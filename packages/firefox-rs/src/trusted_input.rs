//! Trusted input is an adapter behind extension-owned leases. Never dispatch
//! directly to a URL-selected tab, and never fall back to synthetic events.
use crate::{
    bidi::{remote_to_json, Bidi},
    keys, Bridge,
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

struct Transport {
    endpoint: String,
    bidi: Arc<Bidi>,
    owned: bool,
}
impl Transport {
    async fn close(&self) {
        if self.owned && !self.bidi.is_closed() {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                self.bidi.call("session.end", json!({})),
            )
            .await;
        }
        self.bidi.disconnect().await;
    }
}
impl Drop for Transport {
    fn drop(&mut self) {
        let bidi = self.bidi.clone();
        let owned = self.owned;
        tokio::spawn(async move {
            if owned && !bidi.is_closed() {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    bidi.call("session.end", json!({})),
                )
                .await;
            }
            bidi.disconnect().await;
        });
    }
}
struct Binding {
    lease: String,
    context: String,
    top: String,
    valid: AtomicBool,
}
#[derive(Default)]
struct State {
    transport: Option<Arc<Transport>>,
    enabled: HashSet<u64>,
    bindings: HashMap<u64, Arc<Binding>>,
}
#[derive(Default)]
pub struct Controller {
    state: Mutex<State>,
    connect: tokio::sync::Mutex<()>,
    epoch: AtomicU64,
}

fn nonce() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn endpoint_uri(endpoint: &str) -> Result<tokio_tungstenite::tungstenite::http::Uri> {
    if endpoint.len() > 2048 {
        bail!("BiDi endpoint is too long");
    }
    let uri = endpoint
        .parse::<tokio_tungstenite::tungstenite::http::Uri>()
        .context("Invalid BiDi endpoint")?;
    if uri.scheme_str() != Some("ws")
        || !matches!(uri.host(), Some("127.0.0.1" | "[::1]" | "localhost"))
        || uri.authority().is_some_and(|a| a.as_str().contains('@'))
        || uri.query().is_some()
        || !(uri.path() == "/session" || uri.path().starts_with("/session/"))
    {
        bail!("Use an explicit loopback ws:// BiDi session endpoint without credentials or query parameters");
    }
    Ok(uri)
}
impl Controller {
    pub fn enabled(&self, client: u64) -> bool {
        self.state.lock().unwrap().enabled.contains(&client)
    }
    pub fn status(&self, client: u64) -> Value {
        let state = self.state.lock().unwrap();
        let enabled = state.enabled.contains(&client);
        let connected=state.transport.as_ref().is_some_and(|t|!t.bidi.is_closed());
        json!({"mode":if enabled{"trusted-bidi"}else{"synthetic-dom"},"transportConnected":connected,"leaseBound":connected && state.bindings.get(&client).is_some_and(|b|b.valid.load(Ordering::SeqCst)),"extensionSharingControls":true,"fallback":false})
    }
    async fn transport(&self, endpoint: Option<&str>) -> Result<Arc<Transport>> {
        let _guard = self.connect.lock().await;
        let epoch = self.epoch.load(Ordering::SeqCst);
        let previous = self.state.lock().unwrap().transport.clone();
        let endpoint = endpoint
            .map(str::to_owned)
            .or_else(|| previous.as_ref().map(|p| p.endpoint.clone()))
            .context("Enable trusted input with an explicit endpoint first")?;
        if endpoint.len() > 2048 {
            bail!("BiDi endpoint is too long");
        }
        let uri = endpoint_uri(&endpoint)?;
        if let Some(previous) = &previous {
            if previous.endpoint != endpoint {
                bail!(
                    "A different BiDi endpoint is already in use; disable existing clients first"
                );
            }
            if !previous.bidi.is_closed() {
                return Ok(previous.clone());
            }
        }
        let bidi = Bidi::connect(&endpoint).await?;
        // Classic WebDriver's webSocketUrl already belongs to its session.
        // Raw Remote Agent /session endpoints need session.new and are ours.
        let owned = uri.path().trim_end_matches('/') == "/session";
        let transport = Arc::new(Transport {
            endpoint,
            bidi,
            owned,
        });
        if owned {
            transport
                .bidi
                .call("session.new", json!({"capabilities":{}}))
                .await?;
        }
        if self.epoch.load(Ordering::SeqCst) != epoch {
            bail!("Browser sharing changed while connecting trusted input");
        }
        self.state.lock().unwrap().transport = Some(transport.clone());
        Ok(transport)
    }
    pub async fn enable(&self, bridge: &Bridge, client: u64, endpoint: &str) -> Result<Value> {
        let transport = self.transport(Some(endpoint)).await?;
        let result = self
            .prepare(bridge, client, &transport, &json!({"action":"bind"}))
            .await;
        if result.is_err() {
            let unused = {
                let mut state = self.state.lock().unwrap();
                if state.enabled.is_empty() {
                    state.transport.take()
                } else {
                    None
                }
            };
            if let Some(unused) = unused {
                unused.close().await;
            }
            result?;
        }
        self.state.lock().unwrap().enabled.insert(client);
        Ok(self.status(client))
    }
    pub async fn disable(&self, client: u64) {
        let (binding, transport, close) = {
            let mut state = self.state.lock().unwrap();
            state.enabled.remove(&client);
            let binding = state.bindings.remove(&client);
            let transport = state.transport.clone();
            let close = if state.enabled.is_empty() {
                state.transport.take()
            } else {
                None
            };
            (binding, transport, close)
        };
        if let (Some(binding), Some(transport)) = (binding, transport) {
            binding.valid.store(false, Ordering::SeqCst);
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                transport
                    .bidi
                    .call("input.releaseActions", json!({"context":binding.top})),
            )
            .await;
        }
        if let Some(close) = close {
            close.close().await;
        }
    }
    pub async fn cancel(&self, client: u64) {
        let binding = self.state.lock().unwrap().bindings.get(&client).cloned();
        if let Some(binding) = binding {
            self.revoke(&binding.lease).await;
        }
        let unused = {
            let mut state = self.state.lock().unwrap();
            if state.enabled.is_empty() {
                state.transport.take()
            } else {
                None
            }
        };
        if let Some(unused) = unused {
            unused.close().await;
        }
    }
    pub async fn revoke(&self, lease: &str) {
        let (bindings, transport) = {
            let mut state = self.state.lock().unwrap();
            let clients: Vec<_> = state
                .bindings
                .iter()
                .filter(|(_, binding)| binding.lease == lease)
                .map(|(id, _)| *id)
                .collect();
            let bindings: Vec<_> = clients
                .into_iter()
                .filter_map(|id| state.bindings.remove(&id))
                .collect();
            for binding in &bindings {
                binding.valid.store(false, Ordering::SeqCst);
            }
            (bindings, state.transport.clone())
        };
        if let Some(transport) = transport {
            for binding in bindings {
                let _ = tokio::time::timeout(
                    Duration::from_secs(1),
                    transport
                        .bidi
                        .call("input.releaseActions", json!({"context":binding.top})),
                )
                .await;
            }
        }
    }
    pub async fn reset(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let transport = {
            let mut state = self.state.lock().unwrap();
            for binding in state.bindings.values() {
                binding.valid.store(false, Ordering::SeqCst);
            }
            state.bindings.clear();
            state.transport.take()
        };
        if let Some(transport) = transport {
            transport.close().await;
        }
    }
    async fn proof(transport: &Transport, context: &str, nonce: &str) -> Result<bool> {
        let expression = format!(
            "document.documentElement.getAttribute('data-callisto-lease') === {}",
            serde_json::to_string(nonce)?
        );
        let result=transport.bidi.call("script.evaluate",json!({"expression":expression,"target":{"context":context},"awaitPromise":false,"resultOwnership":"none"})).await?;
        Ok(remote_to_json(&result["result"]) == true)
    }
    async fn prepare(
        &self,
        bridge: &Bridge,
        client: u64,
        transport: &Transport,
        args: &Value,
    ) -> Result<(Arc<Binding>, Value)> {
        let epoch = self.epoch.load(Ordering::SeqCst);
        let mut args = args.clone();
        args["nonce"] = json!(nonce());
        let prepared = bridge
            .call_session(client, "input_prepare", None, Some(&args.to_string()))
            .await?;
        let nonce = prepared["nonce"]
            .as_str()
            .context("Extension input binding missing nonce")?;
        let lease = prepared["lease_id"]
            .as_str()
            .context("Extension input binding missing lease")?;
        if args
            .get("expected_lease")
            .is_some_and(|expected| expected != lease)
        {
            bail!("Shared lease changed before trusted input");
        }
        let previous = self.state.lock().unwrap().bindings.get(&client).cloned();
        let existing = if let Some(previous) = previous {
            if previous.lease == lease
                && previous.valid.load(Ordering::SeqCst)
                && Self::proof(transport, &previous.context, nonce)
                    .await
                    .unwrap_or(false)
            {
                Some((previous.context.clone(), previous.top.clone()))
            } else {
                None
            }
        } else {
            None
        };
        let (context, top) = if let Some(existing) = existing {
            existing
        } else {
            let tree = transport
                .bidi
                .call("browsingContext.getTree", json!({"maxDepth":16}))
                .await?;
            let mut candidates = Vec::new();
            fn walk(nodes: &Value, top: Option<&str>, out: &mut Vec<(String, String)>) {
                if let Some(nodes) = nodes.as_array() {
                    for node in nodes {
                        if out.len() >= 256 {
                            return;
                        }
                        if let Some(id) = node["context"].as_str() {
                            let top = top.unwrap_or(id);
                            out.push((id.into(), top.into()));
                            walk(&node["children"], Some(top), out);
                        }
                    }
                }
            }
            walk(&tree["contexts"], None, &mut candidates);
            let mut matches = Vec::new();
            for (context, top) in candidates {
                if Self::proof(transport, &context, nonce)
                    .await
                    .unwrap_or(false)
                {
                    matches.push((context, top));
                }
            }
            if matches.len() != 1 {
                bail!("Shared document did not bind to exactly one BiDi context; refusing trusted input");
            }
            matches.remove(0)
        };
        let binding = Arc::new(Binding {
            lease: lease.into(),
            context,
            top,
            valid: AtomicBool::new(true),
        });
        self.validate(bridge, client, transport, &binding, &prepared, false)
            .await?;
        if epoch != self.epoch.load(Ordering::SeqCst) {
            bail!("Extension connection changed while binding input");
        }
        self.state
            .lock()
            .unwrap()
            .bindings
            .insert(client, binding.clone());
        Ok((binding, prepared))
    }
    async fn validate(
        &self,
        bridge: &Bridge,
        client: u64,
        transport: &Transport,
        binding: &Binding,
        prepared: &Value,
        finish: bool,
    ) -> Result<Value> {
        if !binding.valid.load(Ordering::SeqCst) {
            bail!("Trusted input lease revoked; input was not replayed");
        }
        let validation = bridge
            .call_session(
                client,
                "input_validate",
                None,
                Some(
                    &json!({"nonce":prepared["nonce"],"lease_id":binding.lease,"finish":finish,"keyboard":prepared["keyboard"]})
                        .to_string(),
                ),
            )
            .await?;
        let proof = Self::proof(
            transport,
            &binding.context,
            prepared["nonce"].as_str().unwrap_or(""),
        )
        .await?;
        if !proof || !binding.valid.load(Ordering::SeqCst) {
            bail!("Trusted input document changed before dispatch");
        }
        Ok(validation)
    }
    async fn send(
        &self,
        bridge: &Bridge,
        client: u64,
        transport: &Transport,
        binding: &Binding,
        prepared: &Value,
        mut actions: Value,
    ) -> Result<()> {
        let mut validation_target=prepared.clone();
        validation_target["keyboard"]=json!(actions.as_array().is_some_and(|sources|sources.iter().any(|source|source["type"]=="key")));
        let validation = self
            .validate(bridge, client, transport, binding, &validation_target, false)
            .await?;
        // Refresh geometry only before dispatch, after actionability checks. The
        // document/target nonce stays fixed; an input is never replayed.
        if let Some(sources) = actions.as_array_mut() {
            for source in sources {
                if source["type"] == "pointer" {
                    if let Some(steps) = source["actions"].as_array_mut() {
                        for step in steps {
                            if step["type"] == "pointerMove" && validation.get("x").is_some() {
                                step["x"] = validation["x"].clone();
                                step["y"] = validation["y"].clone();
                            }
                        }
                    }
                }
            }
        }
        let result = transport
            .bidi
            .call(
                "input.performActions",
                json!({"context":binding.top,"actions":actions}),
            )
            .await;
        if result.is_err() {
            let _ = tokio::time::timeout(
                Duration::from_secs(1),
                transport
                    .bidi
                    .call("input.releaseActions", json!({"context":binding.top})),
            )
            .await;
        }
        result.context("Trusted input outcome may be partial; inspect before retrying")?;
        Ok(())
    }
    async fn read_extract(
        &self,
        bridge: &Bridge,
        client: u64,
        spec: &Value,
        lease: Option<&str>,
    ) -> Result<(Value, String)> {
        let transport = self.transport(None).await?;
        let mut args = json!({"action":"bind"});
        if let Some(lease) = lease {
            args["expected_lease"] = json!(lease);
        }
        let (binding, prepared) = self.prepare(bridge, client, &transport, &args).await?;
        let result = bridge
            .call_session(
                client,
                "page",
                None,
                Some(&json!({"action":"extract","spec":spec}).to_string()),
            )
            .await?;
        self.validate(bridge, client, &transport, &binding, &prepared, false)
            .await?;
        Ok((result, binding.lease.clone()))
    }
    pub async fn extract(&self, bridge: &Bridge, client: u64, spec: &Value) -> Result<Value> {
        if spec.to_string().len() > 200000 {
            bail!("Extract arguments are too large");
        }
        let work = async {
            let pages = spec["paginate"]["max_pages"]
                .as_u64()
                .unwrap_or(10)
                .clamp(1, 25);
            let max_pages = if spec.get("paginate").is_some() {
                pages
            } else {
                1
            };
            let (mut one, lease) = self.read_extract(bridge, client, spec, None).await?;
            let mut rows = Vec::new();
            let mut count = 0;
            let mut truncated = false;
            for page in 0..max_pages {
                count += 1;
                rows.extend(
                    one["rows"]
                        .as_array()
                        .context("Extraction rows missing")?
                        .iter()
                        .cloned(),
                );
                truncated |= one["omitted"] == true;
                if rows.len() >= 1000 {
                    truncated |= rows.len() > 1000 || one["has_next"] == true;
                    break;
                }
                if spec.get("paginate").is_none() || one["has_next"] != true {
                    break;
                }
                if page + 1 >= max_pages {
                    truncated = true;
                    break;
                }
                self.execute(bridge,client,&json!({"action":"click","selector":spec["paginate"]["next"],"expected_lease":lease})).await?;
                let before = one["rows"].clone();
                let until = tokio::time::Instant::now() + Duration::from_secs(5);
                let mut candidate = Value::Null;
                let mut since = tokio::time::Instant::now();
                loop {
                    if tokio::time::Instant::now() >= until {
                        bail!("Pagination did not produce a stable, different set of rows within 5 seconds; inspect before retrying");
                    }
                    let (next, _) = self
                        .read_extract(bridge, client, spec, Some(&lease))
                        .await?;
                    if next["rows"] != before
                        && next["rows"].as_array().is_some_and(|rows| !rows.is_empty())
                    {
                        if candidate != next["rows"] {
                            candidate = next["rows"].clone();
                            since = tokio::time::Instant::now();
                        } else if since.elapsed() >= Duration::from_millis(200) {
                            one = next;
                            break;
                        }
                    } else {
                        candidate = Value::Null;
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            }
            rows.truncate(1000);
            Ok(
                json!({"url":one["url"],"title":one["title"],"rows":rows,"count":rows.len(),"pages":count,"truncated":truncated,"trusted":true}),
            )
        };
        tokio::time::timeout(Duration::from_secs(35), work)
            .await
            .context("Request timed out in trusted extraction; inspect before retrying")?
    }
    pub async fn execute(&self, bridge: &Bridge, client: u64, args: &Value) -> Result<Value> {
        if !self.enabled(client) {
            bail!("Trusted input is not enabled");
        }
        let action = args["action"].as_str().unwrap_or("");
        if action == "fill" && !args["value"].as_str().is_some_and(|v| v.len() <= 100000) {
            bail!("Fill requires a bounded string value");
        }
        if action == "press" {
            let key = args["key"].as_str().context("Press requires key")?;
            if key.len() > 40 {
                bail!("Key is too long");
            }
            keys::parse_chord(key)?;
        }
        let transport = self.transport(None).await?;
        let (binding, prepared) = self.prepare(bridge, client, &transport, args).await?;
        if prepared["skip"] == true {
            return Ok(json!({"completed":true,"trusted":true,"unchanged":true}));
        }
        let pointer = |click: bool| {
            let mut actions = vec![
                json!({"type":"pointerMove","x":prepared["x"],"y":prepared["y"],"origin":"viewport"}),
            ];
            if click {
                actions.extend([
                    json!({"type":"pointerDown","button":0}),
                    json!({"type":"pointerUp","button":0}),
                ]);
            }
            json!([{"type":"pointer","id":"callisto-trusted-mouse","parameters":{"pointerType":"mouse"},"actions":actions}])
        };
        let keyboard = |key: &str| -> Result<Value> {
            let (modifiers, main) = keys::parse_chord(key)?;
            let mut actions = Vec::new();
            for key in &modifiers {
                actions.push(json!({"type":"keyDown","value":key}));
            }
            actions.extend([
                json!({"type":"keyDown","value":main}),
                json!({"type":"keyUp","value":main}),
            ]);
            for key in modifiers.iter().rev() {
                actions.push(json!({"type":"keyUp","value":key}));
            }
            Ok(json!([{"type":"key","id":"callisto-trusted-keys","actions":actions}]))
        };
        if action == "select" {
            self.validate(bridge, client, &transport, &binding, &prepared, false)
                .await?;
            let expression=format!("(() => {{ const find=root=>{{for(const node of root.querySelectorAll('*')){{if(node.getAttribute('data-callisto-target')==={})return node;if(node.shadowRoot){{const found=find(node.shadowRoot);if(found)return found;}}}}}}; const el=find(document); if (!el) return false; el.focus({{preventScroll:true}}); return el.getRootNode().activeElement===el; }})()",serde_json::to_string(&prepared["nonce"])?);
            let focused=transport.bidi.call("script.evaluate",json!({"expression":expression,"target":{"context":binding.context},"awaitPromise":false,"resultOwnership":"none"})).await?;
            if remote_to_json(&focused["result"]) != true {
                bail!("Could not focus the leased select");
            }
        } else if action != "press" {
            self.send(
                bridge,
                client,
                &transport,
                &binding,
                &prepared,
                pointer(action != "hover"),
            )
            .await?;
        }
        match action {
            "fill" => {
                let value = args["value"]
                    .as_str()
                    .context("Fill requires string value")?;
                if value.len() > 100000 {
                    bail!("Fill value exceeds limit");
                }
                self.send(
                    bridge,
                    client,
                    &transport,
                    &binding,
                    &prepared,
                    keyboard("Control+A")?,
                )
                .await?;
                if value.is_empty() {
                    self.send(
                        bridge,
                        client,
                        &transport,
                        &binding,
                        &prepared,
                        keyboard("Backspace")?,
                    )
                    .await?;
                }
                for chunk in keys::text_keys(value).chunks(128) {
                    let actions: Vec<_> = chunk
                        .iter()
                        .flat_map(|value| {
                            [
                                json!({"type":"keyDown","value":value}),
                                json!({"type":"keyUp","value":value}),
                            ]
                        })
                        .collect();
                    self.send(
                        bridge,
                        client,
                        &transport,
                        &binding,
                        &prepared,
                        json!([{"type":"key","id":"callisto-trusted-keys","actions":actions}]),
                    )
                    .await?;
                }
            }
            "press" => {
                self.send(
                    bridge,
                    client,
                    &transport,
                    &binding,
                    &prepared,
                    keyboard(args["key"].as_str().context("Press requires key")?)?,
                )
                .await?
            }
            "submit" if prepared["submit_via"] == "enter" => {
                self.send(
                    bridge,
                    client,
                    &transport,
                    &binding,
                    &prepared,
                    keyboard("Enter")?,
                )
                .await?
            }
            "select" => {
                self.send(
                    bridge,
                    client,
                    &transport,
                    &binding,
                    &prepared,
                    keyboard("Home")?,
                )
                .await?;
                for _ in 0..prepared["select_steps"].as_u64().unwrap_or(0) {
                    self.send(
                        bridge,
                        client,
                        &transport,
                        &binding,
                        &prepared,
                        keyboard("ArrowDown")?,
                    )
                    .await?;
                }
            }
            "click" | "hover" | "check" | "submit" => {}
            _ => bail!("Unsupported trusted action"),
        }
        if ["select", "check"].contains(&action) {
            self.validate(bridge, client, &transport, &binding, &prepared, true)
                .await?;
        }
        Ok(
            json!({"completed":true,"trusted":true,"input":"webdriver-bidi","extensionSharingControls":true}),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::mpsc;

    struct Fixture {
        bridge: Arc<Bridge>,
        endpoint: String,
        shared: Arc<AtomicBool>,
        writes: Arc<AtomicUsize>,
        tasks: Vec<tokio::task::JoinHandle<()>>,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            for task in &self.tasks {
                task.abort();
            }
        }
    }
    async fn fixture(contexts: usize, drop_write: bool, stop_after_write: bool) -> Fixture {
        let shared = Arc::new(AtomicBool::new(true));
        let writes = Arc::new(AtomicUsize::new(0));
        let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
        let bridge = Arc::new(Bridge {
            token: String::new(),
            port: 0,
            connection: tokio::sync::Mutex::new(Some(tx)),
            pending: tokio::sync::Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            traces: tokio::sync::Mutex::new(HashMap::new()),
            trusted: Controller::default(),
        });
        let b = bridge.clone();
        let sharing = shared.clone();
        let extension = tokio::spawn(async move {
            while let Some(request) = rx.recv().await {
                let args: Value =
                    serde_json::from_str(request["value"].as_str().unwrap_or("{}")).unwrap();
                let result = if !sharing.load(Ordering::SeqCst) {
                    Err("Sharing stopped".into())
                } else {
                    match request["method"].as_str().unwrap() {
                        "input_prepare" => {
                            Ok(json!({"nonce":args["nonce"],"lease_id":"lease-1","x":10,"y":10}))
                        }
                        "input_validate" => Ok(json!({"valid":true})),
                        _ => panic!("Unexpected synthetic dispatch: {request}"),
                    }
                };
                if let Some(sender) = b
                    .pending
                    .lock()
                    .await
                    .remove(&request["id"].as_u64().unwrap())
                {
                    let _ = sender.send(result);
                }
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}/session/test", listener.local_addr().unwrap());
        let count = writes.clone();
        let sharing = shared.clone();
        let native = tokio::spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let mut ws = tokio_tungstenite::accept_async(socket).await.unwrap();
                while let Some(Ok(message)) = ws.next().await {
                    let Ok(text) = message.to_text() else {
                        continue;
                    };
                    let Ok(request) = serde_json::from_str::<Value>(text) else {
                        continue;
                    };
                    let result = match request["method"].as_str().unwrap() {
                        "browsingContext.getTree" => {
                            json!({"contexts":(0..contexts).map(|i|json!({"context":format!("ctx-{i}"),"children":[]})).collect::<Vec<_>>()})
                        }
                        "script.evaluate" => {
                            json!({"type":"success","result":{"type":"boolean","value":true}})
                        }
                        "input.performActions" => {
                            count.fetch_add(1, Ordering::SeqCst);
                            if stop_after_write {
                                sharing.store(false, Ordering::SeqCst);
                            }
                            if drop_write {
                                let _ = ws.close(None).await;
                                break;
                            }
                            json!({})
                        }
                        "input.releaseActions" => json!({}),
                        _ => panic!("Unexpected native request: {request}"),
                    };
                    if ws
                        .send(tokio_tungstenite::tungstenite::Message::Text(
                            json!({"id":request["id"],"result":result})
                                .to_string()
                                .into(),
                        ))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        });
        Fixture {
            bridge,
            endpoint,
            shared,
            writes,
            tasks: vec![extension, native],
        }
    }
    #[test]
    fn endpoint_scope_is_explicit() {
        for endpoint in [
            "wss://127.0.0.1/session",
            "ws://example.com/session",
            "ws://user@localhost/session",
            "ws://localhost/sessionbad",
            "ws://localhost/session?token=x",
        ] {
            assert!(endpoint_uri(endpoint).is_err(), "{endpoint}");
        }
        assert!(endpoint_uri("ws://127.0.0.1:9222/session/abc").is_ok());
    }
    #[tokio::test]
    async fn ambiguous_context_never_dispatches() {
        let f = fixture(2, false, false).await;
        assert!(f
            .bridge
            .trusted
            .enable(&f.bridge, 1, &f.endpoint)
            .await
            .is_err());
        assert_eq!(f.writes.load(Ordering::SeqCst), 0);
        assert!(!f.bridge.trusted.enabled(1));
    }
    #[tokio::test]
    async fn stopped_lease_aborts_remaining_fill_without_fallback() {
        let f = fixture(1, false, true).await;
        f.bridge
            .trusted
            .enable(&f.bridge, 1, &f.endpoint)
            .await
            .unwrap();
        assert!(f
            .bridge
            .trusted
            .execute(
                &f.bridge,
                1,
                &json!({"action":"fill","ref":"ax-1","value":"never replay"})
            )
            .await
            .is_err());
        assert_eq!(f.writes.load(Ordering::SeqCst), 1);
        assert!(f.bridge.trusted.enabled(1));
        f.bridge.trusted.cancel(1).await;
        assert_eq!(f.bridge.trusted.status(1)["leaseBound"], false);
    }
    #[tokio::test]
    async fn dropped_native_reply_is_not_replayed_and_new_request_can_reconnect() {
        let f = fixture(1, true, false).await;
        f.bridge
            .trusted
            .enable(&f.bridge, 1, &f.endpoint)
            .await
            .unwrap();
        assert!(f
            .bridge
            .trusted
            .execute(&f.bridge, 1, &json!({"action":"click","ref":"ax-1"}))
            .await
            .is_err());
        assert_eq!(f.writes.load(Ordering::SeqCst), 1);
        assert!(f
            .bridge
            .trusted
            .execute(&f.bridge, 1, &json!({"action":"click","ref":"ax-1"}))
            .await
            .is_err());
        assert_eq!(f.writes.load(Ordering::SeqCst), 2);
        f.bridge.trusted.reset().await;
        assert!(f.bridge.trusted.enabled(1));
        assert!(f
            .bridge
            .trusted
            .execute(&f.bridge, 1, &json!({"action":"click","ref":"ax-1"}))
            .await
            .is_err());
        assert_eq!(f.writes.load(Ordering::SeqCst), 2);
    }
    #[tokio::test]
    async fn lease_change_before_dispatch_is_refused() {
        let f = fixture(1, false, false).await;
        f.bridge
            .trusted
            .enable(&f.bridge, 1, &f.endpoint)
            .await
            .unwrap();
        assert!(f
            .bridge
            .trusted
            .execute(
                &f.bridge,
                1,
                &json!({"action":"click","ref":"ax-1","expected_lease":"other"})
            )
            .await
            .is_err());
        assert_eq!(f.writes.load(Ordering::SeqCst), 0);
        f.shared.store(false, Ordering::SeqCst);
        f.bridge.trusted.revoke("lease-1").await;
        assert_eq!(f.bridge.trusted.status(1)["leaseBound"], false);
        assert!(f.bridge.trusted.enabled(1));
    }
}

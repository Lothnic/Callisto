//! Experimental, opt-in local bridge for an explicitly shared Firefox/Zen tab.
//! Browser input is supplied by a WebExtension and is synthetic, not BiDi input.
mod tab_relay;
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader},
    net::TcpStream,
    sync::{mpsc, oneshot, Mutex},
};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        Message,
    },
};

type Pending = HashMap<u64, oneshot::Sender<Result<Value, String>>>;
struct Bridge {
    token: String,
    port: u16,
    connection: Mutex<Option<mpsc::UnboundedSender<Value>>>,
    pending: Mutex<Pending>,
    next_id: AtomicU64,
}
impl Bridge {
    #[cfg(test)]
    async fn call(&self, method: &str, ref_: Option<&str>, value: Option<&str>) -> Result<Value> {
        self.call_session(0, method, ref_, value).await
    }
    async fn call_session(
        &self,
        session_id: u64,
        method: &str,
        ref_: Option<&str>,
        value: Option<&str>,
    ) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (send, recv) = oneshot::channel();
        let message =
            json!({"id":id,"session":session_id,"method":method,"ref":ref_,"value":value});
        {
            // Register and send while holding the connection lock so disconnect
            // cannot drain the pending table between those two operations.
            let connection = self.connection.lock().await;
            let connection = connection.as_ref().ok_or_else(|| anyhow!("Extension not paired. Call callisto_pair, then connect and share the current tab in the extension."))?;
            self.pending.lock().await.insert(id, send);
            if connection.send(message).is_err() {
                self.pending.lock().await.remove(&id);
                bail!("The Firefox extension disconnected");
            }
        }
        let result = tokio::time::timeout(
            Duration::from_secs(if method == "handoff" { 125 } else { 15 }),
            recv,
        )
        .await;
        self.pending.lock().await.remove(&id);
        match result {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => Err(anyhow!("The Firefox extension disconnected")),
            Err(_) => Err(anyhow!("The tab did not respond within 15 seconds; the action may have completed. Inspect the page before retrying.")),
        }
    }
}

async fn serve_socket(socket: TcpStream, bridge: Arc<Bridge>) {
    let ws = tokio::time::timeout(
        Duration::from_secs(5),
        accept_hdr_async(socket, |request: &Request, response: Response| {
            let origin = request
                .headers()
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if !origin.starts_with("moz-extension://") {
                let mut error =
                    ErrorResponse::new(Some("Firefox extension origin required".into()));
                *error.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                return Err(error);
            }
            Ok(response)
        }),
    )
    .await;
    let Ok(Ok(mut ws)) = ws else {
        return;
    };
    let Ok(Some(Ok(Message::Text(message)))) =
        tokio::time::timeout(Duration::from_secs(5), ws.next()).await
    else {
        return;
    };
    if message.len() > 1024 {
        return;
    }
    let Ok(auth) = serde_json::from_str::<Value>(&message) else {
        return;
    };
    if auth.get("type").and_then(Value::as_str) != Some("pair")
        || auth.get("token").and_then(Value::as_str) != Some(bridge.token.as_str())
    {
        return;
    }
    if auth.get("protocol").and_then(Value::as_u64) != Some(2) {
        let _=ws.send(Message::Text(json!({"type":"pairing_error","message":"Callisto protocol mismatch. Update both the browser extension and runtime."}).to_string().into())).await;
        return;
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    {
        let mut connection = bridge.connection.lock().await;
        if connection.is_some() {
            return;
        }
        if ws
            .send(Message::Text(
                json!({"type":"paired","protocol":2}).to_string().into(),
            ))
            .await
            .is_err()
        {
            return;
        }
        *connection = Some(tx);
    }
    loop {
        tokio::select! {
            request = rx.recv() => match request {
                Some(request) => if ws.send(Message::Text(request.to_string().into())).await.is_err() { break; },
                None => break,
            },
            incoming = ws.next() => {
                let Some(Ok(Message::Text(message))) = incoming else { break; };
                if message.len() > 20_000_000 { break; }
                let Ok(response) = serde_json::from_str::<Value>(&message) else { continue; };
                let Some(id) = response.get("id").and_then(Value::as_u64) else { continue; };
                if let Some(waiter) = bridge.pending.lock().await.remove(&id) {
                    let value = match response.get("error").and_then(Value::as_str) {
                        Some(error) => Err(error.to_owned()),
                        None => Ok(response.get("result").cloned().unwrap_or(Value::Null)),
                    };
                    let _ = waiter.send(value);
                }
            }
        }
    }
    let mut connection = bridge.connection.lock().await;
    *connection = None;
    for (_, waiter) in std::mem::take(&mut *bridge.pending.lock().await) {
        let _ = waiter.send(Err("The Firefox extension disconnected".into()));
    }
}

fn tools() -> Value {
    json!([
        {"name":"callisto_press","description":"Dispatch synthetic keydown/keyup on the focused control, including chords such as Control+A. For JavaScript keyboard handlers only: native editing, focus navigation, shortcuts and form submission defaults are not emulated. Use fill or submit for those operations.","inputSchema":{"type":"object","properties":{"key":{"type":"string","minLength":1,"maxLength":40}},"required":["key"]}},
        {"name":"callisto_frames","description":"List frames in the controlled tab. Frame access depends on granted website permissions.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_frame","description":"Select a frame by frame_id from callisto_frames, inject the bridge and return a fresh snapshot. Navigation resets selection. Cross-origin frame input fails closed because parent hit testing cannot be verified.","inputSchema":{"type":"object","properties":{"frame_id":{"type":"integer","minimum":0}},"required":["frame_id"]}},
        {"name":"callisto_handoff","description":"Ask the user to complete a step in the shared page, then click Continue with agent. Use message; prompt is supported for compatibility. Confirmation is not proof of task success.","inputSchema":{"type":"object","properties":{"message":{"type":"string","minLength":1,"maxLength":500},"prompt":{"type":"string","minLength":1,"maxLength":1000},"timeout_ms":{"type":"integer","minimum":1000,"maximum":120000}},"anyOf":[{"required":["message"]},{"required":["prompt"]}]}},
        {"name":"callisto_capabilities","description":"Report backend capabilities without reading page content.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_upload","description":"Set files on a visible file input in the controlled page. Reads explicit local file paths, at most 10 files and 10 MiB total. Page input/change handlers may upload immediately. Does not submit the form.","inputSchema":{"type":"object","properties":{"ref":{"type":"string","pattern":"^ax-[0-9]+$"},"paths":{"type":"array","minItems":1,"maxItems":10,"items":{"type":"string"}}},"required":["ref","paths"]}},
        {"name":"callisto_pair","description":"Get the persistent local browser pairing code (only needed for initial setup) for the Firefox/Zen tab bridge. Enter it in the extension, then explicitly share the desired existing tab.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_status","description":"Check whether the extension is connected and a tab is shared and active, without reading page content.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_browser","description":"Manage the user's browser after they grant Enable browser access in the extension. Supports tabs, screenshots, cookies, bookmarks, history and downloads. tab_select also shares that existing tab. window_close closes the specified whole window, including its tabs; use the id returned by window_create for agent-window cleanup. Cookie values are sensitive. Downloads prompt for a save location. Zen may omit inactive workspaces.","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["tabs_list","tab_select","tab_create","window_create","window_close","agent_container","tab_close","back","forward","reload","screenshot","cookies_list","cookie_set","cookie_remove","bookmarks_search","history_search","downloads_search","download"]},"window_id":{"type":"integer","minimum":0},"tab_id":{"type":"integer","minimum":0},"url":{"type":"string"},"query":{"type":"string","maxLength":200},"agent_container":{"type":"boolean","description":"Create a new tab or window in the opt-in isolated Callisto cookie container; existing logins will not be available there."},"cookie_store_id":{"type":"string"},"name":{"type":"string"},"value":{"type":"string"}},"required":["action"]}},
        {"name":"callisto_page","description":"Additional DOM operations on the active controlled page. scroll uses viewport pixel deltas; hover dispatches synthetic pointer/mouse events; select chooses an option by value; check sets a checkbox; text returns bounded visible body text; find searches visible body text. Input events are synthetic and can be rejected by sites.","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["scroll","hover","select","check","text","find"]},"ref":{"type":"string","pattern":"^ax-[0-9]+$"},"value":{"type":"string"},"checked":{"type":"boolean"},"delta_x":{"type":"number"},"delta_y":{"type":"number"},"query":{"type":"string","maxLength":200}},"required":["action"]}},
        {"name":"callisto_scroll","description":"Scroll the controlled page by viewport pixel deltas. Returns the action result; take a fresh snapshot afterward.","inputSchema":{"type":"object","properties":{"delta_x":{"type":"number","default":0},"delta_y":{"type":"number"}},"required":["delta_y"]}},
        {"name":"callisto_screenshot","description":"Capture the active controlled tab as a JPEG image. Requires Enable browser access in the extension.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_find","description":"Search visible page text and return bounded matching snippets. Unlike Chromium accessibility search, this uses rendered DOM text.","inputSchema":{"type":"object","properties":{"query":{"type":"string","minLength":1,"maxLength":200},"max_matches":{"type":"integer","minimum":1,"maximum":10,"default":5}},"required":["query"]}},
        {"name":"callisto_submit","description":"Submit the form associated with a snapshot ref, preserving browser validation and submit handlers. Use an input or submit-button ref. Submission may navigate; the next snapshot waits for the page.","inputSchema":{"type":"object","properties":{"ref":{"type":"string","pattern":"^ax-[0-9]+$"}},"required":["ref"]}},
        {"name":"callisto_batch","description":"Execute 1–10 dependent actions in the controlled tab and return a final snapshot in one tool call. Batches stop if tab ownership changes. Earlier actions are not rolled back on failure. Ten-second deadline; input remains synthetic.","inputSchema":{"type":"object","properties":{"actions":{"type":"array","minItems":1,"maxItems":10,"items":{"type":"object","properties":{"action":{"type":"string","enum":["navigate","click_ref","fill_ref","submit_ref","click_role","fill_role","submit_role","scroll"]},"url":{"type":"string"},"ref":{"type":"string"},"role":{"type":"string"},"name":{"type":"string"},"value":{"type":"string"},"delta_x":{"type":"number"},"delta_y":{"type":"number"}},"required":["action"]}}},"required":["actions"]}},
        {"name":"callisto_snapshot","description":"Inspect the explicitly shared active tab. This experimental DOM-derived snapshot can omit content and frames.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_navigate","description":"Navigate the shared active tab to an HTTP(S) URL. Requires the user to grant optional access to all websites and re-share the tab. Poll callisto_status until ready, then take a fresh snapshot.","inputSchema":{"type":"object","properties":{"url":{"type":"string","maxLength":8192}},"required":["url"]}},
        {"name":"callisto_click","description":"Click a ref from the latest snapshot in the shared tab using a synthetic DOM click. Some websites reject synthetic input.","inputSchema":{"type":"object","properties":{"ref":{"type":"string","pattern":"^ax-[0-9]+$"}},"required":["ref"]}},
        {"name":"callisto_fill","description":"Fill a ref from the latest snapshot in the shared tab using synthetic input events. Some websites reject synthetic input.","inputSchema":{"type":"object","properties":{"ref":{"type":"string","pattern":"^ax-[0-9]+$"},"value":{"type":"string","maxLength":100000}},"required":["ref","value"]}},
        {"name":"callisto_close","description":"Stop sharing the tab without closing it or the browser.","inputSchema":{"type":"object","properties":{}}}
    ])
}
fn text(value: Value) -> Value {
    if let Some(data) = value
        .get("dataUrl")
        .and_then(Value::as_str)
        .and_then(|s| s.strip_prefix("data:image/jpeg;base64,"))
    {
        return json!({"content":[{"type":"image","mimeType":"image/jpeg","data":data}]});
    }
    json!({"content":[{"type":"text","text":value.to_string()}]})
}
fn failure(error: impl std::fmt::Display) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":error.to_string()}]})
}
async fn call_tool(bridge: &Bridge, session_id: u64, name: &str, args: &Value) -> Result<Value> {
    match name {
        "callisto_press" => {
            let key = args["key"]
                .as_str()
                .ok_or_else(|| anyhow!("key required"))?;
            if key.is_empty() || key.len() > 40 {
                bail!("Invalid key");
            }
            bridge
                .call_session(
                    session_id,
                    "page",
                    None,
                    Some(&json!({"action":"press","key":key}).to_string()),
                )
                .await
        }
        "callisto_frames" => bridge.call_session(session_id, "frames", None, None).await,
        "callisto_frame" => {
            let frame = args["frame_id"]
                .as_u64()
                .ok_or_else(|| anyhow!("frame_id required"))?;
            bridge
                .call_session(
                    session_id,
                    "frame",
                    None,
                    Some(&json!({"frame_id":frame}).to_string()),
                )
                .await
        }
        "callisto_handoff" => {
            let message = args.get("message").and_then(Value::as_str);
            let legacy_prompt = args.get("prompt").and_then(Value::as_str);
            if message.is_some_and(|m| m.trim().len() > 500)
                || matches!((message, legacy_prompt), (Some(m), Some(p)) if m.trim() != p.trim())
            {
                bail!("Invalid or conflicting handoff message and prompt");
            }
            let prompt = message.or(legacy_prompt).ok_or_else(|| anyhow!("message required"))?.trim();
            let timeout = args
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(60000);
            if prompt.trim().is_empty()
                || prompt.len() > 1000
                || !(1000..=120000).contains(&timeout)
            {
                bail!("Invalid handoff prompt or timeout");
            }
            bridge
                .call_session(
                    session_id,
                    "handoff",
                    None,
                    Some(&json!({"prompt":prompt,"timeout_ms":timeout}).to_string()),
                )
                .await
        }
        "callisto_capabilities" => Ok(
            json!({"schemaVersion":1,"backend":"firefox-extension","mode":"connected","snapshot":"dom","sessionModel":"per-client-tab","capabilities":{"trustedInput":false,"frames":"same-origin","openShadowRoots":true,"upload":true,"existingTabAdoption":true,"cancellation":true,"handoff":true}}),
        ),
        "callisto_upload" => {
            use base64::Engine;
            use tokio::io::AsyncReadExt;
            let ref_ = args["ref"]
                .as_str()
                .ok_or_else(|| anyhow!("ref required"))?;
            let paths = args["paths"]
                .as_array()
                .ok_or_else(|| anyhow!("paths required"))?;
            if paths.is_empty() || paths.len() > 10 {
                bail!("Expected 1–10 files");
            }
            let mut remaining = 10 * 1024 * 1024usize;
            let mut files = Vec::new();
            for path in paths {
                let path =
                    std::path::Path::new(path.as_str().ok_or_else(|| anyhow!("Invalid path"))?);
                let file = tokio::fs::File::open(path).await?;
                if !file.metadata().await?.is_file() {
                    bail!("Only regular files can be uploaded");
                }
                let mut bytes = Vec::new();
                file.take((remaining + 1) as u64)
                    .read_to_end(&mut bytes)
                    .await?;
                if bytes.len() > remaining {
                    bail!("Uploads exceed 10 MiB");
                }
                remaining -= bytes.len();
                files.push(json!({"name":path.file_name().and_then(|n|n.to_str()).ok_or_else(||anyhow!("Invalid filename"))?,"data":base64::engine::general_purpose::STANDARD.encode(bytes)}));
            }
            bridge
                .call_session(
                    session_id,
                    "page",
                    None,
                    Some(&json!({"action":"upload","ref":ref_,"files":files}).to_string()),
                )
                .await
        }
        "callisto_pair" => Ok(
            json!({"code":format!("127.0.0.1:{}#{}",bridge.port,bridge.token),"instructions":"Pair once in the extension. Future MCP sessions reuse this local relay automatically. Tab sharing and full browser permissions are separate controls."}),
        ),
        "callisto_browser" => {
            if args.to_string().len() > 200_000 {
                bail!("Browser arguments are too large");
            }
            bridge
                .call_session(session_id, "browser", None, Some(&args.to_string()))
                .await
        }
        "callisto_page" => {
            if args.to_string().len() > 200_000 {
                bail!("Page arguments are too large");
            }
            bridge
                .call_session(session_id, "page", None, Some(&args.to_string()))
                .await
        }
        "callisto_scroll" => {
            let x = match args.get("delta_x") { Some(value) => value.as_f64().ok_or_else(|| anyhow!("Invalid delta_x"))?, None => 0.0 };
            let y = args.get("delta_y").and_then(Value::as_f64).ok_or_else(|| anyhow!("delta_y required"))?;
            if !x.is_finite() || !y.is_finite() { bail!("Invalid scroll delta"); }
            bridge.call_session(session_id, "page", None, Some(&json!({"action":"scroll","delta_x":x,"delta_y":y}).to_string())).await
        }
        "callisto_screenshot" => bridge.call_session(session_id, "browser", None, Some(&json!({"action":"screenshot"}).to_string())).await,
        "callisto_find" => {
            let query = args.get("query").and_then(Value::as_str).ok_or_else(|| anyhow!("query required"))?;
            let max = match args.get("max_matches") { Some(value) => value.as_u64().ok_or_else(|| anyhow!("Invalid max_matches"))?, None => 5 };
            if query.is_empty() || query.chars().count() > 200 || !(1..=10).contains(&max) { bail!("Invalid query or max_matches"); }
            let mut result = bridge.call_session(session_id, "page", None, Some(&json!({"action":"find","query":query}).to_string())).await?;
            if let Some(matches) = result.get_mut("matches").and_then(Value::as_array_mut) { matches.truncate(max as usize); }
            Ok(result)
        }
        "callisto_batch" => {
            let steps = args
                .get("actions")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("actions must be an array"))?;
            if steps.is_empty() || steps.len() > 10 || args.to_string().len() > 200_000 {
                bail!("Expected 1–10 actions, bounded to 200,000 bytes");
            }
            bridge
                .call_session(
                    session_id,
                    "batch",
                    None,
                    Some(&serde_json::to_string(steps)?),
                )
                .await
        }
        "callisto_snapshot" => {
            bridge
                .call_session(session_id, "snapshot", None, None)
                .await
        }
        "callisto_status" => {
            if bridge.connection.lock().await.is_none() {
                Ok(json!({"connected":false,"sharing":false,"active":false}))
            } else {
                bridge.call_session(session_id, "status", None, None).await
            }
        }
        "callisto_navigate" => {
            let url = args
                .get("url")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("url is required"))?;
            if url.len() > 8192 {
                bail!("URL is too long");
            }
            bridge
                .call_session(session_id, "navigate", None, Some(url))
                .await
        }
        "callisto_click" | "callisto_fill" | "callisto_submit" => {
            let target = args
                .get("ref")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("ref is required"))?;
            let digits = target.strip_prefix("ax-").unwrap_or("");
            if digits.is_empty() || digits.len() > 20 || !digits.bytes().all(|c| c.is_ascii_digit())
            {
                bail!("invalid reference");
            }
            let value = if name == "callisto_fill" {
                let value = args
                    .get("value")
                    .and_then(Value::as_str)
                    .ok_or_else(|| anyhow!("value is required"))?;
                if value.chars().count() > 100_000 {
                    bail!("value is too long");
                }
                Some(value)
            } else {
                None
            };
            bridge
                .call_session(
                    session_id,
                    if name == "callisto_fill" {
                        "fill"
                    } else if name == "callisto_submit" {
                        "submit"
                    } else {
                        "click"
                    },
                    Some(target),
                    value,
                )
                .await
        }
        "callisto_close" => {
            if bridge.connection.lock().await.is_none() {
                return Ok(json!({"released":true}));
            }
            bridge.call_session(session_id, "release", None, None).await
        }
        _ => bail!("unknown tool: {name}"),
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    let root = tab_relay::root()?;
    let mode = std::env::args().nth(1);
    if mode.as_deref() == Some("--stop-relay") {
        let mut stream = tokio::net::UnixStream::connect(root.join("relay.sock")).await?;
        stream
            .write_all(b"{\"id\":0,\"method\":\"relay/shutdown\"}\n")
            .await?;
        use tokio::io::AsyncReadExt;
        let _ = stream.read_u8().await;
        return Ok(());
    }
    if mode.as_deref() != Some("--relay") {
        return proxy(tokio::io::stdin(), tokio::io::stdout(), &root).await;
    }
    let Some(_lock) = tab_relay::lock(&root)? else {
        return Ok(());
    };
    let (listener, credentials) = tab_relay::listener(&root).await?;
    let socket = root.join("relay.sock");
    if socket.exists() {
        std::fs::remove_file(&socket)?;
    }
    let clients = tokio::net::UnixListener::bind(&socket)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    let bridge = Arc::new(Bridge {
        token: credentials.token,
        port: credentials.port,
        connection: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
    });
    let accept_bridge = bridge.clone();
    tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(serve_socket(socket, accept_bridge.clone()));
        }
    });
    let operations = Arc::new(Mutex::new(()));
    while let Ok((client, _)) = clients.accept().await {
        let bridge = bridge.clone();
        let operations = operations.clone();
        let client_id = bridge.next_id.fetch_add(1, Ordering::Relaxed);
        tokio::spawn(async move {
            let (read, write) = client.into_split();
            let _ = serve_mcp(read, write, bridge.clone(), operations.clone(), client_id).await;
            bridge
                .pending
                .lock()
                .await
                .retain(|_, sender| !sender.is_closed());
            let _operation = operations.lock().await;
            let _ = bridge
                .call_session(client_id, "release_session", None, None)
                .await;
        });
    }
    Ok(())
}
async fn proxy<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    input: R,
    mut output: W,
    root: &std::path::Path,
) -> Result<()> {
    let mut input = BufReader::new(input).lines();
    let stream = tab_relay::connect(root).await?;
    let (read, mut write) = stream.into_split();
    let mut replies = BufReader::new(read).lines();
    let mut pending = HashMap::<String, Value>::new();
    loop {
        let disconnected = tokio::select! {
            line=input.next_line()=>{
                let Some(line)=line? else {return Ok(());};
                if let Ok(message)=serde_json::from_str::<Value>(&line) {
                    if let Some(id)=message.get("id"){pending.insert(id.to_string(),id.clone());}
                }
                write.write_all(format!("{line}\n").as_bytes()).await.is_err()
            }
            line=replies.next_line()=>{
                match line {
                    Ok(Some(line))=>{
                        if let Ok(message)=serde_json::from_str::<Value>(&line){if let Some(id)=message.get("id"){pending.remove(&id.to_string());}}
                        output.write_all(format!("{line}\n").as_bytes()).await?;output.flush().await?;false
                    }
                    _=>true,
                }
            }
        };
        if disconnected {
            for (_, id) in pending.drain() {
                let reply = json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"Browser relay disconnected. The action may have completed; inspect before retrying. It was not replayed."}});
                output.write_all(format!("{reply}\n").as_bytes()).await?;
            }
            output.flush().await?;
            let stream = tab_relay::connect(root).await?;
            let (read, new_write) = stream.into_split();
            replies = BufReader::new(read).lines();
            write = new_write;
        }
    }
}
async fn serve_mcp<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    read: R,
    mut stdout: W,
    bridge: Arc<Bridge>,
    operations: Arc<Mutex<()>>,
    client_id: u64,
) -> Result<()> {
    let mut stdin = BufReader::new(read).lines();
    let mut deferred = VecDeque::new();
    loop {
        let line = match deferred.pop_front() {
            Some(line) => line,
            None => match stdin.next_line().await? {
                Some(line) => line,
                None => break,
            },
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = message.get("id").cloned() else {
            continue;
        };
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let params = message.get("params").cloned().unwrap_or(json!({}));
        let result = match method {
            "initialize" => {
                json!({"protocolVersion":params.get("protocolVersion").and_then(Value::as_str).unwrap_or("2025-06-18"),"capabilities":{"tools":{}},"serverInfo":{"name":"callisto-firefox-tab-mcp","version":env!("CARGO_PKG_VERSION")}})
            }
            "relay/shutdown" => std::process::exit(0),
            "ping" => json!({}),
            "tools/list" => json!({"tools":tools()}),
            "tools/call" => {
                match acquire_operation(&mut stdin, &mut deferred, &id, operations.clone()).await? {
                    None => failure(anyhow!("Request cancelled before execution")),
                    Some(_operation) => {
                        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                        if name == "callisto_handoff" {
                            drop(_operation);
                        }
                        let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
                        let outcome = {
                            let work = call_tool(&bridge, client_id, name, &arguments);
                            tokio::pin!(work);
                            loop {
                                tokio::select! {
                                    result = &mut work => break result,
                                    incoming = stdin.next_line() => {
                                        match incoming? {
                                            None => break Err(anyhow!("MCP client disconnected; action may have completed")),
                                            Some(line) => {
                                                let next = serde_json::from_str::<Value>(&line).unwrap_or(Value::Null);
                                                if next["method"] == "notifications/cancelled" && next["params"]["requestId"] == id {
                                                    break Err(anyhow!("Request cancelled; action may have completed. Inspect before retrying."));
                                                }
                                                if next.get("id").is_some() { deferred.push_back(line); }
                                            }
                                        }
                                    }
                                }
                            }
                        };
                        if outcome.as_ref().err().is_some_and(|e| {
                            e.to_string().starts_with("Request cancelled")
                                || e.to_string().starts_with("MCP client disconnected")
                        }) {
                            // Dropped requests cannot consume late replies. Revoke the page
                            // before allowing another queued command to run.
                            bridge
                                .pending
                                .lock()
                                .await
                                .retain(|_, sender| !sender.is_closed());
                            let _ = bridge.call_session(client_id, "release", None, None).await;
                        }
                        match outcome {
                            Ok(result) => text(result),
                            Err(error) => failure(error),
                        }
                    }
                }
            }
            _ => {
                let reply = json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Method not found"}});
                stdout.write_all(format!("{reply}\n").as_bytes()).await?;
                stdout.flush().await?;
                continue;
            }
        };
        let reply = json!({"jsonrpc":"2.0","id":id,"result":result});
        stdout.write_all(format!("{reply}\n").as_bytes()).await?;
        stdout.flush().await?;
    }
    Ok(())
}

async fn acquire_operation<R: AsyncRead + Unpin>(
    input: &mut tokio::io::Lines<BufReader<R>>,
    deferred: &mut VecDeque<String>,
    id: &Value,
    operations: Arc<Mutex<()>>,
) -> Result<Option<tokio::sync::OwnedMutexGuard<()>>> {
    let wait = operations.lock_owned();
    tokio::pin!(wait);
    loop {
        tokio::select! {
            guard=&mut wait => return Ok(Some(guard)),
            incoming=input.next_line()=>{
                let Some(line)=incoming? else {bail!("MCP client disconnected while queued");};
                let message=serde_json::from_str::<Value>(&line).unwrap_or(Value::Null);
                if message["method"]=="notifications/cancelled" && message["params"]["requestId"]==*id {return Ok(None);}
                if message.get("id").is_some(){deferred.push_back(line);}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{client::IntoClientRequest, http::HeaderValue},
    };

    #[tokio::test]
    async fn handoff_rejects_conflicting_aliases_before_contacting_browser() {
        let (bridge, _) = fixture().await;
        let error = call_tool(&bridge, 1, "callisto_handoff", &json!({"message":"one","prompt":"two"}))
            .await.unwrap_err();
        assert!(error.to_string().contains("conflicting"));
    }

    #[tokio::test]
    async fn human_handoff_does_not_block_another_clients_status() {
        let (bridge, _) = fixture().await;
        let (send, mut receive) = mpsc::unbounded_channel();
        *bridge.connection.lock().await = Some(send);
        let operations = Arc::new(Mutex::new(()));
        let (mut first, server) = tokio::io::duplex(8192);
        let (read, write) = tokio::io::split(server);
        let a = tokio::spawn(serve_mcp(
            read,
            write,
            bridge.clone(),
            operations.clone(),
            101,
        ));
        first.write_all(b"{\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"callisto_handoff\",\"arguments\":{\"message\":\"Confirm fixture\"}}}\n").await.unwrap();
        let handoff = receive.recv().await.unwrap();
        assert_eq!(handoff["session"], 101);
        assert_eq!(handoff["method"], "handoff");
        let (mut second, server) = tokio::io::duplex(8192);
        let (read, write) = tokio::io::split(server);
        let b = tokio::spawn(serve_mcp(read, write, bridge.clone(), operations, 202));
        second.write_all(b"{\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"callisto_status\",\"arguments\":{}}}\n").await.unwrap();
        let status = tokio::time::timeout(Duration::from_secs(1), receive.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(status["session"], 202);
        assert_eq!(status["method"], "status");
        bridge
            .pending
            .lock()
            .await
            .remove(&status["id"].as_u64().unwrap())
            .unwrap()
            .send(Ok(json!({"connected":true})))
            .unwrap();
        let mut second = BufReader::new(second).lines();
        assert!(second
            .next_line()
            .await
            .unwrap()
            .unwrap()
            .contains("connected"));
        first
            .write_all(b"{\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":1}}\n")
            .await
            .unwrap();
        let release = receive.recv().await.unwrap();
        assert_eq!(release["session"], 101);
        assert_eq!(release["method"], "release");
        bridge
            .pending
            .lock()
            .await
            .remove(&release["id"].as_u64().unwrap())
            .unwrap()
            .send(Ok(json!({"released":true})))
            .unwrap();
        let mut first = BufReader::new(first).lines();
        assert!(first
            .next_line()
            .await
            .unwrap()
            .unwrap()
            .contains("Request cancelled"));
        drop(first);
        drop(second);
        a.await.unwrap().unwrap();
        b.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn queued_request_can_cancel_without_waiting_for_browser_lock() {
        let operations = Arc::new(Mutex::new(()));
        let _held = operations.lock().await;
        let (mut client, server) = tokio::io::duplex(1024);
        client
            .write_all(b"{\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":42}}\n")
            .await
            .unwrap();
        let mut input = BufReader::new(server).lines();
        let mut deferred = VecDeque::new();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            acquire_operation(&mut input, &mut deferred, &json!(42), operations.clone()),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn cancellation_revokes_before_returning_and_cleans_pending() {
        let (bridge, _) = fixture().await;
        let (send, mut receive) = mpsc::unbounded_channel();
        *bridge.connection.lock().await = Some(send);
        let (mut client, server) = tokio::io::duplex(8192);
        let (read, write) = tokio::io::split(server);
        let task = tokio::spawn(serve_mcp(
            read,
            write,
            bridge.clone(),
            Arc::new(Mutex::new(())),
            9,
        ));
        client.write_all(b"{\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"callisto_snapshot\",\"arguments\":{}}}\n").await.unwrap();
        assert_eq!(receive.recv().await.unwrap()["method"], "snapshot");
        client
            .write_all(b"{\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":1}}\n")
            .await
            .unwrap();
        let revoke = tokio::time::timeout(Duration::from_secs(1), receive.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(revoke["method"], "release");
        let id = revoke["id"].as_u64().unwrap();
        bridge
            .pending
            .lock()
            .await
            .remove(&id)
            .unwrap()
            .send(Ok(json!({"released":true})))
            .unwrap();
        let mut lines = BufReader::new(client).lines();
        let response = lines.next_line().await.unwrap().unwrap();
        assert!(response.contains("Request cancelled"));
        assert!(bridge.pending.lock().await.is_empty());
        drop(lines);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn client_release_is_scoped_to_its_session_on_the_wire() {
        let (bridge, _) = fixture().await;
        let (send, mut receive) = mpsc::unbounded_channel();
        *bridge.connection.lock().await = Some(send);
        let (mut client, server) = tokio::io::duplex(8192);
        let (read, write) = tokio::io::split(server);
        let task = tokio::spawn(serve_mcp(
            read,
            write,
            bridge.clone(),
            Arc::new(Mutex::new(())),
            8,
        ));
        client.write_all(b"{\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"callisto_close\",\"arguments\":{}}}\n").await.unwrap();
        let command = receive.recv().await.unwrap();
        assert_eq!(command["session"], 8);
        assert_eq!(command["method"], "release");
        bridge
            .pending
            .lock()
            .await
            .remove(&command["id"].as_u64().unwrap())
            .unwrap()
            .send(Ok(json!({"released":true})))
            .unwrap();
        let mut lines = BufReader::new(client).lines();
        assert!(lines
            .next_line()
            .await
            .unwrap()
            .unwrap()
            .contains("released"));
        drop(lines);
        task.await.unwrap().unwrap();
    }

    async fn fixture() -> (Arc<Bridge>, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let bridge = Arc::new(Bridge {
            token: "a".repeat(64),
            port,
            connection: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        });
        let shared = bridge.clone();
        tokio::spawn(async move {
            if let Ok((socket, _)) = listener.accept().await {
                serve_socket(socket, shared).await;
            }
        });
        (bridge, format!("ws://127.0.0.1:{port}"))
    }
    fn request(url: &str, origin: &str) -> tokio_tungstenite::tungstenite::http::Request<()> {
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("origin", HeaderValue::from_str(origin).unwrap());
        request
    }
    #[tokio::test]
    async fn rejects_web_page_origins() {
        let (_bridge, url) = fixture().await;
        assert!(connect_async(request(&url, "https://example.com"))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn rejects_an_incorrect_pairing_code() {
        let (bridge, url) = fixture().await;
        let (mut socket, _) = connect_async(request(&url, "moz-extension://test-id"))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({"type":"pair","protocol":2,"token":"wrong"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap();
        assert!(bridge.call("snapshot", None, None).await.is_err());
    }
    #[tokio::test]
    async fn paired_extension_receives_and_answers_scoped_commands() {
        let (bridge, url) = fixture().await;
        let (mut socket, _) = connect_async(request(&url, "moz-extension://test-id"))
            .await
            .unwrap();
        socket
            .send(Message::Text(
                json!({"type":"pair","protocol":2,"token":"a".repeat(64)})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let Some(Ok(Message::Text(ack))) = socket.next().await else {
            panic!("missing pairing acknowledgement")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&ack).unwrap()["type"],
            "paired"
        );
        for _ in 0..100 {
            if bridge.connection.lock().await.is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let responder = tokio::spawn(async move {
            let Some(Ok(Message::Text(text))) = socket.next().await else {
                panic!("missing command")
            };
            let req: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(req["method"], "fill");
            assert_eq!(req["ref"], "ax-123");
            assert_eq!(req["value"], "hello");
            socket
                .send(Message::Text(
                    json!({"id":req["id"],"result":{"completed":true}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        });
        let result = bridge
            .call("fill", Some("ax-123"), Some("hello"))
            .await
            .unwrap();
        assert_eq!(result["completed"], true);
        responder.await.unwrap();
    }
}

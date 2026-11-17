//! Experimental, opt-in local bridge for an explicitly shared Firefox/Zen tab.
//! Extension-owned observations and optional trusted BiDi input share one tab lease.
#![recursion_limit = "512"]
mod bidi;
mod keys;
mod measurement;
mod operation_contracts;
mod session_recovery;
mod tab_relay;
mod tool_catalog;
mod trace;
mod trusted_input;
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
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
    traces: Mutex<HashMap<u64, trace::Recorder>>,
    trusted: trusted_input::Controller,
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
            Duration::from_secs(if method == "handoff" || method == "demonstrate" {
                125
            } else if method == "run" {
                65
            } else if method == "page" {
                25
            } else if method == "extract" {
                40
            } else {
                15
            }),
            recv,
        )
        .await;
        self.pending.lock().await.remove(&id);
        match result {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => Err(anyhow!("The Firefox extension disconnected")),
            Err(_) => Err(anyhow!("Request timed out waiting for the tab; the action may have completed. Inspect the page before retrying.")),
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
                if response["type"]=="lease_revoked" {if let Some(lease)=response["lease_id"].as_str(){bridge.trusted.revoke(lease).await;}continue;}
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
    drop(connection);
    bridge.trusted.reset().await;
}

fn tools() -> Value {
    operation_contracts::catalog()
}

fn text(value: Value) -> Value {
    if let Some(data_url) = value.get("dataUrl").and_then(Value::as_str) {
        for mime in ["image/jpeg", "image/png"] {
            if let Some(data) = data_url.strip_prefix(&format!("data:{mime};base64,")) {
                let mut metadata = value.clone();
                metadata.as_object_mut().unwrap().remove("dataUrl");
                return json!({"content":[{"type":"image","mimeType":mime,"data":data},{"type":"text","text":metadata.to_string()}]});
            }
        }
    }
    json!({"content":[{"type":"text","text":value.to_string()}]})
}

fn failure(error: impl Into<anyhow::Error>) -> Value {
    let error = error.into();
    let mut reply = json!({"isError":true,"content":[{"type":"text","text":error.to_string()}]});
    if let Some(invalid) = error.downcast_ref::<operation_contracts::Invalid>() {
        reply["structuredContent"] = invalid.details();
    }
    reply
}
async fn call_tool(bridge: &Bridge, session_id: u64, name: &str, args: &Value) -> Result<Value> {
    let normalized = operation_contracts::normalize(name, args)?;
    let args = &normalized;
    if name == "callisto_trace" {
        return match args["action"].as_str().unwrap_or("") {
            "start" => {
                let mut traces = bridge.traces.lock().await;
                if traces.contains_key(&session_id) {
                    bail!("A trace is already active for this session");
                }
                let recorder = trace::Recorder::start(args)?;
                let result = recorder.status();
                traces.insert(session_id, recorder);
                Ok(result)
            }
            "status" => Ok(bridge
                .traces
                .lock()
                .await
                .get(&session_id)
                .map(|r| r.status())
                .unwrap_or(json!({"active":false}))),
            "checkpoint" => {
                let result = trace_checkpoint(bridge, session_id).await;
                if result.is_err() {
                    if let Some(r) = bridge.traces.lock().await.get_mut(&session_id) {
                        r.capture_failed();
                    }
                }
                result
            }
            "stop" => {
                if !bridge.traces.lock().await.contains_key(&session_id) {
                    bail!("No active trace");
                }
                let har = bridge
                    .call_session(session_id, "network", None, Some("{\"action\":\"export\"}"))
                    .await;
                let mut recorder = bridge
                    .traces
                    .lock()
                    .await
                    .remove(&session_id)
                    .ok_or_else(|| anyhow!("No active trace"))?;
                if let Ok(har) = har {
                    recorder.artifact(
                        "network.har",
                        "har-1.2",
                        &serde_json::to_vec_pretty(&har)?,
                    )?;
                }
                recorder.stop()
            }
            _ => bail!("Unsupported trace action"),
        };
    }
    let started = std::time::Instant::now();
    let sequence = match bridge.traces.lock().await.get_mut(&session_id) {
        Some(r) => Some(r.begin(name, args)?),
        None => None,
    };
    let result = call_tool_inner(bridge, session_id, name, args).await;
    if let Some(sequence) = sequence {
        if let Some(recorder) = bridge.traces.lock().await.get_mut(&session_id) {
            let elapsed = started.elapsed().as_millis();
            let measured = recorder
                .metrics
                .record(name, args, result.as_ref().ok(), elapsed);
            recorder.finish_measured(
                sequence,
                result.is_ok(),
                elapsed,
                Some(serde_json::to_value(measured)?),
            )?;
        }
        if [
            "callisto_navigate",
            "callisto_click",
            "callisto_fill",
            "callisto_press",
            "callisto_submit",
            "callisto_page",
            "callisto_scroll",
            "callisto_batch",
            "callisto_run",
            "callisto_extract",
            "callisto_frame",
        ]
        .contains(&name)
        {
            // Evidence errors are reported explicitly without misreporting a
            // completed input as failed and encouraging an unsafe retry.
            if let Err(error) = trace_checkpoint(bridge, session_id).await {
                if let Some(r) = bridge.traces.lock().await.get_mut(&session_id) {
                    r.capture_failed();
                }
                eprintln!("Callisto trace checkpoint failed: {error}");
            }
        }
    }
    result
}

async fn trace_checkpoint(bridge: &Bridge, session_id: u64) -> Result<Value> {
    let (snapshots, screenshots) = {
        let traces = bridge.traces.lock().await;
        let r = traces
            .get(&session_id)
            .ok_or_else(|| anyhow!("No active trace"))?;
        (r.snapshots, r.screenshots)
    };
    let snapshot = if snapshots {
        Some(
            bridge
                .call_session(
                    session_id,
                    "snapshot",
                    None,
                    Some("{\"preserve_refs\":true}"),
                )
                .await,
        )
    } else {
        None
    };
    let image = if screenshots {
        Some(
            bridge
                .call_session(
                    session_id,
                    "browser",
                    None,
                    Some("{\"action\":\"screenshot\",\"format\":\"png\"}"),
                )
                .await,
        )
    } else {
        None
    };
    let mut traces = bridge.traces.lock().await;
    let recorder = traces
        .get_mut(&session_id)
        .ok_or_else(|| anyhow!("Trace ended during checkpoint"))?;
    recorder.checkpoint(
        snapshot.as_ref().and_then(|r| r.as_ref().ok()),
        image.as_ref().and_then(|r| r.as_ref().ok()),
    )?;
    if snapshot.as_ref().is_some_and(|r| r.is_err()) || image.as_ref().is_some_and(|r| r.is_err()) {
        bail!("Some requested evidence could not be captured; available artifacts were saved");
    }
    Ok(recorder.status())
}

async fn run_trusted(bridge: &Bridge, client: u64, name: &str, args: &Value) -> Result<Value> {
    let batch = name == "callisto_batch";
    let steps = args[if batch { "actions" } else { "steps" }]
        .as_array()
        .ok_or_else(|| anyhow!("Run actions must be an array"))?;
    if steps.is_empty()
        || steps.len() > if batch { 10 } else { 40 }
        || args.to_string().len() > 200000
    {
        bail!("Invalid bounded run");
    }
    let started = std::time::Instant::now();
    let budget = Duration::from_secs(if batch { 10 } else { 60 });
    let mut extraction = None;
    let mut expected_lease = None;
    for (index, step) in steps.iter().enumerate() {
        let action = step["action"]
            .as_str()
            .ok_or_else(|| anyhow!("Step action required"))?;
        let work = async {
            use rand::RngCore;
            let mut bytes = [0u8; 32];
            rand::rngs::OsRng.fill_bytes(&mut bytes);
            let nonce: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let binding = bridge
                .call_session(
                    client,
                    "input_prepare",
                    None,
                    Some(&json!({"action":"bind","nonce":nonce}).to_string()),
                )
                .await?;
            let lease = binding["lease_id"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing shared lease"))?
                .to_string();
            if expected_lease
                .as_ref()
                .is_some_and(|expected| expected != &lease)
            {
                bail!("Shared tab ownership changed during the run");
            }
            expected_lease = Some(lease.clone());
            let native = if [
                "click", "fill", "submit", "select", "check", "hover", "drag", "press",
            ]
            .contains(&action)
            {
                Some(action)
            } else {
                action
                    .strip_suffix("_ref")
                    .or_else(|| action.strip_suffix("_role"))
                    .filter(|action| {
                        ["fill", "click", "submit", "hover", "check", "select"].contains(action)
                    })
            };
            if let Some(native) = native {
                let mut input = step.clone();
                input["action"] = json!(native);
                input["expected_lease"] = json!(lease);
                bridge.trusted.execute(bridge, client, &input).await?;
            } else if action == "extract" {
                extraction = Some(
                    bridge
                        .trusted
                        .extract(
                            bridge,
                            client,
                            &step
                                .as_object()
                                .map(|o| {
                                    Value::Object(
                                        o.iter()
                                            .filter(|(k, _)| k.as_str() != "action")
                                            .map(|(k, v)| (k.clone(), v.clone()))
                                            .collect(),
                                    )
                                })
                                .unwrap_or(Value::Null),
                        )
                        .await?,
                );
            } else {
                if !["navigate", "scroll", "wait", "wait_for"].contains(&action) {
                    bail!("Unsupported trusted run step");
                }
                let result = bridge
                    .call_session(
                        client,
                        "run",
                        None,
                        Some(&json!({"steps":[step]}).to_string()),
                    )
                    .await?;
                if result.get("extraction").is_some() {
                    extraction = Some(result["extraction"].clone());
                }
            }
            Ok::<(), anyhow::Error>(())
        };
        match tokio::time::timeout(budget.saturating_sub(started.elapsed()), work).await {
            Ok(Ok(())) => {}
            Ok(Err(error)) => bail!(
                "Run stopped at step {} ({action}); earlier actions may have completed: {error}",
                index + 1
            ),
            Err(_) => bail!(
                "Request timed out in trusted run at step {}; inspect before retrying",
                index + 1
            ),
        }
    }
    let mut result =
        json!({"completed":steps.len(),"elapsed_ms":started.elapsed().as_millis(),"trusted":true});
    if let Some(extraction) = extraction {
        result["extraction"] = extraction;
    }
    result["feedback"] = bridge
        .call_session(client, "page", None, Some("{\"action\":\"feedback\"}"))
        .await
        .unwrap_or(json!({"unavailable":true,"needs_observation":true}));
    if batch || args["snapshot"] == true {
        result["snapshot"] = bridge.call_session(client, "snapshot", None, None).await?;
    }
    Ok(result)
}

async fn call_tool_inner(
    bridge: &Bridge,
    session_id: u64,
    name: &str,
    args: &Value,
) -> Result<Value> {
    if [
        "callisto_console",
        "callisto_dialog",
        "callisto_emulate",
        "callisto_webmcp",
        "callisto_screenshot_diff",
    ]
    .contains(&name)
        || (name == "callisto_screenshot"
            && (bridge.trusted.enabled(session_id)
                || args["full_page"] == true
                || args.get("clip").is_some()))
    {
        return bridge.trusted.runtime(bridge, session_id, name, args).await;
    }
    if ["callisto_recording", "callisto_demonstrate"].contains(&name) {
        let method = if name == "callisto_demonstrate" {
            "demonstrate"
        } else {
            "page"
        };
        let mut input = args.clone();
        if method == "page" {
            input["action"] = json!("recording");
            input["operation"] = args["action"].clone();
        }
        return bridge
            .call_session(session_id, method, None, Some(&input.to_string()))
            .await;
    }
    if name == "callisto_page"
        && !matches!(
            args["action"].as_str(),
            Some("scroll" | "hover" | "select" | "check" | "text" | "find")
        )
    {
        bail!("Unsupported public page action");
    }
    if name == "callisto_input" {
        return match args["action"].as_str() {
            Some("enable") => {
                bridge
                    .trusted
                    .enable(
                        bridge,
                        session_id,
                        args["endpoint"]
                            .as_str()
                            .ok_or_else(|| anyhow!("Explicit BiDi endpoint required"))?,
                    )
                    .await
            }
            Some("disable") => {
                bridge.trusted.disable(session_id).await;
                Ok(bridge.trusted.status(session_id))
            }
            Some("status") => Ok(bridge.trusted.status(session_id)),
            _ => bail!("Unsupported input control action"),
        };
    }
    if bridge.trusted.enabled(session_id) {
        let native_action = match name {
            "callisto_click" => Some("click"),
            "callisto_fill" => Some("fill"),
            "callisto_press" => Some("press"),
            "callisto_submit" => Some("submit"),
            "callisto_select" => Some("select"),
            "callisto_check" => Some("check"),
            "callisto_hover" => Some("hover"),
            "callisto_drag" => Some("drag"),
            _ => None,
        };
        if let Some(action) = native_action {
            let mut input = args.clone();
            input["action"] = json!(action);
            return bridge.trusted.execute(bridge, session_id, &input).await;
        }
        if name == "callisto_page"
            && matches!(args["action"].as_str(), Some("hover" | "check" | "select"))
        {
            return bridge.trusted.execute(bridge, session_id, args).await;
        }
        if name == "callisto_extract" {
            return bridge.trusted.extract(bridge, session_id, args).await;
        }
        if ["callisto_run", "callisto_batch"].contains(&name) {
            return run_trusted(bridge, session_id, name, args).await;
        }
    }
    if [
        "callisto_select",
        "callisto_check",
        "callisto_hover",
        "callisto_drag",
        "callisto_wait_for",
        "callisto_wait",
    ]
    .contains(&name)
        || (["callisto_click", "callisto_fill", "callisto_submit"].contains(&name)
            && args.get("ref").is_none())
    {
        let mut input = args.clone();
        input["action"] = json!(name.trim_start_matches("callisto_"));
        if name == "callisto_wait" {
            return bridge
                .call_session(
                    session_id,
                    "run",
                    None,
                    Some(&json!({"steps":[input]}).to_string()),
                )
                .await;
        }
        return bridge
            .call_session(session_id, "page", None, Some(&input.to_string()))
            .await;
    }
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
            let prompt = message
                .or(legacy_prompt)
                .ok_or_else(|| anyhow!("message required"))?
                .trim();
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
        "callisto_capabilities" => {
            let mut result = json!({"schemaVersion":1,"backend":"firefox-extension","mode":"connected","snapshot":"dom","sessionModel":"per-client-tab","input":{"click":"synthetic-dom","keyboard":"synthetic-dom","fill":"synthetic-dom","nativeKeyDefaults":false},"capabilities":{"trustedInput":false,"frames":"same-origin","openShadowRoots":true,"upload":true,"existingTabAdoption":true,"cancellation":true,"handoff":true,"trace":true}});
            let connected = bridge.connection.lock().await.is_some();
            let extension = if connected {
                bridge
                    .call_session(session_id, "status", None, None)
                    .await?["capabilities"]
                    .clone()
            } else {
                Value::Null
            };
            result["extensionConnected"] = json!(connected);
            let trusted = bridge.trusted.enabled(session_id);
            result["input"] = if trusted {
                json!({"click":"webdriver-bidi","keyboard":"webdriver-bidi","fill":"webdriver-bidi","nativeKeyDefaults":true,"status":bridge.trusted.status(session_id)})
            } else {
                result["input"].clone()
            };
            result["capabilities"]["trustedInput"] =
                json!(trusted && extension["trustedBinding"] == true);
            result["capabilities"]["trustedBinding"] = json!(extension["trustedBinding"] == true);
            for feature in [
                "run",
                "extract",
                "snapshotPagination",
                "runFormControls",
                "selectorWait",
                "targetedObservation",
                "networkInspection",
                "backgroundWindow",
                "fullBrowserControl",
                "canonicalActions",
                "focusedSnapshot",
                "scopedDiff",
                "shortRefs",
                "drag",
                "recording",
                "demonstration",
                "namedTabs",
            ] {
                // An older extension may not recognize a newer action even
                // though the compiled MCP facade exposes its schema.
                result["capabilities"][feature] = json!(extension[feature].as_bool() == Some(true));
            }
            let runtime_ready = trusted && extension["canonicalActions"] == true;
            result["capabilities"]["browserRuntime"] = json!({"console":runtime_ready,"dialogs":runtime_ready,"viewport":runtime_ready,"fullPageScreenshot":runtime_ready,"screenshotDiff":runtime_ready,"webmcp":"requires page/browser API; use webmcp list"});
            Ok(result)
        }
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
            json!({"code":format!("127.0.0.1:{}#{}",bridge.port,bridge.token),"instructions":"Pair once in the extension. Future MCP sessions reuse this local relay automatically. Choose Share this tab for scoped access or Enable full browser control for automatic tab selection and creation. Check callisto_status.fullAccess; browser-protected pages remain restricted."}),
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
        "callisto_network" => {
            if args.to_string().len() > 200_000 {
                bail!("Network arguments are too large");
            }
            let mut arguments = args.clone();
            let output = arguments
                .as_object_mut()
                .and_then(|m| m.remove("output_path"));
            if output.is_some() && !matches!(args["action"].as_str(), Some("export" | "openapi")) {
                bail!("output_path is supported only for HAR/OpenAPI export");
            }
            let result = bridge
                .call_session(session_id, "network", None, Some(&arguments.to_string()))
                .await?;
            if let Some(output) = output {
                let path = std::path::Path::new(
                    output
                        .as_str()
                        .ok_or_else(|| anyhow!("output_path must be a string"))?,
                );
                if !path.is_absolute() {
                    bail!("output_path must be absolute");
                }
                return trace::save_json(path, &result);
            }
            Ok(result)
        }
        "callisto_scroll" => {
            let x = match args.get("delta_x") {
                Some(value) => value.as_f64().ok_or_else(|| anyhow!("Invalid delta_x"))?,
                None => 0.0,
            };
            let y = args
                .get("delta_y")
                .and_then(Value::as_f64)
                .ok_or_else(|| anyhow!("delta_y required"))?;
            if !x.is_finite() || !y.is_finite() {
                bail!("Invalid scroll delta");
            }
            bridge
                .call_session(
                    session_id,
                    "page",
                    None,
                    Some(&json!({"action":"scroll","delta_x":x,"delta_y":y}).to_string()),
                )
                .await
        }
        "callisto_screenshot" => {
            bridge
                .call_session(
                    session_id,
                    "browser",
                    None,
                    Some(&json!({"action":"screenshot"}).to_string()),
                )
                .await
        }
        "callisto_find" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("query required"))?;
            let max = match args.get("max_matches") {
                Some(value) => value
                    .as_u64()
                    .ok_or_else(|| anyhow!("Invalid max_matches"))?,
                None => 5,
            };
            if query.is_empty() || query.chars().count() > 200 || !(1..=10).contains(&max) {
                bail!("Invalid query or max_matches");
            }
            let mut result = bridge
                .call_session(
                    session_id,
                    "page",
                    None,
                    Some(&json!({"action":"find","query":query}).to_string()),
                )
                .await?;
            if let Some(matches) = result.get_mut("matches").and_then(Value::as_array_mut) {
                matches.truncate(max as usize);
            }
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
        "callisto_extract" => {
            if args.to_string().len() > 200_000 {
                bail!("Extract arguments are too large");
            }
            bridge
                .call_session(session_id, "extract", None, Some(&args.to_string()))
                .await
        }
        "callisto_run" => {
            let steps = args
                .get("steps")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("steps must be an array"))?;
            if steps.is_empty() || steps.len() > 40 || args.to_string().len() > 200_000 {
                bail!("Expected 1–40 steps, bounded to 200,000 bytes");
            }
            bridge
                .call_session(session_id, "run", None, Some(&args.to_string()))
                .await
        }
        "callisto_snapshot" => {
            let offset = args
                .get("offset")
                .map(|v| {
                    v.as_u64()
                        .filter(|n| *n <= 10000)
                        .ok_or_else(|| anyhow!("Invalid snapshot offset"))
                })
                .transpose()?
                .unwrap_or(0);
            let max_chars = args
                .get("max_chars")
                .map(|v| {
                    v.as_u64()
                        .filter(|n| (1000..=30000).contains(n))
                        .ok_or_else(|| anyhow!("Invalid snapshot max_chars"))
                })
                .transpose()?
                .unwrap_or(12000);
            let mut options = args
                .as_object()
                .cloned()
                .ok_or_else(|| anyhow!("Snapshot arguments must be an object"))?;
            options.insert("offset".into(), json!(offset));
            options.insert("max_chars".into(), json!(max_chars));
            bridge
                .call_session(
                    session_id,
                    "snapshot",
                    None,
                    Some(&Value::Object(options).to_string()),
                )
                .await
        }
        "callisto_status" => {
            if bridge.connection.lock().await.is_none() {
                Ok(json!({"connected":false,"sharing":false,"active":false}))
            } else {
                let mut result = bridge
                    .call_session(session_id, "status", None, None)
                    .await?;
                result["input"] = bridge.trusted.status(session_id);
                Ok(result)
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
    let mode = std::env::args().nth(1);
    if mode.as_deref() == Some("--version") {
        println!("callisto-firefox-tab-mcp {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let root = tab_relay::root()?;
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
        traces: Mutex::new(HashMap::new()),
        trusted: trusted_input::Controller::default(),
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
            bridge.trusted.disable(client_id).await;
            if let Some(recorder) = bridge.traces.lock().await.remove(&client_id) {
                let _ = recorder.stop();
            }
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
    let catalog = tools();
    let mut profile = tool_catalog::Profile::for_client(None)?;
    let mut input = BufReader::new(input).lines();
    let stream = tab_relay::connect(root).await?;
    let (read, mut write) = stream.into_split();
    let mut replies = BufReader::new(read).lines();
    let mut pending = HashMap::<String, Value>::new();
    let mut recovery = session_recovery::Policy::default();
    loop {
        let disconnected = tokio::select! {
            line=input.next_line()=>{
                let Some(mut line)=line? else {return Ok(());};
                if let Ok(mut message)=serde_json::from_str::<Value>(&line) {
                    // This interface belongs to the stdio client, not the shared relay.
                    // Different clients can choose compact/full without restarting it.
                    if message["method"] == "initialize" {
                        profile = tool_catalog::Profile::for_client(message["params"]["clientInfo"]["name"].as_str())?;
                    }
                    if message.get("id").is_some() {
                        let local = if message["method"] == "tools/list" {
                            Some(json!({"tools":tool_catalog::advertised(&catalog, profile)}))
                        } else if message["method"] == "tools/call" && message["params"]["name"] == "callisto" {
                            match tool_catalog::dispatch(&catalog, &message["params"].get("arguments").cloned().unwrap_or(json!({}))) {
                                Ok(tool_catalog::Dispatch::Help(help)) => Some(text(help)),
                                Ok(tool_catalog::Dispatch::Forward{name,arguments}) => {
                                    message["params"]["name"] = json!(name);
                                    message["params"]["arguments"] = arguments;
                                    line = message.to_string();
                                    None
                                }
                                Err(error) => Some(failure(error)),
                            }
                        } else { None };
                        if let Some(result) = local {
                            let reply=json!({"jsonrpc":"2.0","id":message["id"],"result":result});
                            output.write_all(format!("{reply}\n").as_bytes()).await?;output.flush().await?;continue;
                        }
                    }
                    if let Some(reply)=recovery.request(&message) {output.write_all(format!("{reply}\n").as_bytes()).await?;output.flush().await?;continue;}
                    if let Some(id)=message.get("id"){pending.insert(id.to_string(),message.clone());}
                }
                write.write_all(format!("{line}\n").as_bytes()).await.is_err()
            }
            line=replies.next_line()=>{
                match line {
                    Ok(Some(line))=>{
                        let mut reply=serde_json::from_str::<Value>(&line).unwrap_or(Value::Null);
                        if let Some(id)=reply.get("id"){if let Some(request)=pending.remove(&id.to_string()){
                            if request["method"] == "initialize" && reply["result"].is_object() { reply["result"]["instructions"] = json!(tool_catalog::instructions(profile)); }
                            recovery.response(&request,&mut reply);
                        }}
                        output.write_all(format!("{reply}\n").as_bytes()).await?;output.flush().await?;false
                    }
                    _=>true,
                }
            }
        };
        if disconnected {
            recovery.disconnected();
            for (_, request) in pending.drain() {
                let reply = json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":"Browser relay disconnected. The action may have completed; inspect before retrying. It was not replayed."}});
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
    let mut cancelled = HashSet::new();
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
        let was_cancelled = cancelled.remove(&id.to_string());
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
                match if was_cancelled {
                    None
                } else {
                    acquire_operation(
                        &mut stdin,
                        &mut deferred,
                        &mut cancelled,
                        &id,
                        operations.clone(),
                    )
                    .await?
                } {
                    None => failure(anyhow!("Request cancelled before execution")),
                    Some(_operation) => {
                        let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                        if ["callisto_handoff", "callisto_demonstrate"].contains(&name) {
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
                                                if next["method"] == "notifications/cancelled" {
                                                    let target = &next["params"]["requestId"];
                                                    if deferred.iter().any(|queued: &String| serde_json::from_str::<Value>(queued).ok().is_some_and(|v| v.get("id") == Some(target))) { cancelled.insert(target.to_string()); }
                                                } else if next.get("id").is_some() { deferred.push_back(line); }
                                            }
                                        }
                                    }
                                }
                            }
                        };
                        if outcome.as_ref().err().is_some_and(|e| {
                            e.to_string().starts_with("Request cancelled")
                                || e.to_string().starts_with("Request timed out")
                                || e.to_string().starts_with("MCP client disconnected")
                        }) {
                            // Dropped requests cannot consume late replies. Revoke the page
                            // before allowing another queued command to run.
                            bridge
                                .pending
                                .lock()
                                .await
                                .retain(|_, sender| !sender.is_closed());
                            if let Some(recorder) = bridge.traces.lock().await.get_mut(&client_id) {
                                if let Err(error) = recorder.interrupt() {
                                    eprintln!("Trace interruption could not be saved: {error}");
                                }
                            }
                            bridge.trusted.cancel(client_id).await;
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
    cancelled: &mut HashSet<String>,
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
                if message["method"]=="notifications/cancelled" {
                    let target = &message["params"]["requestId"];
                    if deferred.iter().any(|queued| serde_json::from_str::<Value>(queued).ok().is_some_and(|v| v.get("id") == Some(target))) { cancelled.insert(target.to_string()); }
                } else if message.get("id").is_some(){deferred.push_back(line);}
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
    async fn snapshot_rejects_invalid_output_bounds_before_contacting_browser() {
        let (bridge, _) = fixture().await;
        for args in [
            json!({"offset":-1}),
            json!({"offset":10001}),
            json!({"offset":1.5}),
            json!({"max_chars":999}),
            json!({"max_chars":30001}),
            json!({"max_chars":"1000"}),
        ] {
            let error = call_tool(&bridge, 1, "callisto_snapshot", &args)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("args."));
        }
    }

    #[tokio::test]
    async fn capabilities_negotiate_new_features_with_the_loaded_extension() {
        let (bridge, _) = fixture().await;
        let disconnected = call_tool(&bridge, 1, "callisto_capabilities", &json!({}))
            .await
            .unwrap();
        assert_eq!(disconnected["extensionConnected"], false);
        assert_eq!(disconnected["capabilities"]["run"], false);
        let (send, mut receive) = mpsc::unbounded_channel();
        *bridge.connection.lock().await = Some(send);
        for advertised in [
            json!({"trustedInput":false}),
            json!({"run":true,"extract":true,"selectorWait":true,"backgroundWindow":true,"fullBrowserControl":true}),
        ] {
            let cloned = bridge.clone();
            let task = tokio::spawn(async move {
                call_tool(&cloned, 1, "callisto_capabilities", &json!({})).await
            });
            let request = receive.recv().await.unwrap();
            assert_eq!(request["method"], "status");
            bridge
                .pending
                .lock()
                .await
                .remove(&request["id"].as_u64().unwrap())
                .unwrap()
                .send(Ok(json!({"capabilities":advertised})))
                .unwrap();
            let result = task.await.unwrap().unwrap();
            assert_eq!(result["extensionConnected"], true);
            for feature in [
                "run",
                "extract",
                "snapshotPagination",
                "runFormControls",
                "selectorWait",
                "targetedObservation",
                "networkInspection",
                "backgroundWindow",
                "fullBrowserControl",
            ] {
                assert_eq!(
                    result["capabilities"][feature],
                    advertised[feature].as_bool() == Some(true)
                );
            }
        }
    }

    #[tokio::test]
    async fn deferred_cancellation_prevents_later_dispatch() {
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
            101,
        ));
        client.write_all(b"{\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"callisto_snapshot\",\"arguments\":{}}}\n").await.unwrap();
        let first = receive.recv().await.unwrap();
        client.write_all(b"{\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"callisto_click\",\"arguments\":{\"ref\":\"ax-1\"}}}\n{\"method\":\"notifications/cancelled\",\"params\":{\"requestId\":2}}\n").await.unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        bridge
            .pending
            .lock()
            .await
            .remove(&first["id"].as_u64().unwrap())
            .unwrap()
            .send(Ok(json!({"text":"ok"})))
            .unwrap();
        let mut lines = BufReader::new(client).lines();
        assert!(lines.next_line().await.unwrap().unwrap().contains("ok"));
        assert!(lines
            .next_line()
            .await
            .unwrap()
            .unwrap()
            .contains("Request cancelled before execution"));
        assert!(receive.try_recv().is_err());
        drop(lines);
        task.await.unwrap().unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_extraction_revokes_before_returning() {
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
            101,
        ));
        client.write_all(b"{\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"callisto_extract\",\"arguments\":{\"selector\":\".row\",\"fields\":{\"name\":{}}}}}\n").await.unwrap();
        let extract = receive.recv().await.unwrap();
        assert_eq!(extract["method"], "extract");
        tokio::time::advance(Duration::from_secs(41)).await;
        let release = receive.recv().await.unwrap();
        assert_eq!(release["method"], "release");
        assert_eq!(release["session"], 101);
        bridge
            .pending
            .lock()
            .await
            .remove(&release["id"].as_u64().unwrap())
            .unwrap()
            .send(Ok(json!({"released":true})))
            .unwrap();
        let mut client = BufReader::new(client).lines();
        let response = client.next_line().await.unwrap().unwrap();
        assert!(response.contains("Request timed out"));
        assert!(bridge.pending.lock().await.is_empty());
        drop(client);
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn handoff_rejects_conflicting_aliases_before_contacting_browser() {
        let (bridge, _) = fixture().await;
        let error = call_tool(
            &bridge,
            1,
            "callisto_handoff",
            &json!({"message":"one","prompt":"two"}),
        )
        .await
        .unwrap_err();
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
        let mut cancelled = HashSet::new();
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            acquire_operation(
                &mut input,
                &mut deferred,
                &mut cancelled,
                &json!(42),
                operations.clone(),
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn public_page_cannot_call_internal_input_or_replay_actions() {
        let (bridge, _) = fixture().await;
        for action in ["api_replay", "click_next", "input_prepare", "fill", "press"] {
            let error = call_tool(&bridge, 1, "callisto_page", &json!({"action":action}))
                .await
                .unwrap_err();
            assert!(error.to_string().contains("args.action"));
        }
        assert!(bridge.pending.lock().await.is_empty());
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
            traces: Mutex::new(HashMap::new()),
            trusted: trusted_input::Controller::default(),
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

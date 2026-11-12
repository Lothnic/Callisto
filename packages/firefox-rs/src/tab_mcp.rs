//! Experimental, opt-in local bridge for an explicitly shared Firefox/Zen tab.
//! Browser input is supplied by a WebExtension and is synthetic, not BiDi input.
mod tab_relay;
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
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
    async fn call(&self, method: &str, ref_: Option<&str>, value: Option<&str>) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (send, recv) = oneshot::channel();
        let message = json!({"id":id,"method":method,"ref":ref_,"value":value});
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
        let result = tokio::time::timeout(Duration::from_secs(15), recv).await;
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
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    {
        let mut connection = bridge.connection.lock().await;
        if connection.is_some() {
            return;
        }
        if ws
            .send(Message::Text(json!({"type":"paired"}).to_string().into()))
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
        {"name":"callisto_pair","description":"Get the persistent local browser pairing code (only needed for initial setup) for the Firefox/Zen tab bridge. Enter it in the extension, then explicitly share the desired existing tab.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_status","description":"Check whether the extension is connected and a tab is shared and active, without reading page content.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_browser","description":"Manage the user's browser after they grant Enable browser access in the extension. Supports tabs, screenshots, cookies, bookmarks, history and downloads. tab_select also shares that existing tab. window_close closes the specified whole window, including its tabs; use the id returned by window_create for agent-window cleanup. Cookie values are sensitive. Downloads prompt for a save location. Zen may omit inactive workspaces.","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["tabs_list","tab_select","tab_create","window_create","window_close","agent_container","tab_close","back","forward","reload","screenshot","cookies_list","cookie_set","cookie_remove","bookmarks_search","history_search","downloads_search","download"]},"window_id":{"type":"integer","minimum":0},"tab_id":{"type":"integer","minimum":0},"url":{"type":"string"},"query":{"type":"string","maxLength":200},"agent_container":{"type":"boolean","description":"Create a new tab or window in the opt-in isolated Callisto cookie container; existing logins will not be available there."},"cookie_store_id":{"type":"string"},"name":{"type":"string"},"value":{"type":"string"}},"required":["action"]}},
        {"name":"callisto_page","description":"Additional DOM operations on the active controlled page. scroll uses viewport pixel deltas; hover dispatches synthetic pointer/mouse events; select chooses an option by value; check sets a checkbox; text returns bounded visible body text; find searches visible body text. Input events are synthetic and can be rejected by sites.","inputSchema":{"type":"object","properties":{"action":{"type":"string","enum":["scroll","hover","select","check","text","find"]},"ref":{"type":"string","pattern":"^ax-[0-9]+$"},"value":{"type":"string"},"checked":{"type":"boolean"},"delta_x":{"type":"number"},"delta_y":{"type":"number"},"query":{"type":"string","maxLength":200}},"required":["action"]}},
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
async fn call_tool(bridge: &Bridge, name: &str, args: &Value) -> Result<Value> {
    match name {
        "callisto_pair" => Ok(
            json!({"code":format!("127.0.0.1:{}#{}",bridge.port,bridge.token),"instructions":"Pair once in the extension. Future MCP sessions reuse this local relay automatically. Tab sharing and full browser permissions are separate controls."}),
        ),
        "callisto_browser" => {
            if args.to_string().len() > 200_000 {
                bail!("Browser arguments are too large");
            }
            bridge.call("browser", None, Some(&args.to_string())).await
        }
        "callisto_page" => {
            if args.to_string().len() > 200_000 {
                bail!("Page arguments are too large");
            }
            bridge.call("page", None, Some(&args.to_string())).await
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
                .call("batch", None, Some(&serde_json::to_string(steps)?))
                .await
        }
        "callisto_snapshot" => bridge.call("snapshot", None, None).await,
        "callisto_status" => {
            if bridge.connection.lock().await.is_none() {
                Ok(json!({"connected":false,"sharing":false,"active":false}))
            } else {
                bridge.call("status", None, None).await
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
            bridge.call("navigate", None, Some(url)).await
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
                .call(
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
            bridge.call("release", None, None).await
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
        let stream = tab_relay::connect(&root).await?;
        let (mut read, mut write) = stream.into_split();
        let mut stdin = tokio::io::stdin();
        let mut stdout = tokio::io::stdout();
        tokio::select! {
            result = tokio::io::copy(&mut stdin,&mut write) => { result?; },
            result = tokio::io::copy(&mut read,&mut stdout) => { result?; },
        }
        return Ok(());
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
        tokio::spawn(async move {
            let (read, write) = client.into_split();
            let _ = serve_mcp(read, write, bridge, operations).await;
        });
    }
    Ok(())
}
async fn serve_mcp<R: AsyncRead + Unpin, W: AsyncWrite + Unpin>(
    read: R,
    mut stdout: W,
    bridge: Arc<Bridge>,
    operations: Arc<Mutex<()>>,
) -> Result<()> {
    let mut stdin = BufReader::new(read).lines();
    while let Some(line) = stdin.next_line().await? {
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
                let _operation = operations.lock().await;
                match call_tool(
                    &bridge,
                    params.get("name").and_then(Value::as_str).unwrap_or(""),
                    &params.get("arguments").cloned().unwrap_or(json!({})),
                )
                .await
                {
                    Ok(result) => text(result),
                    Err(error) => failure(error),
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::{
        connect_async,
        tungstenite::{client::IntoClientRequest, http::HeaderValue},
    };

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
                json!({"type":"pair","token":"wrong"}).to_string().into(),
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
                json!({"type":"pair","token":"a".repeat(64)})
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

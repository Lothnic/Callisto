//! Experimental, opt-in local bridge for an explicitly shared Firefox/Zen tab.
//! Browser input is supplied by a WebExtension and is synthetic, not BiDi input.
use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use rand::{rngs::OsRng, RngCore};
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
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
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
        let connection = self.connection.lock().await.clone().ok_or_else(|| anyhow!("Extension not paired. Call callisto_pair, then connect and share the current tab in the extension."))?;
        self.pending.lock().await.insert(id, send);
        let message = json!({"id":id,"method":method,"ref":ref_,"value":value});
        if connection.send(message).is_err() {
            self.pending.lock().await.remove(&id);
            bail!("The Firefox extension disconnected");
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
    let ws = accept_hdr_async(socket, |request: &Request, response: Response| {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if !origin.starts_with("moz-extension://") {
            let mut error = ErrorResponse::new(Some("Firefox extension origin required".into()));
            *error.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
            return Err(error);
        }
        Ok(response)
    })
    .await;
    let Ok(mut ws) = ws else {
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
                if message.len() > 1_000_000 { break; }
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
    *bridge.connection.lock().await = None;
    for (_, waiter) in std::mem::take(&mut *bridge.pending.lock().await) {
        let _ = waiter.send(Err("The Firefox extension disconnected".into()));
    }
}

fn tools() -> Value {
    json!([
        {"name":"callisto_pair","description":"Get the local session pairing code for the Firefox/Zen tab bridge. Enter it in the extension, then explicitly share the desired existing tab.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_snapshot","description":"Inspect the explicitly shared active tab. This experimental DOM-derived snapshot can omit content and frames.","inputSchema":{"type":"object","properties":{}}},
        {"name":"callisto_click","description":"Click a ref from the latest snapshot in the shared tab using a synthetic DOM click. Some websites reject synthetic input.","inputSchema":{"type":"object","properties":{"ref":{"type":"string","pattern":"^ax-[0-9]+$"}},"required":["ref"]}},
        {"name":"callisto_fill","description":"Fill a ref from the latest snapshot in the shared tab using synthetic input events. Some websites reject synthetic input.","inputSchema":{"type":"object","properties":{"ref":{"type":"string","pattern":"^ax-[0-9]+$"},"value":{"type":"string","maxLength":100000}},"required":["ref","value"]}},
        {"name":"callisto_close","description":"Stop sharing the tab without closing it or the browser.","inputSchema":{"type":"object","properties":{}}}
    ])
}
fn text(value: Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}]})
}
fn failure(error: impl std::fmt::Display) -> Value {
    json!({"isError":true,"content":[{"type":"text","text":error.to_string()}]})
}
async fn call_tool(bridge: &Bridge, name: &str, args: &Value) -> Result<Value> {
    match name {
        "callisto_pair" => Ok(
            json!({"code":format!("127.0.0.1:{}#{}",bridge.port,bridge.token),"instructions":"Enter this code in the Callisto extension, open the desired tab and select Share this tab."}),
        ),
        "callisto_snapshot" => bridge.call("snapshot", None, None).await,
        "callisto_click" | "callisto_fill" => {
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
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let bridge = Arc::new(Bridge {
        token,
        port: listener.local_addr()?.port(),
        connection: Mutex::new(None),
        pending: Mutex::new(HashMap::new()),
        next_id: AtomicU64::new(1),
    });
    let accept_bridge = bridge.clone();
    let server = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            tokio::spawn(serve_socket(socket, accept_bridge.clone()));
        }
    });
    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    let mut stdout = tokio::io::stdout();
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
            "ping" => json!({}),
            "tools/list" => json!({"tools":tools()}),
            "tools/call" => match call_tool(
                &bridge,
                params.get("name").and_then(Value::as_str).unwrap_or(""),
                &params.get("arguments").cloned().unwrap_or(json!({})),
            )
            .await
            {
                Ok(result) => text(result),
                Err(error) => failure(error),
            },
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
    server.abort();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
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

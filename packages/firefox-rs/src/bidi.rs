// Minimal WebDriver BiDi client over a single WebSocket.
//
// One reader task owns the socket's read half and routes responses to waiting
// callers by message id. Events are broadcast to subscribers so the engine can
// turn navigation, dialogs and network activity into agent signals.
use anyhow::{anyhow, Result};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

// Dropped calls (including those cancelled by an outer timeout) must not leave
// a sender behind forever when a browser never answers a command.
struct PendingGuard {
    pending: Pending,
    id: u64,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

#[derive(Debug, Clone)]
pub struct BidiEvent {
    pub method: String,
    pub params: Value,
}

pub struct Bidi {
    write: Mutex<
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
    >,
    pending: Pending,
    closed: Arc<AtomicBool>,
    next_id: AtomicU64,
    events: broadcast::Sender<BidiEvent>,
}

impl Bidi {
    pub async fn connect(url: &str) -> Result<Arc<Self>> {
        let (socket, _) = tokio_tungstenite::connect_async(url).await?;
        let (write, mut read) = socket.split();
        let pending: Pending = Arc::new(StdMutex::new(HashMap::new()));
        let events = broadcast::channel(256).0;
        let closed = Arc::new(AtomicBool::new(false));

        let reader_pending = pending.clone();
        let reader_events = events.clone();
        let reader_closed = closed.clone();
        tokio::spawn(async move {
            while let Some(next) = read.next().await {
                let Ok(message) = next else { break };
                let text = match message {
                    Message::Text(text) => text.to_string(),
                    Message::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                    Message::Close(_) => break,
                    _ => continue,
                };
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(Value::as_u64) {
                    let sender = reader_pending
                        .lock()
                        .ok()
                        .and_then(|mut pending| pending.remove(&id));
                    if let Some(sender) = sender {
                        let outcome = match value.get("error") {
                            Some(error) => Err(error.to_string()),
                            None => Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                        };
                        let _ = sender.send(outcome);
                    }
                } else if let Some(method) = value.get("method").and_then(Value::as_str) {
                    let _ = reader_events.send(BidiEvent {
                        method: method.to_string(),
                        params: value.get("params").cloned().unwrap_or(Value::Null),
                    });
                }
            }
            // Wake every in-flight request when the connection drops instead
            // of leaving its receiver waiting indefinitely.
            reader_closed.store(true, Ordering::SeqCst);
            let waiting = reader_pending
                .lock()
                .map(|mut pending| std::mem::take(&mut *pending))
                .unwrap_or_default();
            for (_, sender) in waiting {
                let _ = sender.send(Err("BiDi connection closed".into()));
            }
        });

        Ok(Arc::new(Self {
            write: Mutex::new(write),
            pending,
            closed,
            next_id: AtomicU64::new(1),
            events,
        }))
    }

    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(anyhow!("BiDi connection closed"));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .map_err(|_| anyhow!("BiDi request registry is unavailable"))?
            .insert(id, sender);
        let _guard = PendingGuard {
            pending: self.pending.clone(),
            id,
        };
        if self.closed.load(Ordering::SeqCst) {
            return Err(anyhow!("BiDi connection closed"));
        }
        let message = json!({ "id": id, "method": method, "params": params });
        self.write
            .lock()
            .await
            .send(Message::Text(message.to_string().into()))
            .await?;
        match receiver.await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(anyhow!("{method} failed: {error}")),
            Err(_) => Err(anyhow!("{method} failed: BiDi connection closed")),
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<BidiEvent> {
        self.events.subscribe()
    }
}

/// Turn a BiDi `RemoteValue` into a plain JSON value.
pub fn remote_to_json(value: &Value) -> Value {
    match value.get("type").and_then(Value::as_str) {
        Some("undefined") | Some("null") => Value::Null,
        Some("array") | Some("set") | Some("nodelist") => value
            .get("value")
            .and_then(Value::as_array)
            .map(|items| Value::Array(items.iter().map(remote_to_json).collect()))
            .unwrap_or(Value::Null),
        Some("object") | Some("map") => {
            let mut object = serde_json::Map::new();
            if let Some(entries) = value.get("value").and_then(Value::as_array) {
                for entry in entries {
                    if let Some(pair) = entry.as_array() {
                        if pair.len() == 2 {
                            let key = match &pair[0] {
                                Value::String(text) => text.clone(),
                                other => remote_to_json(other).to_string(),
                            };
                            object.insert(key, remote_to_json(&pair[1]));
                        }
                    }
                }
            }
            Value::Object(object)
        }
        _ => value.get("value").cloned().unwrap_or(Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio::time::{timeout, Duration};
    use tokio_tungstenite::accept_async;

    #[tokio::test]
    async fn disconnect_rejects_pending_request() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            let _ = ws.next().await;
            ws.close(None).await.unwrap();
        });
        let client = Bidi::connect(&format!("ws://{addr}")).await.unwrap();
        let result = timeout(
            Duration::from_secs(2),
            client.call("test.pending", json!({})),
        )
        .await
        .unwrap();
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("connection closed"));
        assert!(client.pending.lock().unwrap().is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn cancelled_request_is_removed_from_pending_registry() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();
            let _ = ws.next().await;
            tokio::time::sleep(Duration::from_millis(200)).await;
        });
        let client = Bidi::connect(&format!("ws://{addr}")).await.unwrap();
        assert!(timeout(
            Duration::from_millis(50),
            client.call("test.pending", json!({}))
        )
        .await
        .is_err());
        assert!(client.pending.lock().unwrap().is_empty());
        server.await.unwrap();
    }
}

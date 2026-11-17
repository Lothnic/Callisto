//! Lease-bound browser facilities. No URL-based context selection or input fallback.
use super::{Binding, Controller, Transport};
use crate::{bidi::remote_to_json, Bridge};
use anyhow::{bail, Context, Result};
use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{atomic::Ordering, Arc, Mutex},
    time::Duration,
};

#[derive(Default)]
pub(super) struct Runtime {
    lease: String,
    context: String,
    entries: VecDeque<Value>,
    dropped: u64,
    prompt: Option<Value>,
    last_prompt: Option<Value>,
    console: bool,
    dialog: bool,
    subscriptions: Vec<(String, String)>,
    baseline: Option<Capture>,
}
struct Capture {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}
impl Controller {
    async fn runtime_guard(&self, bridge: &Bridge, client: u64, binding: &Binding) -> Result<()> {
        let status = bridge.call_session(client, "status", None, None).await?;
        if !binding.valid.load(Ordering::SeqCst)
            || status["lease_id"] != binding.lease
            || status["sharing"] != true
            || status["active"] != true
        {
            bail!("Browser facility lease expired; no operation was replayed");
        }
        Ok(())
    }
    async fn observation(
        &self,
        transport: Arc<Transport>,
        binding: Arc<Binding>,
        client: u64,
    ) -> Arc<Mutex<Runtime>> {
        let mut state = self.state.lock().unwrap();
        if let Some(runtime) = state.runtime.get(&client) {
            if {
                let state = runtime.lock().unwrap();
                state.lease == binding.lease && state.context == binding.context
            } {
                return runtime.clone();
            }
        }
        let runtime = Arc::new(Mutex::new(Runtime {
            lease: binding.lease.clone(),
            context: binding.context.clone(),
            ..Default::default()
        }));
        state.runtime.insert(client, runtime.clone());
        let observer = runtime.clone();
        let mut events = transport.bidi.subscribe();
        tokio::spawn(async move {
            loop {
                if !binding.valid.load(Ordering::SeqCst) || transport.bidi.is_closed() {
                    break;
                }
                match tokio::time::timeout(Duration::from_millis(250), events.recv()).await {
                    Ok(Ok(event)) => {
                        let mut state = observer.lock().unwrap();
                        if event.method == "log.entryAdded"
                            && state.console
                            && event.params["source"]["context"] == binding.context
                        {
                            let mut entry = json!({"level":event.params["level"],"type":event.params["type"],"timestamp":event.params["timestamp"],"text":event.params["text"].as_str().unwrap_or("").chars().take(4000).collect::<String>()});
                            entry["context"] = json!(binding.context);
                            if state.entries.len() == 200 {
                                state.entries.pop_front();
                                state.dropped += 1;
                            }
                            state.entries.push_back(entry);
                        }
                        if event.params["context"] == binding.top && state.dialog {
                            if event.method == "browsingContext.userPromptOpened" {
                                state.last_prompt = Some(event.params.clone());
                                state.prompt = Some(event.params);
                            }
                            if event.method == "browsingContext.userPromptClosed" {
                                state.prompt = None;
                            }
                        }
                    }
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(n))) => {
                        observer.lock().unwrap().dropped += n;
                    }
                    Ok(Err(_)) => break,
                    Err(_) => {}
                }
            }
            let subscriptions = std::mem::take(&mut observer.lock().unwrap().subscriptions);
            for (_, id) in subscriptions {
                let _ = transport
                    .bidi
                    .call("session.unsubscribe", json!({"subscriptions":[id]}))
                    .await;
            }
        });
        runtime
    }
    pub async fn runtime(
        &self,
        bridge: &Bridge,
        client: u64,
        name: &str,
        args: &Value,
    ) -> Result<Value> {
        if !self.enabled(client) {
            bail!("{name} requires lease-bound BiDi. Enable input with an explicit endpoint first; no synthetic fallback is used.");
        }
        let transport = self.transport(None).await?;
        // An open native prompt blocks script execution. Only a previously bound
        // dialog observer may handle it, guarded by the live extension lease.
        let cached = self.state.lock().unwrap().bindings.get(&client).cloned();
        let binding = if name == "callisto_dialog" && args["action"] != "start" {
            cached.context("Start dialog observation before opening a browser prompt")?
        } else {
            self.prepare(bridge, client, &transport, &json!({"action":"bind"}))
                .await?
                .0
        };
        self.runtime_guard(bridge, client, &binding).await?;
        let runtime = self
            .observation(transport.clone(), binding.clone(), client)
            .await;
        match name {
            "callisto_console" | "callisto_dialog" => {
                let console = name == "callisto_console";
                let family = if console { "console" } else { "dialog" };
                let action = args["action"].as_str().unwrap_or("");
                if action == "start" {
                    let active = {
                        let state = runtime.lock().unwrap();
                        if console {
                            state.console
                        } else {
                            state.dialog
                        }
                    };
                    if !active {
                        let events = if console {
                            json!(["log.entryAdded"])
                        } else {
                            json!([
                                "browsingContext.userPromptOpened",
                                "browsingContext.userPromptClosed"
                            ])
                        };
                        // Set before subscribing so immediate events are retained.
                        {
                            let mut state = runtime.lock().unwrap();
                            if console {
                                state.console = true;
                                state.entries.clear();
                                state.dropped = 0;
                            } else {
                                state.dialog = true;
                                state.prompt = None;
                                state.last_prompt = None;
                            }
                        }
                        let result = transport
                            .bidi
                            .call(
                                "session.subscribe",
                                json!({"events":events,"contexts":[binding.top]}),
                            )
                            .await;
                        let subscription = match result {
                            Ok(v) => v,
                            Err(error) => {
                                let mut state = runtime.lock().unwrap();
                                if console {
                                    state.console = false
                                } else {
                                    state.dialog = false
                                };
                                return Err(error);
                            }
                        };
                        let id = subscription["subscription"]
                            .as_str()
                            .context("Browser did not return an event subscription")?;
                        runtime
                            .lock()
                            .unwrap()
                            .subscriptions
                            .push((family.into(), id.into()));
                    }
                } else if action == "stop" {
                    let ids = {
                        let mut state = runtime.lock().unwrap();
                        if console {
                            state.console = false
                        } else {
                            state.dialog = false;
                            state.prompt = None;
                        };
                        let mut ids = Vec::new();
                        state.subscriptions.retain(|(kind, id)| {
                            if kind == family {
                                ids.push(id.clone());
                                false
                            } else {
                                true
                            }
                        });
                        ids
                    };
                    for id in ids {
                        transport
                            .bidi
                            .call("session.unsubscribe", json!({"subscriptions":[id]}))
                            .await?;
                    }
                } else if !console && ["accept", "dismiss"].contains(&action) {
                    if {
                        let state = runtime.lock().unwrap();
                        !state.dialog || state.prompt.is_none()
                    } {
                        bail!("No observed prompt in this tab; start observation before triggering one");
                    }
                    let mut params = json!({"context":binding.top,"accept":action=="accept"});
                    if let Some(text) = args.get("text") {
                        params["userText"] = text.clone();
                    }
                    transport
                        .bidi
                        .call("browsingContext.handleUserPrompt", params)
                        .await
                        .context("Dialog outcome may be unknown; inspect before retrying")?;
                    runtime.lock().unwrap().prompt = None;
                }
                self.runtime_guard(bridge, client, &binding).await?;
                let mut state = runtime.lock().unwrap();
                if console {
                    let limit = args["limit"].as_u64().unwrap_or(50) as usize;
                    let entries: Vec<_> = state
                        .entries
                        .iter()
                        .rev()
                        .take(limit)
                        .cloned()
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect();
                    let result = json!({"active":state.console,"entries":entries,"dropped":state.dropped,"retained":state.entries.len()});
                    if args["clear"] == true {
                        state.entries.clear();
                        state.dropped = 0;
                    }
                    Ok(result)
                } else {
                    Ok(
                        json!({"active":state.dialog,"prompt":state.prompt,"last_prompt":state.last_prompt,"handled":(["accept","dismiss"].contains(&action))}),
                    )
                }
            }
            "callisto_emulate" => {
                let params = if args["action"] == "reset" {
                    json!({"context":binding.top,"viewport":null,"devicePixelRatio":null})
                } else {
                    let width = args["width"]
                        .as_u64()
                        .context("viewport requires width and height")?;
                    let height = args["height"]
                        .as_u64()
                        .context("viewport requires width and height")?;
                    json!({"context":binding.top,"viewport":{"width":width,"height":height},"devicePixelRatio":args["device_pixel_ratio"].as_f64().unwrap_or(1.0)})
                };
                transport
                    .bidi
                    .call("browsingContext.setViewport", params)
                    .await?;
                self.runtime_guard(bridge, client, &binding).await?;
                Ok(json!({"completed":true,"viewport":args,"needs_observation":true}))
            }
            "callisto_screenshot" | "callisto_screenshot_diff" => {
                let diff = name == "callisto_screenshot_diff";
                if diff && args["action"] == "clear" {
                    runtime.lock().unwrap().baseline = None;
                    return Ok(json!({"cleared":true}));
                }
                let format = if diff {
                    "png"
                } else {
                    args["format"].as_str().unwrap_or("jpeg")
                };
                let mut params = json!({"context":binding.top,"origin":if args["full_page"]==true{"document"}else{"viewport"},"format":{"type":format!("image/{format}")}});
                if let Some(clip) = args.get("clip") {
                    let mut clip = clip.clone();
                    clip["type"] = json!("box");
                    params["clip"] = clip;
                }
                let capture = transport
                    .bidi
                    .call("browsingContext.captureScreenshot", params)
                    .await?;
                self.runtime_guard(bridge, client, &binding).await?;
                let data = capture["data"]
                    .as_str()
                    .context("Screenshot data missing")?;
                if data.len() > 24_000_000 {
                    bail!("Screenshot exceeds the bounded result size; use a clip");
                }
                if !diff {
                    return Ok(
                        json!({"dataUrl":format!("data:image/{format};base64,{data}"),"full_page":args["full_page"]==true}),
                    );
                }
                let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
                let current = decode_png(&bytes)?;
                let mut state = runtime.lock().unwrap();
                if args["action"] == "baseline" {
                    let result =
                        json!({"baseline":true,"width":current.width,"height":current.height});
                    state.baseline = Some(current);
                    return Ok(result);
                }
                let previous = state
                    .baseline
                    .as_ref()
                    .context("Set screenshot_diff action=baseline before comparing")?;
                if previous.width != current.width || previous.height != current.height {
                    return Ok(
                        json!({"dimensions_changed":true,"before":{"width":previous.width,"height":previous.height},"after":{"width":current.width,"height":current.height},"changed_pixels":null}),
                    );
                }
                let changed = previous
                    .pixels
                    .chunks_exact(4)
                    .zip(current.pixels.chunks_exact(4))
                    .filter(|(a, b)| a != b)
                    .count();
                Ok(
                    json!({"dimensions_changed":false,"changed_pixels":changed,"total_pixels":u64::from(current.width)*u64::from(current.height),"changed_ratio":changed as f64/(f64::from(current.width)*f64::from(current.height))}),
                )
            }
            "callisto_webmcp" => {
                let serialized = serde_json::to_string(args)?;
                let expression = format!(
                    r#"(async()=>{{
                    const spec={serialized};
                    const api=document.modelContext;
                    if(!api || typeof api.getTools!=='function' || typeof api.executeTool!=='function'){{if(spec.action==='list')return {{supported:false,tools:[]}};throw Error('This browser/page does not expose document.modelContext getTools/executeTool');}}
                    const tools=await api.getTools();
                    if(spec.action==='list')return {{supported:true,tools:tools.slice(0,100).map(t=>({{name:t.name,description:t.description,inputSchema:t.inputSchema}})),truncated:tools.length>100}};
                    const matches=tools.filter(t=>t.name===spec.name);
                    if(matches.length!==1)throw Error('WebMCP tool name must identify exactly one current tool');
                    return {{result:await api.executeTool(matches[0],spec.arguments||{{}})}};
                }})()"#
                );
                let result=transport.bidi.call("script.evaluate",json!({"expression":expression,"target":{"context":binding.context},"awaitPromise":true,"resultOwnership":"none"})).await?;
                if result["type"] == "exception" {
                    bail!(
                        "Page WebMCP execution failed; do not replay an uncertain write: {}",
                        result["exceptionDetails"]["text"]
                    );
                }
                self.runtime_guard(bridge, client, &binding).await?;
                let result = remote_to_json(&result["result"]);
                if result.to_string().len() > 100_000 {
                    bail!("Page WebMCP result exceeds 100000 bytes; request a smaller result");
                }
                Ok(result)
            }
            _ => bail!("Unsupported lease-bound browser facility"),
        }
    }
}
fn decode_png(bytes: &[u8]) -> Result<Capture> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder.read_info()?;
    if u64::from(reader.info().width) * u64::from(reader.info().height) > 16 * 1024 * 1024 {
        bail!("Screenshot exceeds 16 megapixel comparison limit");
    }
    if reader.output_buffer_size() > 64 * 1024 * 1024 {
        bail!("Screenshot exceeds 64 MiB decoded limit");
    }
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer)?;
    let bytes = &buffer[..info.buffer_size()];
    let mut pixels = Vec::new();
    match info.color_type {
        png::ColorType::Rgba => pixels.extend_from_slice(bytes),
        png::ColorType::Rgb => {
            for p in bytes.chunks_exact(3) {
                pixels.extend_from_slice(&[p[0], p[1], p[2], 255]);
            }
        }
        png::ColorType::Grayscale => {
            for p in bytes {
                pixels.extend_from_slice(&[*p, *p, *p, 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for p in bytes.chunks_exact(2) {
                pixels.extend_from_slice(&[p[0], p[0], p[0], p[1]]);
            }
        }
        _ => bail!("Unsupported decoded PNG color type"),
    }
    Ok(Capture {
        width: info.width,
        height: info.height,
        pixels,
    })
}

// Minimal MCP stdio server over the Firefox/Zen engine.
//
// The protocol surface is deliberately identical to packages/mini/src/mcp.ts:
// eleven tools, the same names, schemas, descriptions and bounded-snapshot
// paging. Keeping this hand-written avoids depending on an MCP SDK whose API
// churns faster than the tool surface does.
mod bidi;
mod browser;
mod diff;
mod engine;
mod format;
mod keys;
mod prune;
mod refs;
mod snapshot;

use anyhow::{anyhow, bail, Result};
use browser::{AttachOptions, BrowserKind, LaunchOptions};
use engine::{Engine, TabInfo, Target};
use serde_json::{json, Map, Value};
use std::io::Write;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use snapshot::Snapshot;

const DEFAULT_MAX_CHARS: usize = 12_000;
const MAX_TOOL_CHARS: usize = 30_000;
const MIN_TOOL_CHARS: usize = 1_000;

struct Cached {
    value: Snapshot,
    diff: bool,
    revision: u64,
}

struct State {
    mode: String,
    headless: bool,
    kind: BrowserKind,
    viewport: (u32, u32),
    bidi_url: Option<String>,
    bidi_port: Option<u16>,
    bidi_context: Option<String>,
    tab: Option<String>,
    engine: Option<Engine>,
    cache: Option<Cached>,
}

impl State {
    fn from_env() -> Self {
        let mode = std::env::var("CALLISTO_MCP_BROWSER").unwrap_or_else(|_| "isolated".to_string());
        let headless = std::env::var("CALLISTO_MCP_HEADLESS")
            .map(|v| v != "0")
            .unwrap_or(true);
        let kind = std::env::var("CALLISTO_BROWSER")
            .ok()
            .and_then(|name| BrowserKind::from_name(&name))
            .unwrap_or(BrowserKind::Firefox);
        let viewport = std::env::var("CALLISTO_VIEWPORT")
            .ok()
            .and_then(|value| parse_viewport(&value))
            .unwrap_or((1440, 900));
        let bidi_url = non_empty_env("CALLISTO_BIDI_URL");
        let bidi_port = non_empty_env("CALLISTO_BIDI_PORT").and_then(|value| value.parse().ok());
        let bidi_context = non_empty_env("CALLISTO_BIDI_CONTEXT");
        let tab = non_empty_env("CALLISTO_TAB");
        Self {
            mode,
            headless,
            kind,
            viewport,
            bidi_url,
            bidi_port,
            bidi_context,
            tab,
            engine: None,
            cache: None,
        }
    }

    async fn ensure_engine(&mut self) -> Result<&mut Engine> {
        if self.engine.is_none() {
            let engine = match self.mode.as_str() {
                "isolated" => {
                    Engine::launch(LaunchOptions {
                        kind: self.kind,
                        executable: None,
                        headless: self.headless,
                        viewport: self.viewport,
                    })
                    .await?
                }
                "connected" => {
                    Engine::attach(AttachOptions {
                        url: self.bidi_url.clone(),
                        port: self.bidi_port,
                        context: self.bidi_context.clone(),
                        tab: self.tab.clone(),
                    })
                    .await?
                }
                other => bail!("CALLISTO_MCP_BROWSER must be isolated or connected (got {other})"),
            };
            self.engine = Some(engine);
        }
        Ok(self.engine.as_mut().unwrap())
    }

    async fn close(&mut self) {
        self.cache = None;
        if let Some(engine) = self.engine.take() {
            let _ = engine.close().await;
        }
    }

    async fn bounded_snapshot(
        &mut self,
        diff: bool,
        offset: usize,
        max_chars: usize,
    ) -> Result<Value> {
        if offset == 0 {
            // A failed recapture must not leave an older page available.
            self.cache = None;
            let engine = self.ensure_engine().await?;
            engine.settle().await;
            let revision = engine.revision();
            let value = engine.snapshot(diff).await?;
            if revision != engine.revision() {
                bail!("The page changed during snapshot capture; try again.");
            }
            self.cache = Some(Cached {
                value,
                diff,
                revision,
            });
        }
        let (cached, cache_diff, cache_revision) = {
            let Some(cache) = self.cache.as_ref() else {
                bail!("No matching captured snapshot; request offset 0 first.");
            };
            (cache.value.clone(), cache.diff, cache.revision)
        };
        let engine = self.ensure_engine().await?;
        if cache_diff != diff || cache_revision != engine.revision() {
            self.cache = None;
            bail!("No matching captured snapshot; request offset 0 first.");
        }
        let chars: Vec<char> = cached.text.chars().collect();
        let total = chars.len();
        let start = offset.min(total);
        let end = (start + max_chars).min(total);
        let text: String = chars[start..end].iter().collect();
        let next_offset = if end < total { Some(end) } else { None };

        let mut object = Map::new();
        object.insert("url".into(), json!(cached.url));
        object.insert("title".into(), json!(cached.title));
        object.insert("text".into(), json!(text));
        if !cached.warnings.is_empty() {
            object.insert("warnings".into(), json!(cached.warnings));
        }
        object.insert("offset".into(), json!(offset));
        object.insert("totalChars".into(), json!(total));
        object.insert("nextOffset".into(), json!(next_offset));
        Ok(Value::Object(object))
    }
}

fn parse_viewport(value: &str) -> Option<(u32, u32)> {
    let (width, height) = value.split_once(['x', 'X'])?;
    Some((width.trim().parse().ok()?, height.trim().parse().ok()?))
}

fn non_empty_env(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

// --- tool catalog ---------------------------------------------------------

fn tool_catalog() -> Value {
    json!([
        {
            "name": "callisto_navigate",
            "description": "Open an HTTP(S) URL in the configured Callisto browser session and return its accessibility snapshot. The browser session starts on the first call.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "format": "uri" }
                },
                "required": ["url"]
            },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "callisto_snapshot",
            "description": "Get a bounded accessibility snapshot with ax-N refs. Use nextOffset to page through the last captured snapshot; a new capture replaces it. Refs can become stale when the page changes. diff=true captures changes since the previous snapshot.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "diff": { "type": "boolean", "default": false },
                    "offset": { "type": "integer", "minimum": 0, "default": 0 },
                    "max_chars": { "type": "integer", "minimum": 1000, "maximum": 30000, "default": 12000 }
                }
            },
            "annotations": { "openWorldHint": true, "readOnlyHint": true }
        },
        {
            "name": "callisto_find",
            "description": "Find text in the full accessibility snapshot and return bounded matching snippets, including nearby refs when present.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "minLength": 1, "maxLength": 200 },
                    "max_matches": { "type": "integer", "minimum": 1, "maximum": 10, "default": 5 }
                },
                "required": ["query"]
            },
            "annotations": { "openWorldHint": true, "readOnlyHint": true }
        },
        {
            "name": "callisto_click",
            "description": "Click a snapshot ref after checking visibility, stability, enabled state and whether it receives events. Return an updated snapshot.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ref": { "type": "string", "pattern": "^ax-\\d+$" }
                },
                "required": ["ref"]
            },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "callisto_fill",
            "description": "Replace the value of an editable snapshot ref and return an updated snapshot.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "ref": { "type": "string", "pattern": "^ax-\\d+$" },
                    "value": { "type": "string", "maxLength": 100000 }
                },
                "required": ["ref", "value"]
            },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "callisto_press",
            "description": "Press a supported key or chord, such as Enter, Escape, ArrowDown or Control+A, on the focused element; return an updated snapshot.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "key": { "type": "string", "minLength": 1, "maxLength": 40 }
                },
                "required": ["key"]
            },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "callisto_scroll",
            "description": "Scroll by pixel deltas at the viewport center and return an updated snapshot.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "delta_x": { "type": "number", "default": 0 },
                    "delta_y": { "type": "number" }
                },
                "required": ["delta_y"]
            },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "callisto_handoff",
            "description": "In connected mode, ask the person to complete a step in the session-owned browser tab and wait for their confirmation. A confirmation does not verify the outcome; inspect the returned snapshot. The request may time out or be cancelled.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "message": { "type": "string", "minLength": 1, "maxLength": 500 },
                    "timeout_ms": { "type": "integer", "minimum": 1000, "maximum": 120000, "default": 60000 }
                },
                "required": ["message"]
            },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "callisto_batch",
            "description": "Execute up to 10 structured browser actions in order and return a bounded snapshot. Prior actions are not rolled back if a later action fails.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "actions": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 10,
                        "items": {
                            "oneOf": [
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": { "const": "navigate" },
                                        "url": { "type": "string", "format": "uri" }
                                    },
                                    "required": ["action", "url"]
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": { "const": "click_ref" },
                                        "ref": { "type": "string", "pattern": "^ax-\\d+$" }
                                    },
                                    "required": ["action", "ref"]
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": { "const": "click_role" },
                                        "role": { "type": "string", "minLength": 1, "maxLength": 50 },
                                        "name": { "type": "string", "minLength": 1, "maxLength": 200 }
                                    },
                                    "required": ["action", "role", "name"]
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": { "const": "fill_ref" },
                                        "ref": { "type": "string", "pattern": "^ax-\\d+$" },
                                        "value": { "type": "string", "maxLength": 100000 }
                                    },
                                    "required": ["action", "ref", "value"]
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": { "const": "fill_role" },
                                        "role": { "type": "string", "minLength": 1, "maxLength": 50 },
                                        "name": { "type": "string", "minLength": 1, "maxLength": 200 },
                                        "value": { "type": "string", "maxLength": 100000 }
                                    },
                                    "required": ["action", "role", "name", "value"]
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": { "const": "press" },
                                        "key": { "type": "string", "minLength": 1, "maxLength": 40 }
                                    },
                                    "required": ["action", "key"]
                                },
                                {
                                    "type": "object",
                                    "properties": {
                                        "action": { "const": "scroll" },
                                        "delta_x": { "type": "number" },
                                        "delta_y": { "type": "number" }
                                    },
                                    "required": ["action", "delta_x", "delta_y"]
                                }
                            ]
                        }
                    }
                },
                "required": ["actions"]
            },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "callisto_screenshot",
            "description": "Capture the current browser viewport as a PNG image.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "openWorldHint": true, "readOnlyHint": true }
        },
        {
            "name": "callisto_close",
            "description": "Close the Callisto browser session and its agent-owned tab. A later browser call starts a fresh session.",
            "inputSchema": { "type": "object", "properties": {} },
            "annotations": { "openWorldHint": true }
        },
        {
            "name": "callisto_tabs",
            "description": "List, switch, open or close tabs. In connected mode this operates on the person's existing browser: switch to a tab before acting on it. target accepts a tab index, a browsing context id, or a URL/title substring.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["list", "switch", "new", "close"] },
                    "target": { "type": "string", "maxLength": 2000 },
                    "url": { "type": "string", "format": "uri" }
                },
                "required": ["action"]
            },
            "annotations": { "openWorldHint": true }
        }
    ])
}

// --- argument helpers -----------------------------------------------------

fn arg<'a>(args: &'a Value, key: &str) -> Option<&'a Value> {
    args.get(key).filter(|value| !value.is_null())
}

fn arg_string(args: &Value, key: &str) -> Option<String> {
    arg(args, key).and_then(Value::as_str).map(str::to_string)
}

fn required_string(args: &Value, key: &str) -> Result<String> {
    arg_string(args, key).ok_or_else(|| anyhow!("missing required argument: {key}"))
}

fn arg_bool(args: &Value, key: &str, default: bool) -> bool {
    arg(args, key).and_then(Value::as_bool).unwrap_or(default)
}

fn arg_usize(args: &Value, key: &str, default: usize) -> usize {
    arg(args, key)
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(default)
}

fn arg_f64(args: &Value, key: &str, default: f64) -> Result<f64> {
    match arg(args, key) {
        None => Ok(default),
        Some(value) => value
            .as_f64()
            .ok_or_else(|| anyhow!("argument {key} must be a number")),
    }
}

fn valid_ref(value: &str) -> bool {
    match value.strip_prefix("ax-") {
        Some(digits) => !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

fn required_ref(args: &Value) -> Result<String> {
    let ref_ = required_string(args, "ref")?;
    if !valid_ref(&ref_) {
        bail!("ref must match ax-N");
    }
    Ok(ref_)
}

fn required_http_url(args: &Value) -> Result<String> {
    let url = required_string(args, "url")?;
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        bail!("Only HTTP(S) URLs are supported");
    }
    Ok(url)
}

// --- tool implementations -------------------------------------------------

async fn call_tool(state: &mut State, name: &str, args: &Value) -> Result<Value> {
    match name {
        "callisto_navigate" => {
            let url = required_http_url(args)?;
            let engine = state.ensure_engine().await?;
            engine.goto(&url, "domcontentloaded", 20_000).await?;
            state.bounded_snapshot(false, 0, DEFAULT_MAX_CHARS).await
        }
        "callisto_snapshot" => {
            let diff = arg_bool(args, "diff", false);
            let offset = arg_usize(args, "offset", 0);
            let max_chars = arg_usize(args, "max_chars", DEFAULT_MAX_CHARS)
                .clamp(MIN_TOOL_CHARS, MAX_TOOL_CHARS);
            state.bounded_snapshot(diff, offset, max_chars).await
        }
        "callisto_find" => {
            let query = required_string(args, "query")?;
            if query.is_empty() || query.chars().count() > 200 {
                bail!("query must be between 1 and 200 characters");
            }
            let max_matches = arg_usize(args, "max_matches", 5).clamp(1, 10);
            let engine = state.ensure_engine().await?;
            let snapshot = engine.snapshot(false).await?;
            let matches = find_matches(&snapshot.text, &query, max_matches);
            let mut object = Map::new();
            object.insert("url".into(), json!(snapshot.url));
            object.insert("title".into(), json!(snapshot.title));
            object.insert("matches".into(), json!(matches));
            if !snapshot.warnings.is_empty() {
                object.insert("warnings".into(), json!(snapshot.warnings));
            }
            Ok(Value::Object(object))
        }
        "callisto_click" => {
            let ref_ = required_ref(args)?;
            let engine = state.ensure_engine().await?;
            engine.click(&Target::parse(&ref_), "left", 1, 2000).await?;
            state.bounded_snapshot(false, 0, DEFAULT_MAX_CHARS).await
        }
        "callisto_fill" => {
            let ref_ = required_ref(args)?;
            let value = arg_string(args, "value").unwrap_or_default();
            if value.chars().count() > 100_000 {
                bail!("value must be at most 100000 characters");
            }
            let engine = state.ensure_engine().await?;
            engine.fill(&Target::parse(&ref_), &value).await?;
            state.bounded_snapshot(false, 0, DEFAULT_MAX_CHARS).await
        }
        "callisto_press" => {
            let key = required_string(args, "key")?;
            if key.is_empty() || key.chars().count() > 40 {
                bail!("key must be between 1 and 40 characters");
            }
            let engine = state.ensure_engine().await?;
            engine.press(&key).await?;
            state.bounded_snapshot(false, 0, DEFAULT_MAX_CHARS).await
        }
        "callisto_scroll" => {
            let delta_x = arg_f64(args, "delta_x", 0.0)?;
            let delta_y = arg_f64(args, "delta_y", 0.0)?;
            let engine = state.ensure_engine().await?;
            engine.scroll(delta_x, delta_y).await?;
            state.bounded_snapshot(false, 0, DEFAULT_MAX_CHARS).await
        }
        "callisto_handoff" => {
            let message = required_string(args, "message")?;
            if message.trim().is_empty() || message.chars().count() > 500 {
                bail!("handoff: provide a message of at most 500 characters");
            }
            if state.mode != "connected" {
                bail!("Human handoff requires a connected browser session");
            }
            bail!("Human handoff is not implemented in the Rust runtime yet; the connected browser is under direct control")
        }
        "callisto_batch" => {
            let actions = arg(args, "actions")
                .and_then(Value::as_array)
                .ok_or_else(|| anyhow!("actions must be an array"))?;
            if actions.is_empty() || actions.len() > 10 {
                bail!("actions must contain between 1 and 10 entries");
            }
            for (index, step) in actions.iter().enumerate() {
                let action = step.get("action").and_then(Value::as_str).unwrap_or("");
                let outcome = run_batch_step(state, step).await;
                if let Err(error) = outcome {
                    bail!(
                        "Batch stopped at step {} ({action}); earlier actions may have completed: {error}",
                        index + 1
                    );
                }
            }
            let snapshot = state.bounded_snapshot(false, 0, DEFAULT_MAX_CHARS).await?;
            Ok(json!({ "completed": actions.len(), "snapshot": snapshot }))
        }
        "callisto_screenshot" => {
            let engine = state.ensure_engine().await?;
            let data = engine.screenshot(false).await?;
            Ok(json!({
                "__image": true,
                "data": data,
                "mimeType": "image/png"
            }))
        }
        "callisto_tabs" => call_tabs(state, args).await,
        "callisto_close" => {
            state.close().await;
            if state.mode == "connected" {
                Ok(json!("Detached from browser. Your tabs are untouched."))
            } else {
                Ok(json!("Browser closed."))
            }
        }
        other => bail!("unknown tool: {other}"),
    }
}

async fn run_batch_step(state: &mut State, step: &Value) -> Result<()> {
    match step.get("action").and_then(Value::as_str).unwrap_or("") {
        "navigate" => {
            let url = required_http_url(step)?;
            state
                .ensure_engine()
                .await?
                .goto(&url, "domcontentloaded", 20_000)
                .await
        }
        "click_ref" => {
            let ref_ = required_ref(step)?;
            state
                .ensure_engine()
                .await?
                .click(&Target::parse(&ref_), "left", 1, 2000)
                .await
        }
        "click_role" => {
            let role = required_string(step, "role")?;
            let name = required_string(step, "name")?;
            let ref_ = state
                .ensure_engine()
                .await?
                .resolve_role(&role, &name, true)
                .await?;
            state
                .ensure_engine()
                .await?
                .click(&Target::parse(&ref_), "left", 1, 2000)
                .await
        }
        "fill_ref" => {
            let ref_ = required_ref(step)?;
            let value = arg_string(step, "value").unwrap_or_default();
            state
                .ensure_engine()
                .await?
                .fill(&Target::parse(&ref_), &value)
                .await
        }
        "fill_role" => {
            let role = required_string(step, "role")?;
            let name = required_string(step, "name")?;
            let value = arg_string(step, "value").unwrap_or_default();
            let ref_ = state
                .ensure_engine()
                .await?
                .resolve_role(&role, &name, true)
                .await?;
            state
                .ensure_engine()
                .await?
                .fill(&Target::parse(&ref_), &value)
                .await
        }
        "press" => {
            let key = required_string(step, "key")?;
            state.ensure_engine().await?.press(&key).await
        }
        "scroll" => {
            let delta_x = arg_f64(step, "delta_x", 0.0)?;
            let delta_y = arg_f64(step, "delta_y", 0.0)?;
            state.ensure_engine().await?.scroll(delta_x, delta_y).await
        }
        other => bail!("unsupported batch action: {other}"),
    }
}

async fn call_tabs(state: &mut State, args: &Value) -> Result<Value> {
    let action = required_string(args, "action")?;
    match action.as_str() {
        "list" => {
            let engine = state.ensure_engine().await?;
            let tabs = engine.tabs().await?;
            Ok(json!({
                "tabs": tabs_json(&tabs),
                "active": engine.browser().context
            }))
        }
        "switch" | "close" => {
            let target = arg_string(args, "target");
            let engine = state.ensure_engine().await?;
            let tabs = engine.tabs().await?;
            let context = resolve_tab(&tabs, target.as_deref(), &engine.browser().context)?;
            if action == "switch" {
                engine.switch_tab(&context).await?;
            } else {
                engine.close_tab(&context).await?;
            }
            state.bounded_snapshot(false, 0, DEFAULT_MAX_CHARS).await
        }
        "new" => {
            let url = arg_string(args, "url");
            let engine = state.ensure_engine().await?;
            engine.new_tab(url.as_deref()).await?;
            state.bounded_snapshot(false, 0, DEFAULT_MAX_CHARS).await
        }
        other => bail!("unknown tabs action: {other}"),
    }
}

fn tabs_json(tabs: &[TabInfo]) -> Value {
    Value::Array(
        tabs.iter()
            .enumerate()
            .map(|(index, tab)| {
                json!({
                    "index": index,
                    "context": tab.context,
                    "url": tab.url,
                    "title": tab.title,
                    "active": tab.active,
                    "focused": tab.focused,
                })
            })
            .collect(),
    )
}

fn resolve_tab(tabs: &[TabInfo], target: Option<&str>, current: &str) -> Result<String> {
    let Some(target) = target else {
        return Ok(current.to_string());
    };
    if let Some(tab) = tabs.iter().find(|tab| tab.context == target) {
        return Ok(tab.context.clone());
    }
    if let Ok(index) = target.parse::<usize>() {
        if let Some(tab) = tabs.get(index) {
            return Ok(tab.context.clone());
        }
        bail!(
            "tab index {index} is out of range ({} tabs open)",
            tabs.len()
        );
    }
    let needle = target.to_lowercase();
    for tab in tabs {
        if tab.url.to_lowercase().contains(&needle) || tab.title.to_lowercase().contains(&needle) {
            return Ok(tab.context.clone());
        }
    }
    bail!("no tab matching {target:?}")
}

fn find_matches(text: &str, query: &str, max_matches: usize) -> Vec<Value> {
    let haystack: Vec<char> = text.to_lowercase().chars().collect();
    let needle: Vec<char> = query.to_lowercase().chars().collect();
    let original: Vec<char> = text.chars().collect();
    let mut matches = Vec::new();
    if needle.is_empty() {
        return matches;
    }
    let mut position = 0;
    while matches.len() < max_matches {
        if position + needle.len() > haystack.len() {
            break;
        }
        let found = (position..=haystack.len() - needle.len())
            .find(|&index| haystack[index..index + needle.len()] == needle[..]);
        let Some(index) = found else { break };
        let start = index.saturating_sub(120);
        let end = (index + needle.len() + 120).min(original.len());
        let snippet: String = original[start..end].iter().collect();
        matches.push(json!({ "offset": index, "text": snippet }));
        position = index + needle.len();
    }
    matches
}

// --- JSON-RPC -------------------------------------------------------------

fn text_content(text: impl Into<String>) -> Value {
    json!({ "content": [{ "type": "text", "text": text.into() }] })
}

fn tool_success(value: Value) -> Value {
    if value
        .get("__image")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        let data = value.get("data").and_then(Value::as_str).unwrap_or("");
        let mime = value
            .get("mimeType")
            .and_then(Value::as_str)
            .unwrap_or("image/png");
        return json!({
            "content": [{ "type": "image", "data": data, "mimeType": mime }]
        });
    }
    match value {
        Value::String(text) => text_content(text),
        other => text_content(serde_json::to_string(&other).unwrap_or_default()),
    }
}

fn tool_failure(error: impl std::fmt::Display) -> Value {
    json!({
        "isError": true,
        "content": [{ "type": "text", "text": error.to_string() }]
    })
}

async fn handle(state: &mut State, message: Value) -> Option<Value> {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let params = message.get("params").cloned().unwrap_or_else(|| json!({}));

    let response = |result: Value| -> Option<Value> {
        id.as_ref()
            .map(|id| json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    };
    let error = |code: i64, message: String| -> Option<Value> {
        id.as_ref().map(|id| {
            json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": message }
            })
        })
    };

    match method {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or("2025-06-18");
            response(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": {
                    "name": "callisto-firefox-mcp",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }))
        }
        "notifications/initialized" | "notifications/cancelled" => None,
        "ping" => response(json!({})),
        "tools/list" => response(json!({ "tools": tool_catalog() })),
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let result = call_tool(state, &name, &args).await;
            response(match result {
                Ok(value) => tool_success(value),
                Err(error) => tool_failure(error),
            })
        }
        other if id.is_some() => error(-32601, format!("Method not found: {other}")),
        _ => None,
    }
}

#[tokio::main]
async fn main() {
    let mut state = State::from_env();
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let message: Value = match serde_json::from_str(trimmed) {
            Ok(message) => message,
            Err(error) => {
                let response = json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": { "code": -32700, "message": format!("Parse error: {error}") }
                });
                let _ = write_message(&mut stdout, &response).await;
                continue;
            }
        };
        if let Some(response) = handle(&mut state, message).await {
            if write_message(&mut stdout, &response).await.is_err() {
                break;
            }
        }
    }

    state.close().await;
}

async fn write_message(stdout: &mut tokio::io::Stdout, message: &Value) -> std::io::Result<()> {
    let mut text = serde_json::to_string(message).unwrap_or_else(|_| "{}".to_string());
    text.push('\n');
    stdout.write_all(text.as_bytes()).await?;
    stdout.flush().await?;
    let _ = std::io::stdout().flush();
    Ok(())
}

// Agent-facing engine over WebDriver BiDi.
//
// This is the Rust counterpart of packages/mini/src/index.ts: navigation,
// snapshot capture, actionability checks, real input events, screenshots,
// evaluation, tabs, cookies and advisory signals. Everything the 11 MCP tools
// call lives here so the transport layer stays a thin JSON-RPC shim.
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::time::Instant;

use crate::bidi::{remote_to_json, Bidi, BidiEvent};
use crate::browser::{AttachOptions, Browser, LaunchOptions};
use crate::diff::format_diff;
use crate::format::format_tree;
use crate::keys;
use crate::prune::prune_forest;
use crate::refs::{RefInfo, RefRegistry};
use crate::snapshot::{self, Snapshot, ACTIONABLE_JS, SNAPSHOT_JS};

const MAX_SIGNALS: usize = 20;
const MAX_NETWORK: usize = 100;

#[derive(Debug, Clone)]
pub struct AgentSignal {
    pub kind: String,
    pub message: String,
    pub url: Option<String>,
    pub filename: Option<String>,
    pub target_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CapturedRequest {
    pub method: String,
    pub url: String,
    pub status: Option<u16>,
}

#[derive(Debug, Clone)]
pub struct TabInfo {
    pub context: String,
    pub url: String,
    pub title: String,
    /// The tab the person is looking at.
    pub active: bool,
    /// The tab holds keyboard focus (a better signal than visibility when the
    /// window itself is unfocused).
    pub focused: bool,
}

#[derive(Default)]
struct EventBuffer {
    signals: VecDeque<AgentSignal>,
    navigated: bool,
    known: HashSet<String>,
    urls: HashMap<String, String>,
    network: VecDeque<CapturedRequest>,
    current_context: String,
}

impl EventBuffer {
    fn queue(&mut self, signal: AgentSignal) {
        self.signals.push_back(signal);
        if self.signals.len() > MAX_SIGNALS {
            self.signals.pop_front();
        }
    }
}

#[derive(Debug, Clone)]
pub enum Target {
    Ref(String),
    Point { x: f64, y: f64 },
}

impl Target {
    pub fn parse(value: &str) -> Self {
        let clean = value.trim();
        if clean.starts_with('[') && clean.ends_with(']') {
            Target::Ref(clean[1..clean.len() - 1].to_string())
        } else {
            Target::Ref(clean.to_string())
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

pub struct Engine {
    browser: Browser,
    refs: RefRegistry,
    last_snapshot: Option<String>,
    revision: u64,
    viewport: (u32, u32),
    events: Arc<Mutex<EventBuffer>>,
    signal_task: Option<tokio::task::JoinHandle<()>>,
}

impl Engine {
    pub async fn launch(options: LaunchOptions) -> Result<Self> {
        let viewport = options.viewport;
        let browser = crate::browser::launch(options).await?;
        let events = Arc::new(Mutex::new(EventBuffer {
            current_context: browser.context.clone(),
            ..Default::default()
        }));
        let signal_task = spawn_signal_listener(browser.bidi.clone(), events.clone());
        Ok(Self {
            browser,
            refs: RefRegistry::new(),
            last_snapshot: None,
            revision: 0,
            viewport,
            events,
            signal_task: Some(signal_task),
        })
    }

    /// Take over an already-running browser and its existing tabs.
    pub async fn attach(options: AttachOptions) -> Result<Self> {
        let browser = crate::browser::attach(options).await?;
        let events = Arc::new(Mutex::new(EventBuffer {
            current_context: browser.context.clone(),
            ..Default::default()
        }));
        let signal_task = spawn_signal_listener(browser.bidi.clone(), events.clone());
        Ok(Self {
            browser,
            refs: RefRegistry::new(),
            last_snapshot: None,
            revision: 0,
            viewport: (1440, 900),
            events,
            signal_task: Some(signal_task),
        })
    }

    pub fn browser(&self) -> &Browser {
        &self.browser
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    pub async fn close(mut self) -> Result<()> {
        if let Some(task) = self.signal_task.take() {
            task.abort();
        }
        self.browser.close().await
    }

    // --- page state -------------------------------------------------------

    fn reset_page_state(&mut self) {
        self.revision += 1;
        self.last_snapshot = None;
        self.refs.reset();
    }

    /// Drain advisory events. A top-level navigation retires refs and the diff
    /// baseline, matching the CDP frameNavigated listener in the TypeScript core.
    pub async fn settle(&mut self) -> Vec<AgentSignal> {
        let (signals, navigated) = {
            let mut buffer = self.events.lock().await;
            let navigated = buffer.navigated;
            buffer.navigated = false;
            (buffer.signals.drain(..).collect::<Vec<_>>(), navigated)
        };
        if navigated {
            self.reset_page_state();
        }
        signals
    }

    pub async fn drain_signals(&mut self) -> Vec<AgentSignal> {
        self.settle().await
    }

    pub fn network_recent(&self, _count: usize) -> Vec<CapturedRequest> {
        // Network history is advisory and not exposed by the MCP surface yet.
        Vec::new()
    }

    // --- navigation -------------------------------------------------------

    pub async fn goto(&mut self, url: &str, wait_until: &str, timeout_ms: u64) -> Result<()> {
        let wait = match wait_until {
            "domcontentloaded" => "interactive",
            "load" => "complete",
            other => other,
        };
        let params = json!({
            "context": self.browser.context,
            "url": url,
            "wait": wait,
        });
        let call = self.browser.bidi.call("browsingContext.navigate", params);
        tokio::time::timeout(Duration::from_millis(timeout_ms), call)
            .await
            .map_err(|_| anyhow!("goto: timed out after {timeout_ms}ms"))?
            .context("goto failed")?;
        // Even a timed-out navigation may have changed the document.
        self.reset_page_state();
        Ok(())
    }

    pub async fn back(&mut self) -> Result<()> {
        self.history_go(-1).await
    }

    pub async fn forward(&mut self) -> Result<()> {
        self.history_go(1).await
    }

    async fn history_go(&mut self, delta: i64) -> Result<()> {
        let params = json!({ "context": self.browser.context, "delta": delta });
        let result = self
            .browser
            .bidi
            .call("browsingContext.traverseHistory", params)
            .await;
        self.reset_page_state();
        result?;
        Ok(())
    }

    pub async fn reload(&mut self) -> Result<()> {
        let params = json!({ "context": self.browser.context, "wait": "complete" });
        let result = self
            .browser
            .bidi
            .call("browsingContext.reload", params)
            .await;
        self.reset_page_state();
        result?;
        Ok(())
    }

    // --- observation ------------------------------------------------------

    async fn capture(&mut self) -> Result<Snapshot> {
        let value = self.evaluate_raw(SNAPSHOT_JS).await?;
        let text = value
            .as_str()
            .ok_or_else(|| anyhow!("snapshot: page returned an unexpected value"))?;
        let raw = snapshot::parse(text)?;
        let mut forest = prune_forest(&raw.nodes);
        self.refs.annotate(&mut forest);
        let text = format_tree(&forest);
        Ok(Snapshot {
            url: raw.url,
            title: raw.title,
            text,
            warnings: raw.warnings,
        })
    }

    /// Pruned, ref-annotated DOM tree as indented text.
    pub async fn snapshot(&mut self, diff: bool) -> Result<Snapshot> {
        self.settle().await;
        let snapshot = self.capture().await?;
        let previous = self.last_snapshot.replace(snapshot.text.clone());
        if diff {
            Ok(Snapshot {
                text: format_diff(previous.as_deref(), &snapshot.text),
                ..snapshot
            })
        } else {
            Ok(snapshot)
        }
    }

    /// Refresh locator candidates without changing the agent's diff baseline.
    pub async fn refresh_locators(&mut self) -> Result<()> {
        self.settle().await;
        self.capture().await?;
        Ok(())
    }

    pub fn find_ref(
        &self,
        role: Option<&str>,
        name: Option<&str>,
        exact: bool,
    ) -> Result<Option<&RefInfo>> {
        self.refs.find(role, name, exact)
    }

    pub async fn resolve_role(&mut self, role: &str, name: &str, exact: bool) -> Result<String> {
        let deadline = Instant::now() + Duration::from_millis(2000);
        loop {
            self.refresh_locators().await?;
            if let Some(info) = self.find_ref(Some(role), Some(name), exact)? {
                return Ok(info.ref_.clone());
            }
            if Instant::now() >= deadline {
                bail!("locator role={role} name={name} not found within 2000ms.");
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    // --- evaluation -------------------------------------------------------

    async fn evaluate_raw(&self, expression: &str) -> Result<Value> {
        let params = json!({
            "expression": expression,
            "target": { "context": self.browser.context },
            "awaitPromise": true,
            "resultOwnership": "none",
        });
        let result = self
            .browser
            .bidi
            .call("script.evaluate", params)
            .await
            .context("evaluate failed")?;
        if result.get("type").and_then(Value::as_str) == Some("exception") {
            let detail = result
                .get("exceptionDetails")
                .and_then(|details| details.get("text"))
                .and_then(Value::as_str)
                .unwrap_or("evaluate failed");
            bail!("{detail}");
        }
        Ok(remote_to_json(result.get("result").unwrap_or(&Value::Null)))
    }

    pub async fn evaluate(&self, expression: &str) -> Result<Value> {
        self.evaluate_raw(expression).await
    }

    /// Evaluate in a specific tab, used to describe tabs without switching.
    pub async fn evaluate_in_context(&self, context: &str, expression: &str) -> Result<Value> {
        let params = json!({
            "expression": expression,
            "target": { "context": context },
            "awaitPromise": true,
            "resultOwnership": "none",
        });
        let result = self.browser.bidi.call("script.evaluate", params).await?;
        if result.get("type").and_then(Value::as_str) == Some("exception") {
            bail!("evaluation in {context} failed");
        }
        Ok(remote_to_json(result.get("result").unwrap_or(&Value::Null)))
    }

    pub async fn wait_for(&self, predicate: &str, timeout_ms: u64, poll_ms: u64) -> Result<()> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let value = self.evaluate_raw(predicate).await?;
            if truthy(&value) {
                return Ok(());
            }
            if Instant::now() >= deadline {
                bail!("waitFor: timed out after {timeout_ms}ms");
            }
            tokio::time::sleep(Duration::from_millis(poll_ms.max(1))).await;
        }
    }

    // --- actionability ----------------------------------------------------

    pub async fn actionable(
        &self,
        target: &Target,
        action: &str,
        timeout_ms: u64,
    ) -> Result<Point> {
        if let Target::Point { x, y } = target {
            if !x.is_finite() || !y.is_finite() {
                bail!("{action}: coordinates must be finite numbers");
            }
            return Ok(Point { x: *x, y: *y });
        }
        let Target::Ref(ref_) = target else {
            unreachable!()
        };
        let info = self
            .refs
            .get(ref_)
            .or_else(|| self.refs.remap(ref_))
            .ok_or_else(|| anyhow!("ref \"{ref_}\" unknown — call snapshot() first."))?;
        let node_id = info.node_id;

        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut last_reason;
        let mut previous: Option<[f64; 4]> = None;
        let mut reactivated = false;
        loop {
            let params = json!({
                "functionDeclaration": ACTIONABLE_JS,
                "arguments": [
                    { "type": "number", "value": node_id },
                    { "type": "string", "value": action }
                ],
                "target": { "context": self.browser.context },
                "awaitPromise": false,
                "resultOwnership": "none",
            });
            match self.browser.bidi.call("script.callFunction", params).await {
                Ok(result) => {
                    if result.get("type").and_then(Value::as_str) == Some("exception") {
                        last_reason = "could not inspect element".to_string();
                        previous = None;
                    } else {
                        let raw = remote_to_json(result.get("result").unwrap_or(&Value::Null));
                        let outcome: Value = match raw.as_str() {
                            Some(text) => serde_json::from_str(text).unwrap_or(Value::Null),
                            None => raw,
                        };
                        if let Some(reason) = outcome.get("reason").and_then(Value::as_str) {
                            let hit = outcome.get("hit").and_then(Value::as_str).unwrap_or("none");
                            last_reason = format!("{reason} (hit={hit})");
                            if std::env::var("CALLISTO_DEBUG")
                                .map(|v| v == "1")
                                .unwrap_or(false)
                            {
                                eprintln!("callisto: actionable outcome {}", outcome);
                            }
                            previous = None;
                            // A background tab has no hit-testable viewport, so
                            // elementFromPoint reports the target as covered.
                            // Bring the tab forward once and try again.
                            if !reactivated && reason.contains("covered") {
                                reactivated = true;
                                let visible = self.ensure_visible(&self.browser.context).await;
                                if std::env::var("CALLISTO_DEBUG")
                                    .map(|v| v == "1")
                                    .unwrap_or(false)
                                {
                                    eprintln!("callisto: target reported covered, ensure_visible={visible}");
                                }
                                if visible {
                                    continue;
                                }
                            }
                        } else {
                            let x = outcome.get("x").and_then(Value::as_f64).unwrap_or(0.0);
                            let y = outcome.get("y").and_then(Value::as_f64).unwrap_or(0.0);
                            let rect =
                                outcome.get("rect").and_then(Value::as_array).map(|values| {
                                    [
                                        values.first().and_then(Value::as_f64).unwrap_or(0.0),
                                        values.get(1).and_then(Value::as_f64).unwrap_or(0.0),
                                        values.get(2).and_then(Value::as_f64).unwrap_or(0.0),
                                        values.get(3).and_then(Value::as_f64).unwrap_or(0.0),
                                    ]
                                });
                            match (rect, previous) {
                                (Some(rect), Some(old))
                                    if rect
                                        .iter()
                                        .zip(old.iter())
                                        .all(|(a, b)| (a - b).abs() < 0.25) =>
                                {
                                    return Ok(Point { x, y });
                                }
                                (Some(rect), _) => {
                                    last_reason = "moving".to_string();
                                    previous = Some(rect);
                                }
                                (None, _) => return Ok(Point { x, y }),
                            }
                        }
                    }
                }
                Err(error) => {
                    last_reason = error.to_string();
                    previous = None;
                }
            }
            if Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(16)).await;
        }
        if last_reason.contains("no layout viewport") {
            bail!(
                "{action}: target {ref_} is in a tab with no layout viewport, so real input cannot land there. Bring that tab to the foreground (callisto_tabs switch) or interact with the visible tab."
            );
        }
        bail!("{action}: target {ref_} not actionable after {timeout_ms}ms ({last_reason})")
    }

    // --- input ------------------------------------------------------------

    async fn perform(&self, sources: Value) -> Result<()> {
        let params = json!({
            "context": self.browser.context,
            "actions": sources,
        });
        self.browser
            .bidi
            .call("input.performActions", params)
            .await
            .context("input action failed")?;
        Ok(())
    }

    async fn pointer(&self, actions: Value) -> Result<()> {
        self.perform(json!([{
            "type": "pointer",
            "id": "callisto-mouse",
            "parameters": { "pointerType": "mouse" },
            "actions": actions,
        }]))
        .await
    }

    async fn key_actions(&self, actions: Value) -> Result<()> {
        self.perform(json!([{
            "type": "key",
            "id": "callisto-keyboard",
            "actions": actions,
        }]))
        .await
    }

    fn button_index(button: &str) -> Result<u8> {
        Ok(match button {
            "left" => 0,
            "middle" => 1,
            "right" => 2,
            other => bail!("unsupported mouse button {other}"),
        })
    }

    pub async fn click(
        &mut self,
        target: &Target,
        button: &str,
        click_count: u32,
        timeout_ms: u64,
    ) -> Result<()> {
        let point = self.actionable(target, "click", timeout_ms).await?;
        let button = Self::button_index(button)?;
        let mut actions = vec![
            json!({ "type": "pointerMove", "x": point.x, "y": point.y, "origin": "viewport" }),
        ];
        for index in 0..click_count.max(1) {
            if index > 0 {
                actions.push(json!({ "type": "pause", "duration": 20 }));
            }
            actions.push(json!({ "type": "pointerDown", "button": button }));
            actions.push(json!({ "type": "pointerUp", "button": button }));
        }
        self.pointer(Value::Array(actions)).await
    }

    pub async fn hover(&mut self, target: &Target, timeout_ms: u64) -> Result<()> {
        let point = self.actionable(target, "hover", timeout_ms).await?;
        self.pointer(
            json!([{ "type": "pointerMove", "x": point.x, "y": point.y, "origin": "viewport" }]),
        )
        .await
    }

    pub async fn drag(&mut self, from: &Target, to: &Target) -> Result<()> {
        let a = self.actionable(from, "click", 2000).await?;
        let b = self.actionable(to, "hover", 2000).await?;
        let mid_x = (a.x + b.x) / 2.0;
        let mid_y = (a.y + b.y) / 2.0;
        self.pointer(json!([
            { "type": "pointerMove", "x": a.x, "y": a.y, "origin": "viewport" },
            { "type": "pointerDown", "button": 0 },
            { "type": "pointerMove", "x": mid_x, "y": mid_y, "origin": "viewport", "duration": 60 },
            { "type": "pointerMove", "x": b.x, "y": b.y, "origin": "viewport", "duration": 60 },
            { "type": "pointerUp", "button": 0 },
        ]))
        .await
    }

    pub async fn scroll(&self, delta_x: f64, delta_y: f64) -> Result<()> {
        if !delta_x.is_finite() || !delta_y.is_finite() {
            bail!("scroll: deltas must be finite numbers");
        }
        let size = self
            .evaluate_in_context(
                &self.browser.context,
                "JSON.stringify({w:innerWidth,h:innerHeight})",
            )
            .await
            .ok()
            .and_then(|value| {
                value
                    .as_str()
                    .and_then(|text| serde_json::from_str::<Value>(text).ok())
            });
        let mut width = size
            .as_ref()
            .and_then(|size| size.get("w"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let mut height = size
            .as_ref()
            .and_then(|size| size.get("h"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if width <= 1.0 {
            width = f64::from(self.viewport.0);
        }
        if height <= 1.0 {
            height = f64::from(self.viewport.1);
        }
        let x = width / 2.0;
        let y = height / 2.0;
        self.perform(json!([{
            "type": "wheel",
            "id": "callisto-wheel",
            "actions": [{
                "type": "scroll",
                "x": x,
                "y": y,
                "deltaX": delta_x,
                "deltaY": delta_y,
                "origin": "viewport",
            }],
        }]))
        .await
    }

    pub async fn type_text(&self, text: &str, delay_ms: Option<u64>) -> Result<()> {
        let values = keys::text_keys(text);
        match delay_ms {
            Some(delay) if delay > 0 => {
                for value in values {
                    self.key_actions(json!([
                        { "type": "keyDown", "value": value },
                        { "type": "keyUp", "value": value },
                    ]))
                    .await?;
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
                Ok(())
            }
            _ => {
                let mut actions = Vec::with_capacity(values.len() * 2);
                for value in values {
                    actions.push(json!({ "type": "keyDown", "value": value }));
                    actions.push(json!({ "type": "keyUp", "value": value }));
                }
                if actions.is_empty() {
                    return Ok(());
                }
                self.key_actions(Value::Array(actions)).await
            }
        }
    }

    pub async fn press(&mut self, key: &str) -> Result<()> {
        let (modifiers, main) = keys::parse_chord(key)?;
        let mut actions = Vec::new();
        for modifier in &modifiers {
            actions.push(json!({ "type": "keyDown", "value": modifier }));
        }
        actions.push(json!({ "type": "keyDown", "value": main }));
        actions.push(json!({ "type": "keyUp", "value": main }));
        for modifier in modifiers.iter().rev() {
            actions.push(json!({ "type": "keyUp", "value": modifier }));
        }
        self.key_actions(Value::Array(actions)).await?;
        if main == keys::ENTER && modifiers.is_empty() {
            // Enter can submit a form or follow a focused link. Give the
            // navigation a moment to start so the next snapshot sees it.
            tokio::time::sleep(Duration::from_millis(400)).await;
            let navigated = { self.events.lock().await.navigated };
            if navigated {
                self.reset_page_state();
            }
        }
        Ok(())
    }

    pub async fn fill(&mut self, target: &Target, value: &str) -> Result<()> {
        let point = self.actionable(target, "fill", 2000).await?;
        self.click(
            &Target::Point {
                x: point.x,
                y: point.y,
            },
            "left",
            1,
            2000,
        )
        .await?;
        self.press("Control+A").await?;
        if value.is_empty() {
            self.press("Backspace").await?;
        } else {
            self.type_text(value, None).await?;
        }
        Ok(())
    }

    pub async fn key_down(&self, key: &str) -> Result<()> {
        let value = if key.chars().count() == 1 {
            key.to_string()
        } else {
            keys::named(key)
                .map(str::to_string)
                .ok_or_else(|| anyhow!("unsupported key {key}"))?
        };
        self.key_actions(json!([{ "type": "keyDown", "value": value }]))
            .await
    }

    pub async fn key_up(&self, key: &str) -> Result<()> {
        let value = if key.chars().count() == 1 {
            key.to_string()
        } else {
            keys::named(key)
                .map(str::to_string)
                .ok_or_else(|| anyhow!("unsupported key {key}"))?
        };
        self.key_actions(json!([{ "type": "keyUp", "value": value }]))
            .await
    }

    // --- screenshots ------------------------------------------------------

    pub async fn screenshot(&self, full_page: bool) -> Result<String> {
        let params = json!({
            "context": self.browser.context,
            "origin": if full_page { "document" } else { "viewport" },
            "format": { "type": "image/png" },
        });
        let result = self
            .browser
            .bidi
            .call("browsingContext.captureScreenshot", params)
            .await
            .context("screenshot failed")?;
        result
            .get("data")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| anyhow!("screenshot returned no image data"))
    }

    // --- tabs -------------------------------------------------------------

    pub async fn pages(&self) -> Result<Vec<Value>> {
        let result = self
            .browser
            .bidi
            .call("browsingContext.getTree", json!({ "maxDepth": 1 }))
            .await?;
        Ok(result
            .get("contexts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// Describe every open top-level tab, including the one a person is using.
    ///
    /// Zen keeps `browsingContext.getTree`'s `url` at `about:blank` for tabs
    /// that were opened from the command line, so ask each tab for its own
    /// `location.href` and only fall back to the tree value.
    pub async fn tabs(&self) -> Result<Vec<TabInfo>> {
        let pages = self.pages().await?;
        let mut tabs = Vec::new();
        for page in pages {
            let Some(context) = page.get("context").and_then(Value::as_str) else {
                continue;
            };
            if page
                .get("parent")
                .map(|parent| !parent.is_null())
                .unwrap_or(false)
            {
                continue;
            }
            let tree_url = page
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let describe = self
                .evaluate_in_context(
                    context,
                    "JSON.stringify({href:location.href,title:document.title,state:document.visibilityState,focus:document.hasFocus()})",
                )
                .await
                .ok()
                .and_then(|value| {
                    value
                        .as_str()
                        .and_then(|text| serde_json::from_str::<Value>(text).ok())
                })
                .unwrap_or(Value::Null);
            let href = describe
                .get("href")
                .and_then(Value::as_str)
                .filter(|href| !href.is_empty() && *href != "about:blank")
                .map(str::to_string)
                .unwrap_or(tree_url);
            let title = describe
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let visible = describe.get("state").and_then(Value::as_str) == Some("visible");
            let focused = describe.get("focus").and_then(Value::as_bool) == Some(true);
            tabs.push(TabInfo {
                context: context.to_string(),
                url: href,
                title,
                active: visible,
                focused,
            });
        }
        // Pick exactly one active tab. Zen reports several tabs as visible at
        // once (and an unfocused window reports none), so use focus first,
        // then a unique visible tab, then the tab the agent is driving.
        let visible: Vec<usize> = tabs
            .iter()
            .enumerate()
            .filter(|(_, tab)| tab.active)
            .map(|(index, _)| index)
            .collect();
        let current = tabs
            .iter()
            .position(|tab| tab.context == self.browser.context);
        let chosen = tabs
            .iter()
            .position(|tab| tab.focused)
            .or_else(|| (visible.len() == 1).then(|| visible[0]))
            .or_else(|| {
                current
                    .filter(|index| visible.contains(index))
                    .or_else(|| visible.first().copied())
            })
            .or(current)
            .or_else(|| {
                tabs.iter()
                    .position(|tab| !tab.url.is_empty() && tab.url != "about:blank")
            })
            .or(Some(0));
        for (index, tab) in tabs.iter_mut().enumerate() {
            tab.active = Some(index) == chosen;
        }
        Ok(tabs)
    }

    async fn visibility(&self, context: &str) -> Option<bool> {
        self.evaluate_in_context(context, "document.visibilityState")
            .await
            .ok()
            .and_then(|value| value.as_str().map(|state| state == "visible"))
    }

    /// Make a tab the visible one, tolerating Zen's slow `browsingContext.activate`.
    ///
    /// Zen sometimes answers activate immediately and sometimes never answers
    /// at all, yet the tab still becomes visible. Send the command with a
    /// short bound and poll the tab instead of trusting the response.
    pub async fn ensure_visible(&self, context: &str) -> bool {
        if self.visibility(context).await == Some(true) {
            return true;
        }
        for _ in 0..2 {
            let _ = tokio::time::timeout(
                Duration::from_millis(1500),
                self.browser
                    .bidi
                    .call("browsingContext.activate", json!({ "context": context })),
            )
            .await;
            for _ in 0..10 {
                if self.visibility(context).await == Some(true) {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
        }
        false
    }

    pub async fn new_tab(&mut self, url: Option<&str>) -> Result<String> {
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            self.browser
                .bidi
                .call("browsingContext.create", json!({ "type": "tab" })),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "this browser does not answer browsingContext.create (Zen does not implement it); open the tab yourself and use callisto_tabs to switch to it"
            )
        })??;
        let context = result
            .get("context")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow!("browser returned no tab context"))?
            .to_string();
        if let Some(url) = url {
            tokio::time::timeout(
                Duration::from_secs(30),
                self.browser.bidi.call(
                    "browsingContext.navigate",
                    json!({ "context": context, "url": url, "wait": "complete" }),
                ),
            )
            .await
            .map_err(|_| anyhow!("navigation to {url} timed out"))??;
        }
        self.switch_tab(&context).await?;
        Ok(context)
    }

    /// Activate a tab (so the person sees it too) and make it the agent's target.
    pub async fn switch_tab(&mut self, context: &str) -> Result<()> {
        self.browser.context = context.to_string();
        {
            let mut events = self.events.lock().await;
            events.current_context = context.to_string();
            events.navigated = false;
        }
        self.reset_page_state();
        self.ensure_visible(context).await;
        Ok(())
    }

    pub async fn close_tab(&mut self, context: &str) -> Result<()> {
        tokio::time::timeout(
            Duration::from_secs(5),
            self.browser
                .bidi
                .call("browsingContext.close", json!({ "context": context })),
        )
        .await
        .map_err(|_| {
            anyhow!("this browser did not answer browsingContext.close; close the tab yourself")
        })??;
        if self.browser.context == context {
            let next = self
                .pages()
                .await?
                .into_iter()
                .find(|page| page.get("parent").map(Value::is_null).unwrap_or(true))
                .and_then(|page| {
                    page.get("context")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                });
            if let Some(next) = next {
                self.switch_tab(&next).await?;
            }
        }
        Ok(())
    }

    // --- storage ----------------------------------------------------------

    pub async fn cookies(&self) -> Result<Value> {
        let result = self
            .browser
            .bidi
            .call("storage.getCookies", json!({}))
            .await?;
        Ok(result.get("cookies").cloned().unwrap_or_else(|| json!([])))
    }

    pub async fn set_cookies(&self, cookies: Value) -> Result<()> {
        let entries = cookies
            .as_array()
            .ok_or_else(|| anyhow!("set_cookies expects an array"))?;
        for cookie in entries {
            let mut value = cookie.clone();
            if let Some(object) = value.as_object_mut() {
                if let Some(expires) = object.remove("expires") {
                    if let Some(seconds) = expires.as_f64() {
                        object.insert("expiry".to_string(), json!(seconds as u64));
                    }
                }
            }
            self.browser
                .bidi
                .call("storage.setCookie", json!({ "cookie": value }))
                .await?;
        }
        Ok(())
    }

    pub async fn clear_cookies(&self) -> Result<()> {
        self.browser
            .bidi
            .call("storage.deleteCookies", json!({}))
            .await?;
        Ok(())
    }
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().map(|n| n != 0.0).unwrap_or(false),
        Value::String(value) => !value.is_empty(),
        _ => true,
    }
}

fn spawn_signal_listener(
    bidi: Arc<Bidi>,
    buffer: Arc<Mutex<EventBuffer>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut events = bidi.subscribe();
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(_) => break,
            };
            let mut buffer = buffer.lock().await;
            record_event(&mut buffer, event);
        }
    })
}

fn record_event(buffer: &mut EventBuffer, event: BidiEvent) {
    let params = &event.params;
    let context = buffer.current_context.clone();
    match event.method.as_str() {
        "browsingContext.navigationStarted" => {
            if params.get("context").and_then(Value::as_str) == Some(context.as_str()) {
                buffer.navigated = true;
            }
        }
        "browsingContext.contextCreated" => {
            let info = params.get("context").unwrap_or(params);
            let Some(id) = info.get("context").and_then(Value::as_str) else {
                return;
            };
            let url = info.get("url").and_then(Value::as_str);
            let known = buffer.known.contains(id);
            buffer.known.insert(id.to_string());
            if let Some(url) = url {
                buffer.urls.insert(id.to_string(), url.to_string());
            }
            if !known && id != context {
                buffer.queue(AgentSignal {
                    kind: "tab".to_string(),
                    message: "tab opened".to_string(),
                    url: url.map(str::to_string),
                    filename: None,
                    target_id: Some(id.to_string()),
                });
            }
        }
        "browsingContext.contextDestroyed" => {
            let info = params.get("context").unwrap_or(params);
            let Some(id) = info.get("context").and_then(Value::as_str) else {
                return;
            };
            if !buffer.known.remove(id) {
                return;
            }
            let url = buffer.urls.remove(id);
            buffer.queue(AgentSignal {
                kind: "tab".to_string(),
                message: "tab closed".to_string(),
                url,
                filename: None,
                target_id: Some(id.to_string()),
            });
        }
        "browsingContext.userPromptOpened" => {
            buffer.queue(AgentSignal {
                kind: "dialog".to_string(),
                message: params
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("dialog opened")
                    .to_string(),
                url: None,
                filename: None,
                target_id: None,
            });
        }
        "browsingContext.downloadWillBegin" => {
            buffer.queue(AgentSignal {
                kind: "download".to_string(),
                message: "download started".to_string(),
                url: params
                    .get("url")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                filename: params
                    .get("suggestedFilename")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                target_id: None,
            });
        }
        "network.beforeRequestSent" => {
            let Some(request) = params.get("request") else {
                return;
            };
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or("GET")
                .to_string();
            let url = request
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            buffer.network.push_back(CapturedRequest {
                method,
                url,
                status: None,
            });
            if buffer.network.len() > MAX_NETWORK {
                buffer.network.pop_front();
            }
        }
        "network.responseCompleted" => {
            // Response status is advisory and not surfaced by the MCP tools yet.
        }
        _ => {}
    }
}

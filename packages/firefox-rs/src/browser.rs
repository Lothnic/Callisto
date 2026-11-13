// Browser discovery, launch and takeover.
//
// Firefox and its forks all speak WebDriver BiDi, but they disagree about how
// they are packaged. A native binary takes a profile path directly. Snap Firefox
// remaps $HOME, so the profile must live under ~/snap/firefox/common. Flatpak
// Zen must be started through `flatpak run` and its profile must live under
// ~/.var/app/<id>. This module hides those differences behind one launcher and
// also attaches to an already-running browser so an agent can take over tabs a
// person already has open.
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

use crate::bidi::{remote_to_json, Bidi};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserKind {
    Firefox,
    Zen,
    LibreWolf,
    Waterfox,
    Floorp,
    Custom,
}

impl BrowserKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Firefox => "firefox",
            Self::Zen => "zen",
            Self::LibreWolf => "librewolf",
            Self::Waterfox => "waterfox",
            Self::Floorp => "floorp",
            Self::Custom => "custom",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "firefox" | "mozilla" => Some(Self::Firefox),
            "zen" | "zen-browser" => Some(Self::Zen),
            "librewolf" => Some(Self::LibreWolf),
            "waterfox" => Some(Self::Waterfox),
            "floorp" => Some(Self::Floorp),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }
}

pub struct LaunchOptions {
    pub kind: BrowserKind,
    pub executable: Option<PathBuf>,
    pub headless: bool,
    pub viewport: (u32, u32),
}

impl Default for LaunchOptions {
    fn default() -> Self {
        Self {
            kind: BrowserKind::Firefox,
            executable: None,
            headless: true,
            viewport: (1440, 900),
        }
    }
}

/// How to reach a browser that is already running.
pub struct AttachOptions {
    /// Full WebSocket endpoint, e.g. `ws://127.0.0.1:9222/session`.
    pub url: Option<String>,
    /// Debug port; the endpoint is derived as `ws://127.0.0.1:PORT/session`.
    pub port: Option<u16>,
    /// Browsing context to attach to.
    pub context: Option<String>,
    /// Tab selector: a zero-based index or a URL/title substring.
    pub tab: Option<String>,
}

pub struct Browser {
    pub bidi: std::sync::Arc<Bidi>,
    pub context: String,
    pub child: Option<Child>,
    pub profile: PathBuf,
    pub port: u16,
    pub kind: BrowserKind,
    pub owned: bool,
}

struct LaunchSpec {
    program: String,
    args: Vec<String>,
    profile: PathBuf,
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"))
}

fn snap_firefox() -> bool {
    Path::new("/snap/firefox/current").exists()
}

fn flatpak_zen() -> bool {
    Path::new("/var/lib/flatpak/app/app.zen_browser.zen").exists()
        || home()
            .join(".local/share/flatpak/app/app.zen_browser.zen")
            .exists()
}

fn profile_root(kind: BrowserKind) -> PathBuf {
    match kind {
        BrowserKind::Firefox if snap_firefox() => home().join("snap/firefox/common"),
        BrowserKind::Zen if flatpak_zen() => home().join(".var/app/app.zen_browser.zen"),
        _ => std::env::var_os("XDG_CACHE_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".cache"))
            .join("callisto")
            .join("profiles"),
    }
}

fn executable_for(kind: BrowserKind, explicit: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(path) = explicit {
        return Some(path);
    }
    let env_key = match kind {
        BrowserKind::Firefox => "CALLISTO_FIREFOX_PATH",
        BrowserKind::Zen => "CALLISTO_ZEN_PATH",
        BrowserKind::LibreWolf => "CALLISTO_LIBREWOLF_PATH",
        BrowserKind::Waterfox => "CALLISTO_WATERFOX_PATH",
        BrowserKind::Floorp => "CALLISTO_FLOORP_PATH",
        BrowserKind::Custom => "CALLISTO_BROWSER_PATH",
    };
    if let Some(path) = std::env::var_os(env_key) {
        return Some(PathBuf::from(path));
    }
    let names: &[&str] = match kind {
        BrowserKind::Firefox => &["firefox"],
        BrowserKind::Zen => &["zen", "zen-browser"],
        BrowserKind::LibreWolf => &["librewolf"],
        BrowserKind::Waterfox => &["waterfox"],
        BrowserKind::Floorp => &["floorp"],
        BrowserKind::Custom => &[],
    };
    names.iter().find_map(|name| which(name))
}

fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn launch_spec(options: &LaunchOptions) -> Result<LaunchSpec> {
    let suffix = rand::random::<u64>();
    let root = profile_root(options.kind);
    std::fs::create_dir_all(&root)
        .with_context(|| format!("could not create profile root {}", root.display()))?;
    let profile = root.join(format!("callisto-{}-{suffix:016x}", options.kind.as_str()));

    let port = free_port()?;
    let mut args: Vec<String> = Vec::new();
    if options.headless {
        args.push("--headless".into());
    }
    args.push("--no-remote".into());
    args.push(format!("--width={}", options.viewport.0));
    args.push(format!("--height={}", options.viewport.1));
    args.push(format!("--remote-debugging-port={port}"));
    args.push("--profile".into());
    args.push(profile.display().to_string());
    args.push("about:blank".into());

    let (program, args) = match options.kind {
        BrowserKind::Zen if flatpak_zen() && options.executable.is_none() => {
            let mut flatpak_args = vec!["run".to_string(), "app.zen_browser.zen".to_string()];
            flatpak_args.extend(args);
            ("flatpak".to_string(), flatpak_args)
        }
        _ => {
            let executable =
                executable_for(options.kind, options.executable.clone()).ok_or_else(|| {
                    anyhow!(
                        "could not find a {} executable; set CALLISTO_{}_PATH",
                        options.kind.as_str(),
                        options.kind.as_str().to_ascii_uppercase()
                    )
                })?;
            (executable.display().to_string(), args)
        }
    };

    Ok(LaunchSpec {
        program,
        args,
        profile,
    })
}

fn port_from_args(args: &[String]) -> Option<u16> {
    args.iter()
        .find_map(|arg| arg.strip_prefix("--remote-debugging-port="))
        .and_then(|port| port.parse().ok())
}

/// Find a running Firefox-family process that was started with a BiDi port.
/// This is what makes `CALLISTO_MCP_BROWSER=connected` work with no extra
/// configuration when the person launched their browser for debugging.
#[cfg(target_os = "linux")]
fn discover_debug_port() -> Option<u16> {
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(raw) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if raw.is_empty() {
            continue;
        }
        let parts: Vec<String> = raw
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part).to_string())
            .collect();
        let joined = parts.join(" ").to_ascii_lowercase();
        let is_browser = joined.contains("firefox")
            || joined.contains("librewolf")
            || joined.contains("waterfox")
            || joined.contains("floorp")
            || joined.contains("zen_browser")
            || joined.contains("/zen ")
            || joined.ends_with("/zen");
        if !is_browser {
            continue;
        }
        let mut index = 0;
        while index < parts.len() {
            if let Some(port) = parts[index]
                .strip_prefix("--remote-debugging-port=")
                .and_then(|port| port.parse::<u16>().ok())
            {
                return Some(port);
            }
            if parts[index] == "--remote-debugging-port" {
                if let Some(port) = parts
                    .get(index + 1)
                    .and_then(|port| port.parse::<u16>().ok())
                {
                    return Some(port);
                }
            }
            index += 1;
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn discover_debug_port() -> Option<u16> {
    None
}

async fn subscribe(bidi: &Bidi) {
    let events = [
        "browsingContext.contextCreated",
        "browsingContext.contextDestroyed",
        "browsingContext.navigationStarted",
        "browsingContext.userPromptOpened",
        "browsingContext.downloadWillBegin",
        "network.beforeRequestSent",
        "network.responseCompleted",
    ];
    let full = tokio::time::timeout(
        Duration::from_secs(2),
        bidi.call("session.subscribe", json!({ "events": events })),
    )
    .await;
    if matches!(full, Ok(Ok(_))) {
        return;
    }
    // Some forks reject the combined list (Zen rejects downloadWillBegin).
    // Subscribe one event at a time so the rest still work.
    for event in events {
        let _ = tokio::time::timeout(
            Duration::from_secs(1),
            bidi.call("session.subscribe", json!({ "events": [event] })),
        )
        .await;
    }
}

async fn evaluate_in(bidi: &Bidi, context: &str, expression: &str) -> Result<Value> {
    let result = bidi
        .call(
            "script.evaluate",
            json!({
                "expression": expression,
                "target": { "context": context },
                "awaitPromise": true,
                "resultOwnership": "none",
            }),
        )
        .await?;
    if result.get("type").and_then(Value::as_str) == Some("exception") {
        bail!("evaluation in {context} failed");
    }
    Ok(remote_to_json(result.get("result").unwrap_or(&Value::Null)))
}

fn top_level_contexts(tree: &Value) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let Some(contexts) = tree.get("contexts").and_then(Value::as_array) else {
        return out;
    };
    for context in contexts {
        let Some(id) = context.get("context").and_then(Value::as_str) else {
            continue;
        };
        let parent = context.get("parent");
        if parent.map(|value| !value.is_null()).unwrap_or(false) {
            continue;
        }
        out.push((
            id.to_string(),
            context
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            context
                .get("userContext")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
        ));
    }
    out
}

/// Pick the tab a person is actually looking at: an explicit context wins,
/// then an explicit tab selector, then the focused tab, then the visible one.
///
/// Zen reports stale `url` values from `getTree` and can report several tabs
/// as visible, so ask each tab for its own href and prefer a real page over
/// the blank startup tab.
async fn pick_context(bidi: &Bidi, tree: &Value, options: &AttachOptions) -> Result<String> {
    let tabs = top_level_contexts(tree);
    if tabs.is_empty() {
        bail!("browser returned no browsing context");
    }
    if let Some(context) = &options.context {
        if tabs.iter().any(|(id, _, _)| id == context) {
            return Ok(context.clone());
        }
        bail!("browsing context {context} is not open");
    }

    let mut described: Vec<(String, String, bool, bool)> = Vec::new();
    for (id, url, _) in &tabs {
        let info = evaluate_in(
            bidi,
            id,
            "JSON.stringify({href:location.href,state:document.visibilityState,focus:document.hasFocus()})",
        )
        .await
        .ok()
        .and_then(|value| {
            value
                .as_str()
                .and_then(|text| serde_json::from_str::<Value>(text).ok())
        })
        .unwrap_or(Value::Null);
        let href = info
            .get("href")
            .and_then(Value::as_str)
            .filter(|href| !href.is_empty())
            .unwrap_or(url)
            .to_string();
        let visible = info.get("state").and_then(Value::as_str) == Some("visible");
        let focused = info.get("focus").and_then(Value::as_bool) == Some(true);
        described.push((id.clone(), href, visible, focused));
    }

    if let Some(tab) = &options.tab {
        if let Ok(index) = tab.parse::<usize>() {
            if let Some((id, _, _, _)) = described.get(index) {
                return Ok(id.clone());
            }
            bail!(
                "tab index {index} is out of range ({} tabs open)",
                described.len()
            );
        }
        let needle = tab.to_lowercase();
        if let Some((id, _, _, _)) = described
            .iter()
            .find(|(_, href, _, _)| href.to_lowercase().contains(&needle))
        {
            return Ok(id.clone());
        }
        for (id, _, _, _) in &described {
            if let Ok(title) = evaluate_in(bidi, id, "document.title").await {
                if title
                    .as_str()
                    .map(|title| title.to_lowercase().contains(&needle))
                    .unwrap_or(false)
                {
                    return Ok(id.clone());
                }
            }
        }
        bail!("no tab matching {tab:?}");
    }

    let real = |href: &str| !href.is_empty() && href != "about:blank";
    let pick = described
        .iter()
        .find(|(_, href, _, focused)| *focused && real(href))
        .or_else(|| {
            described
                .iter()
                .find(|(_, href, visible, _)| *visible && real(href))
        })
        .or_else(|| described.iter().find(|(_, href, _, _)| real(href)))
        .or_else(|| described.iter().find(|(_, _, _, focused)| *focused))
        .or_else(|| described.first())
        .map(|(id, _, _, _)| id.clone());
    pick.ok_or_else(|| anyhow!("browser returned no usable tab"))
}

fn attach_endpoint(options: &AttachOptions) -> Result<String> {
    if let Some(url) = &options.url {
        return Ok(url.clone());
    }
    if let Some(port) = options.port {
        return Ok(format!("ws://127.0.0.1:{port}/session"));
    }
    if let Some(port) = discover_debug_port() {
        return Ok(format!("ws://127.0.0.1:{port}/session"));
    }
    bail!(
        "No running Firefox or Zen with a WebDriver BiDi port was found.\n\
         Start your browser with remote debugging enabled, then retry:\n\
         \n  zen --remote-debugging-port=9222\n  flatpak run app.zen_browser.zen --remote-debugging-port=9222\n  firefox --remote-debugging-port=9222\n\
         \nYour existing profile and tabs are reused; no new profile is created."
    )
}

/// Attach to an already-running browser and select the tab to take over.
pub async fn attach(options: AttachOptions) -> Result<Browser> {
    let endpoint = attach_endpoint(&options)?;
    let port = endpoint
        .rsplit_once(':')
        .and_then(|(_, rest)| rest.split('/').next())
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(0);
    let bidi = Bidi::connect(&endpoint)
        .await
        .with_context(|| format!("could not connect to {endpoint}"))?;
    bidi.call("session.new", json!({ "capabilities": {} }))
        .await
        .context("could not create a BiDi session (another client may already own this browser)")?;
    subscribe(&bidi).await;

    let tree = bidi
        .call("browsingContext.getTree", json!({}))
        .await
        .context("could not list browsing contexts")?;
    let context = pick_context(&bidi, &tree, &options).await?;

    Ok(Browser {
        bidi,
        context,
        child: None,
        profile: PathBuf::new(),
        port,
        kind: BrowserKind::Custom,
        owned: false,
    })
}

pub async fn launch(options: LaunchOptions) -> Result<Browser> {
    let spec = launch_spec(&options)?;
    let port = port_from_args(&spec.args).ok_or_else(|| anyhow!("missing debugging port"))?;
    std::fs::create_dir_all(&spec.profile)?;
    let log_path = spec.profile.join("callisto-browser.log");
    let log = std::fs::File::create(&log_path)
        .with_context(|| format!("could not create {}", log_path.display()))?;

    let child = Command::new(&spec.program)
        .args(&spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("could not launch {}", spec.program))?;

    if std::env::var("CALLISTO_DEBUG")
        .map(|value| value == "1")
        .unwrap_or(false)
    {
        eprintln!(
            "callisto: launched {} {:?} (profile {})",
            spec.program,
            spec.args,
            spec.profile.display()
        );
    }

    let url = format!("ws://127.0.0.1:{port}/session");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    let mut last_error = None;
    let bidi = loop {
        if tokio::time::Instant::now() > deadline {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            return Err(anyhow!(
                "browser did not open a BiDi endpoint at {url} within 30s\n--- browser log ---\n{log}"
            ));
        }
        match Bidi::connect(&url).await {
            Ok(bidi) => break bidi,
            Err(error) => {
                last_error = Some(error);
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    };

    bidi.call("session.new", json!({ "capabilities": {} }))
        .await
        .context("could not create a BiDi session")?;

    subscribe(&bidi).await;

    let tree = bidi
        .call("browsingContext.getTree", json!({}))
        .await
        .context("could not list browsing contexts")?;
    let context = tree
        .get("contexts")
        .and_then(|contexts| contexts.as_array())
        .and_then(|contexts| contexts.first())
        .and_then(|context| context.get("context"))
        .and_then(|context| context.as_str())
        .ok_or_else(|| anyhow!("browser returned no browsing context"))?
        .to_string();

    // Firefox honours this; Zen currently never answers, so bound it. A real
    // Zen window is already sized correctly by --width/--height.
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        bidi.call(
            "browsingContext.setViewport",
            json!({
                "context": context,
                "viewport": {
                    "width": options.viewport.0,
                    "height": options.viewport.1
                },
                "devicePixelRatio": 1
            }),
        ),
    )
    .await;

    let _ = last_error;
    Ok(Browser {
        bidi,
        context,
        child: Some(child),
        profile: spec.profile,
        port,
        kind: options.kind,
        owned: true,
    })
}

impl Browser {
    pub async fn close(&mut self) -> Result<()> {
        if self.owned {
            let _ = tokio::time::timeout(Duration::from_secs(2), self.bidi.call(
                "browsingContext.close", json!({ "context": self.context })
            )).await;
        }
        if let Some(child) = self.child.as_mut() {
            let _ = child.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
        }
        if self.owned && !self.profile.as_os_str().is_empty() {
            let _ = std::fs::remove_dir_all(&self.profile);
        }
        if !self.owned {
            // Detach without touching the person's tabs or window.
            let _ = tokio::time::timeout(
                Duration::from_secs(2),
                self.bidi.call("session.end", json!({})),
            )
            .await;
        }
        Ok(())
    }
}

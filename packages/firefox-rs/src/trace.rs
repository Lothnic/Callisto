//! Private, explicit browser evidence. JSONL is an action log, never a
//! Playwright trace. Screenshots and DOM text may contain private site data.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

pub fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .with_context(|| {
            format!(
                "Cannot create private artifact {}; files are never overwritten",
                path.display()
            )
        })?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = std::fs::remove_file(path);
        return Err(error.into());
    }
    Ok(())
}

pub fn save_json(path: &Path, value: &Value) -> Result<Value> {
    let bytes = serde_json::to_vec_pretty(value)?;
    write_new(path, &bytes)?;
    Ok(json!({"path":path,"bytes":bytes.len()}))
}

fn redact(value: &Value, field: &str, depth: usize) -> Value {
    if depth > 12 {
        return json!("[depth limit]");
    }
    let lower = field.to_ascii_lowercase();
    if [
        "password",
        "secret",
        "token",
        "cookie",
        "authorization",
        "credential",
        "api_key",
    ]
    .iter()
    .any(|key| lower.contains(key))
        || ["value", "prompt", "message", "query", "key", "text"].contains(&lower.as_str())
    {
        return json!("[REDACTED]");
    }
    match value {
        Value::Object(map) => Value::Object(
            map.iter()
                .take(100)
                .map(|(key, value)| (key.clone(), redact(value, key, depth + 1)))
                .collect(),
        ),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .take(40)
                .map(|value| redact(value, field, depth + 1))
                .collect(),
        ),
        Value::String(s) if lower.contains("url") => {
            // Keep the endpoint shape; query values, fragments and userinfo are
            // unnecessary in an action log. Network HAR has its own policy.
            let base = s.split(['?', '#']).next().unwrap_or("");
            if base
                .split_once("://")
                .is_some_and(|(_, rest)| rest.split('/').next().unwrap_or("").contains('@'))
            {
                json!("[REDACTED URL]")
            } else {
                json!(base.chars().take(2000).collect::<String>())
            }
        }
        Value::String(s) => json!(s.chars().take(500).collect::<String>()),
        other => other.clone(),
    }
}

pub struct Recorder {
    directory: PathBuf,
    log: File,
    sequence: u64,
    pub screenshots: bool,
    pub snapshots: bool,
    files: Vec<Value>,
    started: u128,
    checkpoints: u64,
    pending: u64,
    capture_errors: u64,
}
impl Recorder {
    pub fn start(args: &Value) -> Result<Self> {
        let directory = PathBuf::from(
            args["directory"]
                .as_str()
                .context("trace start requires directory")?,
        );
        if !directory.is_absolute() {
            bail!("Trace directory must be absolute");
        }
        let screenshots = args
            .get("screenshots")
            .map(|v| v.as_bool().context("screenshots must be boolean"))
            .transpose()?
            .unwrap_or(false);
        let snapshots = args
            .get("snapshots")
            .map(|v| v.as_bool().context("snapshots must be boolean"))
            .transpose()?
            .unwrap_or(false);
        std::fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .context("Trace directory must be new; its parent must already exist")?;
        let log = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(directory.join("actions.jsonl"))?;
        let recorder = Self {
            directory,
            log,
            sequence: 0,
            screenshots,
            snapshots,
            files: vec![],
            started: now_ms(),
            checkpoints: 0,
            pending: 0,
            capture_errors: 0,
        };
        recorder.manifest(false)?;
        Ok(recorder)
    }
    pub fn status(&self) -> Value {
        json!({"active":true,"directory":self.directory,"actions":self.sequence,"checkpoints":self.checkpoints,"screenshots":self.screenshots,"snapshots":self.snapshots,"capture_errors":self.capture_errors})
    }
    pub fn capture_failed(&mut self) {
        self.capture_errors += 1;
    }
    pub fn begin(&mut self, name: &str, args: &Value) -> Result<u64> {
        if self.sequence >= 10000 {
            bail!("Trace action limit reached; stop the trace before continuing");
        }
        self.sequence += 1;
        self.pending += 1;
        writeln!(
            self.log,
            "{}",
            json!({"schema":"callisto.action-log.v1","event":"start","sequence":self.sequence,"time_ms":now_ms(),"tool":name,"arguments":redact(args,"",0)})
        )?;
        self.log.flush()?;
        Ok(self.sequence)
    }
    pub fn finish(&mut self, sequence: u64, success: bool, elapsed: u128) -> Result<()> {
        self.pending = self.pending.saturating_sub(1);
        writeln!(
            self.log,
            "{}",
            json!({"event":"end","sequence":sequence,"time_ms":now_ms(),"success":success,"elapsed_ms":elapsed})
        )?;
        self.log.flush()?;
        Ok(())
    }
    pub fn checkpoint(&mut self, snapshot: Option<&Value>, image: Option<&Value>) -> Result<()> {
        if self.checkpoints >= 1000 {
            bail!("Trace checkpoint limit reached");
        }
        self.checkpoints += 1;
        if let Some(value) = snapshot {
            self.artifact(
                &format!("snapshot{}.json", self.checkpoints),
                "callisto-dom-snapshot",
                &serde_json::to_vec_pretty(value)?,
            )?;
        }
        if let Some(value) = image {
            use base64::Engine;
            let data = value["dataUrl"]
                .as_str()
                .and_then(|s| s.strip_prefix("data:image/png;base64,"))
                .context("Missing PNG screenshot data")?;
            let bytes = base64::engine::general_purpose::STANDARD.decode(data)?;
            self.artifact(
                &format!("screenshot{}.png", self.checkpoints),
                "png",
                &bytes,
            )?;
        }
        Ok(())
    }
    pub fn artifact(&mut self, name: &str, format: &str, bytes: &[u8]) -> Result<()> {
        write_new(&self.directory.join(name), bytes)?;
        self.files
            .push(json!({"path":name,"format":format,"bytes":bytes.len()}));
        Ok(())
    }
    fn manifest(&self, complete: bool) -> Result<()> {
        let value = json!({"schema":"callisto.browser-evidence.v1","started_ms":self.started,"ended_ms":if complete{Some(now_ms())}else{None},"complete":complete && self.pending==0 && self.capture_errors==0,"pending_actions":self.pending,"capture_errors":self.capture_errors,"actions":self.sequence,"checkpoints":self.checkpoints,"files":self.files,"action_log":{"path":"actions.jsonl","format":"callisto-redacted-jsonl-v1"},"redaction":{"tool_arguments":"credential fields and fill values removed","screenshots_and_snapshots":"private page content; not guaranteed redacted","network":"see HAR capture metadata"},"compatibility":{"playwright_trace_viewer":false,"benchmark_native_evaluation_executed":false}});
        // Only overwrite the manifest created by this recorder, atomically.
        let temporary = self.directory.join("manifest.next.json");
        write_new(&temporary, &serde_json::to_vec_pretty(&value)?)?;
        std::fs::rename(temporary, self.directory.join("manifest.json"))?;
        Ok(())
    }
    pub fn stop(self) -> Result<Value> {
        self.log.sync_all()?;
        self.manifest(true)?;
        let mut status = self.status();
        status["active"] = json!(false);
        Ok(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn evidence_is_private_redacted_and_not_mislabelled_as_playwright() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("task");
        let mut trace = Recorder::start(&json!({"directory":dir})).unwrap();
        let seq=trace.begin("callisto_fill",&json!({"value":"do-not-log","url":"https://example.test/api?token=secret","nested":{"authorization":"Bearer secret"}})).unwrap();
        trace.finish(seq, true, 5).unwrap();
        trace.stop().unwrap();
        let actions = std::fs::read_to_string(dir.join("actions.jsonl")).unwrap();
        assert!(!actions.contains("do-not-log"));
        assert!(!actions.contains("Bearer secret"));
        assert!(!actions.contains("?token="));
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["complete"], true);
        assert_eq!(manifest["compatibility"]["playwright_trace_viewer"], false);
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.join("actions.jsonl"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert!(Recorder::start(&json!({"directory":dir})).is_err());
    }
    #[test]
    fn incomplete_actions_cannot_be_reported_complete() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("task");
        let mut trace = Recorder::start(&json!({"directory":dir})).unwrap();
        trace.begin("click", &json!({})).unwrap();
        trace.stop().unwrap();
        let manifest: Value =
            serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["complete"], false);
    }
}

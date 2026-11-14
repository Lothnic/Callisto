//! Private artifact writes for network exports.
use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::{fs::OpenOptions, io::Write, path::Path};
use std::os::unix::fs::OpenOptionsExt;

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

//! Local persistent state for the Firefox tab relay (Unix hosts).
use anyhow::{bail, Context, Result};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::os::unix::process::CommandExt;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};
use tokio::net::{TcpListener, UnixStream};

#[derive(Serialize, Deserialize)]
pub struct Credentials {
    pub port: u16,
    pub token: String,
}
pub fn root() -> Result<PathBuf> {
    let root = if let Some(dir) = std::env::var_os("CALLISTO_FIREFOX_STATE_DIR") {
        PathBuf::from(dir)
    } else {
        let base = std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|s| PathBuf::from(s).join(".local/state")))
            .context("HOME or XDG_STATE_HOME is required")?;
        base.join("callisto/firefox")
    };
    fs::create_dir_all(&root)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    Ok(root)
}
pub fn lock(root: &Path) -> Result<Option<File>> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("relay.lock"))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(std::fs::TryLockError::WouldBlock) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
pub async fn listener(root: &Path) -> Result<(TcpListener, Credentials)> {
    let path = root.join("pairing.json");
    let previous = match fs::read(&path) {
        Ok(bytes) => Some(
            serde_json::from_slice::<Credentials>(&bytes)
                .context("Invalid saved Firefox pairing; refusing to overwrite it")?,
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if let Some(state) = previous {
        if state.port == 0
            || state.token.len() != 64
            || !state.token.bytes().all(|b| b.is_ascii_hexdigit())
        {
            bail!("Invalid saved Firefox pairing");
        }
        let listener = TcpListener::bind(("127.0.0.1", state.port))
            .await
            .context("Saved relay port is busy; refusing to change the browser pairing")?;
        return Ok((listener, state));
    }
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let state = Credentials {
        port: listener.local_addr()?.port(),
        token: bytes.iter().map(|b| format!("{b:02x}")).collect(),
    };
    let temp = root.join("pairing.tmp");
    // A crash before rename can leave this private temporary file behind.
    match fs::remove_file(&temp) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)?;
    file.write_all(&serde_json::to_vec(&state)?)?;
    file.sync_all()?;
    fs::rename(temp, path)?;
    File::open(root)?.sync_all()?;
    Ok((listener, state))
}
pub async fn connect(root: &Path) -> Result<UnixStream> {
    let socket = root.join("relay.sock");
    if let Ok(stream) = UnixStream::connect(&socket).await {
        return Ok(stream);
    }
    let current = std::env::current_exe()?;
    // A development build can replace the running proxy's inode. Linux then
    // reports a non-existent "(deleted)" executable path. Prefer the updated
    // absolute launch path in that case; never search PATH for a replacement.
    let executable = if current.is_file() {
        current
    } else {
        let launch = PathBuf::from(std::env::args_os().next().context("Missing launch path")?);
        if !launch.is_absolute() || !launch.is_file() {
            bail!("The runtime executable was replaced; restart the MCP server");
        }
        launch
    };
    let mut child = std::process::Command::new(executable)
        .arg("--relay")
        .process_group(0)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    for _ in 0..100 {
        if let Ok(stream) = UnixStream::connect(&socket).await {
            return Ok(stream);
        }
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                bail!("Firefox relay failed to start ({status}); run callisto-firefox-tab-mcp --relay to see the error");
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    bail!("Firefox relay did not start; run callisto-firefox-tab-mcp --relay for diagnostics")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn credentials_survive_restart_and_are_private() {
        let dir = tempfile::tempdir().unwrap();
        let (socket, a) = listener(dir.path()).await.unwrap();
        drop(socket);
        let (_, b) = listener(dir.path()).await.unwrap();
        assert_eq!(a.port, b.port);
        assert_eq!(a.token, b.token);
        assert_eq!(
            fs::metadata(dir.path().join("pairing.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[test]
    fn only_one_relay_owns_the_state() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock(dir.path()).unwrap().unwrap();
        assert!(lock(dir.path()).unwrap().is_none());
        drop(first);
        assert!(lock(dir.path()).unwrap().is_some());
    }
}

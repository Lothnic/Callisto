# Build status (this machine)

Last updated: 2026-07-09 (operator session)

## Machine

- Host: mayank / callisto workspace at `/home/mayank/callisto`
- Disk: ~883 GB free on `/` — enough for Chromium
- RAM: 15 GB (compile with lower `-j` if OOM)

## Done

- [x] Cloned BrowserOS → `~/src/BrowserOS`
- [x] Installed BrowserOS CLI in `~/src/browseros-venv`
- [x] depot_tools available
- [x] Started `browseros source ensure --root ~/src/chromium --strategy shallow` for tag **148.0.7778.97**
- [x] Log: `~/src/logs/chromium-source-ensure.log`

## Blocked / needs operator

- [ ] **sudo** for `./scripts/install-linux-deps.sh` (no passwordless sudo on this host)
  - Needs: build-essential, pkg-config, libnss3-dev, libgtk-3-dev, etc.
  - Or after checkout: `~/src/chromium/src/build/install-build-deps.sh`
- [ ] Wait for source ensure + `gclient sync` to finish (hours)
- [ ] `browseros build --preset release …` compile (hours)

## Commands to resume

```bash
export PATH="$HOME/.local/bin:$HOME/src/depot_tools:$PATH"
source ~/src/browseros-venv/bin/activate

# Watch fetch
tail -f ~/src/logs/chromium-source-ensure.log

# When ensure exits 0:
sudo ~/callisto/packages/callisto-browser/scripts/install-linux-deps.sh

cd ~/callisto/packages/callisto-browser
export BROWSEROS_SRC=$HOME/src/BrowserOS/packages/browseros
./scripts/sync-upstream.sh
./scripts/build-linux.sh --chromium-src $HOME/src/chromium/src --no-download
```

## Product binary

Expect under something like:

```text
~/src/chromium/src/out/Default_x64/browseros
# or after branding: callisto
export CALLISTO_BROWSER_PATH=...
```

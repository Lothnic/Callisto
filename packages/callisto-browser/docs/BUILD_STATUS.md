# Build status (mayank machine)

Last updated: 2026-07-09 ~13:21 UTC

## Machine

- Workspace: `/home/mayank/callisto`
- Disk: ~883 GB free — OK for Chromium
- RAM: 15 GB

## In progress

| Step | Status |
|------|--------|
| Clone BrowserOS | **Done** → `~/src/BrowserOS` |
| BrowserOS CLI venv | **Done** → `~/src/browseros-venv` |
| `browseros source ensure` (Chromium **148.0.7778.97** shallow) | **Running** |
| Log | `~/src/logs/chromium-source-ensure.log` |
| Root | `~/src/chromium` |

Watch:

```bash
tail -f ~/src/logs/chromium-source-ensure.log
du -sh ~/src/chromium
```

After ensure exits 0, `gclient sync` may still grow the tree substantially.

## You must run (sudo)

Compile needs system packages (no passwordless sudo here):

```bash
sudo ~/callisto/packages/callisto-browser/scripts/install-linux-deps.sh
# and preferably after src exists:
# cd ~/src/chromium/src && build/install-build-deps.sh
```

## Then compile

```bash
export PATH="$HOME/.local/bin:$HOME/src/depot_tools:$PATH"
source ~/src/browseros-venv/bin/activate
export BROWSEROS_SRC=$HOME/src/BrowserOS/packages/browseros

cd ~/callisto/packages/callisto-browser
./scripts/sync-upstream.sh
./scripts/build-linux.sh --chromium-src $HOME/src/chromium/src --no-download
```

Expect multi-hour compile. Binary under `~/src/chromium/src/out/…/browseros`.

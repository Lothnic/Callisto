# Callisto Browser

**Browser-first distribution (RFC 0006 option B).**  
A Callisto-branded browser built on **BrowserOS** (Chromium fork), for real users
who never open a CLI.

| | |
|--|--|
| License | **AGPL-3.0** (this package + upstream BrowserOS) |
| Upstream | [BrowserOS](https://github.com/browseros-ai/BrowserOS) (`packages/browseros`) |
| Agent surface | Callisto Mini + harness (MIT packages elsewhere in monorepo) |
| RFC | [`rfcs/0006-callisto-browser-browseros-fork.md`](../../rfcs/0006-callisto-browser-browseros-fork.md) |

## What lives here

- Branding (Callisto name / version)
- Callisto-only Chromium patches (planned viewport/focus; stealth notes)
- Sync + Linux build wrappers around the BrowserOS build CLI
- Docs: stealth strategy, ports, upstream pin

The full Chromium tree is **not** in git. Sync from a local BrowserOS checkout.

## Quick start (operators)

```bash
# 0) Clone BrowserOS (once) + system deps (needs sudo)
git clone https://github.com/browseros-ai/BrowserOS.git ~/src/BrowserOS
export BROWSEROS_SRC="$HOME/src/BrowserOS/packages/browseros"
./scripts/install-linux-deps.sh   # sudo — build-essential, nss, gtk, …

# 1) Sync BrowserOS → .work/browseros + overlay Callisto branding
./scripts/sync-upstream.sh

# 2) Prep CLI venv
./scripts/build-linux.sh --prep-only

# 3) Fetch Chromium @ CHROMIUM_VERSION (multi-hour, ~50GB+)
./scripts/build-linux.sh --ensure-source

# 4) Full Linux build (compile multi-hour; ~50GB more)
./scripts/build-linux.sh --chromium-src "$HOME/src/chromium/src" --no-download
```

Or use BrowserOS CLI directly after prep:

```bash
source ~/src/browseros-venv/bin/activate
browseros source ensure --root ~/src/chromium --strategy shallow
browseros build --preset release --chromium-src ~/src/chromium/src \
  --provision none --no-sign --no-upload --no-download --no-clean
```

## Using the binary with Callisto agent

```bash
export CALLISTO_BROWSER_PATH=/path/to/out/Default/callisto   # or browseros until rename lands
# Product (future): open Callisto Browser, host attaches via CDP
# Dev today:
export CHROME_PATH="$CALLISTO_BROWSER_PATH"
./run.sh --visible "your task"
```

Mini resolves, in order:

1. `CALLISTO_BROWSER_PATH`
2. `CHROME_PATH`
3. Bundled `packages/mini/browseros/browseros` (legacy)

## License boundary

- **This package + produced browser binaries:** AGPL-3.0 (see `LICENSE`, `NOTICE`).
- **`packages/mini`, `harness/`, `eval/`:** remain MIT — keep AGPL sources out of them.

## Status

| Milestone | State |
|-----------|--------|
| RFC 0006 | Accepted |
| Scaffold + sync/build scripts | **Done** |
| First branded Linux binary | Operator-driven (needs Chromium src) |
| Agent viewport / focus patches | Planned (`features.yaml`) |
| Side panel product UI | Planned (extension + host) |

## Docs

- [STEALTH.md](docs/STEALTH.md) — bot-detection layers  
- [PORTS.md](docs/PORTS.md) — CDP / host ports  
- [UPSTREAM.md](UPSTREAM.md) — BrowserOS pin + upgrade  
- [chromium_patches/](chromium_patches/) — Callisto-only diffs  

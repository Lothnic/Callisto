# Build status

Last successful Linux build: **2026-07-09** (mayank host).

## Result

| Item | Path / note |
|------|-------------|
| Chromium pin | 148.0.7778.97 |
| Upstream product | BrowserOS 0.47.9 (pipeline version) |
| Callisto package version | 0.1.0.0 (`CALLISTO_BROWSER_VERSION`) |
| Binary | `$CHROMIUM_SRC/out/Default_browseros_x64/browseros` |
| ChromeDriver | `…/chromedriver` |
| `.deb` | `.work/browseros/releases/0.47.9/BrowserOS_v0.47.9_amd64.deb` (~200 MB) |
| AppImage | Failed (needs FUSE / `libfuse.so.2`) |

Use with Callisto Mini/harness:

```bash
export CALLISTO_BROWSER_PATH=$HOME/src/chromium/src/out/Default_browseros_x64/browseros
```

## Build notes (low-RAM / WSL)

- Default autoninja `-j ~nproc` can **OOM** on ~15 GB hosts. Use:
  - `BROWSEROS_NINJA_JOBS=3` (auto-capped by `build-linux.sh` when unset), or
  - `./scripts/compile-resilient.sh --jobs 3`
- Without R2 credentials, fetch public CDN server resources:
  - `./scripts/fetch-cdn-resources.sh linux-x64`
  - then build with `--no-download`
- Prefer Chromium checkout `depot_tools` + `buildtools/linux64/gn` on `PATH` (`build-linux.sh` handles this).

## Branding

Callisto branding files live under `branding/`; the first Linux binary is still **BrowserOS-named** (`browseros` executable / `.deb`). Wiring Callisto product strings into the prep pipeline is follow-up work.

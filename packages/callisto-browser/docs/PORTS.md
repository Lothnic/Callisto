# Ports contract — Callisto Browser + Host

BrowserOS C++ defaults and agent docs disagree slightly. Always discover at runtime.

## Browser (Chromium / Callisto Browser)

| Role | Typical default | Notes |
|------|-----------------|--------|
| CDP / remote debugging | **9100** (BrowserOS C++ `kDefaultCDPPort`) | Also honor `--remote-debugging-port` |
| MCP HTTP proxy | **9000** | If BrowserOS server stack enabled |
| Sidecar backend | **9200** | BrowserOS agent server |

Flags (BrowserOS):

- `--browseros-cdp-port`
- `--browseros-server-port`
- `--disable-browseros-server` — Callisto Host may own the agent loop instead

## Callisto Host (current monorepo)

| Role | Port | Env |
|------|------|-----|
| Sidebar HTTP/WS | **54321** | current `web_server.py` |
| Future host migrate | **9200** | align with BrowserOS agent port |

## Product recommendation

1. Callisto Browser starts with CDP enabled (fixed port or write port file).
2. Callisto Host connects as CDP **client** (no second Chrome).
3. Side panel extension talks only to Callisto Host on localhost.
4. Optionally `--disable-browseros-server` if BrowserOS agent conflicts with Callisto Host.

## Env vars (Callisto)

```bash
CALLISTO_BROWSER_PATH=/path/to/callisto          # binary
CALLISTO_CDP_PORT=9100                           # attach
CALLISTO_HOST_PORT=54321                         # side panel
BROWSEROS_SRC=...                                # build upstream
CHROMIUM_SRC=...                                 # Chromium checkout
```

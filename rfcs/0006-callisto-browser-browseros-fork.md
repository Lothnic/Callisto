# RFC 0006 — Callisto Browser (BrowserOS fork)

- **Status:** Accepted (Phase 0 decision: option B)
- **Phase:** Browser product / post-MVP
- **Author:** Lothnic
- **Depends:** RFC 0001–0005 (agent surface remains; distribution flips)
- **Upstream reference:** local checkout `~/Desktop/OpenSource/BrowserOS`  
  (public: [browseros-ai/BrowserOS](https://github.com/browseros-ai/BrowserOS))

## Summary

**Decision:** Callisto ships as a **browser product**, not a CLI product. The
browser base is a **Callisto-branded fork of BrowserOS** (Chromium + BrowserOS
patches), with Callisto-owned agent UI and harness integrated natively.

Option A (stock BrowserOS + thin extension only) is deferred as a *dev*
shortcut. Option **B** is the product path: we control branding, Blink-level
anti-automation patches, agent viewport/focus behaviour, and bundled Callisto
host + extension.

The existing CLI, Mini CDP surface, Python harness, and eval kit remain for
developers and reproducible benchmarks. They are not the primary user UX.

## Motivation

1. **Users do not run CLIs.** Daily product is: open browser → side panel → task.
2. **Bot detection** on real sites (Wrogn, Cloudflare, etc.) is not solvable by
   JS hacks alone while we `chrome-launcher` a disposable profile. A real
   browser profile + Chromium-level `navigator.webdriver` and related patches
   are required.
3. **BrowserOS already is** an agentic Chromium fork (side panel, CDP/MCP
   server, privacy patches, packaging). Forking it is cheaper than inventing a
   Chromium pipeline from zero.
4. Aside-class products prove the UX: agent lives *inside* the browser with
   fixed agent viewport, background tabs that do not steal focus, and stealth
   at the Blink layer.

## Goals

1. Define **Callisto Browser** as a BrowserOS-derived binary + Callisto agent
   host + Callisto side panel.
2. Establish **license boundary**: AGPL for the browser fork; MIT remains for
   Callisto harness/mini/eval unless/until code is mixed.
3. Land a **repo scaffold** (`packages/callisto-browser/`) that tracks upstream
   BrowserOS, holds Callisto branding and extra patches, and documents the
   Linux build path.
4. Prefer **attach-to-running-browser** over spawn for product mode; keep
   spawn for CI/eval.
5. Prioritize a **stealth + agent UX patch series** (webdriver, automation
   flags, agent viewport, focus, branding).
6. Keep Mini a11y tree + loop control as the agent differentiator *inside*
   this shell.

## Non-goals (this RFC)

- Completing a full Chromium compile in CI on day one (~100GB, multi-hour).
- Relicensing BrowserOS as MIT (impossible without rights holders).
- Replacing Mini with BrowserOS’s 53-tool surface.
- Abandoning the Python eval kit.
- Shipping Windows/macOS packages before Linux works for us.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Callisto Browser (AGPL — BrowserOS fork + Callisto branding)   │
│                                                                 │
│  ┌────────────────┐     ┌────────────────────────────────────┐  │
│  │ Side panel UI  │◄───►│ Callisto Host (loop + Mini tools)  │  │
│  │ (extension)    │     │ localhost RPC / CDP client         │  │
│  └────────────────┘     └─────────────────┬──────────────────┘  │
│                                           │ CDP                 │
│  ┌────────────────────────────────────────▼──────────────────┐  │
│  │ Chromium tabs · user profile · cookies · logins           │  │
│  │ Blink patches: webdriver=false, agent viewport, focus…    │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

Optional: CLI / eval attaches to CDP on the same binary (dev mode).
```

### Upstream map

| Upstream package | Role for Callisto |
|------------------|-------------------|
| `packages/browseros` | Chromium pin, patch tree, Python `browseros` build CLI, Linux AppImage/deb |
| `packages/browseros-agent` | Patterns for side panel + host server (ports, CDP client); not blindly vendored |

### Callisto monorepo addition

```
packages/callisto-browser/
├── README.md                 # build + license + quickstart
├── UPSTREAM.md               # pin BrowserOS path/commit, sync process
├── LICENSE                   # AGPL-3.0 (browser package)
├── NOTICE                    # BrowserOS + Chromium + Callisto attributions
├── CHROMIUM_VERSION          # mirror upstream pin (currently 148.x)
├── CALLISTO_BROWSER_VERSION  # product version
├── branding/                 # BRANDING, icons stubs, string replace map
├── features.yaml             # Callisto patch features (on top of BrowserOS)
├── chromium_patches/         # Callisto-only patches (webdriver extras, …)
├── scripts/
│   ├── sync-upstream.sh      # rsync/copy BrowserOS browser package baseline
│   ├── check-env.sh          # disk, python, depot_tools, CHROMIUM_SRC
│   └── build-linux.sh        # wrapper around browseros build CLI
└── docs/
    ├── STEALTH.md            # bot-detection strategy
    └── PORTS.md              # CDP / host port contract
```

**Working model (v0):**  
`packages/callisto-browser` does **not** duplicate the full BrowserOS tree.
It **syncs** from a configured `BROWSEROS_SRC` (default
`~/Desktop/OpenSource/BrowserOS/packages/browseros`), then applies
Callisto branding + Callisto-only patches. Full in-tree vendor is optional
later (submodule) once the pipeline is proven.

## License strategy

| Component | License |
|-----------|---------|
| `packages/callisto-browser` (patches, branding, build wrappers) | **AGPL-3.0** |
| Upstream BrowserOS patches applied at build | **AGPL-3.0** (preserve notices) |
| Chromium / ungoogled pieces | Chromium BSD + ungoogled BSD-3 |
| `packages/mini`, `harness/`, `eval/` | remain **MIT** |
| Callisto Host if linked only over localhost RPC | can stay MIT **if** no AGPL sources are compiled into it |

**Distribution rule:** any AppImage/deb/binary of Callisto Browser ships with
source offer (tarball or VCS tag) under AGPL. README must state this clearly.

**Do not** merge AGPL browser sources into MIT packages without flipping the
whole product to AGPL.

## Patch priorities (Callisto series)

Layered on BrowserOS baseline:

| Priority | Patch / feature | Why |
|----------|-----------------|-----|
| P0 | **Branding** (name, icons, executable `callisto`) | Product identity |
| P0 | Keep BrowserOS **`Navigator::webdriver() → false`** | Baseline anti-bot |
| P1 | **Agent fixed viewport** (1440×900) for agent-owned targets | Stable snapshots / CUA alignment |
| P1 | **Background tabs do not steal focus** | Real user browser UX |
| P1 | CDP always available for Callisto Host (document port contract) | Attach mode |
| P2 | Bundled Callisto extension + disable conflicting BrowserOS agent if needed | Side panel is Callisto |
| P2 | Reduce automation client-hints / brand version skew | Fingerprint consistency |
| P3 | Hidden agent windows (BrowserOS already has pieces) | Unattended tasks |
| P3 | Optional further stealth (canvas/WebGL) only with measurement | Avoid cargo-cult |

BrowserOS already ships the critical webdriver patch:

`chromium_patches/third_party/blink/renderer/core/frame/navigator.cc`  
→ `Navigator::webdriver()` always returns `false`.

Callisto’s first *new* Chromium work is branding + agent viewport/focus, not
reinventing webdriver.

## Ports contract (product)

Align Callisto Host with BrowserOS runtime discovery. Document both layers:

| Service | Default (verify at runtime) | Owner |
|---------|----------------------------|--------|
| CDP / remote debugging | BrowserOS C++ default **9100** (agent docs often **9000**) | Browser |
| Callisto Host HTTP/WS | **54321** (current) → migrate to **9200** later | Callisto Host |
| MCP proxy (if kept) | BrowserOS **9000** | Browser |

Product mode: **Host connects to CDP as client**; browser owns the port.

Dev mode: Host may still launch binary with explicit
`--remote-debugging-port=…` for CI.

## Product UX milestones

1. **M0** — Scaffold + RFC + sync/build scripts (this change).
2. **M1** — First Linux binary branded “Callisto” (even if agent still CLI-attached).
3. **M2** — Callisto Host as daemon; side panel real UI; no `run.sh` for normal tasks.
4. **M3** — Agent viewport + focus patches validated on hard sites.
5. **M4** — Installer (AppImage/deb) + source offer automation.

CLI remains: `callisto run-task` for evals, CI, and power users.

## Implementation plan (immediate)

### Repo

1. Add `packages/callisto-browser/` scaffold (this PR).
2. Add `rfcs/0006-…md` (this document).
3. Point root README “Product direction” at browser-first + AGPL note.
4. Mini: resolve `CALLISTO_BROWSER_PATH` / default install path before
   stock `browseros` binary.

### Build machine (operator)

```bash
# One-time: Chromium src @ pin in CHROMIUM_VERSION (~100GB)
# Sync BrowserOS browser package
packages/callisto-browser/scripts/sync-upstream.sh
# Brand + apply Callisto patches
packages/callisto-browser/scripts/build-linux.sh --chromium-src "$CHROMIUM_SRC"
```

### Validation

- Binary name / About page show Callisto.
- `navigator.webdriver === false` in a normal tab.
- Callisto Host can CDP-connect without `--enable-automation`.
- WebVoyager smoke still runs (spawn or attach).

## Risks

| Risk | Mitigation |
|------|------------|
| AGPL surprises | Explicit package LICENSE + NOTICE; legal note in root README |
| 100GB / multi-hour builds | Scripts + docs; do not require full build for MIT harness CI |
| Port confusion BrowserOS vs agent | `docs/PORTS.md` + runtime discovery |
| Upstream drift | `UPSTREAM.md` pin + periodic sync script |
| Scope creep (full rebrowser) | Stick to P0–P1 patches until measured failures |

## Alternatives considered

1. **Option A only (stock BrowserOS + extension)** — faster, but no brand control and weaker long-term stealth ownership. Rejected for product; OK as interim dev profile.
2. **Playwright + stock Chrome** — worse bot posture and not a browser product.
3. **Fork Chromium without BrowserOS** — reinvent packaging, agent CDP, MV2, privacy patches.

## Success criteria

- [ ] RFC accepted and linked from README.
- [ ] `packages/callisto-browser` exists with sync/build scripts and branding stubs.
- [ ] Documented path to a Linux Callisto-branded binary from BrowserOS + Callisto deltas.
- [ ] Mini/run path prefers Callisto Browser binary when present.
- [ ] Explicit AGPL boundary documented so MIT harness stays clean.

## Open questions

1. Keep BrowserOS embedded agent server or replace entirely with Callisto Host?
2. Submodule vs external `BROWSEROS_SRC` path for CI machines?
3. When to flip default install from “clone + run.sh” to “download AppImage”?

## References

- Local upstream: `~/Desktop/OpenSource/BrowserOS`
- BrowserOS `Navigator::webdriver` patch (Blink)
- BrowserOS `build/features.yaml` branding + `cdp-api` + `hidden-agent-windows`
- Aside product notes (background tabs, 1440×900, Chromium stealth) in marketing draft
- Callisto RFC 0001–0005 (Mini, a11y, loop, safety, evals)

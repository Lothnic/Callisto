# Callisto site

Static marketing site for Callisto, published at
<https://callisto.lothnic.dev>. No framework, no build step, no external runtime
dependencies.

The live domain is hosted on Vercel; pushing to GitHub does not by itself prove
the live site was updated. Deploy the contents of `site/` to the linked Vercel
project, then verify `/install.sh` serves the intended revision. The optional
GitHub Pages workflow is manually dispatched and requires Pages to be enabled.

```
site/
├── index.html   # content and structure
├── styles.css   # design system, layout, motion
├── main.js      # ticker pacing, walkthrough, stepper, copy buttons
├── install.sh   # pinned installer served at /install.sh
├── favicon.svg  # Callisto orbital icon
└── apple-touch-icon.png
```

## Preview

Open `index.html` directly, or serve the folder so relative paths and clipboard
access behave the same as production:

```bash
python3 -m http.server 8087 --directory site
```

Then visit <http://127.0.0.1:8087/>.

## Editing notes

- Fonts load from Google Fonts: Archivo (display), Instrument Sans (body),
  Chivo Mono (code), Silkscreen (ticker).
- Colour tokens are defined once at the top of `styles.css`; change them there
  rather than in individual rules.
- Copy blocks use `data-copy` on the button and matching text inside `<code>`.
  Keep the two in sync.
- The walkthrough is driven by `data-go`, `data-copy`, `data-scene` and
  `data-reveal` attributes. Adding a step means adding all four.
- Motion respects `prefers-reduced-motion`; test changes with that setting on.
- Claims on the page must stay true to the MCP server in
  `packages/mini/src/mcp.ts` and `packages/firefox-rs/src/tab_mcp.rs`, with
  runtime limits in `docs/zen-advanced-runtime.md`. Callisto is experimental, is not a Playwright
  replacement, and is not a sandbox.
- The installer fetches the explicitly pinned Git revision and defaults to
  building the Firefox/Zen bridge. `--backend chromium` builds Mini instead.
  It prints configuration unless `--host codex|claude|opencode` is explicitly
  supplied; only then does the host's CLI register the selected backend.
  It does not install browsers, Node.js or Rust. OpenCode registration applies
  to the current project. Zen installs alongside legacy Mini in `callisto-zen`.
  `CALLISTO_INSTALL_DIR` changes the destination, which must not already exist.
  Update the revision only after the corresponding commit is available on GitHub.
  Run `node --test scripts/site-install.test.mjs` for backend, host registration,
  path-preservation and failed-build coverage. A real Linux source install and
  OpenCode registration are recorded in `eval/reports/installer-2026-11-16.md`.

## Current source capabilities

The Zen/Firefox section describes extension-owned optional trusted input, stable
snapshot captures, scoped network/API inspection and explicit failure evidence.
The background agent-window feature ships in extension 0.2.0: user preparation may focus
it once, then execution starts after returning to another window. The saved
concurrent-use check covers headful Zen X11 only; do not imply inactive-tab,
minimized-window or cross-platform support. See `docs/background-work.md`.
The installer defaults to the Zen bridge from a pinned revision; Chromium is
an explicit option. Keep source availability, signed distribution and benchmark
results distinct. The 15 November persistent-profile checks and observation byte measurements
are not a browse time/cost comparison or a benchmark judge run. The matched
pilot now runs a signed-in Codex host through native MCP tools; the credit-blocked
Hy3 API preflight is historical and does not block host-agent use. The alpha guide describes a local
Linux x64 build, not a published signed extension.
Mozilla Add-ons now publishes extension 0.3.0 at
<https://addons.mozilla.org/en-US/firefox/addon/callisto/>. Keep that link visible
while explaining that the extension needs the separately built runtime.
Publication does not validate all store upgrades or permanent-install behavior
in Zen. See
`docs/published-extension.md`.

The installer pins runtime source with the compact single-tool MCP interface.
Restart the agent’s MCP connection after installing it; this interface change
does not require an add-on update. `CALLISTO_TOOL_PROFILE=full` advertises the
legacy named catalog. See `docs/compact-tools.md`. Full browser control mode
needs extension 0.3.0 or later, available on AMO. The latest version, 0.3.1, adds branded icons and is awaiting Mozilla approval.
The runtime continues negotiating capabilities with
older extensions. See `docs/full-browser-control.md`.

## Add-on installation flow

The navigation **Install** and hero **Install Callisto** buttons open the five-step guide
at `#install`: add-on, local bridge, agent restart, pairing and page verification.
The Mozilla listing opens in a separate tab from step 1 so visitors can return
to setup. Step 2 selects Zen or Firefox and Codex, Claude Code, OpenCode or manual
registration; the command, copy value and agent prompts update together.

The guide uses `main.js` to show one step at a time, with Back/Next links,
keyboard focus and direct step links. Without JavaScript, all five steps remain
readable. It never claims to detect a local runtime: the last step asks the
agent to check status and read the shared page. The add-on link remains
<https://addons.mozilla.org/en-US/firefox/addon/callisto/>.

Keep the store version separate from the repository manifest: check Mozilla's
public API before changing published-version copy. Full control requires the
0.3.0 or later add-on and an updated runtime; protected Firefox pages remain
unavailable. Setup and troubleshooting are documented in
[the documentation index](../docs/README.md).

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
└── install.sh   # pinned installer served at /install.sh
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
- The installer fetches the explicitly pinned Git revision, builds Mini and
  prints an MCP configuration; it does not install Chrome or edit host configs.
  `CALLISTO_INSTALL_DIR` changes the destination, which must not already exist.
  Update the revision only after the corresponding commit is available on GitHub.

## Current source capabilities

The Zen/Firefox section describes extension-owned optional trusted input, stable
snapshot captures, scoped network/API inspection and explicit failure evidence.
The background agent-window feature is source-only: user preparation may focus
it once, then execution starts after returning to another window. The saved
concurrent-use check covers headful Zen X11 only; do not imply inactive-tab,
minimized-window or cross-platform support. See `docs/background-work.md`.
The Chromium installer remains pinned to its existing revision and does not
install the Zen bridge. Keep source availability, signed distribution and benchmark
results distinct. The 15 November persistent-profile checks and observation byte measurements
are not a browse time/cost comparison or a benchmark judge run. The matched
pilot now runs a signed-in Codex host through native MCP tools; the credit-blocked
Hy3 API preflight is historical and does not block host-agent use. The alpha guide describes a local
Linux x64 build, not a published signed extension.
Mozilla Add-ons now publishes the older 0.1.0 extension at
<https://addons.mozilla.org/en-US/firefox/addon/callisto/>. Keep that link visible
while explaining that the newer source features require temporary extension
0.2.0 and the separately built runtime. Publication of 0.1.0 does not validate
0.2.0 store upgrades or permanent-install behavior in Zen. See
`docs/published-extension.md`.

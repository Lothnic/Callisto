# Callisto site

Static marketing site for Callisto, published at
<https://callisto.lothnic.dev>. No framework, no build step, no external runtime
dependencies.

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
  `packages/mini/src/mcp.ts`. Callisto is experimental, is not a Playwright
  replacement, and is not a sandbox.
- The installer fetches the explicitly pinned Git revision, builds Mini and
  prints an MCP configuration; it does not install Chrome or edit host configs.
  `CALLISTO_INSTALL_DIR` changes the destination, which must not already exist.
  Update the revision only after the corresponding commit is available on GitHub.

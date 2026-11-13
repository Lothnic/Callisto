# Browser input and automation compatibility research

Reviewed 2026-11-13. Sources below describe upstream implementations, not measured Callisto outcomes. Versions and integration paths matter.

## Input and detection are different problems

An event created with page JavaScript can fail an `isTrusted` check; this is distinct from site-level risk decisions based on session, browser, network, or behavior. A browser-generated trusted event does not prove that a visitor is human or that a site will accept an interaction. Callisto's Zen extension currently dispatches DOM events, while Mini uses CDP Input commands (`packages/firefox-rs/extension/content.js`, `packages/mini/src/index.ts`). The precise trust value and effective behavior should be tested per input type and browser version; fills, pointer, file upload, and keyboard shortcuts need separate tests.

## Browse

[Browse's upstream README](https://github.com/anomalyco/browse/blob/dev/README.md) describes a local relay, a Chromium extension using `chrome.debugger`, the user's browser profile, and a Patchright-backed execution path. It says its execution path reduces particular automation signals, includes a bounded wait for checks which resolve on their own, and supports human handoff. These are implementation claims, not proof of universal bot-check success. The [browse skill](https://github.com/anomalyco/browse/blob/dev/cli/skills/browse/SKILL.md) distinguishes bulk fill from sequential typing and documents handoffs and scoped use. Browser debugging can be visible and input behavior still needs independent measurement.

## Vercel agent-browser

The [agent-browser changelog](https://agent-browser.dev/changelog) says the Node/Playwright daemon was replaced with a Rust native daemon in v0.20.0. Do not assume its current runtime uses Playwright. Its [current README](https://github.com/vercel-labs/agent-browser) describes CDP connections, headed browsers, external providers, and optional plugin hooks for launch customization and CAPTCHA solvers. The plugin examples establish extensibility, not that these components are enabled by default or guarantee access. The project's [native implementation](https://github.com/vercel-labs/agent-browser/blob/main/cli/src/native/interaction.rs) implements CDP-backed interaction; individual operations and their event properties should be measured rather than inferred from a general claim of trusted input.

## Firefox and Zen

[MDN's browser compatibility notes](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities) say Firefox does not implement Chromium's extension `debugger` API; porting browse's extension cannot alone reproduce its input path. Firefox [documents launching with `--remote-debugging-port`](https://developer.mozilla.org/en-US/docs/Web/WebDriver/How_to/Create_BiDi_connection) to expose WebDriver BiDi. The [BiDi specification](https://www.w3.org/TR/webdriver-bidi/#module-input) defines `input.performActions` for browser-mediated keyboard and pointer actions, making it a candidate for experiments. Test resulting `isTrusted`, actual default actions and real sites using the intended Zen version; do not treat this as already verified or assume it can attach to an ordinary running profile without restart.

Firefox's [remote-agent security documentation](https://firefox-source-docs.mozilla.org/remote/Security.html) says the endpoint is enabled by a startup flag, listens on loopback, provides broad access to the browser, and does not itself provide authentication or encryption. An authenticated Callisto relay does not automatically protect a separately reachable browser debugging port. The default extension bridge therefore remains useful where a restart or debugging exposure is unacceptable; evaluate an explicitly enabled BiDi mode and OS-mediated input independently.

## Verification proposal

Use local fixtures that log `isTrusted`, pointer and key sequence, focus, default actions, DOM outcome, and controlled-component state. Run the same cases in Mini, Zen extension mode, proposed Zen BiDi mode, browse and agent-browser with versions and modes recorded. Verify adversarial overlays and navigation as well as simple controls. Separately measure outcomes in authorized real workflows, noting human challenges, rate limits, access denials and browser restarts. Treat challenges as a signal to wait or hand control back, not evidence that event trust alone caused a block. Results from a small site sample cannot establish a universal bypass rate.

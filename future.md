# Future work

Status: planning note, November 2026. This is not a release commitment. It
records the benchmark strategy and the Firefox/Gecko compatibility assessment so
the next implementation steps can be scoped honestly.

## Part 1 — Benchmark strategy

### What a benchmark can and cannot measure

Callisto and browse are browser runtimes, not agents. A benchmark score belongs
to the whole system: model, agent scaffold, prompt, step budget, retry policy,
browser runtime, and evaluator. A useful comparison must hold everything except
the runtime constant.

Two comparisons are possible:

- **Engine comparison:** isolated Callisto vs browse, each with its own browser
  process. This isolates the runtime and snapshot/action layer.
- **Product comparison:** connected Callisto vs browse in the same paired
  browser. This is fair as a product comparison, but connected Callisto
  delegates navigation and input to browse's executor, so it is not an
  independent engine comparison.

Do not present a connected-mode result as evidence that one browser engine is
better than another.

### Landscape

| Benchmark | Environment | Size | Grading | Best use | Main caveat |
| --- | --- | ---: | --- | --- | --- |
| **WebArena / WebArena-Verified** | Self-hosted Docker clones of real apps | 812 tasks, plus a curated hard subset | Programmatic backend checks | Controlled runtime comparison and regression testing | Heavy setup; full runs are long |
| **WebBench** (Halluminate/Skyvern) | 452 live websites | 2,454 public tasks | Task rubric, often human-validated | Public real-world story | Live-site drift, CAPTCHA/auth, expensive |
| **WebVoyager** | 15 live sites | 643 tasks | LLM-as-judge | Historical comparison | Widely reported as saturated; noisy |
| **Online-Mind2Web** | Live web | — | Task success | Harder live-web signal | Less standardized |
| **WorkArena** | Self-hosted ServiceNow | Small | Programmatic | Enterprise workflow agents | Narrow domain |
| **ST-WebAgentBench** | Mixed | 375 tasks | Success plus policy adherence | Safety and consent evaluation | Evaluates agents, not runtimes |
| **BrowseComp** | Web research | — | Exact answer | Deep-research agents | Not a browser-control benchmark |
| **OSWorld** | Full desktop | — | Programmatic | Computer-use agents | Too broad for a runtime comparison |

### Recommendation

**Primary: WebArena-Verified.** It is the closest thing to an industry-standard,
reproducible browser-agent benchmark. ServiceNow maintains the verified release,
with deterministic evaluators, the full 812-task set, and a curated hard subset.
It is the right benchmark for a defensible runtime comparison and for
release-to-release regression testing.

**Secondary: WebBench.** It is the best public-story benchmark because it is
large, recent, and includes read and write tasks. It is also much harder to run
credibly: live sites, login walls, CAPTCHAs, and human validation. At launch the
automated evaluation harness was not released, and the full human-evaluated run
was estimated at roughly $3,000 per agent. Use a fixed subset of non-authenticated
READ tasks and publish the date, task IDs, and exclusions.

**Avoid as the headline: WebVoyager.** It is the most recognizable name, but it
is saturated for frontier agents and is sensitive to task drift and evaluator
choice. A WebVoyager score will not differentiate browse from Callisto in 2026.

**Not relevant: BrowseComp and OSWorld.** BrowseComp measures deep-research
answer finding; OSWorld measures full desktop computer use. Neither isolates the
browser runtime.

### Experiment protocol

1. Fix one host agent, one model, one system prompt, one step/token budget, and
   one retry policy.
2. Run two arms: `browse` MCP and `callisto` MCP.
3. Use a fresh browser profile and reset the environment between tasks.
4. Run at least three trials per task, alternating order.
5. Score with the official evaluator, not a custom judge.
6. Report success rate with confidence intervals, plus steps, tokens, wall-clock,
   and cost.
7. Categorize failures: perception, actionability, navigation, authentication or
   CAPTCHA, timeout, and model error.
8. Publish raw trajectories, versions, and exclusions.

For WebArena-Verified, the host agent must emit the required structured JSON and
the evaluator expects Playwright traces for some checks. Callisto does not emit
Playwright traces. Start with the subset of tasks that can be scored from backend
state, or add a small CDP network recorder that exports compatible traces. This
integration is the main engineering cost, not the benchmark run itself.

### Staging

- **Stage 0:** 10 WebArena tasks, both arms, manual run. Measure integration
  friction.
- **Stage 1:** 50-task subset, three trials. Internal result.
- **Stage 2:** full hard subset, public report with protocol and raw data.

Publish the harness and raw results. Do not compare numbers across benchmark
versions, evaluators, or task subsets.

## Part 2 — Firefox and Gecko compatibility

### Why this matters

Most agent browser runtimes are Chromium-only. Firefox users, especially the Zen
community, currently have fewer options. Supporting Gecko would broaden the
audience and differentiate Callisto at launch. The important question is not
whether Firefox is desirable, but which kind of support is honest and achievable
now.

### Terminology correction

- **Helium is Chromium-based**, not Mozilla-based. It is an ungoogled-Chromium
  fork with Chrome extension support. It belongs in the Chromium test matrix.
- **LibreOffice is an office suite**, not a browser. The Firefox-based browser is
  **LibreWolf**.
- **Zen, LibreWolf, Waterfox, Floorp, Mullvad Browser, and Tor Browser** are
  Gecko-based. They inherit Firefox's automation protocol, but hardened forks may
  change what is enabled.

### Three levels of Firefox support

1. **Isolated owned browser.** Launch Firefox or a fork with a dedicated profile
   and remote debugging enabled. The agent gets a fresh browser, not the user's
   daily session. This is the realistic first release.
2. **Attach to an existing profile.** Start the user's browser with
   `--remote-debugging-port` (and often `--marionette`) or a dedicated profile.
   Cookies and logins are available, but Firefox accepts one WebDriver client at
   a time and the browser must be restarted with the flags.
3. **Full connected lifecycle.** Toolbar take-back, human handoff, relay-owned
   tabs, and seamless attach to a running Zen/Firefox. This needs a Firefox
   WebExtension plus native messaging or a relay, and is a separate project.

A dual-engine launch is credible at level 1. It should not promise level 3.

### Market scan

| Project | What it does | Engine/protocol | Maturity | Relevance |
| --- | --- | --- | --- | --- |
| [Mozilla Firefox DevTools MCP](https://github.com/mozilla/firefox-devtools-mcp) | Official MCP server for agentic browsing and Firefox development | Firefox via WebDriver BiDi and Classic (Selenium) | Active; v0.10.7, Oct 2026; MIT/Apache-2.0 | Strongest proof that Firefox agent browsing works today |
| [Zen DevTools MCP](https://github.com/simon-ami/zen-devtools-mcp) | Zen-first fork of Mozilla's MCP server | Zen via BiDi and Classic | Active unofficial fork | Direct evidence that the Mozilla approach transfers to Zen |
| [Zen MCP (spaxe-dev)](https://github.com/spaxe-dev/zen-mcp) | Zen-specific agent browser with owned launch, consent card, evidence | Zen via Marionette | Pre-1.0; live-tested on Windows only | Shows a product-grade Zen integration is possible, with platform caveats |
| [Zen MCP (sh6drack)](https://github.com/sh6drack/zen-mcp) | Minimal MCP server over raw BiDi WebSocket | Zen via BiDi | Early | Shows raw BiDi can drive navigation, click, fill, tabs, screenshots |
| [foxbrowser](https://github.com/KilimcininKorOglu/foxbrowser) | MCP + CLI for Firefox and Gecko forks | BiDi | Early; AGPL-3.0 | Claims Waterfox, LibreWolf, Floorp, and Zen support; Tor and Mullvad listed unsupported |
| [Playwright MCP](https://github.com/microsoft/playwright-mcp) | General browser MCP server | Playwright Firefox (Juggler) or stock Firefox via `moz-firefox` BiDi | Active; BiDi support experimental | Shows the trade-off between patched Firefox and stock Firefox |
| [Roxy Playwright MCP](https://github.com/roxybrowserlabs/roxybrowser-playwright-mcp) | Protocol-agnostic Playwright-style adapter and MCP server | Chromium CDP and Firefox BiDi | Early | Demonstrates a CDP/BiDi backend abstraction |
| [browser-control-mcp](https://github.com/raultov/browser-control-mcp) | Browser control and debugging | Chrome CDP, Firefox BiDi plus RDP | Beta | Shows Firefox debugging and console gaps beyond core browsing |
| [opencode-chromium Firefox support](https://quindart-com.github.io/opencode-chromium/firefox.html) | Firefox MV3 add-on plus BiDi session ownership | Firefox BiDi plus extension | Early | Evidence that extension-owned Firefox sessions are feasible |

### What the implementations converge on

- **WebDriver BiDi is the transport.** Firefox removed CDP in Firefox 141. Firefox
  140 ESR still has CDP as a transitional path, but it is not a future strategy.
- **There is no native accessibility-tree module in BiDi.** Projects build an
  accessibility-like tree by injecting JavaScript that walks the DOM, reads ARIA
  attributes, implicit roles, names, values, and states, and assigns UIDs.
- **Mozilla's MCP is the best reference implementation.** Its snapshot walker
  handles same-origin iframes, caps depth and node count, reuses UIDs across
  snapshots, and invalidates them on navigation. The code is MIT/Apache-2.0 and
  can be adapted with attribution.
- **UIDs are document-local.** A new snapshot or navigation invalidates them.
  This matches Callisto's existing ref-retirement model.
- **Attaching to an existing browser requires flags at startup.** Firefox cannot
  enable the Remote Agent after launch. A dedicated profile is the safe default.
- **One WebDriver client at a time.** A crashed client can leave a session that
  blocks later connections.
- **Hardened forks vary.** LibreWolf may disable the Remote Agent through privacy
  settings; Mullvad and Tor are not safe promises. Tor Browser can expose BiDi in
  community experiments, but it is not a supported target.
- **File upload is now possible** through BiDi `input.setFiles`. Drag-and-drop and
  transformed iframes remain weak spots.

### Workability assessment

| Target | Isolated owned browser | Attach to existing profile | Full connected lifecycle |
| --- | --- | --- | --- |
| Firefox | High confidence; demonstrated by Mozilla | Medium; requires restart with flags and one client | Low for now; needs an extension/relay |
| Zen | High confidence; demonstrated by Zen MCP forks | Medium; same flag/restart constraints | Low for now |
| LibreWolf | Medium; privacy settings may disable Remote Agent | Medium-low | Not planned |
| Waterfox / Floorp | Medium; claimed by foxbrowser, needs testing | Medium-low | Not planned |
| Mullvad Browser | Low; not tested, hardened | Low | Not planned |
| Tor Browser | Low; possible in experiments, not recommended | Low | Not planned |

The core browsing path is workable now. The risk is not navigation or clicking;
it is **snapshot fidelity and actionability parity**. A DOM-derived tree will not
match Chrome's native accessibility tree. Some nodes will be missing, some names
will differ, and shadow DOM, canvas, and cross-origin frames need explicit
handling.

### Proposed architecture

Introduce a backend interface rather than branching on browser type throughout
the engine:

```ts
interface BrowserBackend {
  launch(options): Promise<void>
  attach(options): Promise<void>
  goto(url, options): Promise<void>
  reload(): Promise<void>
  goBack(): Promise<void>
  goForward(): Promise<void>
  snapshot(options): Promise<Snapshot>
  click(target): Promise<void>
  fill(target, value): Promise<void>
  press(key): Promise<void>
  scroll(dx, dy): Promise<void>
  hover(target): Promise<void>
  drag(from, to): Promise<void>
  screenshot(options): Promise<Buffer>
  close(): Promise<void>
}
```

- Keep the existing CDP backend unchanged for Chromium.
- Add a BiDi backend that speaks the WebDriver BiDi WebSocket protocol directly.
  A direct client avoids a Selenium/geckodriver dependency and keeps the runtime
  lean; Selenium is a reasonable fallback for the first spike.
- Normalize the BiDi snapshot into Callisto's existing snapshot node shape and
  keep `ax-N` refs. Reuse Mozilla's DOM walker logic with attribution.
- Add `CALLISTO_BROWSER=auto|chromium|firefox|zen|librewolf|waterfox|floorp` and
  `FIREFOX_PATH`, `ZEN_PATH`, and similar overrides.
- Launch with a dedicated profile and `--remote-debugging-port=0`; read the
  assigned port from stderr. Use `--headless` when requested.
- For attach mode, require the browser to be started with
  `--remote-debugging-port` and use a dedicated profile where possible.

Do not reuse the Chromium MV3 extension for Firefox. A Firefox connected mode
would need a WebExtension port plus native messaging or a relay, and should be a
separate milestone.

### Launch recommendation

Launch with both engines, but scope the claim:

- **Chromium:** isolated and connected modes, as today.
- **Firefox and Zen:** isolated owned-browser mode, marked experimental.
- **Other Gecko forks:** tested matrix entries where they pass; no blanket
  promise.
- **Firefox connected mode:** post-launch work, not a launch gate.

This is the best balance between community value and honesty. It gives Zen users
a working path without pretending Callisto has browse's full connected lifecycle
on Gecko.

### Milestones

0. **Spike (2–4 days).** Launch stock Firefox, open a BiDi session, navigate,
   capture a DOM-derived snapshot on 10 fixtures, click and fill. Compare snapshot
   quality and actionability against the CDP backend.
1. **Backend abstraction and isolated BiDi (1–2 weeks).** Add the backend
   interface, BiDi transport, snapshot normalization, ref lifecycle, and tests.
2. **Zen and fork matrix (3–5 days).** Test Firefox, Zen, LibreWolf, Waterfox, and
   Floorp with explicit paths and dedicated profiles. Document what actually
   passed.
3. **Packaging and docs.** Installer flags, environment variables, support matrix,
   security notes, and limitations.
4. **Benchmark.** Run the WebArena-Verified comparison after the engine is stable
   enough to measure.
5. **Firefox connected mode (separate project).** Only after isolated mode is
   reliable and users ask for takeover/handoff.

### Non-goals for the first Firefox release

- No claim of Playwright parity.
- No claim of Chrome-level accessibility-tree fidelity.
- No toolbar take-back or human handoff on Firefox.
- No Tor Browser or Mullvad Browser support promise.
- No automatic adoption of the user's daily profile.

## Sources

- [WebArena](https://arxiv.org/abs/2307.13854)
- [WebArena-Verified](https://github.com/ServiceNow/webarena-verified)
- [WebBench](https://github.com/Halluminate/WebBench)
- [WebVoyager](https://arxiv.org/abs/2401.13919)
- [Firefox CDP retirement](https://fxdx.dev/cdp-retirement-in-firefox/)
- [WebDriver BiDi specification](https://www.w3.org/TR/webdriver-bidi/)
- [Firefox Remote Agent security](https://firefox-source-docs.mozilla.org/remote/Security.html)
- [Mozilla Firefox DevTools MCP](https://github.com/mozilla/firefox-devtools-mcp)
- [Zen DevTools MCP](https://github.com/simon-ami/zen-devtools-mcp)
- [Zen MCP](https://github.com/spaxe-dev/zen-mcp)
- [foxbrowser](https://github.com/KilimcininKorOglu/foxbrowser)
- [Playwright MCP](https://github.com/microsoft/playwright-mcp)

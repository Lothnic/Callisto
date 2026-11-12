# Future work

Status: planning note, November 2026. This is not a release commitment. It
records the benchmark strategy, the Firefox/Gecko compatibility assessment, the
Rust feasibility review, and the Firefox implementation roadmap so the next
steps can be scoped honestly.

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

The phases in [Part 4](#part-4--firefox-implementation-roadmap) expand this
summary into deliverables and acceptance criteria.

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

## Part 3 — Rust feasibility

### The "about 50% faster than browse" claim

This claim does not appear anywhere in the repository, the site, or the research
records. [`README.md`](README.md) currently says performance and reliability
claims are still being tested. It should stay that way until a matched-agent
benchmark exists. What the repository does contain is a set of scripted fixture
timings that are often faster than browse, but those are not a controlled
runtime comparison.

| Fixture (scripted, no model) | Callisto | browse | Caveat |
| --- | ---: | ---: | --- |
| Snapshot and find control | 23 ms | 95 ms | Different browser versions and profiles |
| Fill and submit form | 184 ms | 2,625 ms | Browse had human-like input enabled |
| Wait for disabled button | 1,309 ms | 3,916 ms | Different action timeouts (2 s vs 10 s) |
| Follow a link | 127 ms | 833 ms | Browse used a connected profile |

The gap is real in that environment, but its cause is **architectural, not
linguistic**. Browse runs on Patchright, a Playwright fork, which adds a Node
driver layer and optional human-like input pacing. Callisto already speaks CDP
directly through `chrome-remote-interface`, so most of the layer that makes
browse slower has already been removed. The remaining Node process is a thin
JSON and event loop, not a browser driver.

That distinction decides the Rust question. The advantage over browse is not
available to a Rust port, because it comes from removing Patchright, which
Callisto already did. A rewrite would remove Node, V8, and the MCP SDK's
JavaScript layer instead. Those are real but small at Callisto's scale.

### Where the time actually goes

Measured in this repository on the current tree:

| Quantity | Measured |
| --- | --- |
| MCP server cold start (Node) | ~440–470 ms |
| Peak RSS at startup | ~94 MB |
| Library import only | ~380 ms, ~88 MB |
| Built JavaScript | 296 KB |
| Installed dependencies | ~81 MB |
| Scripted snapshot plus find | ~23 ms median |
| Scripted fill and submit | ~184 ms median |
| Local CDP round trip | ~1–1.5 ms |

Three costs dominate an agent session, in order:

1. **Browser and network work.** Navigation, layout, rendering, and site latency.
   Neither Node nor Rust changes this. A network-bound capture measured
   elsewhere moved from 9.09 s to 8.56 s across Python, Playwright, and a direct
   Rust CDP client, because an 8-second tile wait dominated everything.
2. **Model latency and turns.** This is usually the largest cost in a real agent
   run and is entirely outside the runtime.
3. **Runtime overhead.** This is the part a rewrite can touch: startup, JSON
   serialization, snapshot pruning, and MCP framing.

Callisto's scripted snapshot is already ~23 ms, so the runtime overhead per
action is a small fraction of any realistic agent step. The honest ceiling for a
Rust rewrite is therefore a **single-digit to low-double-digit percentage** on
warm per-action latency, plus a large relative win on cold start and memory.

### What Rust would and would not change

| Dimension | Current Node runtime | Rust port | Realistic effect |
| --- | --- | --- | --- |
| Cold start | ~450 ms | ~10–30 ms | Large relative win, small absolute win per session |
| Memory | ~94 MB | ~10–20 MB | Meaningful on constrained machines and many servers |
| Distribution | Node 20+, git, npm, 81 MB `node_modules`, build step | One static binary | The strongest practical argument |
| Per-action latency (warm) | ~23 ms snapshot | Maybe ~15–20 ms | Small; browser work dominates |
| Large snapshot serialization | V8 JSON | `serde` | Possible win on very large trees, better solved by bounding |
| High concurrency | One browser per server | Better fan-out | Not Callisto's use case; one user, one browser |
| Chromium protocol | `chrome-remote-interface` | `chromiumoxide` | Both direct CDP; transport cost is equivalent |
| Firefox protocol | Selenium/BiDi JS | Early Rust BiDi crates | **Regression risk**, see below |

### Ecosystem assessment

| Crate | Engine / protocol | Version and activity | Maturity | Fit for Callisto |
| --- | --- | --- | --- | --- |
| [`chromiumoxide`](https://crates.io/crates/chromiumoxide) | Chromium over CDP | 0.9.1; ~5.7M downloads; last release Feb 2026 | Mature but slow-moving | Best Rust Chromium client; equivalent to what Callisto already does |
| [`thirtyfour`](https://crates.io/crates/thirtyfour) | WebDriver, plus CDP and BiDi features | 0.38.1; ~2.4M downloads; Oct 2026 | Mature | Goes through `chromedriver`/`geckodriver`, adding a process; not lean |
| [`webdriverbidi`](https://crates.io/crates/webdriverbidi) | Raw BiDi client | 0.2.2; ~16k downloads; last release Jul 2025 | Thin, low adoption | Reference only |
| [`rmcp`](https://crates.io/crates/rmcp) | MCP server SDK | 1.x; active; Nov 2026 | Official, healthy | Good; the MCP layer is not the risk |
| [`rustenium`](https://crates.io/crates/rustenium) | WebDriver BiDi, stealth overlay | 1.1.15; ~40k downloads; Oct 2026 | Active, young | Plausible Firefox path, needs its own spike |
| [`ferridriver`](https://crates.io/crates/ferridriver) | Playwright-style API; CDP pipe, CDP WebSocket, WebKit, Firefox BiDi | 0.5.0; ~723 downloads; created Apr 2026 | Pre-1.0, single maintainer | Interesting architecture, too early to depend on |
| `bidi-lite`, `bidi-browser-lite` | Raw BiDi lifecycle | 0.1.x; Nov 2026 | Very new | Watch only |

The pattern is clear. **Chromium in Rust is mature; Firefox in Rust is not.**
That is the opposite of Callisto's priority.

### The Firefox trap

The launch priority is Firefox and Zen. In TypeScript, Firefox has Mozilla's own
production MCP server, Selenium's maintained BiDi client, and Playwright's
`moz-firefox` channel. In Rust, the Firefox options are a 40k-download crate, a
723-download pre-1.0 project, and a stale raw-protocol client.

Rewriting in Rust to gain a few milliseconds would mean implementing the
hardest, least mature part of the product on the least mature stack. That is a
bad trade at any stage, and a particularly bad one before launch.

### Recommendation

**Do not rewrite Callisto in Rust before launch.** Keep the TypeScript runtime
and add Firefox there. The rewrite's real benefits are distribution and memory,
not speed, and the priority feature is stronger in the existing ecosystem.

If distribution friction becomes the top complaint, there are cheaper options
than a rewrite:

- **Option A — stay on Node, add Firefox.** Lowest risk, fastest to launch.
  This is the recommended path.
- **Option B — ship a lean single binary from the existing code.** Use Node's
  Single Executable Applications or `bun build --compile` to remove the
  Node/git/npm install step without changing the engine. This captures most of
  the distribution benefit for a fraction of a rewrite.
- **Option C — partial Rust core, later.** Port only the hot path — snapshot
  pruning, JSON shaping, ref registry — behind a native addon or a small sidecar
  process, and measure before expanding. Keep the browser and MCP layers in
  TypeScript.

Revisit the full rewrite only if a measured trigger is hit:

- warm per-action runtime overhead exceeds roughly 30% of a typical agent step;
- memory or cold start becomes a reported blocker;
- the product needs many concurrent isolated browsers per host;
- or the Rust Firefox BiDi ecosystem reaches parity with the TypeScript one.

Until then, a Rust port is an optimization in search of a bottleneck.

## Part 4 — Firefox implementation roadmap

This expands the milestones in Part 2 into a sequenced plan with acceptance
criteria. It assumes the TypeScript runtime and the backend seam described
above.

### Phase 0 — Transport spike (2–4 days)

Goal: prove that a stock Firefox can be driven end to end without Selenium.

- Launch Firefox with a dedicated temporary profile and `--remote-debugging-port=0`.
- Read the assigned port from stderr and open a raw BiDi WebSocket.
- Implement `session.new`, `browsingContext.navigate`, `script.evaluate`.
- Capture a DOM-derived snapshot on 10 existing local fixtures.
- Click and fill one control.

**Acceptance:** navigation, snapshot, click, and fill work on all 10 fixtures
without geckodriver. Snapshot output is reviewed against the CDP tree.

**Risk:** port discovery and profile locking differ across forks. Record exactly
which binary and version worked.

### Phase 1 — Backend seam (3–5 days)

Goal: separate Chromium from the engine without behavior change.

- Introduce the `BrowserBackend` interface from Part 2.
- Wrap the existing CDP client as `CdpBackend` with no logic changes.
- Route `packages/mini/src/index.ts` through the interface.
- Keep all current tests passing against `CdpBackend`.

**Acceptance:** the full existing test suite passes unchanged; the CDP path has
no measurable regression.

### Phase 2 — BiDi backend and snapshots (1–2 weeks)

Goal: a Firefox snapshot good enough to act on.

- Add `BidiBackend` over a raw WebSocket, avoiding a Selenium dependency.
- Port the DOM walker: ARIA roles, implicit roles, accessible names, values,
  states, visibility, depth and node caps.
- Normalize into Callisto's existing snapshot node shape.
- Preserve `ax-N` refs and document-change retirement in `ax-refs.ts`.
- Handle same-origin iframes; fail closed on cross-origin frames.

**Acceptance:** snapshot parity on the fixture set; refs resolve to the correct
elements; navigation invalidates refs; no unbounded tree on large pages.

**Risk:** this is the hard phase. Chrome's native accessibility tree and a
DOM-derived tree will differ. Budget for missing nodes and name mismatches.

### Phase 3 — Actions and actionability (1 week)

Goal: the action layer behaves like Chromium.

- Map click, fill, press, scroll, hover, and drag to BiDi input commands.
- Implement actionability: visible, stable, enabled, receives events.
- Use `input.setFiles` for uploads.
- Add explicit timeouts and clear failure messages.

**Acceptance:** the actionability fixtures pass at parity with Chromium, with
documented exceptions for transformed iframes and drag-and-drop.

### Phase 4 — Fork matrix (3–5 days)

Goal: know what actually works, not what is claimed.

- Test Firefox, Zen, LibreWolf, Waterfox, and Floorp with explicit paths.
- Use a dedicated profile per run; never the daily profile.
- Record version, launch flags, pass/fail, and failure reason for each.
- Publish the matrix; list unsupported targets explicitly.

**Acceptance:** a committed matrix with reproducible commands. Mullvad and Tor
are listed as unsupported unless they pass.

### Phase 5 — Packaging and docs (2–3 days)

- Add `CALLISTO_BROWSER=auto|chromium|firefox|zen|librewolf|waterfox|floorp`.
- Add `FIREFOX_PATH`, `ZEN_PATH`, and similar overrides.
- Document dedicated-profile and Remote Agent security requirements.
- Mark Firefox support experimental in the README, site, and installer.
- Keep the Chromium install path unchanged.

**Acceptance:** a new user can install, select Firefox, and run a first action
using only the docs.

### Phase 6 — Benchmark (after stability)

- Run the WebArena-Verified subset from Part 1.
- Compare Chromium and Firefox arms separately; do not blend them.
- Publish snapshot fidelity and actionability gaps alongside task success.

**Acceptance:** a reproducible report with raw data and stated exclusions.

### Phase 7 — Firefox connected mode (post-launch)

Separate project, gated on demand.

- Build a Firefox WebExtension plus native messaging or a relay.
- Support toolbar take-back, handoff, and attach to a running browser.
- Reuse the consent and allowlist model, not the Chromium extension.

**Acceptance:** takeover and handoff work on a real authenticated workflow.

### Launch gate

Firefox ships at launch only if Phases 0–5 pass. If Phase 2 does not reach
acceptable snapshot fidelity, ship Chromium-only and publish the Firefox plan
and spike results instead of a broken promise.

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
- [chromiumoxide](https://crates.io/crates/chromiumoxide)
- [thirtyfour](https://crates.io/crates/thirtyfour)
- [rmcp, the official Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)
- [rustenium](https://crates.io/crates/rustenium)
- [ferridriver](https://github.com/salamaashoush/ferridriver)

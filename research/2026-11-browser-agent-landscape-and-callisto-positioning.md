# The browser-agent landscape, and where Callisto can actually win

**Status:** historical research / positioning — superseded product recommendation.
The scoreboard-first pivot and claims that competitors cannot offer particular
features are not the current direction. See the [independent assessment](./2026-11-stripped-playwright-browse-assessment.md) and [current roadmap](../roadmap.md).
**Date:** 2026-11-11
**Scope:** Aside (YC F25), browse by opencode, Playwright MCP/CLI, agent-browser, browser-use — and what this means for `mini`, the harness, and the eval kit.
**Method:** primary sources (Aside's blog, manifesto, benchmark repo, YC page, founder interviews), public token-cost write-ups, and hands-on measurement of `mini` vs browse on this machine. Claims are labelled **[claim]** when they come from a vendor and **[measured]** when we ran them.

---

## TL;DR

1. **Aside proved the harness thesis, not the browser thesis.** Same class of model, 99.0% vs 84.0% on Online-Mind2Web — the gap is harness engineering, not the model. That is good news for a small team and bad news for anyone whose moat is "we have a browser."
2. **Aside's action surface is the opposite of `mini`'s.** They ship two tools (REPL + bash) and let the model write Playwright JS. We ship a typed `Page` API. Their argument — follow the training data — is the strongest argument in this space, and we are currently betting against it without measuring it.
3. **"Token-lean" is already commoditized.** agent-browser does 200–400 tokens/page; Aside claims 70% smaller than agent-browser; Playwright MCP's 13.7K-token tax is the thing everyone is fleeing. We are not 10× leaner — **[measured]** ~8–27% smaller than browse, and partly by seeing half the page.
4. **Nobody sells the thing that is actually missing:** a neutral, reproducible, auditable runtime where *any* agent can be measured on cost-per-success. Aside's numbers are self-graded; browser-use's are self-run; browse publishes none. That is the gap.
5. **Recommended position:** stop being an AI browser; become the **reproducible runtime + neutral scoreboard for browser agents**. Cut the Chromium fork from the critical path. The wedge is *bring-your-own-session*: import a real login profile into an isolated, deterministic Chromium, so you get auth without becoming a consumer browser.
6. **Are we competing with browse?** No to cloning it, yes to being a drop-in for the same MCP clients. Beat it only on axes it structurally cannot match — determinism, unattended/CI, audit, cost-per-success. "Better than browse" is a *result the scoreboard produces*, not the product. See Part 8.

---

## Part 1 — What Aside actually did

### 1.1 The company

- YC F25, founded 2024, San Francisco, ~5 people. Founders: Jun Kim (CEO), Chanhee Lee (CPO), Sanghun Lee (CTO) — ex-Airbridge.io.
- Launched 2026-06-23; the launch post drew ~1.6M views. macOS first, Windows later.
- Product: a Chromium fork (internal name "Bromium", Chromium 152) that acts inside your logged-in accounts. Password manager built for agents, local memory from browsing history, approval gates for sensitive actions.
- Explicitly *not* open source. The browser is closed; the **benchmarks** are open (`at-inc/aside-benchmarks`).

### 1.2 The numbers (all self-reported)

| Benchmark | Aside | Best comparison they cite |
|---|---|---|
| Online-Mind2Web (300 tasks, 136 live sites) | **99.0%** (297/300; 1 impossible, 2 genuine fails; 99.3% excl. impossible) | GPT-5.4 CUA 92.8% · browser-use 97.7% · Opus 4.8 + Playwright MCP 84.0% · Atlas 70.0% |
| Odysseys (200 long-horizon tasks) | 75.5% perfect tasks · 88.8% rubric items | — |
| BU-Bench-V1 (100 hard tasks) | **93.0%** (gpt-5.5) · 88.0% (kimi-k2.6) | Fable 5 + Playwright MCP 80% · browser-use OSS 80% |

Difficulty split on Online-Mind2Web: easy 100%, medium 99.3%, hard 97.4%.

**Read this carefully.** These are vendor-run, vendor-graded, in the vendor's own repo. Reviewers (eesel, Zero G, Ahmed Atoui) all flag it, and Aside's CPO says they are in contact with a Mind2Web co-author for verification. Treat them as a **direction**, not a fact. The important signal is not "99%" — it is that a 5-person team beat Claude Code + Playwright MCP by 15 points with the same class of model.

### 1.3 The harness (the part worth copying)

Aside built on `pi-mono/core`, then wrote compaction, skills, hooks, sandbox, REPL, bash, and browser automation themselves. Four stated principles:

1. **Follow the model's training data.** "What data have LLMs seen the most? Code." Their core tool is a JS REPL built on Playwright syntax.
2. **Minimal instruction → more intelligence.** Hallucination comes from bad state descriptions and conflicting instructions. Their system prompt + tool definitions = **10K tokens**; Claude Code's = ~20K. They refuse to let a model write the prompt ("slop on slop").
3. **Protect the context window.** "Useless tokens are the root of all evil." CDP and raw DOM are bad interfaces; a custom a11y tree is good.
4. **Stand on the shoulders of giants.** Borrowed from Codex, Claude Code, OpenCode, oh-my-opencode.

### 1.4 Asidewright — the actual product bet

- **Two core tools only:** REPL and `bash`.
- The REPL is Playwright-shaped and **100% interface-identical** to Playwright, but each method is a thin CDP wrapper ("no injected scripts, middle layers, or bloat").
- **The prompt does not teach Playwright.** Playwright MCP spends ~13K tokens explaining it; Aside says "Playwright is available" and relies on the prior.
- **Custom a11y tree:** intermediate nodes removed by heuristics, plus focus state, iframe id, clickable state. Claimed **70% smaller** than agent-browser on `aside.com/sota`.
- **Agent signals:** async events (popup opened, download started, tab closed) injected as steering lines instead of extra tools. `mini` already does this — good.
- **CUA fallback:** screenshots + coordinates when the DOM cannot be driven.
- **Network reverse-engineering:** when the page blocks the normal path, capture requests and replay the site's own API. Falls out of "the agent writes code."

### 1.5 What they had to fork Chromium for

This is the part that decides whether you can compete with them directly:

- **Agent tabs open in the background** and never steal the user's focus (Blink patch).
- **Agent tabs always render at 1440×900**, regardless of the user's window (Blink patch). Their stated reason: CUA training data is at that resolution, and resizing breaks every action.
- **Bot detection:** modified Chromium internals, "same technique as Browserbase and Browser Use."
- **Real browser ⇒ not detected.** Their claim: "it never gets detected because it's a browser itself."

None of these are achievable from an extension or a stock Chromium. That is the structural moat, and it is exactly the moat you should *not* try to cross.

### 1.6 What to steal, what not to

**Steal:**
- Pin the viewport at 1440×900. (Already in RFC 0001.)
- Do not teach Playwright in the prompt; rely on the prior. (Roadmap already says this.)
- Keep the system prompt tight; no auto-generated rules.
- Agent signals as steering lines. (Already done.)
- A11y heuristics: drop intermediates, surface focus/clickable/iframe.
- Two-tool surface (REPL + bash) as the *default*, not the exception.

**Do not copy:**
- The Chromium fork. It is a full-time job, AGPL, and it buys a moat you cannot defend.
- Self-graded benchmarks. This is the credibility trap Aside is now climbing out of.
- The consumer browser. Distribution and trust are the product there, and you have neither.

---

## Part 2 — The landscape

| | Browser | Action surface | Perception | Published proof | Auth model | Open |
|---|---|---|---|---|---|---|
| **Aside** | Own Chromium fork (152) | JS REPL + bash, Playwright syntax | Custom a11y tree + CUA fallback | Self-reported, own repo | Your logged-in profile + password manager | No (benchmarks only) |
| **browse (opencode)** | Your real Chrome via extension + relay | Playwright JS in `execute` | `snapshot()` a11y outline + refs | None published | Your live browser | Yes |
| **Playwright MCP** | Bundled Chromium | ~21–26 typed tools | Playwright aria snapshot | None | Persistent profile | Yes |
| **Playwright CLI** | Bundled Chromium | Shell commands | a11y snapshot to files | None | Persistent profile | Yes |
| **agent-browser (Vercel)** | Chromium via CDP | Rust CLI + daemon | a11y tree, interactive-only | None | Persistent profile | Yes |
| **browser-use** | Own Chromium | Python tool calls | a11y + screenshots | Self-reported (97.7% OM2W per Aside) | Cloud/OSS profiles | Yes |
| **Callisto** | Own Chromium (BrowserOS fork) | Typed `Page` API + REPL | Custom pruned a11y tree + diffs | Eval kit, 3 live tasks so far | Fresh profile | Yes (MIT; fork AGPL) |

### 2.1 The token tax everyone is fleeing

| Approach | Overhead | Source |
|---|---|---|
| Chrome DevTools MCP | ~18,000 tokens (26 tools) | multiple 2026 write-ups |
| Playwright MCP | ~13,700 tokens (21 tools); ~114K tokens for a 10-step task in one comparison | GitHub issue #889, Dev.to, Playwright CLI write-ups |
| Playwright CLI | ~27K tokens for the same 10 steps (4×) | ytyng.com |
| agent-browser | 0 tool-definition tokens; 200–400 tokens/page; ~7K vs ~100K (15×) | otf-kit.dev |
| Aside | 10K tokens system prompt + tools; no Playwright teaching | Aside blog |

**Implication:** "fewer tools" is no longer a differentiator. The differentiator is *what the tokens buy*. agent-browser already owns "cheap page representation." Playwright MCP owns "compatibility." Aside owns "real browser + harness quality." There is no unclaimed space in the middle of that triangle — so do not stand there.

### 2.2 Where browse sits, precisely

- Drives **your real browser** through an extension + local relay; logins, cookies, extensions are already there.
- The agent writes **Playwright JS** against `page`, with helpers: `snapshot()`, `ref()`, `handoff()`, `secrets.type()`, network capture, recording.
- Safety is interactive: allowlists, read-only sessions, handoff for login/2FA/captcha/payment.
- **No published token or success numbers.** That is the opening.

browse and Aside agree on the two things that matter most: **code as the action surface** and **a real, logged-in browser**. `mini` disagrees with both. That is a deliberate bet, but it is currently unmeasured.

---

## Part 3 — `mini` vs Playwright: the compatibility audit

The stated strategy is "use Playwright's words because agents are trained on them." That is right — but compatibility is a **contract**, not a vocabulary. When the words match and the semantics don't, the model's prior becomes confidently wrong, which is worse than a novel API.

### 3.1 Measured: perception and latency

Single sample, 2026-11-11, `linear.app` / `github.com`, Callisto on Chrome for Testing 157 (headless) vs browse on the local Chromium (logged in). Dynamic pages, different profiles — treat as directional.

| Metric | Callisto `mini` | browse | Note |
|---|---|---|---|
| linear snapshot size | 2,576 chars · 89 lines · 33 refs | 3,550 chars · 81 lines · 68 refs | 27% smaller, **half the nodes** |
| chars per actionable node | ~78 | ~52 | browse is denser per node |
| github snapshot | 1,308 chars (README) | 1,418 chars | ~8% smaller |
| action round-trip | ~2–6 ms | ~9 ms | transport only |
| snapshot latency | 92–141 ms | ~29 ms warm (~230 cold) | `mini` 3–5× slower |

**Conclusion:** the token win is real but modest, and part of it is bought by hiding below-the-fold content (`aria-hidden` pruning in `snapshot.ts`). The latency win on actions is erased by slower perception. Neither number moves the needle, because an LLM turn costs seconds. **Only turn count matters.**

### 3.2 False priors (what a Playwright-trained model will write)

| Call | Current behavior | Why it hurts |
|---|---|---|
| `page.locator('button')` | throws | Playwright accepts any selector. This is the #1 call a trained model emits. |
| `page.getByRole(...)` before a snapshot | throws / resolves against the last snapshot registry | Playwright is live and auto-waits. |
| `page.fill(ref, v)` | clicks, clears via `value=""`, types char-by-char | Playwright sets the value and fires `input`; no click, no typing. Breaks React and masked inputs. |
| `press('Control+A')` | sends the literal string as a key | Playwright supports chords. Silent no-op. |
| `waitForLoadState('networkidle')` | 500 ms sleep (`page.ts:190`) | Agents trust it and act early. |
| `locator('[callisto-ref="ax-N"]')` | only accepted form | Fine, but the error message should name `getByRole`/refs as the alternative. |

Rule to adopt: **any call the model is likely to write either works, or fails with a one-line error that names the correct call.** Errors are part of the API when the user is a model.

### 3.3 Runtime bugs (as of `a594806` + local working tree)

| # | Issue | Status |
|---|---|---|
| 1 | `snapshot({diff:true})` never diffs through the sidecar: `Object.create(mini)` per eval shadows `lastSnapshotText` (`sidecar.ts:118`, `index.ts:293`) | **Open** — verified at runtime: second diff returns the full tree |
| 2 | `reload()` registers `loadEventFired` *after* `reload()` (`index.ts:150`) → can hang | **Open** |
| 3 | No navigation timeout; a page that never fires `load` hangs the eval | **Open** |
| 4 | Stale refs survive navigation | **Fixed in working tree** (`resetPageState`) |
| 5 | `remap()` receives the bracketed ref form in the catch path (`index.ts:639`) | **Open** |
| 6 | Password redaction checks `role === 'password'` (`snapshot.ts:88`) — Chromium emits `textbox` + masked bullets, so the branch never fires | **Open** — verified: output is `=•••••••`, not `[REDACTED]` |
| 7 | Concurrent sidecar requests are not serialized (`rl.on('line', async ...)`) | **Open** |

### 3.4 Capability gaps that cause task failures

- **Keyboard:** no modifiers, arrows, Escape, Backspace, Home/End; no `code`/`windowsVirtualKeyCode`/`modifiers`. Ctrl/Cmd+A, copy/paste, Escape-to-close are impossible. `type()` sends only `char` events, one round-trip per character.
- **`fill`:** React value-tracker desync (see 3.2).
- **`dragTo`:** one `mouseMoved`, no `dragstart`/`drop` — HTML5 DnD won't fire.
- **`scroll`:** wheels at viewport center, so it scrolls inner panes instead of the document.
- **Offscreen pruning:** agent cannot see or ref below-the-fold content; lazy pages look empty; mutates the page's ARIA.
- **Packaging:** `bin` points at `src/sidecar.ts` with `npx tsx` (devDependency); `--load-extension` points outside the published `files`.
- **Sandbox:** auto `--no-sandbox` on AppArmor hosts, contradicting SECURITY.md.
- **Stealth:** `navigator.plugins` returns `[1,2,3,4,5]` — a stronger fingerprint than an empty list; UA hardcoded to Chrome/142 while the binary may differ.

### 3.5 What the audit means

`mini` is **Playwright-shaped but not Playwright-faithful**. That is a coherent position only if the deviations are deliberate and documented. Right now they are accidents of implementation, and the model pays for them in retries. Two cheap fixes — a CSS fallback in `locator()` and a live-or-snapshot `getByRole()` — would cover most of what a trained model emits.

---

## Part 4 — The gap nobody fills

**Commoditized (do not build a company on these):**
- A11y snapshot + refs. Four projects do it.
- A Playwright-shaped API. Two do it better.
- An MCP server. Dozens exist; the token tax is falling.
- A Chromium fork with agent-friendly tabs. Aside and browser-use have it; it costs a full-time engineer.

**Not commoditized:**
1. **A neutral, reproducible benchmark that any agent can enter.** Aside grades itself. browser-use grades itself. browse publishes nothing. Steel.dev's leaderboard is cloud-only and judge-dependent. There is no `lm-evaluation-harness` for browser agents.
2. **Cost-per-success as the headline metric.** Tokens alone ignore retries; success alone ignores cost. Nobody publishes USD per completed task with confidence intervals.
3. **Deterministic auth.** Real-browser agents (browse, Aside) cannot run reproducibly in CI. Fresh-profile agents (Callisto today) hit every login wall. The missing middle is a **portable session bundle**: export cookies/storage from a real browser, import into an isolated Chromium, replay deterministically, encrypted and scoped.
4. **Policy + audit for unattended runs.** browse has interactive handoff; Aside has consumer approvals; CI has nothing. Allow/deny by origin, action type and spend, with an append-only log, is infrastructure, not a browser feature.

Notice that 1–4 are the same product from four angles: **a runtime you can trust to run the same task twice and tell you what it cost.**

---

## Part 5 — Recommended product

### 5.1 Position

> **Callisto — the reproducible runtime and neutral scoreboard for browser agents.**

Not a browser. Not another MCP wrapper. The layer teams use to answer: *does my agent actually work, what does it cost per task, and can I run it unattended without getting burned?*

### 5.2 Shape

```
callisto                 umbrella + eval + leaderboard
├── @callisto/mini       engine (CDP, a11y tree, refs)        MIT
├── callisto-mcp         adapter: any MCP client can drive it MIT
├── callisto-eval        task runner, scorer, manifests       MIT
├── callisto profile     import/export encrypted session      MIT
└── examples/browser     BrowserOS fork, demo only             AGPL, separate repo
```

Cut the fork from the critical path. Keep it as a demo if you like the screenshot.

### 5.3 The wedge: bring-your-own-session

This is the feature neither browse nor Callisto has, and it resolves the central tradeoff:

- `callisto profile import --from chrome` → encrypted bundle of cookies + localStorage for chosen origins (scoped, expiring, never leaves the machine).
- `callisto run --profile work.json task.yaml` → isolated Chromium, deterministic viewport, replayed session, no fresh-profile login wall.
- Origin allowlist + per-action policy + append-only audit log.
- Result: reproducible **and** authenticated. CI-safe **and** useful.

### 5.4 The scoreboard

Publish, for every harness × model × task set:

| Field | Why |
|---|---|
| success rate + 95% CI | the headline |
| USD per successful task | the metric buyers actually feel |
| tokens/task, turns/task | the cost drivers |
| wall-clock/task | the UX driver |
| harness commit, model, browser build, viewport | reproducibility |
| traces + task-level results | the thing Aside is being criticised for not having |
| prior-hit rate | % of model-written calls valid first try — measures API compatibility |

Start with 30 tasks, four entrants (Callisto harness, browse/opencode, Playwright MCP, agent-browser), one model, one machine. Publish the kit and the raw runs. That is a defensible first number, and it is more than anyone else has.

### 5.5 Why this is "for everyone"

- **Agent developers:** "measure your agent against the field, in an afternoon."
- **Teams:** "run browser agents in CI without handing over your profile."
- **Researchers:** "reproducible numbers with traces."
- **OSS:** "bring your own harness; we score it."

### 5.6 90-day plan

1. **Weeks 1–2 — compatibility + correctness.** Fix the sidecar diff bug, `reload` race, nav timeouts, key modifiers, `fill`, `networkidle`, password redaction, packaging. Add the CSS-locator fallback and live `getByRole`. Target prior-hit rate >95%.
2. **Weeks 3–4 — `callisto-mcp`.** Thin server over the sidecar; drop-in for opencode/Claude Code/Codex. This is distribution.
3. **Weeks 5–7 — profile import/export.** The wedge. Encrypted, scoped, expiring.
4. **Weeks 8–10 — the first public table.** 30 tasks, 4 entrants, cost-per-success + CI, traces published.
5. **Weeks 11–13 — leaderboard + submission format.** Accept external harnesses; publish the kit.

### 5.7 Kill criteria

Be honest with yourself up front:

- If the first table shows Callisto's harness is not within ~5 points of Playwright MCP at similar cost, the harness thesis is unproven — pivot to pure measurement.
- If profile import cannot pass the same bot walls as a real browser on the target sites, the "CI-safe authenticated" wedge collapses; fall back to "audit + benchmark" only.
- If Aside ships their framework (their FAQ says they might), the neutral-scoreboard window closes fast. Move on the benchmark first, not last.

---

## Part 6 — Engineering backlog (prioritized)

**P0 — correctness (blocks every claim)**
1. `sidecar.ts`: `new Page(mini)`, not `Object.create(mini)`. One line; fixes diff mode and state divergence.
2. `reload()`: register `loadEventFired` before `reload()`; add a nav timeout to `goto`/`reload`/`historyGo`.
3. Password redaction by `input[type=password]` / `protected` property; regression test.
4. Serialize sidecar requests (one in-flight eval at a time).

**P1 — compatibility (blocks the agent's prior)**
5. `locator()` CSS fallback via `DOM.querySelector` + `getBoxModel`.
6. `getByRole` live query or auto-snapshot on miss.
7. Key event table: modifiers, `code`, virtual key codes, Escape/arrows/Home/End; `Input.insertText` for `type`.
8. `fill` via native value setter + `InputEvent` with `inputType`.
9. Honest `networkidle` (Network request counting) or rename it.

**P2 — perception**
10. Make offscreen pruning optional; measure success with/without.
11. Single `getFullAXTree` for the main frame; lazy-load child frames.
12. Batch `aria-hidden` application (collect rects first) or drop the DOM walk entirely.
13. Report refs/coverage in `scripts/tokens.mjs`, not just chars.

**P3 — product**
14. `callisto-mcp`.
15. Profile import/export.
16. Cost-per-success scorer + leaderboard format.
17. Demote the BrowserOS fork to `examples/`; fix licensing separation.

---

## Part 7 — Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Aside open-sources their harness | Medium | Ship the scoreboard first; be the neutral party, not a competitor |
| Headless bot walls cap success | High | Profile import; never promise parity with a real browser |
| Benchmark validity attacks (judge bias) | High | Publish traces, human spot-check, report inter-rater agreement |
| Solo-maintainer bandwidth | High | Cut the fork; build on an existing harness (`pi-mono/core` is what Aside used) |
| "Another AI browser" positioning | Certain if unchanged | Do not ship a browser |
| AGPL fork contaminates the MIT story | Medium | Separate repo, separate artifact, demo only |

---

## Part 8 — Decision: are we competing with browse?

This section records the call that follows from Parts 2–5, so the repo has one place that answers the question directly.

### 8.1 The decision

**No to cloning browse. Yes to being a drop-in for the same clients.**

browse's moat is not its API surface — it is that it drives *your* browser: your logins, cookies, extensions and bot reputation. That cannot be copied by writing a better wrapper. The moment Callisto launches its own Chromium, it sits on the wrong side of that tradeoff, and every buyer asks the one question Callisto loses: *"can it sign into my stuff?"*

So the frame is not "browse but leaner." The frame is: **same clients, one config change, different guarantee.**

### 8.2 What "better" has to mean, concretely

| Axis | Target | Why browse cannot follow |
|---|---|---|
| Same task set, same model | success ≥ browse | table stakes |
| USD per successful task | ≤ browse (target −30%) | browse publishes no cost numbers to defend |
| Turns per task | fewer | the only real speed lever |
| Reproducible | two identical runs, pinned manifest | browse runs against a live, mutating browser |
| Unattended | headless, N parallel, CI-safe | browse is interactive, single-user |
| Auditable | append-only log, origin/action policy | browse has handoff, not policy |
| Auth | imported session bundle | browse has it live; Callisto needs it *portable* |

The last row is load-bearing. Without profile import Callisto loses the auth fight, and the whole "better" story collapses. With it, Callisto gets the one thing browse structurally cannot do: **the same authenticated task, twice, on a machine that is not the user's.**

### 8.3 The distinction that keeps getting lost

"Better than browse" is not a product. It is a **benchmark result**.

The product is the thing that produces the result: a runtime that runs any agent, measures cost-per-success, and proves it. browse becomes an *entrant in the table*, not an enemy. That position is stronger, because you cannot beat what you cannot measure — and Callisto would be the one measuring.

- Building a competitor to browse? **No.**
- Building something browse users can swap in via MCP? **Yes — same clients, one config change.**
- Building the layer that decides whether browse or Callisto is better? **Yes. That is the product.**

### 8.4 The decision rule (30-task, four-way table)

Run Callisto harness, browse/opencode, Playwright MCP and agent-browser on the same 30 tasks, one model, one machine.

- If Callisto wins on **cost per successful task at equal success** → ship the "better browse" story with the table attached.
- If it does not → ship the scoreboard anyway and let it say so honestly. Callisto still owns the category and earns the credibility Aside is currently being questioned for.

Either way the outcome is useful, as long as the deliverable is not a browser with a marketing page.

### 8.5 One line to hold onto

> **browse gives an agent your browser. Callisto gives you a browser you can trust to run the same task twice and tell you what it cost.**

If a feature does not serve that sentence, it is not on the critical path — including the Chromium fork.

---

## Appendix A — Current evidence in this repo

Local runs (working tree, 2026-07):

| Run | Tasks | Success | Tokens/task | Median time | Cost/task |
|---|---|---|---|---|---|
| `webvoyager-live-smoke` | 3 | 100% | 2,615 | 13.1 s | $0.0086 |
| `webvoyager-live-test-2` | 1 | 100% | 2,211 | 13.1 s | $0.0074 |
| `webvoyager-live-test` | 1 | 0% | 0 | 32.0 s | $0 |
| `webvoyager-pr-50-fake` | 50 | 100% (fake model) | 0 | ~0 s | $0 |

Only 4 real live tasks exist. That is a smoke test, not a benchmark — and it is exactly the gap the scoreboard fills. Do not put "100%" in a README without this table next to it.

## Appendix B — Reproduction

```bash
# Callisto, headless, on a downloaded Chrome for Testing
CHROME_PATH=/path/to/chrome CALLISTO_NO_SANDBOX=1 \
  node -e "/* sidecar: launch, goto linear.app, snapshot x5 */"

# browse: same page, count chars and refs
# (see the session helper in this doc's git history)
```

Measurement caveats: single sample, different profiles/login state, dynamic pages, different Chromium builds. Re-run with pinned browser, logged-out state, and N≥5 before publishing.

## Appendix C — Sources

- Aside — "How we built a browser agent that outperforms Fable": https://aside.com/blog/how-we-built-the-sota-browser-agent-that-outperforms-fable
- Aside — Manifesto: https://aside.com/manifesto
- Aside benchmark results: https://github.com/at-inc/aside-benchmarks
- YC company page: https://www.ycombinator.com/companies/aside
- Founder interview (pivot, Chromium, verification): https://www.eomag.io/article/aside-chanhee-lee
- Skeptical reviews: https://www.eesel.ai/blog/aside-ai-browser-review · https://zerogtalent.com/blog/aside-s-ai-browser-breaks-benchmarks-and-scales-gtm-after-viral-june-2026-launch
- Playwright MCP token cost: https://blog.fsck.com/2025/10/19/mcps-are-not-like-other-apis/
- agent-browser token comparison: https://otf-kit.dev/blog/agent-browser-15x-cheaper-than-playwright-mcp
- Playwright CLI vs agent-browser: https://www.ytyng.com/en/blog/ai-browser-automation-tools-comparison-2026
- Playwright MCP docs: https://playwright.dev/mcp/introduction
- Local repo: `packages/mini/src/{index,page,snapshot,ax-*}.ts`, `harness/callisto/`, `runs/*/summary.json`

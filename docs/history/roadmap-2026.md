# Open-Source Agentic Browser — Build Roadmap

> A working plan to ship a credible open-source alternative to Aside / Operator / browser-use, with public evals and a real community.
>
> **Project codename:** `Callisto`
> **Author goal:** solo-to-tiny-team, Python-comfortable developer, ~18 weeks to v1.
> **Approach:** harness-first, defer browser fork, defer training.

---

## How to read this

- Phases 1–5 are the minimum viable product (MVP).
- Each phase has: **goal**, **why**, **concrete steps**, **what to build**, **what to learn**, **success criteria**, **pitfalls**, **time box**.
- The **Learning Track** at the end is a parallel curriculum — run it concurrently with the phase work, not after.
- **Don't-do list** at the very end. Read it before you do anything.

---

## Phase 0 — Before you start (Days 1–3)

### Goal
Decide the project's *shape* and stand up the bones (repo, CI, name) so phase 1 starts clean.

### Why it matters
Half the open-source agent repos die in the first 90 days because the author picks the wrong scope, picks a bad name, or never sets up CI. Doing this on day 1 compounds.

### Concrete steps
1. **Pick a name.** - Done - callisto
2. **Pick the language split.** Recommendation: **TypeScript for the browser runtime (Mini Playwright, a11y tree, browser CDP code)**, **Python for the harness, eval scripts, and CLI**. Both supported from day 1. Don't fight Aside's "follow training data" principle twice — meet in the middle.
3. **Pick a license.** MIT or Apache-2.0. Not GPL. Not "source-available." MIT is friendlier to commercial use, which is fine; you want adoption.
4. **Create the repo.** README with:
   - One-line thesis: "An open-source agentic browser with reproducible eval scores."
   - Status badge (work in progress, Phase X of 5).
   - Quickstart (placeholder even if it doesn't work yet — shows intent).
   - "Benchmarks" section with a table of runs (empty for now, but the table's existence is the promise).
   - Contributing pointer to `CONTRIBUTING.md`.
5. **Set up CI.** GitHub Actions from day one. Even just `pytest` and `tsc --noEmit` for now.
6. **Decide your distribution shape.** Two options:
   - **CLI-first** (`callisto run "task"`) — lower friction, ships as `pip install callisto` and `npm i -g callisto`. My recommendation.
   - **Browser-shaped** (a packaged Chromium variant) — heavier, slower to ship, better long-term UX.
7. **Open an `rfcs/` folder.** Write a 1-page RFC per non-trivial design choice (Mini Playwright surface, a11y tree format, agent loop prompt). This is your project's institutional memory.
8. **Set up a "phase tracker" issue.** One GitHub issue per phase, with checkbox checklist. The community will read it.

### Files to create
```
<project>/
├── README.md
├── LICENSE
├── CONTRIBUTING.md
├── .github/workflows/ci.yml
├── rfcs/
│   └── 0001-mini-playwright-surface.md
└── .gitignore
```

### What to learn
- **Git basics for OSS**: semantic commit messages, branch hygiene, conventional commits.
- **GitHub Actions**: simple matrix builds, caching dependencies.
- **Semantic versioning**: 0.x.y is right for pre-1.0.
- (Optional) **Keep a Changelog**: https://keepachangelog.com/

### Success criteria
- Repo is public, CI is green on `main`, README renders correctly, npm/pypi names are reserved.

### Pitfalls
- Don't bikeshed the name for more than one evening.
- Don't pick GPL "to keep it principled." MIT maximizes adoption.
- Don't skip CI — adding it later is harder.

---

## Phase 1 — Mini Playwright wrapper (Weeks 1–4)

### Goal
Build `callisto.mini` — a thin, agent-friendly wrapper over Chromium that exposes only what an agent needs, in ~15–20 methods, with 80% fewer tokens than raw Playwright.

### Why it matters
This is the foundation. Every token the wrapper burns is a token the agent cannot spend on reasoning. Every method on the surface is a thing the LLM must learn. Aggressive pruning here sets the entire product's efficiency curve.

### Concrete steps
1. **Study `playwright-core` source.** Specifically: how it talks to CDP under the hood. Skim, don't read deeply.
2. **Set up the package.** TypeScript project, `tsconfig.json` strict mode, ESM, Node ≥ 20.
3. **Pick your CDP client.** Two real options:
   - **`chrome-remote-interface`**: tiny, well-typed, ~50 methods. You'll add methods as needed.
   - **`puppeteer-core`**: heavier, but if you want a free fallback for fancy stuff, it has your back.
   - **Recommendation:** `chrome-remote-interface` for the wrapper. Add `puppeteer-core` only for things you can't do directly.
4. **Implement browser lifecycle.**
   - `launch({ headless?, viewport?, userAgent? })` — wrap `chrome --remote-debugging-port=9222` start.
   - `close()`.
   - `pages()` — list open tabs.
5. **Implement the navigation surface.**
   - `goto(url, { waitUntil? })`
   - `back()`, `forward()`, `reload()`
6. **Implement the interaction surface.** All async, all typed.
   - `click(ref | { x, y }, opts?)`
   - `dblclick`, `rightclick`, `hover`, `dragTo(from, to)`
   - `type(text, { delay? })`
   - `press(key)`, `keyDown(key)`, `keyUp(key)`
   - `fill(ref, value)` — clears the field first, then types (so the model doesn't have to remember to clear)
   - `scroll(deltaX, deltaY)`
7. **Implement the observation surface.**
   - `screenshot(opts?)` → `Buffer`
   - `snapshot()` → custom tree (stub for now; full impl in Phase 2)
   - `evaluate<T>(fn, ...args)` → typed result
8. **Implement the tab/wait surface.**
   - `tabs.new(url?) / switch / close`
   - `waitFor(predicate, { timeout?, poll? })` — JS function as string or function ref
9. **Implement the storage surface.**
   - `cookies.get / set / clear`
   - `localStorage.getItem / setItem`
   - `sessionStorage` similarly
10. **Skip ruthlessly.** No selectors engine, no `page.locator()`, no `expect()`, no trace viewer, no video, no network mocking.
11. **Write a 200-line smoke test** that opens amazon.com, takes a screenshot, clicks a button, screenshots again. Run it in CI.

### Code structure
```
packages/mini/
├── src/
│   ├── client.ts        # the CDP client wrapper
│   ├── elements.ts      # ref handling
│   ├── snapshot.ts      # stub for Phase 2
│   └── index.ts         # the 15-20 method surface
├── tests/
│   └── smoke.test.ts
└── package.json
```

### What to learn
- **TypeScript essentials** (if new):
  - `tsconfig.json` basics: `target`, `module`, `strict`, `paths`.
  - **Resource:** *Total TypeScript* (Matt Pocock) free tier, or just the official *TS for JS programmers* docs. Skip deep-dives.
- **Async/Await in TS**: same shape as Python.
- **Chrome DevTools Protocol**: skim https://chromedevtools.github.io/devtools-protocol/. You only need: `Page`, `DOM`, `Runtime`, `Input`, `Accessibility`, `Network`, `Target`. Maybe `Storage`.
- **Playwright internals (light)**: how it dispatches to CDP. You don't need to read all of it — just enough to know what to copy.
- **Ref handling**: how to keep refs stable across re-renders. Single-line pattern: re-snapshot, remap by selector or text match.

### Success criteria
- A 200-line smoke test passes against amazon.com and github.com.
- API surface is documented in one Markdown file with method signatures.
- Token count of "minimally describing the wrapper" is <2K tokens (vs Playwright's ~13K).

### Pitfalls
- **Don't** try to implement everything in Playwright. You'll never finish.
- **Don't** add `page.locator()` chains. Refs only.
- **Don't** wrap CDP responses in raw form. Type them.
- **Don't** forget to set a default viewport. Aside's 1440×900 lesson: pin it.

### Time box
4 weeks part-time. 2 weeks if it's your primary project.

---

## Phase 2 — Custom a11y tree (Weeks 4–7)

### Goal
Replace the stub `snapshot()` with a custom accessibility tree that's 50–70% smaller than agent-browser's, with stable refs and useful state annotations.

### Why it matters
This is the perception layer. The LLM sees the world through this. Denser = more efficient. Stable refs = fewer re-snapshots. Good state annotations = fewer hallucinations.

### Concrete steps
1. **Read the ARIA + accessibility-tree specs.** MDN's "Accessibility tree" article; WAI-ARIA 1.2 roles reference.
2. **Wire up CDP's Accessibility domain** in your Mini wrapper.
   - `Accessibility.enable`
   - `Accessibility.getFullAXTree`
3. **Understand the four properties of AX objects:** name, description, role, state. (From MDN.)
4. **Implement the pruner.** Heuristics:
   - Drop nodes with `role: "none"` or `"presentation"`.
   - Drop nodes with empty `name` AND no interactive `role`.
   - Drop intermediate text nodes that don't carry semantics.
   - Collapse wrappers that have only one semantic child.
5. **Implement the ref allocator.** Assign stable string refs:
   - `ref="ax-42"` based on CDP `nodeId` translated via your map.
   - Persist map across re-snapshots when possible (heuristic: same ref → same selector/text).
6. **Augment with LLM-friendly state.**
   - `focused`, `focusable`, `checked`, `expanded`, `disabled`, `selected`, `required`.
   - `iframeId` for nodes inside iframes (so ref lookup can cross frames).
   - Bounding-box hint (for fallback to vision later).
7. **Implement re-resolution.** When a ref fails to resolve, re-snapshot and try a heuristic remap:
   - Same `name` + `role` + nearby state.
   - Same XPath computed from the AX tree.
   - If still fails, return "ref not found" and let the model re-decide.
8. **Handle iframes and shadow DOM.** If a node has `iframeId`, recurse. If shadow DOM is present, walk the shadow root.
9. **Serialize to indented text.** Format like:
   ```
   [page] amazon.com - Sign In
     [#1] <link> "Amazon Home" [href=/]
     [#2] <textbox> "Email or mobile phone number" [required, focused]
       ...
     [#3] <button> "Continue"
   ```
10. **Write a comparator.** Run your tree vs agent-browser / Playwright MCP on the same 10 URLs (amazon, github, linear, notion, gmail, etc.). Report token count delta.
11. **Add a "stable test"** — open a page, snapshot, click a button by ref, snapshot again, verify ref stability.

### Files to add
```
packages/mini/src/
├── snapshot.ts          # full impl
├── ax-prune.ts          # pruning logic
├── ax-refs.ts           # ref allocation + remap
└── ax-format.ts         # text serialization
```

### What to learn
- **Accessibility tree semantics**: ARIA roles, properties, states. ~4 hours of reading will cover it.
- **Chrome DevTools Protocol Accessibility domain**: skim the docs page.
- **Tree diffing algorithms**: just enough to do heuristic ref remap. Nothing fancy.
- **CDP `Runtime.callFunctionOn`**: useful for walking shadow DOM from JS injected.

### Success criteria
- Snapshot of amazon.com checkout page is <500 tokens; agent-browser's is >1500.
- Refs survive a click + state change in 80%+ of cases without re-allocation.
- Tests pass for: amazon.com, github.com, linear.app, notion.so, gmail.com.

### Pitfalls
- **Don't** skip iframe handling. Half the modern web lives in iframes.
- **Don't** drop role-less wrappers naively — some are landmarks (`<main>`, `<nav>`).
- **Don't** allocate refs by incrementing counter — you'll collide on re-snapshots. Hash by nodeId instead.
- **Don't** forget to refresh the AX tree before each snapshot. CDP caches aggressively.

### Time box
3 weeks part-time.

---

## Phase 3 — Agent loop (Weeks 7–11)

### Goal
Build the harness: a coding-agent-shaped loop with two tools (`bash` + a JS REPL backed by Mini), small prompt, single-action discipline, persistent scratchpad.

### Why it matters
This is the brain of the operation. The loop is what makes everything before it useful. Get this wrong and nothing else matters.

### Concrete steps
1. **Pick a foundation library.** Three real options:
   - **pi-mono/core** — what Aside built on. Lean, TypeScript-first, designed for coding agents. *Recommended.*
   - **Vercel AI SDK** — model-agnostic, more batteries included. Good if you want pure ergonomics.
   - **Custom 100-line chat wrapper** — if you want full control and a tiny dep tree.
2. **Define your model abstraction layer.** One interface, many providers:
   ```python
   class ChatModel(Protocol):
       async def chat(self, messages, tools) -> Response: ...
   ```
   Implement for OpenAI, Anthropic, Gemini, Ollama. Stub a fake model for tests.
3. **Implement the two tools.** Both in Python (or TS, your call):
   - **Bash tool**: shell out, return stdout/stderr/exit code. With a 30s timeout.
   - **JS REPL tool**: takes JS code, runs it against Mini, returns the result. The Mini wrapper is imported here.
4. **Write the system prompt.** Aim for <12K tokens. Sections:
   - Identity (3 lines).
   - Capabilities (10 lines: what tools exist, what the runtime looks like).
   - Workflow (20 lines: always snapshot first, one action per turn, retry on failure).
   - Examples (5–10 concrete examples of good vs bad tool use).
   - Anti-patterns (10 lines: don't write prompts to yourself, don't repeat the same failing action, don't make up URLs).
   - **Don't teach Playwright.** Aside's big lesson. The model knows it.
5. **Implement the loop.**
   ```python
   while not done and steps < max_steps:
       response = await model.chat(history, tools)
       if response.tool_calls:
           for call in response.tool_calls:
               result = await execute_tool(call)
               history.append(call, result)
       else:
           done = True
           return response.text
   ```
6. **Add the scratchpad.** Write a file `/tmp/callisto/scratch.md` after each turn. The model can re-read it next turn. This gets you free long-horizon context.
7. **Add recovery hooks.**
   - On tool error: re-snapshot, return "couldn't find ref, here's the new state."
   - On consecutive identical actions: stop and ask the user.
   - On "stuck" detection (same state N turns in a row): halt with explanation.
8. **Add the `/ask` command.** Pause-and-confirm on destructive actions. Implement as a tool decorator.
9. **Test against 5 hand-picked tasks.**
   - "Find the pricing page for linear.app."
   - "Log into a staging environment (no MFA)."
   - "Extract the top 10 product names from this page."
   - "Fill out and submit a simple form."
   - "Compare prices for X across 3 sites."
10. **Add a CLI**: `callisto run "task description"`.

### Files to add
```
harness/
├── pyproject.toml
├── callisto/
│   ├── __init__.py
│   ├── models/
│   │   ├── base.py
│   │   ├── openai.py
│   │   ├── anthropic.py
│   │   ├── gemini.py
│   │   └── ollama.py
│   ├── tools/
│   │   ├── bash.py
│   │   ├── repl.py
│   │   └── ask.py
│   ├── loop.py
│   ├── scratchpad.py
│   ├── snapshot.py  # uses the Mini wrapper
│   └── cli.py
└── tests/
    ├── test_loop.py
    └── test_e2e.py
```

### What to learn
- **ReAct / chain-of-thought**: skim the original papers (Wei et al. 2022; Yao et al. 2022). 30 min.
- **Tool-use function-calling APIs across providers**: they differ slightly. Read once, write the abstraction, move on.
- **Prompt engineering for coding agents**: read Anthropic's "Building effective agents" and OpenAI's "A practical guide to building agents." Then stop reading prompts guides and start writing your own.
- **Error-handling patterns**: exponential backoff, idempotency, graceful degradation.

### Success criteria
- 5/5 hand-picked tasks complete.
- Single-task runs cost <$0.30 of API tokens at GPT-5 / Claude Opus quality.
- System prompt is <12K tokens.

### Pitfalls
- **Don't** add a third tool. Two is the discipline.
- **Don't** let the model write its own prompt. Aside's "running autoresearch produces slop" lesson.
- **Don't** allow multiple actions per turn. Single-action discipline is the most-replicated reliability win.
- **Don't** over-engineer the harness. 200 lines is fine.

### Time box
4 weeks part-time.

---

## Phase 4 — Auth, safety, memory (Weeks 11–15)

### Goal
Add the layers that turn a demo into something people can actually use: password autofill (LLM never sees the password), approval flow for sensitive actions, sandbox isolation, local memory.

### Why it matters
This is where callisto (or whatever you call it) actually differentiates from browser-use / Skyvern — they all skip this. Aside has it; the OS version you ship should have it; nobody else has open-sourced it well.

### Concrete steps
1. **Audit what you must protect.**
   - User passwords (no LLM read access).
   - User payment info (LLM should always need approval to use).
   - User messages/posts (LLM should need approval to send).
   - User files (sandboxed to scratch dir by default).
2. **Implement password autofill via OS keychain.**
   - Python: `keyring` library.
   - TS binding to: macOS Keychain, Linux libsecret, Windows Cred Manager.
   - When the agent needs to log in, it emits a `signin(selector, credentialId)` tool call. The harness resolves `credentialId` → secret from keychain, types it, never returns the value to the model.
3. **Implement approval flow.**
   - Decorate sensitive tool calls with `@requires_approval`.
   - Harness pauses, prints the action, prompts the user via CLI/TUI.
   - On approve, proceed. On deny, return error to model.
   - Categories to start with: payment, send_message, post_public, delete, account_change.
4. **Implement the sandbox.**
   - Run each session as a separate OS user (Linux: `useradd` + `su`; macOS: just sandbox-exec with a profile; Windows: harder).
   - Use OS-level containerization if available (bubblewrap, sandbox-exec).
   - Default-deny outbound network; allowlist of domains.
   - Filesystem restricted to a per-session `~/.callisto/sessions/<id>/` dir.
5. **Implement memory.**
   - Pick embedding model: `sentence-transformers/all-MiniLM-L6-v2` is small and good.
   - Index: every task summary + key pages visited.
   - At task start, query top-K by cosine similarity to current task description.
   - Injection point: prepend relevant memories to context (token-budget capped).
   - Storage: local SQLite + vectors. Don't ship Postgres.
6. **Implement audit logging.**
   - Every (screenshot, snapshot diff, action, tool_result, model output, timestamp) → JSONL append.
   - Per session, per task.
   - This is essential for debugging AND for the eval-repro story. Aside's bet.
7. **Wire it all into the harness loop.** Tool calls now have post-conditions: "after `type(secret)` is called, the secret value is purged from the message history" (purge via message-edit before next model call).
8. **Write a security test suite.** 50 cases. Things like:
   - "Passwords typed in this session never appear in the message log."
   - "Payment action requires approval."
   - "Filesystem writes are confined to the scratch dir."
9. **Document the threat model.** A `SECURITY.md` with what you protect, what you don't, how to report issues.

### Files to add
```
harness/callisto/
├── auth/
│   ├── keychain.py
│   └── autofill.py
├── approvals.py
├── sandbox.py
├── memory.py
├── audit.py
└── threat_model.md   # also /SECURITY.md at repo root
```

### What to learn
- **OS keychain APIs** (keyring lib abstracts most of this).
- **Linux user namespaces** (if going bubblewrap).
- **Capability-based authorization** (read the small book *Capability Myths Demolished*).
- **Local embedding models**: `sentence-transformers` basics, ONNX runtime, FAISS or hnswlib for vector search.
- **Threat modeling**: STRIDE, LINDDUN, OWASP Agentic AI Top 10.

### Success criteria
- Passwords flow through keychain without LLM read.
- Sensitive tool calls block until user approves.
- Filesystem writes confined, audit log complete, memory retrievable.
- `SECURITY.md` published.

### Pitfalls
- **Don't** roll your own crypto. Use libsodium / Fernet / keyring.
- **Don't** "secure by obscurity" — publish the threat model. Credibility.
- **Don't** try to make the sandbox perfect. Make it good-enough and document what's not.
- **Don't** skip the audit log. Trust me.

### Time box
4 weeks part-time.

---

## Phase 5 — Benchmarks & public evals (Weeks 15–18)

### Goal
Ship a public eval suite that runs on every PR and shows real benchmark numbers. Credibility moat.

### Why it matters
Browser-use's numbers are noise because nobody publishes their eval kit. Aside's numbers are *plausible* because they publish theirs. You need to do the same or your benchmarks mean nothing.

### Concrete steps
1. **Pick the four benchmarks to target.** In order of priority:
   - **WebVoyager** (~640 tasks, public, easy) — first to ship.
   - **Online-Mind2Web** (300 tasks, 136 sites) — the canonical web-agent test.
   - **BU-Bench-V1** (100 tasks) — referenced in browser-use blog.
   - **Odyssey** (long-horizon, request access) — current frontier.
2. **Set up the eval kit repo.**
   ```
   eval/
   ├── benchmarks/
   │   ├── webvoyager/
   │   ├── mind2web/
   │   ├── bu_bench_v1/
   │   └── odyssey/
   ├── runner.py        # orchestration
   ├── scorer.py        # rubric + completion scoring
   └── README.md        # "Run this to reproduce our numbers"
   ```
3. **Implement the WebVoyager runner first.** It's the easiest. ~640 tasks covering 15 sites.
4. **Implement reproducibility discipline.**
   - Pin model versions (`gpt-5.5-2026-04-12`, `claude-fable-5-...`).
   - Pin dependency versions.
   - Pin your own commit SHA in eval output.
   - Store model responses + tool calls + screenshots for every task.
5. **Make the runner fail closed.** If a task can't complete (page down, etc.), it doesn't count, doesn't get padded with a fake pass.
6. **Add CI integration.** Every PR runs WebVoyager on a 50-task subset. If it tanks, the PR fails.
7. **Publish a `BENCHMARKS.md`** at the repo root with a table:
   ```
   | Benchmark      | Ours   | browser-use | Skyvern | Operator |
   | -------------- | ------ | ----------- | ------- | -------- |
   | WebVoyager     | TBD    | ~89%        | TBD     | ~87%     |
   | Mind2Web (live)| TBD    | ~97.7%      | TBD     | ~92.8%   |
   | BU-Bench-V1    | TBD    | TBD         | TBD     | TBD      |
   | Odyssey (long) | TBD    | TBD         | TBD     | TBD      |
   ```
   Numbers should be reproducible from your kit. Anyone with the kit and an API key should be able to fill in their own row.
8. **Don't claim SOTA.** Report numbers with confidence intervals. Don't claim first place without a per-benchmark head-to-head.
9. **Submit to Mind2Web leaderboard.** Once you have a number you're confident in. Aside hasn't done this yet; you can beat them there.

### Files to add
```
eval/
├── pyproject.toml
├── runner.py
├── scorer.py
├── BENCHMARKS.md      # also at repo root
└── benchmarks/...
.github/workflows/
└── eval.yml           # weekly cron + per-PR runs
```

### What to learn
- **WebVoyager paper + dataset**: ~2 hours.
- **Mind2Web dataset**: ~4 hours to understand. Skip the static-Mind2Web, focus on Online (live sites).
- **Hugging Face `datasets` library**: useful for benchmark loading.
- **Statistical rigor**: bootstrapping, confidence intervals, multiple seeds. Even simple thing like "run 3 times, report mean ± std" is 100× better than single-run numbers.
- **Public benchmark ethics**: don't cherry-pick. Don't run on training-data tasks. Report failures.

### Success criteria
- WebVoyager runs locally with one command.
- `BENCHMARKS.md` at repo root reflects current numbers.
- CI fails when a PR drops your WebVoyager score by more than 5%.
- Mind2Web leaderboard submission accepted (or queued).

### Pitfalls
- **Don't** submit to leaderboards with non-reproducible numbers. Reputation dies fast.
- **Don't** data-contaminate. If a benchmark site is in your training data, exclude it.
- **Don't** conflate "model X + our harness" with "our harness alone." Report both.
- **Don't** lie. The community will catch you.

### Time box
3 weeks part-time.

---

## Phase 6+ — Optional, after v1 ships

### Phase 6 — Browser fork (only if you must)
- **Trigger:** real users say "the stock Chromium doesn't work for X."
- **Options:**
  - Fork Lightpanda (already designed for agents).
  - Patch stock Chromium yourself (high cost — multi-engineer, years).
  - Patch via Electron (medium cost).
- **Patches to consider porting from Aside:**
  - Background-tab focus-stealing prevention.
  - Viewport locking at 1440×900.
  - `navigator.webdriver` removal + canvas noise mitigation (bot detection).
- **Time:** 1–6 months depending on scope.

### Phase 7 — Fine-tuning (only if v1 traction exists)
- **Don't** pretrain a model. **Distill** instead.
- Collect trajectories from GPT-5 / Claude Opus running through your harness on real tasks. ~10K trajectories is a starting corpus.
- Fine-tune one open coder model (Qwen2.5-Coder, GLM-4.5, DeepSeek-V3) on the *successful* subset.
- Target a *specific* subskill first (e.g., the a11y-tree-to-coords click predictor). Don't try to fine-tune the whole loop.
- **Time:** 1–3 months for one subskill.
- **Risk:** Trajectory quality > quantity. Bad trajectories train bad models.

### Phase 8 — Multi-agent
- Subagent spawning (Aside mentions this for "research then act" workflows).
- Recursive planning.
- Inter-agent memory.

### Phase 9 — Cloud offering
- Hosted browser sessions.
- Paid tier.
- Enterprise features (SSO, audit retention, custom models).

---

## Cross-Cutting: Learning Track (concurrent with phases)

Run this as a parallel curriculum. Don't cram it into phase 1 — pace it across the 18 weeks. ~3–5 hours/week should be enough.

### Week 0–2: Foundations
- **TypeScript essentials**: types, interfaces, generics (light), async/await. Total TypeScript *free tier* or the official handbook.
- **Node ecosystem**: ESM, npm scripts, `package.json`, `tsc --noEmit`.
- **Modern Python**: async/await, type hints (if you've drifted from these), `pydantic` basics.
- **Git basics for OSS**: rebasing, conventional commits, GitHub PR workflow.

### Week 2–6: Browser internals
- **Chrome DevTools Protocol**: skim the docs, focus on Page, DOM, Runtime, Input, Accessibility, Network.
- **Playwright source code**: read the architecture overview, not every line. Understand how Playwright dispatches to CDP.
- **Web accessibility basics**: MDN "Accessibility tree", WAI-ARIA roles reference (~4 hours total).
- **iframe and shadow DOM**: read the spec, understand how they differ from the main DOM tree.

### Week 6–10: Agent fundamentals
- **ReAct paper** (Yao et al. 2022): 30 min skim.
- **Chain-of-thought paper** (Wei et al. 2022): 20 min skim.
- **Tool-use function-calling APIs**: read each provider's docs once. Note the differences.
- **Anthropic's "Building effective agents"**: read once. Take notes.
- **OpenAI's "A practical guide to building agents"**: read once.
- **Then stop reading and start building.** Most agent projects die in prompt-guide hell.
- **Browse the Claude Code / OpenAI Codex source patterns.** Even if you can't read the full source, public architecture summaries are gold.

### Week 10–14: Security
- **OWASP Agentic AI Top 10**: read once.
- **STRIDE threat modeling**: 1 hour. Apply to your auth layer.
- **OS keychain APIs**: `keyring` lib reads most of it.
- **Basic capability-based authorization**: read the *Capability Myths Demolished* paper.
- **SQLite + vector search basics**: `sqlite-vec`, `faiss`, or `hnswlib`. Pick one.

### Week 14–18: Eval methodology
- **Statistical rigor for ML evals**: bootstrapping, confidence intervals, multiple seeds.
- **WebVoyager + Mind2Web papers + datasets.**
- **Reproducibility checklists.**
- **Public benchmark ethics**: don't data-contaminate, don't cherry-pick.

### Optional / off-and-on
- **Watch talks from AI engineer World's Fair, GitHub Universe, Cursor's "Composer" launch.** Skip vendor pitches; watch the *technical* talks.
- **Read `browser-use`, `Stagehand`, and `Skyvern` source.** Borrow the good ideas, name them.
- **Read everything Magnus Müller (Skyvern) writes.** He's one of the most thoughtful people shipping in this space.

---

## Meta — Releasing, Community, Contribution Guide

### Repository hygiene
- `README.md` with quickstart, status, benchmarks table, links to docs.
- `CONTRIBUTING.md`: how to file issues, PR conventions, RFC process, "good first issue" label.
- `CODE_OF_CONDUCT.md`: standard Contributor Covenant.
- `LICENSE`: MIT or Apache-2.0.
- `SECURITY.md`: threat model + how to report vulns.
- `CHANGELOG.md`: keep a changelog from day 1.
- `rfcs/`: design decisions get an RFC before code.

### Release strategy
- 0.x for the entire roadmap.
- Pre-1.0 means "expect breaking changes" — that's fine.
- Tag every phase milestone with a GitHub release.
- Publish to PyPI and npm as soon as the CLI is usable.
- Don't wait for "perfect" — ship the rough thing and iterate.

### Community signals
- A "phase tracker" issue per phase (community reads these).
- Public roadmap (the file you're reading) committed at `ROADMAP.md`.
- Weekly devlog posts (optional but powerful for traction).
- Discord or GitHub Discussions — pick one. Don't run both badly.

### Contribution guide
- Small first issues: a `good first issue` GitHub label.
- A "first contribution" check in CI to guide newcomers.
- Friendly tone in code review. Reject slop, accept people.

---

## Don't-Do List (read before you do anything)

1. **Don't fork Chromium first.** Start with stock Chromium via CDP. Fork only if v1 ships and users ask.
2. **Don't train from scratch.** Distill, or don't train at all.
3. **Don't add tools to the agent loop.** Two tools. JS REPL + bash. Stay disciplined.
4. **Don't let the model write its own prompt.** Aside's lesson.
5. **Don't claim SOTA.** Report numbers; let the leaderboard decide.
6. **Don't skip auth/safety memory.** This is your differentiator.
7. **Don't ship without an eval kit.** Your numbers mean nothing if no one can reproduce them.
8. **Don't GPL your code.** MIT or Apache-2.0. Maximize adoption.
9. **Don't bikeshed the name.** One evening, then commit.
10. **Don't read prompt engineering guides forever.** Build, test, iterate.
11. **Don't add iframe handling "later."** Half the modern web is iframes; phase 2 needs it from day 1.
12. **Don't put the LLM's context on a diet of full screenshots.** Use the a11y tree; save vision for fallback.
13. **Don't lock yourself to one provider.** Plug-in model abstraction on day 1.
14. **Don't forget to publish the threat model.** It's a credibility move AND you'll catch your own bugs.

---

## Timeline Summary

| Week(s) | Phase | Goal |
|---------|-------|------|
| 0 (3 days) | Phase 0 | Repo, name, license, CI, README seed |
| 1–4 | Phase 1 | Mini Playwright wrapper, smoke tests |
| 4–7 | Phase 2 | Custom a11y tree, comparator against agent-browser |
| 7–11 | Phase 3 | Agent loop with two tools, scratchpad, recovery |
| 11–15 | Phase 4 | Auth, safety, sandbox, memory, audit log |
| 15–18 | Phase 5 | Public benchmarks, leaderboard submission |
| 18+ | Phase 6+ | Browser fork? Fine-tuning? Multi-agent? |

Solo, part-time: ~18 weeks to v1.
Solo, full-time: ~10 weeks.
Two-person team, full-time: ~6–8 weeks.

---

## Appendix A — Useful References

### Code to study
- `at-inc/aside-benchmarks` — Aside's eval kit (the model).
- `browser-use/browser-use` — the reference harness pattern.
- `skyvern-ai/skyvern` — vision-first, explore-then-replay pattern.
- `browserbase/stagehand` — TS-friendly browser agent.
- `lightpanda-io/lightpanda` — agent-shaped browser.
- `conductor-oss` — Apart's parent project, mentioned by Aside.
- `pi-mono/core` — the foundation Aside built on.
- `nøttelabs/open-operator-evals` — a third-party reproduction kit for browser-use.

### Papers (skim, don't deep-read)
- ReAct (Yao et al. 2022)
- Chain-of-Thought (Wei et al. 2022)
- WebVoyager (He et al. 2024)
- Mind2Web (Deng et al. 2023)
- Building Effective Agents (Anthropic, 2024)
- A Practical Guide to Building Agents (OpenAI, 2025)

### Docs to know cold
- Chrome DevTools Protocol: https://chromedevtools.github.io/devtools-protocol/
- Accessibility tree (MDN): https://developer.mozilla.org/en-US/docs/Glossary/Accessibility_tree
- ARIA 1.2: https://www.w3.org/TR/wai-aria-1.2/
- OWASP Agentic AI Top 10 (2025)
- pi-mono core docs: https://pi.dev/

### People to follow
- Magnus Müller (Skyvern) — most thoughtful agent engineer in OSS.
- Yejin Park, Andrej Karpathy (general LLM reasoning critique).
- Simon Willison's blog — best at explaining emerging agent tech.

---

## Appendix B — When you get stuck

| Stuck on... | First move |
|---|---|
| TypeScript build errors | Read the error to the end. 90% are type-fixable in 2 minutes. |
| CDP method returning nothing | Check you called `.enable()` first. |
| Ref not found after re-render | Re-snapshot, remap by name+role+state. |
| Model hallucinates URLs | Add anti-pattern to prompt: "always `goto()` before reading." |
| Agent loops forever | Add max-step guard. Detect identical action N times → halt. |
| Token costs explode | Check: full screenshots in context? Verbose DOM? Trim both. |
| Auth fails | Use OS keychain, never touch creds in the model. |
| Can't reproduce your own benchmark numbers | Pin model versions, pin dependency versions, document the SHA. |
| User doesn't trust password autofill | Publish the threat model. Explain it can't leak the password to the LLM. |
| Long-horizon task fails at step 30 | Read the audit log. Find where context started drifting. Add a checkpoint. |

---

*Last updated: alongside the conversation that produced this roadmap. Update it as you ship.*

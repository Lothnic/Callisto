# Callisto

**An open-source agentic browser with reproducible eval scores.**

[![CI](https://github.com/Lothnic/callisto/actions/workflows/ci.yml/badge.svg)](https://github.com/Lothnic/callisto/actions/workflows/ci.yml)
![status](https://img.shields.io/badge/status-WIP%20%C2%B7%20Phase%205%20of%205-orange)
![license](https://img.shields.io/badge/license-MIT-blue)

> ⚠️ **Work in progress.** Harness-first build toward v1. See the [roadmap](roadmap.md).

Callisto drives a real Chromium over the Chrome DevTools Protocol and hands an
LLM agent a tiny, token-cheap surface to perceive and act on the web. The bet:
a lean perception layer (a custom accessibility tree) plus a disciplined
two-tool agent loop beats a fat wrapper every time — measured on public evals
anyone can reproduce.

## Why another one

- **Token-lean by construction.** The Mini wrapper is ~15–20 methods described
  in <2K tokens (raw Playwright is ~13K). Every token saved is a token the
  agent spends reasoning.
- **Reproducible numbers.** Every benchmark ships with the kit that produced
  it. Pinned models, pinned deps, pinned commit SHA. See
  [BENCHMARKS.md](BENCHMARKS.md) and the Phase 5 [`eval/`](eval/) kit.
- **Safety is a feature, not a footnote.** Keychain-backed autofill (the LLM
  never sees the password), approval gates on sensitive actions, sandboxing,
  and a full audit log. See [SECURITY.md](SECURITY.md).

## Quickstart

From a clone of this repo (editable install; PyPI packaging is still `0.x`):

```bash
# 1. Browser runtime (Node ≥ 20)
cd packages/mini
npm install
npm run build

# 2. Python harness
cd ../../harness
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"

# 3. API key
cp ../.env.example ../.env
# edit ../.env — set GROQ_API_KEY (default) or another provider key

# 4. Run a task (loads harness + Chrome via run.sh)
cd ..
./run.sh "find the pricing page for linear.app"
```

Useful variants:

```bash
./run.sh --visible "open github.com and list open issues"
./run.sh --ollama "open skyscanner for flights from delhi to goa"
./run.sh --siliconflow --model tencent/Hy3 "what is on example.com"
./run.sh --chat                         # multi-turn session
```

Provider flags: `--groq` (default), `--openrouter`, `--siliconflow`,
`--generalcompute`, `--ollama`. Safety defaults: Chrome sandbox and human
approval are **on**. For Docker/CI only: `./run.sh --no-sandbox --no-approval
"..."`. See `harness/.venv/bin/callisto run-task --help` for the full CLI.

Offline tests without a browser or API key:

```bash
cd harness && .venv/bin/pytest
cd packages/mini && npm test
cd eval && pip install -e ".[dev]" && pytest
```

## Benchmarks

| Benchmark          | Callisto | browser-use | Operator |
| ------------------ | -------- | ----------- | -------- |
| WebVoyager smoke   | 100% live (`siliconflow/tencent/Hy3`, 3 tasks) | n/a | n/a |
| WebVoyager smoke   | 100% fake/offline | n/a | n/a |
| WebVoyager full    | TBD      | ~89%        | ~87%     |
| Mind2Web (live)    | TBD      | ~97.7%      | ~92.8%   |

Numbers are reproducible from the eval kit (Phase 5). The first live row is a
3-task smoke run only; full benchmark runs still land as `TBD` until published
with manifests. See [BENCHMARKS.md](BENCHMARKS.md).

## Architecture

| Package         | Language   | What it is                                        |
| --------------- | ---------- | ------------------------------------------------- |
| `packages/mini` | TypeScript | CDP wrapper — the agent's hands and eyes          |
| `harness/`      | Python     | The agent loop, tools, CLI *(done)*                |
| `eval/`         | Python     | Public benchmark kit *(Phase 5 started)*          |

Installable package names today: `callisto-harness` and `callisto-eval`
(console scripts: `callisto`, `callisto-eval`). The top-level name `callisto`
is reserved for a future unified release.

## Roadmap

Phases 1–5 are the MVP. See [roadmap.md](roadmap.md) for the full plan and
[rfcs/](rfcs/) for design decisions.

| Phase | Deliverable                                        |
| ----- | -------------------------------------------------- |
| 1     | Mini Playwright wrapper *(done)*                    |
| 2     | Custom a11y tree *(done)*                           |
| 3     | Agent loop (two tools, scratchpad, recovery) *(done)* |
| 4     | Auth, safety, memory, audit log *(done)*            |
| 5     | Public benchmarks + leaderboard *(in progress)*    |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Design changes get an
[RFC](rfcs/) first. Be kind; reject slop, accept people.

## License

MIT — see [LICENSE](LICENSE).

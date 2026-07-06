# Callisto

**An open-source agentic browser with reproducible eval scores.**

[![CI](https://github.com/Lothnic/callisto/actions/workflows/ci.yml/badge.svg)](https://github.com/Lothnic/callisto/actions/workflows/ci.yml)
![status](https://img.shields.io/badge/status-WIP%20%C2%B7%20Phase%201%20of%205-orange)
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
  [BENCHMARKS.md](BENCHMARKS.md) (coming in Phase 5).
- **Safety is a feature, not a footnote.** Keychain-backed autofill (the LLM
  never sees the password), approval gates on sensitive actions, sandboxing,
  and a full audit log. See [SECURITY.md](SECURITY.md).

## Quickstart

> Placeholder — the CLI lands in Phase 3. This shows the intended shape.

```bash
# Python harness (Phase 3+)
pip install callisto
callisto run "find the pricing page for linear.app"
```

```bash
# TypeScript browser runtime (Phase 1, this repo)
cd packages/mini
npm install
npm run typecheck
CALLISTO_SMOKE=1 npm test        # needs a local Chrome/Chromium
```

## Benchmarks

| Benchmark       | Callisto | browser-use | Operator |
| --------------- | -------- | ----------- | -------- |
| WebVoyager      | TBD      | ~89%        | ~87%     |
| Mind2Web (live) | TBD      | ~97.7%      | ~92.8%   |

Numbers are reproducible from the eval kit (Phase 5). Empty today — the table's
existence is the promise.

## Architecture

| Package         | Language   | What it is                                        |
| --------------- | ---------- | ------------------------------------------------- |
| `packages/mini` | TypeScript | CDP wrapper — the agent's hands and eyes          |
| `harness/`      | Python     | The agent loop, tools, CLI *(Phase 3)*            |
| `eval/`         | Python     | Public benchmark kit *(Phase 5)*                  |

## Roadmap

Phases 1–5 are the MVP. See [roadmap.md](roadmap.md) for the full plan and
[rfcs/](rfcs/) for design decisions.

| Phase | Deliverable                                        |
| ----- | -------------------------------------------------- |
| 1     | Mini Playwright wrapper *(in progress)*            |
| 2     | Custom a11y tree                                   |
| 3     | Agent loop (two tools, scratchpad, recovery)       |
| 4     | Auth, safety, memory, audit log                    |
| 5     | Public benchmarks + leaderboard                    |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Design changes get an
[RFC](rfcs/) first. Be kind; reject slop, accept people.

## License

MIT — see [LICENSE](LICENSE).

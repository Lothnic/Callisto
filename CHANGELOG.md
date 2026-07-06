# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/) (0.x during the roadmap —
expect breaking changes).

## [Unreleased]

### Added
- Phase 0 scaffold: repo bones (README, license, contributing, code of conduct,
  security policy), CI, RFC process, npm workspace with `packages/mini`.
- Phase 1: `@callisto/mini` — a token-lean CDP wrapper over Chromium exposing
  the ~20-method surface an agent needs (lifecycle, navigation, interaction,
  observation, tabs/wait, storage).
- Phase 2: custom accessibility tree behind `snapshot()` — pruned,
  ref-annotated, iframe-aware, serialized to compact indented text
  (`ax-prune`/`ax-refs`/`ax-format`). Refs are stable by `backendDOMNodeId` and
  resolve to box-model centers at action time, so interaction works by ref, not
  just coordinates. `LaunchOpts.chromeFlags` for Docker/CI (`--no-sandbox`).
  RFC 0002 documents the design; `scripts/tokens.mjs` reports tree density.

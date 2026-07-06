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
  observation, tabs/wait, storage). `snapshot()` is a stub pending Phase 2.

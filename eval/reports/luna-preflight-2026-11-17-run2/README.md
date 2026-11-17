# Separate paired Luna preflight

Both Wikipedia trials passed using fresh Codex conversations configured with
`gpt-6-luna`, `high` effort: compact Callisto/Zen and native browse/Chromium.
[Results](results.json) retain their usage, exact prompts, visible tool events and
source evidence. Executed source snapshots and their recorded hashes are under
`harness/` and `harness-sha256.json`.

These two diagnostic trials are not included in the
[24-trial comparison](../luna-real-world-2026-11-17/README.md). The full run
started with new browser profiles; provider-side prefix caches may have been
warmed by this preflight. The event stream records the requested host model
configuration and usage, without independently echoing an upstream model ID.

# Firefox/Zen source installer check — 16 November 2026

The public source installer previously built only isolated Chromium Mini.
That backend has no `callisto_pair` tool and cannot connect to the Firefox/Zen
extension. The updated installer defaults to `zen`, accepts an explicit
`--backend chromium` or `--backend firefox`, and supports opt-in registration
with `--host codex|claude|opencode`.

## Real Linux installation

- Downloaded source from public GitHub at pinned revision
  `ee7bd992172bbea6a0cac4bf9e86ffda458f7ed2`.
- Ran the installer with `--backend zen --host opencode` in a newly initialized
  temporary Git project, using a new installation path and isolated configuration
  and state directories.
- Built the release Rust bridge successfully. It reported
  `callisto-firefox-tab-mcp 0.2.0-alpha.1`.
- OpenCode v2.3.0 registered the exact Node launcher path and explicit `zen`
  argument in that temporary project's configuration.
- Started that registered command over real MCP stdio using isolated relay state.
  The tool catalog included `callisto_pair`, capabilities reported
  `firefox-extension`, and `callisto_pair` generated a correctly shaped local code.
  The code was not retained in this report. The test client and owned relay
  were stopped afterward.
- Environment: Linux x64, Node.js v26.5.0, Cargo 1.99.1.

The smoke verifies download, compilation, host registration, startup, tool
discovery and pairing-code generation. Connecting a browser remains an explicit
user step. macOS installation, Windows support and older host CLI versions
were not verified by this run.

## Repeatable installer checks

`node --test scripts/site-install.test.mjs` exercises the actual Bash installer
with isolated build-tool fixtures. It covers backend selection, explicit host
registration, paths containing spaces, preservation of legacy and existing
installations, failed-build cleanup, a destination appearing during compilation,
invalid arguments and missing Rust. It does not use the network or modify the
user's agent configuration. These checks run in the Firefox CI contract step.

## Published extension

Mozilla's API reports 0.2.0 as public. The downloaded XPI matches the API's
SHA-256; its assets match the source bytes and its manifest matches after parsing
JSON. The archive contains Mozilla signature files.

SHA-256: `27777e6c0e706f3fd57f53fcd01482ee9f00112c9b60a8bba87aaade1de83742`.

See [setup and migration](../../docs/getting-started.md) and
[published add-on details](../../docs/published-extension.md).

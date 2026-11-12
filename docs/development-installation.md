# Launcher, packages and extension signing

Build Mini with `npm --prefix packages/mini ci` and
`npm --prefix packages/mini run build`. Build the existing-profile bridge with
`cargo build --locked --release --manifest-path packages/firefox-rs/Cargo.toml --bin callisto-firefox-tab-mcp`.

One stdio entry point now selects either backend:

```sh
node /absolute/path/to/callisto/scripts/callisto.mjs chromium
node /absolute/path/to/callisto/scripts/callisto.mjs zen
```

Use either command in a host's MCP configuration. For example:

```sh
codex mcp add callisto-zen -- node /absolute/path/to/callisto/scripts/callisto.mjs zen
```

`CALLISTO_BROWSER` supplies the default backend; the command argument overrides
it. `CALLISTO_FIREFOX_BINARY` selects a packaged bridge instead of the source
build. The launcher forwards stdio, termination signals and exit status. It does
not yet normalize the backend tool contracts or update installed files.
Both servers expose `callisto_capabilities` with a versioned response describing
the active backend, observation type, session model and supported features.
Run `node --test scripts/launcher.test.mjs` after building both backends to check
the launcher against the real MCP processes using isolated relay state.

The Runtime packages workflow builds and tests the Rust bridge for Linux x64
and macOS ARM64, creates archives and SHA-256 checksum files, and uploads them
to an existing tagged GitHub release. Manual runs produce workflow artifacts.
These packages are not code-signed. Windows support remains unavailable.

The Sign Firefox extension workflow is manually dispatched. Configure repository
Actions secrets `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` from an AMO developer
account, then run it. Never put these in the extension or repository. It lints
the extension and requests Mozilla signing for self-distribution, uploading the
returned XPI as an artifact. Each submitted version must satisfy Mozilla's
version and review requirements. This does not publish a store listing or an
automatic-update manifest. Signing has not yet been executed for this project.

References: [Mozilla web-ext signing](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/).

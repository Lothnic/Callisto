# Callisto alpha for Linux x64

This alpha is for a small group of testers on Linux x64 with glibc 2.39 or newer.
The packaged build was tested on Ubuntu 26.04.1; other distributions and macOS
are not part of this alpha matrix. It packages Chromium
Mini, the Firefox/Zen bridge, a launcher, diagnostics and an **unsigned temporary
extension**. It does not install a browser, alter host configuration or provide a
permanent signed add-on. Reload the extension after the browser exits.

For normal use, install the [published add-on](published-extension.md) and
use the [source bridge installer](getting-started.md#install-the-firefoxzen-bridge).
Temporary add-on loading is for development and local bundle testing.

The current source package target is `v0.3.1-alpha.1`. Release availability and the tested browser
matrix are recorded in the release notes; source instructions remain usable
before that release is published.

## Install and diagnose

A local alpha build is usable before public release assets are published. From
this checkout, build to a fresh directory, verify and install it:

```sh
npm --prefix packages/mini ci
mkdir -p dist/alpha
node scripts/package-alpha.mjs --version v0.3.1-alpha.1 --out dist/alpha/v0.3.1-alpha.1
node scripts/install-release.mjs --from-dir dist/alpha/v0.3.1-alpha.1 --prefix "$HOME/.local/share/callisto-alpha"
node "$HOME/.local/share/callisto-alpha/bin/callisto.mjs" doctor zen
```

The local installer checks the manifest platform/version and verifies the same
archive checksums as the published-release installer. It installs Node
dependencies, so npm registry access or a suitable local cache is still needed.
Source builds require Node.js 20 or newer, npm, Rust/Cargo, tar, Python and
binutils/objdump. The bundle does not include these build tools.

### Published-release installation

Download `callisto-install.mjs` and its `.sha256` file from the same alpha release
on [GitHub](https://github.com/Lothnic/Callisto/releases). Verify the checksum with
`sha256sum -c callisto-install.mjs.sha256`, then install to a dedicated prefix:

```sh
node callisto-install.mjs --version v0.3.1-alpha.1 --prefix "$HOME/.local/share/callisto-alpha"
node "$HOME/.local/share/callisto-alpha/bin/callisto.mjs" doctor zen
```

Explicit alpha versions are supported. Automatic updates continue to select
stable releases; alpha installation does not opt you into automatic updates.
An installation switches its `current` pointer only after checksums and dependency
installation succeed. A failed update leaves the active version in place.

Register the launcher command with your MCP host:

```sh
node "$HOME/.local/share/callisto-alpha/bin/callisto.mjs" zen
```

For Chromium, use `chromium` instead of `zen`. Chrome/Chromium must be installed;
set `CHROME_PATH` when it cannot be discovered. The optional setup command can
register an MCP entry for a supported host; see [the setup guide](getting-started.md).

## Connect a Firefox or Zen tab

1. Open `about:debugging`, choose **This Firefox**, then **Load Temporary Add-on**.
2. Select `current/packages/firefox-rs/extension/manifest.json` under the prefix.
   For Zen Flatpak, copy the entire extension folder to an accessible location
   such as Downloads first. Keep the CSS and JavaScript files together.
3. Ask your agent for `callisto_pair`, enter that code in the extension and connect.
4. Open the intended test page and choose **Share this tab**. Optional navigation,
   browser and network permissions are separate and explained in the extension.
5. Start with the Example Domain task in the setup guide, using a test account or
   dedicated profile. Finish with **Stop sharing**.

Trusted native input requires an explicitly supplied loopback BiDi endpoint in a
deliberately debug-enabled browser. Do not restart a personal browser merely to
try it. See [the runtime guide](zen-advanced-runtime.md). The default DOM mode
still works without remote debugging.

## Recover and report a problem

After extension disconnect, browser restart or tab loss, share the intended tab
again. After a relay restart, a surviving MCP proxy preserves trusted-input intent
and refuses further input until trusted mode is explicitly enabled again or
explicitly disabled. Interrupted writes are never replayed. Inspect the page
before retrying: an already-dispatched action may have finished.

`doctor` checks package files and private state-directory permissions. It does
not start a relay, read pairing credentials or claim to have tested a live
connection. The extension shows actual connection and shared-tab state.

Include the alpha version, OS/browser/host versions, doctor output, reproduction
steps, expected/actual behavior and redacted errors. Screenshots, DOM, HAR and
trace artifacts may expose private content; review before sharing. Never include
pairing codes, cookie values, account secrets or provider credentials.

To remove the alpha, first stop sharing and close its MCP entry. Remove that
entry from the host, then remove only the dedicated alpha prefix you created.
The temporary extension can be removed in `about:addons`. Removing software does
not erase evidence already exported or data retained by an MCP host.

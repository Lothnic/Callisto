# Firefox and Zen experiments

This crate contains two experimental Rust MCP servers. Neither is ready for a
1.0 release or a replacement for the Chromium connected runtime.

## Existing tabs: extension bridge

`callisto-firefox-tab-mcp` is intended to work with a Firefox or Zen browser
that is already running, using its current profile, tabs and logged-in sessions.
It does not start, close or restart the browser. You choose the existing tab to
share using a Firefox WebExtension; the agent can access that tab while it is
active. The bridge exposes page actions, navigation and optional browser-wide controls,
plus pairing, release and connection status. This path is a prototype. A disposable Firefox
smoke test covers the bridge. A manual Zen Flatpak test confirmed pairing,
sharing a regular existing tab from the page context menu, snapshot and
release. A subsequent manual Zen test clicked Reddit’s Share control and
verified the resulting menu. A supervised Zen research task later verified
search input, search submission, reading GitHub through the existing login,
scrolling and restoring the original page, with recovery required. See
`research/2026-11-12-zen-live-workflow.md` in the repository. Broader workflows
and production installation/restart behavior still need validation.

Build it from this directory:

```sh
cargo build --locked --release --bin callisto-firefox-tab-mcp
```

Add the binary to an MCP-compatible host, replacing the example path with the
absolute path to the built binary:

```json
{
  "mcpServers": {
    "callisto-firefox": {
      "command": "/absolute/path/to/callisto/packages/firefox-rs/target/release/callisto-firefox-tab-mcp",
      "args": []
    }
  }
}
```

To try the prototype, in Firefox or Zen open `about:debugging`, select **This
Firefox**, choose **Load Temporary Add-on**, and select `extension/manifest.json`
from this directory. Return to the existing tab you want to use. Ask the agent
to call `callisto_pair`, enter the returned code in the Callisto extension popup,
connect, and select **Share this tab**. Keep that tab active while the agent
works. Use **Stop sharing** to release the tab, or ask the agent to call
`callisto_close`. Navigation revokes sharing; share the new page again when
needed, unless the optional navigation permission described below is enabled.
A temporary add-on is removed when the browser exits; a signed,
permanently installable extension and a streamlined setup are still needed.
The agent can call `callisto_status` to check whether the bridge is connected,
sharing and on the active tab without reading the page.

For sandboxed Zen Flatpak installations, the browser may not be able to read
extension files in your project directory. If the popup or Preferences page is
blank, copy the entire `extension` directory into `~/Downloads` and load that
copy's `manifest.json` instead. Reload or copy it again when developing changes.
As an alternative to the toolbar popup, open the extension's Preferences page
from `about:addons` to pair, then right-click the desired web page and select
**Share this tab with Callisto**. The toolbar badge says `ON` while sharing.
Built-in browser pages and the new-tab page cannot be shared.

The local Claude Code setup for this checkout can be registered with
`claude mcp add --scope local --transport stdio callisto-zen -- /absolute/path/to/callisto-firefox-tab-mcp`.
For Codex, register the same binary with
`codex mcp add callisto-zen -- /absolute/path/to/callisto-firefox-tab-mcp`,
then restart the MCP servers in the host so its tools are loaded. Ask the agent
to check `callisto_status`. With browser access enabled, it can list and select
an existing tab; without it, share a regular page from the extension first.
The MCP executable automatically starts or connects to a persistent local Rust
relay. Pair the browser once using `callisto_pair`; the extension remembers the
credential and reconnects automatically. Later Codex and Claude MCP sessions
reuse that relay, without pasting another code. A browser or relay reconnect
clears tab sharing; with browser access already granted, the agent can select
an existing tab again. **Stop sharing** releases only the current tab and keeps
the browser paired. **Forget browser pairing** removes the credential from
this extension and disconnects it.

Relay state is stored in `$XDG_STATE_HOME/callisto/firefox` (default
`~/.local/state/callisto/firefox`) with a private directory, credential file
and Unix socket. `CALLISTO_FIREFOX_STATE_DIR` overrides the directory for tests.
The relay holds a file lock to prevent duplicate startup and keeps its endpoint
and credential stable across restarts. `callisto-firefox-tab-mcp --stop-relay`
stops it; the next MCP connection starts it again. `--relay` runs it in the
foreground for diagnostics. This relay implementation currently supports Unix
hosts. All MCP clients currently share one controlled tab and their individual
actions are serialized; named per-agent sessions are not implemented.

The persistent credential is a loopback bearer secret stored in the private
relay file and extension local storage. It is not browse's ECDH/HMAC code
exchange. Forgetting it in the extension removes that copy, not the relay's
credential. To invalidate the relay credential too, stop the relay and remove
its private `pairing.json` file, then start again and pair once.

To keep sharing through page navigation, click **Allow navigation** in the
extension and approve the browser's optional permission prompt. This grants the
extension access to data on **all websites**, not just the shared tab. Callisto's
bridge still sends actions only to the explicitly shared active tab. Share the
tab again after granting permission. The agent may then use `callisto_navigate`
for HTTP(S) URLs and wait until `callisto_status` reports `ready: true` before
taking a new snapshot. Without that permission, navigation revokes sharing.
Restricted browser pages still cannot be shared. You can remove the optional
permission in the browser's add-on settings; doing so stops continuous sharing.

The pairing credential authorizes this browser connection to the local relay. Treat
it as a secret and enter it only into the extension. The process listens on
loopback, and the extension requests access to the explicitly selected tab via
`activeTab`; it does not grant blanket access to all tabs. The agent can read
and change the shared page with your account's privileges. Stopping sharing is
best effort: an action already dispatched can still complete. A timed-out action
may have completed; inspect the page before retrying.

## Faster dependent actions and form submission

`callisto_submit` submits the form associated with an input or submit-button
ref using `requestSubmit`, keeping browser validation and submit handlers. It
provides a form path when a search icon is missing from the snapshot; it does
not emulate a trusted Enter key.

`callisto_batch` executes up to ten `navigate`, `fill_ref`, `click_ref`,
`submit_ref`, `fill_role`, `click_role`, `submit_role` or `scroll` actions in
order and returns one final snapshot. Role locators match an exact role/name,
wait up to two seconds for a missing control and reject multiple matches.
Earlier actions are not rolled back. The batch has a ten-second deadline and
stops if control is revoked or moved to another tab. This reduces host-agent
round trips; it does not remove the existing input stability checks.

Snapshots and actions wait for controlled-page readiness instead of immediately
failing during a load. Reattachment can happen at DOMContentLoaded; it need not
wait for images and trackers to finish. Page navigation and revoked ownership
are tracked separately. A content message interrupted by page unload still has
an uncertain outcome and must be inspected before retrying.

## Agent tabs, windows and containers

Existing controlled tabs receive a `[Callisto]` title marker, restored on release.
A separate, explicitly requested `window_create` uses a labelled window in the
same browser profile. Control is scoped to that window's active tab; a different
focused window does not change the target. A minimized or hidden document can
still reject input. Use `window_close` with the returned window ID for cleanup,
rather than closing its tabs individually.

**Zen mirrors pinned tabs into newly created windows.** An agent window is not
an isolated workspace, and may contain those mirrored pins. Callisto does not
remove or move the pins. The initial new tab can appear as `about:blank` while
its URL loads; attachment retries that transition for up to eight seconds.
The fixes for these live Zen observations have automated regression coverage,
but the final window-attachment fix still needs a repeat live Zen test.

## Browser-wide access

Click **Enable browser access** in the extension and approve the Firefox
permission prompt to allow the connected agent to manage the browser. This is
broader than sharing one tab: it grants access to all website content, tabs,
cookies, bookmarks, history and downloads. The extension saves the
pairing credential across MCP sessions. Use **Forget browser pairing** to disconnect the
extension; `callisto_close` releases the controlled page but leaves the paired
connection and browser-wide permission available. Remove permissions through
the add-on settings when needed.

`callisto_browser` provides these actions:

- `tabs_list`, `tab_select`, `tab_create`, `tab_close`. Selecting a tab also
  shares and focuses it. Creation accepts `cookie_store_id` to preserve a
  chosen Firefox container; tab listings include each tab's cookie store.
  Without an explicit store, new tabs inherit the controlled tab's store.
  `window_create` creates an explicitly requested window labelled `[Callisto]`.
  Creation never moves an existing tab into a new cookie store.
- `back`, `forward`, `reload`, `screenshot` on the controlled active tab.
  Screenshots return MCP image content.
- `cookies_list`, `cookie_set`, `cookie_remove` for an explicit HTTP(S) URL and
  optional cookie store. Cookie values can include authentication secrets.
- `bookmarks_search`, `history_search`, `downloads_search`, bounded to 100
  results. `download` accepts an HTTP(S) URL and opens a Save As prompt.

`callisto_page` adds viewport scrolling, synthetic hover, select by option
value, checkbox state, bounded visible body text and text search. The page must
be active. Input is synthetic; sites can reject it or behave differently.

This is **not browse parity**. There is no arbitrary Playwright `execute`,
trusted input, file upload, network interception, frame targeting, protected
secret store, human-handoff lifecycle, independent agent
sessions. The snapshot is a limited DOM view; it omits frames, shadow DOM and
some text. Password input values are redacted, but other sensitive page content
may be visible. MCP cancellation during in-flight actions is not implemented.
`callisto_status` reports browser permission state and known capability gaps.

Firefox's normal WebExtension API does not implement Chromium's debugger API.
Achieving trusted input and full Playwright-style execution requires a separate
privileged/remote debugging transport. Ordinary extensions alone cannot supply
that capability in a normally started Firefox process. The separate BiDi
experiment does not remove this limitation for a browser started without a
remote-debugging endpoint.

Zen workspaces and Firefox containers are distinct: containers separate site
cookies and logins. The bridge leaves the existing tab in its existing container
and workspace. Moving it to a new container could lose the logged-in session.
A controlled tab has a `[Callisto]` title prefix, including in Zen's tab sidebar.
The original title is restored when sharing stops; site title changes are
preserved. This marker does not isolate cookies.

For new isolated agent tabs/windows, choose **Enable agent containers** and
approve the optional contextual-identities permission. The `agent_container`
browser action creates or reuses a Callisto-owned container; `tab_create` and
`window_create` accept `agent_container: true` to use it. This is a separate
cookie session, so existing logins will not appear there. Existing-tab control
keeps that tab's current container. Container support must be enabled in the
browser. Zen workspaces/folders are not managed by this feature; Zen has
reported extension API limitations for tabs in inactive workspaces.

## WebDriver BiDi experiment

`callisto-firefox-mcp` is a separate, unfinished WebDriver BiDi runtime. It can
launch an isolated Firefox/Zen profile or attempt to connect to an explicitly
debug-enabled browser. Its connected mode requires a running browser started
with a remote-debugging port; it cannot attach to a normal existing Zen process
that was started without that flag. The BiDi protocol and the extension bridge
have different capabilities and neither should be assumed to have parity with
Callisto's Chromium implementation. Do not expose a debugging port to an
untrusted network.

## Tests

`cargo test --locked` tests the transport and pairing. Run
`node --test tests/extension-background.test.cjs` for extension pairing and
stop races. The optional
`node tests/extension-content.mjs` exercises the injected DOM action code in a
disposable Chromium instance, using the mini workspace's Playwright dependency
and `/snap/bin/chromium` by default (`CHROMIUM_PATH` overrides it). It does not
validate Firefox extension permissions, pairing or Zen integration.

`tests/firefox-bridge-smoke.py` drives a disposable headless Firefox instance
through a running local geckodriver. Build the debug binary first, start a test
geckodriver on loopback and run `GECKODRIVER_URL=http://127.0.0.1:4444 python3
tests/firefox-bridge-smoke.py`. It installs a temporary test copy of the
extension with `<all_urls>` and automated sharing to exercise real extension
pairing, snapshot, fill, checkbox/select input, text search, screenshots, cookies,
browser-data reads, tab creation/selection/closing, navigation and release. That broader permission is used
only in the test copy. The test does not verify the optional permission prompt,
`activeTab`, the popup, real profiles or Zen.
The automated test does not validate the normal `activeTab` permission flow.

The Firefox smoke test also verifies that a fresh MCP process reuses the live
paired browser and that restarting the relay preserves pairing and triggers
automatic extension reconnection. Extension startup credential restoration is
covered by the background tests. These tests do not replace a signed add-on
installation or an actual Zen browser restart test.

# Firefox and Zen experiments

This crate contains two experimental Rust MCP servers. Neither is ready for a
1.0 release or a replacement for the Chromium connected runtime.

## Existing tabs: extension bridge

`callisto-firefox-tab-mcp` is intended to work with a Firefox or Zen browser
that is already running, using its current profile, tabs and logged-in sessions.
It does not start, close or restart the browser. You choose the existing tab to
share using a Firefox WebExtension; the agent can access that tab while it is
active. The bridge only exposes snapshot, click and fill, plus pairing and
release. This path is a prototype: the extension has not yet been verified
end-to-end in Firefox or Zen.

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
works. Use **Stop sharing** to disconnect, or ask the agent to call
`callisto_close`. Navigation revokes sharing; share the new page again when
needed. A temporary add-on is removed when the browser exits; a signed,
permanently installable extension and a streamlined setup are still needed.

The pairing code grants control of the shared page for this MCP process. Treat
it as a secret and enter it only into the extension. The process listens on
loopback, and the extension requests access to the explicitly selected tab via
`activeTab`; it does not grant blanket access to all tabs. The agent can read
and change the shared page with your account's privileges. Stopping sharing is
best effort: an action already dispatched can still complete. A timed-out action
may have completed; inspect the page before retrying.

The snapshot is a limited DOM view, not a complete accessibility tree. It can
omit text, large content, shadow DOM and iframe contents. Password input values
are redacted, but other sensitive page content may be visible to the agent.
Click and fill use synthetic DOM events, which some sites reject or handle
differently from real input. Browser pages and other restricted pages cannot be
shared, and no screenshot, tab listing, navigation, downloads or trusted input
is provided by this bridge. It does not expose history or bookmarks to the agent;
the user's browser continues to use its existing profile normally. MCP request
cancellation during an in-flight action is not implemented.

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

`cargo test --locked` tests the transport and pairing. The optional
`node tests/extension-content.mjs` exercises the injected DOM action code in a
disposable Chromium instance, using the mini workspace's Playwright dependency
and `/snap/bin/chromium` by default (`CHROMIUM_PATH` overrides it). It does not
validate Firefox extension permissions, pairing or Zen integration. A real
Firefox/Zen extension integration test and an explicitly authorized existing-tab
workflow are still required.

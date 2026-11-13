# Set up Callisto for an agent

Callisto provides local MCP tools to a host such as Codex, Claude Code or
OpenCode. The host provides the model; Callisto does not need a separate model
API key. The runtimes and distribution are experimental.

## Choose a browser path

| Path | Browser and session | Setup |
| --- | --- | --- |
| Firefox or Zen bridge | Connects to an already open profile and can select an existing tab and its login | Rust bridge plus temporary Firefox extension |
| Chromium Mini | Starts a fresh isolated Chromium session by default | Node.js and Chrome/Chromium |
| Chromium via browse | Opens an agent-owned tab in a Chromium profile paired with browse | Mini plus browse CLI and its extension |
| Chromium direct CDP | Adopts a specified existing tab in an already debug-enabled local browser | Mini plus an explicit CDP endpoint and target ID |

The Firefox bridge uses synthetic input, and some sites reject it. The Chromium
connected modes have different capabilities and setup. See the detailed
[Firefox/Zen guide](../packages/firefox-rs/README.md) and [Mini guide](../packages/mini/README.md).
The Firefox/Zen extension targets Firefox 140+ and compatible Zen builds. Its
relay currently requires a Unix host; Windows is not supported.

## Build and register

Install Git, Node.js 20+, npm, the selected browser, and Rust/Cargo for Firefox
or Zen. Install the Codex or Claude Code CLI if using the matching command
below. Clone the public repository and enter its root:

```sh
git clone https://github.com/Lothnic/Callisto.git
cd Callisto
```

Then build and register one backend:

```sh
bash scripts/install-local.sh zen codex
bash scripts/install-local.sh chromium codex
# Substitute claude for codex when using Claude Code.
```

The command builds the chosen backend and registers a stable launcher for the
selected host. Restart the host's MCP servers to load its tools. For manual
configuration, use `node /absolute/path/to/callisto/scripts/callisto.mjs zen`
or `node /absolute/path/to/callisto/scripts/callisto.mjs chromium` as the stdio
command and arguments. The included OpenCode project configuration starts the
isolated Chromium backend. To add Zen to OpenCode, build the bridge as described
in the Firefox guide, then run:

```sh
opencode mcp add callisto-zen -- node /absolute/path/to/callisto/scripts/callisto.mjs zen
opencode mcp list
```

Replace the example path. The command writes project configuration; add
`--global` before `--` for a global entry. OpenCode's
[MCP setup reference](https://opencode.ai/docs/mcp-servers) explains its
configuration and how to inspect connections. Configuration varies by host.

The website's `install.sh` currently builds **only isolated Chromium Mini**
from a pinned source revision, which can lag the current published branch. Use
the source checkout above for Zen or Firefox and for the latest published code.
The packaged installer and opt-in runtime updater require release assets that
have not yet been published; v0.1.0 is source-only. See
[installation and release tooling](development-installation.md).

## First trial

For a first trial, choose isolated Chromium and use a disposable browser
profile or test account. After restarting the host's MCP servers, ask your
agent: “Use Callisto to open https://example.com, take a snapshot, and tell me
the page heading.” Confirm that the response matches the page. This exercises
navigation and observation without submitting anything. If Chrome is not
discovered, set `CHROME_PATH` in the host's environment to your browser binary.

To finish, ask the agent to call `callisto_close`. For Firefox/Zen, you can
also click **Stop sharing** in the extension; this releases all shared tabs.
For a useful bug report, include your OS, browser and host versions, backend,
checkout commit (`git rev-parse --short HEAD`), steps, expected and actual
behavior, and any redacted error. Do not share pairing codes, cookies, private
page content or credentials. See the repository's [security policy](../SECURITY.md)
for reporting security problems privately.

## Pair Firefox or Zen

1. Open `about:debugging` in the existing browser, choose **This Firefox** →
   **Load Temporary Add-on**, and select
   `packages/firefox-rs/extension/manifest.json` from your checkout.
2. Ask the agent to call `callisto_pair`. Open the Callisto extension popup,
   paste the pairing code into its box, and click **Connect**. Treat the code
   as a secret; enter it only into the extension.
3. On a regular web page, click **Share this tab**, or right-click the page and
   select **Share this tab with Callisto**. Ask the agent to check
   `callisto_status` and take a fresh `callisto_snapshot`.
4. To let the agent select other existing tabs, choose **Enable browser
   access** in the extension and approve the browser prompt. This also grants
   access to cookies, history, bookmarks, downloads and all website content.
   The agent can then list tabs with `callisto_browser` / `tabs_list` and
   explicitly select one with `tab_select` and its tab ID.

For navigation in a shared tab, grant **Allow navigation**; it requests access
to all websites. Built-in browser pages cannot be shared. A temporary add-on is
removed when the browser exits. Pairing is saved across MCP sessions, but a
signed permanent add-on and its restart/update experience are not yet shipped.
With sandboxed Zen Flatpak, copy the **entire** extension directory to Downloads
and load that copy's manifest if the popup is blank.

### First trial in Zen

On a supported Unix host, install Git, Node.js 20+, npm, Rust/Cargo, Zen and
the Codex CLI. Then build the bridge and register it with Codex:

```sh
git clone https://github.com/Lothnic/Callisto.git
cd Callisto
bash scripts/install-local.sh zen codex
```

For Claude Code, replace `codex` with `claude`. Restart the host's MCP servers,
then load and pair the temporary extension using the steps above. Open
`https://example.com` yourself in Zen and share that tab. Keep it active, then
ask the agent: “Use Callisto to check the shared Zen tab and tell me its page
heading.” The expected heading is “Example Domain.” This first trial does not
require the optional navigation or browser-wide access permissions.

When finished, click **Stop sharing** in the extension. The temporary extension
must be loaded again after the browser exits. If the agent cannot connect,
check `callisto_status`, confirm the extension is connected and the intended
tab is shared, and consult the [Firefox/Zen guide](../packages/firefox-rs/README.md).

## Give and take control

Tell the agent which existing tab and task you intend, for example: “Use my open
application form tab and fill the address fields.” The tab retains its current
profile, container and login. Each MCP connection has its own tab ownership;
another session cannot select or close that owned tab. Input requires the tab to
be active in its window. Browser access is powerful: the agent acts with the
page's account privileges. The extension's **Stop sharing** releases all agent
tabs; `callisto_close` releases the calling session's tab.

For a step only you should perform, the agent can call `callisto_handoff` with
`message` and an optional `timeout_ms` on either backend. The older `prompt`
argument remains accepted for compatibility. A
banner asks you to complete the step and click **Continue with agent**. The
agent should take a fresh snapshot afterward; confirmation does not establish
that the intended action succeeded. See [browser data handling](browser-data.md).

## Notes for host agents

- Call `callisto_capabilities` first and use the tools advertised by the
  selected backend. The interfaces and response shapes are not identical.
- Both backends expose `callisto_extract` and `callisto_run`, with the same
  declarative interface. `callisto_extract` takes a row selector and a field
  map and returns typed rows instead of a snapshot; optional `paginate` follows
  a next-page control and merges the pages. `limit` applies per page; `truncated`
  indicates omitted rows or a page cap reached while more pages remain. The
  pager must produce a stable, different set of selected rows within five
  seconds, so identical consecutive pages fail closed. Pagination clicks the
  specified control and may change the page. `callisto_run` executes up to 40
  dependent steps (navigate, click/fill by ref or exact role, press, scroll,
  wait, wait-for-text and extract) in one call. Both are driven by host-supplied
  selectors and refs, not arbitrary page JavaScript. Both are advertised by
  `callisto_capabilities` (`capabilities.run` / `capabilities.extract`,
  `true` since 2026-11-13). In the Zen/Firefox backend the extension must be
  the current build — loading an older copy makes the tools silently missing
  or returning `Unsupported action.`; reload and re-pair it after upgrading.
- Both backends expose `callisto_find` and `callisto_scroll`. Firefox finds
  rendered DOM text, while Chromium searches its accessibility snapshot;
  Firefox scroll returns an action result, so capture a new snapshot afterward.
- For Firefox/Zen, check `callisto_status`, use `tabs_list` and `tab_select`
  only when browser access was granted, then snapshot the chosen tab. Respect
  ownership errors; do not close or take over another session's tab.
- Re-snapshot after navigation or stale-reference errors. List/select a frame
  explicitly when needed; cross-origin frame input and trusted Firefox input
  are unsupported. Use a screenshot or ask the user when a snapshot omits data.
- A cancelled or interrupted action may already have completed. Inspect the
  page before retrying. Use `callisto_handoff` for a user-controlled step and
  release control when finished.
- Never expose pairing codes or cookie values in logs or responses. Follow the
  user's authorization when reading or changing logged-in pages.

# Full browser control

Extension **0.3.0** adds an opt-in mode for agents that need to switch between
website tabs without asking you to share each one. The current Mozilla listing
is 0.2.0; install the new temporary development build or upload the 0.3.0 ZIP
as an update to that listing. Use the matching updated local runtime and restart
the agent's MCP connection so it loads the new browser-tool schema.

## Enable

1. Connect the extension to your local runtime using its pairing code.
2. In the popup or connection settings, choose **Enable full browser control**.
3. Approve the requested website and browser permissions, including hidden-tab
   management. The toolbar badge changes to **ALL** and the popup shows
   **Full browser control active**.

The mode lasts until Stop, Disable, connection loss or extension reload.
Sharing a single tab or preparing background work also switches back to the
existing scoped mode. Broader optional browser API permissions remain granted;
disable those permissions or forget pairing to revoke that access as well.

## What agents can do

- List tabs and windows exposed by the browser extension APIs.
- Activate existing tabs across windows, restore minimized windows and show
  hidden tabs when the browser exposes them. Pinned tabs can be selected.
- Select and attach to a website tab without a separate Share gesture.
- Create tabs in a chosen window or create a new window. Website tabs are
  attached automatically in full mode; their default cookie session is inherited
  from the selected tab. Optional agent containers still use a separate login.
- Create blank tabs and load an HTTP(S) URL into them by ID.
- Read and act on the selected page. With no selected tab, page tools adopt the
  active website tab; otherwise they reactivate their selected tab when needed.
- Transfer a tab from another agent session by selecting it. The previous
  session's lease is revoked before the new session receives page control.

Full mode may change browser focus. Use [prepared background work](background-work.md)
when you want the agent to stay in a separate, unfocused window.

Example calls:

```json
{"action":"tabs_list"}
{"action":"windows_list"}
{"action":"tab_select","tab_id":42}
{"action":"tab_create","url":"https://example.com","window_id":1}
{"action":"tab_create"}
{"action":"tab_navigate","tab_id":43,"url":"https://example.com"}
{"action":"tab_activate","tab_id":42}
```

These are `callisto_browser` arguments. `tab_select` attaches the page and returns
`shared:true`; `tab_activate` only activates the tab and returns `shared:false`.
Blank tabs return `shared:false` until navigated to an accessible website.
`callisto_status.fullAccess` reports whether the mode is active;
`callisto_capabilities.capabilities.fullBrowserControl` reports extension support.
Agents cannot enable the mode through a tool call; it is a user control.

## Browser limits

Full mode removes Callisto's per-page Share step. Firefox-protected pages such
as `about:addons` and addons.mozilla.org still cannot be read through content
scripts under default browser settings. `tab_activate` can focus such an existing
tab without claiming that its content is readable. Zen may omit inactive workspace
tabs from extension APIs; showing ordinary hidden tabs cannot reveal an ID that
the browser never exposes. Private windows follow the browser's extension-access
settings. Trusted native input still requires an explicitly configured debugging
endpoint, and network inspection keeps its separate permission and origin scope.

The full-mode integration checks use disposable Firefox and Zen profiles; unit
tests cover activation, ownership transfer and revocation races, and UI checks cover
permission denial and cancelling an in-progress grant. This is not a claim of
unrestricted access to privileged browser internals.

# Browser data in the local bridge

The Firefox/Zen extension sends requested page observations, screenshots and
browser API results to its paired loopback relay. The MCP host receives those
results and may forward them to the model provider configured by the user.
Callisto does not supply a hosted model service or a telemetry endpoint.

Page content can include personal information. Full browser access additionally
allows tabs, history, bookmarks, downloads and cookie operations. Cookie values
may contain authentication credentials. Password input values are redacted in
DOM snapshots; this is not a general filter for secrets elsewhere in a page,
screenshot or browser API result.

The extension manifest declares website content/activity, browsing activity,
bookmarks, authentication information and search terms for Firefox's built-in
data consent. This requires Firefox/Zen based on Firefox 140 or later. Optional
browser API permissions and explicit tab sharing still control access at runtime.
There is no claim that sending data to a local process counts as no transmission.

Stop sharing revokes active tabs across all agent sessions. Forget browser
pairing deletes the extension's saved pairing credential. To revoke the relay's
credential too, first close MCP clients, stop the relay and remove its private
pairing state, then pair again. Removing a credential does not delete content
already received or retained by a configured MCP host/model provider.

See [Mozilla's data consent documentation](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
for the manifest taxonomy, and [the runtime guide](../packages/firefox-rs/README.md)
for permissions and local-state locations.

The Firefox/Zen extension bridge can explicitly connect a loopback BiDi endpoint
for trusted input. It matches a fresh nonce in the shared document rather than
selecting a tab by URL. Stop sharing and cancellation invalidate that input lease;
an already dispatched input may have completed. The standalone `zen-bidi` server
has its own separate session and detach controls.

Optional API replay uses the shared document's session for explicit same-origin
GET/HEAD requests. It accepts no custom credential/header overrides, refuses
redirects and returns bounded, heuristically redacted JSON. Cookies stay in the
browser. Network capture and OpenAPI drafts can still contain private application
field names and paths. Failed/interrupted trace inspection preserves real
artifacts and explicitly reports missing evidence; it never fills gaps with
invented screenshots or network events.

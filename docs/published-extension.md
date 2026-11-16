# Published Firefox and Zen add-on

[Install Callisto Bridge from Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/callisto/).
On 16 November 2026, Mozilla's public API reports version **0.3.0** as public,
with Firefox 140+ compatibility. The downloaded XPI matches Mozilla's SHA-256
and contains Mozilla signature files. Its scripts and other assets matched
source revision `70f3eef9f20198ec0e14f5432c06b6757b1d284a`; its manifest
matched after parsing JSON. The add-on ID
remains `callisto-tab-bridge@lothnic.dev`.

Version 0.2.0 adds background agent-window controls, trusted-input binding,
run/extract helpers, snapshot continuation and network/API inspection compared
with 0.1.0. Check `callisto_capabilities` against the connected extension before
using new tools. Background concurrency remains experimentally verified only
on Zen with Linux X11.

Published extension **0.3.0** adds [Full browser control](full-browser-control.md),
automatic page attachment, hidden-tab activation and blank-tab navigation.
Use the updated runtime to enable this mode; 0.2.0 does not expose it.

The latest version, **0.3.1**, adds the Callisto orbital icons for the toolbar
and add-on manager. It has been submitted and is awaiting Mozilla approval.
Mozilla's public metadata still reports 0.3.0 at the verification above; the
store listing will offer 0.3.1 once Mozilla publishes it.
The same icons are available in `assets/brand/` for the store listing.

## Install and connect

1. Install the add-on from Mozilla Add-ons in Firefox or a compatible Zen build.
2. Install the matching local bridge and register your agent host using the
   [setup guide](getting-started.md). The website's source installer defaults
   to the Firefox/Zen bridge; Chromium Mini does not pair with this extension.
3. Restart the agent's MCP connection, request `callisto_pair`, enter its code
   in the extension and explicitly share a regular website tab.

Installing the add-on alone does not install the runtime or provide a model.
Optional browser access and network inspection remain separate permission
grants. Firefox's protected pages, including addons.mozilla.org, cannot be
shared under default browser settings. See [browser data handling](browser-data.md)
and [background work](background-work.md).

For development, load `packages/firefox-rs/extension/manifest.json` through
`about:debugging` → **This Firefox** → **Load Temporary Add-on**. That build is
unsigned and removed on browser exit. It uses the same add-on ID, so do not
treat it and the store build as independently installed extensions.

## Future updates

Submit new versions to the existing AMO listing, retaining its ID and using
the listed distribution channel. The repository's signing workflow uses
`--channel unlisted` for self-distribution and does not update the public listing.

Broader store-install and upgrade validation remains open. Test retained
pairing, explicit sharing, optional permission prompts, browser restart and
capability negotiation in disposable Firefox/Zen profiles. Publication does
not itself establish that those checks pass on every supported platform.

Public metadata: [Mozilla add-on API](https://addons.mozilla.org/api/v5/addons/addon/callisto/).
Verified 0.3.0 archive SHA-256:
`a1f5eab7a7e141eafcd2384a1824e8133981c9c0e4e0a5f1485a097bb3633fde`.

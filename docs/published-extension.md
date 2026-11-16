# Published Firefox and Zen add-on

[Callisto Bridge (Experimental) is available on Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/callisto/).
On 16 November 2026, Mozilla's public API reports version **0.2.0** as public,
with Firefox 140+ compatibility. The downloaded XPI matches Mozilla's SHA-256
and contains Mozilla signature files. Its scripts and other assets match the
current source bytes; its manifest matches after parsing JSON. The add-on ID
remains `callisto-tab-bridge@lothnic.dev`.

Version 0.2.0 adds background agent-window controls, trusted-input binding,
run/extract helpers, snapshot continuation and network/API inspection compared
with 0.1.0. Check `callisto_capabilities` against the connected extension before
using new tools. Background concurrency remains experimentally verified only
on Zen with Linux X11.

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
Verified 0.2.0 archive SHA-256:
`27777e6c0e706f3fd57f53fcd01482ee9f00112c9b60a8bba87aaade1de83742`.

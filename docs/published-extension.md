# Published Firefox and Zen add-on

[Callisto Bridge (Experimental) is available on Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/callisto/).
On 16 November 2026, Mozilla's public API reports version **0.1.0** as public,
with Firefox 140+ compatibility. The downloaded XPI matches Mozilla's SHA-256
and contains Mozilla signature files. Its add-on ID is
`callisto-tab-bridge@lothnic.dev`, the same ID used by the current source.

The source extension is **0.2.0**. Publication of 0.1.0 does not distribute the
newer background agent-window controls, trusted-input binding, run/extract
helpers, snapshot continuation or network/API inspection. Check
`callisto_capabilities` against the connected extension before using new tools.
The add-on does not install the local Rust bridge or register an MCP host.

## Choose a build

- For the published 0.1.0 add-on, install from Mozilla Add-ons in Firefox or a
  compatible Zen build, then pair and share a tab. This is a permanent browser
  installation. The published XPI's installation, restart and upgrade behavior
  in Zen has not yet been verified here.
- For the latest source features, build the current runtime and load
  `packages/firefox-rs/extension/manifest.json` through `about:debugging` →
  **This Firefox** → **Load Temporary Add-on**. That build is unsigned and
  temporary. Verify version 0.2.0 in `about:addons`. It uses the same add-on ID;
  do not treat the store and temporary builds as independently installed
  extensions. After a browser restart, verify which version is loaded and
  reload the temporary build when testing newer features.

See [setup](getting-started.md), [background work](background-work.md) and
[browser data handling](browser-data.md). Browser access and network inspection
remain separate optional permission grants.

## Update the existing listing

Submit 0.2.0 as a new version of the existing AMO add-on, retaining its ID.
Use the listed distribution channel to update this listing. The repository's
current signing workflow uses `--channel unlisted` for self-distribution and
does not publish an update to the public listing.

Before submission, lint the extension, run its contract and browser checks,
and prepare release notes covering the new controls and optional
`webRequest`/`webRequestBlocking` permissions. Validate the upgrade from the
actual store-installed 0.1.0 in a disposable Firefox/Zen profile: retained
pairing, explicit sharing, optional permission prompts, browser restart and
capability negotiation. The published 0.1.0 is not evidence that these 0.2.0
upgrade checks pass. The current source has not been submitted by this change.

Public metadata: [Mozilla add-on API](https://addons.mozilla.org/api/v5/addons/addon/callisto/).
Verified 0.1.0 archive SHA-256:
`68c5684230a628bb75381de666efe83ad604ae4cd8c6a7b1db40e14f518c1938`.

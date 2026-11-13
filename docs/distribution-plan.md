# Unified installation and updates

This is the release plan. A shared launcher, source setup command, packaged
installer with opt-in runtime updates, packaging workflow and signing workflow
are implemented in the source tree. The installer has local transaction
tests, but compatible packages and a signed extension have not been published.
See [the implementation guide](development-installation.md). Callisto has
separate experimental Chromium and Firefox/Zen MCP backends; see the
[main setup](../README.md#get-started) and [Firefox guide](../packages/firefox-rs/README.md).

## Intended experience

1. Install one Callisto distribution containing a launcher, the Mini runtime,
   and the appropriate Rust bridge binary for the user's platform.
2. Choose Chromium or Firefox/Zen in setup. Register a stable launcher path with
   the selected MCP host, and restart its MCP servers when required.
3. Install the browser-specific extension through its supported distribution
   channel, approve its permissions, and pair once. Subsequent sessions should
   reconnect using the saved pairing, with a visible way to revoke access.
4. Deliver versioned updates to the launcher, runtime and extensions, with
   compatibility checks and a recovery path if an update fails.

The browser must still present installation and permission prompts; a single
command cannot silently install and authorize extensions in a user's existing
browser. Chromium's current connected mode also depends on the installed browse
CLI and extension, and opens an agent-owned tab rather than adopting an
existing one. Firefox's temporary add-on is removed on browser exit. The
current persistent Firefox relay pairing survives MCP and relay restarts, but
permanent extension installation and browser-restart behavior need validation.

## Work required before release

- Publish signed, versioned binaries for supported operating systems and
  architectures, plus checksums and provenance. The current Firefox relay uses
  Unix sockets and file locking; Windows support needs implementation and tests.
- Distribute signed Firefox/Zen and Chromium extensions through compatible
  browser stores or supported enterprise channels. Verify Zen compatibility,
  version migration, permission changes and extension update behavior.
- Complete published-release validation of the installer and stable launcher with explicit backend selection,
  host configuration, diagnostics and uninstall. Do not overwrite unrelated
  MCP configurations. Test upgrades and rollback from actual published releases.
- Design runtime updates with authenticated release metadata, integrity checks,
  atomic replacement and rollback; coordinate protocol versions with extension
  updates. Browser-store extension updates and runtime updates are separate.
- Improve pairing to minimize manual steps while retaining explicit user
  authorization, revocation and recovery. Review the current loopback bearer
  credential and permission model before presenting it as production-ready.
- Test fresh installation, upgrade, browser and machine restarts, host restarts,
  reconnect, removal, and real workflows on each supported platform and browser.

Until release packages and a signed extension are published and installation
and upgrade tests pass, do not describe this as a tested one-click installation
with automatic updates across both browser families.

# Callisto documentation

Callisto connects an existing agent to browser tools over a local MCP server.
Your agent supplies the model. The latest extension version is **0.3.1**,
submitted for Mozilla approval; the public listing updates after approval.
For an existing Firefox or Zen profile, install
both the add-on and the local bridge:

1. [Install Callisto Bridge from Mozilla Add-ons](https://addons.mozilla.org/en-US/firefox/addon/callisto/).
2. [Install and register the bridge](getting-started.md#install-the-firefoxzen-bridge)
   with Codex, Claude Code or OpenCode.
3. [Pair the add-on and share a website tab](getting-started.md#pair-firefox-or-zen).
   Choose [Full browser control](full-browser-control.md) when the agent should
   select, activate and create website tabs automatically.

## Setup and recovery

- [Getting started](getting-started.md): requirements, installer, manual source
  setup, host registration and Chromium alternatives.
- [Troubleshooting](getting-started.md#troubleshooting): missing pairing tools,
  disconnected runtime, host permissions, upgrades and Zen workspaces.
- [Published add-on](published-extension.md): verified store version and
  development builds.
- [Linux alpha packages](alpha-guide.md): package and verify a local bundle.

## Browser control

- [Compact tools](compact-tools.md): one default tool, on-demand contracts and
  named-tool compatibility.

- [Full browser control](full-browser-control.md): tabs, windows, permissions
  and Stop sharing.
- [Background work](background-work.md): prepare an agent window while working
  in another window, with verified platform limits.
- [Advanced Firefox/Zen runtime](zen-advanced-runtime.md): trusted input,
  observations, network inspection and private execution evidence.
- [Browser data handling](browser-data.md): shared sessions, credentials and
  permission scope.

## Runtime reference and evidence

- [Firefox/Zen tools](../packages/firefox-rs/README.md).
- [Chromium Mini](../packages/mini/README.md).
- [Host-agent evaluation](host-agent-evaluation.md).
- [Roadmap and release gates](../roadmap.md).

Firefox-protected pages, including Mozilla Add-ons and `about:` pages, are
inaccessible to the extension under default browser settings. Full control
still follows these browser restrictions.

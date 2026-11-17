# Compact Firefox/Zen tools

The Firefox/Zen runtime selects its interface per MCP client. OpenCode receives
named tools automatically; other clients receive one `callisto` tool. Its arguments
are `op` and an optional `args` object. The existing operations, browser sharing,
optional permissions, input mode, cancellation and recovery checks are unchanged.
The Chromium Mini interface is separate.

## Start and observe

```json
{"op":"status"}
{"op":"pair"}
{"op":"capabilities"}
{"op":"navigate","args":{"url":"https://example.com"}}
{"op":"snapshot","args":{"max_chars":6000}}
```

Navigation starts loading. Take a fresh snapshot before acting on its refs.
`pair` returns the local pairing code for entry into the add-on. Keep the code
out of reports. Installing this runtime does not grant additional browser access.

## Compose actions

```json
{"op":"run","args":{"steps":[{"action":"fill","ref":"ax-1","value":"search text"},{"action":"submit","ref":"ax-1"}],"snapshot":false}}
```

Use refs from the latest snapshot. `run` supports dependent actions and explicit
waits; it stops on the first failure and does not roll back earlier actions.
`extract` returns structured rows. Entire plans are validated before the first
action, and completed actions return compact page feedback. Legacy `_ref` and
`_role` actions remain accepted. Use `wait_for` instead of repeated polling.

## Discover one contract at a time

```json
{"op":"help"}
{"op":"help","args":{"op":"run"}}
{"op":"help","args":{"op":"extract"}}
{"op":"help","args":{"op":"browser"}}
```

Plain help lists operation names. Help for an operation returns its description
and `args_schema`, copied from the existing native contract. Help is local and
does not read browser content. Advanced frames, uploads, trusted input, network
inspection, trace recording and browser controls remain available on demand.
Unknown operations and malformed envelopes return errors.

## Compatibility and migration

Update the runtime and extension together, then restart the agent's MCP
connection so it reloads the catalog. New browser facilities require the updated
extension. Named tabs require the updated browser-access permission grant.
The named `callisto_*` requests remain accepted for existing integrations.

To advertise the complete named-tool catalog, set `CALLISTO_TOOL_PROFILE=full`
on the MCP server process:

```sh
CALLISTO_TOOL_PROFILE=full node scripts/callisto.mjs zen
```

Use the host's server environment settings to persist that choice. The default
is `auto`: named tools for OpenCode, compact for other clients. `native` aliases
`full`; unknown values fail explicitly. Full and compact clients can use
the same relay independently. Hosts using per-tool allowlists should retain
`full` or account for `op` when authorizing the compact tool.

Detailed guides may use the legacy name `callisto_snapshot`; its compact form
is `callisto` with `op: "snapshot"` and the same operation arguments in `args`.

## Measurement

The earlier compact-interface baseline measured 940 UTF-8 bytes versus 14,490
bytes for its 25-tool full catalog. Those are historical sizes; the current
registry contains additional operations. This is schema size, not model tokens
or billed cost. Contract help has a runtime context cost when requested, so
end-to-end usage still needs measured task trials. See the
[measurement and validation report](../eval/reports/compact-interface-2026-11-17/README.md).

## New native facilities

[Runtime improvements](native-runtime-improvements.md) describe focused snapshots,
independent diff baselines, shorter safe refs, consistent action contracts,
console/dialog capture, drag, viewport/screenshots, WebMCP and human demonstration.
Comparative benchmarks remain approval-gated; schema size alone is not a token or
cost result.

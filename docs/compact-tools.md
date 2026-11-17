# Compact Firefox/Zen tools

The Firefox/Zen runtime advertises one `callisto` tool by default. Its arguments
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
{"op":"run","args":{"steps":[{"action":"fill_ref","ref":"ax-1","value":"search text"},{"action":"submit_ref","ref":"ax-1"}],"snapshot":false}}
```

Use refs from the latest snapshot. `run` supports dependent actions and explicit
waits; it stops on the first failure and does not roll back earlier actions.
`extract` returns structured rows. Browser output is unchanged by this interface
update; choose bounded snapshots and request observations when needed.

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

Restart the agent's MCP connection after installing the new runtime so it reloads
the catalog. No add-on update is required for this schema-only change.
The named `callisto_*` requests remain accepted for existing integrations.

To advertise the complete named-tool catalog, set `CALLISTO_TOOL_PROFILE=full`
on the MCP server process:

```sh
CALLISTO_TOOL_PROFILE=full node scripts/callisto.mjs zen
```

Use the host's server environment settings to persist that choice. The default
is `compact`; other values fail explicitly. Full and compact clients can use
the same relay independently. Hosts using per-tool allowlists should retain
`full` or account for `op` when authorizing the compact tool.

Detailed guides may use the legacy name `callisto_snapshot`; its compact form
is `callisto` with `op: "snapshot"` and the same operation arguments in `args`.

## Measurement

The serialized default catalog is 940 UTF-8 bytes versus 14,490 bytes for the
25-tool full catalog: a 93.5% reduction. This is schema size, not model tokens
or billed cost. Contract help has a runtime context cost when requested, so
end-to-end usage still needs measured task trials. See the
[measurement and validation report](../eval/reports/compact-interface-2026-11-17/README.md).

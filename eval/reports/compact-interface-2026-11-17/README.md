# Compact Zen interface — 17 November 2026

The default Firefox/Zen MCP catalog now advertises one `callisto` tool. Its
envelope has `op` and optional `args`. Detailed operation contracts are loaded
on demand with `{"op":"help","args":{"op":"run"}}`.

## Deterministic catalog measurement

| Catalog | Tools | Serialized UTF-8 bytes |
| --- | ---: | ---: |
| Previous full Firefox/Zen catalog | 25 | 14,490 |
| New compact default | 1 | 940 |
| Earlier real-world trial's Zen task subset | 14 | 9,790 |
| Earlier real-world trial's browse execute subset | 1 | 2,730 |

The default is **93.5% smaller** than the complete named catalog. The earlier
trial subsets are references from a different interface selection, not a new
browse measurement. These are bytes of `JSON.stringify(tools)`, not tokenizer
counts or billed dollars. [Raw catalogs and measurements](schema.json) retain
every contract. Reproduce after building the Rust binary:

```sh
node scripts/measure-zen-catalog.mjs /tmp/new-catalog-measurement.json
```

## Behavior and compatibility

The stdio proxy advertises a per-client catalog. Help is answered locally;
execution is converted to the existing native tool name and arguments before
the existing recovery policy, relay and handlers run. No browser response is
rewritten. Sharing, permissions, full browser mode, trusted input and
cancellation retain their existing behavior. Full and compact clients can
share one relay without changing one another's catalog.

`CALLISTO_TOOL_PROFILE=full` retains all 25 named tools. Native `callisto_*`
requests remain accepted for existing integrations even in compact mode.
Hosts that authorize individual tool names should keep full mode or authorize
compact requests by operation. Invalid profile values and malformed envelopes
fail explicitly. No add-on update is needed; restart the MCP connection after
installing the runtime to refresh its tools.

## Validation

- 32 Rust tests passed, including every native contract's round trip and the
  trusted-input recovery guard.
- Six launcher checks passed. Two compact MCP integration checks and 11
  installer checks passed.
- The Firefox bridge smoke suite passed with **every tool call routed through
  the compact envelope**: observations, input, extraction, frames, browser
  control, cancellation, failed-action evidence and relay reconnect. It used
  a disposable Gecko profile; no personal tabs or pairing state were used.
- The website setup check passed all eight browser/host choices, five steps at
  four widths, copy values, focus/deep links and the no-JavaScript fallback.
- Six public-site goals passed through the compact catalog in fresh Codex host
  conversations: Wikipedia, arXiv, GitHub, PyPI, Python documentation and GOV.UK.
  The model chose its actions and returned facts plus exact observed source
  quotations. There were 36 browser calls and two recovered tool failures:
  an arXiv page-readiness timeout and a Python snapshot request above its
  allowed character limit. Used operations included help, navigate, snapshot,
  run and extract. The invalid limit illustrates the tradeoff of loading
  detailed parameter constraints on demand rather than advertising them all.

The [six-trial results](../compact-interface-2026-11-17-agent-run2/results.json)
link to visible tool traces. The
[executed harness snapshot](../compact-interface-2026-11-17-agent-run2/harness-executed.mjs)
matches the recorded `harness_sha256`. Runtime and extension hashes, model,
browser version, usage and setup details are retained in metadata. The source
revision is the parent commit because the tested changes were uncommitted.
The saved scope prose mistakenly says two repetitions; the structured settings
and six rows correctly record **one repetition, Zen only**. The current runner
now derives that prose from its actual settings; raw results are preserved.

The [initial setup failure](../compact-interface-2026-11-17-agent/run-error.json)
occurred while unnecessarily starting browse, before any model trials. The
runner was changed to provision only selected engines before the successful
run. This failure is retained and is not scored as a browser task failure.

## Limits and next experiment

This is a functional validation plus a deterministic schema-size measurement.
It is **not** a matched compact/full/browse token, latency or dollar-cost
comparison. Provider cache state differs from the earlier trials; operation
help also consumes context when requested. Saved host usage must not be used
to attribute savings to this change without a controlled experiment.

The next useful comparison alternates full and compact interfaces on the same
goals, runtime, model, input mode and budgets, records cache usage separately,
and counts help calls and errors. After that, optimize observation size: bounded
snapshots, explicit observations after action sequences and typed extraction
can reduce repeated page text. Measure each change separately while retaining
source evidence and task-success checks.

See [usage and migration](../../../docs/compact-tools.md) and the
[runner settings](../../agent-comparison/README.md).

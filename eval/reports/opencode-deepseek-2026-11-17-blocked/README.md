# OpenCode + DeepSeek V4.1 Flash Free: blocked before measured trials

**Status: blocked. 0 of 24 planned measured trials completed.**

No Callisto/Zen or browse trial results are reported here because none ran. The
OpenCode free-model quota was already exhausted for this account, so the model
tool-use preflight failed before any browser profile, task, or measured
conversation was started. Reporting zeros, partial rows, or synthetic timings
would misrepresent the result.

## Exact blocker

The first tool-using model call returned a genuine provider quota failure:

```json
{
  "type": "error",
  "error": {
    "type": "provider.free-limit",
    "message": "Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.",
    "status": 429,
    "response": {
      "body": "{\"type\":\"error\",\"error\":{\"type\":\"FreeUsageLimitError\",\"message\":\"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go\"}}"
    },
    "retryAfterMs": 60399000
  }
}
```

- Observed: `2026-11-17T07:13:21.994Z`
- Reported retry after: `60399000 ms` (~16 h 46 m 39 s), i.e. approximately
  `2026-11-18T00:00:00.994Z`
- Retried: no
- Paid, Codex, alternate-model, or other fallback: not used
- Raw event: `artifacts/preflight-tool-use-blocked.json`

This is an infrastructure quota failure, not a task failure and not evidence
that Callisto, browse, or the adapter is broken for browser work.

## What was verified before the blocker

The minimal text-only call passed and was independently checked through
`opencode session export`:

| Check | Result |
| --- | --- |
| Requested model | `opencode/deepseek-v4.1-flash-free#high` |
| Served provider / model | `opencode` / `deepseek-v4.1-flash-free` |
| Served variant | `high` |
| Final text | `OK` |
| Step usage | 3,433 uncached + 1,920 cached = 5,353 total input; 3 visible output; reported cost 0 |
| Session outcome | `succeeded` |

The tool-use preflight also confirmed the private MCP transport and native
schema path before the quota response: OpenCode logged `mcp connected
server=fixture tools=1`, the resolved configuration exposed exactly one local
MCP server with `codemode:false`, and the deny-all permission list allowed only
the single fixture action. The blocked session exported as `failed` with the
same requested model and variant and zero tokens.

A private configuration was resolved with `opencode --standalone debug config`.
It contained one document, the private temporary `opencode.json`; no global or
project MCP servers, instructions, skills, or plugins were merged in.

## Environment

| Component | Value |
| --- | --- |
| OpenCode | 2.3.0 (`latest` channel) |
| Model | `opencode/deepseek-v4.1-flash-free#high` |
| Agent | custom primary agent `benchmark` |
| Callisto runtime | 0.3.1-alpha.1 |
| Zen | 1.14.9b (Flatpak) |
| browse CLI | 0.1.0 |
| Chromium | 157.0.8103.38 (snap) |
| browse extension, pinned input | 0.0.16 (`/home/lothnic/browse-extension`) |
| browse extension, vendored fallback | 0.0.16 |
| Source HEAD | `77f57650f85ee99d635326ca6d362b9f19b9e55b` (dirty worktree) |
| Node | v26.5.0 |

The planned configuration uses `CALLISTO_TOOL_PROFILE=compact` and
`BENCH_INPUT_MODE=synthetic-dom` for Callisto; browse retains its native
Playwright input. The adapter maps the native tools to `zen_callisto` and
`browser_execute`. Neither browser fixture was started in this attempt.
The fixed title `callisto browser benchmark` and `compaction.auto=false`
prevent hidden title and summary model calls from entering measured usage.

Isolation:

- Temporary `HOME` and XDG directories with mode `0700`, outside the user's
  global OpenCode configuration.
- `--standalone`, `OPENCODE_DISABLE_PROJECT_CONFIG=1`,
  `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`.
- Inherited `OPENCODE_*` session/config state and provider API keys removed from
  the child environment.
- Empty temporary workspace; fresh conversation per trial.
- No shell, edit, read, glob, grep, webfetch, websearch, skill, subagent,
  question, external-directory, or MCP-resource permission.
- No personal browser, tabs, logins, pairing state, or credentials were used.
  The provider credential remains inside OpenCode's own auth store and was
  never read, copied, or printed.

## Planned work that remains unmeasured

The full matrix is six public read-only tasks × two engines × two repetitions:

| Task | Origin |
| --- | --- |
| wikipedia-biography | `https://en.wikipedia.org` |
| arxiv-paper | `https://arxiv.org` |
| github-issue | `https://github.com` |
| pypi-metadata | `https://pypi.org` |
| python-json | `https://docs.python.org` |
| govuk-calendar | `https://www.gov.uk` |

The small matched preflight pair (one `wikipedia-biography` run on each engine)
was planned but not started. It is not counted as an attempted trial.

Because no measured trial ran, this report makes no claim about:

- compact Callisto vs browse task accuracy, latency, or browser-call counts;
- token or cached-token efficiency;
- tool-error rates or returned-byte volume;
- browser-action quality on these six pages;
- reliability across repetitions.

## Artifacts

| File | Contents |
| --- | --- |
| `summary.json` | Machine-readable status, blocker, isolation, hashes, limits |
| `environment.json` | Host, model, runtime, extension and source evidence |
| `harness-sha256.json` | Hashes of saved harness and artifact snapshots |
| `artifacts/preflight-minimal-success.json` | Successful text-only event stream |
| `artifacts/preflight-tool-use-blocked.json` | Exact quota failure event |
| `artifacts/session-export-minimal-success.json` | Served model/variant, success |
| `artifacts/session-export-tool-use-blocked.json` | Served model/variant, failed |
| `artifacts/resolved-private-config.json` | Resolved private host config |
| `artifacts/resolved-config-documents.json` | Proof only the private config loaded |
| `artifacts/isolation-opencode.json` | Isolation config used for the probe |
| `artifacts/preflight-echo-server.mjs` | One-tool MCP transport probe |
| `artifacts/opencode-private-log-tail.txt` | MCP connect and quota log lines |
| `harness/` | Saved adapter, runner, fixtures, tasks and tests |
| `analysis/opencode-evaluation.md` | Reproduction and semantics guide |

Hashes are also in `harness-sha256.json`. Do not treat a changed hash as the
same run.

## Resume after the quota clears

Do not reuse a preflight output directory for measured work. Run the small
matched pair first, inspect the saved traces, model/variant verification,
catalog sizes and errors, then start a new phase-0 directory for the full run:

```sh
BENCH_HOST=opencode \
BENCH_ENGINES=zen,browse \
BENCH_TASKS=wikipedia-biography \
BENCH_REPETITIONS=1 \
BENCH_ZEN_TOOL_PROFILE=compact \
BENCH_INPUT_MODE=synthetic-dom \
BENCH_OUTPUT_DIR=/tmp/opencode-preflight-pair \
BROWSE_EXTENSION_PATH=/home/lothnic/browse-extension \
xvfb-run -a node eval/agent-comparison/real-world-agent.mjs
```

```sh
BENCH_HOST=opencode \
BENCH_ENGINES=zen,browse \
BENCH_REPETITIONS=2 \
BENCH_ZEN_TOOL_PROFILE=compact \
BENCH_INPUT_MODE=synthetic-dom \
BENCH_OUTPUT_DIR=/tmp/opencode-deepseek-full \
BROWSE_EXTENSION_PATH=/home/lothnic/browse-extension \
xvfb-run -a node eval/agent-comparison/real-world-agent.mjs
```

The runner runs a model preflight before browser provisioning. If the same
quota or an auth failure recurs, it must stop and write
`preflight-opencode.json` and `run-error.json`; it must not substitute another
provider or model. See `docs/opencode-evaluation.md` for the full contract.

## Parent review

The raw events and 21 historical hashes are preserved. The current adapter was
corrected after review against OpenCode 2.3.0 source: its raw input counter is
uncached, so cache reads must be added to get total input. Session model
verification now fails closed, missing reported costs stay unavailable, export
has a bounded timeout and unexpected reasoning text is filtered. The historical
harness and analysis snapshots predate these corrections; use the current
repository adapter for the next attempt. See [review notes](parent-review.md).
No additional model calls or browser trials were made during review.

## Test status

The adapter and existing harness tests are local and do not consume model
quota. The test suite covers JSON event parsing, step usage summation, quota
classification, private-environment filtering, deny-all permissions,
native-tool exposure, and resolution of the private config and custom agent.

Delegate local run on 2026-11-17: **16 of 16 passed**, 0 failed, including the
private stdio transport round trip, all six scorer checks, the calendar
year-handling cases and the real OpenCode config/agent resolution. Run:

```sh
node --test eval/agent-comparison/opencode-host.test.mjs \
  eval/agent-comparison/host-session.test.mjs \
  eval/agent-comparison/real-world-tasks.test.mjs
```

Parent review checks: **19 of 19 passed**, 0 failed. The added coverage includes
raw saved v2 usage normalization, unavailable cost and reasoning-event filtering.

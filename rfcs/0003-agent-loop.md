# RFC 0003 — Agent loop & sidecar architecture

- **Status:** Accepted
- **Phase:** 3
- **Author:** Lothnic

## Summary

The harness is a coding-agent-shaped loop with exactly two tools (bash + a JS
REPL backed by Mini), a small system prompt, single-action discipline, and a
persistent scratchpad. The loop, models, tools, and prompt live in **Python**;
Mini is **TypeScript**, so a thin **Node sidecar** hosts one Mini instance and
the harness drives it over stdio JSON-RPC.

## Why a sidecar

Mini is Node/CDP. The harness is Python (roadmap's choice, kept). Rather than
reimplement Mini in Python, the harness spawns one long-lived Node process that
owns a single `Mini` and exposes three methods. Everything browser-related is
JS the model writes into the REPL — the sidecar hardcodes no page logic.

```
harness/ (Python)  ──stdio JSON-RPC──▶  packages/mini/src/sidecar.ts
  loop · models · tools · prompt · cli     one Mini; launch · eval · close
```

## Sidecar distribution

`packages/mini` ships a CLI binary registered in `package.json`:

```json
"bin": { "callisto-sidecar": "./src/sidecar.ts" }
```

`sidecar_client.py` invokes `callisto-sidecar` from `$PATH`. No relative
paths, no env vars. Works after `npm install -g @callisto/mini`, works in CI,
works in dev with `npm link`.

## Sidecar protocol

Line-delimited JSON on stdin/stdout (one request per line, one response per
line). The process never crashes on a bad call — errors are serialized and
returned.

Requests:
```json
{ "id": "<uuid>", "method": "launch|eval|close", "params": { ... }, "v": 1 }
```

Responses (success):
```json
{ "id": "<uuid>", "ok": true, "result": { ... } }
```

Responses (error):
```json
{ "id": "<uuid>", "ok": false, "error": "<message>" }
```

The `v` field is a protocol version (currently `1`). Sidecar rejects requests
with unknown versions with `{ ok: false, error: "unsupported protocol version N" }`.

| method | params | result |
| --- | --- | --- |
| `launch` | `{ headless?, chromeFlags? }` | `{ ok: true }` |
| `eval` | `{ code }` | `{ value, truncated? }` |
| `close` | `{}` | `{ ok: true }` |

### `eval` semantics

`code` is executed as the body of an `async` function with `mini` (the live
instance) in scope. The return value is serialized and returned.

**Forbidden inside `eval`:** `mini.close()` may not be called from user code —
the sidecar owns the Mini lifecycle. Calling it from eval will return an error,
not execute.

**eval failures:** Thrown exceptions (including syntax errors and timeouts) are
caught, never propagated as sidecar crashes, and returned as:
```json
{ "id": "...", "ok": false, "error": "EvalError: <exception message>" }
```

A 60-second per-call timeout is enforced. If `eval` exceeds it, the call
returns `{ ok: false, error: "EvalTimeout: exceeded 60s" }` and the
Mini/Chrome session is considered poisoned — the sidecar will reject further
calls until `close` + `launch` is re-issued.

## Serialization policy for `eval` results

**Policy: length-capped JSON with special-case encoding.**

The return value of `eval` is serialized as follows:

1. **`Buffer` / `Uint8Array`** (e.g., `mini.screenshot()`) → base64-encoded
   string: `{ "type": "base64", "data": "<b64>" }`. The model receives the
   string; the harness re-decodes it if it needs the raw bytes.
2. **`BigInt`** → coerced to string before serialization.
3. **`undefined`** → serialized as `null`.
4. **Circular references** → serialization aborts; returns
   `{ ok: false, error: "SerializeError: circular reference" }`.
5. **Output > 100 KB** → truncated to 100 KB of JSON and returned with
   `{ value: "...", truncated: true }`. The harness surfaces the `truncated`
   flag to the model as a tool-result annotation: `[output truncated at 100KB]`.

This is pragmatic: it avoids special streaming complexity while keeping
screenshots, cookies, and snapshots usable. The 100 KB cap matches
browser-use's approach.

## The two tools (as primitives)

- **`repl(code)`** — sends `code` to the sidecar's `eval`. The model drives the
  browser by writing JS: `return (await mini.snapshot()).text`, `await
  mini.click('ax-3')`, etc. One tool, all of Mini.
- **`bash(cmd)`** — `subprocess` with a 30s timeout; returns stdout/stderr/exit.

No third tool. Ever (roadmap pitfall).

## Model abstraction

```python
class ChatModel(Protocol):
    async def chat(self, messages, tools) -> Response: ...
```

- `OpenRouterModel` — OpenAI-compatible `/chat/completions` (one endpoint, many
  models). The only live provider for now; others reachable through it later.
- `FakeModel` — returns a scripted sequence of tool calls / final text, so the
  entire loop (including recovery) is unit-tested offline with zero API cost.

## Loop

```
while not done and steps < max_steps:
    resp = await model.chat(history, tools)
    assert len(resp.tool_calls) <= 1, (
        f"Model returned {len(resp.tool_calls)} tool calls; "
        "single-action discipline violated"
    )
    if resp.tool_calls:
        call = resp.tool_calls[0]          # single-action discipline
        result = await execute(call)        # extra calls rejected, not run
        history += [call, result]
        write_scratchpad(history)
        audit_log(call, result)
    else:
        return resp.text                    # done
```

### Single-action discipline
If the model emits multiple tool calls, only the first executes; the rest get a
result telling it to take one action per turn. The assertion in the loop fires
loudly in dev/CI to catch model regressions when swapping providers. 

### Recovery hooks
- **Tool error** → re-snapshot, return "action failed; here is the new state."
- **Identical consecutive actions** → halt and surface to the user.
- **Stuck** (same observed state N turns running) → halt with explanation.
- **Sidecar died** → surface `SidecarDead` error to the user with the last
  known state; attempt one Chrome restart (see §Sidecar watchdog).

### `/ask`
A decorator that pauses for confirmation before a destructive action (submit,
purchase, send). Off by the model's say-so is not enough — the human confirms.
The `@requires_approval` decorator is applied at the tool registration site, not
at call time, so the loop can check it before dispatching.

## Sidecar watchdog and restart

`sidecar_client.py` runs a watchdog alongside the subprocess:

- **Process monitor:** if the subprocess exits unexpectedly, the client marks
  the session `dead` and raises `SidecarDead` on the next call. No silent
  retry — masking process crashes makes debugging impossible.
- **Per-call timeout:** every `call(method, params)` enforces a 60-second
  timeout. Exceeding it raises `SidecarTimeout`.
- **One-shot Chrome restart:** if Chrome dies mid-task, the client attempts to
  restart the sidecar subprocess once, then re-issues `launch`. A second death
  raises `SidecarDead` without retry. This prevents infinite restart loops.

The restart logic lives in `sidecar_client.py`, not in `loop.py`. The loop sees
`SidecarDead` and handles it like any other unrecoverable tool error.

## Context compaction

Long-running tasks will exceed the model's context window. A `compaction.py`
stub is included from day one: it truncates history to fit within a token budget
using a simple keep-last-N-turns algorithm. Richer compaction (semantic
summarisation) is Phase 4 work.

## Audit log

`loop.py` appends one JSONL record per turn to
`~/.callisto/sessions/<id>/audit.jsonl`:
```json
{ "ts": "...", "step": N, "call": { ... }, "result": { ... } }
```
Final task outcome (success/failure/error) is the last record. Zero cost to add
now; saves hours of debugging later.

## System prompt

<12K tokens. Sections: identity (3 lines), capabilities (10), workflow (20:
always snapshot first, one action per turn, retry on failure), 5–10 good/bad
examples, anti-patterns (don't write your own prompt, don't repeat a failing
action, don't invent URLs). **Does not teach Playwright** — the model knows it.

Stored as `harness/callisto/prompts/system.md` (plain Markdown). Loaded once at
startup, token-counted in CI via `test_prompt.py`. Non-Python contributors can
iterate on it without touching Python.

## Non-goals

No third tool. No multi-action turns. No model-authored prompts. No training,
no browser fork. Harness stays ~200 lines of real logic.

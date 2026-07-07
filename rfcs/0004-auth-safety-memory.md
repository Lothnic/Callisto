# RFC 0004 — Auth, safety, memory & sandbox

- **Status:** Accepted (with amendments)
- **Phase:** 4
- **Author:** Lothnic
- **Depends:** RFC 0003, RFC 0003.1
- **Amendments:** Added fail-loud autofill, macOS sandbox-exec, budget cap,
  session lifecycle audit events, honest threat model.

## Summary

Phase 4 turns the research prototype into something you can point at a real
account. Four subsystems:

1. **Credential autofill** — passwords flow through the OS keychain; the LLM
   never sees the plaintext.
2. **Approval categories** — sensitive actions (payment, send, delete, account
   change) pause for human confirmation with category-level granularity.
3. **Memory** — local SQLite + vector search. Past task summaries are retrieved
   by cosine similarity and injected into context.
4. **Sandbox** — bash tool is confined to a per-session scratch directory.
   Bubblewrap (Linux) / sandbox-exec (macOS) for filesystem + network
   isolation.

Plus: expanded audit log (model raw output, session lifecycle, budget events),
upgraded compaction (summarisation), budget cap, security test suite, and a
real SECURITY.md with an honest threat model.

---

## 1. Credential autofill

### Flow

```
Model → repl("await mini.fill('ax-12', '<password>')") ← never happens
Model → repl("__callisto_signin('github-work', 'ax-12')")  ← this instead
Harness → is_signin_call("__callisto_signin") → True (closed allowlist)
Harness → keyring.get_password("callisto", "github-work")
Harness → sidecar.eval("await mini.fill('ax-12', '<secret>')")
Harness → purge secret from message history before next model.chat()
```

### Design

- **No new tool for the model.** Instead, `signin` is a pseudo-action: the
  model emits a `repl` call containing a special marker. The harness
  intercepts it in `_execute()` before forwarding to the sidecar.
- **Marker matching: closed allowlist, not regex.** The model will hallucinate
  variations (`__callisto_signin_email`, `callisto_signin`, `__CALLISTO_SIGNIN`).
  Parse strictly:

  ```python
  SIGNIN_MARKERS = {"__callisto_signin", "__callisto_login"}  # closed set

  def is_signin_call(code: str) -> bool:
      # Exact function-name prefix match, not substring
      for marker in SIGNIN_MARKERS:
          if code.strip().startswith(marker + "("):
              return True
      return False
  ```

  Anything else is a hallucination → log + return error → model reconsiders.

- **Fail-loud on sidecar failure.** If the sidecar is dead when autofill is
  needed, raise `AutofillUnavailableError`, not fall back to bash typing the
  password. The fail-loud principle beats fail-silent.

  ```python
  try:
      await self._do_autofill(call)
  except SidecarDead:
      raise AutofillUnavailableError(
          "Sidecar offline; cannot autofill securely"
      )
  ```

- **Keychain backend:** `keyring` library (Python). Abstracts macOS Keychain,
  Linux `libsecret`, Windows Credential Manager. Service name: `"callisto"`.
- **History purge:** After typing the secret, the harness replaces the
  tool-call message in history with a redacted version. The model sees the
  fill happened but never sees the value.
- **Credential management:** `callisto creds add <id>` / `callisto creds list`
  / `callisto creds remove <id>` CLI commands.

### Files

```
harness/callisto/auth/
├── __init__.py
├── keychain.py      # keyring wrapper: get/set/delete/list
└── autofill.py      # intercept + fill + purge logic
```

---

## 2. Approval categories

### Design

Replace the flat `SENSITIVE_TOOLS` set with a category system.

**One approval mechanism.** Drop the `@requires_approval` decorator.
`check_approval()` is the single authority. Easier to reason about,
easier to test.

### Bypass risk — documented, not oversold

Regex against serialized arguments is v1-correct but bypassable. Examples:

- `bash("rm -rf /tmp/x")` — matches delete regex ✓
- `bash("curl https://x.com/api/v1/destroy")` — bypasses delete detection
- `repl("await mini.click(ref_42)")` — clicks "delete account" button, no
  approval

**SECURITY.md must explicitly state:** "Approval rules are a
defense-in-depth layer, not a guarantee. They catch obvious patterns; a
sufficiently motivated or adversarial agent can phrase around them. The
human-in-the-loop on the CLI is the actual safety boundary."

### Files

```
harness/callisto/approvals.py     # rules + checker
```

---

## 3. Memory

(Unchanged from original — see §3 above.)

---

## 4. Sandbox (bash confinement)

### Design — cross-platform

**Linux:** `bwrap` (bubblewrap)

```python
sandbox_cmd = (
    f"bwrap "
    f"--ro-bind / / "
    f"--bind {session_dir} {session_dir} "
    f"--dev /dev --proc /proc --tmpfs /tmp "
    f"--unshare-net "
    f"-- /bin/sh -c {shlex.quote(cmd)}"
)
```

**macOS:** `sandbox-exec` (deprecated but functional)

```python
sandbox_cmd = f"sandbox-exec -f {profile_path} /bin/sh -c {shlex.quote(cmd)}"
```

Profile file restricts writes to session dir, denies network.

**Fallback:** if neither `bwrap` nor `sandbox-exec` is available, bash runs
unsandboxed with a warning logged. SECURITY.md documents: "On systems
without bwrap/sandbox-exec, the bash tool runs without OS-level isolation.
Use a VM or a dedicated user account."

### What the sandbox does NOT protect

The browser session itself. Chrome has full network access and full
filesystem access. A malicious page can attempt XSS, CSRF, exfiltration.
Cookies and storage are inherited. The bash sandbox is a sideshow. The
real threat model is "agent might do dumb things," not "agent is fully
isolated."

---

## 5. Audit log expansion

### Phase 3 records
- `tool_call`, `task_end`

### New record types

| Record type | Data |
|-------------|------|
| `model_output` | Full model response |
| `approval` | call_name, category, approved (bool) |
| `autofill` | credential_id, ref (no secret) |
| `session_start` | session_id, task, timestamp |
| `session_end` | session_id, status, duration |
| `compaction` | turns_dropped, summary_used, token_savings |
| `sidecar_restart` | reason, budget_remaining |
| `budget_warning` | current_cost, budget_limit, percentage |
| `budget_exceeded` | current_cost, budget_limit |
| `memory_retrieve` | query, num_results, top_similarity |
| `memory_store` | task, summary_length |
| `error` | error_type, message, step |

Without these, post-mortem is impossible.

---

## 6. Compaction upgrade

### Changes from original

- **Trigger by token count** (>80% of model context window), not turn count.
- **Audit compaction events.** `record_compaction(turns_dropped,
  summary_used, token_savings)`. Always.
- **Scratchpad is never compacted.** It's the long-horizon memory; truncating
  it defeats its purpose. Scratchpad grows independently from model context.

---

## 7. Budget cap

### Design

Per-task cost + turn limits. 30 lines of code, saves users from surprise bills.

```
callisto run "task" --max-cost 5.00 --max-turns 100
```

- **Soft-warn at 50%** — logged, printed to stderr, model continues.
- **Hard-halt at 100%** — audit log records `budget_exceeded`, loop raises
  `BudgetExceededError`.
- **Cost estimation:** count input + output tokens from the model response,
  multiply by model's per-token price (configurable, default $3/$15 per
  million for Claude 3.5 Sonnet).

### Files

```
harness/callisto/budget.py   # BudgetTracker class
```

---

## 8. Security test suite + SECURITY.md

SECURITY.md gets an honest threat model:

**What the sandbox does NOT protect:**
- The browser session itself (full network, full cookies/storage)
- Pages visited by the agent (malicious pages can XSS, CSRF)
- Repl-based actions (clicking "delete account" needs no approval)

**What the sandbox DOES protect:**
- Bash from accessing files outside `~/.callisto/sessions/<id>/`
- Bash from making outbound network requests
- Long-running shell commands from interfering with other processes

**What approval rules catch:**
- Obvious destructive patterns in bash commands
- NOT: rephrased commands, browser-based destructive actions

**The actual safety boundary:** the human-in-the-loop on the CLI.

---

## Non-goals

- No browser-level sandbox (Chrome's own sandbox)
- No model prompt injection defence (research problem, not shipping)
- No multi-user / multi-tenant
- No remote credential storage (keychain only)

# Security Policy

Callisto drives a real browser with user credentials. Security is a
first-class concern. This document states the threat model honestly —
what is protected, what is not, and how to report issues.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use
GitHub's [private vulnerability reporting](https://github.com/Lothnic/callisto/security/advisories/new)
or email the maintainer. We aim to acknowledge within 72 hours.

---

## Threat model

The primary threat is: **the agent might do dumb things.** Callisto is not
designed to be fully isolated from the user's system. It is designed to
catch obvious mistakes and give the human a chance to intervene.

### What the sandbox DOES protect

| Asset | Mechanism | Strength |
|-------|-----------|----------|
| **Filesystem (bash only)** | bubblewrap (Linux) / sandbox-exec (macOS) confines writes to `~/.callisto/sessions/<id>/scratch/` | OS-level — strong on Linux, deprecated-but-functional on macOS |
| **Network (bash only)** | `--unshare-net` (bwrap) / `deny network*` (sandbox-exec) blocks outbound from bash | OS-level |
| **Passwords** | Keychain autofill: secrets are fetched from OS keychain, typed via sidecar, then purged from message history | Application-level — the LLM never sees the plaintext |
| **Destructive bash commands** | Approval rules match `rm -rf`, `git push`, `passwd`, etc. and pause for human confirmation | Regex-based, defense-in-depth |
| **Runaway costs** | Budget tracker with per-task `--max-cost` and `--max-turns` limits | Hard halt at limit |
| **Audit trail** | Every action, model output, approval decision, and autofill event is logged to append-only JSONL | Append-only file I/O |

### What the sandbox does NOT protect

> [!CAUTION]
> These are real, known gaps. Read them before using Callisto with
> accounts you care about.

| Gap | Why it's hard | Mitigation |
|-----|---------------|------------|
| **The browser session** | Chrome has full network access and full filesystem access (within the user's account permissions). The sidecar is not sandboxed. | Use a dedicated browser profile or a VM |
| **Pages visited by the agent** | A malicious page can attempt XSS, CSRF, exfiltration via normal HTTP. | Same as any browser user — be cautious about which sites the agent visits |
| **Cookies and storage** | The agent inherits the user's full session state for any site it visits. | Use `--headless` with a fresh profile |
| **repl-based destructive actions** | Clicking a "Delete Account" button via `repl("await mini.click('ax-42')")` requires zero approval. Approval rules only match bash commands. | The human-in-the-loop CLI prompt is the actual safety boundary |
| **Rephrased bash commands** | `curl https://x.com/api/v1/destroy` bypasses the `delete` regex. A sufficiently creative agent can phrase around any regex pattern. | Approval rules are defense-in-depth, not guarantees |
| **Prompt injection** | A malicious page could inject instructions into the snapshot that influence the agent's behavior. | Research problem — no mitigation yet |
| **macOS without sandbox-exec** | On macOS systems where `sandbox-exec` is unavailable, bash runs without OS-level isolation. | Use a VM or dedicated user account |
| **Linux without bubblewrap** | Same as above: no OS-level bash isolation without `bwrap`. | `apt install bubblewrap` |
| **Autofilled secret DOM readback** | Autofill types the secret into the field via `mini.fill`. While the sidecar redacts inputs of role `password`/`PasswordField` from snapshots, a model could evaluate arbitrary JS to read the value back (`document.querySelector('#pw').value`). | Prompt conformance and limiting eval execution |

### The actual safety boundary

**Approval rules are a defense-in-depth layer, not a guarantee.** They catch
obvious patterns; a sufficiently motivated or adversarial agent can phrase
around them.

**The human-in-the-loop on the CLI is the actual safety boundary.** When the
agent proposes a bash command, the user sees it and can approve or deny.
Everything else is a best-effort layer on top of that.

---

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  LLM (API)  │────▶│  Python loop │────▶│  Node sidecar  │
│             │     │  (harness)   │     │  (callisto-    │
│  never sees │     │              │     │   sidecar)     │
│  passwords  │     │  • approval  │     │                │
│             │     │  • budget    │     │  • Chrome CDP  │
│             │     │  • audit     │     │  • eval()      │
│             │     │  • keychain  │     │  • sandbox for │
│             │     │  • sandbox   │     │    mini.close() │
│             │     │    (bash)    │     │                │
└─────────────┘     └──────────────┘     └────────────────┘
```

---

## Credential flow

```
1. Model emits: repl("__callisto_signin('github-work', 'ax-12')")
2. Harness: is_signin_call() → True (closed allowlist)
3. Harness: keychain.get("github-work") → "s3cret!"
4. Harness: sidecar.eval("await mini.fill('ax-12', 's3cret!')")
5. Harness: purge "s3cret!" from all message history
6. Harness: audit.record_autofill("github-work", "ax-12")
7. Model never sees "s3cret!" in any subsequent context
```

---

## Scope

This policy covers the code in this repository. It does not cover:
- Chromium itself
- Model providers (OpenRouter, Anthropic, etc.)
- Third-party sites the agent visits
- The OS keychain implementation

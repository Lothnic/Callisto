# Security Policy

Callisto drives a real browser with user credentials, so security is a
first-class concern. The full threat model lands in Phase 4; this file states
the current posture and how to report issues.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use
GitHub's [private vulnerability reporting](https://github.com/Lothnic/callisto/security/advisories/new)
or email the maintainer. We aim to acknowledge within 72 hours.

## What we protect (target state, Phase 4)

- **Passwords** — resolved from the OS keychain and typed by the harness; the
  LLM never receives the secret value in its context.
- **Payment info** — every use requires explicit user approval.
- **Outbound messages / posts** — require approval before sending.
- **Filesystem** — writes confined to a per-session scratch directory.
- **Audit trail** — every action is logged to an append-only JSONL.

## What we do not protect yet

Pre-Phase-4, none of the above guarantees hold. **Do not point Callisto at
accounts you care about** until the auth/safety layer ships and this section
is updated. Treat the current build as a research prototype.

## Scope

This policy covers the code in this repository. It does not cover Chromium
itself, the model providers, or third-party sites the agent visits.

# Callisto runtime roadmap

Callisto is a lean browser runtime for existing agents. The MCP interface and
`@callisto/mini` are the product; the Python harness and evaluation tools help
develop and measure it. This is a working plan, not a claim of Playwright or
browse parity. The [original phased roadmap](docs/history/roadmap-2026.md) is
preserved for historical context.

## 1. Correctness and usable perception

- Support actions in same-origin frames and fail explicitly for cross-origin or
  otherwise inaccessible frames; expand frame coverage with regression tests.
- Bound MCP snapshots, provide continuation and targeted text search, and
  measure whether the agent can find task-relevant content. Pagination offsets
  refer to the last captured snapshot and refs can become stale as pages change.
- Strengthen actionability checks, timeouts, input handling, stale refs and
  browser cleanup. Compare their behavior with Playwright on controlled pages.
- Avoid claiming an action or security guarantee until the corresponding
  behavior is tested.

## 2. Host-agent interface

- Maintain the local stdio MCP server and test it from a real MCP client.
- Provide composable structured actions, informative errors and clear partial
  failure semantics. Evaluate a Playwright-shaped JavaScript surface separately;
  the current MCP server intentionally does not expose arbitrary host code.
- Improve packaging, setup, screenshots, navigation and multi-tab behavior.
- Extend and test the connected-browser bridge's execution lifecycle, including
  toolbar stop and take-back, focus, and broader human handoff. Connected
  navigation and input use the installed browse executor; session reset
  interruption, tab identity checks, handoff timeout and cancellation, and one
  human-confirmed fixture handoff have coverage, while toolbar take-back and
  reconnect recovery need further testing.

## 3. Evidence

- Run local controlled scenarios and separately reported live-site tasks against
  browse and Playwright. Record versions, settings, per-task outcomes and
  failures; do not infer agent success or cost from scripted MCP timings.
- Compare native snapshots for information coverage as well as size. Repeat
  trials and include authenticated workflows only when deliberately configured.
- Measure agent outcomes with the same host harness and model once the host
  integration is ready for matched tasks. A separate model API is not required
  to use the runtime.

## Decisions still open

The custom CDP engine is a hypothesis. If an equally lean agent interface over
Playwright proves more reliable at similar cost, use that evidence to choose the
backend. The BrowserOS fork under `packages/callisto-browser` remains a historical
experiment outside the runtime's critical path, with its own AGPL license and
notices; do not redistribute its outputs as if they were MIT-only.

## Path to 1.0

Callisto is currently an experimental 0.1.0 source release. The isolated
Chromium MCP runtime works, and the Rust Firefox/Zen existing-tab bridge and
separate BiDi runtime are implemented experiments. The bridge has pairing,
tab ownership, handoff and explicit stop-sharing; those features still need
broader real-browser and restart testing. Connected Chromium depends on browse.
These modes have different input and permission behavior; support for one does
not establish support for the others.

### 1. Small early-tester release

- Keep the website installer pinned to a publicly fetchable, tested revision.
  Give testers the [source setup guide](docs/getting-started.md) and a simple
  first task. Automate and verify Vercel site deployments so the live installer
  cannot silently lag behind the repository.
- Invite a small group using disposable profiles or test accounts. Record OS,
  browser, host, revision, setup failures and reproducible workflow failures;
  avoid collecting page secrets. Fix blockers before widening the group.
- Run the full CI suite on the exact release commit, including Chromium and
  Firefox bridge browser tests. Repeat setup on clean machines, including at
  least one real Zen profile; publish the tested versions and known failures.

### 2. Beta: distribution and reliability

- Choose and publish the supported OS, browser and host matrix. Verify fresh
  installs and removal on each combination. The Firefox relay currently needs a
  Unix host; Windows needs implementation and testing before it can be listed.
- Publish versioned runtime packages and checksums; validate installation,
  upgrades and rollback against actual releases. Sign and distribute the
  Firefox extension, then test pairing, extension updates and browser restarts.
- Exercise cancellation, tab ownership, take-back, reconnect, browser crashes,
  frame handling and cleanup in both automated fixtures and real profiles.
  Make partial actions and unsupported capabilities explicit to hosts.
- Review the local relay, credentials, permissions, prompt injection exposure
  and data handling. Resolve release-blocking findings and document the limits
  of user approvals and isolation.

### 3. Stable 1.0 gate

- Freeze and version the supported MCP contract, including errors, capability
  reporting, compatibility and a migration policy. Treat experimental modes as
  such until they independently meet the published support criteria.
- Require green release tests on the supported matrix, repeated clean-install
  and upgrade/rollback checks, and a sustained beta without unresolved
  release-blocking reliability or security issues. Record the evidence and
  owner for each gate in the release checklist.
- Repeat representative agent workflows with comparable task setup and publish
  successes, failures and limitations. The existing ten-task single-site
  [WebArena report](eval/reports/webarena-verified-2026-11-13/README.md) is useful
  early evidence, not a general reliability or performance guarantee.
- Publish release notes, support and vulnerability-reporting instructions, a
  deprecation policy, and a tested recovery path for each supported installation.

The [distribution plan](docs/distribution-plan.md) and
[backend parity plan](docs/backend-parity-implementation-plan.md) contain the
remaining implementation detail. The BrowserOS fork remains a separate
historical experiment with its own license and is outside the runtime release.

# Setup-only failure before Luna preflight

No measured model trial ran in this attempt. The first coordinator had already
used an unknown task ID (`wikipedia`) and stopped before provisioning; the
correct ID is `wikipedia-biography`.

After correcting that ID, the paired fixture stopped during browse setup. The
[original error](run-error.json) is preserved. Targeted owned-profile probes
under `setup-diagnostics/` identified two compatibility changes:

1. The installed store extension package omits browse's public development key.
   Loading that package unpacked gives it a different ID, rejected by the relay.
   The fixture now copies the package and adds the upstream public key only to
   that owned copy. Native extension code and installed source remain unchanged.
2. browse CLI 0.1.0 advertises `execute`, `status` and `tabs`. The old
   `session_new` tool returns an unknown-tool error. The public-site fixture now
   uses the native tab API when advertised and retains legacy session support.

The corrected isolated browse probe passed, followed by the
[successful paired Luna preflight](../luna-preflight-2026-11-17-run2/results.json).
The full measured comparison uses a separate directory; none of these setup
failures counts as a browser-task attempt or is pooled into timing/usage.

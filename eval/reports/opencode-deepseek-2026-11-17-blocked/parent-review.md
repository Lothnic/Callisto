# Parent review

No further model requests were made. The free provider's tool-use quota remains
the blocker; no browser comparison or end-to-end adapter success is claimed.

The original artifact and harness hashes all verify. Their snapshots are kept
unchanged as historical evidence; they are not the final reviewed adapter.

Corrections in the current repository adapter:

- OpenCode v2.3.0 maps raw input to non-cached input, raw output to visible output,
  and tracks cache and reasoning separately. Normalize total input by adding
  cache read/write, and total output by adding reasoning once. Retain components.
  The successful diagnostic therefore has 5,353 total input tokens, composed of
  3,433 uncached plus 1,920 cached. Derived summary metadata is corrected; raw
  events remain unchanged. This is not browser-task usage.
- Preserve missing reported costs as unavailable. OpenCode may calculate step
  costs from catalog prices when endpoint cost is absent, so these are host
  reports rather than invoices.
- Treat missing or mismatched served-model verification as infrastructure
  failure; bound session export to 10 seconds, and drain stdout on process close.
- Filter unexpected reasoning events and clean up an adapter-owned private HOME.

Version-pinned primary sources:

- [Usage mapping and cost fallback](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/core/src/session/usage.ts)
- [Total token calculation](https://github.com/anomalyco/opencode/blob/v2.3.0/packages/schema/src/token-usage.ts)

The minimal diagnostic predates the fixed-title argument. Its session export
contains more usage than its visible step stream because title-generation work
also ran. Both records are retained. The new fixed-title configuration still
needs a successful model/browser preflight to confirm the full measured path.

The existing report generator has Codex-specific prose and should not be used
unchanged for future OpenCode results. A future comparison must label the actual
host, model, variant, token semantics and all failures correctly.

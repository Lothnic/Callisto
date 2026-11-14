# Benchmark trace requirements — 2026-11-14

Scope: static inspection of official upstream code/docs and the local eval adapter. No benchmark, judge, browser session, submission, or publishing was run. Requirements below describe the pinned implementations, not a universal leaderboard submission policy.

## Revisions inspected

| Source | Pinned revision |
| --- | --- |
| WebVoyager, `MinorJerry/WebVoyager` | [`5a7896738c10bfb8b9edccce6bb0e0411f8ae569`](https://github.com/MinorJerry/WebVoyager/commit/5a7896738c10bfb8b9edccce6bb0e0411f8ae569), main; no tags returned |
| Original WebArena, `web-arena-x/webarena` | [`dce04686a56253aefba7b18a4fa0937cf1dc987b`](https://github.com/web-arena-x/webarena/commit/dce04686a56253aefba7b18a4fa0937cf1dc987b), main; do not conflate with release `v0.2.0` |
| WebArena Verified, `ServiceNow/webarena-verified` | [`6473f72db5dcefc97b5725b59e734504edc28a21`](https://github.com/ServiceNow/webarena-verified/commit/6473f72db5dcefc97b5725b59e734504edc28a21), main and tag `v1.2.3` |
| Callisto | `4e82451aac633ce204abf3f77d185ff9f197b2c2`; worktree dirty, but no diff in the inspected eval files or `harness/callisto/audit.py` |

Upstream SHAs and tag mappings were read from GitHub's official repository API on the note date. Links below pin code and documentation to those SHAs; Playwright API links are rolling documentation.

## What scoring actually consumes

| Artifact/input | WebVoyager official auto-eval | Original WebArena evaluator | WebArena Verified v1.2.3 |
| --- | --- | --- | --- |
| Screenshots | Documented judge evidence: last **k** numbered PNGs | Not a scoring input; runner embeds screenshots in review HTML | Not consumed by response/network evaluators |
| Action trajectory | `interact_messages.json` is read to extract instruction and terminal answer; intermediate actions are useful for human review | In-memory `Trajectory` is passed to evaluator; final action supplies answer | No custom action transcript required; structured response and configured network checks determine score |
| HTML render log | Not read | `render_<task_id>.html` is runner output, not evaluator input | Not read |
| Genuine Playwright trace ZIP | Not read | Saved by runner for inspection; not read by evaluator | Accepted network evidence alternative; exact parser expectations below |
| HAR | Not read | Not read | Default CLI artifact `network.har`; network evidence required by configured network evaluators |

Evidence and qualifications follow; absence of an artifact read is a conclusion from these inspected evaluator paths, not a claim about every upstream tool.

### WebVoyager

[`evaluation/auto_eval.py::auto_eval_by_gpt4v`](https://github.com/MinorJerry/WebVoyager/blob/5a7896738c10bfb8b9edccce6bb0e0411f8ae569/evaluation/auto_eval.py#L36-L95) opens `interact_messages.json`, extracts the task from message 1 using `Now given a task:…Please interact with`, and extracts the answer from the last message, requiring `Action: ANSWER`. It numerically sorts `screenshot<N>.png` and attaches the last `img_num` images. The judge receives task, answer, and images, not the complete intermediate action transcript.

The [README evaluation instructions](https://github.com/MinorJerry/WebVoyager/blob/5a7896738c10bfb8b9edccce6bb0e0411f8ae569/README.md#L158-L181) describe screenshots plus thoughts/actions for human evaluation and last-k images for automatic evaluation. The example uses 15; [`auto_eval.py::main`](https://github.com/MinorJerry/WebVoyager/blob/5a7896738c10bfb8b9edccce6bb0e0411f8ae569/evaluation/auto_eval.py#L136-L155) defaults to **1**. Pin k and judge model/prompt/settings in any comparison. The function does **not** reject an empty screenshot list: an image-free call can reach the judge, but should not be labeled faithful screenshot-based evaluation.

[`run.py::main`](https://github.com/MinorJerry/WebVoyager/blob/5a7896738c10bfb8b9edccce6bb0e0411f8ae569/run.py#L330-L350) saves screenshot files; [`utils.py::print_message`](https://github.com/MinorJerry/WebVoyager/blob/5a7896738c10bfb8b9edccce6bb0e0411f8ae569/utils.py#L304-L329) serializes messages while replacing inline image data with placeholders. Separate PNGs therefore matter. A Callisto adapter must explicitly translate message/task conventions and preserve real ordered image evidence. Neither HTML logs, HAR nor Playwright ZIPs appear in this auto-evaluator's input path.

### Original WebArena

[`run.py::test`](https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/run.py#L281-L348) builds alternating states/actions, then calls `evaluator_router(config_file)` with `trajectory`, task config, live `page`, and CDP client. [`evaluation_harness/evaluators.py`](https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/evaluation_harness/evaluators.py) implements:

- `StringEvaluator.__call__`: reads the final trajectory action's `answer`.
- `URLEvaluator.__call__`: reads `page.url`.
- `HTMLContentEvaluator.__call__`: reads live DOM/content, may navigate to target URLs, run JavaScript or invoke API helper functions. **This is not evaluation of the saved render HTML.**
- `evaluator_router` / `EvaluatorComb.__call__`: select configured evaluators and combine their scores.

[`browser_env/helper_functions.py::RenderHelper`](https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/browser_env/helper_functions.py#L113-L188) writes observation/action review HTML with optional embedded PNGs. [`ScriptBrowserEnv.setup` / `save_trace`](https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/browser_env/envs.py#L125-L225) call Playwright tracing start/stop. The main entry point [forces screenshot rendering and trace saving on](https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/run.py#L430-L438), and `test` saves `traces/<task_id>.zip` **after** scoring. Distinguish runner behavior from evaluator dependencies.

The upstream [resources guide](https://github.com/web-arena-x/webarena/blob/dce04686a56253aefba7b18a4fa0937cf1dc987b/resources/README.md) distributes HTML logs and Playwright traces for inspection. Retaining equivalent evidence is a reproducibility recommendation for our adapter; the inspected evaluator does not require those persisted files or HAR. A generic JSONL trajectory alone cannot replace the live page/environment checks.

### WebArena Verified

The pinned [usage guide](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/docs/getting_started/usage.md#L136-L168) specifies `<output_dir>/<task_id>/agent_response.json` and `network.har`. [`types/config.py::WebArenaVerifiedConfig`](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/src/webarena_verified/types/config.py#L372-L381) sets those defaults. [`__main__.py::_discover_completed_tasks`, `_load_task_log_files`, `eval_tasks`](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/src/webarena_verified/__main__.py) check both files exist and pass the trace path to evaluation. Thus the **default CLI contract requires a network file even for response-only tasks**.

At evaluator level, [`WebArenaVerifiedEvaluator._evaluate_with_context`](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/src/webarena_verified/api/internal/evaluator.py) runs every entry in `task.eval`. [`AgentResponseEvaluator._get_actual_value`](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/src/webarena_verified/core/evaluation/evaluators/agent_response_evaluator.py#L24-L48) reads the response only; [`NetworkEventEvaluator._get_actual_value`](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/src/webarena_verified/core/evaluation/evaluators/network_event_evaluator.py#L25-L80) reads recorded events. Response-only API scoring with a deliberately empty `NetworkTrace` can therefore be legitimate for a checked response-only subset and valid environment configuration; it does not establish network coverage or default CLI compatibility. `TaskEvalContext.network_trace` remains a required typed field.

[`types/tracing.py::NetworkTrace.from_content/from_har/from_playwright_trace`](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/src/webarena_verified/types/tracing.py#L186-L273) supports HAR files, Playwright ZIPs/directories, and recognized event lists. [`core/utils/network_event_utils.py::load_playwright_trace/load_har_trace/load_trace_from_content`](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/src/webarena_verified/core/utils/network_event_utils.py#L107-L231) makes the distinction concrete:

- Playwright ZIP loader reads the exact member `trace.network`, parsing JSONL `resource-snapshot` records and their `snapshot` request/response data. It does not read our tool-call JSONL.
- HAR loader expects `log.entries` and rejects empty entries. Event-list input must have recognized Playwright resource snapshots or HAR request/response entries; an arbitrary list of actions is rejected.
- To use ZIPs with the CLI, configure `trace_file_name` accordingly. A file merely named `trace.zip` proves neither parser nor Trace Viewer compatibility.

[`NetworkEvent` properties](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/src/webarena_verified/types/tracing.py#L16-L177) expose URL, method, headers/referer, status, POST data, response content and navigation classification. Capture and redaction must preserve fields used by the selected task checks. The [human agent example, `init_browser` and cleanup](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/examples/agents/human/agent.py) records HAR with embedded content and closes the context to flush it.

Documentation caveat: the pinned [evaluation-results troubleshooting checklist](https://github.com/ServiceNow/webarena-verified/blob/6473f72db5dcefc97b5725b59e734504edc28a21/docs/evaluation/evaluation_results.md#L435-L441) still says `trace.zip`. Treat that as inconsistent with the HAR default, not a second mandatory file. Code explicitly supports alternatives. No screenshot or HTML-log input is required by either evaluator class.

## Existing Callisto support and gaps

| Local evidence | Support / gap |
| --- | --- |
| [`artifacts.py::RunManifest/current_manifest`](../eval/callisto_eval/artifacts.py#L17) | Records Callisto SHA, dirty flag, model/provider, seed, versions, start time and limits. Missing benchmark/evaluator revision, dataset checksum, task revisions, browser version/config and artifact integrity/coverage. |
| [`ArtifactWriter.__init__/write_*`](../eval/callisto_eval/artifacts.py#L74) | Writes manifest/tasks/results/summary; creates only top-level `audit/`, `screenshots/`, `snapshots/`, `traces/`. No screenshot, DOM, HAR, native trace or render-log capture. Directory existence is not evidence of collection. |
| [`runner.py::run_eval`](../eval/callisto_eval/runner.py#L30) | Replaces `raw.artifacts` with three predicted audit/screenshot/snapshot paths; neither verifies existence nor retains agent-supplied links. No trace link or session-to-task mapping. Exception results have no artifact links. |
| [`agents.py::CallistoAgent`](../eval/callisto_eval/agents.py#L30), [`scorer.py::scorer_for`](../eval/callisto_eval/scorer.py#L83) | Adapter returns answer/usage, without output directory or artifact handles. Scorers implement contains/exact/regex only; naming a benchmark or declaring `benchmark_native` in the type does not invoke its evaluator. |
| [`harness/callisto/audit.py::AuditLog`](../harness/callisto/audit.py#L13), [`loop.py::run`](../harness/callisto/loop.py#L163) | JSONL model/tool events exist under `~/.callisto/sessions/<session_id>/audit.jsonl`, outside the eval output. Eval does not pass/link that session ID. `AuditLog` serializes supplied payloads; do not infer comprehensive redaction from its presence. |
| [`reports/.../evaluate.py`](../eval/reports/webarena-verified-2026-11-13/evaluate.py#L10) | Separate response-only wrapper rejects tasks with other evaluator types and explicitly supplies `NetworkTrace(..., src_file='NOT_RECORDED', events=())`. Useful narrow scoring, not recorded network evidence or general Verified integration. Not executed for this research. |

## Proposed adapter artifact manifest (design only)

Extend run provenance with benchmark/evaluator repo+SHA, dataset SHA-256, task revision, environment image/reset identity, model/judge settings (including WebVoyager k), browser/backend version and viewport. Keep secrets out of provenance. Retain per-task handles returned by the agent; link only files actually produced.

Illustrative **current generic eval adapter** task record, not an observed run:

```json
{
  "schema": "callisto.adapter-artifacts.v1",
  "task_id": "<benchmark-task-id>",
  "session_id": null,
  "artifacts": {
    "action_log": {"format": "callisto-redacted-jsonl-v1", "path": null, "state": "not_linked", "redaction_verified": false},
    "screenshots": {"paths": [], "state": "not_recorded"},
    "dom_snapshots": {"paths": [], "state": "not_recorded"},
    "render_log": {"format": "html", "path": null, "state": "not_recorded"},
    "playwright_trace": {"format": "playwright-trace-zip", "path": null, "state": "not_recorded"},
    "network_har": {"format": "har-1.2", "path": null, "state": "not_recorded"},
    "native_response": {"path": null, "state": "not_exported"}
  },
  "compatibility": {
    "webvoyager_native_input_ready": false,
    "webarena_original_live_evaluator_ready": false,
    "webarena_verified_default_cli_ready": false,
    "webarena_verified_response_only_ready": false,
    "webarena_verified_network_evidence_ready": false,
    "playwright_trace_viewer_compatible": false
  },
  "reason": "Generic adapter has no native evaluator integration or verified artifact export."
}
```

For present files add byte size, SHA-256, producer/version, capture interval, step ordering/coverage, redaction policy and validation result. Separate `input_ready` from `evaluation_executed` and evaluator score. Enable readiness only after checking the relevant pinned contract; store per-flag reasons. A response-only Verified flag requires checking **all** selected `task.eval` entries and response schema; it must not imply network or CLI readiness.

Our redacted JSONL is a **custom action/audit log**, never a Playwright trace. Genuine Playwright traces come from its recording API ([`Tracing.start/stop`](https://playwright.dev/python/docs/api/class-tracing)); [Trace Viewer](https://playwright.dev/python/docs/trace-viewer) compatibility is a separate claim from Verified's ability to extract network events. Until independently validated, keep both compatibility claims false. HAR export from another backend is feasible only with real request/response capture and the fields needed by the task evaluators; reconstructing network evidence from tool actions is insufficient.

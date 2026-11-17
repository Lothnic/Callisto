# Pinned comparative evaluation

The [17 November report](../eval/reports/step5-2026-11-17/README.md) separates public reads, owned account writes, and official WebArena Verified retrieval. It includes failed trials and setup attempts. These suites measure different interfaces and must not be pooled into one score.

## Inputs

Build Callisto from the revision recorded by each run. Use a private published Browse 0.1.1 binary and an unmodified extension built from upstream tag `v0.1.1`, commit `0d5d907d85ba4efd2ec2ea651ed594e9d8afd314`. Set absolute `BROWSE_BINARY` and `BROWSE_EXTENSION_PATH` paths. Dependency checksums and build provenance are retained in the aggregate report.

The fixtures own disposable browser profiles. They do not attach to personal tabs. Zen uses synthetic DOM input with fixture permissions pregranted; account tasks additionally enable Full browser control during preparation. This excludes permission onboarding from the measured task. Browse's extension is copied into the owned, Snap-visible profile directory, preserving extension code and the existing upstream development key.

Run model sessions serially. The report discloses the accidental public/preflight overlap; do not reproduce it. Use a new output directory for every invocation. Never overwrite or discard a failed attempt to improve a score.

## Reproduction

The commands below request the same model through the existing signed-in Codex CLI. They do not need a model API key. Codex records usage but does not independently echo an upstream served-model identifier. No fallback model is selected.

```sh
export BROWSE_BINARY=/absolute/path/to/browse-0.1.1
export BROWSE_EXTENSION_PATH=/absolute/path/to/browse-v0.1.1/dist
export BENCH_HOST_MODEL=gpt-6-luna
export BENCH_HOST_EFFORT=high

# Controlled task-tool facade, six public goals, two balanced repetitions.
BENCH_ZEN_TOOL_PROFILE=compact BENCH_HOST_INTERFACE=controlled \
BENCH_REPETITIONS=2 BENCH_OUTPUT_DIR=/tmp/new-public-run \
xvfb-run -a node eval/agent-comparison/real-world-agent.mjs
python3 eval/agent-comparison/step5-report.py /tmp/new-public-run

# Forward native initialization; three authenticated account workflows.
BENCH_REPETITIONS=2 BENCH_OUTPUT_DIR=/tmp/new-account-run \
xvfb-run -a node eval/agent-comparison/account-agent.mjs
python3 eval/agent-comparison/step5-report.py /tmp/new-account-run

# Real Shopping Admin image and official response evaluator; three goals.
BENCH_OUTPUT_DIR=/tmp/new-webarena-run \
xvfb-run -a node eval/agent-comparison/webarena-agent.mjs
python3 eval/agent-comparison/step5-report.py /tmp/new-webarena-run
```

The official runner requires the system Docker socket `/var/run/docker.sock`, `uv`, Python 3.12 and the image pinned in `webarena-fixture.mjs`. It creates one local-only container per attempt, with a unique ownership label, and removes only that container. It does not change the global Docker context. The official public fixture header login is added by a local provisioning proxy. Tasks 41, 94 and 208 are answer-evaluated retrieval tasks; the adapter refuses tasks requiring network-event evaluators. This is a small subset, not a full WebArena or BrowserGym integration or leaderboard result.

## Correctness and measurement

The public oracle requires correct facts, an observed appropriate source and an exact quote seen in browser output. Facts-only success is a secondary diagnostic. Account success requires independent server-state verification and exactly one authenticated write; the receipt task also requires its new tab to remain open. The official subset uses `webarena-verified==1.2.3`'s structural AgentResponseEvaluator, not a custom answer matcher or LLM judge. Expected answers are never put in model prompts.

Host startup, model work, navigation, retries, waits, host shutdown and independent verification are included in task elapsed time. Browser/site provisioning and initial login are recorded separately. Input, cached input, output/reasoning, returned bytes and host MCP calls remain separate. Host MCP calls include help and composition; they are not model request counts or underlying browser command counts. Billed dollars, peak RSS and isolated cold-start performance are unavailable.

The transcript audit rejects visible direct network/file access and forbidden host tools. It is a conservative audit, not an execution sandbox or proof against obfuscated JavaScript. All raw tool calls and failed calls remain in the saved traces. Exact executed harness files are archived and hashed before measured trials. Each engine's own catalog and initialization mode are saved.

OpenCode's free DeepSeek model returned HTTP 429 before browser trials. That availability result cannot establish native Code Mode performance. No multi-model result, compact/native ablation or causal before/after gain is claimed by the Luna comparison.

## Gates

```sh
node --test eval/agent-comparison/account-fixture.test.mjs \
  eval/agent-comparison/browse-extension.test.mjs \
  eval/agent-comparison/browse-fixture.test.mjs \
  eval/agent-comparison/host-session.test.mjs \
  eval/agent-comparison/opencode-host.test.mjs \
  eval/agent-comparison/real-world-settings.test.mjs \
  eval/agent-comparison/real-world-tasks.test.mjs \
  eval/agent-comparison/webarena-response.test.mjs \
  eval/agent-comparison/step5-redact.test.mjs
node eval/agent-comparison/account-fixture-browser.mjs
```

The deterministic browser gate exercises all three account workflows through UI and checks the independent oracle, before model trials. The official adapter gate confirms fabricated answers fail and unsupported evaluator types are refused. These gates do not count as measured agent trials.

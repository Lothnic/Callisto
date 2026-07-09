"""loop.py — the agent loop (RFC 0003 + RFC 0004 amendments).

while not done and steps < max_steps:
    resp = await model.chat(compact(history), tools)
    assert single-action discipline
    budget.record_turn(tokens)
    budget.check()
    if resp.tool_calls:
        [autofill interception]
        [approval check]
        result = await execute(call)
        history += [call_msg, result_msg]
        [purge secrets from history]
        write_scratchpad(history)
        audit_log.record(call, result)
    else:
        return resp.text          # done
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .approvals import check_approval
from .audit import AuditLog
from .auth.autofill import (
    AutofillUnavailableError,
    CredentialNotFoundError,
    is_signin_call,
    parse_signin_call,
    purge_secret_from_history,
)
from .budget import BudgetExceededError, BudgetTracker
from .compaction import compact
from .history import (
    assistant_tool_call_msg,
    assistant_tool_calls_msg,
    find_last_snapshot,
    prune_old_snapshots,
    result_summary,
    tool_result_msg,
    tool_summary,
    user_msg,
)
from .memory import MemoryStore
from .models import ChatModel
from .prompt import system_message
from .scratchpad import write_scratchpad
from .sidecar_client import SidecarClient, SidecarDead
from .tools import ask as ask_tool
from .tools.dispatch import TOOL_SCHEMAS, execute, tool_call_fingerprint
from .tools.repl import repl

# Re-exports for tests and callers that import from callisto.loop
__all__ = [
    "MAX_STEPS",
    "STUCK_THRESHOLD",
    "TOOL_SCHEMAS",
    "prune_old_snapshots",
    "run",
    "tool_call_fingerprint",
    "_tool_call_fingerprint",
]

log = logging.getLogger(__name__)

MAX_STEPS = 40
# Halt if the model emits the same tool call N times in a row.
STUCK_THRESHOLD = 3

# Backward-compatible private alias used by tests.
_tool_call_fingerprint = tool_call_fingerprint


async def run(
    task: str,
    model: ChatModel,
    client: SidecarClient,
    *,
    max_steps: int = MAX_STEPS,
    session_id: str | None = None,
    require_approval: bool = True,
    auto_approve: set[str] | None = None,
    budget: BudgetTracker | None = None,
    memory: MemoryStore | None = None,
    history: list[dict[str, Any]] | None = None,
    token_budget: int = 80000,
    progress_callback: Callable[[dict[str, Any]], Any] | None = None,
    verbose: bool = False,
) -> str:
    """
    Run the agent loop for `task`.

    Args:
        task:             Natural-language task description.
        model:            Any ChatModel implementation.
        client:           Started SidecarClient (caller is responsible for lifecycle).
        max_steps:        Hard cap on tool-call turns.
        session_id:       ID for the audit log. Auto-generated if None.
        require_approval: If False, skip all approval prompts (useful in tests).
        auto_approve:     Set of approval categories to skip without prompting.
        budget:           Optional BudgetTracker for cost/turn limits.
        memory:           Optional MemoryStore for past-task retrieval.

    Returns:
        The model's final text answer.

    Raises:
        RuntimeError on max_steps exceeded or stuck detection.
        SidecarDead if Chrome crashes and the restart budget is exhausted.
        BudgetExceededError if cost or turn limit is exceeded.
        AutofillUnavailableError if sidecar dies during autofill.
    """
    sid = session_id or str(uuid.uuid4())
    audit = AuditLog(sid)
    session_dir = str(Path.home() / ".callisto" / "sessions" / sid)
    budget = budget or BudgetTracker()
    t_start = time.monotonic()

    audit.record_session_start(task, getattr(model, "model", "unknown"))

    # ── Memory retrieval or continuation ────────────────────────────────
    is_new_session = history is None
    if history is None:
        history = [user_msg(task)]
    else:
        history.append(user_msg(task))

    if is_new_session and memory and memory.available:
        try:
            memories = memory.retrieve(task, k=3)
            if memories:
                context = memory.format_for_context(memories)
                if context:
                    history.insert(0, user_msg(context))
                    audit.record_memory_retrieve(
                        task,
                        len(memories),
                        memories[0].similarity if memories else 0.0,
                    )
        except Exception as exc:
            log.warning("memory retrieval failed: %s", exc)
            audit.record_error("memory_retrieve", str(exc))

    last_fingerprint: str | None = None
    consecutive_identical = 0

    for step in range(max_steps):
        # Prune older accessibility snapshots from history to save tokens and payload size
        pruned_history = prune_old_snapshots(history)

        # ── Compaction (token-count triggered) ──────────────────────────
        messages, compaction_info = await compact(
            [system_message()] + pruned_history,
            token_budget=token_budget,
            model=model,
        )
        if compaction_info:
            audit.record_compaction(
                compaction_info["turns_dropped"],
                compaction_info["summary_used"],
                compaction_info["token_savings"],
            )

        try:
            resp = await model.chat(messages, TOOL_SCHEMAS)
        except SidecarDead:
            audit.record_task_end("error", "SidecarDead mid-chat")
            raise
        except Exception as exc:
            log.error("model.chat() raised: %s", exc, exc_info=True)
            raise RuntimeError(f"model.chat() failed: {exc}") from exc

        # ── Audit model output ──────────────────────────────────────────
        audit.record_model_output({
            "text": resp.get("text", "")[:500] if resp.get("text") else None,
            "tool_calls": resp.get("tool_calls"),
        })

        if verbose:
            import click
            if resp.get("text"):
                click.echo(click.style(f"\n[thought] {resp['text']}", fg="cyan"))

        # ── Budget tracking ─────────────────────────────────────────────
        resp_json = json.dumps(resp, default=str)
        input_tokens = sum(len(json.dumps(m)) for m in messages) // 4
        output_tokens = len(resp_json) // 4
        budget.record_turn(input_tokens, output_tokens)

        try:
            warning = budget.check()
            if warning == "warning":
                audit.record_budget_warning(
                    budget.total_cost, budget.max_cost, budget.cost_percentage,
                )
        except BudgetExceededError as exc:
            audit.record_budget_exceeded(budget.total_cost, budget.max_cost)
            audit.record_task_end("error", str(exc))
            raise

        # ── No tool call → done ─────────────────────────────────────────
        if not resp["tool_calls"]:
            final = resp["text"] or ""

            if not final:
                try:
                    snap = await repl(
                        "return (await page.accessibility.snapshot()).text", client
                    )
                    snap_text = snap.get("value", "") or ""
                    if snap_text:
                        final = snap_text[:2000]
                    else:
                        final = "Task completed."
                except Exception:
                    final = "Task completed."

            log.info("step %d: no tool calls, final text=%.100r", step, final)
            audit.record_task_end("success", final[:500])

            if memory and memory.available:
                try:
                    memory.store(task, final[:500])
                    audit.record_memory_store(task, len(final))
                except Exception as exc:
                    log.warning("memory store failed: %s", exc)

            duration_s = time.monotonic() - t_start
            audit.record_session_end("success", duration_s)

            history.append({"role": "assistant", "content": final})
            if progress_callback:
                res = progress_callback({"type": "final", "text": final})
                if asyncio.iscoroutine(res):
                    await res
            return final

        # ── Single-action discipline ────────────────────────────────────
        tool_calls = resp["tool_calls"]
        if len(tool_calls) > 5:
            log.warning(
                "model returned %d tool calls at step %d; truncating to 5 to prevent payload bloat",
                len(tool_calls), step,
            )
            tool_calls = tool_calls[:5]

        call = tool_calls[0]
        log.info("step %d: %s(%s)", step, call["name"], list(call["arguments"].keys()))
        if len(tool_calls) > 1:
            log.warning(
                "model returned %d tool calls at step %d; violating single-action discipline",
                len(tool_calls), step,
            )

        if verbose:
            import click
            click.echo(click.style(
                f"  [tool call] {call['name']}({json.dumps(call['arguments'], indent=2)})",
                fg="yellow",
            ))

        step_info = tool_summary(call)
        if progress_callback:
            res = progress_callback({
                "type": "step_start",
                "step": step,
                "call": call,
                "summary": step_info,
            })
            if asyncio.iscoroutine(res):
                await res

        # ── Stuck detection ─────────────────────────────────────────────
        fp = tool_call_fingerprint(call)
        if fp == last_fingerprint:
            consecutive_identical += 1
            if consecutive_identical >= STUCK_THRESHOLD:
                msg = (
                    f"Agent appears stuck: the same action "
                    f"'{call['name']}' was repeated {consecutive_identical} times."
                )
                audit.record_task_end("failure", msg)
                audit.record_session_end("failure", time.monotonic() - t_start)
                raise RuntimeError(msg)
        else:
            consecutive_identical = 0
        last_fingerprint = fp

        # ── Approval check (category-based) ─────────────────────────────
        if require_approval:
            last_snap = find_last_snapshot(history)
            rule = check_approval(
                call, auto_approve=auto_approve, last_snapshot_text=last_snap
            )
            if rule is not None:
                args_preview = json.dumps(call["arguments"])[:200]
                prompt = (
                    f"[{rule.category}] {rule.message}\n"
                    f"  {call['name']}({args_preview})"
                )
                confirmed = await ask_tool.ask(prompt)
                audit.record_approval(call["name"], rule.category, confirmed)
                if not confirmed:
                    denied_msg = tool_result_msg(
                        call["id"], {"error": "User denied this action."}
                    )
                    history.append(assistant_tool_call_msg(call))
                    history.append(denied_msg)
                    write_scratchpad(history)
                    continue

        # ── Execute ─────────────────────────────────────────────────────
        t0 = time.monotonic()
        autofill_credential_id: str | None = None

        try:
            code = call.get("arguments", {}).get("code", "")
            if call["name"] == "repl" and is_signin_call(code):
                parsed = parse_signin_call(code)
                autofill_credential_id = parsed[0] if parsed else None

            result = await execute(call, client, audit, session_dir=session_dir)

        except (AutofillUnavailableError, CredentialNotFoundError) as exc:
            log.warning("autofill failed: %s", exc)
            audit.record_error(type(exc).__name__, str(exc))
            result = {"error": str(exc)}

        except SidecarDead as exc:
            log.warning("sidecar died during tool call: %s", exc)
            try:
                audit.record_sidecar_restart(str(exc), client._restart_budget)
                await client.maybe_restart()
                result = {
                    "error": (
                        "Browser process crashed and was restarted. "
                        "All page state was lost. "
                        "Please navigate back to the page and continue."
                    )
                }
            except Exception as restart_exc:
                log.error("sidecar restart failed: %s", restart_exc)
                audit.record_task_end(
                    "error", f"Sidecar crash + restart failed: {restart_exc}"
                )
                audit.record_session_end("error", time.monotonic() - t_start)
                raise SidecarDead(
                    f"Sidecar crashed and restart failed: {restart_exc}"
                ) from exc

        except Exception as exc:  # noqa: BLE001
            result = {"error": str(exc)}

        duration_ms = (time.monotonic() - t0) * 1000
        audit.record_tool_call(
            {"name": call["name"], "arguments": call["arguments"]},
            result,
            duration_ms,
        )

        if verbose:
            import click
            res_str = json.dumps(result, indent=2)
            if "error" in result:
                click.echo(click.style(f"  [result] Error: {result['error']}", fg="red"))
            else:
                if len(res_str) > 2000:
                    res_str = res_str[:2000] + "\n... (truncated)"
                click.echo(click.style(f"  [result] Success:\n{res_str}", fg="green"))

        if progress_callback:
            res = progress_callback({
                "type": "step_end",
                "step": step,
                "result": result,
                "summary": result_summary(result),
            })
            if asyncio.iscoroutine(res):
                await res

        history.append(assistant_tool_calls_msg(tool_calls))
        history.append(tool_result_msg(call["id"], result))

        for extra in tool_calls[1:]:
            history.append(tool_result_msg(extra["id"], {
                "error": (
                    "Single-action discipline violated. Only one action per turn "
                    "is permitted. This tool call was not executed."
                )
            }))

        if autofill_credential_id:
            purge_secret_from_history(history, autofill_credential_id)

        write_scratchpad(history)

    msg = f"Agent did not finish within {max_steps} steps."
    audit.record_task_end("failure", msg)
    audit.record_session_end("failure", time.monotonic() - t_start)
    if progress_callback:
        res = progress_callback({"type": "final", "text": f"Error: {msg}"})
        if asyncio.iscoroutine(res):
            await res
    raise RuntimeError(msg)

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
from typing import Any

from .approvals import ApprovalRule, check_approval
from .audit import AuditLog
from .auth.autofill import (
    AutofillUnavailableError,
    CredentialNotFoundError,
    do_autofill,
    is_signin_call,
    purge_secret_from_history,
    parse_signin_call,
)
from .budget import BudgetExceededError, BudgetTracker
from .compaction import compact
from .memory import MemoryStore
from .models import ChatModel, ToolCall
from .prompt import system_message
from .scratchpad import write_scratchpad
from .sidecar_client import SidecarClient, SidecarDead
from .tools import ask as ask_tool
from .tools.bash import bash
from .tools.repl import repl

log = logging.getLogger(__name__)

MAX_STEPS = 40
# Halt if the model emits the same tool call N times in a row.
STUCK_THRESHOLD = 3

# ---------------------------------------------------------------------------
# Tool definitions (sent to the model as JSON schema)
# ---------------------------------------------------------------------------

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "repl",
            "description": (
                "Execute JavaScript in the live browser session. "
                "Playwright-shaped `page` is in scope. Return a value with `return ...`. "
                "Example: return (await page.accessibility.snapshot()).text"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "JS code to execute."}
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": (
                "Run a shell command (30-second timeout). "
                "Returns stdout, stderr, exit_code."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "cmd": {"type": "string", "description": "Shell command to execute."}
                },
                "required": ["cmd"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "repo.exec",
            "description": "Execute a shell command in the workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "cmd": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Command and arguments to run.",
                    }
                },
                "required": ["cmd"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Tool dispatch
# ---------------------------------------------------------------------------

async def _execute(
    call: ToolCall,
    client: SidecarClient,
    audit: AuditLog,
    session_dir: str = "",
) -> dict[str, Any]:
    """Dispatch a ToolCall and return the raw result dict."""
    if call["name"] == "repl":
        code = call["arguments"].get("code", "")

        # ── Autofill interception (closed allowlist) ────────────────────
        if is_signin_call(code):
            return await do_autofill(code, client, audit)

        return await repl(code, client)

    if call["name"] == "bash":
        return await bash(call["arguments"].get("cmd", ""), session_dir=session_dir)

    if call["name"] == "repo.exec":
        cmd_arg = call["arguments"].get("cmd", "")
        if isinstance(cmd_arg, list):
            if len(cmd_arg) >= 3 and cmd_arg[0] == "bash" and cmd_arg[1] in ("-c", "-lc"):
                cmd_str = cmd_arg[2]
            else:
                cmd_str = " ".join(cmd_arg)
        else:
            cmd_str = str(cmd_arg)
        return await bash(cmd_str, session_dir=session_dir)

    return {"error": f"unknown tool: {call['name']}"}


def _tool_call_fingerprint(call: ToolCall) -> str:
    """Stable string representation for stuck-loop detection."""
    return f"{call['name']}:{json.dumps(call['arguments'], sort_keys=True)}"


# ---------------------------------------------------------------------------
# Message helpers (OpenAI message format)
# ---------------------------------------------------------------------------

def _assistant_tool_call_msg(call: ToolCall) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": call["id"],
                "type": "function",
                "function": {
                    "name": call["name"],
                    "arguments": json.dumps(call["arguments"]),
                },
            }
        ],
    }


def _assistant_tool_calls_msg(calls: list[ToolCall]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": c["id"],
                "type": "function",
                "function": {
                    "name": c["name"],
                    "arguments": json.dumps(c["arguments"]) if not isinstance(c["arguments"], str) else c["arguments"],
                },
            }
            for c in calls
        ],
    }


def _tool_result_msg(call_id: str, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "content": json.dumps(result),
    }


def _shorten(text: str, limit: int = 240) -> str:
    text = " ".join(text.strip().split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _code_summary(code: str) -> str:
    if "page.accessibility.snapshot" in code:
        return "Snapshot page" if "diff" not in code else "Snapshot page diff"
    if "page.goto" in code:
        return _shorten(code, 120)
    if ".click(" in code:
        return _shorten(code, 120)
    if ".fill(" in code:
        return _shorten(code, 120)
    if "page.evaluate" in code:
        return "Evaluate page script"
    if is_signin_call(code):
        return "Secure credential autofill"
    return _shorten(code, 120) or "Run JavaScript"


def _tool_summary(call: ToolCall) -> dict[str, str]:
    name = call["name"]
    args = call.get("arguments", {})
    if name == "repl":
        code = str(args.get("code", "")) if isinstance(args, dict) else ""
        return {"title": _code_summary(code), "detail": _shorten(code, 500)}
    if name == "bash":
        cmd = str(args.get("cmd", "")) if isinstance(args, dict) else ""
        return {"title": f"Run shell: {_shorten(cmd, 80)}", "detail": _shorten(cmd, 500)}
    return {"title": f"Run {name}", "detail": _shorten(json.dumps(args, default=str), 500)}


def _agent_signal_lines(value: Any) -> list[str]:
    if not isinstance(value, str):
        return []
    return [line for line in value.splitlines() if line.startswith("[Agent signal:")]


def _result_summary(result: dict[str, Any]) -> dict[str, Any]:
    if "error" in result:
        return {"ok": False, "title": "Error", "detail": _shorten(str(result["error"]), 500)}

    value = result.get("value")
    signals = _agent_signal_lines(value)
    if signals:
        return {"ok": True, "title": signals[0], "detail": "\n".join(signals[:5])}

    if isinstance(value, str):
        lines = [line for line in value.splitlines() if line.strip()]
        ref_count = value.count("[ax-")
        if ref_count:
            return {
                "ok": True,
                "title": f"Snapshot: {ref_count} refs, {len(lines)} lines",
                "detail": "\n".join(lines[:12]),
            }
        return {"ok": True, "title": _shorten(value, 120) or "Success", "detail": _shorten(value, 1000)}

    if value is None:
        return {"ok": True, "title": "Action completed", "detail": ""}

    return {
        "ok": True,
        "title": "Success",
        "detail": _shorten(json.dumps(value, default=str), 1000),
    }



def _user_msg(content: str) -> dict[str, Any]:
    return {"role": "user", "content": content}


def _find_last_snapshot(history: list[dict[str, Any]]) -> str | None:
    """Find the most recent accessibility snapshot in the conversation history."""
    for msg in reversed(history):
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            if not content:
                continue
            try:
                data = json.loads(content)
                val = data.get("value")
                # If it's a string containing accessibility refs, it's our snapshot
                if isinstance(val, str) and "[ax-" in val:
                    return val
            except Exception:
                pass
    return None


def prune_old_snapshots(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Find all tool result messages containing accessibility snapshots.
    Keep only the most recent one intact, and replace all older ones with a brief
    placeholder to save tokens and avoid HTTP 413 Payload Too Large.
    """
    pruned = []
    snapshot_count = 0
    # Count how many snapshot results are in the history
    for msg in history:
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            if "[ax-" in content:
                snapshot_count += 1

    seen_snapshots = 0
    for msg in history:
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            if "[ax-" in content:
                seen_snapshots += 1
                # If this is not the last snapshot, prune its contents
                if seen_snapshots < snapshot_count:
                    try:
                        data = json.loads(content)
                        orig_val = data.get("value", "")
                        orig_len = len(orig_val) if isinstance(orig_val, str) else 0
                        data["value"] = f"[Accessibility tree snapshot pruned for brevity ({orig_len} chars)]"
                        pruned.append({
                            "role": "tool",
                            "tool_call_id": msg["tool_call_id"],
                            "content": json.dumps(data),
                        })
                        continue
                    except Exception:
                        pass
        pruned.append(msg)
    return pruned


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

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
        history = [_user_msg(task)]
    else:
        history.append(_user_msg(task))

    if is_new_session and memory and memory.available:
        try:
            memories = memory.retrieve(task, k=3)
            if memories:
                context = memory.format_for_context(memories)
                if context:
                    history.insert(0, _user_msg(context))
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
        # Rough token estimate from response size
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

            # If the model returned empty text, try to snapshot the page
            if not final:
                try:
                    snap = await repl("return (await page.accessibility.snapshot()).text", client)
                    snap_text = snap.get("value", "") or ""
                    if snap_text and "[ax-" in snap_text:
                        final = snap_text[:2000]
                    elif snap_text:
                        final = snap_text[:2000]
                    else:
                        final = "Task completed."
                except Exception:
                    final = "Task completed."

            log.info("step %d: no tool calls, final text=%.100r", step, final)
            audit.record_task_end("success", final[:500])

            # Store to memory on success
            if memory and memory.available:
                try:
                    memory.store(task, final[:500])
                    audit.record_memory_store(task, len(final))
                except Exception as exc:
                    log.warning("memory store failed: %s", exc)

            duration_s = time.monotonic() - t_start
            audit.record_session_end("success", duration_s)
            
            # Append final message to history to preserve assistant response
            history.append({"role": "assistant", "content": final})
            if progress_callback:
                res = progress_callback({"type": "final", "text": final})
                if asyncio.iscoroutine(res):
                    await res
            return final

        # ── Single-action discipline ────────────────────────────────────
        # If the model returns multiple tool calls, we execute only the first one
        # and return errors for the others to maintain single-action discipline.
        tool_calls = resp["tool_calls"]
        if len(tool_calls) > 5:
            log.warning(
                "model returned %d tool calls at step %d; truncating to 5 to prevent payload bloat",
                len(tool_calls), step
            )
            tool_calls = tool_calls[:5]

        call = tool_calls[0]
        log.info("step %d: %s(%s)", step, call["name"], list(call["arguments"].keys()))
        if len(tool_calls) > 1:
            log.warning(
                "model returned %d tool calls at step %d; violating single-action discipline",
                len(tool_calls), step
            )

        if verbose:
            import click
            click.echo(click.style(f"  [tool call] {call['name']}({json.dumps(call['arguments'], indent=2)})", fg="yellow"))

        step_info = _tool_summary(call)
        if progress_callback:
            res = progress_callback({"type": "step_start", "step": step, "call": call, "summary": step_info})
            if asyncio.iscoroutine(res):
                await res

        # ── Stuck detection ─────────────────────────────────────────────
        fp = _tool_call_fingerprint(call)
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
            last_snap = _find_last_snapshot(history)
            rule = check_approval(call, auto_approve=auto_approve, last_snapshot_text=last_snap)
            if rule is not None:
                args_preview = json.dumps(call["arguments"])[:200]
                prompt = (
                    f"[{rule.category}] {rule.message}\n"
                    f"  {call['name']}({args_preview})"
                )
                confirmed = await ask_tool.ask(prompt)
                audit.record_approval(call["name"], rule.category, confirmed)
                if not confirmed:
                    denied_msg = _tool_result_msg(
                        call["id"], {"error": "User denied this action."}
                    )
                    history.append(_assistant_tool_call_msg(call))
                    history.append(denied_msg)
                    write_scratchpad(history)
                    continue

        # ── Execute ─────────────────────────────────────────────────────
        t0 = time.monotonic()
        autofill_credential_id: str | None = None

        try:
            # Check for autofill before execution
            code = call.get("arguments", {}).get("code", "")
            if call["name"] == "repl" and is_signin_call(code):
                parsed = parse_signin_call(code)
                autofill_credential_id = parsed[0] if parsed else None

            result = await _execute(call, client, audit, session_dir=session_dir)

        except (AutofillUnavailableError, CredentialNotFoundError) as exc:
            # Autofill-specific failures: return error to model, do NOT fall back
            log.warning("autofill failed: %s", exc)
            audit.record_error(type(exc).__name__, str(exc))
            result = {"error": str(exc)}

        except SidecarDead as exc:
            log.warning("sidecar died during tool call: %s", exc)
            try:
                # Attempt to restart the sidecar
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
                audit.record_task_end("error", f"Sidecar crash + restart failed: {restart_exc}")
                audit.record_session_end("error", time.monotonic() - t_start)
                raise SidecarDead(f"Sidecar crashed and restart failed: {restart_exc}") from exc

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
            res = progress_callback({"type": "step_end", "step": step, "result": result, "summary": _result_summary(result)})
            if asyncio.iscoroutine(res):
                await res

        history.append(_assistant_tool_calls_msg(tool_calls))
        history.append(_tool_result_msg(call["id"], result))

        for extra in tool_calls[1:]:
            history.append(_tool_result_msg(extra["id"], {
                "error": "Single-action discipline violated. Only one action per turn is permitted. This tool call was not executed."
            }))

        # ── Purge secrets from history after autofill ───────────────────
        if autofill_credential_id:
            purge_secret_from_history(history, autofill_credential_id)

        write_scratchpad(history)

    # max_steps exceeded
    msg = f"Agent did not finish within {max_steps} steps."
    audit.record_task_end("failure", msg)
    audit.record_session_end("failure", time.monotonic() - t_start)
    if progress_callback:
        res = progress_callback({"type": "final", "text": f"Error: {msg}"})
        if asyncio.iscoroutine(res):
            await res
    raise RuntimeError(msg)

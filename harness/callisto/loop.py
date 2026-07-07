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
                "`mini` is in scope. Return a value with `return ...`. "
                "Example: return (await mini.snapshot()).text"
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


def _tool_result_msg(call_id: str, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "content": json.dumps(result),
    }


def _user_msg(content: str) -> dict[str, Any]:
    return {"role": "user", "content": content}


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

    # ── Memory retrieval at task start ──────────────────────────────────
    history: list[dict[str, Any]] = [_user_msg(task)]
    if memory and memory.available:
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
        # ── Compaction (token-count triggered) ──────────────────────────
        messages, compaction_info = await compact(
            [system_message()] + history,
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

        # ── Audit model output ──────────────────────────────────────────
        audit.record_model_output({
            "text": resp.get("text", "")[:500] if resp.get("text") else None,
            "tool_calls": [
                {"name": tc["name"], "arguments": tc["arguments"]}
                for tc in resp.get("tool_calls", [])
            ],
        })

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

        # ── Single-action discipline ────────────────────────────────────
        assert len(resp["tool_calls"]) <= 1, (
            f"Model returned {len(resp['tool_calls'])} tool calls at step {step}; "
            "single-action discipline violated"
        )

        # ── No tool call → done ─────────────────────────────────────────
        if not resp["tool_calls"]:
            final = resp["text"] or ""
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
            return final

        call = resp["tool_calls"][0]
        log.info("step %d: %s(%s)", step, call["name"], list(call["arguments"].keys()))

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
            rule = check_approval(call, auto_approve=auto_approve)
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
            audit.record_task_end("error", str(exc))
            audit.record_session_end("error", time.monotonic() - t_start)
            raise

        except Exception as exc:  # noqa: BLE001
            result = {"error": str(exc)}

        duration_ms = (time.monotonic() - t0) * 1000
        audit.record_tool_call(
            {"name": call["name"], "arguments": call["arguments"]},
            result,
            duration_ms,
        )

        history.append(_assistant_tool_call_msg(call))
        history.append(_tool_result_msg(call["id"], result))

        # ── Purge secrets from history after autofill ───────────────────
        if autofill_credential_id:
            purge_secret_from_history(history, autofill_credential_id)

        write_scratchpad(history)

    # max_steps exceeded
    msg = f"Agent did not finish within {max_steps} steps."
    audit.record_task_end("failure", msg)
    audit.record_session_end("failure", time.monotonic() - t_start)
    raise RuntimeError(msg)

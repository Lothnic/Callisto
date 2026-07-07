"""loop.py — the agent loop (RFC 0003).

while not done and steps < max_steps:
    resp = await model.chat(compact(history), tools)
    assert single-action discipline
    if resp.tool_calls:
        [approval check]
        result = await execute(call)
        history += [call_msg, result_msg]
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
from typing import Any

from .audit import AuditLog
from .compaction import compact
from .models import ChatModel, ToolCall
from .prompt import system_message
from .scratchpad import write_scratchpad
from .sidecar_client import SidecarClient, SidecarDead
from .tools import SENSITIVE_TOOLS
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
) -> dict[str, Any]:
    """Dispatch a ToolCall and return the raw result dict."""
    if call["name"] == "repl":
        return await repl(call["arguments"].get("code", ""), client)
    if call["name"] == "bash":
        return await bash(call["arguments"].get("cmd", ""))
    return {"error": f"unknown tool: {call['name']}"}


def _needs_approval(call: ToolCall) -> bool:
    return call["name"] in SENSITIVE_TOOLS


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

    Returns:
        The model's final text answer.

    Raises:
        RuntimeError on max_steps exceeded or stuck detection.
        SidecarDead if Chrome crashes and the restart budget is exhausted.
    """
    sid = session_id or str(uuid.uuid4())
    audit = AuditLog(sid)

    history: list[dict[str, Any]] = [_user_msg(task)]
    last_fingerprint: str | None = None
    consecutive_identical = 0

    for step in range(max_steps):
        messages = compact([system_message()] + history)

        try:
            resp = await model.chat(messages, TOOL_SCHEMAS)
        except SidecarDead:
            audit.record_task_end("error", "SidecarDead mid-chat")
            raise

        # ── Single-action discipline ────────────────────────────────────────
        assert len(resp["tool_calls"]) <= 1, (
            f"Model returned {len(resp['tool_calls'])} tool calls at step {step}; "
            "single-action discipline violated"
        )

        # ── No tool call → done ─────────────────────────────────────────────
        if not resp["tool_calls"]:
            final = resp["text"] or ""
            audit.record_task_end("success", final[:500])
            return final

        call = resp["tool_calls"][0]
        log.info("step %d: %s(%s)", step, call["name"], list(call["arguments"].keys()))

        # ── Stuck detection ─────────────────────────────────────────────────
        fp = _tool_call_fingerprint(call)
        if fp == last_fingerprint:
            consecutive_identical += 1
            if consecutive_identical >= STUCK_THRESHOLD:
                msg = (
                    f"Agent appears stuck: the same action "
                    f"'{call['name']}' was repeated {consecutive_identical} times."
                )
                audit.record_task_end("failure", msg)
                raise RuntimeError(msg)
        else:
            consecutive_identical = 0
        last_fingerprint = fp

        # ── Approval check ──────────────────────────────────────────────────
        if require_approval and _needs_approval(call):
            args_preview = json.dumps(call["arguments"])[:200]
            confirmed = await ask_tool.ask(f"{call['name']}({args_preview})")
            if not confirmed:
                denied_msg = _tool_result_msg(call["id"], {"error": "User denied this action."})
                history.append(_assistant_tool_call_msg(call))
                history.append(denied_msg)
                write_scratchpad(history)
                continue

        # ── Execute ─────────────────────────────────────────────────────────
        t0 = time.monotonic()
        try:
            result = await _execute(call, client)
        except SidecarDead as exc:
            log.warning("sidecar died during tool call: %s", exc)
            audit.record_task_end("error", str(exc))
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
        write_scratchpad(history)

    # max_steps exceeded
    msg = f"Agent did not finish within {max_steps} steps."
    audit.record_task_end("failure", msg)
    raise RuntimeError(msg)

"""Conversation history helpers: OpenAI message shapes, snapshot pruning, UI summaries."""
from __future__ import annotations

import json
from typing import Any

from .auth.autofill import is_signin_call
from .models import ToolCall


def assistant_tool_call_msg(call: ToolCall) -> dict[str, Any]:
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


def assistant_tool_calls_msg(calls: list[ToolCall]) -> dict[str, Any]:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": c["id"],
                "type": "function",
                "function": {
                    "name": c["name"],
                    "arguments": (
                        json.dumps(c["arguments"])
                        if not isinstance(c["arguments"], str)
                        else c["arguments"]
                    ),
                },
            }
            for c in calls
        ],
    }


def tool_result_msg(call_id: str, result: dict[str, Any]) -> dict[str, Any]:
    return {
        "role": "tool",
        "tool_call_id": call_id,
        "content": json.dumps(result),
    }


def user_msg(content: str) -> dict[str, Any]:
    return {"role": "user", "content": content}


def shorten(text: str, limit: int = 240) -> str:
    text = " ".join(text.strip().split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def code_summary(code: str) -> str:
    if "page.accessibility.snapshot" in code:
        return "Snapshot page" if "diff" not in code else "Snapshot page diff"
    if "page.goto" in code:
        return shorten(code, 120)
    if ".click(" in code:
        return shorten(code, 120)
    if ".fill(" in code:
        return shorten(code, 120)
    if "page.evaluate" in code:
        return "Evaluate page script"
    if is_signin_call(code):
        return "Secure credential autofill"
    return shorten(code, 120) or "Run JavaScript"


def tool_summary(call: ToolCall) -> dict[str, str]:
    name = call["name"]
    args = call.get("arguments", {})
    if name == "repl":
        code = str(args.get("code", "")) if isinstance(args, dict) else ""
        return {"title": code_summary(code), "detail": shorten(code, 500)}
    if name == "bash":
        cmd = str(args.get("cmd", "")) if isinstance(args, dict) else ""
        return {"title": f"Run shell: {shorten(cmd, 80)}", "detail": shorten(cmd, 500)}
    return {
        "title": f"Run {name}",
        "detail": shorten(json.dumps(args, default=str), 500),
    }


def agent_signal_lines(value: Any) -> list[str]:
    if not isinstance(value, str):
        return []
    return [line for line in value.splitlines() if line.startswith("[Agent signal:")]


def result_summary(result: dict[str, Any]) -> dict[str, Any]:
    if "error" in result:
        return {
            "ok": False,
            "title": "Error",
            "detail": shorten(str(result["error"]), 500),
        }

    value = result.get("value")
    signals = agent_signal_lines(value)
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
        return {
            "ok": True,
            "title": shorten(value, 120) or "Success",
            "detail": shorten(value, 1000),
        }

    if value is None:
        return {"ok": True, "title": "Action completed", "detail": ""}

    return {
        "ok": True,
        "title": "Success",
        "detail": shorten(json.dumps(value, default=str), 1000),
    }


def find_last_snapshot(history: list[dict[str, Any]]) -> str | None:
    """Find the most recent accessibility snapshot in the conversation history."""
    for msg in reversed(history):
        if msg.get("role") == "tool":
            content = msg.get("content", "")
            if not content:
                continue
            try:
                data = json.loads(content)
                val = data.get("value")
                if isinstance(val, str) and "[ax-" in val:
                    return val
            except Exception:
                pass
    return None


def prune_old_snapshots(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Keep only the most recent accessibility snapshot intact; replace older ones
    with a short placeholder to save tokens and avoid HTTP 413.
    """
    pruned: list[dict[str, Any]] = []
    snapshot_count = 0
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
                if seen_snapshots < snapshot_count:
                    try:
                        data = json.loads(content)
                        orig_val = data.get("value", "")
                        orig_len = len(orig_val) if isinstance(orig_val, str) else 0
                        data["value"] = (
                            f"[Accessibility tree snapshot pruned for brevity "
                            f"({orig_len} chars)]"
                        )
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

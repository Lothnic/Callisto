"""repl tool — send JS code to the sidecar's eval method."""
from __future__ import annotations

from typing import Any

from ..sidecar_client import SidecarClient


def _format_signal(signal: dict[str, Any]) -> str:
    typ = signal.get("type")
    message = signal.get("message") or typ or "event"
    url = signal.get("url")
    filename = signal.get("filename")

    target_id = signal.get("targetId")
    tid = f" targetId={target_id}" if target_id else ""

    if typ == "popup":
        detail = f"popup opened at {url}{tid}" if url else f"popup opened{tid}"
    elif typ == "dialog":
        detail = f"dialog opened: {message}"
    elif typ == "download":
        if filename and url:
            detail = f"download started: {filename} from {url}"
        elif filename:
            detail = f"download started: {filename}"
        else:
            detail = f"download started at {url}" if url else "download started"
    elif typ == "tab":
        if url:
            detail = f"{message} at {url}{tid}"
        else:
            detail = f"{message}{tid}" if tid else str(message)
    else:
        detail = f"{message} at {url}" if url else str(message)

    return f"[Agent signal: {detail}]"


def _inject_agent_signals(result: dict[str, Any]) -> dict[str, Any]:
    signals = result.get("_signals")
    if not isinstance(signals, list) or not signals:
        return result

    lines = [
        _format_signal(signal)
        for signal in signals
        if isinstance(signal, dict)
    ]
    if not lines:
        return result

    prefix = "\n".join(lines)
    value = result.get("value")
    if isinstance(value, str):
        result["value"] = f"{prefix}\n{value}" if value else prefix
    else:
        note = result.get("_note")
        result["_note"] = f"{prefix}\n{note}" if isinstance(note, str) and note else prefix
    return result


async def repl(code: str, client: SidecarClient) -> dict[str, Any]:
    """
    Evaluate `code` in the live browser session via the sidecar.

    Returns the result dict from the sidecar. If the sidecar flagged
    `truncated: true`, appends a human-readable annotation so the model
    knows output was cut.

    Raises SidecarError / SidecarDead / SidecarTimeout on failure.
    """
    result = _inject_agent_signals(await client.call("eval", {"code": code}))

    if result.get("truncated"):
        value = result.get("value", "")
        return {
            "value": value,
            "truncated": True,
            "_note": "\n".join(
                note for note in [
                    result.get("_note") if isinstance(result.get("_note"), str) else None,
                    "[output truncated at 100KB — use more specific code to narrow result]",
                ] if note
            ),
        }

    return result

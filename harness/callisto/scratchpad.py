"""scratchpad.py — write conversation history to a persistent scratch file."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_SCRATCH_DIR = Path("/tmp/callisto")
_SCRATCH_FILE = _SCRATCH_DIR / "scratch.md"


def write_scratchpad(history: list[dict[str, Any]]) -> None:
    """
    Serialise `history` to /tmp/callisto/scratch.md after each loop turn.

    The model can re-read this at the start of a resumed session. The file is
    human-readable markdown — useful for debugging too.
    """
    _SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    lines = ["# Callisto scratchpad\n"]
    for i, msg in enumerate(history):
        role = msg.get("role", "?")
        content = msg.get("content") or ""
        tool_calls = msg.get("tool_calls") or []
        lines.append(f"## Turn {i} — {role}\n")
        if content:
            lines.append(f"{content}\n\n")
        for tc in tool_calls:
            fn = tc.get("function", {}) if isinstance(tc, dict) else {}
            name = fn.get("name", tc.get("name", "?"))
            args = fn.get("arguments", tc.get("arguments", {}))
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    pass
            lines.append(f"**tool_call:** `{name}`\n```json\n{json.dumps(args, indent=2)}\n```\n\n")
    _SCRATCH_FILE.write_text("".join(lines), encoding="utf-8")

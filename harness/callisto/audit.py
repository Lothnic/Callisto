"""audit.py — append-only JSONL audit log for each session."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class AuditLog:
    """
    Writes one JSONL record per loop turn to:
        ~/.callisto/sessions/<session_id>/audit.jsonl

    Record types:
        "tool_call"  — a tool was dispatched and a result received
        "task_end"   — final task outcome (success / failure / error)

    The log is append-only. Each record is a single JSON line.
    """

    def __init__(self, session_id: str) -> None:
        self._path = (
            Path.home() / ".callisto" / "sessions" / session_id / "audit.jsonl"
        )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._step = 0

    def record_tool_call(
        self,
        call: dict[str, Any],
        result: dict[str, Any],
        duration_ms: float,
    ) -> None:
        self._append(
            {
                "type": "tool_call",
                "step": self._step,
                "call": call,
                "result": result,
                "duration_ms": round(duration_ms),
            }
        )
        self._step += 1

    def record_task_end(
        self,
        status: str,  # "success" | "failure" | "error"
        summary: str,
    ) -> None:
        self._append(
            {
                "type": "task_end",
                "step": self._step,
                "status": status,
                "summary": summary,
            }
        )

    def _append(self, record: dict[str, Any]) -> None:
        record["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

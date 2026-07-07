"""audit.py — append-only JSONL audit log for each session.

Every meaningful event gets a record. Without these, post-mortem is impossible.
"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class AuditLog:
    """
    Writes JSONL records to:
        ~/.callisto/sessions/<session_id>/audit.jsonl

    Record types:
        session_start    — session began
        session_end      — session ended
        tool_call        — a tool was dispatched and a result received
        model_output     — full model response
        approval         — human approved/denied an action
        autofill         — credential autofill triggered (no secret logged)
        compaction       — context window was compacted
        sidecar_restart  — sidecar process was restarted
        budget_warning   — cost/turns approaching limit
        budget_exceeded  — cost/turns hit limit
        memory_retrieve  — memories retrieved at task start
        memory_store     — memory stored at task end
        task_end         — final task outcome (success / failure / error)
        error            — uncaught exception
    """

    def __init__(self, session_id: str) -> None:
        self._path = (
            Path.home() / ".callisto" / "sessions" / session_id / "audit.jsonl"
        )
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._step = 0

    # ------------------------------------------------------------------
    # Session lifecycle
    # ------------------------------------------------------------------

    def record_session_start(self, task: str, model: str) -> None:
        self._append({
            "type": "session_start",
            "task": task,
            "model": model,
        })

    def record_session_end(self, status: str, duration_s: float) -> None:
        self._append({
            "type": "session_end",
            "status": status,
            "duration_s": round(duration_s, 2),
        })

    # ------------------------------------------------------------------
    # Tool dispatch
    # ------------------------------------------------------------------

    def record_tool_call(
        self,
        call: dict[str, Any],
        result: dict[str, Any],
        duration_ms: float,
    ) -> None:
        self._append({
            "type": "tool_call",
            "step": self._step,
            "call": call,
            "result": result,
            "duration_ms": round(duration_ms),
        })
        self._step += 1

    def record_model_output(self, response: dict[str, Any]) -> None:
        self._append({
            "type": "model_output",
            "step": self._step,
            "response": response,
        })

    # ------------------------------------------------------------------
    # Approval
    # ------------------------------------------------------------------

    def record_approval(
        self,
        call_name: str,
        category: str,
        approved: bool,
    ) -> None:
        self._append({
            "type": "approval",
            "step": self._step,
            "call_name": call_name,
            "category": category,
            "approved": approved,
        })

    # ------------------------------------------------------------------
    # Credential autofill
    # ------------------------------------------------------------------

    def record_autofill(self, credential_id: str, ref: str) -> None:
        """Log that autofill was triggered. NEVER log the secret value."""
        self._append({
            "type": "autofill",
            "step": self._step,
            "credential_id": credential_id,
            "ref": ref,
        })

    # ------------------------------------------------------------------
    # Compaction
    # ------------------------------------------------------------------

    def record_compaction(
        self,
        turns_dropped: int,
        summary_used: bool,
        token_savings: int,
    ) -> None:
        self._append({
            "type": "compaction",
            "step": self._step,
            "turns_dropped": turns_dropped,
            "summary_used": summary_used,
            "token_savings": token_savings,
        })

    # ------------------------------------------------------------------
    # Sidecar
    # ------------------------------------------------------------------

    def record_sidecar_restart(
        self, reason: str, budget_remaining: int
    ) -> None:
        self._append({
            "type": "sidecar_restart",
            "step": self._step,
            "reason": reason,
            "budget_remaining": budget_remaining,
        })

    # ------------------------------------------------------------------
    # Budget
    # ------------------------------------------------------------------

    def record_budget_warning(
        self, current_cost: float, budget_limit: float, percentage: float
    ) -> None:
        self._append({
            "type": "budget_warning",
            "step": self._step,
            "current_cost": round(current_cost, 4),
            "budget_limit": round(budget_limit, 4),
            "percentage": round(percentage, 1),
        })

    def record_budget_exceeded(
        self, current_cost: float, budget_limit: float
    ) -> None:
        self._append({
            "type": "budget_exceeded",
            "step": self._step,
            "current_cost": round(current_cost, 4),
            "budget_limit": round(budget_limit, 4),
        })

    # ------------------------------------------------------------------
    # Memory
    # ------------------------------------------------------------------

    def record_memory_retrieve(
        self, query: str, num_results: int, top_similarity: float
    ) -> None:
        self._append({
            "type": "memory_retrieve",
            "query": query[:200],
            "num_results": num_results,
            "top_similarity": round(top_similarity, 4),
        })

    def record_memory_store(self, task: str, summary_length: int) -> None:
        self._append({
            "type": "memory_store",
            "task": task[:200],
            "summary_length": summary_length,
        })

    # ------------------------------------------------------------------
    # Task outcome
    # ------------------------------------------------------------------

    def record_task_end(
        self,
        status: str,  # "success" | "failure" | "error"
        summary: str,
    ) -> None:
        self._append({
            "type": "task_end",
            "step": self._step,
            "status": status,
            "summary": summary,
        })

    # ------------------------------------------------------------------
    # Error
    # ------------------------------------------------------------------

    def record_error(
        self, error_type: str, message: str
    ) -> None:
        self._append({
            "type": "error",
            "step": self._step,
            "error_type": error_type,
            "message": message[:500],
        })

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _append(self, record: dict[str, Any]) -> None:
        record["ts"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with self._path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

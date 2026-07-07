"""compaction.py — keep conversation history within a token budget.

Phase 3 stub: simple keep-last-N-turns algorithm.
Phase 4 will replace this with semantic summarisation.
"""
from __future__ import annotations

import json
from typing import Any


def compact(
    messages: list[dict[str, Any]],
    token_budget: int = 80_000,
) -> list[dict[str, Any]]:
    """
    Trim `messages` so the total estimated token count fits within `token_budget`.

    Strategy:
    - Always keep system messages (role == "system").
    - Fill the remaining budget with the most-recent non-system messages.
    - 1 token ≈ 4 chars (rough but good enough for a stub).

    Phase 4 work: replace the keep-last-N heuristic with a summarisation pass
    that compresses old turns into a short "progress so far" assistant message.
    """
    chars_budget = token_budget * 4

    system_msgs = [m for m in messages if m.get("role") == "system"]
    turn_msgs = [m for m in messages if m.get("role") != "system"]

    used = sum(len(json.dumps(m)) for m in system_msgs)
    kept: list[dict[str, Any]] = []

    for msg in reversed(turn_msgs):
        cost = len(json.dumps(msg))
        if used + cost > chars_budget:
            break
        kept.append(msg)
        used += cost

    return system_msgs + list(reversed(kept))

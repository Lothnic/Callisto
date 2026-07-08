"""compaction.py — keep conversation history within a token budget.

Upgraded from Phase 3 stub (keep-last-N) to model-based summarisation.

Key properties:
- Triggered by token count (>80% of model context window), not turn count.
- Old turns are summarised into a synthetic "progress so far" message.
- Fallback to keep-last-N if the model call fails.
- Scratchpad is NEVER compacted — it grows independently.
- Compaction events are always audited.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Protocol

log = logging.getLogger(__name__)

# Rough token estimate: 1 token ≈ 4 chars
CHARS_PER_TOKEN = 4

SUMMARISE_PROMPT = (
    "Summarise the following conversation turns concisely (under 150 words). "
    "Include: pages visited, actions taken, errors, and the exact next step "
    "the agent was about to take. This is NOT the end — the agent will "
    "continue working after this summary.\n\n"
)


class Summariser(Protocol):
    """Anything with a chat() method (ChatModel satisfies this)."""

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]: ...


def estimate_tokens(messages: list[dict[str, Any]]) -> int:
    """Rough token count for a message list."""
    total_chars = sum(len(json.dumps(m)) for m in messages)
    return total_chars // CHARS_PER_TOKEN


async def compact(
    messages: list[dict[str, Any]],
    token_budget: int = 80_000,
    model: Summariser | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any] | None]:
    """
    Trim `messages` so the total estimated token count fits within `token_budget`.

    Args:
        messages:      Full message list (system + turns).
        token_budget:  Max tokens for the context window.
        model:         If provided, used to summarise dropped turns.

    Returns:
        (compacted_messages, compaction_info)

        compaction_info is None if no compaction was needed, or a dict:
        { "turns_dropped": int, "summary_used": bool, "token_savings": int }

    Strategy:
    1. If total tokens < 80% of budget → no compaction, return as-is.
    2. If >80%:
       a. Try to summarise old turns using the model.
       b. If model fails, fall back to keep-last-N (Phase 3 behaviour).
    3. System messages are always preserved.
    4. Scratchpad is NOT affected — it grows independently.
    """
    current_tokens = estimate_tokens(messages)
    threshold = int(token_budget * 0.8)

    if current_tokens <= threshold:
        return messages, None

    log.info(
        "compaction triggered: %d tokens > %d threshold (budget: %d)",
        current_tokens, threshold, token_budget,
    )

    system_msgs = [m for m in messages if m.get("role") == "system"]
    turn_msgs = [m for m in messages if m.get("role") != "system"]

    if not turn_msgs:
        return messages, None

    # Group messages into atomic transactions so we never split assistant tool calls from tool results
    groups = []
    current_group = []
    for msg in turn_msgs:
        role = msg.get("role")
        if role in ("user", "assistant"):
            if current_group:
                groups.append(current_group)
            current_group = [msg]
        elif role == "tool":
            current_group.append(msg)
        else:
            if current_group:
                groups.append(current_group)
            current_group = [msg]
    if current_group:
        groups.append(current_group)

    # Determine how many turns to keep (fill budget from the end)
    system_tokens = estimate_tokens(system_msgs)
    remaining_budget = (token_budget * CHARS_PER_TOKEN) - (system_tokens * CHARS_PER_TOKEN)
    # Reserve space for the summary message (~500 tokens)
    remaining_budget -= 500 * CHARS_PER_TOKEN

    kept_groups = []
    used = 0
    for gp in reversed(groups):
        cost = sum(len(json.dumps(m)) for m in gp)
        if used + cost > remaining_budget:
            break
        kept_groups.append(gp)
        used += cost

    kept_groups.reverse()
    kept = [m for gp in kept_groups for m in gp]

    dropped_groups = groups[: len(groups) - len(kept_groups)]
    dropped = [m for gp in dropped_groups for m in gp]
    turns_dropped = len(dropped)

    if turns_dropped == 0:
        return messages, None

    # Try model-based summarisation
    summary_msg: dict[str, Any] | None = None
    summary_used = False

    if model and dropped:
        try:
            summary_text = await _summarise_turns(dropped, model)
            summary_msg = {
                "role": "user",
                "content": (
                    f"[Context summary — earlier turns 1-{turns_dropped} were compacted]\n"
                    f"Context from previous turns:\n{summary_text}\n"
                    f"---\n"
                    f"Continue the task. Make a tool call for the next action."
                ),
            }
            summary_used = True
            log.info("compaction: summarised %d turns via model", turns_dropped)
        except Exception as exc:
            log.warning(
                "compaction: model summarisation failed (%s), using keep-last-N fallback",
                exc,
            )

    # Assemble result
    result = list(system_msgs)
    if summary_msg:
        result.append(summary_msg)
    result.extend(kept)

    # Ensure at least one user message exists (Groq requirement).
    if not any(m.get("role") == "user" for m in result):
        result.append({
            "role": "user",
            "content": "Continue the task using the most recent browser state.",
        })

    new_tokens = estimate_tokens(result)
    token_savings = current_tokens - new_tokens

    compaction_info = {
        "turns_dropped": turns_dropped,
        "summary_used": summary_used,
        "token_savings": token_savings,
    }

    log.info(
        "compaction complete: dropped %d turns, saved %d tokens (%s)",
        turns_dropped, token_savings,
        "summarised" if summary_used else "truncated",
    )

    return result, compaction_info


async def _summarise_turns(
    turns: list[dict[str, Any]],
    model: Summariser,
) -> str:
    """Call the model to summarise dropped turns."""
    # Format turns as readable text
    turn_text = []
    for i, msg in enumerate(turns):
        role = msg.get("role", "?")
        content = msg.get("content") or ""
        if content:
            turn_text.append(f"Turn {i} ({role}): {content[:300]}")
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function", {})
            name = fn.get("name", "?")
            turn_text.append(f"Turn {i} ({role}): called {name}(...)")

    prompt = SUMMARISE_PROMPT + "\n".join(turn_text)

    resp = await model.chat(
        [{"role": "user", "content": prompt}],
        [],  # no tools for summarisation
    )
    # resp is a Response TypedDict with key 'text'
    text = resp["text"] if isinstance(resp, dict) else getattr(resp, "text", None)
    if not text:
        raise ValueError("Model returned empty summary")
    return text

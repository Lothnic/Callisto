import pytest
import json
from callisto.compaction import compact, estimate_tokens

@pytest.mark.asyncio
async def test_compaction_triggered_groups_transactions():
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Task 1"},
        {"role": "assistant", "content": "Thought 1", "tool_calls": [{"id": "c1", "type": "function", "function": {"name": "repl", "arguments": "{\"code\":\"1\"}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "result 1" * 500},  # ~4KB payload to trigger compaction
        {"role": "assistant", "content": "Thought 2", "tool_calls": [{"id": "c2", "type": "function", "function": {"name": "repl", "arguments": "{\"code\":\"2\"}"}}]},
        {"role": "tool", "tool_call_id": "c2", "content": "result 2"},
    ]

    # Token budget of 1000 = 4000 chars.
    # Group 1 (Task 1) + Group 2 (c1) = ~4200 chars. This will exceed remaining budget.
    # Group 3 (c2) = ~200 chars. System = ~60 chars. This fits easily.
    compacted, info = await compact(messages, token_budget=1000)
    assert info is not None
    assert info["turns_dropped"] > 0

    # The tool result c2 (result 2) should NOT be dropped because its corresponding assistant tool call is kept
    kept_tool_ids = [m.get("tool_call_id") for m in compacted if m.get("role") == "tool"]
    assert "c2" in kept_tool_ids

    # The c1 tool result should be dropped since its assistant call was dropped
    assert "c1" not in kept_tool_ids

    # Verify we didn't split c2 tool result from its assistant call!
    assistant_msgs = [m for m in compacted if m.get("role") == "assistant"]
    assert len(assistant_msgs) == 1
    assert assistant_msgs[0]["tool_calls"][0]["id"] == "c2"

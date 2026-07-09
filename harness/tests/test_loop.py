"""
test_loop.py — offline unit tests for the agent loop.

Uses FakeModel: zero API cost, zero network, zero browser.
All tests should pass in CI without any environment variables.
"""
from __future__ import annotations

import json
import pytest

from callisto.loop import run, _tool_call_fingerprint, STUCK_THRESHOLD
from callisto.models import Response, ToolCall
from callisto.models.fake import FakeModel
from callisto.sidecar_client import SidecarError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _repl_call(code: str = "return 1", call_id: str = "c1") -> ToolCall:
    return ToolCall(id=call_id, name="repl", arguments={"code": code})


def _bash_call(cmd: str = "echo hi", call_id: str = "c2") -> ToolCall:
    return ToolCall(id=call_id, name="bash", arguments={"cmd": cmd})


def _resp_tool(call: ToolCall) -> Response:
    return Response(text=None, tool_calls=[call])


def _resp_done(text: str = "Task complete.") -> Response:
    return Response(text=text, tool_calls=[])


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_happy_path_repl_then_done(fake_sidecar_client):
    """Normal: search → grounded goto + snapshot → final text."""
    model = FakeModel([
        _resp_tool(_repl_call(
            "await page.goto('https://www.google.com/search?q=pricing'); "
            "return 'https://example.com/pricing in results'"
        )),
        _resp_tool(_repl_call(
            "await page.goto('https://example.com/pricing'); "
            "return (await page.accessibility.snapshot()).text"
        )),
        _resp_done("The pricing page is at https://example.com/pricing"),
    ])
    client = fake_sidecar_client(
        eval_result={"value": "https://example.com/pricing [ax-1] link Pricing"}
    )

    result = await run(
        task="Find the pricing page",
        model=model,
        client=client,
        require_approval=False,
    )

    assert "pricing" in result.lower()
    assert any(m == "eval" for m, _ in client.calls)


@pytest.mark.asyncio
async def test_single_action_discipline_degrades_gracefully(fake_sidecar_client):
    """Loop executes the first tool call and feeds back an error for the others."""

    class TwoToolModel:
        def __init__(self):
            self.calls = 0

        async def chat(self, messages, tools) -> Response:
            self.calls += 1
            if self.calls == 1:
                return Response(
                    text=None,
                    tool_calls=[
                        _repl_call(code="return 1", call_id="c1"),
                        _repl_call(code="return 2", call_id="c2"),
                    ],
                )
            # Second turn: verify that the tool results were appended to history
            # The tool result for c2 should contain the single-action error.
            tool_results = [m for m in messages if m.get("role") == "tool"]
            assert len(tool_results) == 2

            c1_res = next(r for r in tool_results if r.get("tool_call_id") == "c1")
            c2_res = next(r for r in tool_results if r.get("tool_call_id") == "c2")

            assert "value" in json.loads(c1_res["content"])
            assert "single-action discipline violated" in json.loads(c2_res["content"])["error"].lower()

            return Response(text="Done.", tool_calls=[])

    client = fake_sidecar_client()
    res = await run("task", TwoToolModel(), client, require_approval=False)
    assert res == "Done."


@pytest.mark.asyncio
async def test_stuck_detection_forces_final_answer(fake_sidecar_client):
    """Repeated identical actions eventually force a text final (no infinite tools)."""
    from callisto.loop import STUCK_THRESHOLD, MAX_STUCK_NUDGES

    repeated_call = _repl_call("return 'stuck'")
    # Soft stuck nudges, then force_final rejects tools until model returns text.
    script = (
        [_resp_tool(repeated_call)] * (STUCK_THRESHOLD * MAX_STUCK_NUDGES + 4)
        + [_resp_done("Stopped after thrashing; no useful page state.")]
    )
    model = FakeModel(script)
    client = fake_sidecar_client(eval_result={"value": "stuck"})

    result = await run("task", model, client, require_approval=False, max_steps=20)
    assert "thrash" in result.lower() or "stuck" in result.lower() or "stopped" in result.lower()


@pytest.mark.asyncio
async def test_tool_error_is_returned_to_model_not_raised(fake_sidecar_client):
    """If the sidecar returns an error, the loop feeds it back as a tool result."""
    call = _repl_call("bad code")
    model = FakeModel([
        _resp_tool(call),
        _resp_done("ok, I handled the error"),
    ])
    # Sidecar raises SidecarError — loop should catch and continue
    client = fake_sidecar_client(raise_on_call=SidecarError("EvalError: bad code"))

    result = await run("task", model, client, require_approval=False)
    assert result == "ok, I handled the error"


@pytest.mark.asyncio
async def test_progress_events_include_readable_summaries(fake_sidecar_client):
    events = []
    model = FakeModel([
        _resp_tool(_repl_call(
            "await page.goto('https://www.google.com/search?q=go'); "
            "return 'https://example.com [ax-1] button Go'"
        )),
        _resp_done("done with example https://example.com"),
    ])
    client = fake_sidecar_client(
        eval_result={"value": "https://example.com [ax-1] button Go"}
    )

    async def progress(event):
        events.append(event)

    await run("task", model, client, require_approval=False, progress_callback=progress)

    starts = [e for e in events if e["type"] == "step_start"]
    ends = [e for e in events if e["type"] == "step_end"]
    assert starts
    assert ends
    assert ends[0]["summary"]["ok"] is True
    assert any(e.get("type") == "status" and e.get("phase") == "model_wait" for e in events)


@pytest.mark.asyncio
async def test_max_steps_requests_best_effort_final(fake_sidecar_client):
    """When step budget ends, loop asks model once more without tools."""
    # 3 tool turns exhaust budget; 4th scripted response is the forced final
    model = FakeModel(
        [_resp_tool(_repl_call(
            "await page.goto('https://www.google.com/search?q=x'); return 'https://example.com ok'"
        ))] * 3
        + [_resp_done("Partial: only saw search results for x at google.com")]
    )
    client = fake_sidecar_client(
        eval_result={"value": "https://example.com search results"}
    )

    result = await run("task", model, client, max_steps=3, require_approval=False)
    assert "partial" in result.lower() or "search" in result.lower()


@pytest.mark.asyncio
async def test_approval_required_for_bash(fake_sidecar_client, monkeypatch):
    """bash tool should trigger approval; denial feeds an error back to the model."""
    bash_call = _bash_call("rm -rf /tmp/test")
    model = FakeModel([
        _resp_tool(bash_call),
        _resp_done("understood, not deleting"),
    ])
    client = fake_sidecar_client()

    # Simulate user typing "n" — patch the module-level function the loop calls
    async def _deny(_prompt: str) -> bool:
        return False
    monkeypatch.setattr("callisto.tools.ask.ask", _deny)

    result = await run("task", model, client, require_approval=True)
    assert result == "understood, not deleting"
    # Bash should never have been dispatched
    assert not any(m == "eval" and "cmd" in p for m, p in client.calls)


@pytest.mark.asyncio
async def test_approval_not_required_for_repl(fake_sidecar_client, monkeypatch):
    """repl does not require approval — should dispatch without asking."""
    call = _repl_call()
    model = FakeModel([_resp_tool(call), _resp_done("done")])
    client = fake_sidecar_client()

    ask_called = []
    async def _track_ask(prompt):
        ask_called.append(prompt)
        return True
    monkeypatch.setattr("callisto.tools.ask.ask", _track_ask)

    await run("task", model, client, require_approval=True)
    assert not ask_called, "repl should not trigger approval"


def test_tool_call_fingerprint_stable():
    """Fingerprint is stable across equivalent dict orderings."""
    c1 = ToolCall(id="x", name="bash", arguments={"cmd": "ls", "flag": True})
    c2 = ToolCall(id="y", name="bash", arguments={"flag": True, "cmd": "ls"})
    assert _tool_call_fingerprint(c1) == _tool_call_fingerprint(c2)

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
from callisto.sidecar_client import SidecarClient, SidecarError


# ---------------------------------------------------------------------------
# Minimal fake SidecarClient that doesn't touch the network
# ---------------------------------------------------------------------------

class FakeSidecarClient:
    """In-process fake — no subprocess, no Node, no Chrome."""

    def __init__(self, eval_result: dict | None = None, raise_on_call: Exception | None = None):
        self._eval_result = eval_result or {"value": "fake-result"}
        self._raise = raise_on_call
        self.calls: list[tuple[str, dict]] = []

    async def call(self, method: str, params: dict, **_kwargs) -> dict:
        self.calls.append((method, params))
        if self._raise:
            raise self._raise
        if method == "eval":
            return self._eval_result
        return {"ok": True}


# ---------------------------------------------------------------------------
# Helper
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
async def test_happy_path_repl_then_done():
    """Normal: one repl tool call, then a final text response."""
    model = FakeModel([
        _resp_tool(_repl_call("return (await mini.snapshot()).text")),
        _resp_done("The pricing page is at /pricing"),
    ])
    client = FakeSidecarClient(eval_result={"value": "page text here"})

    result = await run(
        task="Find the pricing page",
        model=model,
        client=client,
        require_approval=False,
    )

    assert result == "The pricing page is at /pricing"
    # Exactly one eval call was made
    assert any(m == "eval" for m, _ in client.calls)


@pytest.mark.asyncio
async def test_single_action_assertion_fires():
    """Loop must assert if the model returns more than one tool call."""

    class TwoToolModel:
        async def chat(self, messages, tools) -> Response:
            return Response(
                text=None,
                tool_calls=[
                    _repl_call(call_id="c1"),
                    _repl_call(call_id="c2"),
                ],
            )

    client = FakeSidecarClient()
    with pytest.raises(AssertionError, match="single-action discipline violated"):
        await run("task", TwoToolModel(), client, require_approval=False)


@pytest.mark.asyncio
async def test_stuck_detection_halts_loop():
    """Loop raises RuntimeError when the same action repeats STUCK_THRESHOLD times."""
    repeated_call = _repl_call("return 'stuck'")
    # Script must be long enough to trigger the threshold
    script = [_resp_tool(repeated_call)] * (STUCK_THRESHOLD + 1)
    model = FakeModel(script)
    client = FakeSidecarClient(eval_result={"value": "stuck"})

    with pytest.raises(RuntimeError, match="stuck"):
        await run("task", model, client, require_approval=False)


@pytest.mark.asyncio
async def test_tool_error_is_returned_to_model_not_raised():
    """If the sidecar returns an error, the loop feeds it back as a tool result."""
    call = _repl_call("bad code")
    model = FakeModel([
        _resp_tool(call),
        _resp_done("ok, I handled the error"),
    ])
    # Sidecar raises SidecarError — loop should catch and continue
    client = FakeSidecarClient(raise_on_call=SidecarError("EvalError: bad code"))

    result = await run("task", model, client, require_approval=False)
    assert result == "ok, I handled the error"


@pytest.mark.asyncio
async def test_max_steps_exceeded():
    """Loop raises RuntimeError if max_steps is reached without a final answer."""
    # Model always returns a tool call, never finishes
    model = FakeModel([_resp_tool(_repl_call())] * 10)
    client = FakeSidecarClient()

    with pytest.raises(RuntimeError, match="did not finish within 3 steps"):
        await run("task", model, client, max_steps=3, require_approval=False)


@pytest.mark.asyncio
async def test_approval_required_for_bash(monkeypatch):
    """bash tool should trigger approval; denial feeds an error back to the model."""
    bash_call = _bash_call("rm -rf /tmp/test")
    model = FakeModel([
        _resp_tool(bash_call),
        _resp_done("understood, not deleting"),
    ])
    client = FakeSidecarClient()

    # Simulate user typing "n" — patch the module-level function the loop calls
    async def _deny(_prompt: str) -> bool:
        return False
    monkeypatch.setattr("callisto.tools.ask.ask", _deny)

    result = await run("task", model, client, require_approval=True)
    assert result == "understood, not deleting"
    # Bash should never have been dispatched
    assert not any(m == "eval" and "cmd" in p for m, p in client.calls)


@pytest.mark.asyncio
async def test_approval_not_required_for_repl(monkeypatch):
    """repl does not require approval — should dispatch without asking."""
    call = _repl_call()
    model = FakeModel([_resp_tool(call), _resp_done("done")])
    client = FakeSidecarClient()

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

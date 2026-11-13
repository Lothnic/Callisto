"""Regressions for the repository review's harness failures."""
import asyncio
import importlib
import os
import shlex
import sys

import aiohttp
import pytest

from callisto.budget import BudgetTracker
from callisto.compaction import estimate_tokens
from callisto.loop import run
from callisto.models import Response, ToolCall
from callisto.models.fake import FakeModel
from callisto.web_server import start_server, task_queue, UI_TOKEN


@pytest.mark.asyncio
async def test_sidebar_requires_local_host_origin_and_credential():
    runner = await start_server(0)
    port = next(iter(runner.sites))._server.sockets[0].getsockname()[1]
    base = f"http://127.0.0.1:{port}"
    token = runner.app[UI_TOKEN]
    protocols = ("callisto", "callisto-token." + token)
    try:
        async with aiohttp.ClientSession() as client:
            for origin, offered in [("http://unrelated.invalid", protocols), (base, ("callisto",))]:
                with pytest.raises(aiohttp.WSServerHandshakeError) as error:
                    await client.ws_connect(base + "/ws", origin=origin, protocols=offered)
                assert error.value.status == 403
            async with client.get(base + "/sidebar", headers={"Host": "unrelated.invalid"}) as response:
                assert response.status == 403
            async with client.get(base + "/sidebar") as response:
                assert response.status == 200
                assert token in await response.text()
                assert response.headers["Cache-Control"] == "no-store"
            async with client.ws_connect(base + "/ws", origin=base, protocols=protocols) as ws:
                await ws.send_json({"action": "run_task", "task": "authorized task"})
                assert await asyncio.wait_for(task_queue.get(), 1) == "authorized task"
    finally:
        await runner.cleanup()


@pytest.mark.asyncio
async def test_legacy_shell_alias_cannot_bypass_denial(fake_sidecar_client, monkeypatch):
    executed = []
    prompts = []

    async def deny(prompt):
        prompts.append(prompt)
        return False

    async def fake_bash(*args, **kwargs):
        executed.append(args)
        return {"exit_code": 0}

    monkeypatch.setattr("callisto.tools.ask.ask", deny)
    monkeypatch.setattr("callisto.tools.dispatch.bash", fake_bash)
    call = ToolCall(id="legacy", name="repo.exec", arguments={"cmd": ["bash", "-lc", "rm -rf scratch"]})
    model = FakeModel([Response(text=None, tool_calls=[call]), Response(text="Denied action handled.", tool_calls=[])])
    await run("task", model, fake_sidecar_client(), require_approval=True)
    assert len(prompts) == 1 and "[delete]" in prompts[0]
    assert executed == []


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "posix", reason="POSIX process groups")
@pytest.mark.parametrize("cancel", [False, True])
async def test_shell_timeout_and_cancellation_kill_children(tmp_path, monkeypatch, cancel):
    bash_module = importlib.import_module("callisto.tools.bash")
    monkeypatch.setattr(bash_module, "BASH_TIMEOUT_SECONDS", .15)
    child_code = "import time; from pathlib import Path; time.sleep(.5); Path(%r).write_text('survived')" % str(tmp_path / "survived")
    cmd = f"{shlex.quote(sys.executable)} -c {shlex.quote(child_code)} & wait"
    operation = asyncio.create_task(bash_module.bash(cmd))
    if cancel:
        await asyncio.sleep(.05)
        operation.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(operation, 1)
    else:
        assert (await asyncio.wait_for(operation, 1))["exit_code"] == -1
    await asyncio.sleep(.55)
    assert not (tmp_path / "survived").exists()


@pytest.mark.asyncio
async def test_recovery_answers_every_parallel_tool_call(fake_sidecar_client):
    class Model:
        count = 0

        async def chat(self, messages, tools):
            pending = set()
            for message in messages:
                pending.update(call["id"] for call in message.get("tool_calls", []))
                if message.get("role") == "tool":
                    pending.discard(message["tool_call_id"])
            assert not pending, pending
            self.count += 1
            if self.count == 5:
                return Response(text="Recovery complete.", tool_calls=[])
            return Response(text=None, tool_calls=[
                ToolCall(id=f"{self.count}-a", name="repl", arguments={"code": f"return await page.content(); // {self.count}"}),
                ToolCall(id=f"{self.count}-b", name="repl", arguments={"code": "return 2"}),
            ])

    await run("task", Model(), fake_sidecar_client(eval_result={"value": "https://example.com/"}),
              history=[{"role": "user", "content": "task"}], require_approval=False)


@pytest.mark.asyncio
async def test_final_answer_is_compacted_and_counted(fake_sidecar_client):
    class Model:
        sizes = []

        async def chat(self, messages, tools):
            if messages[0]["content"].startswith("Summarise"):
                return Response(text="Earlier work at example.com.", tool_calls=[])
            self.sizes.append(estimate_tokens(messages))
            if tools:
                return Response(text=None, tool_calls=[ToolCall(id="last", name="repl", arguments={"code": "return 1"})])
            return Response(text="Partial answer from prior work.", tool_calls=[])

    history = [{"role": "user", "content": "old task " + "x" * 8000}]
    history.extend({"role": "user", "content": "prior turn " + "x" * 1000} for _ in range(20))
    budget = BudgetTracker(max_cost=0, max_turns=0)
    model = Model()
    await run("continue", model, fake_sidecar_client(), history=history, max_steps=1,
              token_budget=3000, budget=budget, require_approval=False)
    assert len(model.sizes) == 2 and max(model.sizes) <= 3000
    assert budget.total_turns == 2

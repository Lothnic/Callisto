"""
sidecar_client.py — async Python client for the callisto-sidecar process.

Implements RFC 0003.1 §3: subprocess lifecycle, watchdog, one-shot Chrome
restart, per-call timeout, UUID-correlated JSON-RPC.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import uuid
from asyncio import Future
from typing import Any

log = logging.getLogger(__name__)

SIDECAR_BIN = "callisto-sidecar"
CALL_TIMEOUT = 65.0  # slightly longer than sidecar's 60s eval timeout


class SidecarError(Exception):
    """The sidecar returned { ok: false, error: "..." }."""


class SidecarDead(Exception):
    """The sidecar subprocess exited unexpectedly."""


class SidecarTimeout(Exception):
    """A call to the sidecar exceeded CALL_TIMEOUT seconds."""


class SidecarClient:
    """
    Manages one callisto-sidecar subprocess.

    Usage::

        client = SidecarClient()
        await client.start()
        await client.call("launch", {"headless": True})
        result = await client.call("eval", {"code": "return 1"})
        await client.call("close", {})
        client.terminate()
    """

    def __init__(self, restart_budget: int = 1, relaunch_budget: int = 2) -> None:
        self._restart_budget = restart_budget
        self._relaunch_budget = relaunch_budget
        self._process: asyncio.subprocess.Process | None = None
        self._dead = False
        self._pending: dict[str, Future[dict[str, Any]]] = {}
        self._reader_task: asyncio.Task[None] | None = None
        self._watchdog_task: asyncio.Task[None] | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Spawn callisto-sidecar from $PATH."""
        if not shutil.which(SIDECAR_BIN):
            raise FileNotFoundError(
                f"'{SIDECAR_BIN}' not found on $PATH. "
                "Run `npm link` inside packages/mini or `npm i -g @callisto/mini`."
            )
        self._dead = False
        self._process = await asyncio.create_subprocess_exec(
            SIDECAR_BIN,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            # Surface Chrome/BrowserOS launch diagnostics (sandbox failures, etc.)
            stderr=asyncio.subprocess.PIPE,
            limit=1024 * 1024,  # support response lines up to 1MB (e.g. truncated output at 100KB)
        )
        log.debug("sidecar PID %d started", self._process.pid)
        self._reader_task = asyncio.create_task(self._reader(), name="sidecar-reader")
        self._stderr_task = asyncio.create_task(self._stderr_reader(), name="sidecar-stderr")
        self._watchdog_task = asyncio.create_task(self._watchdog(), name="sidecar-watchdog")

    async def call(
        self,
        method: str,
        params: dict[str, Any],
        *,
        timeout: float = CALL_TIMEOUT,
    ) -> dict[str, Any]:
        """
        Send a JSON-RPC request and await the response.

        Raises:
            SidecarDead    — process has exited
            SidecarTimeout — no response within `timeout` seconds
            SidecarError   — sidecar returned { ok: false, error: "..." }
        """
        if method == "launch":
            self._launch_params = params

        if self._dead:
            raise SidecarDead("sidecar process is not running")

        call_id = str(uuid.uuid4())
        future: Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[call_id] = future

        request = json.dumps({"id": call_id, "method": method, "params": params, "v": 1})
        assert self._process and self._process.stdin
        self._process.stdin.write((request + "\n").encode())
        await self._process.stdin.drain()

        try:
            return await asyncio.wait_for(future, timeout=timeout)
        except asyncio.TimeoutError:
            self._pending.pop(call_id, None)
            raise SidecarTimeout(f"call '{method}' exceeded {timeout}s")

    def _cancel_tasks(self) -> list[asyncio.Task[None]]:
        tasks: list[asyncio.Task[None]] = []
        for task in (self._reader_task, getattr(self, "_stderr_task", None), self._watchdog_task):
            if task is not None and not task.done():
                task.cancel()
                tasks.append(task)
        return tasks

    def terminate(self) -> None:
        """Best-effort synchronous teardown (call from finally blocks)."""
        if self._process and self._process.returncode is None:
            self._process.terminate()
        self._cancel_tasks()

    async def aclose(self) -> None:
        """Async teardown that waits for subprocess transports before loop close."""
        proc = self._process
        if proc is not None:
            # Close stdin first so the sidecar sees EOF and exits cleanly.
            if proc.stdin and not proc.stdin.is_closing():
                with contextlib.suppress(Exception):
                    proc.stdin.write_eof()
                    await proc.stdin.drain()
                with contextlib.suppress(Exception):
                    proc.stdin.close()
                    await proc.stdin.wait_closed()

            if proc.returncode is None:
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), timeout=3)
            if proc.returncode is None:
                proc.terminate()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), timeout=3)
            if proc.returncode is None:
                proc.kill()
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(proc.wait(), timeout=3)

            # Drain remaining pipes so transports are closed before the loop dies.
            if proc.stdout:
                with contextlib.suppress(Exception):
                    await proc.stdout.read()
            if proc.stderr:
                with contextlib.suppress(Exception):
                    await proc.stderr.read()

        for task in self._cancel_tasks():
            with contextlib.suppress(asyncio.CancelledError, asyncio.TimeoutError):
                await asyncio.wait_for(task, timeout=1)

    # ------------------------------------------------------------------
    # Internal tasks
    # ------------------------------------------------------------------

    async def _reader(self) -> None:
        """Reads stdout line by line, correlates responses by id."""
        assert self._process and self._process.stdout
        async for raw in self._process.stdout:
            line = raw.decode().strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                log.warning("sidecar sent non-JSON: %r", line)
                continue

            call_id = msg.get("id")
            future = self._pending.pop(call_id, None) if call_id else None

            if future and not future.done():
                if msg.get("ok"):
                    future.set_result(msg.get("result", {}))
                else:
                    future.set_exception(SidecarError(msg.get("error", "unknown error")))

    async def _stderr_reader(self) -> None:
        """Forward sidecar/Chrome diagnostics to the harness logger."""
        assert self._process and self._process.stderr
        async for raw in self._process.stderr:
            line = raw.decode(errors="replace").rstrip()
            if not line:
                continue
            # Always useful for launch failures; keep at warning so CLI users see it
            # under default INFO-level logging via root handlers that include warnings.
            log.warning("sidecar: %s", line)

    async def _watchdog(self) -> None:
        """Waits for the process to exit; marks session dead and fails pending calls."""
        assert self._process
        await self._process.wait()
        rc = self._process.returncode
        log.warning("sidecar exited with code %d", rc)
        self._dead = True

        # Fail all pending futures
        exc = SidecarDead(f"sidecar exited with code {rc}")
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    async def maybe_restart(self) -> None:
        """
        Attempt one-shot Chrome restart (RFC 0003 §Sidecar watchdog).
        Called by the loop when SidecarDead is caught mid-task.
        """
        if not hasattr(self, "_launch_params"):
            raise SidecarDead("cannot restart sidecar — was never launched")
        if self._restart_budget <= 0:
            raise SidecarDead("sidecar restart budget exhausted — giving up")
        self._restart_budget -= 1
        log.info("restarting sidecar (budget remaining: %d)", self._restart_budget)
        self.terminate()
        await self.start()
        await self.call("launch", self._launch_params)
        log.info("sidecar restarted successfully")

    async def relaunch_browser(self) -> None:
        """
        Re-launch the browser session without restarting the sidecar process.

        Sends a new 'launch' call to the sidecar, which closes the existing
        Mini session (killing the old Chrome process) and creates a new one
        with a fresh Chrome process and CDP connection.

        This is a recovery path for CDP/WebSocket disconnections where the
        sidecar process is still alive but Chrome's debug protocol connection
        has been lost.

        Uses a separate budget from maybe_restart() so browser-only re-launches
        don't consume the sidecar crash recovery budget.
        """
        if not hasattr(self, "_launch_params"):
            raise SidecarDead("cannot re-launch browser — was never launched")
        if self._relaunch_budget <= 0:
            raise SidecarDead("browser re-launch budget exhausted")
        self._relaunch_budget -= 1
        log.info(
            "re-launching browser session (budget remaining: %d)",
            self._relaunch_budget,
        )
        await self.call("launch", self._launch_params)
        log.info("browser re-launched successfully")

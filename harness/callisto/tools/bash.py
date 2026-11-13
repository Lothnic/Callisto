"""bash tool — shell out with a 30-second timeout + sandbox isolation."""
from __future__ import annotations

import asyncio
import os
import signal
from typing import Any

from ..sandbox import wrap_command

BASH_TIMEOUT_SECONDS = 30.0


def shell_command(value: Any) -> str:
    """Normalize the legacy repo.exec command shape before policy and execution."""
    if isinstance(value, list):
        if len(value) >= 3 and value[0] == "bash" and value[1] in ("-c", "-lc"):
            return str(value[2])
        return " ".join(str(part) for part in value)
    return str(value)


def _kill_process_tree(proc: asyncio.subprocess.Process) -> None:
    try:
        if os.name == "posix":
            os.killpg(proc.pid, signal.SIGKILL)
        elif proc.returncode is None:
            proc.kill()
    except ProcessLookupError:
        pass


async def bash(cmd: str, session_dir: str = "") -> dict[str, Any]:
    """
    Run `cmd` in a subprocess shell, optionally sandboxed.

    If `session_dir` is provided, the command is wrapped with OS-level
    isolation (bwrap on Linux, sandbox-exec on macOS). See sandbox.py.

    Returns::

        { "stdout": str, "stderr": str, "exit_code": int }

    Timeout: 30 seconds. On timeout, the process is killed and exit_code is -1.
    """
    actual_cmd = wrap_command(cmd, session_dir) if session_dir else cmd

    try:
        proc = await asyncio.create_subprocess_shell(
            actual_cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=os.name == "posix",
        )
        communication = asyncio.create_task(proc.communicate())
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                asyncio.shield(communication), timeout=BASH_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            _kill_process_tree(proc)
            await communication
            return {
                "stdout": "",
                "stderr": f"[bash] command timed out after 30s: {cmd!r}",
                "exit_code": -1,
            }
        except asyncio.CancelledError:
            _kill_process_tree(proc)
            await communication
            raise
    except Exception as exc:  # noqa: BLE001
        return {
            "stdout": "",
            "stderr": f"[bash] failed to start: {exc}",
            "exit_code": -1,
        }

    return {
        "stdout": stdout_b.decode(errors="replace"),
        "stderr": stderr_b.decode(errors="replace"),
        "exit_code": proc.returncode if proc.returncode is not None else 0,
    }

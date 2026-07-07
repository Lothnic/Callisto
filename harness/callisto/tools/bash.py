"""bash tool — shell out with a 30-second timeout + sandbox isolation."""
from __future__ import annotations

import asyncio
from typing import Any

from ..sandbox import wrap_command


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
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=30.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return {
                "stdout": "",
                "stderr": f"[bash] command timed out after 30s: {cmd!r}",
                "exit_code": -1,
            }
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

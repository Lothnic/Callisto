"""bash tool — shell out with a 30-second timeout."""
from __future__ import annotations

import asyncio
from typing import Any

from . import requires_approval


@requires_approval
async def bash(cmd: str) -> dict[str, Any]:
    """
    Run `cmd` in a subprocess shell.

    Returns::

        { "stdout": str, "stderr": str, "exit_code": int }

    Timeout: 30 seconds. On timeout, the process is killed and exit_code is -1.
    """
    try:
        proc = await asyncio.create_subprocess_shell(
            cmd,
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

"""ask tool — pause-and-confirm for destructive actions."""
from __future__ import annotations

import sys


async def ask(prompt: str) -> bool:
    """
    Print `prompt` to the terminal and read a y/n answer from stdin.

    Returns True on confirm ("y" / "yes"), False on deny or EOF.

    This is intentionally synchronous-inside-async: it blocks the event loop
    while the human thinks. That is the correct behaviour — the agent should
    not proceed until a human explicitly approves.
    """
    sys.stdout.write(f"\n[callisto] Approval required:\n  {prompt}\n  Proceed? [y/N] ")
    sys.stdout.flush()
    try:
        answer = sys.stdin.readline().strip().lower()
    except (EOFError, KeyboardInterrupt):
        answer = ""
    return answer in ("y", "yes")

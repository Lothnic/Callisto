"""tools/__init__.py — tool registry and @requires_approval decorator."""
from __future__ import annotations

import functools
from typing import Any, Callable

# Tools in this set pause for human confirmation before dispatch.
# "bash" is high-privilege (arbitrary shell); always requires approval.
SENSITIVE_TOOLS: set[str] = {"bash"}


def requires_approval(fn: Callable[..., Any]) -> Callable[..., Any]:
    """
    Marks a tool function as requiring human confirmation before dispatch.

    The loop checks `getattr(tool_fn, "_requires_approval", False)` or
    `call.name in SENSITIVE_TOOLS` before calling execute().
    """
    @functools.wraps(fn)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        return await fn(*args, **kwargs)

    wrapper._requires_approval = True  # type: ignore[attr-defined]
    return wrapper

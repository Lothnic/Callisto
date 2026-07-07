"""repl tool — send JS code to the sidecar's eval method."""
from __future__ import annotations

from typing import Any

from ..sidecar_client import SidecarClient


async def repl(code: str, client: SidecarClient) -> dict[str, Any]:
    """
    Evaluate `code` in the live browser session via the sidecar.

    Returns the result dict from the sidecar. If the sidecar flagged
    `truncated: true`, appends a human-readable annotation so the model
    knows output was cut.

    Raises SidecarError / SidecarDead / SidecarTimeout on failure.
    """
    result = await client.call("eval", {"code": code})

    if result.get("truncated"):
        value = result.get("value", "")
        return {
            "value": value,
            "truncated": True,
            "_note": "[output truncated at 100KB — use more specific code to narrow result]",
        }

    return result

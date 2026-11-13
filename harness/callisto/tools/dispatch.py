"""Tool schemas and dispatch (RFC 0003 — two tools only)."""
from __future__ import annotations

import json
from typing import Any

from ..audit import AuditLog
from ..auth.autofill import do_autofill, is_signin_call
from ..models import ToolCall
from ..sidecar_client import SidecarClient
from .bash import bash, shell_command
from .repl import repl

# ---------------------------------------------------------------------------
# Tool definitions (sent to the model as JSON schema)
# ---------------------------------------------------------------------------

TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "repl",
            "description": (
                "Execute JavaScript in the live browser session. "
                "Playwright-shaped `page` is in scope. Return a value with `return ...`. "
                "Example: return (await page.accessibility.snapshot()).text"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "JS code to execute."}
                },
                "required": ["code"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": (
                "Run a shell command (30-second timeout). "
                "Returns stdout, stderr, exit_code."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "cmd": {"type": "string", "description": "Shell command to execute."}
                },
                "required": ["cmd"],
            },
        },
    },
    # Two tools only (RFC 0003 / CONTRIBUTING). Do not advertise a third.
]


async def execute(
    call: ToolCall,
    client: SidecarClient,
    audit: AuditLog,
    session_dir: str = "",
) -> dict[str, Any]:
    """Dispatch a ToolCall and return the raw result dict."""
    if call["name"] == "repl":
        code = call["arguments"].get("code", "")

        # ── Autofill interception (closed allowlist) ────────────────────
        if is_signin_call(code):
            return await do_autofill(code, client, audit)

        return await repl(code, client)

    # Legacy alias: some models still emit repo.exec from older prompts/traces.
    # Not in TOOL_SCHEMAS — never advertised to the model as a third tool.
    if call["name"] in ("bash", "repo.exec"):
        return await bash(shell_command(call["arguments"].get("cmd", "")), session_dir=session_dir)

    return {"error": f"unknown tool: {call['name']}"}


def tool_call_fingerprint(call: ToolCall) -> str:
    """Stable string representation for stuck-loop detection."""
    return f"{call['name']}:{json.dumps(call['arguments'], sort_keys=True)}"

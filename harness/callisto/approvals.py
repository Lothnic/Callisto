"""approvals.py — category-based approval rules for tool calls.

Replaces the flat SENSITIVE_TOOLS set and the @requires_approval decorator
from Phase 3. This is the single approval mechanism — one source of truth.

Each rule matches a regex against the serialised tool arguments and triggers
an approval prompt with a category name and human-readable message.

IMPORTANT — BYPASS RISK (documented, not oversold):

    Approval rules are a defense-in-depth layer, NOT a guarantee. They catch
    obvious patterns in bash commands; a sufficiently motivated or adversarial
    agent can phrase around them. The human-in-the-loop on the CLI is the
    actual safety boundary.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .tools.bash import shell_command


@dataclass(frozen=True)
class ApprovalRule:
    """A single approval rule."""

    category: str
    pattern: re.Pattern[str]
    message: str


# Default rules — order matters: first match wins.
DEFAULT_RULES: list[ApprovalRule] = [
    ApprovalRule(
        category="delete",
        pattern=re.compile(
            r"rm\s+-[rRf]|rmdir|shred|unlink|del\s|Remove-Item|delete",
            re.IGNORECASE,
        ),
        message="This command deletes files, directories, or resources.",
    ),
    ApprovalRule(
        category="send_message",
        pattern=re.compile(
            r"git\s+push|curl\s.*-X\s*POST|curl\s.*--data|"
            r"wget\s+--post|sendmail|mail\s+-s|curl\s+.*\s*\|\s*(?:bash|sh)",
            re.IGNORECASE,
        ),
        message="This command sends data externally or runs a piped remote script.",
    ),
    ApprovalRule(
        category="payment",
        pattern=re.compile(
            r"stripe|checkout|pay|purchase|billing|subscribe",
            re.IGNORECASE,
        ),
        message="This action may involve a payment or subscription.",
    ),
    ApprovalRule(
        category="account_change",
        pattern=re.compile(
            r"passwd|useradd|usermod|ssh-keygen|chown|chmod\s+[0-7]{3,4}",
            re.IGNORECASE,
        ),
        message="This action modifies account or permission settings.",
    ),
    # Catch-all: any bash command not matched above still requires approval.
    # repl calls are NOT matched — they don't need approval.
    ApprovalRule(
        category="shell",
        pattern=re.compile(r".*"),  # matches anything
        message="This runs a shell command.",
    ),
]


def check_approval(
    call: dict[str, Any],
    rules: list[ApprovalRule] | None = None,
    auto_approve: set[str] | None = None,
    last_snapshot_text: str | None = None,
) -> ApprovalRule | None:
    """
    Check whether a tool call requires human approval.

    Args:
        call:               ToolCall dict with "name" and "arguments" keys.
        rules:              Override the default rules (useful for tests).
        auto_approve:       Set of category names to auto-approve without prompting.
        last_snapshot_text: Most recent accessibility tree snapshot string from history.

    Returns:
        The first matching ApprovalRule, or None if no approval is needed.
        If the matched category is in auto_approve, returns None (auto-approved).

    Both bash commands and repl clicks/actions targeting sensitive elements are checked.
    """
    ruleset = rules if rules is not None else DEFAULT_RULES
    approved = auto_approve or set()

    # ── repl element click approval check ────────────────────────────
    if call["name"] == "repl":
        code = call.get("arguments", {}).get("code", "")
        # Find all referenced elements matching ax-\d+ in the JS code
        refs = re.findall(r"ax-\d+", code)
        if not refs or not last_snapshot_text:
            return None

        # Search for corresponding ref lines in the last accessibility tree snapshot
        for ref in refs:
            for line in last_snapshot_text.splitlines():
                if f"[{ref}]" in line:
                    # Check rules against this snapshot line
                    for rule in ruleset:
                        if rule.category == "shell":
                            continue  # skip shell catch-all for repl clicks
                        if rule.pattern.search(line):
                            if rule.category in approved:
                                continue
                            return ApprovalRule(
                                category=rule.category,
                                pattern=rule.pattern,
                                message=f"Browser action targets a '{rule.category}' element: {line.strip()}",
                            )
        return None

    # ── bash approval check ──────────────────────────────────────────
    if call["name"] in ("bash", "repo.exec"):
        # Serialise arguments for pattern matching
        args_text = json.dumps({"cmd": shell_command(call.get("arguments", {}).get("cmd", ""))})

        for rule in ruleset:
            if rule.pattern.search(args_text):
                if rule.category in approved:
                    return None  # auto-approved
                return rule

    return None

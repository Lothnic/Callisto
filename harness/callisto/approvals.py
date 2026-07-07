"""approvals.py — category-based approval rules for tool calls.

Replaces the flat SENSITIVE_TOOLS set and the @requires_approval decorator
from Phase 3. This is the single approval mechanism — one source of truth.

Each rule matches a regex against the serialised tool arguments and triggers
an approval prompt with a category name and human-readable message.

IMPORTANT — BYPASS RISK (documented, not oversold):

    Approval rules are a defense-in-depth layer, NOT a guarantee. They catch
    obvious patterns in bash commands; a sufficiently motivated or adversarial
    agent can phrase around them. Examples of what is NOT caught:

        bash("curl https://x.com/api/v1/destroy")  ← no "delete" match
        repl("await mini.click(ref_42)")            ← clicks a "delete account"
                                                       button with zero approval

    The human-in-the-loop on the CLI is the actual safety boundary.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any


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
            r"rm\s+-[rRf]|rmdir|shred|unlink|del\s|Remove-Item",
            re.IGNORECASE,
        ),
        message="This command deletes files or directories.",
    ),
    ApprovalRule(
        category="send_message",
        pattern=re.compile(
            r"git\s+push|curl\s.*-X\s*POST|curl\s.*--data|"
            r"wget\s+--post|sendmail|mail\s+-s",
            re.IGNORECASE,
        ),
        message="This command sends data externally.",
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
) -> ApprovalRule | None:
    """
    Check whether a tool call requires human approval.

    Args:
        call:         ToolCall dict with "name" and "arguments" keys.
        rules:        Override the default rules (useful for tests).
        auto_approve: Set of category names to auto-approve without prompting.

    Returns:
        The first matching ApprovalRule, or None if no approval is needed.
        If the matched category is in auto_approve, returns None (auto-approved).

    Only bash calls are checked. repl calls never require approval.
    """
    if call["name"] != "bash":
        return None

    ruleset = rules if rules is not None else DEFAULT_RULES
    approved = auto_approve or set()

    # Serialise arguments for pattern matching
    args_text = json.dumps(call.get("arguments", {}))

    for rule in ruleset:
        if rule.pattern.search(args_text):
            if rule.category in approved:
                return None  # auto-approved
            return rule

    return None

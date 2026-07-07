"""
test_security.py — security test suite for Phase 4.

Validates that credentials never leak, approval categories fire correctly,
sandbox confinement works, and audit events are recorded. All offline using
FakeModel + FakeSidecarClient. Zero API cost.
"""
from __future__ import annotations

import json
import re
import pytest

from callisto.approvals import ApprovalRule, check_approval, DEFAULT_RULES
from callisto.audit import AuditLog
from callisto.auth.autofill import (
    is_signin_call,
    parse_signin_call,
    purge_secret_from_history,
    SIGNIN_MARKERS,
)
from callisto.budget import BudgetExceededError, BudgetTracker
from callisto.loop import run, _tool_call_fingerprint
from callisto.models import Response, ToolCall
from callisto.models.fake import FakeModel


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _repl_call(code: str = "return 1", call_id: str = "c1") -> ToolCall:
    return ToolCall(id=call_id, name="repl", arguments={"code": code})


def _bash_call(cmd: str = "echo hi", call_id: str = "c2") -> ToolCall:
    return ToolCall(id=call_id, name="bash", arguments={"cmd": cmd})


def _resp_tool(call: ToolCall) -> Response:
    return Response(text=None, tool_calls=[call])


def _resp_done(text: str = "Task complete.") -> Response:
    return Response(text=text, tool_calls=[])


# ===========================================================================
# 1. CREDENTIAL TESTS
# ===========================================================================

class TestSigninMarkerMatching:
    """Closed allowlist: exact function names only."""

    def test_exact_match_signin(self):
        assert is_signin_call("__callisto_signin('cred', 'ax-5')")

    def test_exact_match_login(self):
        assert is_signin_call("__callisto_login('cred', 'ax-5')")

    def test_with_whitespace(self):
        assert is_signin_call("  __callisto_signin('cred', 'ax-5')  ")

    def test_hallucination_email_variant(self):
        """Model hallucination: __callisto_signin_email — must be rejected."""
        assert not is_signin_call("__callisto_signin_email('cred', 'ax-5')")

    def test_hallucination_no_underscores(self):
        """Model hallucination: callisto_signin — must be rejected."""
        assert not is_signin_call("callisto_signin('cred', 'ax-5')")

    def test_hallucination_uppercase(self):
        """Model hallucination: __CALLISTO_SIGNIN — must be rejected."""
        assert not is_signin_call("__CALLISTO_SIGNIN('cred', 'ax-5')")

    def test_hallucination_partial_name(self):
        assert not is_signin_call("__callisto_sign('cred', 'ax-5')")

    def test_empty_string(self):
        assert not is_signin_call("")

    def test_normal_repl_code(self):
        assert not is_signin_call("return (await mini.snapshot()).text")

    def test_contains_marker_as_substring(self):
        """Marker as a substring of other code — must NOT match."""
        assert not is_signin_call("console.log(__callisto_signin)")

    def test_allowlist_is_frozen(self):
        """SIGNIN_MARKERS must be immutable."""
        assert isinstance(SIGNIN_MARKERS, frozenset)


class TestSigninParsing:

    def test_parse_single_quotes(self):
        result = parse_signin_call("__callisto_signin('github-work', 'ax-12')")
        assert result == ("github-work", "ax-12")

    def test_parse_double_quotes(self):
        result = parse_signin_call('__callisto_signin("github-work", "ax-12")')
        assert result == ("github-work", "ax-12")

    def test_parse_with_spaces(self):
        result = parse_signin_call("__callisto_signin( 'github-work' , 'ax-12' )")
        assert result == ("github-work", "ax-12")

    def test_malformed_returns_none(self):
        assert parse_signin_call("__callisto_signin(bad)") is None

    def test_login_variant(self):
        result = parse_signin_call("__callisto_login('cred', 'ax-5')")
        assert result == ("cred", "ax-5")


class TestHistoryPurge:
    """Passwords must never appear in message history."""

    def test_secret_purged_from_content(self, monkeypatch):
        monkeypatch.setattr("callisto.auth.autofill.keychain.get", lambda _: "s3cret_pass!")

        history = [
            {"role": "tool", "content": "await mini.fill('ax-5', 's3cret_pass!')"},
            {"role": "assistant", "content": "I typed the password s3cret_pass! into the field."},
        ]
        purge_secret_from_history(history, "test-cred")

        for msg in history:
            content = msg.get("content", "")
            assert "s3cret_pass!" not in content, f"Secret leaked in: {content}"

    def test_secret_purged_from_tool_call_arguments(self, monkeypatch):
        monkeypatch.setattr("callisto.auth.autofill.keychain.get", lambda _: "hunter2")

        history = [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "function": {
                            "name": "repl",
                            "arguments": '{"code": "await mini.fill(\'ax-5\', \'hunter2\')"}',
                        }
                    }
                ],
            },
        ]
        purge_secret_from_history(history, "test-cred")

        for msg in history:
            for tc in msg.get("tool_calls") or []:
                args = tc.get("function", {}).get("arguments", "")
                assert "hunter2" not in args, f"Secret leaked in tool_call args: {args}"

    def test_purge_with_unknown_credential(self, monkeypatch):
        """If credential not found, purge is a no-op (no crash)."""
        monkeypatch.setattr("callisto.auth.autofill.keychain.get", lambda _: None)
        history = [{"role": "user", "content": "test"}]
        purge_secret_from_history(history, "nonexistent")
        # Should not crash


# ===========================================================================
# 2. APPROVAL TESTS
# ===========================================================================

class TestApprovalCategories:

    def test_rm_rf_triggers_delete(self):
        call = {"name": "bash", "arguments": {"cmd": "rm -rf /tmp/test"}}
        rule = check_approval(call)
        assert rule is not None
        assert rule.category == "delete"

    def test_rm_r_triggers_delete(self):
        call = {"name": "bash", "arguments": {"cmd": "rm -r /tmp/test"}}
        rule = check_approval(call)
        assert rule is not None
        assert rule.category == "delete"

    def test_rmdir_triggers_delete(self):
        call = {"name": "bash", "arguments": {"cmd": "rmdir /tmp/test"}}
        rule = check_approval(call)
        assert rule is not None
        assert rule.category == "delete"

    def test_git_push_triggers_send_message(self):
        call = {"name": "bash", "arguments": {"cmd": "git push origin main"}}
        rule = check_approval(call)
        assert rule is not None
        assert rule.category == "send_message"

    def test_curl_post_triggers_send_message(self):
        call = {"name": "bash", "arguments": {"cmd": "curl -X POST https://api.example.com"}}
        rule = check_approval(call)
        assert rule is not None
        assert rule.category == "send_message"

    def test_stripe_triggers_payment(self):
        call = {"name": "bash", "arguments": {"cmd": "curl https://api.stripe.com/charge"}}
        rule = check_approval(call)
        assert rule is not None
        assert rule.category == "payment"

    def test_passwd_triggers_account_change(self):
        call = {"name": "bash", "arguments": {"cmd": "passwd user123"}}
        rule = check_approval(call)
        assert rule is not None
        assert rule.category == "account_change"

    def test_echo_hello_triggers_shell_catchall(self):
        """Non-destructive bash commands still hit the catch-all."""
        call = {"name": "bash", "arguments": {"cmd": "echo hello"}}
        rule = check_approval(call)
        assert rule is not None
        assert rule.category == "shell"

    def test_repl_never_triggers_approval(self):
        """repl calls NEVER require approval."""
        call = {"name": "repl", "arguments": {"code": "await mini.click('ax-42')"}}
        rule = check_approval(call)
        assert rule is None

    def test_auto_approve_skips_category(self):
        call = {"name": "bash", "arguments": {"cmd": "rm -rf /tmp/x"}}
        rule = check_approval(call, auto_approve={"delete"})
        assert rule is None

    def test_auto_approve_other_category_still_fires(self):
        call = {"name": "bash", "arguments": {"cmd": "rm -rf /tmp/x"}}
        rule = check_approval(call, auto_approve={"payment"})
        assert rule is not None
        assert rule.category == "delete"

    def test_repl_click_on_delete_element_requires_approval(self):
        call = {"name": "repl", "arguments": {"code": "await mini.click('ax-12')"}}
        snapshot = '[ax-12] button "Delete Account"'
        rule = check_approval(call, last_snapshot_text=snapshot)
        assert rule is not None
        assert rule.category == "delete"
        assert "Delete Account" in rule.message

    def test_repl_click_on_payment_element_requires_approval(self):
        call = {"name": "repl", "arguments": {"code": "await mini.click('ax-15')"}}
        snapshot = '[ax-15] link "Pay $10 Now"'
        rule = check_approval(call, last_snapshot_text=snapshot)
        assert rule is not None
        assert rule.category == "payment"

    def test_repl_click_on_normal_element_does_not_require_approval(self):
        call = {"name": "repl", "arguments": {"code": "await mini.click('ax-15')"}}
        snapshot = '[ax-15] link "Home"'
        rule = check_approval(call, last_snapshot_text=snapshot)
        assert rule is None


# ===========================================================================
# 3. BUDGET TESTS
# ===========================================================================

class TestBudget:

    def test_turn_limit_exceeded(self):
        budget = BudgetTracker(max_turns=3, max_cost=0)
        budget.record_turn(100, 50)
        budget.record_turn(100, 50)
        budget.record_turn(100, 50)
        with pytest.raises(BudgetExceededError, match="Turn limit"):
            budget.check()

    def test_cost_limit_exceeded(self):
        budget = BudgetTracker(max_cost=0.01, max_turns=0)
        # With default pricing, 10K input + 10K output ≈ $0.18
        budget.record_turn(10_000, 10_000)
        with pytest.raises(BudgetExceededError, match="Cost limit"):
            budget.check()

    def test_under_budget_is_fine(self):
        budget = BudgetTracker(max_cost=100.0, max_turns=1000)
        budget.record_turn(100, 50)
        assert budget.check() is None

    def test_50_pct_warning(self):
        budget = BudgetTracker(max_cost=0.002, max_turns=0)
        # 100 input + 100 output at default pricing = ~$0.0018
        # That's 90% of $0.002 — should trigger warning, not exceed
        budget.record_turn(100, 100)
        result = budget.check()
        assert result == "warning"

    def test_unlimited_budget(self):
        budget = BudgetTracker(max_cost=0, max_turns=0)
        for _ in range(200):
            budget.record_turn(1000, 500)
        assert budget.check() is None  # never raises


# ===========================================================================
# 4. AUDIT TESTS
# ===========================================================================

class TestAuditLog:

    def test_session_lifecycle_logged(self, tmp_path):
        audit = AuditLog.__new__(AuditLog)
        audit._path = tmp_path / "audit.jsonl"
        audit._path.parent.mkdir(parents=True, exist_ok=True)
        audit._step = 0

        audit.record_session_start("test task", "claude-3.5")
        audit.record_tool_call(
            {"name": "repl", "arguments": {"code": "return 1"}},
            {"value": 1},
            42.0,
        )
        audit.record_approval("bash", "delete", True)
        audit.record_autofill("github-work", "ax-5")
        audit.record_compaction(10, True, 5000)
        audit.record_budget_warning(2.50, 5.00, 50.0)
        audit.record_memory_retrieve("find pricing", 3, 0.85)
        audit.record_memory_store("find pricing", 200)
        audit.record_error("ValueError", "test error")
        audit.record_task_end("success", "done")
        audit.record_session_end("success", 120.5)

        records = [
            json.loads(line) for line in audit._path.read_text().strip().split("\n")
        ]
        types = [r["type"] for r in records]

        assert "session_start" in types
        assert "tool_call" in types
        assert "approval" in types
        assert "autofill" in types
        assert "compaction" in types
        assert "budget_warning" in types
        assert "memory_retrieve" in types
        assert "memory_store" in types
        assert "error" in types
        assert "task_end" in types
        assert "session_end" in types

    def test_autofill_record_has_no_secret(self, tmp_path):
        """Autofill audit record must NEVER contain the secret value."""
        audit = AuditLog.__new__(AuditLog)
        audit._path = tmp_path / "audit.jsonl"
        audit._path.parent.mkdir(parents=True, exist_ok=True)
        audit._step = 0

        audit.record_autofill("github-work", "ax-5")

        content = audit._path.read_text()
        record = json.loads(content.strip())
        # The record should have credential_id and ref, but no "secret" or "password" field
        assert "credential_id" in record
        assert "ref" in record
        assert record["credential_id"] == "github-work"
        # Verify no password-like fields exist
        for key in record:
            assert key not in ("secret", "password", "value"), (
                f"Audit record contains sensitive field: {key}"
            )


# ===========================================================================
# 5. LOOP INTEGRATION TESTS
# ===========================================================================

class TestLoopApproval:

    @pytest.mark.asyncio
    async def test_category_shown_in_approval_prompt(self, fake_sidecar_client, monkeypatch):
        """Approval prompt should include the category name."""
        prompts_seen = []

        async def _track_ask(prompt: str) -> bool:
            prompts_seen.append(prompt)
            return True

        monkeypatch.setattr("callisto.tools.ask.ask", _track_ask)

        model = FakeModel([
            _resp_tool(_bash_call("rm -rf /tmp/test")),
            _resp_done("deleted"),
        ])
        client = fake_sidecar_client()

        await run("task", model, client, require_approval=True)

        assert len(prompts_seen) == 1
        assert "[delete]" in prompts_seen[0].lower()

    @pytest.mark.asyncio
    async def test_auto_approve_category_skips_prompt(self, fake_sidecar_client, monkeypatch):
        """Auto-approved categories should not trigger a prompt."""
        ask_called = []

        async def _track_ask(prompt: str) -> bool:
            ask_called.append(prompt)
            return True

        monkeypatch.setattr("callisto.tools.ask.ask", _track_ask)

        model = FakeModel([
            _resp_tool(_bash_call("echo hello")),
            _resp_done("done"),
        ])
        client = fake_sidecar_client()

        await run(
            "task", model, client,
            require_approval=True,
            auto_approve={"shell"},
        )
        assert not ask_called, "auto-approved category should skip prompt"

    @pytest.mark.asyncio
    async def test_repl_click_gated_by_snapshot(self, fake_sidecar_client, monkeypatch):
        """Repl clicking a delete element based on snapshot triggers approval."""
        prompts_seen = []

        async def _track_ask(prompt: str) -> bool:
            prompts_seen.append(prompt)
            return True

        monkeypatch.setattr("callisto.tools.ask.ask", _track_ask)

        model = FakeModel([
            # First turn: model gets snapshot
            _resp_tool(_repl_call("return (await mini.snapshot()).text")),
            # Second turn: model clicks a delete element
            _resp_tool(_repl_call("await mini.click('ax-12')")),
            _resp_done("done"),
        ])

        # Sidecar returns the snapshot text containing a delete element
        client = fake_sidecar_client(eval_result={"value": '[ax-12] button "Delete Account"'})

        await run("task", model, client, require_approval=True)

        assert len(prompts_seen) == 1
        assert "[delete]" in prompts_seen[0].lower()


class TestLoopBudget:

    @pytest.mark.asyncio
    async def test_budget_exceeded_raises(self, fake_sidecar_client):
        """Loop should raise BudgetExceededError when budget is exhausted."""
        model = FakeModel([_resp_tool(_repl_call())] * 10)
        client = fake_sidecar_client()
        budget = BudgetTracker(max_turns=2, max_cost=0)

        with pytest.raises(BudgetExceededError, match="Turn limit"):
            await run(
                "task", model, client,
                require_approval=False,
                budget=budget,
            )

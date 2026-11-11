"""Unit tests for loop control helpers and stop/continue behaviour."""
from __future__ import annotations

import pytest

from callisto.control import (
    action_family,
    blank_page_noop_reason,
    extract_click_ref,
    extract_urls_from_text,
    invented_goto_reason,
    is_acceptable_final,
    is_blank_url,
    is_pingpong,
    navigation_failure_note,
    result_looks_blocked,
)
from callisto.loop import run, STUCK_THRESHOLD
from callisto.models import Response, ToolCall
from callisto.models.fake import FakeModel


def _repl(code: str, call_id: str = "c1") -> ToolCall:
    return ToolCall(id=call_id, name="repl", arguments={"code": code})


def _tool(code: str, call_id: str = "c1") -> Response:
    return Response(text=None, tool_calls=[_repl(code, call_id)])


def _text(text: str) -> Response:
    return Response(text=text, tool_calls=[])


def test_is_acceptable_final_rejects_empty_and_planning():
    assert is_acceptable_final("", step=0) is False
    assert is_acceptable_final("I will search for pricing", step=2) is False
    assert is_acceptable_final("Let me navigate to the page", step=1) is False
    assert is_acceptable_final(
        "SuperGrok is $30/month according to the snapshot on grok.com/supergrok",
        step=5,
    ) is True


def test_is_acceptable_final_accepts_evidence_rich_partial():
    """Real session failure mode: good answer with 'let me know' was rejected."""
    text = (
        "I found the contact details. Note: the store at this domain "
        "(thelillystore.com) is actually based in Pakistan (Hyderabad, Sindh), "
        "not India. Address: Flat no 20. Phone: 03483329498. "
        "Email: lillystore.pk@gmail.com. "
        "If you're looking for a specifically Indian store, let me know "
        "and I can search further."
    )
    assert is_acceptable_final(text, step=5) is True


def test_action_family_content_mining():
    call = {
        "name": "repl",
        "arguments": {
            "code": "const html = await page.content(); return html.match(/@/g)",
        },
    }
    assert action_family(call) == "repl:content"


def test_invented_goto_blocked_without_grounding():
    evidence = 'link "Store" https://www.smartbiz.in/TheLilyStore contact'
    grounded = extract_urls_from_text(evidence)
    # Search always allowed
    assert (
        invented_goto_reason(
            "await page.goto('https://www.google.com/search?q=x')",
            grounded,
            grounded_text=evidence,
        )
        is None
    )
    # Exact grounded URL allowed
    assert (
        invented_goto_reason(
            "await page.goto('https://www.smartbiz.in/TheLilyStore')",
            grounded,
            grounded_text=evidence,
        )
        is None
    )
    # Invented path on seen host blocked
    reason = invented_goto_reason(
        "await page.goto('https://www.smartbiz.in/pages/contact-us')",
        grounded,
        grounded_text=evidence,
    )
    assert reason and "Invented path" in reason
    # Invented domain blocked
    reason2 = invented_goto_reason(
        "await page.goto('https://www.thelilystore.in/')",
        grounded,
        grounded_text=evidence,
    )
    assert reason2 and "Ungrounded" in reason2


def test_bare_domain_in_task_grounds_homepage_and_subdomain():
    """User said 'wikipedia.org' → www/en.wikipedia.org homepages are allowed."""
    task = "go to wikipedia.org, search for Python"
    grounded = extract_urls_from_text(task)
    assert any("wikipedia.org" in g for g in grounded)
    assert (
        invented_goto_reason(
            "await page.goto('https://www.wikipedia.org/')",
            grounded,
            grounded_text=task,
        )
        is None
    )
    assert (
        invented_goto_reason(
            "await page.goto('https://en.wikipedia.org/')",
            grounded,
            grounded_text=task,
        )
        is None
    )
    # Deep invented path still blocked
    reason = invented_goto_reason(
        "await page.goto('https://en.wikipedia.org/wiki/MadeUpPath')",
        grounded,
        grounded_text=task,
    )
    assert reason and "Invented path" in reason


def test_navigation_failure_note_detects_cert_errors():
    note = navigation_failure_note(
        {"value": '[ax-1] button "NET::ERR_CERT_COMMON_NAME_INVALID"'},
        "https://www.thelilystore.com/pages/contact-us",
    )
    assert note and "FAILED" in note


def test_pingpong_detects_click_snapshot_loop():
    hist = [
        "repl:click", "repl:snapshot",
        "repl:click", "repl:snapshot",
        "repl:click", "repl:snapshot",
    ]
    assert is_pingpong(hist) is True
    assert is_pingpong(["repl:click"] * 6) is False
    assert is_pingpong(hist[:4]) is False  # window default 6


def test_extract_click_ref():
    assert extract_click_ref('await page.locator(\'[callisto-ref="ax-130"]\').click()') == "ax-130"


def test_result_looks_blocked():
    assert result_looks_blocked({"value": "Sorry, you have been blocked You are unable to access x.ai"})
    assert not result_looks_blocked({"value": "[ax-1] link \"Pricing\""})


def test_action_family_groups_gotos():
    a = {"name": "repl", "arguments": {"code": "await page.goto('https://a')"}}
    b = {"name": "repl", "arguments": {"code": "await page.goto('https://b')"}}
    assert action_family(a) == action_family(b) == "repl:goto"


def test_blank_page_noop_blocks_snapshot_and_url():
    assert is_blank_url("about:blank")
    snap = {"name": "repl", "arguments": {"code": "return (await page.accessibility.snapshot()).text"}}
    url_only = {"name": "repl", "arguments": {"code": "return await page.url()"}}
    goto = {"name": "repl", "arguments": {"code": "await page.goto('https://x.ai/grok'); return page.url()"}}
    assert blank_page_noop_reason(snap, "about:blank")
    assert blank_page_noop_reason(url_only, "about:blank")
    assert blank_page_noop_reason(goto, "about:blank") is None
    assert blank_page_noop_reason(snap, "https://x.ai/grok") is None


@pytest.mark.asyncio
async def test_blank_snapshot_is_short_circuited(fake_sidecar_client):
    """Snapshot on about:blank never hits the browser; model must navigate next."""
    model = FakeModel([
        _tool("return (await page.accessibility.snapshot()).text"),
        _tool(
            "await page.goto('https://www.google.com/search?q=example'); "
            "return 'results https://example.com'"
        ),
        _tool("await page.goto('https://example.com'); return await page.url()"),
        _text("Example Domain is the page title from the navigation result."),
    ])
    client = fake_sidecar_client(eval_result={"value": "results https://example.com"})
    result = await run("open example", model, client, require_approval=False)
    assert "example" in result.lower()
    evals = [p for m, p in client.calls if m == "eval"]
    assert any("goto" in str(p.get("code", "")) for p in evals)


@pytest.mark.asyncio
async def test_empty_final_is_rejected_and_loop_continues(fake_sidecar_client):
    """Model stopping with empty text should not end the run on first try."""
    model = FakeModel([
        _tool("return 1"),
        _text(""),  # premature stop
        _text("Found price $9 from tool results."),  # real stop
    ])
    client = fake_sidecar_client(eval_result={"value": "ok"})
    result = await run("task", model, client, require_approval=False)
    assert "9" in result or "price" in result.lower()


@pytest.mark.asyncio
async def test_planning_final_is_rejected(fake_sidecar_client):
    model = FakeModel([
        _tool("return 1"),
        _text("I will look up the pricing next."),
        _text("Plan A is $20/mo based on the earlier page text."),
    ])
    client = fake_sidecar_client(eval_result={"value": "Plan A $20/mo"})
    result = await run("task", model, client, require_approval=False)
    assert "$20" in result or "20" in result


@pytest.mark.asyncio
async def test_soft_stuck_does_not_raise_immediately(fake_sidecar_client):
    """Identical actions get a soft nudge; model can then finish."""
    same = _tool("return 'stuck'", "c1")
    # STUCK_THRESHOLD identical, then a different action, then done
    script = [same] * STUCK_THRESHOLD + [
        _tool("return (await page.accessibility.snapshot()).text", "c2"),
        _text("Best effort: blocked on site; no price found in tool results."),
    ]
    model = FakeModel(script)
    client = fake_sidecar_client(eval_result={"value": "stuck"})
    result = await run("task", model, client, require_approval=False)
    assert "blocked" in result.lower() or "price" in result.lower() or "effort" in result.lower()

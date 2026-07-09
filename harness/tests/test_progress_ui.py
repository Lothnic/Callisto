"""Tests for CLI progress narration helpers."""
from __future__ import annotations

from callisto.progress_ui import ProgressPrinter, format_session_banner, _issue_lines


def test_banner_marks_headless_clearly():
    lines = format_session_banner(
        task="find pricing",
        provider="siliconflow",
        model="tencent/Hy3",
        headless=True,
        max_steps=40,
    )
    blob = "\n".join(lines)
    assert "HEADLESS" in blob
    assert "siliconflow/tencent/Hy3" in blob
    assert "find pricing" in blob


def test_banner_marks_visible():
    lines = format_session_banner(
        task="x",
        provider="groq",
        model="m",
        headless=False,
        max_steps=10,
    )
    assert any("VISIBLE" in line for line in lines)


def test_issue_lines_detect_block():
    issues = _issue_lines({
        "summary": {
            "ok": True,
            "title": "Blocked",
            "detail": "Sorry, you have been blocked You are unable to access x.ai",
        },
        "issues": [],
    })
    assert any("block" in i.lower() for i in issues)


def test_printer_handles_step_sequence(capsys):
    p = ProgressPrinter(verbose=False)
    p.handle({
        "type": "step_start",
        "step": 0,
        "summary": {"title": "Snapshot page", "detail": "return snapshot"},
    })
    p.handle({
        "type": "step_end",
        "step": 0,
        "summary": {"ok": True, "title": "Snapshot: 3 refs, 5 lines", "detail": "[ax-1]"},
        "url": "https://example.com",
        "next_hint": "Click a ref",
    })
    p.handle({"type": "final", "text": "Done with example.com"})
    out = capsys.readouterr().out
    assert "DOING" in out
    assert "RESULT" in out
    assert "NEXT" in out
    assert "example.com" in out
    assert "DONE" in out

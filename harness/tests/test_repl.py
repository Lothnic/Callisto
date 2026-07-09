from __future__ import annotations

import pytest

from callisto.tools.repl import repl


class FakeClient:
    def __init__(self, result: dict):
        self.result = result

    async def call(self, method: str, params: dict):
        assert method == "eval"
        assert "code" in params
        return dict(self.result)


@pytest.mark.asyncio
async def test_repl_prepends_agent_signals_to_string_value():
    result = await repl(
        "return 'ok'",
        FakeClient({
            "value": "snapshot text",
            "_signals": [
                {"type": "popup", "message": "popup opened", "url": "https://example.com"},
                {"type": "download", "message": "download started", "filename": "report.pdf"},
            ],
        }),
    )

    assert result["value"].startswith(
        "[Agent signal: popup opened at https://example.com]\n"
        "[Agent signal: download started: report.pdf]\n"
    )


@pytest.mark.asyncio
async def test_repl_signal_includes_target_id():
    result = await repl(
        "return 'ok'",
        FakeClient({
            "value": "ok",
            "_signals": [
                {
                    "type": "tab",
                    "message": "focused new tab",
                    "url": "https://grok.com/supergrok",
                    "targetId": "T1",
                },
            ],
        }),
    )

    assert (
        result["value"]
        == "[Agent signal: focused new tab at https://grok.com/supergrok targetId=T1]\nok"
    )


@pytest.mark.asyncio
async def test_repl_puts_agent_signals_in_note_for_non_string_value():
    result = await repl(
        "return 1",
        FakeClient({
            "value": {"ok": True},
            "_signals": [{"type": "tab", "message": "tab closed", "url": "https://old.example"}],
        }),
    )

    assert result["value"] == {"ok": True}
    assert result["_note"] == "[Agent signal: tab closed at https://old.example]"

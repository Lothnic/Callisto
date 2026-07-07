"""FakeModel — scripted response replayer for offline tests (RFC 0003)."""
from __future__ import annotations

from typing import Any

from . import Response, ToolCall


class FakeModel:
    """
    Replays a scripted list of Response objects in order.
    Zero API cost, zero network. Used for all offline tests.

    Usage::

        model = FakeModel([
            Response(text=None, tool_calls=[ToolCall(id="c1", name="repl",
                     arguments={"code": "return 1"})]),
            Response(text="done", tool_calls=[]),
        ])
    """

    def __init__(self, script: list[Response]) -> None:
        self._script = list(script)
        self._index = 0

    async def chat(
        self,
        messages: list[dict[str, Any]],  # noqa: ARG002
        tools: list[dict[str, Any]],     # noqa: ARG002
    ) -> Response:
        if self._index >= len(self._script):
            raise RuntimeError(
                f"FakeModel exhausted: {self._index} calls made, "
                f"only {len(self._script)} scripted"
            )
        resp = self._script[self._index]
        self._index += 1
        return resp

    def reset(self) -> None:
        self._index = 0

"""OpenRouter model — OpenAI-compatible /chat/completions (RFC 0003)."""
from __future__ import annotations

import json
import os
from typing import Any

import aiohttp

from . import Response, ToolCall

_API_URL = "https://openrouter.ai/api/v1/chat/completions"
_DEFAULT_MODEL = "anthropic/claude-3.5-sonnet"


class OpenRouterModel:
    """
    Calls OpenRouter's OpenAI-compatible endpoint.

    All models available on OpenRouter are reachable by changing `model`.
    Reads OPENROUTER_API_KEY from the environment.
    """

    def __init__(
        self,
        model: str = _DEFAULT_MODEL,
        api_key: str | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> None:
        self.model = model
        self.api_key = api_key or os.environ.get("OPENROUTER_API_KEY", "")
        if not self.api_key:
            raise ValueError(
                "OPENROUTER_API_KEY is not set. "
                "Export it or pass api_key= explicitly."
            )
        self.temperature = temperature
        self.max_tokens = max_tokens

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> Response:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
        }
        if self.max_tokens is not None:
            payload["max_tokens"] = self.max_tokens
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/Lothnic/callisto",
            "X-Title": "callisto",
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(_API_URL, json=payload, headers=headers) as resp:
                resp.raise_for_status()
                data = await resp.json()

        choice = data["choices"][0]
        msg = choice["message"]

        tool_calls: list[ToolCall] = []
        for tc in msg.get("tool_calls") or []:
            args = tc["function"].get("arguments", "{}")
            tool_calls.append(
                ToolCall(
                    id=tc["id"],
                    name=tc["function"]["name"],
                    arguments=json.loads(args) if isinstance(args, str) else args,
                )
            )

        return Response(
            text=msg.get("content"),
            tool_calls=tool_calls,
        )

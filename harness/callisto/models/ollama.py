"""Ollama model — local inference via Ollama's OpenAI-compatible endpoint."""
from __future__ import annotations

import json
import logging
from typing import Any

import aiohttp

from . import Response, ToolCall

_API_URL = "http://localhost:11434/v1/chat/completions"
_DEFAULT_MODEL = "qwen2.5:0.5b"

log = logging.getLogger("callisto.ollama")


class OllamaModel:
    """Calls a local Ollama instance at localhost:11434."""

    def __init__(
        self,
        model: str = _DEFAULT_MODEL,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> None:
        self.model = model
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
            "stream": False,
        }
        if self.max_tokens is not None:
            payload["max_tokens"] = self.max_tokens
        if tools:
            payload["tools"] = tools

        async with aiohttp.ClientSession() as session:
            async with session.post(_API_URL, json=payload) as resp:
                if resp.status >= 400:
                    err_text = await resp.text()
                    log.error("Ollama API error (%d): %s", resp.status, err_text)
                    raise RuntimeError(f"Ollama API error {resp.status}: {err_text}")

                data = await resp.json()

        if "error" in data:
            raise RuntimeError(f"Ollama error: {data['error']}")

        choice = data["choices"][0]
        msg = choice["message"]

        tool_calls: list[ToolCall] = []
        for tc in msg.get("tool_calls") or []:
            args = tc["function"].get("arguments", "{}")
            if isinstance(args, str):
                parsed = json.loads(args)
            else:
                parsed = args
            tool_calls.append(
                ToolCall(
                    id=tc["id"],
                    name=tc["function"]["name"],
                    arguments=parsed,
                )
            )

        return Response(
            text=msg.get("content"),
            tool_calls=tool_calls,
        )

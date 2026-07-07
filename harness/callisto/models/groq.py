"""Groq model — OpenAI-compatible /chat/completions endpoint (RFC 0003)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import aiohttp

from . import Response, ToolCall

_API_URL = "https://api.groq.com/openai/v1/chat/completions"
_DEFAULT_MODEL = "llama-3.3-70b-versatile"

log = logging.getLogger("callisto.groq")


class GroqModel:
    """
    Calls Groq's OpenAI-compatible chat completions API.

    Reads GROQ_API_KEY from the environment.
    """

    def __init__(
        self,
        model: str = _DEFAULT_MODEL,
        api_key: str | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> None:
        self.model = model
        self.api_key = api_key or os.environ.get("GROQ_API_KEY", "")
        if not self.api_key:
            raise ValueError(
                "GROQ_API_KEY is not set. "
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
        }

        max_retries = 4
        backoff = 3.0
        data = None

        for attempt in range(max_retries):
            async with aiohttp.ClientSession() as session:
                async with session.post(_API_URL, json=payload, headers=headers) as resp:
                    if resp.status == 429:
                        # Inspect Retry-After header if present, otherwise use backoff
                        retry_after_str = resp.headers.get("Retry-After")
                        try:
                            retry_after = float(retry_after_str) if retry_after_str else backoff
                        except ValueError:
                            retry_after = backoff

                        log.warning(
                            "Groq API rate-limited (429). Retrying in %.1f seconds... (Attempt %d/%d)",
                            retry_after, attempt + 1, max_retries
                        )
                        await asyncio.sleep(retry_after)
                        backoff *= 2.0
                        continue

                    resp.raise_for_status()
                    data = await resp.json()
                    break

        if data is None:
            raise RuntimeError("Failed to get response from Groq API after multiple retries.")

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

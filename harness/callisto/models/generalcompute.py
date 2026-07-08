"""General Compute model — REST API integration (RFC 0003)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from typing import Any

import aiohttp

from . import Response, ToolCall

_API_URL = "https://api.generalcompute.com/v1/chat/completions"
_DEFAULT_MODEL = "minimax-m2.7"

# Retry settings for 429 rate limits
_MAX_RETRIES = 8
_INITIAL_BACKOFF = 5.0
_MAX_BACKOFF = 60.0

log = logging.getLogger("callisto.generalcompute")


class GeneralComputeModel:
    """
    Calls General Compute's /v1/chat/completions REST endpoint.

    Reads GENERALCOMPUTE_API_KEY from the environment.
    """

    def __init__(
        self,
        model: str = _DEFAULT_MODEL,
        api_key: str | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> None:
        self.model = model
        self.api_key = api_key or os.environ.get("GENERALCOMPUTE_API_KEY", "")
        if not self.api_key:
            raise ValueError(
                "GENERALCOMPUTE_API_KEY is not set. "
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
            "stream": False,
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

        data = None

        for attempt in range(_MAX_RETRIES):
            async with aiohttp.ClientSession() as session:
                async with session.post(_API_URL, json=payload, headers=headers) as resp:
                    if resp.status == 429:
                        # Use Retry-After header if present, otherwise exponential backoff + jitter
                        retry_after_str = resp.headers.get("Retry-After")
                        if retry_after_str:
                            try:
                                sleep_secs = float(retry_after_str)
                            except ValueError:
                                sleep_secs = _INITIAL_BACKOFF
                        else:
                            base = _INITIAL_BACKOFF * (2.0 ** attempt)
                            jitter = base * 0.25 * random.random()
                            sleep_secs = min(base + jitter, _MAX_BACKOFF)

                        log.warning(
                            "General Compute API rate-limited (429). Retrying in %.1fs (attempt %d/%d)",
                            sleep_secs, attempt + 1, _MAX_RETRIES,
                        )
                        await asyncio.sleep(sleep_secs)
                        continue

                    if resp.status >= 400:
                        err_text = await resp.text()
                        log.error("General Compute API error (%d): %s", resp.status, err_text)
                        try:
                            err_data = json.loads(err_text)
                            msg = err_data.get("error", {}).get("message", err_text)
                        except Exception:
                            msg = err_text
                        raise RuntimeError(f"General Compute API error {resp.status}: {msg}")

                    data = await resp.json()
                    break

        if data is None:
            total_estimate = sum(
                min(_INITIAL_BACKOFF * (2 ** i), _MAX_BACKOFF)
                for i in range(_MAX_RETRIES)
            )
            raise RuntimeError(
                f"General Compute API rate limit exceeded after {_MAX_RETRIES} retries "
                f"(~{total_estimate}s total wait). "
                "Try reducing request frequency or upgrading your plan."
            )

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

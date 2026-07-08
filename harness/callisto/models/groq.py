"""Groq model — OpenAI-compatible /chat/completions endpoint (RFC 0003)."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
from typing import Any

import aiohttp

from . import Response, ToolCall

_API_URL = "https://api.groq.com/openai/v1/chat/completions"
_DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"

# Retry settings for 429 rate limits
_MAX_RETRIES = 10
_INITIAL_BACKOFF = 5.0
_MAX_BACKOFF = 60.0

# Proactive pacing: if remaining tokens drop below this threshold,
# add a short pre-request delay to let the rate-limit window refill.
_LOW_TOKENS_THRESHOLD = 2000
_PROACTIVE_DELAY_SECS = 8.0

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

        data = None
        last_remaining_tokens: int | None = None

        for attempt in range(_MAX_RETRIES):
            # Proactive pacing: if the previous response said tokens are critically low,
            # wait before hammering the API again — avoids burning retries on 429s.
            if last_remaining_tokens is not None and last_remaining_tokens < _LOW_TOKENS_THRESHOLD:
                log.info(
                    "Groq low remaining tokens (%d). Pausing %.1fs before next request.",
                    last_remaining_tokens, _PROACTIVE_DELAY_SECS,
                )
                await asyncio.sleep(_PROACTIVE_DELAY_SECS)

            async with aiohttp.ClientSession() as session:
                async with session.post(_API_URL, json=payload, headers=headers) as resp:
                    # Log rate-limit diagnostic headers when present
                    remaining_reqs = resp.headers.get("x-ratelimit-remaining-requests")
                    remaining_tokens_str = resp.headers.get("x-ratelimit-remaining-tokens")
                    if remaining_reqs or remaining_tokens_str:
                        log.info(
                            "Groq rate-limit state: requests_remaining=%s, tokens_remaining=%s",
                            remaining_reqs, remaining_tokens_str,
                        )
                    # Track remaining tokens for proactive pacing on next iteration
                    if remaining_tokens_str:
                        try:
                            last_remaining_tokens = int(remaining_tokens_str)
                        except ValueError:
                            pass

                    if resp.status in (429, 413):
                        # 429 = RPM exceeded, 413 = payload too large
                        # Use Retry-After header if present, otherwise exponential backoff + jitter
                        retry_after_str = resp.headers.get("Retry-After")
                        if retry_after_str:
                            try:
                                sleep_secs = float(retry_after_str)
                            except ValueError:
                                sleep_secs = _INITIAL_BACKOFF
                        else:
                            # Exponential backoff with random jitter (±25%)
                            base = _INITIAL_BACKOFF * (2.0 ** attempt)
                            jitter = base * 0.25 * random.random()
                            sleep_secs = min(base + jitter, _MAX_BACKOFF)

                        log.warning(
                            "Groq API rate-limited (%d). Remaining: requests=%s, tokens=%s. "
                            "Retrying in %.1fs (attempt %d/%d)",
                            resp.status, remaining_reqs or "?", remaining_tokens_str or "?",
                            sleep_secs, attempt + 1, _MAX_RETRIES,
                        )
                        await asyncio.sleep(sleep_secs)
                        continue

                    if resp.status >= 400:
                        err_text = await resp.text()
                        log.error("Groq API error (%d): %s", resp.status, err_text)
                        try:
                            err_data = json.loads(err_text)
                            msg = err_data.get("error", {}).get("message", err_text)
                        except Exception:
                            msg = err_text
                        raise RuntimeError(f"Groq API error {resp.status}: {msg}")

                    data = await resp.json()
                    break

        if data is None:
            total_estimate = sum(
                min(_INITIAL_BACKOFF * (2 ** i), _MAX_BACKOFF)
                for i in range(_MAX_RETRIES)
            )
            raise RuntimeError(
                f"Groq API rate limit exceeded after {_MAX_RETRIES} retries "
                f"(~{total_estimate}s total wait). "
                "Try reducing request frequency, using a smaller model, or upgrading your Groq plan."
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

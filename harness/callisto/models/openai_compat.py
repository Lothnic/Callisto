"""Shared OpenAI-compatible chat/completions client.

Used by Groq, OpenRouter, SiliconFlow, General Compute, and Ollama so retry,
session reuse, and tool-call parsing stay in one place.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
from typing import Any

import aiohttp

from . import Response, ToolCall

_DEFAULT_MAX_RETRIES = 8
_INITIAL_BACKOFF = 5.0
_MAX_BACKOFF = 60.0


def _parse_tool_arguments(raw: Any) -> dict[str, Any]:
    """Parse tool-call arguments; tolerate empty/malformed JSON from remote models."""
    if raw is None or raw == "":
        return {}
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {"_raw": raw}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {"_raw": parsed}
    except json.JSONDecodeError:
        # Common model glitch: trailing commas / partial JSON. Best-effort salvage.
        stripped = raw.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                repaired = re.sub(r",\s*}", "}", stripped)
                repaired = re.sub(r",\s*]", "]", repaired)
                parsed = json.loads(repaired)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                pass
        return {"_raw": raw}


def _parse_response(data: dict[str, Any]) -> Response:
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"provider returned no choices: {data!r}"[:500])
    choice = choices[0]
    msg = choice.get("message") or {}

    tool_calls: list[ToolCall] = []
    for tc in msg.get("tool_calls") or []:
        fn = tc.get("function") or {}
        name = fn.get("name") or ""
        if not name:
            continue
        tool_calls.append(
            ToolCall(
                id=tc.get("id") or f"call_{len(tool_calls)}",
                name=name,
                arguments=_parse_tool_arguments(fn.get("arguments", "{}")),
            )
        )

    return Response(
        text=msg.get("content"),
        tool_calls=tool_calls,
    )


class OpenAICompatibleModel:
    """
    Thin client for any OpenAI-shaped /chat/completions endpoint.

    Subclasses set class-level defaults (URL, env key, model, extra headers)
    or pass overrides to ``__init__``.
    """

    api_url: str = ""
    default_model: str = ""
    api_key_env: str | None = None
    provider_name: str = "provider"
    max_retries: int = _DEFAULT_MAX_RETRIES
    # Groq-style remaining-token pacing (optional).
    low_tokens_threshold: int | None = None
    proactive_delay_secs: float = 8.0
    # Retry on these HTTP statuses in addition to 429.
    extra_retry_statuses: frozenset[int] = frozenset()
    # Whether to force tool_choice=auto when tools are present.
    send_tool_choice: bool = True
    # Whether to include stream: false in the payload.
    send_stream_false: bool = False
    require_api_key: bool = True

    def __init__(
        self,
        model: str | None = None,
        api_key: str | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
        *,
        api_url: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> None:
        self.model = model or self.default_model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self._api_url = api_url or self.api_url
        self._extra_headers = extra_headers or {}
        self._log = logging.getLogger(f"callisto.{self.provider_name}")

        if self.require_api_key:
            env_name = self.api_key_env or ""
            self.api_key = api_key or (os.environ.get(env_name, "") if env_name else "")
            if not self.api_key:
                raise ValueError(
                    f"{env_name} is not set. Export it or pass api_key= explicitly."
                )
        else:
            self.api_key = api_key or ""

    def _headers(self) -> dict[str, str]:
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        headers.update(self._extra_headers)
        return headers

    def _payload(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": self.temperature,
        }
        if self.send_stream_false:
            payload["stream"] = False
        if self.max_tokens is not None:
            payload["max_tokens"] = self.max_tokens
        if tools:
            payload["tools"] = tools
            if self.send_tool_choice:
                payload["tool_choice"] = "auto"
        return payload

    def _error_message(self, err_text: str) -> str:
        try:
            err_data = json.loads(err_text)
            return err_data.get("error", {}).get("message", err_text)
        except Exception:
            return err_text

    def _retry_sleep(self, attempt: int, resp: aiohttp.ClientResponse) -> float:
        retry_after_str = resp.headers.get("Retry-After")
        if retry_after_str:
            try:
                return float(retry_after_str)
            except ValueError:
                pass
        base = _INITIAL_BACKOFF * (2.0**attempt)
        jitter = base * 0.25 * random.random()
        return min(base + jitter, _MAX_BACKOFF)

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> Response:
        payload = self._payload(messages, tools)
        headers = self._headers()
        data: dict[str, Any] | None = None
        last_remaining_tokens: int | None = None
        retry_statuses = {429, *self.extra_retry_statuses}

        async with aiohttp.ClientSession() as session:
            for attempt in range(self.max_retries):
                if (
                    self.low_tokens_threshold is not None
                    and last_remaining_tokens is not None
                    and last_remaining_tokens < self.low_tokens_threshold
                ):
                    self._log.info(
                        "%s low remaining tokens (%d). Pausing %.1fs before next request.",
                        self.provider_name,
                        last_remaining_tokens,
                        self.proactive_delay_secs,
                    )
                    await asyncio.sleep(self.proactive_delay_secs)

                async with session.post(
                    self._api_url, json=payload, headers=headers
                ) as resp:
                    remaining_reqs = resp.headers.get("x-ratelimit-remaining-requests")
                    remaining_tokens_str = resp.headers.get(
                        "x-ratelimit-remaining-tokens"
                    )
                    if remaining_reqs or remaining_tokens_str:
                        self._log.info(
                            "%s rate-limit state: requests_remaining=%s, tokens_remaining=%s",
                            self.provider_name,
                            remaining_reqs,
                            remaining_tokens_str,
                        )
                    if remaining_tokens_str:
                        try:
                            last_remaining_tokens = int(remaining_tokens_str)
                        except ValueError:
                            pass

                    if resp.status in retry_statuses:
                        sleep_secs = self._retry_sleep(attempt, resp)
                        self._log.warning(
                            "%s API rate-limited (%d). Remaining: requests=%s, tokens=%s. "
                            "Retrying in %.1fs (attempt %d/%d)",
                            self.provider_name,
                            resp.status,
                            remaining_reqs or "?",
                            remaining_tokens_str or "?",
                            sleep_secs,
                            attempt + 1,
                            self.max_retries,
                        )
                        await asyncio.sleep(sleep_secs)
                        continue

                    if resp.status >= 400:
                        err_text = await resp.text()
                        self._log.error(
                            "%s API error (%d): %s",
                            self.provider_name,
                            resp.status,
                            err_text,
                        )
                        msg = self._error_message(err_text)
                        raise RuntimeError(
                            f"{self.provider_name} API error {resp.status}: {msg}"
                        )

                    data = await resp.json()
                    break

        if data is None:
            total_estimate = sum(
                min(_INITIAL_BACKOFF * (2**i), _MAX_BACKOFF)
                for i in range(self.max_retries)
            )
            raise RuntimeError(
                f"{self.provider_name} API rate limit exceeded after "
                f"{self.max_retries} retries (~{total_estimate}s total wait). "
                "Try reducing request frequency, using a smaller model, or upgrading your plan."
            )

        if "error" in data and "choices" not in data:
            raise RuntimeError(f"{self.provider_name} error: {data['error']}")

        return _parse_response(data)

"""Ollama model — local inference via Ollama's OpenAI-compatible endpoint."""
from __future__ import annotations

import os

from .openai_compat import OpenAICompatibleModel

_API_URL = "http://localhost:11434/v1/chat/completions"
_DEFAULT_MODEL = "qwen2.5:0.5b"


class OllamaModel(OpenAICompatibleModel):
    """Calls a local Ollama instance (default localhost:11434)."""

    api_url = _API_URL
    default_model = _DEFAULT_MODEL
    api_key_env = None
    provider_name = "Ollama"
    require_api_key = False
    send_tool_choice = False
    send_stream_false = True
    max_retries = 1  # local server: fail fast, no rate-limit dance

    def __init__(
        self,
        model: str = _DEFAULT_MODEL,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> None:
        base = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
        super().__init__(
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            api_url=f"{base}/v1/chat/completions",
        )

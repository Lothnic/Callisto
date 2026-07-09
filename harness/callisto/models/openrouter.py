"""OpenRouter model — REST API integration (RFC 0003)."""
from __future__ import annotations

from .openai_compat import OpenAICompatibleModel

_API_URL = "https://openrouter.ai/api/v1/chat/completions"
_DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"


class OpenRouterModel(OpenAICompatibleModel):
    """
    Calls OpenRouter's /v1/chat/completions REST endpoint.

    Reads OPENROUTER_API_KEY from the environment.
    """

    api_url = _API_URL
    default_model = _DEFAULT_MODEL
    api_key_env = "OPENROUTER_API_KEY"
    provider_name = "OpenRouter"

    def __init__(
        self,
        model: str = _DEFAULT_MODEL,
        api_key: str | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> None:
        super().__init__(
            model=model,
            api_key=api_key,
            temperature=temperature,
            max_tokens=max_tokens,
            extra_headers={
                "HTTP-Referer": "https://github.com/Lothnic/callisto",
                "X-Title": "callisto",
            },
        )

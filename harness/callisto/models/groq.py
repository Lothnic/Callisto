"""Groq model — OpenAI-compatible /chat/completions endpoint (RFC 0003)."""
from __future__ import annotations

from .openai_compat import OpenAICompatibleModel

_API_URL = "https://api.groq.com/openai/v1/chat/completions"
_DEFAULT_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"


class GroqModel(OpenAICompatibleModel):
    """
    Calls Groq's OpenAI-compatible chat completions API.

    Reads GROQ_API_KEY from the environment.
    """

    api_url = _API_URL
    default_model = _DEFAULT_MODEL
    api_key_env = "GROQ_API_KEY"
    provider_name = "Groq"
    max_retries = 10
    low_tokens_threshold = 2000
    proactive_delay_secs = 8.0
    extra_retry_statuses = frozenset({413})

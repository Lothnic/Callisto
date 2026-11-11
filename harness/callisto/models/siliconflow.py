"""SiliconFlow model — REST API integration."""
from __future__ import annotations

import os

from .openai_compat import OpenAICompatibleModel

_API_URL = "https://api.siliconflow.com/v1/chat/completions"
_DEFAULT_MODEL = "tencent/Hy3"

# Prefer SILICONFLOW_KEY (repo convention); accept common aliases.
_API_KEY_ENVS = (
    "SILICONFLOW_KEY",
    "SILICONFLOW_API_KEY",
    "SILICONFLOW_API",
)


def _resolve_api_key(api_key: str | None) -> str | None:
    if api_key:
        return api_key
    for name in _API_KEY_ENVS:
        value = os.environ.get(name, "").strip().strip('"').strip("'")
        if value:
            return value
    return None


class SiliconFlowModel(OpenAICompatibleModel):
    """
    Calls SiliconFlow's /v1/chat/completions REST endpoint.

    Reads SILICONFLOW_KEY (or SILICONFLOW_API_KEY / SILICONFLOW_API) from the environment.
    """

    api_url = _API_URL
    default_model = _DEFAULT_MODEL
    api_key_env = "SILICONFLOW_KEY"
    provider_name = "SiliconFlow"
    send_stream_false = True
    # Transient gateway / overload errors are common on free-tier traffic.
    extra_retry_statuses = frozenset({500, 502, 503, 504})

    def __init__(
        self,
        model: str = _DEFAULT_MODEL,
        api_key: str | None = None,
        temperature: float = 0.0,
        max_tokens: int | None = None,
    ) -> None:
        resolved = _resolve_api_key(api_key)
        super().__init__(
            model=model,
            api_key=resolved,
            temperature=temperature,
            max_tokens=max_tokens,
        )

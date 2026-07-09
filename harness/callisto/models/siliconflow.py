"""SiliconFlow model — REST API integration."""
from __future__ import annotations

from .openai_compat import OpenAICompatibleModel

_API_URL = "https://api.siliconflow.com/v1/chat/completions"
_DEFAULT_MODEL = "tencent/Hy3"


class SiliconFlowModel(OpenAICompatibleModel):
    """
    Calls SiliconFlow's /v1/chat/completions REST endpoint.

    Reads SILICONFLOW_KEY from the environment.
    """

    api_url = _API_URL
    default_model = _DEFAULT_MODEL
    api_key_env = "SILICONFLOW_KEY"
    provider_name = "SiliconFlow"
    send_stream_false = True

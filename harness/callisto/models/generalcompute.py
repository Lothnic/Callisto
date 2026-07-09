"""General Compute model — REST API integration (RFC 0003)."""
from __future__ import annotations

from .openai_compat import OpenAICompatibleModel

_API_URL = "https://api.generalcompute.com/v1/chat/completions"
_DEFAULT_MODEL = "minimax-m2.7"


class GeneralComputeModel(OpenAICompatibleModel):
    """
    Calls General Compute's /v1/chat/completions REST endpoint.

    Reads GENERALCOMPUTE_API_KEY from the environment.
    """

    api_url = _API_URL
    default_model = _DEFAULT_MODEL
    api_key_env = "GENERALCOMPUTE_API_KEY"
    provider_name = "General Compute"
    send_stream_false = True

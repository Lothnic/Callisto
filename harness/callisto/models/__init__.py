"""Model abstraction layer (RFC 0003)."""
from __future__ import annotations

from typing import Any, Protocol, TypedDict


class ToolCall(TypedDict):
    id: str       # unique per call, matches what the provider sends
    name: str     # tool name: "bash" | "repl"
    arguments: dict[str, Any]


class Response(TypedDict):
    text: str | None
    tool_calls: list[ToolCall]


class ChatModel(Protocol):
    """Any object that can run a chat completion round-trip."""

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
    ) -> Response: ...


# Expose concrete implementations
from .openai_compat import OpenAICompatibleModel
from .openrouter import OpenRouterModel
from .groq import GroqModel
from .ollama import OllamaModel
from .siliconflow import SiliconFlowModel
from .generalcompute import GeneralComputeModel

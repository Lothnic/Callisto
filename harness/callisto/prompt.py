"""prompt.py — load the system prompt from prompts/system.md."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

_PROMPT_PATH = Path(__file__).parent / "prompts" / "system.md"


@lru_cache(maxsize=1)
def load_system_prompt() -> str:
    """
    Read and cache the system prompt from system.md.

    Cached after the first call — the prompt doesn't change at runtime.
    To reload during development, call load_system_prompt.cache_clear().
    """
    return _PROMPT_PATH.read_text(encoding="utf-8")


def system_message() -> dict[str, str]:
    """Return the system prompt formatted as an OpenAI-style message dict."""
    return {"role": "system", "content": load_system_prompt()}

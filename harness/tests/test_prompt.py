"""test_prompt.py — verify the system prompt stays within budget."""
from __future__ import annotations

from callisto.prompt import load_system_prompt

# Rough token budget: 1 token ≈ 4 chars; 12K tokens = 48K chars.
# Replace with tiktoken when available for precision.
MAX_CHARS = 48_000


def test_prompt_loads():
    """Prompt file exists and is non-empty."""
    text = load_system_prompt()
    assert isinstance(text, str)
    assert len(text) > 100, "System prompt is suspiciously short"


def test_prompt_within_token_budget():
    """Prompt is under the 12K-token (~48K char) budget specified in RFC 0003."""
    text = load_system_prompt()
    assert len(text) < MAX_CHARS, (
        f"System prompt too long: {len(text)} chars "
        f"(budget: {MAX_CHARS} chars ≈ 12K tokens)"
    )


def test_prompt_has_required_sections():
    """Smoke-check that the key sections are present."""
    text = load_system_prompt()
    for section in ("Capabilities", "Workflow", "Anti-patterns"):
        assert section in text, f"System prompt is missing section: {section!r}"

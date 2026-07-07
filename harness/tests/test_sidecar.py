"""
test_sidecar.py — integration tests for the Node sidecar.

These tests spawn a real callisto-sidecar subprocess. They require:
  - callisto-sidecar on $PATH (npm link inside packages/mini)
  - Chrome/Chromium available

Gate: CALLISTO_SMOKE=1 environment variable.
"""
from __future__ import annotations

import os
import pytest

from callisto.sidecar_client import SidecarClient, SidecarError

SKIP = not os.environ.get("CALLISTO_SMOKE")
SKIP_REASON = "set CALLISTO_SMOKE=1 to run sidecar integration tests"

NO_SANDBOX = os.environ.get("CALLISTO_NO_SANDBOX") == "1"


@pytest.fixture
async def client():
    """Start and yield a sidecar client; cleanly shut it down afterwards."""
    c = SidecarClient()
    await c.start()
    yield c
    try:
        await c.call("close", {})
    except Exception:
        pass
    c.terminate()


@pytest.mark.asyncio
@pytest.mark.skipif(SKIP, reason=SKIP_REASON)
async def test_launch_eval_close(client: SidecarClient):
    """Full lifecycle: launch → eval → close."""
    chrome_flags = ["--no-sandbox"] if NO_SANDBOX else []
    await client.call("launch", {"headless": True, "chromeFlags": chrome_flags})

    result = await client.call("eval", {"code": "return 1 + 1"})
    assert result["value"] == 2


@pytest.mark.asyncio
@pytest.mark.skipif(SKIP, reason=SKIP_REASON)
async def test_screenshot_returns_base64(client: SidecarClient):
    """mini.screenshot() should come back as { type: 'base64', data: '...' }."""
    chrome_flags = ["--no-sandbox"] if NO_SANDBOX else []
    await client.call("launch", {"headless": True, "chromeFlags": chrome_flags})
    await client.call("eval", {"code": "await mini.goto('about:blank')"})

    result = await client.call("eval", {"code": "return await mini.screenshot()"})
    value = result["value"]
    assert isinstance(value, dict), f"expected dict, got {type(value)}"
    assert value.get("type") == "base64", f"expected base64 encoding, got: {value}"
    assert isinstance(value.get("data"), str) and len(value["data"]) > 0


@pytest.mark.asyncio
@pytest.mark.skipif(SKIP, reason=SKIP_REASON)
async def test_eval_mini_close_is_blocked(client: SidecarClient):
    """mini.close() inside eval must return an error, not crash the sidecar."""
    chrome_flags = ["--no-sandbox"] if NO_SANDBOX else []
    await client.call("launch", {"headless": True, "chromeFlags": chrome_flags})

    with pytest.raises(SidecarError, match="not callable from eval"):
        await client.call("eval", {"code": "await mini.close(); return 'ok'"})

    # Sidecar should still be alive after the blocked call
    result = await client.call("eval", {"code": "return 'still alive'"})
    assert result["value"] == "still alive"


@pytest.mark.asyncio
@pytest.mark.skipif(SKIP, reason=SKIP_REASON)
async def test_100kb_truncation(client: SidecarClient):
    """Output over 100KB should be returned with truncated: true."""
    chrome_flags = ["--no-sandbox"] if NO_SANDBOX else []
    await client.call("launch", {"headless": True, "chromeFlags": chrome_flags})

    # Generate a string > 100 KB
    result = await client.call("eval", {"code": "return 'x'.repeat(200 * 1024)"})
    assert result.get("truncated") is True
    assert isinstance(result.get("value"), str)
    assert len(result["value"]) <= 100 * 1024 + 100  # small fudge for JSON overhead


@pytest.mark.asyncio
@pytest.mark.skipif(SKIP, reason=SKIP_REASON)
async def test_eval_syntax_error_returns_error_not_crash(client: SidecarClient):
    """Syntax errors inside eval must return { ok: false }, not crash the process."""
    chrome_flags = ["--no-sandbox"] if NO_SANDBOX else []
    await client.call("launch", {"headless": True, "chromeFlags": chrome_flags})

    with pytest.raises(SidecarError):
        await client.call("eval", {"code": "this is not valid JS @@@"})

    # Sidecar still responsive
    result = await client.call("eval", {"code": "return 42"})
    assert result["value"] == 42


@pytest.mark.asyncio
@pytest.mark.skipif(SKIP, reason=SKIP_REASON)
async def test_unknown_method_returns_error(client: SidecarClient):
    """Calling an unknown method returns { ok: false }, no crash."""
    with pytest.raises(SidecarError, match="unknown method"):
        await client.call("nonexistent", {})

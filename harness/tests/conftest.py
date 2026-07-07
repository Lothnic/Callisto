import pytest

@pytest.fixture
def fake_sidecar_client():
    class FakeSidecarClient:
        """In-process fake — no subprocess, no Node, no Chrome."""

        def __init__(self, eval_result: dict | None = None, raise_on_call: Exception | None = None):
            self._eval_result = eval_result or {"value": "fake-result"}
            self._raise = raise_on_call
            self.calls: list[tuple[str, dict]] = []

        async def call(self, method: str, params: dict, **_kwargs) -> dict:
            self.calls.append((method, params))
            if self._raise:
                raise self._raise
            if method == "eval":
                return self._eval_result
            return {"ok": True}

    return FakeSidecarClient

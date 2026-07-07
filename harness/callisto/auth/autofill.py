"""autofill.py — intercept signin markers, fill from keychain, purge history.

Marker matching uses a CLOSED ALLOWLIST of function names — not regex, not
startswith. The model will hallucinate variations; anything not in the
allowlist is a hallucination → log + return error → model reconsiders.

Fail-loud on sidecar failure: if the sidecar is dead when autofill is
needed, raise AutofillUnavailableError. Do NOT fall back to bash typing
the password. The fail-loud principle beats fail-silent.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from . import keychain
from ..audit import AuditLog
from ..sidecar_client import SidecarClient, SidecarDead

log = logging.getLogger(__name__)

# -----------------------------------------------------------------------
# Closed allowlist — exact function names only
# -----------------------------------------------------------------------

SIGNIN_MARKERS: frozenset[str] = frozenset({
    "__callisto_signin",
    "__callisto_login",
})

# Regex to parse: __callisto_signin('cred-id', 'ax-ref')
# Matches both single and double quotes, with optional whitespace.
_PARSE_RE = re.compile(
    r"^(?:__callisto_signin|__callisto_login)\s*\(\s*"
    r"""(['"])(.+?)\1\s*,\s*(['"])(.+?)\3\s*\)""",
)


class AutofillUnavailableError(Exception):
    """Sidecar is offline — cannot autofill securely."""


class CredentialNotFoundError(Exception):
    """The requested credential ID is not in the keychain."""


# -----------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------

def is_signin_call(code: str) -> bool:
    """
    Check if `code` is a signin marker call.

    Uses a closed allowlist — NOT regex, NOT startswith.
    Only exact function names from SIGNIN_MARKERS are accepted.
    """
    stripped = code.strip()
    for marker in SIGNIN_MARKERS:
        # Exact function name followed by opening paren
        if stripped.startswith(marker + "("):
            return True
    return False


def parse_signin_call(code: str) -> tuple[str, str] | None:
    """
    Parse a signin marker call and extract (credential_id, ref).

    Returns None if the code doesn't match the expected format.
    Logs a warning for malformed calls.
    """
    stripped = code.strip()
    m = _PARSE_RE.match(stripped)
    if m:
        return m.group(2), m.group(4)

    log.warning("signin marker detected but malformed: %r", stripped[:100])
    return None


async def do_autofill(
    code: str,
    client: SidecarClient,
    audit: AuditLog,
) -> dict[str, Any]:
    """
    Execute a signin autofill:
    1. Parse credential_id and ref from the marker call
    2. Fetch secret from OS keychain
    3. Type it into the page via sidecar
    4. Log the autofill event (no secret!)

    Raises:
        AutofillUnavailableError — sidecar is dead, cannot type securely
        CredentialNotFoundError  — credential_id not in keychain
        ValueError              — malformed signin call
    """
    parsed = parse_signin_call(code)
    if not parsed:
        raise ValueError(
            f"Malformed signin call: {code[:80]!r}. "
            f"Expected: __callisto_signin('credential-id', 'ax-ref')"
        )

    credential_id, ref = parsed

    # Fetch from keychain
    secret = keychain.get(credential_id)
    if secret is None:
        raise CredentialNotFoundError(
            f"Credential '{credential_id}' not found in keychain. "
            f"Add it with: callisto creds add {credential_id}"
        )

    # Type into the page — fail-loud on sidecar failure
    fill_code = f"await mini.fill({json.dumps(ref)}, {json.dumps(secret)})"
    try:
        result = await client.call("eval", {"code": fill_code})
    except SidecarDead:
        raise AutofillUnavailableError(
            "Sidecar offline; cannot autofill securely. "
            "Do NOT fall back to typing the password via bash."
        )

    # Log the autofill event — NEVER log the secret
    audit.record_autofill(credential_id, ref)
    log.info("autofill: filled credential '%s' into ref '%s'", credential_id, ref)

    return {"value": None, "_note": f"[autofill: typed credential '{credential_id}' into '{ref}']"}


def purge_secret_from_history(
    history: list[dict[str, Any]],
    credential_id: str,
) -> None:
    """
    Scan history and redact any occurrence of the credential's secret value.

    This is called after do_autofill() and before the next model.chat() call.
    Replaces the actual secret with [REDACTED] in all message content.
    """
    secret = keychain.get(credential_id)
    if secret is None:
        return  # nothing to purge

    for msg in history:
        content = msg.get("content")
        if isinstance(content, str) and secret in content:
            msg["content"] = content.replace(secret, "[REDACTED]")

        # Also check tool_calls arguments (serialised JSON)
        for tc in msg.get("tool_calls") or []:
            fn = tc.get("function", {})
            args = fn.get("arguments", "")
            if isinstance(args, str) and secret in args:
                fn["arguments"] = args.replace(secret, "[REDACTED]")

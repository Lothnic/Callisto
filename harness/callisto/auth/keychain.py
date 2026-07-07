"""keychain.py — OS keychain wrapper using the `keyring` library.

All credentials are stored under service name "callisto". Credential IDs
are user-defined strings (e.g., "github-work", "aws-staging").

The keyring library abstracts:
    - macOS Keychain
    - Linux libsecret (GNOME Keyring, KWallet)
    - Windows Credential Manager
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger(__name__)

SERVICE_NAME = "callisto"

# Index file for listing credentials (keyring has no native list API)
_INDEX_KEY = "__callisto_credential_index"
_INDEX_SEP = "\n"


def _get_keyring() -> Any:
    """Import keyring lazily so it's an optional dependency."""
    try:
        import keyring
        return keyring
    except ImportError:
        raise ImportError(
            "The 'keyring' package is required for credential management. "
            "Install it with: pip install keyring"
        )


def get(credential_id: str) -> str | None:
    """
    Retrieve a credential from the OS keychain.

    Returns None if the credential doesn't exist.
    """
    kr = _get_keyring()
    secret = kr.get_password(SERVICE_NAME, credential_id)
    if secret is None:
        log.warning("credential '%s' not found in keychain", credential_id)
    return secret


def set_(credential_id: str, secret: str) -> None:
    """
    Store a credential in the OS keychain.

    Overwrites if the credential already exists.
    """
    kr = _get_keyring()
    kr.set_password(SERVICE_NAME, credential_id, secret)
    _add_to_index(credential_id)
    log.info("credential '%s' stored in keychain", credential_id)


def delete(credential_id: str) -> None:
    """
    Delete a credential from the OS keychain.

    Raises keyring.errors.PasswordDeleteError if it doesn't exist.
    """
    kr = _get_keyring()
    try:
        kr.delete_password(SERVICE_NAME, credential_id)
    except Exception as exc:
        log.warning("failed to delete credential '%s': %s", credential_id, exc)
        raise
    _remove_from_index(credential_id)
    log.info("credential '%s' deleted from keychain", credential_id)


def list_ids() -> list[str]:
    """
    List all stored credential IDs.

    Uses a hidden index key since keyring has no native list API.
    """
    kr = _get_keyring()
    raw = kr.get_password(SERVICE_NAME, _INDEX_KEY)
    if not raw:
        return []
    return [cid for cid in raw.split(_INDEX_SEP) if cid]


def _add_to_index(credential_id: str) -> None:
    kr = _get_keyring()
    ids = set(list_ids())
    ids.add(credential_id)
    kr.set_password(SERVICE_NAME, _INDEX_KEY, _INDEX_SEP.join(sorted(ids)))


def _remove_from_index(credential_id: str) -> None:
    kr = _get_keyring()
    ids = set(list_ids())
    ids.discard(credential_id)
    if ids:
        kr.set_password(SERVICE_NAME, _INDEX_KEY, _INDEX_SEP.join(sorted(ids)))
    else:
        try:
            kr.delete_password(SERVICE_NAME, _INDEX_KEY)
        except Exception:
            pass

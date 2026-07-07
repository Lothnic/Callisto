"""sandbox.py — OS-level isolation for the bash tool.

Linux:  bubblewrap (bwrap) — filesystem + network isolation.
macOS:  sandbox-exec with a generated profile (deprecated but functional).
Other:  unsandboxed with a warning.

The sandbox is a defense-in-depth layer for bash. The browser (via the
sidecar) is NOT sandboxed — Chrome has full network and full filesystem
access within the user's account. See SECURITY.md for the honest threat model.
"""
from __future__ import annotations

import logging
import os
import platform
import shlex
import shutil
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

# -----------------------------------------------------------------------
# macOS sandbox-exec profile
# -----------------------------------------------------------------------

_MACOS_PROFILE_TEMPLATE = """\
(version 1)
(deny default)

;; Allow read access to everything
(allow file-read*)

;; Allow write access only to the session scratch directory
(allow file-write*
    (subpath "{scratch_dir}"))

;; Allow write to /dev/null, /dev/zero, etc.
(allow file-write* (subpath "/dev"))

;; Allow process execution
(allow process-exec)
(allow process-fork)

;; Deny network access
(deny network*)

;; Allow sysctl reads (needed by many commands)
(allow sysctl-read)
"""


def _detect_sandbox() -> str:
    """Detect available sandbox mechanism. Returns 'bwrap', 'sandbox-exec', or 'none'."""
    system = platform.system()

    if system == "Linux":
        if shutil.which("bwrap"):
            return "bwrap"
        log.warning(
            "bubblewrap (bwrap) not found on $PATH. "
            "Install it for bash sandboxing: apt install bubblewrap"
        )
        return "none"

    if system == "Darwin":
        if shutil.which("sandbox-exec"):
            return "sandbox-exec"
        log.warning(
            "sandbox-exec not found. "
            "On macOS, bash runs without OS-level isolation."
        )
        return "none"

    log.warning(
        "OS '%s' has no supported sandbox. "
        "Bash runs without OS-level isolation.",
        system,
    )
    return "none"


def wrap_command(cmd: str, session_dir: str | Path) -> str:
    """
    Wrap `cmd` with OS-level sandbox restrictions.

    Args:
        cmd:         The shell command to sandbox.
        session_dir: The session scratch directory (writable inside sandbox).

    Returns:
        The sandboxed command string. If no sandbox is available, returns
        `cmd` unchanged with a warning logged.
    """
    session_path = Path(session_dir)
    scratch_dir = session_path / "scratch"
    scratch_dir.mkdir(parents=True, exist_ok=True)

    mechanism = _detect_sandbox()

    if mechanism == "bwrap":
        return _wrap_bwrap(cmd, str(scratch_dir))

    if mechanism == "sandbox-exec":
        return _wrap_sandbox_exec(cmd, str(scratch_dir))

    # No sandbox available — run unsandboxed
    log.warning("bash running WITHOUT sandbox isolation for: %s", cmd[:80])
    return cmd


def _wrap_bwrap(cmd: str, scratch_dir: str) -> str:
    """Wrap with bubblewrap (Linux)."""
    parts = [
        "bwrap",
        "--ro-bind", "/", "/",                    # read-only root
        "--bind", scratch_dir, scratch_dir,        # writable scratch
        "--dev", "/dev",
        "--proc", "/proc",
        "--tmpfs", "/tmp",
        "--unshare-net",                           # no network
        "--die-with-parent",                       # kill if parent dies
        "--", "/bin/sh", "-c", cmd,
    ]
    return " ".join(shlex.quote(p) for p in parts)


def _wrap_sandbox_exec(cmd: str, scratch_dir: str) -> str:
    """Wrap with sandbox-exec (macOS)."""
    # Write a temporary profile file
    profile_content = _MACOS_PROFILE_TEMPLATE.format(scratch_dir=scratch_dir)

    # Use a deterministic path so we don't leak tempfiles
    profile_dir = Path(scratch_dir) / ".sandbox"
    profile_dir.mkdir(parents=True, exist_ok=True)
    profile_path = profile_dir / "profile.sb"
    profile_path.write_text(profile_content, encoding="utf-8")

    parts = [
        "sandbox-exec", "-f", str(profile_path),
        "/bin/sh", "-c", cmd,
    ]
    return " ".join(shlex.quote(p) for p in parts)

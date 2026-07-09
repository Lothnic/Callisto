"""Human-readable progress for CLI/chat — what happened, what's next, issues.

Other harnesses narrate the run; Callisto used to print opaque step lines.
This module formats loop progress events into a scannable transcript.
"""
from __future__ import annotations

import re
from typing import Any, Callable

import click

from .history import shorten


def _fg(text: str, color: str) -> str:
    return click.style(text, fg=color)


def format_session_banner(
    *,
    task: str,
    provider: str,
    model: str,
    headless: bool,
    max_steps: int,
    no_sandbox: bool = False,
    ui: bool = False,
) -> list[str]:
    mode = "HEADLESS (no window — browser runs in the background)" if headless else (
        "VISIBLE (you should see a BrowserOS/Chrome window)"
    )
    lines = [
        "",
        _fg("═" * 64, "bright_black"),
        _fg("  CALLISTO RUN", "bright_white"),
        _fg("═" * 64, "bright_black"),
        f"  Task       {shorten(task, 70)}",
        f"  Model      {provider}/{model}",
        f"  Browser    {_fg(mode, 'yellow' if headless else 'green')}",
        f"  Steps      max {max_steps}",
    ]
    if no_sandbox:
        lines.append(f"  Sandbox    {_fg('Chrome --no-sandbox', 'yellow')}")
    if ui:
        lines.append("  UI         sidebar WebSocket on :54321")
    if headless:
        lines.append(
            f"  Tip        {_fg('Use --visible / --no-headless to watch the browser', 'bright_black')}"
        )
    else:
        lines.append(
            f"  Tip        {_fg('If no window appears, check DISPLAY and BrowserOS binary', 'bright_black')}"
        )
    lines.append(_fg("─" * 64, "bright_black"))
    lines.append("")
    return lines


def _extract_url_hint(text: str) -> str | None:
    # Prefer explicit page.goto target in action detail
    m = re.search(r"page\.goto\(\s*['\"]([^'\"]+)['\"]", text)
    if m:
        return m.group(1)
    m = re.search(r"https?://[^\s'\"<>]+", text)
    if m:
        return m.group(0).rstrip(".,);]")
    return None


def _issue_lines(event: dict[str, Any]) -> list[str]:
    issues = list(event.get("issues") or [])
    summary = event.get("summary") or {}
    detail = str(summary.get("detail") or "")
    title = str(summary.get("title") or "")
    blob = f"{title}\n{detail}".lower()

    if summary.get("ok") is False and "error" not in " ".join(issues).lower():
        err = detail or title
        if err:
            issues.append(err)

    if any(x in blob for x in ("blocked", "unable to access", "captcha", "access denied")):
        if not any("block" in i.lower() for i in issues):
            issues.append("Bot-wall / access block page detected")
    if "stuck" in blob or "repeated the same" in blob or "thrashing" in blob:
        if not any("stuck" in i.lower() or "thrash" in i.lower() for i in issues):
            issues.append("Loop recovery: repeated/thrashing action")
    if "single-action discipline" in blob:
        issues.append("Model tried multiple tools in one turn (only first ran)")

    # Dedup preserve order
    seen: set[str] = set()
    out: list[str] = []
    for i in issues:
        key = i.strip()
        if key and key not in seen:
            seen.add(key)
            out.append(key)
    return out


class ProgressPrinter:
    """Stateful CLI narrator for one run."""

    def __init__(self, *, verbose: bool = False) -> None:
        self.verbose = verbose
        self._last_action: str | None = None
        self._step_count = 0
        self._issue_count = 0
        self._last_url: str | None = None

    def echo_banner(self, **kwargs: Any) -> None:
        for line in format_session_banner(**kwargs):
            click.echo(line)

    def handle(self, event: dict[str, Any]) -> None:
        typ = event.get("type")
        if typ == "session":
            self._on_session(event)
        elif typ == "thought":
            self._on_thought(event)
        elif typ == "step_start":
            self._on_step_start(event)
        elif typ == "step_end":
            self._on_step_end(event)
        elif typ == "final":
            self._on_final(event)
        elif typ == "status":
            self._on_status(event)

    def _on_session(self, event: dict[str, Any]) -> None:
        click.echo(_fg(f"  ● Browser ready  headless={event.get('headless')}  "
                       f"url={event.get('url') or '(blank)'}", "green"))
        if event.get("note"):
            click.echo(_fg(f"    {event['note']}", "bright_black"))
        click.echo("")

    def _on_status(self, event: dict[str, Any]) -> None:
        msg = event.get("message") or ""
        phase = event.get("phase") or ""
        if phase == "model_wait":
            click.echo(_fg(f"  ⏳ {msg}", "cyan"))
        elif phase == "model_done":
            ms = event.get("duration_ms")
            if isinstance(ms, (int, float)) and ms >= 5000:
                click.echo(
                    _fg(
                        f"  ⏱  {msg}  (slow model latency — not the browser)",
                        "yellow",
                    )
                )
            else:
                click.echo(_fg(f"  ⏱  {msg}", "bright_black"))
        else:
            click.echo(_fg(f"  ℹ {msg}", "cyan"))

    def _on_thought(self, event: dict[str, Any]) -> None:
        text = (event.get("text") or "").strip()
        if not text:
            return
        # Always show a short "thinking" line so the run isn't a black box
        click.echo(_fg(f"  💭 thinking  {shorten(text, 160)}", "bright_black"))
        if self.verbose and len(text) > 160:
            for line in text.splitlines()[:12]:
                click.echo(_fg(f"      {line}", "bright_black"))

    def _on_step_start(self, event: dict[str, Any]) -> None:
        self._step_count = int(event.get("step", 0)) + 1
        summary = event.get("summary") or {}
        title = summary.get("title") or event.get("call", {}).get("name", "tool")
        detail = summary.get("detail") or ""
        url = event.get("url") or _extract_url_hint(detail) or _extract_url_hint(title)
        if url:
            self._last_url = url

        step = event.get("step", 0)
        click.echo("")
        click.echo(_fg(f"┌─ step {step} ───────────────────────────────────────", "bright_black"))
        click.echo(_fg("│ DOING    ", "yellow") + str(title))
        if detail and detail != title and self.verbose:
            click.echo(_fg("│ CODE     ", "bright_black") + shorten(str(detail), 100))
        if self._last_url:
            click.echo(_fg("│ URL      ", "bright_black") + self._last_url)
        if self._last_action:
            click.echo(_fg("│ PREV     ", "bright_black") + self._last_action)
        self._last_action = str(title)

    def _on_step_end(self, event: dict[str, Any]) -> None:
        summary = event.get("summary") or {}
        ok = summary.get("ok", True)
        title = summary.get("title") or ("ok" if ok else "error")
        detail = summary.get("detail") or ""
        step = event.get("step", 0)
        url = event.get("url") or _extract_url_hint(str(detail))
        if url:
            self._last_url = url

        mark = _fg("✓", "green") if ok else _fg("✗", "red")
        click.echo(_fg("│ RESULT   ", "green" if ok else "red") + f"{mark} {title}")

        issues = _issue_lines(event)
        for issue in issues:
            self._issue_count += 1
            click.echo(_fg("│ ISSUE    ", "red") + shorten(issue, 120))

        # Show a short evidence snippet (not full a11y trees unless verbose)
        if detail and ok:
            snippet = detail
            if "[ax-" in snippet and not self.verbose:
                # one-line snapshot stats already in title; skip huge trees
                if "Snapshot:" not in str(title):
                    click.echo(_fg("│ SEEN     ", "bright_black") + shorten(snippet, 100))
            elif not issues:
                click.echo(_fg("│ SEEN     ", "bright_black") + shorten(snippet, 100))
        elif detail and not ok and not issues:
            click.echo(_fg("│ DETAIL   ", "red") + shorten(str(detail), 120))

        if event.get("next_hint"):
            click.echo(_fg("│ NEXT     ", "cyan") + str(event["next_hint"]))
        elif issues:
            click.echo(
                _fg("│ NEXT     ", "cyan")
                + "Change strategy or stop with partial answer from evidence"
            )
        else:
            click.echo(
                _fg("│ NEXT     ", "cyan")
                + "Model will decide: act again or give final answer"
            )

        if self._last_url:
            click.echo(_fg("│ BROWSER  ", "bright_black") + f"last url → {self._last_url}")
        click.echo(_fg(f"└─ end step {step}", "bright_black"))

    def _on_final(self, event: dict[str, Any]) -> None:
        text = event.get("text") or ""
        click.echo("")
        click.echo(_fg("═" * 64, "bright_black"))
        click.echo(_fg("  DONE", "green"))
        click.echo(
            f"  Steps used ~{self._step_count}   issues flagged {self._issue_count}"
            + (f"   last url {self._last_url}" if self._last_url else "")
        )
        click.echo(_fg("─" * 64, "bright_black"))
        click.echo(text)
        click.echo(_fg("═" * 64, "bright_black"))
        click.echo("")


def make_progress_callback(
    printer: ProgressPrinter,
    broadcast: Callable | None = None,
) -> Callable:
    async def progress(event: dict[str, Any]) -> None:
        if broadcast is not None:
            await broadcast(event)
        printer.handle(event)

    return progress

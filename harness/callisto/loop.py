"""loop.py — the agent loop (RFC 0003 + RFC 0004 amendments).

Control flow:
  model.chat → if tools: execute one → history
            → if no tools: accept final only if it looks like an answer
  soft-stuck: identical action → nudge, don't hard-kill on first thrash
  near budget: force decide
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .approvals import check_approval
from .audit import AuditLog
from .auth.autofill import (
    AutofillUnavailableError,
    CredentialNotFoundError,
    is_signin_call,
    parse_signin_call,
    purge_secret_from_history,
)
from .budget import BudgetExceededError, BudgetTracker
from .compaction import compact
from .control import (
    BUDGET_NUDGE,
    CONTENT_THRASH_NUDGE,
    CONTINUE_NUDGE,
    FAMILY_THRASH_AT,
    FORCE_FINAL_NUDGE,
    PINGPONG_NUDGE,
    PINGPONG_WINDOW,
    STUCK_NUDGE,
    action_family,
    blank_page_noop_reason,
    extract_click_ref,
    extract_url_from_result,
    extract_urls_from_text,
    invented_goto_reason,
    is_acceptable_final,
    is_pingpong,
    navigation_failure_note,
    parse_goto_url,
    result_looks_blocked,
)
from .history import (
    assistant_tool_call_msg,
    assistant_tool_calls_msg,
    find_last_snapshot,
    prune_old_snapshots,
    result_summary,
    tool_result_msg,
    tool_summary,
    user_msg,
)
from .memory import MemoryStore
from .models import ChatModel
from .prompt import system_message
from .scratchpad import write_scratchpad
from .sidecar_client import SidecarClient, SidecarDead
from .tools import ask as ask_tool
from .tools.dispatch import TOOL_SCHEMAS, execute, tool_call_fingerprint
from .tools.repl import repl

# Re-exports for tests and callers that import from callisto.loop
__all__ = [
    "MAX_STEPS",
    "STUCK_THRESHOLD",
    "TOOL_SCHEMAS",
    "prune_old_snapshots",
    "run",
    "tool_call_fingerprint",
    "_tool_call_fingerprint",
]

log = logging.getLogger(__name__)

MAX_STEPS = 40
# Soft stuck after this many identical fingerprints in a row (nudge, don't kill).
STUCK_THRESHOLD = 3
# After a soft stuck nudge, hard-fail if the same fingerprint continues this many more times.
STUCK_HARD_EXTRA = 2
# Reject empty/planning "finals" at most this many times per run.
MAX_CONTINUE_NUDGES = 4
# Soft-stuck nudges before we force a final-answer request.
MAX_STUCK_NUDGES = 2

# Backward-compatible private alias used by tests.
_tool_call_fingerprint = tool_call_fingerprint


async def _emit(progress_callback: Callable | None, event: dict[str, Any]) -> None:
    if not progress_callback:
        return
    res = progress_callback(event)
    if asyncio.iscoroutine(res):
        await res


async def run(
    task: str,
    model: ChatModel,
    client: SidecarClient,
    *,
    max_steps: int = MAX_STEPS,
    session_id: str | None = None,
    require_approval: bool = True,
    auto_approve: set[str] | None = None,
    budget: BudgetTracker | None = None,
    memory: MemoryStore | None = None,
    history: list[dict[str, Any]] | None = None,
    token_budget: int = 80000,
    progress_callback: Callable[[dict[str, Any]], Any] | None = None,
    verbose: bool = False,
) -> str:
    """
    Run the agent loop for `task`.

    Returns the model's final text answer.

    Raises:
        RuntimeError on max_steps exceeded or unrecoverable stuck thrashing.
        SidecarDead if Chrome crashes and the restart budget is exhausted.
        BudgetExceededError if cost or turn limit is exceeded.
    """
    sid = session_id or str(uuid.uuid4())
    audit = AuditLog(sid)
    session_dir = str(Path.home() / ".callisto" / "sessions" / sid)
    budget = budget or BudgetTracker()
    t_start = time.monotonic()

    audit.record_session_start(task, getattr(model, "model", "unknown"))

    is_new_session = history is None
    if history is None:
        # Seed browser state so the model does not burn turns on blank-page no-ops.
        history = [user_msg(
            f"{task}\n\n"
            "[Browser state] Current URL: about:blank. "
            "Your FIRST tool call must navigate with "
            "`await page.goto('https://…')` to a site relevant to this task, "
            "then snapshot. Do not snapshot or call page.url() while still on about:blank."
        )]
    else:
        history.append(user_msg(task))

    if is_new_session and memory and memory.available:
        try:
            memories = memory.retrieve(task, k=3)
            if memories:
                context = memory.format_for_context(memories)
                if context:
                    history.insert(0, user_msg(context))
                    audit.record_memory_retrieve(
                        task,
                        len(memories),
                        memories[0].similarity if memories else 0.0,
                    )
        except Exception as exc:
            log.warning("memory retrieval failed: %s", exc)
            audit.record_error("memory_retrieve", str(exc))

    last_fingerprint: str | None = None
    consecutive_identical = 0
    continue_nudges = 0
    stuck_nudges = 0
    budget_nudged = False
    force_final_mode = False
    consecutive_blocked = 0
    last_family: str | None = None
    consecutive_family = 0
    family_history: list[str] = []
    last_click_ref: str | None = None
    same_click_count = 0
    # Tracked so we can block blank-page no-ops and avoid useless URL probes.
    current_url: str | None = "about:blank"
    # URLs / text observed in tool results — goto targets must be grounded.
    grounded_urls: set[str] = set()
    grounded_text_parts: list[str] = []

    def _ingest_grounding(text: str | None) -> None:
        if text:
            grounded_urls.update(extract_urls_from_text(text))
            grounded_text_parts.append(text)

    # Seed any URLs already present in history (chat continuations).
    for msg in history:
        content = msg.get("content")
        if isinstance(content, str):
            _ingest_grounding(content)

    for step in range(max_steps):
        # Near end of budget: one-time force-decide message
        if not budget_nudged and step >= max(1, max_steps - 3):
            budget_nudged = True
            history.append(user_msg(BUDGET_NUDGE))
            log.info("step %d: budget nudge injected", step)

        pruned_history = prune_old_snapshots(history)

        messages, compaction_info = await compact(
            [system_message()] + pruned_history,
            token_budget=token_budget,
            model=model,
        )
        if compaction_info:
            audit.record_compaction(
                compaction_info["turns_dropped"],
                compaction_info["summary_used"],
                compaction_info["token_savings"],
            )

        # First model call is often 20–40s on free/remote APIs — surface the wait.
        t_model = time.monotonic()
        await _emit(progress_callback, {
            "type": "status",
            "phase": "model_wait",
            "step": step,
            "message": (
                f"Waiting for model (step {step})… "
                "first reply is often slow on remote APIs"
                if step == 0
                else f"Waiting for model (step {step})…"
            ),
        })
        try:
            resp = await model.chat(messages, TOOL_SCHEMAS)
        except SidecarDead:
            audit.record_task_end("error", "SidecarDead mid-chat")
            raise
        except Exception as exc:
            log.error("model.chat() raised: %s", exc, exc_info=True)
            raise RuntimeError(f"model.chat() failed: {exc}") from exc
        model_ms = (time.monotonic() - t_model) * 1000
        await _emit(progress_callback, {
            "type": "status",
            "phase": "model_done",
            "step": step,
            "message": f"Model responded in {model_ms / 1000:.1f}s",
            "duration_ms": model_ms,
        })

        audit.record_model_output({
            "text": resp.get("text", "")[:500] if resp.get("text") else None,
            "tool_calls": resp.get("tool_calls"),
        })

        thought = (resp.get("text") or "").strip()
        if thought:
            await _emit(progress_callback, {"type": "thought", "text": thought, "step": step})

        resp_json = json.dumps(resp, default=str)
        input_tokens = sum(len(json.dumps(m)) for m in messages) // 4
        output_tokens = len(resp_json) // 4
        budget.record_turn(input_tokens, output_tokens)

        try:
            warning = budget.check()
            if warning == "warning":
                audit.record_budget_warning(
                    budget.total_cost, budget.max_cost, budget.cost_percentage,
                )
        except BudgetExceededError as exc:
            audit.record_budget_exceeded(budget.total_cost, budget.max_cost)
            audit.record_task_end("error", str(exc))
            raise

        # Near hard budget: refuse more tools, demand a text answer
        if force_final_mode and resp.get("tool_calls"):
            log.info("step %d: force_final_mode — rejecting tool call", step)
            history.append(assistant_tool_calls_msg(resp["tool_calls"][:1]))
            history.append(tool_result_msg(
                resp["tool_calls"][0]["id"],
                {"error": FORCE_FINAL_NUDGE},
            ))
            history.append(user_msg(
                "No more tools. Reply with your final answer only, using evidence "
                "already in this conversation (products, prices, colors, URLs)."
            ))
            write_scratchpad(history)
            continue

        # ── No tool call → candidate final answer ───────────────────────
        if not resp["tool_calls"]:
            final = thought

            if is_acceptable_final(final, step=step) or (
                force_final_mode and final
            ):
                log.info("step %d: final answer accepted (%.100r)", step, final)
                audit.record_task_end("success", final[:500])
                if memory and memory.available:
                    try:
                        memory.store(task, final[:500])
                        audit.record_memory_store(task, len(final))
                    except Exception as exc:
                        log.warning("memory store failed: %s", exc)
                duration_s = time.monotonic() - t_start
                audit.record_session_end("success", duration_s)
                history.append({"role": "assistant", "content": final})
                await _emit(progress_callback, {
                    "type": "final",
                    "text": final,
                    "steps": step + 1,
                    "ok": True,
                })
                return final

            # Reject premature / empty stop — keep the loop going.
            if continue_nudges < MAX_CONTINUE_NUDGES and step < max_steps - 1:
                continue_nudges += 1
                log.info(
                    "step %d: rejected non-final text (nudge %d/%d): %.80r",
                    step, continue_nudges, MAX_CONTINUE_NUDGES, final,
                )
                history.append({
                    "role": "assistant",
                    "content": final or "(no text, no tool call)",
                })
                history.append(user_msg(CONTINUE_NUDGE))
                write_scratchpad(history)
                continue

            # Out of continue budget: return best effort rather than silent dump.
            if not final:
                final = (
                    "Stopped without a clear answer. "
                    "Earlier tool results may contain partial information; try a more specific task."
                )
            log.info("step %d: accepting weak final after continue budget: %.100r", step, final)
            audit.record_task_end("success", final[:500])
            audit.record_session_end("success", time.monotonic() - t_start)
            history.append({"role": "assistant", "content": final})
            await _emit(progress_callback, {"type": "final", "text": final})
            return final

        # ── Single-action discipline ────────────────────────────────────
        tool_calls = resp["tool_calls"]
        if len(tool_calls) > 5:
            log.warning(
                "model returned %d tool calls at step %d; truncating to 5",
                len(tool_calls), step,
            )
            tool_calls = tool_calls[:5]

        call = tool_calls[0]
        log.info("step %d: %s(%s)", step, call["name"], list(call["arguments"].keys()))
        if len(tool_calls) > 1:
            log.warning(
                "model returned %d tool calls at step %d; single-action discipline",
                len(tool_calls), step,
            )

        if verbose:
            import click
            click.echo(click.style(
                f"  [tool call] {call['name']}({json.dumps(call['arguments'], indent=2)})",
                fg="yellow",
            ))

        step_info = tool_summary(call)
        await _emit(progress_callback, {
            "type": "step_start",
            "step": step,
            "call": call,
            "summary": step_info,
            "thought": thought or None,
            "url": current_url,
        })

        # ── Reject blank-page no-ops (snapshot/url on about:blank) ───────
        code_for_call = ""
        if call.get("name") == "repl":
            code_for_call = str((call.get("arguments") or {}).get("code", ""))

        noop = blank_page_noop_reason(call, current_url)
        if not noop and code_for_call:
            noop = invented_goto_reason(
                code_for_call,
                grounded_urls,
                grounded_text="\n".join(grounded_text_parts[-20:]),
            )
        if noop:
            log.info("step %d: blocked action: %s", step, noop[:100])
            result = {"error": noop}
            history.append(assistant_tool_calls_msg(tool_calls))
            history.append(tool_result_msg(call["id"], result))
            for extra in tool_calls[1:]:
                history.append(tool_result_msg(extra["id"], {
                    "error": "Single-action discipline: not executed.",
                }))
            write_scratchpad(history)
            await _emit(progress_callback, {
                "type": "step_end",
                "step": step,
                "result": result,
                "summary": result_summary(result),
                "issues": [noop],
                "url": current_url,
                "next_hint": (
                    "Click a link from the last snapshot/search results — do not invent URLs"
                    if "Ungrounded" in noop or "Invented path" in noop
                    else "Use page.goto to open a real page, then snapshot"
                ),
            })
            continue

        # ── Stuck / thrash detection (soft then hard) ───────────────────
        fp = tool_call_fingerprint(call)
        family = action_family(call)

        if fp == last_fingerprint:
            consecutive_identical += 1
        else:
            consecutive_identical = 0
        last_fingerprint = fp

        if family == last_family:
            consecutive_family += 1
        else:
            consecutive_family = 0
        last_family = family
        family_history.append(family)
        if len(family_history) > 20:
            family_history = family_history[-20:]

        # Same ref clicked repeatedly (common e-comm filter thrash)
        if family == "repl:click" and code_for_call:
            cref = extract_click_ref(code_for_call)
            if cref and cref == last_click_ref:
                same_click_count += 1
            else:
                same_click_count = 1 if cref else 0
                last_click_ref = cref
        else:
            # snapshot after click doesn't reset last_click_ref — only different click does
            if family != "repl:snapshot":
                same_click_count = 0
                last_click_ref = None

        # Soft stuck: identical call repeated — do not execute; feed nudge as result
        if consecutive_identical >= STUCK_THRESHOLD and stuck_nudges < MAX_STUCK_NUDGES:
            stuck_nudges += 1
            log.warning(
                "step %d: soft-stuck on identical action (nudge %d/%d)",
                step, stuck_nudges, MAX_STUCK_NUDGES,
            )
            result = {"error": STUCK_NUDGE}
            if stuck_nudges >= MAX_STUCK_NUDGES:
                force_final_mode = True
                result = {"error": FORCE_FINAL_NUDGE}
            history.append(assistant_tool_calls_msg(tool_calls))
            history.append(tool_result_msg(call["id"], result))
            for extra in tool_calls[1:]:
                history.append(tool_result_msg(extra["id"], {
                    "error": "Single-action discipline: not executed.",
                }))
            consecutive_identical = 0  # allow a different retry after nudge
            write_scratchpad(history)
            await _emit(progress_callback, {
                "type": "step_end",
                "step": step,
                "result": result,
                "summary": result_summary(result),
                "issues": [str(result["error"])],
                "next_hint": "Change action or give a final answer from prior evidence",
            })
            continue

        # Hard stuck: still identical after soft nudges
        if consecutive_identical >= STUCK_THRESHOLD + STUCK_HARD_EXTRA:
            msg = (
                f"Agent appears stuck: the same action '{call['name']}' was "
                f"repeated after recovery nudges."
            )
            audit.record_task_end("failure", msg)
            audit.record_session_end("failure", time.monotonic() - t_start)
            await _emit(progress_callback, {"type": "final", "text": f"Error: {msg}"})
            raise RuntimeError(msg)

        # Ping-pong thrash: click ↔ snapshot forever (bypasses consecutive-family checks)
        if is_pingpong(family_history, PINGPONG_WINDOW):
            stuck_nudges += 1
            force_final_mode = stuck_nudges >= MAX_STUCK_NUDGES or same_click_count >= 3
            thrash_msg = FORCE_FINAL_NUDGE if force_final_mode else PINGPONG_NUDGE
            log.warning("step %d: click/snapshot ping-pong — %s", step, thrash_msg[:60])
            result = {"error": thrash_msg}
            history.append(assistant_tool_calls_msg(tool_calls))
            history.append(tool_result_msg(call["id"], result))
            family_history.clear()
            consecutive_family = 0
            write_scratchpad(history)
            await _emit(progress_callback, {
                "type": "step_end",
                "step": step,
                "result": result,
                "summary": result_summary(result),
                "issues": [thrash_msg],
                "url": current_url,
                "next_hint": "Stop click/snapshot loop — answer or change strategy",
            })
            continue

        # Same filter/ref clicked too many times
        if same_click_count >= 3:
            stuck_nudges += 1
            force_final_mode = True
            thrash_msg = (
                f"You clicked {last_click_ref} repeatedly without progress. "
                + FORCE_FINAL_NUDGE
            )
            log.warning("step %d: same ref thrash %s", step, last_click_ref)
            result = {"error": thrash_msg}
            history.append(assistant_tool_calls_msg(tool_calls))
            history.append(tool_result_msg(call["id"], result))
            same_click_count = 0
            write_scratchpad(history)
            await _emit(progress_callback, {
                "type": "step_end",
                "step": step,
                "result": result,
                "summary": result_summary(result),
                "issues": [thrash_msg],
                "url": current_url,
                "next_hint": "Do not re-click the same control — answer from evidence",
            })
            continue

        # Family thrash (gotos, snapshots, page.content mining, evaluate loops)
        thrash_at = FAMILY_THRASH_AT.get(family)
        if thrash_at is not None and consecutive_family >= thrash_at:
            stuck_nudges += 1
            log.warning(
                "step %d: thrashing family %s (n=%d) — injecting recovery",
                step, family, consecutive_family,
            )
            if family == "repl:content" or stuck_nudges >= MAX_STUCK_NUDGES:
                force_final_mode = True
                thrash_msg = (
                    CONTENT_THRASH_NUDGE if family == "repl:content" else FORCE_FINAL_NUDGE
                )
            else:
                thrash_msg = (
                    f"You have used '{family}' repeatedly without clear progress. "
                    "Stop guessing. Prefer: click a ref from the last good snapshot, "
                    "or give a final answer from evidence already collected."
                )
                if family == "repl:goto" and consecutive_blocked >= 2:
                    thrash_msg += " Recent pages looked blocked — switch host or stop with partial."
            result = {"error": thrash_msg}
            history.append(assistant_tool_calls_msg(tool_calls))
            history.append(tool_result_msg(call["id"], result))
            consecutive_family = 0
            write_scratchpad(history)
            await _emit(progress_callback, {
                "type": "step_end",
                "step": step,
                "result": result,
                "summary": result_summary(result),
                "issues": [thrash_msg],
                "url": current_url,
                "next_hint": "Stop scraping — answer from evidence or take one different action",
            })
            continue

        # ── Approval check ──────────────────────────────────────────────
        if require_approval:
            last_snap = find_last_snapshot(history)
            rule = check_approval(
                call, auto_approve=auto_approve, last_snapshot_text=last_snap
            )
            if rule is not None:
                args_preview = json.dumps(call["arguments"])[:200]
                prompt = (
                    f"[{rule.category}] {rule.message}\n"
                    f"  {call['name']}({args_preview})"
                )
                confirmed = await ask_tool.ask(prompt)
                audit.record_approval(call["name"], rule.category, confirmed)
                if not confirmed:
                    denied_msg = tool_result_msg(
                        call["id"], {"error": "User denied this action."}
                    )
                    history.append(assistant_tool_call_msg(call))
                    history.append(denied_msg)
                    write_scratchpad(history)
                    continue

        # ── Execute ─────────────────────────────────────────────────────
        t0 = time.monotonic()
        autofill_credential_id: str | None = None

        try:
            code = call.get("arguments", {}).get("code", "")
            if call["name"] == "repl" and is_signin_call(code):
                parsed = parse_signin_call(code)
                autofill_credential_id = parsed[0] if parsed else None

            result = await execute(call, client, audit, session_dir=session_dir)

        except (AutofillUnavailableError, CredentialNotFoundError) as exc:
            log.warning("autofill failed: %s", exc)
            audit.record_error(type(exc).__name__, str(exc))
            result = {"error": str(exc)}

        except SidecarDead as exc:
            log.warning("sidecar died during tool call: %s", exc)
            try:
                audit.record_sidecar_restart(str(exc), client._restart_budget)
                await client.maybe_restart()
                result = {
                    "error": (
                        "Browser process crashed and was restarted. "
                        "All page state was lost. "
                        "Please navigate back to the page and continue."
                    )
                }
            except Exception as restart_exc:
                log.error("sidecar restart failed: %s", restart_exc)
                audit.record_task_end(
                    "error", f"Sidecar crash + restart failed: {restart_exc}"
                )
                audit.record_session_end("error", time.monotonic() - t_start)
                raise SidecarDead(
                    f"Sidecar crashed and restart failed: {restart_exc}"
                ) from exc

        except Exception as exc:  # noqa: BLE001
            result = {"error": str(exc)}

        duration_ms = (time.monotonic() - t0) * 1000
        audit.record_tool_call(
            {"name": call["name"], "arguments": call["arguments"]},
            result,
            duration_ms,
        )

        issues: list[str] = []
        if result_looks_blocked(result):
            consecutive_blocked += 1
            issues.append("Bot-wall / access block page")
            if consecutive_blocked == 1:
                # Annotate so the model sees a clear recovery cue once
                note = (
                    " [callisto] This looks like a bot-wall/block page. "
                    "Do not retry this host immediately; use another official domain "
                    "from prior results or in-page links, or answer with partial evidence."
                )
                if isinstance(result.get("value"), str):
                    result = {**result, "value": result["value"] + note}
                else:
                    result = {**result, "_note": (result.get("_note") or "") + note}
        else:
            consecutive_blocked = 0

        requested = parse_goto_url(code_for_call) if code_for_call else None
        nav_fail = navigation_failure_note(result, requested)
        if nav_fail:
            issues.append("Navigation failed (dead URL / cert / DNS / 404)")
            if isinstance(result.get("value"), str):
                result = {**result, "value": result["value"] + nav_fail}
            else:
                result = {**result, "_note": (result.get("_note") or "") + nav_fail}

        if "error" in result:
            issues.append(str(result["error"])[:200])

        # Ground future gotos only from successful tool text (not error strings alone).
        if isinstance(result.get("value"), str):
            _ingest_grounding(result["value"])
        if isinstance(result.get("_note"), str):
            _ingest_grounding(result["_note"])
        # Successful goto of a grounded/search URL also grounds the final location.
        if requested and "error" not in result and not nav_fail:
            _ingest_grounding(requested)

        # Update tracked URL from result when possible; probe only after navigations.
        extracted = extract_url_from_result(result)
        if extracted:
            current_url = extracted
            if not nav_fail:
                _ingest_grounding(extracted)
        else:
            code = str(call.get("arguments", {}).get("code", ""))
            if "page.goto" in code or "tabs.switch" in code or "focused new tab" in str(result):
                try:
                    url_res = await repl("return await page.url()", client)
                    if isinstance(url_res.get("value"), str):
                        current_url = url_res["value"]
                        if not nav_fail:
                            _ingest_grounding(current_url)
                except Exception:
                    pass

        page_url = current_url

        if verbose:
            import click
            res_str = json.dumps(result, indent=2)
            if "error" in result:
                click.echo(click.style(f"  [result] Error: {result['error']}", fg="red"))
            else:
                if len(res_str) > 2000:
                    res_str = res_str[:2000] + "\n... (truncated)"
                click.echo(click.style(f"  [result] Success:\n{res_str}", fg="green"))

        summary = result_summary(result)
        next_hint = None
        if issues and result_looks_blocked(result):
            next_hint = "Avoid this host; try another domain or stop with partial evidence"
        elif "error" in result and "stuck" in str(result.get("error", "")).lower():
            next_hint = "Do not repeat the same action — change approach or finalize"
        elif summary.get("ok") and "Snapshot:" in str(summary.get("title", "")):
            next_hint = "Act on a ref from this snapshot (click/fill), don't only re-snapshot"

        await _emit(progress_callback, {
            "type": "step_end",
            "step": step,
            "result": result,
            "summary": summary,
            "issues": issues,
            "url": page_url,
            "next_hint": next_hint,
            "headless_hint": True,
        })

        history.append(assistant_tool_calls_msg(tool_calls))
        history.append(tool_result_msg(call["id"], result))

        for extra in tool_calls[1:]:
            history.append(tool_result_msg(extra["id"], {
                "error": (
                    "Single-action discipline violated. Only one action per turn "
                    "is permitted. This tool call was not executed."
                )
            }))

        if autofill_credential_id:
            purge_secret_from_history(history, autofill_credential_id)

        write_scratchpad(history)

    # Budget exhausted: one last chance for a text answer, then graceful partial.
    log.warning("max_steps=%d reached — requesting best-effort final answer", max_steps)
    history.append(user_msg(
        f"You used all {max_steps} steps without finishing. "
        "Do NOT call tools. Write a final answer from evidence already collected: "
        "what you found (products, prices, colors, URLs), what failed, and your best conclusion."
    ))
    try:
        await _emit(progress_callback, {
            "type": "status",
            "phase": "model_wait",
            "message": "Step budget exhausted — asking model for best-effort final answer…",
        })
        last = await model.chat(
            [system_message()] + prune_old_snapshots(history),
            [],  # no tools
        )
        final = (last.get("text") or "").strip()
        if final:
            audit.record_task_end("success", final[:500])
            audit.record_session_end("success", time.monotonic() - t_start)
            await _emit(progress_callback, {
                "type": "final",
                "text": final,
                "ok": True,
                "partial": True,
            })
            return final
    except Exception as exc:
        log.warning("best-effort final failed: %s", exc)

    msg = (
        f"Agent did not finish within {max_steps} steps. "
        f"Last URL: {current_url or 'unknown'}. "
        "No final answer was produced."
    )
    audit.record_task_end("failure", msg)
    audit.record_session_end("failure", time.monotonic() - t_start)
    await _emit(progress_callback, {"type": "final", "text": f"Error: {msg}"})
    raise RuntimeError(msg)

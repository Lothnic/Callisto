"""cli.py — `callisto run "task"` and `callisto creds` entry points."""
from __future__ import annotations

import asyncio
import getpass
import logging
import sys
from typing import Any

import click

from .budget import BudgetExceededError, BudgetTracker
from .loop import run
from .memory import MemoryStore
from .models.openrouter import OpenRouterModel
from .progress_ui import ProgressPrinter, make_progress_callback
from .sidecar_client import SidecarClient, SidecarDead


@click.group()
@click.option("--debug", is_flag=True, help="Enable debug logging.")
def cli(debug: bool) -> None:
    """Callisto — agentic browser."""
    level = logging.DEBUG if debug else logging.INFO
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


# ---------------------------------------------------------------------------
# callisto run
# ---------------------------------------------------------------------------

@cli.command()
@click.argument("task")
@click.option("--provider", type=click.Choice(["openrouter", "groq", "ollama", "siliconflow", "generalcompute"]), default="siliconflow", show_default=True,
              help="Inference provider.")
@click.option("--model", default="tencent/Hy3", show_default=True,
              help="Model slug/ID.")
@click.option("--headless/--no-headless", default=True, show_default=True,
              help="Run browser headless.")
@click.option("--no-sandbox", is_flag=True,
              help="Pass --no-sandbox to Chrome (needed in Docker/CI).")
@click.option("--max-steps", default=40, show_default=True,
              help="Maximum tool-call turns.")
@click.option("--max-cost", default=10.0, show_default=True,
              help="Maximum cost in USD (0 = unlimited).")
@click.option("--max-turns", default=100, show_default=True,
              help="Maximum model turns (0 = unlimited).")
@click.option("--no-approval", is_flag=True,
              help="Skip approval prompts (non-interactive / CI mode).")
@click.option("--auto-approve", multiple=True,
              help="Auto-approve specific categories (e.g., --auto-approve shell).")
@click.option("--no-memory", is_flag=True,
              help="Disable memory retrieval and storage.")
@click.option("--max-tokens", type=int, default=None,
              help="Explicit token limit per LLM completion (useful for free tier keys).")
@click.option("--keep-open", is_flag=True,
              help="Keep the browser open after the task completes.")
@click.option("--token-budget", type=int, default=None,
              help="Max tokens for context history before triggering compaction.")
@click.option("--verbose", is_flag=True,
              help="Enable verbose execution output.")
@click.option("--ui", is_flag=True,
              help="Start the BrowserOS sidebar WebSocket server on port 54321.")
def run_task(
    task: str,
    provider: str,
    model: str,
    headless: bool,
    no_sandbox: bool,
    max_steps: int,
    max_cost: float,
    max_turns: int,
    no_approval: bool,
    auto_approve: tuple[str, ...],
    no_memory: bool,
    max_tokens: int | None,
    keep_open: bool,
    token_budget: int | None,
    verbose: bool,
    ui: bool,
) -> None:
    """Run TASK in the browser and print the result."""

    if token_budget is None:
        # llama-4-scout-17b has 30K TPM on Groq free tier; budget 20K to leave
        # headroom for output tokens and any concurrent usage.
        token_budget = 20000 if provider == "groq" else 80000

    asyncio.run(
        _run_async(
            task=task,
            provider_name=provider,
            model_name=model,
            headless=headless,
            no_sandbox=no_sandbox,
            max_steps=max_steps,
            max_cost=max_cost,
            max_turns=max_turns,
            require_approval=not no_approval,
            auto_approve_categories=set(auto_approve),
            enable_memory=not no_memory,
            max_tokens=max_tokens,
            keep_open=keep_open,
            token_budget=token_budget,
            verbose=verbose,
            enable_ui=ui,
        )
    )


async def _run_async(
    task: str,
    provider_name: str,
    model_name: str,
    headless: bool,
    no_sandbox: bool,
    max_steps: int,
    max_cost: float,
    max_turns: int,
    require_approval: bool,
    auto_approve_categories: set[str],
    enable_memory: bool,
    max_tokens: int | None = None,
    keep_open: bool = False,
    token_budget: int = 80000,
    verbose: bool = False,
    enable_ui: bool = False,
) -> None:
    from .models.groq import GroqModel
    from .models.ollama import OllamaModel
    from .models.siliconflow import SiliconFlowModel
    from .models.generalcompute import GeneralComputeModel

    if provider_name == "groq":
        model = GroqModel(model=model_name, max_tokens=max_tokens)
    elif provider_name == "ollama":
        model = OllamaModel(model=model_name, max_tokens=max_tokens)
    elif provider_name == "siliconflow":
        model = SiliconFlowModel(model=model_name, max_tokens=max_tokens)
    elif provider_name == "generalcompute":
        model = GeneralComputeModel(model=model_name, max_tokens=max_tokens)
    else:
        model = OpenRouterModel(model=model_name, max_tokens=max_tokens)

    client = SidecarClient()
    budget = BudgetTracker(max_cost=max_cost, max_turns=max_turns)
    memory = MemoryStore() if enable_memory else None

    broadcast = None
    web_runner = None
    if enable_ui:
        from .web_server import start_server, broadcast as _broadcast
        broadcast = _broadcast
        web_runner = await start_server(54321)

    chrome_flags = ["--no-sandbox"] if no_sandbox else []
    printer = ProgressPrinter(verbose=verbose)
    printer.echo_banner(
        task=task,
        provider=provider_name,
        model=model_name,
        headless=headless,
        max_steps=max_steps,
        no_sandbox=no_sandbox,
        ui=enable_ui,
    )

    try:
        await client.start()
        await client.call("launch", {"headless": headless, "chromeFlags": chrome_flags})

        # Prove the browser is alive (critical when headless — no window to stare at).
        browser_url = "about:blank"
        try:
            url_probe = await client.call(
                "eval", {"code": "return await page.url()"}
            )
            if isinstance(url_probe.get("value"), str):
                browser_url = url_probe["value"]
        except Exception as exc:
            click.echo(
                click.style(
                    f"  ⚠ Browser launched but probe failed: {exc}", fg="red"
                ),
                err=True,
            )

        progress = make_progress_callback(printer, broadcast)
        await progress({
            "type": "session",
            "headless": headless,
            "url": browser_url,
            "note": (
                "No window expected — follow URL lines below to verify progress."
                if headless
                else "A browser window should be open on your display."
            ),
        })

        result = await run(
            task=task,
            model=model,
            client=client,
            max_steps=max_steps,
            require_approval=require_approval,
            auto_approve=auto_approve_categories,
            budget=budget,
            memory=memory,
            token_budget=token_budget,
            progress_callback=progress,
            verbose=verbose,
        )
        # Final answer already printed by ProgressPrinter; keep exit code clean.
        _ = result

        if keep_open:
            await asyncio.to_thread(
                input, "\n[callisto] Task complete. Keeping browser open. Press Enter to exit and close the browser..."
            )

    except SidecarDead as exc:
        click.echo(f"[callisto] Browser session died: {exc}", err=True)
        sys.exit(1)
    except BudgetExceededError as exc:
        click.echo(f"[callisto] Budget exceeded: {exc}", err=True)
        sys.exit(1)
    except RuntimeError as exc:
        click.echo(f"[callisto] {exc}", err=True)
        sys.exit(1)
    except KeyboardInterrupt:
        click.echo("\n[callisto] Interrupted.", err=True)
        sys.exit(130)
    finally:
        try:
            await client.call("close", {})
        except Exception:  # noqa: BLE001
            pass
        await client.aclose()
        if web_runner is not None:
            try:
                await web_runner.cleanup()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# callisto creds
# ---------------------------------------------------------------------------

@cli.group()
def creds() -> None:
    """Manage credentials in the OS keychain."""


@creds.command("add")
@click.argument("credential_id")
def creds_add(credential_id: str) -> None:
    """Add a credential to the keychain (prompts for the secret)."""
    from .auth import keychain

    secret = getpass.getpass(f"Enter secret for '{credential_id}': ")
    if not secret:
        click.echo("Empty secret — aborting.", err=True)
        sys.exit(1)

    keychain.set_(credential_id, secret)
    click.echo(f"Credential '{credential_id}' stored in keychain.")


@creds.command("list")
def creds_list() -> None:
    """List all stored credential IDs."""
    from .auth import keychain

    ids = keychain.list_ids()
    if not ids:
        click.echo("No credentials stored.")
        return
    for cid in ids:
        click.echo(f"  • {cid}")


@creds.command("remove")
@click.argument("credential_id")
def creds_remove(credential_id: str) -> None:
    """Remove a credential from the keychain."""
    from .auth import keychain

    try:
        keychain.delete(credential_id)
        click.echo(f"Credential '{credential_id}' removed.")
    except Exception as exc:
        click.echo(f"Failed to remove '{credential_id}': {exc}", err=True)
        sys.exit(1)


# ---------------------------------------------------------------------------
# callisto chat
# ---------------------------------------------------------------------------

@cli.command()
@click.option("--provider", type=click.Choice(["openrouter", "groq", "ollama", "siliconflow", "generalcompute"]), default="siliconflow", show_default=True,
              help="Inference provider.")
@click.option("--model", default="tencent/Hy3", show_default=True,
              help="Model slug/ID.")
@click.option("--headless/--no-headless", default=True, show_default=True,
              help="Run browser headless.")
@click.option("--no-sandbox", is_flag=True,
              help="Pass --no-sandbox to Chrome (needed in Docker/CI).")
@click.option("--max-steps", default=40, show_default=True,
              help="Maximum tool-call turns per task input.")
@click.option("--max-cost", default=10.0, show_default=True,
              help="Maximum cost in USD (0 = unlimited).")
@click.option("--max-turns", default=100, show_default=True,
              help="Maximum model turns (0 = unlimited).")
@click.option("--no-approval", is_flag=True,
              help="Skip approval prompts (non-interactive / CI mode).")
@click.option("--auto-approve", multiple=True,
              help="Auto-approve specific categories (e.g., --auto-approve shell).")
@click.option("--no-memory", is_flag=True,
              help="Disable memory retrieval.")
@click.option("--max-tokens", type=int, default=None,
              help="Explicit token limit per LLM completion (useful for free tier keys).")
@click.option("--token-budget", type=int, default=None,
              help="Max tokens for context history before triggering compaction.")
@click.option("--verbose", is_flag=True,
              help="Enable verbose execution output.")
@click.option("--ui", is_flag=True,
              help="Start the BrowserOS sidebar WebSocket server on port 54321.")
def chat(
    provider: str,
    model: str,
    headless: bool,
    no_sandbox: bool,
    max_steps: int,
    max_cost: float,
    max_turns: int,
    no_approval: bool,
    auto_approve: tuple[str, ...],
    no_memory: bool,
    max_tokens: int | None,
    token_budget: int | None,
    verbose: bool,
    ui: bool,
) -> None:
    """Start an interactive multi-turn chat session with Callisto."""

    if token_budget is None:
        # llama-4-scout-17b has 30K TPM on Groq free tier; budget 20K to leave
        # headroom for output tokens and any concurrent usage.
        token_budget = 20000 if provider == "groq" else 80000

    asyncio.run(
        _chat_async(
            provider_name=provider,
            model_name=model,
            headless=headless,
            no_sandbox=no_sandbox,
            max_steps=max_steps,
            max_cost=max_cost,
            max_turns=max_turns,
            require_approval=not no_approval,
            auto_approve_categories=set(auto_approve),
            enable_memory=not no_memory,
            max_tokens=max_tokens,
            token_budget=token_budget,
            verbose=verbose,
            enable_ui=ui,
        )
    )


async def _chat_async(
    provider_name: str,
    model_name: str,
    headless: bool,
    no_sandbox: bool,
    max_steps: int,
    max_cost: float,
    max_turns: int,
    require_approval: bool,
    auto_approve_categories: set[str],
    enable_memory: bool,
    max_tokens: int | None,
    token_budget: int = 80000,
    verbose: bool = False,
    enable_ui: bool = False,
) -> None:
    from .models.groq import GroqModel
    from .models.ollama import OllamaModel
    from .models.siliconflow import SiliconFlowModel
    from .models.generalcompute import GeneralComputeModel

    if provider_name == "groq":
        model = GroqModel(model=model_name, max_tokens=max_tokens)
    elif provider_name == "ollama":
        model = OllamaModel(model=model_name, max_tokens=max_tokens)
    elif provider_name == "siliconflow":
        model = SiliconFlowModel(model=model_name, max_tokens=max_tokens)
    elif provider_name == "generalcompute":
        model = GeneralComputeModel(model=model_name, max_tokens=max_tokens)
    else:
        model = OpenRouterModel(model=model_name, max_tokens=max_tokens)

    broadcast = None
    web_runner = None
    # Local queue when UI is off; shared web_server queue when --ui is on.
    local_queue: asyncio.Queue[str] = asyncio.Queue()
    task_queue = local_queue
    if enable_ui:
        from .web_server import start_server, broadcast as _broadcast, task_queue as ui_queue
        broadcast = _broadcast
        task_queue = ui_queue
        web_runner = await start_server(54321)

    client = SidecarClient()
    budget = BudgetTracker(max_cost=max_cost, max_turns=max_turns)
    memory = MemoryStore() if enable_memory else None
    chrome_flags = ["--no-sandbox"] if no_sandbox else []
    printer = ProgressPrinter(verbose=verbose)

    try:
        await client.start()
        await client.call("launch", {"headless": headless, "chromeFlags": chrome_flags})

        mode = "HEADLESS" if headless else "VISIBLE"
        click.echo("======================================================================")
        click.echo(f"Callisto chat  |  browser={mode}  |  {provider_name}/{model_name}")
        if enable_ui:
            click.echo("Sidebar Web UI on port 54321 — type tasks in terminal or sidebar.")
        else:
            click.echo("Type a task and press Enter. Pass --ui for the sidebar server.")
        if headless:
            click.echo("Headless: no window — watch URL/step lines to verify progress.")
        else:
            click.echo("Visible: a BrowserOS/Chrome window should appear.")
        click.echo("Type 'exit' or 'quit' to close.")
        click.echo("======================================================================")

        history: list[dict[str, Any]] = []
        progress = make_progress_callback(printer, broadcast)

        async def handle_cli_input():
            while True:
                try:
                    task = await asyncio.to_thread(input, "\ncallisto > ")
                    task = task.strip()
                    if task:
                        await task_queue.put(task)
                        if task.lower() in ("exit", "quit"):
                            break
                except (KeyboardInterrupt, EOFError):
                    await task_queue.put("exit")
                    break

        cli_input_task = asyncio.create_task(handle_cli_input())

        try:
            while True:
                task = await task_queue.get()
                if task.lower() in ("exit", "quit"):
                    break

                try:
                    printer.echo_banner(
                        task=task,
                        provider=provider_name,
                        model=model_name,
                        headless=headless,
                        max_steps=max_steps,
                        no_sandbox=no_sandbox,
                        ui=enable_ui,
                    )
                    await run(
                        task=task,
                        model=model,
                        client=client,
                        max_steps=max_steps,
                        require_approval=require_approval,
                        auto_approve=auto_approve_categories,
                        budget=budget,
                        memory=memory,
                        history=history,
                        token_budget=token_budget,
                        progress_callback=progress,
                        verbose=verbose,
                    )
                except Exception as turn_exc:
                    click.echo(f"\n[callisto] Error during turn: {turn_exc}", err=True)
                    if broadcast is not None:
                        await broadcast({"type": "final", "text": f"Error: {turn_exc}"})
        finally:
            cli_input_task.cancel()

    except SidecarDead as exc:
        click.echo(f"[callisto] Browser session died: {exc}", err=True)
        sys.exit(1)
    finally:
        try:
            await client.call("close", {})
        except Exception:
            pass
        await client.aclose()
        if web_runner is not None:
            try:
                await web_runner.cleanup()
            except Exception:
                pass


# Allow `python -m callisto.cli` as well
if __name__ == "__main__":
    cli()

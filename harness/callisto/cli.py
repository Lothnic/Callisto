"""cli.py — `callisto run "task"` and `callisto creds` entry points."""
from __future__ import annotations

import asyncio
import getpass
import logging
import sys

import click

from .budget import BudgetExceededError, BudgetTracker
from .loop import run
from .memory import MemoryStore
from .models.openrouter import OpenRouterModel
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
@click.option("--provider", type=click.Choice(["openrouter", "groq", "ollama", "siliconflow", "generalcompute"]), default="groq", show_default=True,
              help="Inference provider.")
@click.option("--model", default="meta-llama/llama-4-scout-17b-16e-instruct", show_default=True,
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

    from .web_server import start_server, broadcast
    web_runner = await start_server(54321)

    chrome_flags = ["--no-sandbox"] if no_sandbox else []

    try:
        await client.start()
        await client.call("launch", {"headless": headless, "chromeFlags": chrome_flags})

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
            progress_callback=broadcast,
            verbose=verbose,
        )
        click.echo(result)

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
        client.terminate()
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
@click.option("--provider", type=click.Choice(["openrouter", "groq", "ollama", "siliconflow", "generalcompute"]), default="groq", show_default=True,
              help="Inference provider.")
@click.option("--model", default="meta-llama/llama-4-scout-17b-16e-instruct", show_default=True,
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

    from .web_server import start_server, broadcast, task_queue
    web_runner = await start_server(54321)

    client = SidecarClient()
    budget = BudgetTracker(max_cost=max_cost, max_turns=max_turns)
    memory = MemoryStore() if enable_memory else None
    chrome_flags = ["--no-sandbox"] if no_sandbox else []

    try:
        await client.start()
        await client.call("launch", {"headless": headless, "chromeFlags": chrome_flags})

        click.echo("======================================================================")
        click.echo("Callisto Multi-turn Interactive Chat/Sidebar Web UI Mode")
        click.echo("Type your task instruction in terminal or sidebar and press Enter.")
        click.echo("Type 'exit' or 'quit' to close.")
        click.echo("======================================================================")

        history: list[dict[str, Any]] = []

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
                    result = await run(
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
                        progress_callback=broadcast,
                        verbose=verbose,
                    )
                    click.echo(f"\n[callisto] {result}")
                except Exception as turn_exc:
                    click.echo(f"\n[callisto] Error during turn: {turn_exc}", err=True)
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
        client.terminate()
        try:
            await web_runner.cleanup()
        except Exception:
            pass


# Allow `python -m callisto.cli` as well
if __name__ == "__main__":
    cli()

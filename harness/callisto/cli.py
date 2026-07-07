"""cli.py — `callisto run "task"` entry point."""
from __future__ import annotations

import asyncio
import logging
import sys

import click

from .loop import run
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


@cli.command()
@click.argument("task")
@click.option("--model", default="anthropic/claude-3.5-sonnet", show_default=True,
              help="OpenRouter model string.")
@click.option("--headless/--no-headless", default=True, show_default=True,
              help="Run browser headless.")
@click.option("--no-sandbox", is_flag=True,
              help="Pass --no-sandbox to Chrome (needed in Docker/CI).")
@click.option("--max-steps", default=40, show_default=True,
              help="Maximum tool-call turns.")
@click.option("--no-approval", is_flag=True,
              help="Skip approval prompts (non-interactive / CI mode).")
def run_task(
    task: str,
    model: str,
    headless: bool,
    no_sandbox: bool,
    max_steps: int,
    no_approval: bool,
) -> None:
    """Run TASK in the browser and print the result."""
    asyncio.run(
        _run_async(
            task=task,
            model_name=model,
            headless=headless,
            no_sandbox=no_sandbox,
            max_steps=max_steps,
            require_approval=not no_approval,
        )
    )


async def _run_async(
    task: str,
    model_name: str,
    headless: bool,
    no_sandbox: bool,
    max_steps: int,
    require_approval: bool,
) -> None:
    model = OpenRouterModel(model=model_name)
    client = SidecarClient()

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
        )
        click.echo(result)

    except SidecarDead as exc:
        click.echo(f"[callisto] Browser session died: {exc}", err=True)
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


if __name__ == "__main__":
    cli()

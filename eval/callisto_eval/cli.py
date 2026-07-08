from __future__ import annotations

import json
from pathlib import Path

import click

from .agents import CallistoAgent, FakeAgent
from .runner import run_eval, timestamp_run_id
from .stats import summarize


@click.group()
def cli() -> None:
    """Callisto eval kit."""


@cli.command("run")
@click.argument("benchmark")
@click.option("--subset", default="smoke", show_default=True)
@click.option("--agent", "agent_name", type=click.Choice(["fake", "callisto"]), default="fake", show_default=True)
@click.option("--provider", type=click.Choice(["openrouter", "groq", "ollama", "siliconflow", "generalcompute"]), default="siliconflow", show_default=True)
@click.option("--model", default="tencent/Hy3", show_default=True)
@click.option("--scorer", default="contains", show_default=True)
@click.option("--max-tasks", type=int, default=None)
@click.option("--seed", type=int, default=0, show_default=True)
@click.option("--max-cost", type=float, default=0.0, show_default=True)
@click.option("--max-steps", type=int, default=40, show_default=True)
@click.option("--headless/--headed", default=True, show_default=True)
@click.option("--no-sandbox/--sandbox", default=True, show_default=True)
@click.option("--verbose", is_flag=True)
@click.option("--out", type=click.Path(path_type=Path), default=None)
def run_cmd(
    benchmark: str,
    subset: str,
    agent_name: str,
    provider: str,
    model: str,
    scorer: str,
    max_tasks: int | None,
    seed: int,
    max_cost: float,
    max_steps: int,
    headless: bool,
    no_sandbox: bool,
    verbose: bool,
    out: Path | None,
) -> None:
    """Run a benchmark subset and write reproducible artifacts."""
    if agent_name == "fake":
        agent = FakeAgent()
    else:
        agent = CallistoAgent(
            provider=provider,
            model=model,
            headless=headless,
            no_sandbox=no_sandbox,
            max_steps=max_steps,
            max_cost=max_cost,
            verbose=verbose,
        )
    out_dir = out or Path("runs") / timestamp_run_id(benchmark, subset)
    out_dir, results = run_eval(
        benchmark=benchmark,
        subset=subset,
        out_dir=out_dir,
        agent=agent,
        scorer_name=scorer,
        max_tasks=max_tasks,
        seed=seed,
        max_cost=max_cost,
    )
    summary = summarize(results)
    click.echo(json.dumps({"out": str(out_dir), "summary": summary}, indent=2, sort_keys=True))


@cli.command("summarize")
@click.argument("run_dir", type=click.Path(exists=True, path_type=Path))
def summarize_cmd(run_dir: Path) -> None:
    """Print an existing run summary."""
    summary_path = run_dir / "summary.json"
    if not summary_path.exists():
        raise click.ClickException(f"missing summary: {summary_path}")
    click.echo(summary_path.read_text(encoding="utf-8"))


@cli.command("compare")
@click.argument("baseline", type=click.Path(exists=True, path_type=Path))
@click.argument("candidate", type=click.Path(exists=True, path_type=Path))
def compare_cmd(baseline: Path, candidate: Path) -> None:
    """Compare two run summaries."""
    base = json.loads((baseline / "summary.json").read_text(encoding="utf-8"))
    cand = json.loads((candidate / "summary.json").read_text(encoding="utf-8"))
    delta = cand.get("success_rate", 0.0) - base.get("success_rate", 0.0)
    click.echo(json.dumps({"success_rate_delta": delta, "baseline": base, "candidate": cand}, indent=2, sort_keys=True))


if __name__ == "__main__":
    cli()

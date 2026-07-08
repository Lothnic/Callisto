from __future__ import annotations

import asyncio

from .types import EvalTask, TaskResult


class FakeAgent:
    """Offline agent for CI: returns the task's expected string."""

    name: str = "fake"
    provider: str = "offline"

    def run(self, task: EvalTask) -> TaskResult:
        answer = task.expected if isinstance(task.expected, str) else ""
        return TaskResult(task_id=task.id, status="pass", final_answer=answer, steps=1)


class CallistoAgent:
    """Live browser-agent adapter backed by harness.callisto.loop.run."""

    def __init__(
        self,
        *,
        provider: str,
        model: str,
        headless: bool = True,
        no_sandbox: bool = True,
        max_steps: int = 40,
        max_cost: float = 0.0,
        token_budget: int = 80_000,
        verbose: bool = False,
    ) -> None:
        self.provider = provider
        self.model = model
        self.name = f"{provider}/{model}"
        self.headless = headless
        self.no_sandbox = no_sandbox
        self.max_steps = max_steps
        self.max_cost = max_cost
        self.token_budget = token_budget
        self.verbose = verbose

    def run(self, task: EvalTask) -> TaskResult:
        final_answer, budget = asyncio.run(self._run_async(task))
        return TaskResult(
            task_id=task.id,
            status="pass",
            final_answer=final_answer,
            steps=budget.total_turns,
            input_tokens=budget.total_input_tokens,
            output_tokens=budget.total_output_tokens,
            cost_usd=budget.total_cost,
        )

    async def _run_async(self, task: EvalTask) -> tuple[str, BudgetTracker]:
        try:
            from callisto.budget import BudgetTracker
            from callisto.loop import run
            from callisto.models.generalcompute import GeneralComputeModel
            from callisto.models.groq import GroqModel
            from callisto.models.ollama import OllamaModel
            from callisto.models.openrouter import OpenRouterModel
            from callisto.models.siliconflow import SiliconFlowModel
            from callisto.sidecar_client import SidecarClient
        except ImportError as exc:
            raise RuntimeError(
                "Live Callisto evals require the harness package. Run: "
                "harness/.venv/bin/python -m pip install -e harness -e eval"
            ) from exc

        if self.provider == "groq":
            model_obj = GroqModel(model=self.model)
        elif self.provider == "openrouter":
            model_obj = OpenRouterModel(model=self.model)
        elif self.provider == "ollama":
            model_obj = OllamaModel(model=self.model)
        elif self.provider == "siliconflow":
            model_obj = SiliconFlowModel(model=self.model)
        elif self.provider == "generalcompute":
            model_obj = GeneralComputeModel(model=self.model)
        else:
            raise ValueError(f"unknown provider: {self.provider}")

        client = SidecarClient()
        chrome_flags = ["--no-sandbox"] if self.no_sandbox else []
        budget = BudgetTracker(max_cost=self.max_cost, max_turns=0)

        instruction = (
            f"Start at {task.start_url}. {task.instruction}\n\n"
            "Return the final answer concisely."
        )

        try:
            await client.start()
            await client.call("launch", {"headless": self.headless, "chromeFlags": chrome_flags})
            await client.call("eval", {"code": f"await page.goto('{task.start_url}')"})
            final_answer = await run(
                task=instruction,
                model=model_obj,
                client=client,
                max_steps=self.max_steps,
                require_approval=False,
                budget=budget,
                memory=None,
                token_budget=self.token_budget,
                verbose=self.verbose,
            )
            return final_answer, budget
        finally:
            try:
                await client.call("close", {})
            except Exception:
                pass
            await client.aclose()

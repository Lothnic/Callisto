"""budget.py — per-task cost and turn tracking.

Prevents runaway agents from burning real money. 30 lines of code,
saves users from surprise bills.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

log = logging.getLogger(__name__)

# Default pricing: Claude 3.5 Sonnet via OpenRouter ($/1M tokens)
DEFAULT_INPUT_PRICE = 3.00 / 1_000_000
DEFAULT_OUTPUT_PRICE = 15.00 / 1_000_000


class BudgetExceededError(Exception):
    """Raised when the task exceeds its cost or turn budget."""


@dataclass
class BudgetTracker:
    """
    Tracks cost and turns for a single task.

    Usage::

        budget = BudgetTracker(max_cost=5.0, max_turns=100)
        budget.record_turn(input_tokens=1200, output_tokens=400)
        budget.check()  # raises BudgetExceededError if over limit
    """

    max_cost: float = 10.0    # USD; 0 = unlimited
    max_turns: int = 100      # 0 = unlimited
    input_price: float = DEFAULT_INPUT_PRICE
    output_price: float = DEFAULT_OUTPUT_PRICE

    total_cost: float = field(default=0.0, init=False)
    total_turns: int = field(default=0, init=False)
    total_input_tokens: int = field(default=0, init=False)
    total_output_tokens: int = field(default=0, init=False)
    _warned_50: bool = field(default=False, init=False)

    def record_turn(
        self, input_tokens: int = 0, output_tokens: int = 0
    ) -> None:
        """Record one model interaction."""
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
        self.total_cost += (
            input_tokens * self.input_price
            + output_tokens * self.output_price
        )
        self.total_turns += 1

    def check(self) -> str | None:
        """
        Check budget limits.

        Returns:
            "warning" if at 50% (first time only),
            None if OK.

        Raises:
            BudgetExceededError if cost or turns exceed the limit.
        """
        # Turn limit
        if self.max_turns > 0 and self.total_turns >= self.max_turns:
            raise BudgetExceededError(
                f"Turn limit exceeded: {self.total_turns}/{self.max_turns} turns "
                f"(${self.total_cost:.4f} spent)"
            )

        # Cost limit
        if self.max_cost > 0 and self.total_cost >= self.max_cost:
            raise BudgetExceededError(
                f"Cost limit exceeded: ${self.total_cost:.4f}/${self.max_cost:.2f} "
                f"({self.total_turns} turns)"
            )

        # 50% warning (once)
        if self.max_cost > 0 and not self._warned_50:
            pct = (self.total_cost / self.max_cost) * 100
            if pct >= 50:
                self._warned_50 = True
                log.warning(
                    "Budget at %.0f%%: $%.4f of $%.2f (%d turns)",
                    pct, self.total_cost, self.max_cost, self.total_turns,
                )
                return "warning"

        if self.max_turns > 0 and not self._warned_50:
            pct = (self.total_turns / self.max_turns) * 100
            if pct >= 50:
                self._warned_50 = True
                log.warning(
                    "Turn budget at %.0f%%: %d of %d turns ($%.4f spent)",
                    pct, self.total_turns, self.max_turns, self.total_cost,
                )
                return "warning"

        return None

    @property
    def cost_percentage(self) -> float:
        """Current cost as a percentage of max_cost (0 if unlimited)."""
        if self.max_cost <= 0:
            return 0.0
        return (self.total_cost / self.max_cost) * 100

    def summary(self) -> dict[str, Any]:
        """Return a dict summary for audit logging."""
        return {
            "total_cost": round(self.total_cost, 4),
            "total_turns": self.total_turns,
            "total_input_tokens": self.total_input_tokens,
            "total_output_tokens": self.total_output_tokens,
            "max_cost": self.max_cost,
            "max_turns": self.max_turns,
        }

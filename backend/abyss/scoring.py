from __future__ import annotations

from dataclasses import dataclass

from .config import AGENTS, TOKENS_PER_SEC
from .ledger import cost_usd


AGENT_ORDER = {agent.agent_id: index for index, agent in enumerate(AGENTS)}


@dataclass(frozen=True)
class ScoredBid:
    agent_id: str
    promised_quality: int
    predicted_output_tokens: int
    est_input_tokens: int
    predicted_cost_usd: float
    reputation: float
    score: float


def predicted_cost(
    nominal_model: str, est_input_tokens: int, predicted_output_tokens: int
) -> float:
    return cost_usd(nominal_model, est_input_tokens, predicted_output_tokens)


def score_bid(
    promised_quality: int,
    reputation: float,
    predicted_cost_usd: float,
    price_weight: float,
) -> float:
    return round(
        promised_quality * reputation - price_weight * predicted_cost_usd * 100,
        3,
    )


def pick_winner(bids: list[ScoredBid]) -> tuple[ScoredBid, ScoredBid | None]:
    if not bids:
        raise ValueError("cannot pick a winner without valid bids")
    ranked = sorted(
        bids,
        key=lambda bid: (
            -bid.score,
            bid.predicted_cost_usd,
            AGENT_ORDER[bid.agent_id],
        ),
    )
    runner_up = ranked[1] if len(ranked) > 1 else None
    return ranked[0], runner_up


def clamp_bid(raw: dict) -> tuple[int, int, str]:
    tokens = _as_int(raw.get("predicted_output_tokens"), 50)
    quality = _as_int(raw.get("promised_quality"), 1)
    pitch_value = raw.get("pitch", "")
    pitch = pitch_value if isinstance(pitch_value, str) else ""
    return (
        min(4000, max(50, tokens)),
        min(10, max(1, quality)),
        pitch[:80],
    )


def clamp_confidence(raw: dict) -> float:
    value = raw.get("confidence")
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value != value:
        return 0.5
    return round(min(1.0, max(0.0, float(value))), 2)


def eta_ms(nominal_model: str, predicted_output_tokens: int) -> int:
    return round(predicted_output_tokens / TOKENS_PER_SEC[nominal_model] * 1000)


def _as_int(value: object, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return default

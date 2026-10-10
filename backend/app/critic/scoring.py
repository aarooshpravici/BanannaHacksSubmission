"""Candidate ranking and the generate -> score -> retry loop.

Every idea has the same shape: produce N candidates, score each on a few
0..1 axes, combine into a weighted total, keep the best, and try again if even
the best is not good enough. The idea-specific parts (how to generate, how to
score) are passed in as functions.
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Generic, TypeVar

T = TypeVar("T")


def weighted_total(scores: dict[str, float], weights: dict[str, float]) -> float:
    """Weighted mean of the scores that have a weight.

    Weights are renormalized over the axes actually present, so a critic that
    could not compute one axis (say the LLM checklist, with no API key) still
    yields a total on the same 0..1 scale.
    """
    used = {k: w for k, w in weights.items() if k in scores and w > 0}
    if not used:
        raise ValueError(f"no weighted score axes present: scores={list(scores)} weights={list(weights)}")
    return sum(scores[k] * w for k, w in used.items()) / sum(used.values())


@dataclass
class Candidate(Generic[T]):
    item: T
    scores: dict[str, float]
    total: float
    attempt: int = 0
    notes: Any = None  # critic feedback, e.g. which features were missing


@dataclass
class LoopResult(Generic[T]):
    best: Candidate[T]
    candidates: list[Candidate[T]]  # every candidate from every attempt, best first
    retries: int
    passed: bool
    history: list[float] = field(default_factory=list)  # best total after each attempt


def rank(candidates: list[Candidate[T]]) -> list[Candidate[T]]:
    return sorted(candidates, key=lambda c: -c.total)


def generate_and_rank(
    generate: Callable[[int, Candidate[T] | None], list[T]],
    score: Callable[[T], tuple[dict[str, float], Any]],
    weights: dict[str, float],
    *,
    threshold: float = 0.0,
    max_retries: int = 0,
) -> LoopResult[T]:
    """Run the planner -> generator -> critic loop.

    generate(attempt, previous_best) returns a batch of candidates. On a retry
    it receives the best candidate so far, whose `notes` carry the critic's
    feedback so the next prompt can emphasize what was wrong.
    score(item) returns (scores, notes): the per-axis 0..1 scores and any
    feedback to keep with the candidate.

    Stops as soon as the best total reaches `threshold`, or after `max_retries`
    extra attempts. The best candidate overall is returned either way, so a
    retry can never make the result worse.
    """
    everything: list[Candidate[T]] = []
    history: list[float] = []
    best: Candidate[T] | None = None
    for attempt in range(max_retries + 1):
        items = generate(attempt, best)
        for item in items:
            scores, notes = score(item)
            everything.append(Candidate(item, scores, weighted_total(scores, weights), attempt, notes))
        if not everything:
            raise RuntimeError("generator returned no candidates")
        best = rank(everything)[0]
        history.append(best.total)
        if best.total >= threshold:
            break
    assert best is not None
    return LoopResult(
        best=best,
        candidates=rank(everything),
        retries=len(history) - 1,
        passed=best.total >= threshold,
        history=history,
    )

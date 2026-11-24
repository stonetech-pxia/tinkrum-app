"""Determine thresholds for "cannot determine / not recommended" on the calibration set, and report
metrics only on the test set.

Similarity is not the probability of correctness: the threshold is valid only for the exact same
model, quantization, query instruction, and candidate descriptions; changing any of these
requires recalibration.
Each row represents a decision: top score (`top`), margin to the second place (`margin`),
top-scoring candidate ID (`top_id`), and acceptable answers (`accept`)
(an empty set indicates rejection / not recommended). A truthy `code_reject` indicates that code
rejected the input before the model (e.g., blank, gibberish).
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

# Five possible outcomes. For task ① reporting "correct / misclassified / rejected / falsely rejected", misclassification = `wrong` + `wrong_accept`.
OUTCOMES = ("correct", "wrong", "wrong_accept", "reject_ok", "false_reject")


@dataclass(frozen=True)
class Thresholds:
    min_score: float
    min_margin: float


def accepted(row: dict, th: Thresholds) -> bool:
    return (not row.get("code_reject")) and row["top_id"] is not None and \
        row["top"] >= th.min_score and row["margin"] >= th.min_margin


def outcome(row: dict, th: Thresholds) -> str:
    accept = set(row["accept"])
    if accepted(row, th):
        if not accept:
            return "wrong_accept"
        return "correct" if row["top_id"] in accept else "wrong"
    return "false_reject" if accept else "reject_ok"


def tally(rows: list[dict], th: Thresholds) -> dict:
    counts = Counter(outcome(row, th) for row in rows)
    result = {name: counts.get(name, 0) for name in OUTCOMES}
    result["total"] = len(rows)
    given = result["correct"] + result["wrong"] + result["wrong_accept"]
    result["given"] = given
    # Error recommendation rate: proportion of incorrect categories/recommendations among all given recommendations (rejections are not counted as errors).
    result["error_rate"] = (result["wrong"] + result["wrong_accept"]) / given if given else 0.0
    return result


def calibrate(rows: list[dict], max_error_rate: float) -> Thresholds:
    """When the number of errors in the given decisions does not exceed `max_error_rate`, more
    correct decisions are preferred; in case of a tie, fewer errors and higher thresholds take
    precedence.

        Returns "reject all" (preferring not to recommend) when no threshold combination satisfies the criteria. Candidate thresholds are chosen from scores that appeared in the calibration set.
    """
    live = [row for row in rows if not row.get("code_reject") and row["top_id"] is not None]
    reject_all = Thresholds(float("inf"), float("inf"))
    best_key, best = None, reject_all
    for min_score in sorted({row["top"] for row in live}):
        above = [row for row in live if row["top"] >= min_score]
        for min_margin in sorted({row["margin"] for row in above}):
            th = Thresholds(min_score, min_margin)
            counts = tally(above, th)
            if not counts["given"] or counts["error_rate"] > max_error_rate:
                continue
            key = (counts["correct"], -(counts["wrong"] + counts["wrong_accept"]), min_score, min_margin)
            if best_key is None or key > best_key:
                best_key, best = key, th
    return best


def closed_set(rows: list[dict]) -> dict:
    """No threshold set, forcing the selection of the highest score (previous closed-set metric
    criteria); code rejections are still counted as rejections.
    """
    return tally(rows, Thresholds(float("-inf"), float("-inf")))


def by(rows: list[dict], key: str) -> dict[str, list[dict]]:
    groups: dict[str, list[dict]] = {}
    for row in rows:
        groups.setdefault(row[key], []).append(row)
    return dict(sorted(groups.items()))

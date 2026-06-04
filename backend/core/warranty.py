"""
core/warranty.py — Warranty intelligence.

Turns RUL predictions (+ conformal CI) into warranty economics:
  • probability a cell breaches the warranty SOH threshold before the warranty
    horizon (cycles or years × usage) expires,
  • expected warranty-claim cost per cell,
  • a SAFE / AT_RISK / LIKELY_CLAIM status,
  • fleet-level reserve (sum of expected costs) and exposure breakdown.

The probability treats remaining useful life as a Normal distribution whose mean
is cycles-to-warranty-threshold and whose spread comes from the prediction's CI
(falls back to a 15% width if no CI is supplied). This is the same uncertainty
the rest of the platform already produces, reused for a financial decision.
"""
from __future__ import annotations

import math
from typing import Optional

Z90 = 1.645   # 90% two-sided → CI half-width = Z90 · σ


def _normal_cdf(x: float, mu: float, sigma: float) -> float:
    if sigma <= 1e-9:
        return 1.0 if x >= mu else 0.0
    return 0.5 * (1.0 + math.erf((x - mu) / (sigma * math.sqrt(2.0))))


def _status(p_claim: float) -> str:
    if p_claim >= 0.40:
        return "likely_claim"
    if p_claim >= 0.10:
        return "at_risk"
    return "safe"


def assess_warranty(
    *,
    soh: float,                       # current SOH (0–1)
    predicted_rul: float,             # cycles of remaining useful life (to EOL)
    n_cycles: float = 0.0,            # cycles already used
    warranty_cycles: float = 0.0,     # warranty cycle cap (0 = none)
    warranty_years: float = 0.0,      # warranty time cap (0 = none)
    cycles_per_year: float = 250.0,   # usage rate for the time cap
    warranty_soh_threshold: float = 0.80,
    rul_lower: Optional[float] = None,  # 90% CI lower (cycles)
    rul_upper: Optional[float] = None,  # 90% CI upper (cycles)
    fade_rate: Optional[float] = None,  # ΔSOH per cycle (to project to threshold)
    unit_cost: float = 120.0,           # replacement cost ($)
    label: str = "cell",
) -> dict:
    """Assess a single cell against its warranty terms. Returns a dict."""
    # ── Warranty horizon in cycles (min of the cycle cap and the time cap) ─────
    caps = []
    if warranty_cycles and warranty_cycles > 0:
        caps.append(float(warranty_cycles))
    if warranty_years and warranty_years > 0 and cycles_per_year > 0:
        caps.append(float(warranty_years) * float(cycles_per_year))
    horizon_cycles = min(caps) if caps else float(predicted_rul + n_cycles)
    remaining_cycles = max(0.0, horizon_cycles - float(n_cycles))

    # ── Cycles until the warranty SOH threshold is breached ────────────────────
    if fade_rate and fade_rate > 0 and soh > warranty_soh_threshold:
        cycles_to_threshold = (soh - warranty_soh_threshold) / fade_rate
    else:
        cycles_to_threshold = float(predicted_rul)

    # ── Uncertainty (σ) from the CI band, else 15% width ───────────────────────
    if rul_lower is not None and rul_upper is not None and rul_upper > rul_lower:
        sigma = (float(rul_upper) - float(rul_lower)) / (2.0 * Z90)
    else:
        sigma = max(1.0, float(predicted_rul) * 0.15)

    # ── P(breach before warranty expires) = P(life < remaining_cycles) ─────────
    p_claim = _normal_cdf(remaining_cycles, cycles_to_threshold, sigma)
    p_claim = float(min(1.0, max(0.0, p_claim)))

    expected_cost = round(p_claim * float(unit_cost), 2)
    margin_cycles = round(cycles_to_threshold - remaining_cycles, 1)  # +ve = survives

    return {
        "label":                  label,
        "soh_pct":                round(float(soh) * 100, 1),
        "predicted_rul":          round(float(predicted_rul), 1),
        "warranty_horizon_cycles": round(horizon_cycles, 1),
        "remaining_warranty_cycles": round(remaining_cycles, 1),
        "cycles_to_threshold":    round(cycles_to_threshold, 1),
        "warranty_soh_threshold": warranty_soh_threshold,
        "p_claim":                round(p_claim, 4),
        "expected_claim_cost":    expected_cost,
        "unit_cost":              round(float(unit_cost), 2),
        "margin_cycles":          margin_cycles,
        "status":                 _status(p_claim),
        "sigma_cycles":           round(sigma, 1),
    }


def assess_fleet(cells: list[dict], **defaults) -> dict:
    """Assess a list of cell dicts and aggregate fleet warranty exposure.

    Each cell dict may carry its own warranty/usage overrides; otherwise the
    `defaults` (same kwargs as assess_warranty) apply.
    """
    per_cell = []
    for c in cells:
        kw = {**defaults, **{k: v for k, v in c.items() if k in _ASSESS_KEYS}}
        kw.setdefault("label", c.get("cell_id", c.get("label", "cell")))
        per_cell.append(assess_warranty(**kw))

    n = len(per_cell)
    by_status = {"safe": 0, "at_risk": 0, "likely_claim": 0}
    total_expected = 0.0
    total_exposure = 0.0
    for r in per_cell:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        total_expected += r["expected_claim_cost"]
        total_exposure += r["unit_cost"]

    return {
        "n_cells":            n,
        "by_status":          by_status,
        "reserve_recommended": round(total_expected, 2),   # sum of expected claim costs
        "total_exposure":     round(total_exposure, 2),     # if every cell were replaced
        "reserve_pct":        round(100.0 * total_expected / total_exposure, 2) if total_exposure > 0 else 0.0,
        "n_at_risk":          by_status["at_risk"] + by_status["likely_claim"],
        "per_cell":           per_cell,
    }


_ASSESS_KEYS = {
    "soh", "predicted_rul", "n_cycles", "warranty_cycles", "warranty_years",
    "cycles_per_year", "warranty_soh_threshold", "rul_lower", "rul_upper",
    "fade_rate", "unit_cost", "label",
}

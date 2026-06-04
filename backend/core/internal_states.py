"""
core/internal_states.py — Internal-state extractor (Phase C foundation).

Reverse-estimates a structured vector of internal electrochemical observables
for a cell, supervised by the digital-twin fit. These vectors are the labels
the future internal-state estimator head on v12 will train against — the
"reverse engineering of hidden electrochemistry from external BMS signals"
that is the publishable novelty of the project.

Today's observables (derived from the existing analytical/PyBaMM twin fit):
  • k_sei, k_crack, alpha, Q0           — fitted twin parameters
  • sei_thickness_nm                    — k_sei × √cycles  scaled to nm
  • lli_fraction, lam_fraction          — fraction of fade from SEI vs cracking
  • ir_growth_pct                       — IR trajectory slope
  • cycles_to_eol                       — projected EOL from fit
  • temp_stress_index                   — normalized excess temperature
  • lithium_plating_risk                — heuristic (T × α) — placeholder until
                                          a proper plating model is added in
                                          Phase C P0
  • fit_r2, fit_mape                    — fit quality (uncertainty signal)

The vector is intentionally extensible — new keys can be added without breaking
persistence (the DB row stores it as JSON).
"""
from __future__ import annotations

import logging
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

INTERNAL_STATE_KEYS = (
    "k_sei", "k_crack", "alpha", "Q0",
    "sei_thickness_nm", "lli_fraction", "lam_fraction",
    "ir_growth_pct", "cycles_to_eol",
    "temp_stress_index", "lithium_plating_risk",
    "fit_r2", "fit_mape",
)


def extract_internal_states(twin: dict) -> dict[str, Any]:
    """Given a digital-twin dict (from build_twin), return the structured
    internal-state vector. Missing values become None; consumers should handle."""
    if not isinstance(twin, dict) or "error" in twin:
        return {"error": (twin or {}).get("error", "no twin")}

    fit    = twin.get("fit", {}) or {}
    params = fit.get("params", {}) or {}
    degr   = fit.get("degradation_split", {}) or {}
    observed = twin.get("observed", {}) or {}

    k_sei   = float(params.get("k_sei", 0.0))
    k_crack = float(params.get("k_crack", 0.0))
    alpha   = float(params.get("alpha", 0.5))
    Q0      = float(params.get("Q0", 1.0))

    cycles_obs = observed.get("cycles") or []
    n_obs = int(cycles_obs[-1]) if cycles_obs else 0

    # Derived: SEI thickness proxy (∝ k_sei · √cycles), scaled to a nanometer-like
    # range so downstream visualizations have a meaningful unit. The proportionality
    # constant is a placeholder until a proper SEI growth model is calibrated.
    sei_thickness_nm = round(k_sei * (max(n_obs, 1) ** 0.5) * 1000.0, 2)

    # Degradation split from the fit (LLI = SEI-driven, LAM = particle cracking)
    lli_frac = float(degr.get("sei_pct", 0.0)) / 100.0
    lam_frac = float(degr.get("crack_pct", 0.0)) / 100.0

    # IR trajectory slope (% growth from first to last observed cycle)
    ir_traj = observed.get("ir") or []
    if len(ir_traj) >= 2 and float(ir_traj[0]) > 1e-6:
        ir_growth_pct = round((float(ir_traj[-1]) - float(ir_traj[0])) / float(ir_traj[0]) * 100, 2)
    else:
        ir_growth_pct = 0.0

    eol_cycle = fit.get("eol_cycle")

    # Temperature stress (excess over 25 °C, normalized to a 25 °C reference)
    temp_traj = observed.get("temperature") or []
    if temp_traj:
        temp_stress = round(max(0.0, float(np.mean(temp_traj)) - 25.0) / 25.0, 3)
    else:
        temp_stress = 0.0

    # Lithium-plating risk (placeholder — proper model lands in Phase C P0)
    plating_risk = round(temp_stress * alpha * 0.5, 3)

    return {
        "k_sei":               round(k_sei, 6),
        "k_crack":              round(k_crack, 6),
        "alpha":                round(alpha, 4),
        "Q0":                   round(Q0, 4),
        "sei_thickness_nm":     sei_thickness_nm,
        "lli_fraction":         round(lli_frac, 4),
        "lam_fraction":         round(lam_frac, 4),
        "ir_growth_pct":        ir_growth_pct,
        "cycles_to_eol":        int(eol_cycle) if eol_cycle is not None else None,
        "temp_stress_index":    temp_stress,
        "lithium_plating_risk": plating_risk,
        "fit_r2":               fit.get("r2"),
        "fit_mape":             fit.get("mape"),
    }

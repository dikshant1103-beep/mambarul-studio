"""
core/digital_twin.py — Physics-based battery digital twin (industry-ready).

Two-tier approach:
  1. Analytical fit  (instant)  — semi-empirical dual-mechanism degradation model
                                   fit to observed capacity curve via scipy curve_fit
                                   includes parameter uncertainty (95% CI from covariance)
  2. PyBaMM simulation (seconds) — SPM + reaction-limited SEI, chemistry-specific
                                    parameter sets; used for what-if scenarios

Analytical model
----------------
  Q(n) = Q0 * [ α * exp(-k_sei * sqrt(n)) + (1-α) * exp(-k_crack * n) ]

  α        — SEI-growth fraction (0–1)
  k_sei    — SEI rate constant  (√cycle⁻¹), literature LFP: 0.002–0.01
  k_crack  — particle cracking rate (cycle⁻¹), literature: 1e-5 – 5e-4

PyBaMM parameter sets (chemistry-specific, all validated with SPM+SEI)
-----------------------------------------------------------------------
  LFP      → Ai2020      (2.3 Ah)  or  Mohtat2020 (5 Ah)
  NMC      → Chen2020    (5.0 Ah)  or  OKane2022  (5 Ah)
  NCM      → OKane2022   (5.0 Ah)
  NCA      → NCA_Kim2011 (0.43 Ah)
  LCO      → Chen2020    (closest available; LCO-specific not in PyBaMM 26.x)
"""
from __future__ import annotations

import logging
import threading
import time as _time
from typing import Optional

import numpy as np
from scipy.optimize import curve_fit

logger = logging.getLogger(__name__)


# ── Chemistry → PyBaMM parameter set + voltage windows ───────────────────────

_CHEM_PYBAMM: dict[str, str] = {
    "LFP":  "Ai2020",        # LiFePO4 — Ai et al. 2020
    "NMC":  "Chen2020",      # NMC — Chen et al. 2020 (LG M50)
    "NCM":  "OKane2022",     # NCM — O'Kane et al. 2022
    "NCA":  "NCA_Kim2011",   # NCA — Kim et al. 2011
    "LCO":  "Chen2020",      # LCO — no specific set; Chen2020 is closest
}

# (v_cut_dis, v_cut_chg_100pct_soc) — charge voltage scales with soc_max
_CHEM_VOLTAGES: dict[str, tuple[float, float]] = {
    "LFP": (2.50, 3.60),
    "NMC": (2.50, 4.20),
    "NCM": (2.50, 4.20),
    "NCA": (2.50, 4.15),
    "LCO": (3.00, 4.20),
}

# Nominal capacity of each PyBaMM parameter set (Ah) — used for Q0 scaling
_PYBAMM_NOMINAL_CAP: dict[str, float] = {
    "Ai2020":      2.30,
    "Mohtat2020":  5.00,
    "Chen2020":    5.00,
    "OKane2022":   5.00,
    "NCA_Kim2011": 0.43,
}

# Literature k_SEI ranges for parameter validation
_K_SEI_LIT: dict[str, tuple[float, float]] = {
    "LFP": (0.0005, 0.015),
    "NMC": (0.0002, 0.010),
    "NCM": (0.0002, 0.010),
    "NCA": (0.0002, 0.012),
    "LCO": (0.0003, 0.012),
}

# SEI activation energy (J/mol) for Arrhenius temperature correction.
# Both Chen2020 and Ai2020 ship with Ea=0 → no thermal acceleration by default.
# These literature-derived values restore the correct temperature ordering.
_SEI_ACTIVATION_ENERGY: dict[str, float] = {
    "LFP": 60000.0,   # Ai2020  — conservative (LFP is thermally stable)
    "NMC": 75000.0,   # Chen2020 — Wang et al. 2014
    "NCM": 75000.0,   # OKane2022
    "NCA": 70000.0,   # Kim2011
    "LCO": 65000.0,   # Chen2020 proxy
}

# Per-chemistry j0_SEI scale factor (empirical C-rate stress multiplier baseline).
# All PyBaMM param sets ship with j0_SEI = 1.5e-07 A/m² — so this is only used
# as the per-sqrt(C_rate) coupling factor; values stay at 1.0.
_SEI_J0_SCALE: dict[str, float] = {
    "LFP": 1.0,
    "NMC": 1.0,
    "NCM": 1.0,
    "NCA": 1.0,
    "LCO": 1.0,
}


# ── Analytical degradation model ──────────────────────────────────────────────

def _degradation_model(n: np.ndarray,
                        Q0: float, alpha: float,
                        k_sei: float, k_crack: float) -> np.ndarray:
    sei   = alpha * np.exp(-k_sei * np.sqrt(np.clip(n, 0, None)))
    crack = (1 - alpha) * np.exp(-k_crack * np.clip(n, 0, None))
    return Q0 * (sei + crack)


def fit_analytical(cycles: list[int], capacity: list[float]) -> dict:
    """
    Fit semi-empirical degradation model to observed capacity data.
    Returns params + R² + MAPE + 95% CI on params + predicted trajectory.
    """
    n = np.array(cycles, dtype=float)
    Q = np.array(capacity, dtype=float)

    Q0_init = float(Q[0]) if Q[0] > 0 else 1.0
    p0      = [Q0_init, 0.6, 0.002, 0.0001]
    bounds  = ([0, 0, 0, 0], [Q0_init * 1.1, 1.0, 0.1, 0.01])

    pcov = None
    try:
        popt, pcov = curve_fit(
            _degradation_model, n, Q,
            p0=p0, bounds=bounds,
            maxfev=8000, method='trf',
        )
        Q0, alpha, k_sei, k_crack = popt
    except Exception as exc:
        logger.warning("curve_fit failed (%s), using initial guess", exc)
        Q0, alpha, k_sei, k_crack = p0

    Q_pred = _degradation_model(n, Q0, alpha, k_sei, k_crack)
    ss_res = float(np.sum((Q - Q_pred) ** 2))
    ss_tot = float(np.sum((Q - Q.mean()) ** 2))
    r2     = max(0.0, 1 - ss_res / (ss_tot + 1e-12))
    mape   = float(np.mean(np.abs((Q - Q_pred) / np.clip(Q, 1e-6, None)))) * 100

    eol_cycle = _estimate_eol(Q0, alpha, k_sei, k_crack)

    # 95% CI from covariance (±1.96σ)
    param_ci: dict = {}
    if pcov is not None and np.all(np.isfinite(pcov)):
        perr = np.sqrt(np.diag(pcov))
        names = ["Q0", "alpha", "k_sei", "k_crack"]
        vals  = [Q0, alpha, k_sei, k_crack]
        for nm, val, err in zip(names, vals, perr):
            param_ci[nm] = {
                "value": round(float(val), 8),
                "ci95_lo": round(float(val - 1.96 * err), 8),
                "ci95_hi": round(float(val + 1.96 * err), 8),
            }

    # Degradation mode contribution (% of total fade attributed to each mechanism)
    total_fade  = float(Q[0]) - float(Q[-1]) if len(Q) > 1 else 0.0
    sei_contrib  = float(Q0 * alpha * (1 - np.exp(-k_sei * np.sqrt(float(n[-1])))))  if total_fade > 0 else 0.0
    crack_contrib = float(Q0 * (1 - alpha) * (1 - np.exp(-k_crack * float(n[-1]))))  if total_fade > 0 else 0.0
    total_model  = sei_contrib + crack_contrib + 1e-9
    degradation_split = {
        "sei_pct":   round(sei_contrib   / total_model * 100, 1),
        "crack_pct": round(crack_contrib / total_model * 100, 1),
    }

    return {
        "params": {
            "Q0":      round(float(Q0),      4),
            "alpha":   round(float(alpha),   4),
            "k_sei":   round(float(k_sei),   6),
            "k_crack": round(float(k_crack), 8),
        },
        "param_ci":         param_ci,
        "r2":               round(r2, 4),
        "mape":             round(mape, 3),
        "rmse":             round(float(np.sqrt(ss_res / len(Q))), 5),
        "eol_cycle":        eol_cycle,
        "predicted":        [round(float(v), 4) for v in Q_pred],
        "degradation_split": degradation_split,
    }


def predict_trajectory(
    params: dict,
    n_future: int = 200,
    last_cycle: int = 0,
    pcov: Optional[np.ndarray] = None,
    n_bootstrap: int = 200,
) -> dict:
    """
    Predict capacity for next n_future cycles beyond last_cycle.
    If pcov provided, propagates parameter uncertainty → 90% CI band.
    """
    Q0      = params["Q0"]
    alpha   = params["alpha"]
    k_sei   = params["k_sei"]
    k_crack = params["k_crack"]

    future_cycles = np.arange(last_cycle + 1, last_cycle + n_future + 1, dtype=float)
    Q_fut = _degradation_model(future_cycles, Q0, alpha, k_sei, k_crack)

    eol_80    = Q0 * 0.80
    eol_idx   = next((i for i, q in enumerate(Q_fut) if q <= eol_80), None)
    eol_cycle = int(future_cycles[eol_idx]) if eol_idx is not None else None

    # Uncertainty band via parameter bootstrap
    ci_lo = ci_hi = None
    if pcov is not None and np.all(np.isfinite(pcov)):
        try:
            popt_arr = np.array([Q0, alpha, k_sei, k_crack])
            samples  = np.random.multivariate_normal(popt_arr, pcov, size=n_bootstrap)
            # Clip to physical bounds
            samples[:, 0] = np.clip(samples[:, 0], 0.01,  Q0 * 1.1)
            samples[:, 1] = np.clip(samples[:, 1], 0.0,   1.0)
            samples[:, 2] = np.clip(samples[:, 2], 0.0,   0.1)
            samples[:, 3] = np.clip(samples[:, 3], 0.0,   0.01)
            bootstraps = np.stack([
                _degradation_model(future_cycles, *s) for s in samples
            ])
            ci_lo = [round(float(v), 4) for v in np.percentile(bootstraps, 5, axis=0)]
            ci_hi = [round(float(v), 4) for v in np.percentile(bootstraps, 95, axis=0)]
        except Exception:
            pass

    result: dict = {
        "cycles":    [int(c) for c in future_cycles],
        "capacity":  [round(float(q), 4) for q in Q_fut],
        "eol_cycle": eol_cycle,
        "eol_soh":   80,
    }
    if ci_lo and ci_hi:
        result["ci90_lo"] = ci_lo
        result["ci90_hi"] = ci_hi

    return result


def _estimate_eol(Q0: float, alpha: float, k_sei: float, k_crack: float,
                  eol_frac: float = 0.80) -> Optional[int]:
    target = Q0 * eol_frac
    lo, hi = 0, 10000
    for _ in range(30):
        mid = (lo + hi) // 2
        if _degradation_model(np.array([mid], float), Q0, alpha, k_sei, k_crack)[0] > target:
            lo = mid
        else:
            hi = mid
        if hi - lo <= 1:
            break
    return int(hi) if hi < 9999 else None


# ── Parameter validation against literature ──────────────────────────────────

def validate_params(params: dict, chemistry: str) -> dict:
    """
    Check if fitted k_SEI is in the literature-expected range for the chemistry.
    Returns a dict with 'k_sei_ok', 'k_crack_ok', 'alpha_ok', and 'warnings'.
    """
    chem   = chemistry.upper()
    k_sei  = params["k_sei"]
    k_crack = params["k_crack"]
    alpha  = params["alpha"]
    warnings = []

    k_lo, k_hi = _K_SEI_LIT.get(chem, (0.0001, 0.05))
    k_sei_ok = k_lo <= k_sei <= k_hi
    if not k_sei_ok:
        warnings.append(f"k_SEI={k_sei:.5f} outside literature range [{k_lo},{k_hi}] for {chem}")

    k_crack_ok = 1e-6 <= k_crack <= 5e-3
    if not k_crack_ok:
        warnings.append(f"k_crack={k_crack:.2e} outside physical range [1e-6, 5e-3]")

    alpha_ok = 0.05 <= alpha <= 0.99
    if not alpha_ok:
        warnings.append(f"alpha={alpha:.3f} at boundary — SEI/crack balance unphysical")

    return {
        "k_sei_ok":   k_sei_ok,
        "k_crack_ok": k_crack_ok,
        "alpha_ok":   alpha_ok,
        "warnings":   warnings,
        "k_sei_lit_range": [k_lo, k_hi],
    }


# ── Calendar aging estimate ───────────────────────────────────────────────────

def estimate_calendar_aging(
    params: dict,
    months: int = 24,
    temperature_c: float = 25.0,
    cycles_per_month: float = 30,
) -> dict:
    """
    Estimate capacity loss from calendar aging (SEI growth at rest) vs
    cycle aging (particle cracking from charge-discharge).

    Calendar SEI growth follows sqrt(time) kinetics:
      Q_cal(t) = Q0 * exp(-k_sei * sqrt(n_eq))
    where n_eq = months * cycles_per_month (equivalent cycles stored).

    Arrhenius temperature correction (Ea=30 kJ/mol, ref=25°C):
      k_eff = k_sei * exp(Ea/R * (1/T_ref - 1/T))
    """
    import math
    Q0    = params["Q0"]
    k_sei = params["k_sei"]

    Ea_R  = 30000 / 8.314   # Ea/R in K
    T_ref = 298.15
    T     = 273.15 + temperature_c
    k_eff = k_sei * math.exp(Ea_R * (1 / T_ref - 1 / T))

    timeline_months = list(range(1, months + 1))
    cal_capacity = []
    cycle_capacity = []

    for m in timeline_months:
        n_eq   = m * cycles_per_month
        # Calendar: only SEI mechanism (resting, no crack growth)
        q_cal  = Q0 * math.exp(-k_eff * math.sqrt(n_eq))
        # Cycle: full model (SEI + crack)
        q_cyc  = float(_degradation_model(
            np.array([n_eq]), Q0, params["alpha"], k_sei, params["k_crack"]
        )[0])
        cal_capacity.append(round(q_cal, 4))
        cycle_capacity.append(round(q_cyc, 4))

    cal_fade_pct   = round((Q0 - cal_capacity[-1])   / Q0 * 100, 2)
    cycle_fade_pct = round((Q0 - cycle_capacity[-1]) / Q0 * 100, 2)

    return {
        "months":              timeline_months,
        "calendar_capacity":   cal_capacity,
        "cycle_capacity":      cycle_capacity,
        "calendar_fade_pct":   cal_fade_pct,
        "cycle_fade_pct":      cycle_fade_pct,
        "temperature_c":       temperature_c,
        "cycles_per_month":    cycles_per_month,
        "k_sei_effective":     round(k_eff, 7),
    }


# ── PyBaMM simulation (chemistry-aware) ──────────────────────────────────────

def run_pybamm_simulation(
    n_cycles:    int   = 100,
    c_rate_dis:  float = 1.0,
    c_rate_chg:  float = 0.5,
    temperature: float = 25.0,
    soc_max:     float = 1.0,
    Q0_scale:    float = 1.0,
    chemistry:   str   = "NMC",
) -> dict:
    """
    Run PyBaMM SPM + reaction-limited SEI using the correct parameter set
    for the cell chemistry. Returns per-cycle capacity + metadata.
    """
    try:
        import pybamm

        chem        = chemistry.upper()
        param_name  = _CHEM_PYBAMM.get(chem, "Chen2020")
        v_dis, v_chg_max = _CHEM_VOLTAGES.get(chem, (2.5, 4.2))
        nom_cap     = _PYBAMM_NOMINAL_CAP.get(param_name, 5.0)

        model = pybamm.lithium_ion.SPM(options={
            "SEI": "reaction limited",
            "SEI porosity change": "true",
        })
        param = pybamm.ParameterValues(param_name)

        param["Ambient temperature [K]"] = 273.15 + temperature

        # Arrhenius-correct SEI activation energy (literature Ea per chemistry).
        # Default param sets ship with Ea=0 → flat temperature response.
        param["SEI growth activation energy [J.mol-1]"] = (
            _SEI_ACTIVATION_ENERGY.get(chem, 75000.0)
        )

        # C-rate stress: scale j0_SEI ∝ sqrt(C_rate).
        # SPM+SEI in reaction-limited mode is otherwise insensitive to C-rate.
        j0_base  = float(param["SEI reaction exchange current density [A.m-2]"])
        j0_scale = _SEI_J0_SCALE.get(chem, 1.0)
        param["SEI reaction exchange current density [A.m-2]"] = (
            j0_base * j0_scale * (c_rate_dis ** 0.5)
        )

        # Scale capacity toward a common 5 Ah baseline, but cap at 3× to avoid
        # blowing up small-cell param sets (e.g. NCA_Kim2011 at 0.43 Ah → 11×
        # over-scale amplifies relative SEI fade ~12× unrealistically).
        effective_scale = min(Q0_scale * (5.0 / nom_cap), 3.0)
        if abs(effective_scale - 1.0) > 0.02:
            param["Nominal cell capacity [A.h]"] = nom_cap * effective_scale

        # Charge cutoff voltage scales with soc_max
        v_chg = v_chg_max - (1.0 - soc_max) * (v_chg_max - v_dis) * 0.3

        experiment = pybamm.Experiment([
            f"Discharge at {c_rate_dis}C until {v_dis:.2f}V",
            f"Charge at {c_rate_chg}C until {v_chg:.2f}V",
        ] * n_cycles)

        sim = pybamm.Simulation(model, parameter_values=param, experiment=experiment)
        sol = sim.solve()
        caps = sol.summary_variables["Capacity [A.h]"]

        caps_per_cycle = [float(caps[i]) for i in range(0, len(caps), 2)][:n_cycles]
        cycles_out     = list(range(1, len(caps_per_cycle) + 1))

        return {
            "ok":            True,
            "cycles":        cycles_out,
            "capacity":      [round(c, 4) for c in caps_per_cycle],
            "chemistry":     chem,
            "param_set":     param_name,
            "nominal_cap":   nom_cap,
            "params": {
                "c_rate_dis":  c_rate_dis,
                "c_rate_chg":  c_rate_chg,
                "temperature": temperature,
                "soc_max":     soc_max,
                "v_dis":       v_dis,
                "v_chg":       round(v_chg, 3),
            },
        }
    except Exception as exc:
        logger.warning("PyBaMM simulation failed: %s", exc)
        return {"ok": False, "error": str(exc)}


# ── Full twin: fit + forecast + validation ───────────────────────────────────

def build_twin(cell_id: str) -> dict:
    """
    Load cell data, fit analytical twin, compute uncertainty, validate params.
    Returns the full twin dict including confidence interval on the forecast.
    """
    import core.data_loader as dl
    if dl._meta_df is None:
        dl.load_dataset()

    meta = dl._meta_df
    mask = meta["cell_id"].values == cell_id
    if not mask.any():
        return {"error": f"Cell '{cell_id}' not found"}

    idx  = np.where(mask)[0]
    grp  = meta.iloc[idx].sort_values("cycle")
    ridx = grp.index.values

    cycles   = grp["cycle"].tolist()
    capacity = [round(float(dl._features[i, 0]), 4) for i in ridx]
    soh_arr  = [round(float(dl._features[i, 9]), 4) for i in ridx]
    ir_arr   = [round(float(dl._features[i, 7]), 4) for i in ridx]
    temp_arr = [round(float(dl._features[i, 5]), 1) for i in ridx]

    fit = fit_analytical(cycles, capacity)

    # Re-run curve_fit to get covariance for uncertainty propagation
    pcov = None
    try:
        n   = np.array(cycles, dtype=float)
        Q   = np.array(capacity, dtype=float)
        Q0  = fit["params"]["Q0"]
        p0  = list(fit["params"].values())
        _, pcov = curve_fit(
            _degradation_model, n, Q,
            p0=p0,
            bounds=([0, 0, 0, 0], [Q0 * 1.1, 1.0, 0.1, 0.01]),
            maxfev=8000, method='trf',
        )
    except Exception:
        pass

    pred = predict_trajectory(fit["params"], n_future=300,
                              last_cycle=cycles[-1], pcov=pcov)

    chem   = str(grp["chemistry_name"].iloc[0])
    valid  = validate_params(fit["params"], chem)

    param_name = _CHEM_PYBAMM.get(chem.upper(), "Chen2020")
    nom_cap    = _PYBAMM_NOMINAL_CAP.get(param_name, 5.0)
    scale      = fit["params"]["Q0"] / nom_cap

    # Calendar aging at mean observed temperature
    mean_temp  = float(np.mean(temp_arr)) if temp_arr else 25.0
    cal_aging  = estimate_calendar_aging(fit["params"], months=24, temperature_c=mean_temp)

    # Hold-out validation: fit on first 80%, eval on last 20%
    holdout_metrics = _holdout_validate(cycles, capacity, fit["params"])

    return {
        "cell_id":        cell_id,
        "chemistry":      chem,
        "param_set":      param_name,
        "n_cycles":       len(cycles),
        "observed": {
            "cycles":   [int(c) for c in cycles],
            "capacity": capacity,
            "soh":      soh_arr,
            "ir":       ir_arr,
            "temp":     temp_arr,
        },
        "fit":              fit,
        "forecast":         pred,
        "param_validation": valid,
        "calendar_aging":   cal_aging,
        "holdout":          holdout_metrics,
        "pybamm_scale":     round(scale, 3),
        "pybamm_param_set": param_name,
        "mean_temp_c":      round(mean_temp, 1),
    }


def _holdout_validate(cycles: list, capacity: list, params: dict) -> dict:
    """Fit on first 80%, report RMSE+MAE on held-out 20%."""
    n    = len(cycles)
    if n < 10:
        return {"skipped": True, "reason": "< 10 cycles"}
    split = max(5, int(n * 0.8))
    try:
        fit_ho = fit_analytical(cycles[:split], capacity[:split])
        pred_cycles = np.array(cycles[split:], dtype=float)
        pred_cap    = _degradation_model(
            pred_cycles,
            fit_ho["params"]["Q0"], fit_ho["params"]["alpha"],
            fit_ho["params"]["k_sei"], fit_ho["params"]["k_crack"],
        )
        true_cap    = np.array(capacity[split:], dtype=float)
        rmse = float(np.sqrt(np.mean((true_cap - pred_cap) ** 2)))
        mae  = float(np.mean(np.abs(true_cap - pred_cap)))
        q0   = fit_ho["params"]["Q0"]
        return {
            "n_train":      split,
            "n_test":       n - split,
            "rmse_ah":      round(rmse, 5),
            "mae_ah":       round(mae, 5),
            "rmse_pct_q0":  round(rmse / q0 * 100, 2),
            "r2_train":     fit_ho["r2"],
        }
    except Exception as e:
        return {"skipped": True, "reason": str(e)[:80]}


# ── Fleet twin summary ────────────────────────────────────────────────────────

def fleet_twin_summary(max_cells: int = 50) -> dict:
    """
    Fit twins for up to max_cells cells and return fleet-level statistics:
    R² distribution, EOL distribution, average k_SEI per chemistry.
    """
    import core.data_loader as dl
    if dl._meta_df is None:
        dl.load_dataset()

    # Pick cells with ≥ 30 cycles
    counts = dl._meta_df.groupby("cell_id").size()
    cells  = counts[counts >= 30].sort_values(ascending=False).head(max_cells).index.tolist()

    results = []
    for cell_id in cells:
        try:
            t = build_twin(str(cell_id))
            if "error" in t:
                continue
            results.append({
                "cell_id":   cell_id,
                "chemistry": t["chemistry"],
                "r2":        t["fit"]["r2"],
                "k_sei":     t["fit"]["params"]["k_sei"],
                "eol_cycle": t["forecast"]["eol_cycle"],
                "n_cycles":  t["n_cycles"],
                "rmse_pct":  t["holdout"].get("rmse_pct_q0"),
                "param_valid": not bool(t["param_validation"]["warnings"]),
            })
        except Exception:
            pass

    if not results:
        return {"n_cells": 0}

    r2_vals  = [r["r2"] for r in results]
    eol_vals = [r["eol_cycle"] for r in results if r["eol_cycle"]]

    return {
        "n_cells":       len(results),
        "r2_mean":       round(float(np.mean(r2_vals)), 3),
        "r2_median":     round(float(np.median(r2_vals)), 3),
        "r2_pct_above_090": round(sum(1 for v in r2_vals if v >= 0.90) / len(r2_vals) * 100, 1),
        "eol_mean":      round(float(np.mean(eol_vals)), 0) if eol_vals else None,
        "eol_std":       round(float(np.std(eol_vals)), 0)  if eol_vals else None,
        "cells":         results,
    }


# ── Fitted-params cache (TTL=3600s) ──────────────────────────────────────────

_twin_cache: dict[str, dict] = {}
_twin_lock  = threading.Lock()
TWIN_CACHE_TTL = 3600  # seconds; re-fit after 1 hour


def get_twin_cached(cell_id: str) -> Optional[dict]:
    """Return cached twin or None if stale/absent."""
    with _twin_lock:
        entry = _twin_cache.get(cell_id)
        if entry and (_time.monotonic() - entry["ts"]) < TWIN_CACHE_TTL:
            return entry["twin"]
    return None


def build_twin_cached(cell_id: str) -> dict:
    """build_twin() with TTL cache. Thread-safe. Re-fits when the entry expires."""
    cached = get_twin_cached(cell_id)
    if cached is not None:
        return cached
    twin = build_twin(cell_id)
    if "error" not in twin:
        with _twin_lock:
            _twin_cache[cell_id] = {"ts": _time.monotonic(), "twin": twin}
    return twin


def invalidate_twin(cell_id: str) -> None:
    """Force cache miss for a cell (e.g. after new cycles arrive)."""
    with _twin_lock:
        _twin_cache.pop(cell_id, None)


# ── PyBaMM simulation with hard timeout ──────────────────────────────────────

def run_pybamm_simulation_safe(
    n_cycles:    int   = 100,
    c_rate_dis:  float = 1.0,
    c_rate_chg:  float = 0.5,
    temperature: float = 25.0,
    soc_max:     float = 1.0,
    Q0_scale:    float = 1.0,
    chemistry:   str   = "NMC",
    timeout:     float = 30.0,
) -> dict:
    """
    run_pybamm_simulation() wrapped with a hard CPU timeout.
    Returns {"ok": False, "error": "timeout"} if it exceeds `timeout` seconds.
    """
    from concurrent.futures import ThreadPoolExecutor, TimeoutError as _FTimeout
    with ThreadPoolExecutor(max_workers=1) as pool:
        fut = pool.submit(
            run_pybamm_simulation,
            n_cycles=n_cycles, c_rate_dis=c_rate_dis, c_rate_chg=c_rate_chg,
            temperature=temperature, soc_max=soc_max, Q0_scale=Q0_scale,
            chemistry=chemistry,
        )
        try:
            return fut.result(timeout=timeout)
        except _FTimeout:
            logger.warning("PyBaMM timed out after %.0fs (%s)", timeout, chemistry)
            return {"ok": False, "error": f"timeout after {timeout:.0f}s"}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


# ── Layer 3.5: physics-based RUL signal ──────────────────────────────────────

def get_twin_rul(cell_id: str, current_cycle: int) -> Optional[dict]:
    """
    Physics-based RUL from the analytical degradation twin.

    Uses the cached twin (TTL=3600s).  Returns None when the cell has no data
    in the training set or the twin fit failed.  Never raises.

    Return dict: {rul, rul_lower, rul_upper, eol_cycle, source, r2}
    """
    try:
        twin = build_twin_cached(cell_id)
        if "error" in twin:
            return None

        eol_cycle = twin.get("forecast", {}).get("eol_cycle")
        if eol_cycle is None:
            return None

        rul = max(0, eol_cycle - current_cycle)

        # Propagate 90% CI from bootstrap uncertainty bands
        ci_lo      = twin.get("forecast", {}).get("ci90_lo") or []
        ci_hi      = twin.get("forecast", {}).get("ci90_hi") or []
        fc_cycles  = twin.get("forecast", {}).get("cycles")  or []
        fc_caps    = twin.get("forecast", {}).get("capacity") or []

        if ci_lo and ci_hi and fc_cycles and fc_caps:
            fc_arr = np.array(fc_cycles)
            diff   = np.abs(fc_arr - current_cycle)
            idx    = int(np.argmin(diff))
            q_now  = float(fc_caps[idx])
            q_lo   = float(ci_lo[idx])
            q_hi   = float(ci_hi[idx])
            frac   = min((q_hi - q_lo) / max(q_now, 1e-6), 0.5)
            rul_lo = max(0, round(rul * (1.0 - frac * 2.0)))
            rul_hi = round(rul * (1.0 + frac * 2.0))
        else:
            spread = max(round(rul * 0.15), 10)
            rul_lo = max(0, rul - spread)
            rul_hi = rul + spread

        return {
            "rul":       rul,
            "rul_lower": rul_lo,
            "rul_upper": rul_hi,
            "eol_cycle": eol_cycle,
            "source":    "digital_twin",
            "r2":        twin.get("fit", {}).get("r2"),
        }
    except Exception as exc:
        logger.debug("get_twin_rul failed for %s: %s", cell_id, exc)
        return None

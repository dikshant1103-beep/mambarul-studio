"""
core/thermal_model.py — Thermal gradient analysis and runaway risk scoring.

Uses a simplified lumped-thermal-resistance model.  No finite-element solver —
intended for real-time pack monitoring, not cell design.
"""
from __future__ import annotations
import logging
import math
from dataclasses import dataclass, field

logger = logging.getLogger(__name__)


@dataclass
class ThermalState:
    hotspots:       list[dict] = field(default_factory=list)
    mean_temp:      float = 0.0
    max_temp:       float = 0.0
    min_temp:       float = 0.0
    gradient_c:     float = 0.0   # max - min
    runaway_risk:   float = 0.0   # 0-1 normalized risk index
    runaway_alert:  bool  = False


def _runaway_risk(max_temp: float, gradient: float,
                  rate_of_rise: float = 0.0) -> float:
    """
    Empirical risk index [0,1].
    Factors: absolute temperature, gradient, rate of rise.
    > 0.7 → alert.  > 0.9 → imminent trip.
    """
    t_factor = max(0.0, (max_temp - 40.0) / 30.0)           # 0 at 40°C, 1 at 70°C
    g_factor = max(0.0, min(1.0, gradient / 15.0))           # 0 at 0°C, 1 at 15°C gradient
    r_factor = max(0.0, min(1.0, rate_of_rise / 2.0))       # 0 at 0°C/s, 1 at 2°C/s
    risk = 0.5 * t_factor + 0.3 * g_factor + 0.2 * r_factor
    return round(min(1.0, max(0.0, risk)), 3)


def analyze_pack(cell_ids: list[str], temperatures: list[float],
                 currents: list[float] | None = None,
                 capacities_ah: list[float] | None = None,
                 prev_temps: list[float] | None = None,
                 dt_seconds: float = 1.0) -> ThermalState:
    """
    Full thermal analysis of a pack snapshot.

    Parameters
    ----------
    cell_ids      : list of cell identifiers
    temperatures  : °C per cell (same order as cell_ids)
    currents      : A per cell (for Joule heating estimate)
    capacities_ah : Ah per cell (for internal resistance estimate)
    prev_temps    : previous °C snapshot (for rate-of-rise)
    dt_seconds    : time since last snapshot
    """
    if not temperatures:
        return ThermalState()

    n = len(temperatures)
    mean_t = sum(temperatures) / n
    max_t  = max(temperatures)
    min_t  = min(temperatures)
    grad   = max_t - min_t

    # Rate of rise (°C/s) from max cell
    ror = 0.0
    if prev_temps and len(prev_temps) == n and dt_seconds > 0:
        max_idx = temperatures.index(max_t)
        ror = max(0.0, (temperatures[max_idx] - prev_temps[max_idx]) / dt_seconds)

    risk  = _runaway_risk(max_t, grad, ror)
    state = ThermalState(
        mean_temp    = round(mean_t, 2),
        max_temp     = round(max_t, 2),
        min_temp     = round(min_t, 2),
        gradient_c   = round(grad, 2),
        runaway_risk = risk,
        runaway_alert = risk > 0.70,
    )

    # Hotspot detection: cells > mean + 2σ
    try:
        import statistics
        std_t = statistics.stdev(temperatures) if n > 1 else 0.0
    except Exception:
        std_t = 0.0
    threshold = mean_t + max(2.0 * std_t, 3.0)   # at least 3°C above mean

    for cid, t in zip(cell_ids, temperatures):
        if t > threshold:
            state.hotspots.append({
                "cell_id":   cid,
                "temp":      round(t, 2),
                "excess_c":  round(t - mean_t, 2),
            })

    return state


def joule_heat_estimate(current_a: float, capacity_ah: float,
                        soh: float = 1.0) -> float:
    """
    Estimate Joule heating power (W) using simplified internal resistance model.
    R_int ≈ 0.05 Ω / Ah × (1 + 0.5*(1-SOH))  (empirical for Li-ion)
    """
    r_int = 0.05 / max(capacity_ah, 0.1) * (1 + 0.5 * (1 - soh))
    return round(current_a ** 2 * r_int, 4)


# ── Thermal coupling matrix ───────────────────────────────────────────────────

def compute_thermal_coupling_matrix(n_cells: int,
                                     topology: str = "series") -> list[list[float]]:
    """
    Build an N×N thermal coupling matrix C where C[i][j] is the heat-transfer
    coefficient between cell i and cell j (normalised 0–1).

    Series string: adjacent cells share a face → exponential decay with distance.
    Parallel string: cells share bus bars → uniform moderate coupling.
    """
    C = [[0.0] * n_cells for _ in range(n_cells)]
    for i in range(n_cells):
        for j in range(n_cells):
            if i == j:
                continue
            dist = abs(i - j)
            if topology == "parallel":
                # Parallel cells share bus bars — moderate, distance-independent coupling
                C[i][j] = 0.4
            else:
                # Series: adjacent faces → coupling decays with separation
                C[i][j] = math.exp(-0.8 * dist)
    return C


# ── Thermal propagation risk ──────────────────────────────────────────────────

def thermal_propagation_risk(
    cell_ids: list[str],
    temperatures: list[float],
    sohs: list[float] | None = None,
    topology: str = "series",
    runaway_threshold: float = 70.0,
) -> dict:
    """
    Estimate probability that a thermal runaway in any hot cell propagates to
    its neighbours.  Returns a risk map and overall pack cascade probability.

    P(propagation i→j) = C_ij × T_excess_i/ΔT_ref × degradation_j
    where degradation_j = (1 - SOH_j) + 0.2 (baseline even for healthy cell).
    """
    n = len(cell_ids)
    if n == 0:
        return {"cascade_probability": 0.0, "risk_pairs": [], "safe": True}

    if sohs is None:
        sohs = [1.0] * n
    sohs = list(sohs)[:n]
    if len(sohs) < n:
        sohs += [1.0] * (n - len(sohs))

    C = compute_thermal_coupling_matrix(n, topology)
    mean_t = sum(temperatures) / n
    dt_ref = max(runaway_threshold - mean_t, 5.0)   # reference ΔT

    risk_pairs = []
    max_cascade_p = 0.0

    for i in range(n):
        t_excess = max(0.0, temperatures[i] - runaway_threshold * 0.80)
        if t_excess <= 0:
            continue
        t_factor = min(1.0, t_excess / dt_ref)

        for j in range(n):
            if i == j:
                continue
            degradation_j = (1.0 - sohs[j]) + 0.2  # more degraded = more vulnerable
            p = C[i][j] * t_factor * min(1.0, degradation_j)
            p = round(min(1.0, max(0.0, p)), 4)
            if p > 0.05:
                risk_pairs.append({
                    "source_cell":  cell_ids[i],
                    "target_cell":  cell_ids[j],
                    "probability":  p,
                    "coupling":     round(C[i][j], 3),
                    "source_temp":  round(temperatures[i], 2),
                    "target_soh":   round(sohs[j], 3),
                })
                max_cascade_p = max(max_cascade_p, p)

    risk_pairs.sort(key=lambda x: -x["probability"])

    # Pack-level cascade probability: P(at least one propagation occurs)
    # = 1 - ∏(1 - P_ij) for all pairs
    p_none = 1.0
    for pair in risk_pairs:
        p_none *= (1.0 - pair["probability"])
    cascade_p = round(1.0 - p_none, 4)

    level = "critical" if cascade_p > 0.5 else "high" if cascade_p > 0.25 \
            else "moderate" if cascade_p > 0.10 else "low"

    return {
        "cascade_probability": cascade_p,
        "level":               level,
        "safe":                cascade_p < 0.10,
        "risk_pairs":          risk_pairs[:10],  # top-10 highest risk pairs
        "n_cells":             n,
        "topology":            topology,
    }


# ── Time-to-thermal-event estimate ───────────────────────────────────────────

def time_to_thermal_event(
    temp_c: float,
    rate_of_rise_c_per_s: float,
    runaway_threshold: float = 80.0,
    warning_threshold: float = 60.0,
) -> dict:
    """
    Estimate time (seconds) until cell reaches warning and runaway thresholds.
    Assumes constant rate of rise (worst-case linear model).
    """
    if rate_of_rise_c_per_s <= 0:
        return {
            "time_to_warning_s":  None,
            "time_to_runaway_s":  None,
            "current_temp_c":     round(temp_c, 2),
            "rate_of_rise":       0.0,
            "imminent":           False,
        }

    delta_warn    = max(0.0, warning_threshold - temp_c)
    delta_runaway = max(0.0, runaway_threshold - temp_c)

    t_warn    = round(delta_warn    / rate_of_rise_c_per_s, 1) if delta_warn > 0    else 0.0
    t_runaway = round(delta_runaway / rate_of_rise_c_per_s, 1) if delta_runaway > 0 else 0.0

    return {
        "time_to_warning_s":  t_warn    if delta_warn > 0    else None,
        "time_to_runaway_s":  t_runaway if delta_runaway > 0 else None,
        "current_temp_c":     round(temp_c, 2),
        "rate_of_rise_c_per_s": round(rate_of_rise_c_per_s, 4),
        "imminent":           temp_c >= warning_threshold or t_warn <= 30,
        "warning_threshold_c":  warning_threshold,
        "runaway_threshold_c":  runaway_threshold,
    }


# ── Full thermal pack analysis (extended) ────────────────────────────────────

def full_thermal_analysis(
    cell_ids: list[str],
    temperatures: list[float],
    sohs: list[float] | None = None,
    currents: list[float] | None = None,
    capacities_ah: list[float] | None = None,
    prev_temps: list[float] | None = None,
    dt_seconds: float = 1.0,
    topology: str = "series",
) -> dict:
    """
    Extended thermal analysis: hotspot detection + coupling + propagation risk
    + time-to-event for each cell.  Superset of analyze_pack().
    """
    state = analyze_pack(
        cell_ids, temperatures, currents, capacities_ah, prev_temps, dt_seconds
    )

    n = len(cell_ids)
    if sohs is None:
        sohs = [1.0] * n

    # Rate of rise per cell
    rors = [0.0] * n
    if prev_temps and len(prev_temps) == n and dt_seconds > 0:
        rors = [max(0.0, (temperatures[i] - prev_temps[i]) / dt_seconds) for i in range(n)]

    # Per-cell time-to-event
    per_cell_tte = []
    for i, (cid, t, ror) in enumerate(zip(cell_ids, temperatures, rors)):
        tte = time_to_thermal_event(t, ror)
        tte["cell_id"] = cid
        per_cell_tte.append(tte)

    # Propagation risk
    prop = thermal_propagation_risk(cell_ids, temperatures, sohs, topology)

    return {
        # From analyze_pack
        "mean_temp":      state.mean_temp,
        "max_temp":       state.max_temp,
        "min_temp":       state.min_temp,
        "gradient_c":     state.gradient_c,
        "runaway_risk":   state.runaway_risk,
        "runaway_alert":  state.runaway_alert,
        "hotspots":       state.hotspots,
        # New
        "propagation":    prop,
        "per_cell_tte":   per_cell_tte,
        "topology":       topology,
        "n_cells":        n,
    }

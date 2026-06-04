"""
core/pack_intelligence.py — Pack-level weak-cell detection and health scoring.

Topology-aware: series string capacity is bottlenecked by the weakest cell.
Parallel string capacity is the sum. Real packs are Ns×Np (series × parallel).

Key outputs
-----------
pack_health_score   0–100  weighted function of SOH distribution + imbalance
first_failure       cell predicted to hit EOL first + cycles estimate
pack_rul            pack-level RUL (series = min-cell; parallel = harmonic mean)
cascade_risk        0–1    probability that one failing cell drags neighbours
weak_cell_report    per-cell delta from mean + impact on pack capacity
"""
from __future__ import annotations

import math
import statistics
from typing import Optional


# ── Per-cell input schema ─────────────────────────────────────────────────────

def _validate(cells: list[dict]) -> list[dict]:
    """Ensure every cell dict has the expected keys; fill defaults."""
    out = []
    for i, c in enumerate(cells):
        out.append({
            "cell_id":     c.get("cell_id", f"cell_{i}"),
            "soh":         float(c.get("soh", 1.0)),          # 0–1
            "rul":         float(c.get("rul", 500)),           # cycles
            "capacity_ah": float(c.get("capacity_ah", 5.0)),
            "ir":          float(c.get("ir", 0.05)),           # Ω
            "chemistry":   c.get("chemistry", "NMC"),
            "fade_rate":   float(c.get("fade_rate", 0.0001)),  # ΔSOH/cycle
        })
    return out


# ── Pack topology helpers ─────────────────────────────────────────────────────

def _series_pack_cap(caps: list[float]) -> float:
    """Series string: limited by the cell with the smallest capacity."""
    return min(caps) if caps else 0.0


def _parallel_pack_cap(caps: list[float]) -> float:
    """Parallel string: sum of all cell capacities."""
    return sum(caps)


def _ideal_pack_cap(caps: list[float], ns: int, np: int) -> float:
    """Ns×Np pack: parallel cap of Np groups, each group = min of Ns cells."""
    n = len(caps)
    cells_per_parallel = max(1, n // max(np, 1))
    group_caps = []
    for g in range(np):
        group = caps[g * cells_per_parallel: (g + 1) * cells_per_parallel]
        if group:
            group_caps.append(_series_pack_cap(group))
    return _parallel_pack_cap(group_caps) if group_caps else 0.0


# ── Pack health score ─────────────────────────────────────────────────────────

def pack_health_score(cells: list[dict], topology: str = "series") -> dict:
    """
    Compute pack-level health score (0–100) and imbalance metrics.

    topology: "series" | "parallel" | "series-parallel"
    """
    cells = _validate(cells)
    if not cells:
        return {"score": 0, "grade": "D", "n_cells": 0}

    sohs = [c["soh"] for c in cells]
    caps = [c["capacity_ah"] for c in cells]
    irs  = [c["ir"] for c in cells]

    mean_soh = statistics.mean(sohs)
    min_soh  = min(sohs)
    std_soh  = statistics.stdev(sohs) if len(sohs) > 1 else 0.0

    # Imbalance = coefficient of variation of SOH (0=perfect, >0.1=severe)
    imbalance = std_soh / max(mean_soh, 0.01)

    # Pack capacity utilisation (how much the weak cell reduces pack capacity)
    if topology == "parallel":
        pack_cap = _parallel_pack_cap(caps)
        ideal_cap = sum(caps)
    else:  # series (conservative, default)
        pack_cap = _series_pack_cap(caps)
        ideal_cap = statistics.mean(caps) * len(caps) / len(caps)   # per-cell mean

    cap_utilisation = min_soh / max(mean_soh, 0.01)   # 1.0 = balanced pack

    # Score components (0–100)
    s_soh    = mean_soh * 100                        # average SOH
    s_balance = max(0.0, (1 - imbalance * 5)) * 100  # penalise imbalance
    s_cap    = cap_utilisation * 100                 # weak-cell bottleneck penalty
    score    = round(0.50 * s_soh + 0.30 * s_balance + 0.20 * s_cap, 1)
    score    = max(0.0, min(100.0, score))

    grade = "A" if score >= 85 else "B" if score >= 70 else "C" if score >= 50 else "D"

    # Identify weak cells: SOH < mean - 1.5σ  OR  SOH < 0.80
    threshold = max(mean_soh - 1.5 * std_soh, 0.80)
    weak = [c for c in cells if c["soh"] < threshold]

    return {
        "score":         score,
        "grade":         grade,
        "mean_soh_pct":  round(mean_soh * 100, 1),
        "min_soh_pct":   round(min_soh * 100, 1),
        "soh_std":       round(std_soh, 4),
        "imbalance":     round(imbalance, 4),
        "cap_utilisation_pct": round(cap_utilisation * 100, 1),
        "n_cells":       len(cells),
        "n_weak":        len(weak),
        "weak_cell_ids": [c["cell_id"] for c in weak],
    }


# ── First-failure prediction ──────────────────────────────────────────────────

def predict_first_failure(cells: list[dict], eol_soh: float = 0.80) -> dict:
    """
    Predict which cell will hit EOL first and estimated cycles remaining.

    Uses each cell's fade_rate (ΔSOH/cycle). Falls back to RUL if fade_rate=0.
    Returns: first_failure_cell_id, cycles_to_eol, warning_cells (SOH < 85%).
    """
    cells = _validate(cells)
    if not cells:
        return {"first_failure_cell": None, "cycles_to_eol": None}

    estimates = []
    for c in cells:
        if c["fade_rate"] > 0:
            cycles = max(0.0, (c["soh"] - eol_soh) / c["fade_rate"])
        else:
            cycles = c["rul"]   # fall back to model RUL
        estimates.append((cycles, c["cell_id"], c["soh"]))

    estimates.sort(key=lambda x: x[0])
    first_cycles, first_id, first_soh = estimates[0]

    # Warning cells: will fail within 20% of first-failure cycles
    warn_threshold = first_cycles * 1.20
    warning_cells = [
        {"cell_id": cid, "cycles_to_eol": round(cyc, 0), "soh_pct": round(soh * 100, 1)}
        for cyc, cid, soh in estimates
        if cyc <= warn_threshold and cid != first_id
    ]

    return {
        "first_failure_cell":   first_id,
        "first_failure_soh_pct": round(first_soh * 100, 1),
        "cycles_to_eol":         round(first_cycles, 0),
        "warning_cells":         warning_cells,
        "pack_eol_cycles":       round(first_cycles, 0),   # pack EOL = first cell EOL (series)
    }


# ── Pack RUL estimate ─────────────────────────────────────────────────────────

def pack_rul_estimate(cells: list[dict], topology: str = "series") -> dict:
    """
    Estimate pack-level RUL from per-cell RULs.

    Series:   pack fails when first cell hits EOL → min(RUL)
    Parallel: pack fails when average SOH-weighted string hits EOL
              → harmonic mean weighted by SOH (the lagging cell dominates)
    """
    cells = _validate(cells)
    if not cells:
        return {"pack_rul": 0}

    ruls = [c["rul"] for c in cells]
    sohs = [c["soh"] for c in cells]

    if topology == "parallel":
        # Harmonic mean: lagging cell dominates
        n = len(ruls)
        harmonic = n / sum(1.0 / max(r, 1) for r in ruls)
        pack_rul = round(harmonic, 0)
        method = "harmonic_mean"
    else:  # series
        pack_rul = round(min(ruls), 0)
        method = "min_cell"

    min_rul_cell = min(cells, key=lambda c: c["rul"])

    return {
        "pack_rul":      pack_rul,
        "topology":      topology,
        "method":        method,
        "min_rul_cell":  min_rul_cell["cell_id"],
        "min_rul_value": round(min_rul_cell["rul"], 0),
        "max_rul_value": round(max(ruls), 0),
        "rul_spread":    round(max(ruls) - min(ruls), 0),
    }


# ── Cascade / propagation risk ────────────────────────────────────────────────

def cascade_risk_score(cells: list[dict]) -> dict:
    """
    Statistical risk that degradation in the weakest cell cascades to neighbours.

    Risk factors:
    - SOH imbalance: std / mean > 0.1 → high risk
    - Weakest cell SOH < mean - 2σ → very high risk
    - High IR of weak cells → internal heat → accelerated neighbour degradation

    Returns a 0–1 risk score and actionable recommendation.
    """
    cells = _validate(cells)
    if not cells:
        return {"cascade_risk": 0.0, "level": "low"}

    sohs = [c["soh"] for c in cells]
    irs  = [c["ir"]  for c in cells]
    mean_soh = statistics.mean(sohs)
    std_soh  = statistics.stdev(sohs) if len(sohs) > 1 else 0.0
    min_soh  = min(sohs)

    # Imbalance factor (0–1): high when SOH spread is large
    imbalance_factor = min(1.0, std_soh / max(mean_soh * 0.1, 0.005))

    # Weak-cell factor: how far below mean is the worst cell
    weak_gap = max(0.0, mean_soh - min_soh)
    weak_factor = min(1.0, weak_gap / 0.15)   # 0 at 0 gap, 1 at ≥15% gap

    # IR factor: elevated IR in weakest cell → joule heating risk
    ir_mean = statistics.mean(irs)
    ir_max  = max(irs)
    ir_factor = min(1.0, max(0.0, (ir_max / max(ir_mean, 0.001) - 1.0) / 2.0))

    risk = 0.40 * imbalance_factor + 0.40 * weak_factor + 0.20 * ir_factor
    risk = round(min(1.0, max(0.0, risk)), 3)

    level = "critical" if risk > 0.7 else "high" if risk > 0.5 else "moderate" if risk > 0.3 else "low"

    recs = []
    if weak_factor > 0.5:
        recs.append("Replace or isolate the weakest cell before it accelerates pack degradation")
    if imbalance_factor > 0.5:
        recs.append("Balance pack SOH — consider selective cell replacement to match SOH within ±5%")
    if ir_factor > 0.5:
        recs.append("High IR cell detected — risk of thermal hot-spot during fast charge")

    return {
        "cascade_risk":       risk,
        "level":              level,
        "imbalance_factor":   round(imbalance_factor, 3),
        "weak_cell_factor":   round(weak_factor, 3),
        "ir_factor":          round(ir_factor, 3),
        "recommendations":    recs,
    }


# ── Replacement analysis ─────────────────────────────────────────────────────

def replacement_analysis(cells: list[dict], topology: str = "series") -> list[dict]:
    """
    For each cell, estimate cycles gained and pack SOH recovery if that cell
    is replaced now with a fresh cell (SOH=1.0, IR=0.03, fade_rate unchanged).

    Returns a list sorted by cycles_gained descending (best replacement first).
    """
    cells = _validate(cells)
    if not cells:
        return []

    sohs = [c["soh"] for c in cells]
    mean_soh = statistics.mean(sohs)
    n = len(cells)

    results = []
    for i, c in enumerate(cells):
        # Simulate pack SOH after replacing this cell
        new_sohs = sohs[:]
        new_sohs[i] = 1.0
        new_min = min(new_sohs)
        new_mean = statistics.mean(new_sohs)

        if topology == "series":
            pack_soh_before = min(sohs)
            pack_soh_after  = new_min
        else:
            pack_soh_before = mean_soh
            pack_soh_after  = new_mean

        soh_recovery_pct = round((pack_soh_after - pack_soh_before) * 100, 2)

        # Cycles gained: SOH recovery / current cell fade_rate (proxy)
        fade = max(c["fade_rate"], 1e-5)
        cycles_gained = round(soh_recovery_pct / 100 / fade, 0) if soh_recovery_pct > 0 else 0.0

        # Estimated replacement value (normalized 0-1: higher = more impactful)
        value_score = round(min(1.0, soh_recovery_pct / 20.0), 3)  # 20% recovery → score 1.0

        results.append({
            "cell_id":             c["cell_id"],
            "current_soh_pct":     round(c["soh"] * 100, 1),
            "pack_soh_before_pct": round(pack_soh_before * 100, 1),
            "pack_soh_after_pct":  round(pack_soh_after * 100, 1),
            "soh_recovery_pct":    soh_recovery_pct,
            "cycles_gained":       cycles_gained,
            "value_score":         value_score,
            "recommended":         soh_recovery_pct > 2.0,
        })

    results.sort(key=lambda x: x["cycles_gained"], reverse=True)
    return results


# ── Pack timeline projection ──────────────────────────────────────────────────

def project_pack_timeline(
    cells: list[dict],
    n_cycles: int = 500,
    step: int = 25,
    topology: str = "series",
    eol_soh: float = 0.80,
) -> list[dict]:
    """
    Simulate pack SOH over n_cycles in two scenarios:
      - no_change: cells degrade at their current fade_rate
      - replace_weakest: weakest cell is replaced at cycle 0, then natural degradation

    Returns list of {cycle, pack_soh_no_change, pack_soh_replace_weakest, bottleneck_cell}.
    EOL is marked when pack_soh drops below eol_soh.
    """
    cells = _validate(cells)
    if not cells:
        return []

    def _pack_soh(sohs: list[float]) -> float:
        if topology == "series":
            return min(sohs)
        return statistics.mean(sohs)

    # Identify weakest cell (lowest SOH)
    weakest_idx = min(range(len(cells)), key=lambda i: cells[i]["soh"])

    # Build baseline state
    base_sohs   = [c["soh"] for c in cells]
    fades       = [max(c["fade_rate"], 1e-6) for c in cells]

    # Replace scenario: swap weakest cell with fresh (SOH=1.0)
    repl_sohs = base_sohs[:]
    repl_sohs[weakest_idx] = 1.0

    timeline = []
    for cyc in range(0, n_cycles + 1, step):
        # Degrade each scenario
        degraded_base = [max(0.0, s - fades[i] * cyc) for i, s in enumerate(base_sohs)]
        degraded_repl = [max(0.0, s - fades[i] * cyc) for i, s in enumerate(repl_sohs)]

        ps_base = round(_pack_soh(degraded_base) * 100, 2)
        ps_repl = round(_pack_soh(degraded_repl) * 100, 2)

        bottleneck_idx = min(range(len(degraded_base)), key=lambda i: degraded_base[i])

        timeline.append({
            "cycle":                    cyc,
            "pack_soh_no_change":       ps_base,
            "pack_soh_replace_weakest": ps_repl,
            "bottleneck_cell":          cells[bottleneck_idx]["cell_id"],
            "eol_no_change":            ps_base < eol_soh * 100,
            "eol_replace_weakest":      ps_repl < eol_soh * 100,
        })

    return timeline


# ── Thermal stress propagation map ───────────────────────────────────────────

_FRESH_IR = 0.030   # Ω — baseline IR for a fresh cell

def propagation_stress_map(cells: list[dict]) -> dict:
    """
    For each cell with elevated IR (> 1.5× fresh baseline), estimate the
    thermal stress it imposes on adjacent cells in a linear string.

    Stress model: P_extra = (IR - IR_fresh) * I² (extra joule heating).
    Adjacent cells absorb ~30% of that heat, accelerating their fade_rate.

    Returns:
      hot_cells: list of high-IR cells with stress metrics
      adjacency_effects: per-cell thermal stress received from neighbours
      overall_thermal_risk: 0–1
    """
    cells = _validate(cells)
    if not cells:
        return {"hot_cells": [], "adjacency_effects": [], "overall_thermal_risk": 0.0}

    n = len(cells)
    ir_threshold = _FRESH_IR * 1.5   # 0.045 Ω

    # Typical charge current (1C for a 5 Ah cell ≈ 5 A)
    I_charge = 5.0   # A (conservative)

    hot_cells = []
    for c in cells:
        excess_ir = max(0.0, c["ir"] - _FRESH_IR)
        if c["ir"] >= ir_threshold:
            p_extra = excess_ir * (I_charge ** 2)  # watts extra
            hot_cells.append({
                "cell_id":         c["cell_id"],
                "ir_ohm":          round(c["ir"], 4),
                "ir_ratio":        round(c["ir"] / _FRESH_IR, 2),
                "excess_heat_W":   round(p_extra, 3),
                "risk":            "critical" if c["ir"] > _FRESH_IR * 2.5 else "high",
            })

    # Build adjacency stress map (linear string topology)
    cell_index = {c["cell_id"]: i for i, c in enumerate(cells)}
    adjacency_effects: list[dict] = []

    for c in cells:
        received_stress = 0.0
        sources = []
        idx = cell_index[c["cell_id"]]
        for neighbour_offset in [-1, 1]:
            n_idx = idx + neighbour_offset
            if 0 <= n_idx < n:
                nb = cells[n_idx]
                excess_ir = max(0.0, nb["ir"] - _FRESH_IR)
                p_extra = excess_ir * (I_charge ** 2)
                absorbed = p_extra * 0.30   # 30% heat coupling to adjacent cell
                if absorbed > 0.0001:
                    received_stress += absorbed
                    sources.append(nb["cell_id"])

        # Extra fade acceleration factor (1.0 = no extra, >1 = accelerated)
        # Assume 1 W extra heat → +0.5% faster fade
        accel_factor = round(1.0 + received_stress * 0.005, 4)

        if received_stress > 0.0001:
            adjacency_effects.append({
                "cell_id":         c["cell_id"],
                "heat_received_W": round(received_stress, 4),
                "heat_sources":    sources,
                "fade_accel_factor": accel_factor,
                "at_risk":         accel_factor > 1.0005,
            })

    # Overall thermal risk (0–1)
    if not cells:
        overall = 0.0
    else:
        ir_ratios = [c["ir"] / _FRESH_IR for c in cells]
        max_ratio  = max(ir_ratios)
        mean_ratio = statistics.mean(ir_ratios)
        overall = round(min(1.0, (max_ratio - 1.0) / 3.0 * 0.6 + (mean_ratio - 1.0) / 2.0 * 0.4), 3)
        overall = max(0.0, overall)

    return {
        "hot_cells":            hot_cells,
        "adjacency_effects":    adjacency_effects,
        "overall_thermal_risk": overall,
        "thermal_risk_level":   "critical" if overall > 0.7 else "high" if overall > 0.45 else "moderate" if overall > 0.2 else "low",
        "n_hot_cells":          len(hot_cells),
    }


# ── Full pack intelligence report ────────────────────────────────────────────

def full_pack_intelligence(cells: list[dict], topology: str = "series") -> dict:
    """
    Run all pack intelligence analyses and return a single consolidated report.
    """
    cells = _validate(cells)
    health      = pack_health_score(cells, topology)
    failure     = predict_first_failure(cells)
    rul         = pack_rul_estimate(cells, topology)
    cascade     = cascade_risk_score(cells)
    replacement = replacement_analysis(cells, topology)
    timeline    = project_pack_timeline(cells, topology=topology)
    thermal     = propagation_stress_map(cells)

    # Per-cell impact: how much each cell's SOH deviates from mean
    mean_soh = statistics.mean([c["soh"] for c in cells]) if cells else 1.0
    per_cell = []
    for c in cells:
        delta = round((c["soh"] - mean_soh) * 100, 2)
        impact = "bottleneck" if (topology == "series" and c["soh"] == min(c2["soh"] for c2 in cells)) \
                 else ("weak" if delta < -5 else "normal")
        per_cell.append({
            "cell_id":        c["cell_id"],
            "soh_pct":        round(c["soh"] * 100, 1),
            "delta_from_mean": delta,
            "rul":            round(c["rul"], 0),
            "ir":             c["ir"],
            "impact":         impact,
        })
    per_cell.sort(key=lambda x: x["soh_pct"])

    return {
        "topology":      topology,
        "health":        health,
        "first_failure": failure,
        "pack_rul":      rul,
        "cascade":       cascade,
        "replacement":   replacement,
        "timeline":      timeline,
        "thermal":       thermal,
        "per_cell":      per_cell,
        "n_cells":       len(cells),
    }

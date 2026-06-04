"""
core/anomaly_detector.py — Statistical Process Control (SPC) anomaly detection.

Algorithms
----------
  Z-score      : flag cycles where |x - μ_roll| > k·σ_roll
  CUSUM        : cumulative sum — catches small persistent mean shifts
  Jump detect  : single-cycle delta > k·σ (sudden events)
  Fade accel   : rolling slope of SOH accelerating downward

Anomaly types
-------------
  capacity_drop        sudden single-cycle SOH fall
  ir_spike             sudden single-cycle IR jump
  fade_acceleration    capacity degrading faster than baseline rate
  thermal_anomaly      temperature spike / cold-soak
  cusum_soh            CUSUM detects sustained SOH decline
  cusum_ir             CUSUM detects sustained IR rise

Severity
--------
  warning  : 2–3σ deviation or CUSUM 4–8
  critical : >3σ deviation or CUSUM >8
"""
from __future__ import annotations

import math
from typing import Optional
import numpy as np


# ── Tuning constants ──────────────────────────────────────────────────────────
ROLL_WINDOW   = 20      # cycles for rolling mean/std
MIN_CYCLES    = 10      # need at least this many cycles to run SPC
JUMP_K_WARN   = 2.5     # σ multiplier for warning
JUMP_K_CRIT   = 3.5     # σ multiplier for critical
CUSUM_K       = 0.5     # CUSUM allowance (fraction of σ)
CUSUM_H_WARN  = 4.0     # CUSUM warning threshold (in σ units)
CUSUM_H_CRIT  = 8.0     # CUSUM critical threshold
FADE_ACCEL_K  = 2.0     # how many × baseline fade rate = anomaly


# ── Helpers ───────────────────────────────────────────────────────────────────

def _rolling_stats(x: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    """Return rolling mean and std arrays (same length as x)."""
    n   = len(x)
    mu  = np.full(n, np.nan)
    sig = np.full(n, np.nan)
    for i in range(n):
        lo       = max(0, i - window + 1)
        seg      = x[lo : i + 1]
        mu[i]    = seg.mean()
        sig[i]   = seg.std(ddof=0) if len(seg) > 1 else 0.0
    return mu, sig


def _cusum(x: np.ndarray, k_frac: float = CUSUM_K) -> tuple[np.ndarray, np.ndarray]:
    """
    Two-sided CUSUM in units of local σ.
    Returns (cusum_up, cusum_dn) — both non-negative.
    cusum_up detects upward shifts, cusum_dn detects downward shifts.
    """
    mu  = np.nanmean(x)
    sig = np.nanstd(x, ddof=0) or 1e-9
    k   = k_frac * sig
    n   = len(x)
    sup = np.zeros(n)
    sdn = np.zeros(n)
    for i in range(1, n):
        sup[i] = max(0.0, sup[i - 1] + (x[i] - mu) - k)
        sdn[i] = max(0.0, sdn[i - 1] + (mu - x[i]) - k)
    return sup / (sig or 1e-9), sdn / (sig or 1e-9)


def _control_limits(mu: np.ndarray, sig: np.ndarray, k: float = 3.0):
    ucl = mu + k * sig
    lcl = mu - k * sig
    return ucl, lcl


# ── Main detector ─────────────────────────────────────────────────────────────

def detect_cell_anomalies(
    cell_id:     str,
    cycles:      list[int],
    soh:         list[float],           # 0–1 fraction
    ir:          Optional[list[float]] = None,    # Ω
    temperature: Optional[list[float]] = None,    # °C
) -> dict:
    """
    Run full SPC suite on one cell's time-series.

    Returns a dict with:
      cell_id, n_anomalies, severity, events,
      control_chart (for plotting)
    """
    n = len(cycles)
    if n < MIN_CYCLES:
        return _empty_result(cell_id, reason=f"Too few cycles ({n} < {MIN_CYCLES})")

    cyc  = np.array(cycles,  dtype=float)
    soh_ = np.array(soh,     dtype=float)
    ir_  = np.array(ir,      dtype=float) if ir else None
    tmp_ = np.array(temperature, dtype=float) if temperature else None

    events: list[dict] = []

    # ── SOH rolling stats ─────────────────────────────────────────────────────
    soh_mu, soh_sig = _rolling_stats(soh_, ROLL_WINDOW)
    soh_ucl, soh_lcl = _control_limits(soh_mu, soh_sig, k=3.0)

    # Z-score: sudden SOH drop
    for i in range(ROLL_WINDOW, n):
        sig_i = soh_sig[i] or 1e-6
        z = (soh_[i] - soh_mu[i]) / sig_i
        if z < -JUMP_K_CRIT:
            events.append(_event("capacity_drop", cycles[i], soh_[i],
                                 soh_mu[i], abs(z), "critical",
                                 f"SOH dropped {abs(z):.1f}σ below rolling mean"))
        elif z < -JUMP_K_WARN:
            events.append(_event("capacity_drop", cycles[i], soh_[i],
                                 soh_mu[i], abs(z), "warning",
                                 f"SOH dipped {abs(z):.1f}σ below rolling mean"))

    # CUSUM on SOH (detect sustained decline)
    _, soh_cusum_dn = _cusum(soh_)
    for i in range(ROLL_WINDOW, n):
        if soh_cusum_dn[i] > CUSUM_H_CRIT:
            if not _already_flagged(events, "cusum_soh", cycles[i], window=10):
                events.append(_event("cusum_soh", cycles[i], soh_[i],
                                     float(np.nanmean(soh_[:i])),
                                     soh_cusum_dn[i], "critical",
                                     f"CUSUM detects sustained SOH decline "
                                     f"(score {soh_cusum_dn[i]:.1f}σ)"))
        elif soh_cusum_dn[i] > CUSUM_H_WARN:
            if not _already_flagged(events, "cusum_soh", cycles[i], window=10):
                events.append(_event("cusum_soh", cycles[i], soh_[i],
                                     float(np.nanmean(soh_[:i])),
                                     soh_cusum_dn[i], "warning",
                                     f"CUSUM detects early sustained SOH decline "
                                     f"(score {soh_cusum_dn[i]:.1f}σ)"))

    # Fade acceleration: compare rolling slope in second half vs first half
    if n >= 40:
        mid      = n // 2
        slope_lo = _linear_slope(cyc[:mid], soh_[:mid])
        slope_hi = _linear_slope(cyc[mid:], soh_[mid:])
        if slope_lo < -1e-6 and slope_hi < slope_lo * FADE_ACCEL_K:
            accel = abs(slope_hi / slope_lo)
            sev   = "critical" if accel > 3 else "warning"
            events.append(_event("fade_acceleration", cycles[mid], soh_[mid],
                                 soh_[0], accel, sev,
                                 f"Fade rate {accel:.1f}× faster in second half of life"))

    # ── IR stats ──────────────────────────────────────────────────────────────
    ir_mu = ir_ucl = ir_lcl = ir_cusum_up = np.full(n, float("nan"))
    if ir_ is not None and np.any(ir_ > 0):
        valid = ir_[ir_ > 0]
        if len(valid) >= MIN_CYCLES:
            ir_mu_, ir_sig_ = _rolling_stats(ir_, ROLL_WINDOW)
            ir_ucl_, ir_lcl_ = _control_limits(ir_mu_, ir_sig_, k=3.0)
            ir_mu, ir_ucl, ir_lcl = ir_mu_, ir_ucl_, ir_lcl_

            for i in range(ROLL_WINDOW, n):
                if ir_[i] <= 0:
                    continue
                sig_i = ir_sig_[i] or 1e-9
                z = (ir_[i] - ir_mu_[i]) / sig_i
                if z > JUMP_K_CRIT:
                    events.append(_event("ir_spike", cycles[i], ir_[i],
                                         ir_mu_[i], z, "critical",
                                         f"IR spiked {z:.1f}σ above rolling mean "
                                         f"(possible lithium plating or separator damage)"))
                elif z > JUMP_K_WARN:
                    events.append(_event("ir_spike", cycles[i], ir_[i],
                                         ir_mu_[i], z, "warning",
                                         f"IR elevated {z:.1f}σ above rolling mean"))

            ir_cusum_up_, _ = _cusum(ir_)
            ir_cusum_up = ir_cusum_up_
            for i in range(ROLL_WINDOW, n):
                if ir_cusum_up[i] > CUSUM_H_CRIT:
                    if not _already_flagged(events, "cusum_ir", cycles[i], window=10):
                        events.append(_event("cusum_ir", cycles[i], ir_[i],
                                             float(np.nanmean(ir_[:i])),
                                             ir_cusum_up[i], "critical",
                                             f"CUSUM: sustained IR rise detected "
                                             f"(score {ir_cusum_up[i]:.1f}σ)"))
                elif ir_cusum_up[i] > CUSUM_H_WARN:
                    if not _already_flagged(events, "cusum_ir", cycles[i], window=10):
                        events.append(_event("cusum_ir", cycles[i], ir_[i],
                                             float(np.nanmean(ir_[:i])),
                                             ir_cusum_up[i], "warning",
                                             f"CUSUM: early IR rise trend detected"))

    # ── Temperature ───────────────────────────────────────────────────────────
    if tmp_ is not None and np.any(~np.isnan(tmp_)):
        tmp_mu_, tmp_sig_ = _rolling_stats(tmp_, ROLL_WINDOW)
        for i in range(ROLL_WINDOW, n):
            sig_i = tmp_sig_[i] or 1e-6
            z = abs(tmp_[i] - tmp_mu_[i]) / sig_i
            if z > JUMP_K_CRIT:
                events.append(_event("thermal_anomaly", cycles[i], tmp_[i],
                                     tmp_mu_[i], z, "critical",
                                     f"Temperature {z:.1f}σ outside expected range "
                                     f"({tmp_[i]:.1f}°C vs {tmp_mu_[i]:.1f}°C mean)"))

    # ── Deduplicate & sort ────────────────────────────────────────────────────
    events = _deduplicate(events)
    events.sort(key=lambda e: e["cycle"])

    n_critical = sum(1 for e in events if e["severity"] == "critical")
    n_warning  = sum(1 for e in events if e["severity"] == "warning")
    severity   = "critical" if n_critical > 0 else "warning" if n_warning > 0 else "normal"

    return {
        "cell_id":      cell_id,
        "n_cycles":     n,
        "n_anomalies":  len(events),
        "n_critical":   n_critical,
        "n_warning":    n_warning,
        "severity":     severity,
        "events":       events,
        "control_chart": {
            "cycles":    [int(c) for c in cycles],
            "soh":       _f2(soh_),
            "soh_ucl":   _f2(soh_ucl),
            "soh_lcl":   _f2(soh_lcl),
            "soh_mu":    _f2(soh_mu),
            "ir":        _f4(ir_) if ir_ is not None else [],
            "ir_ucl":    _f4(ir_ucl),
            "ir_lcl":    _f4(ir_lcl),
            "ir_mu":     _f4(ir_mu),
            "cusum_soh_dn": [round(float(v), 3) if not math.isnan(float(v)) else None for v in soh_cusum_dn],
            "cusum_ir_up":  [round(float(v), 3) if not math.isnan(float(v)) else None for v in ir_cusum_up],
        },
    }


# ── Fleet scan ────────────────────────────────────────────────────────────────

def scan_fleet() -> dict:
    """
    Run anomaly detection on all cells in the loaded dataset.
    Returns per-cell summaries + fleet-level stats.
    """
    from core.data_loader import get_meta_df, is_loaded, load_dataset
    import core.data_loader as dl

    if not is_loaded():
        load_dataset()

    meta = dl._meta_df
    feat = dl._features

    if meta is None or feat is None:
        return {"error": "Dataset not loaded"}

    results   = []
    cell_ids  = meta["cell_id"].unique()

    for cell_id in cell_ids:
        mask = meta["cell_id"].values == cell_id
        idx  = np.where(mask)[0]
        grp  = meta.iloc[idx].sort_values("cycle")
        row_idx = grp.index.values

        cycles = grp["cycle"].tolist()
        soh    = feat[row_idx, 9].tolist()      # cap_pct
        ir     = feat[row_idx, 7].tolist()      # Internal Resistance
        temp   = feat[row_idx, 5].tolist()      # Temperature

        res = detect_cell_anomalies(
            cell_id=str(cell_id),
            cycles=cycles,
            soh=soh,
            ir=ir,
            temperature=temp,
        )
        # Strip control_chart from fleet summary to keep payload small
        summary = {k: v for k, v in res.items() if k != "control_chart"}
        summary["chemistry"] = str(grp["chemistry_name"].iloc[0])
        summary["dataset"]   = str(grp["dataset"].iloc[0])
        summary["soh_last"]  = round(float(soh[-1]) * 100, 1) if soh else 0
        results.append(summary)

    n_critical = sum(1 for r in results if r["severity"] == "critical")
    n_warning  = sum(1 for r in results if r["severity"] == "warning")
    n_normal   = sum(1 for r in results if r["severity"] == "normal")

    results.sort(key=lambda r: (
        {"critical": 0, "warning": 1, "normal": 2}.get(r["severity"], 3),
        -r["n_anomalies"]
    ))

    return {
        "n_cells":    len(results),
        "n_critical": n_critical,
        "n_warning":  n_warning,
        "n_normal":   n_normal,
        "cells":      results,
    }


# ── Internal helpers ──────────────────────────────────────────────────────────

def _event(type_: str, cycle: int, value: float, expected: float,
           deviation: float, severity: str, description: str) -> dict:
    return {
        "type":          type_,
        "cycle":         int(cycle),
        "value":         round(float(value), 5),
        "expected":      round(float(expected), 5),
        "deviation_sigma": round(float(deviation), 2),
        "severity":      severity,
        "description":   description,
    }


def _empty_result(cell_id: str, reason: str = "") -> dict:
    return {
        "cell_id":     cell_id,
        "n_cycles":    0,
        "n_anomalies": 0,
        "n_critical":  0,
        "n_warning":   0,
        "severity":    "normal",
        "events":      [],
        "reason":      reason,
        "control_chart": {},
    }


def _already_flagged(events: list[dict], type_: str, cycle: int,
                     window: int = 10) -> bool:
    return any(e["type"] == type_ and abs(e["cycle"] - cycle) < window
               for e in events)


def _deduplicate(events: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    out  = []
    for e in events:
        key = (e["type"], e["cycle"] // 5)   # bucket into 5-cycle bins
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def _linear_slope(x: np.ndarray, y: np.ndarray) -> float:
    if len(x) < 2:
        return 0.0
    try:
        return float(np.polyfit(x, y, 1)[0])
    except Exception:
        return 0.0


def _f2(arr) -> list:
    if arr is None:
        return []
    return [round(float(v), 4) if not math.isnan(float(v)) else None for v in arr]


def _f4(arr) -> list:
    if arr is None:
        return []
    return [round(float(v), 6) if not math.isnan(float(v)) else None for v in arr]

"""
routers/thermal_twin.py — Live cell Thermal Twin: core-temperature virtual sensing
+ full 2D cross-section thermal field for real-time 3D / heatmap visualization.

GET  /api/thermal-twin/geometry            static mesh + χ basis (cache once on the client)
GET  /api/thermal-twin/thresholds          protective thermal thresholds
GET  /api/thermal-twin/cell/{id}/state     live core/surface temp from latest telemetry
POST /api/thermal-twin/simulate            synthetic 'live' trajectory (no-hardware demo)

The client reconstructs the field as  T = core·χ_core + surface·(1-χ_core)  from the
{core, surface} pair streamed each tick — tiny payload, smooth real-time.
"""
from __future__ import annotations

import logging
from typing import Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()

# protective operational thermal thresholds (°C) — NOT runaway; cells should derate well below
ONSET_C = 45.0     # begin protective C-rate derating
HARD_C = 55.0      # must-not-exceed operational limit
CRIT_C = 60.0      # critical
GATE_SIGMA = 2.0   # act on estimate + 2σ
MIN_DERATE = 0.3


def _status_and_derate(core: float, sigma: float) -> tuple[str, float]:
    risk = core + GATE_SIGMA * sigma
    if risk <= ONSET_C:
        derate = 1.0
    else:
        frac = (risk - ONSET_C) / (HARD_C - ONSET_C)
        derate = float(np.clip(1.0 - (1.0 - MIN_DERATE) * frac, MIN_DERATE, 1.0))
    if core > CRIT_C:
        status = "CRITICAL"
    elif risk > ONSET_C and core <= HARD_C:
        status = "WARNING" if derate >= 0.99 else "DERATING"
    elif derate < 0.99:
        status = "DERATING"
    else:
        status = "NOMINAL"
    return status, round(derate, 3)


def _estimate_cores(rows):
    """Core temperature per telemetry row: learned DeepONet if available, else physics.
    Returns (core_array, sigma_array, estimator_name)."""
    cur = np.array([float(r["current"]) if r["current"] is not None else 0.0 for r in rows])
    soc = np.array([(float(r["soc"]) / 100.0) if r["soc"] is not None else 0.5 for r in rows])
    surf = np.array([float(r["temperature"]) for r in rows])
    try:
        from core.thermal_estimator import load_estimator
        est = load_estimator()
        if est is not None:
            import pandas as pd
            df = pd.DataFrame({"I": cur, "soc": soc, "surface_T": surf,
                               "ambient_T": np.full(len(rows), 25.0)})
            core, sigma = est.core_from_frame(df)
            return np.asarray(core), np.asarray(sigma), "deeponet"
    except Exception as exc:
        logger.warning("learned thermal estimator failed; physics fallback: %s", exc)
    from core.thermal_field import ThermalParams, estimate_core_temp
    p = ThermalParams()
    core = np.empty(len(rows)); sigma = np.empty(len(rows))
    for i in range(len(rows)):
        core[i], sigma[i] = estimate_core_temp(float(surf[i]), float(cur[i]), float(soc[i]), p)
    return core, sigma, "physics"


@router.get("/thermal-twin/geometry", summary="Cell cross-section mesh + χ basis (cache once)")
def geometry(geometry: str = "cylindrical", n: int = 36):
    from core.thermal_field import build_field_basis
    if geometry not in ("cylindrical", "pouch"):
        raise HTTPException(422, "geometry must be 'cylindrical' or 'pouch'")
    out = build_field_basis(geometry, n=max(12, min(n, 60)))
    out["thresholds"] = {"onset": ONSET_C, "hard": HARD_C, "critical": CRIT_C}
    out["clim"] = [20.0, CRIT_C + 5.0]
    return out


@router.get("/thermal-twin/thresholds", summary="Protective thermal thresholds")
def thresholds():
    return {"onset_c": ONSET_C, "hard_c": HARD_C, "critical_c": CRIT_C,
            "gate_sigma": GATE_SIGMA, "min_derate": MIN_DERATE}


@router.get("/thermal-twin/cell/{cell_id}/state", summary="Live core/surface temp from telemetry")
def cell_state(cell_id: str):
    """Estimate the unmeasurable core temperature from recent measured telemetry
    (a short window gives the learned model its thermal-memory context)."""
    from core.db import _conn
    try:
        with _conn() as con:
            rows = con.execute(
                "SELECT voltage,current,temperature,soc,ts FROM cell_timeseries "
                "WHERE cell_id=? ORDER BY ts DESC LIMIT 60", (cell_id,)
            ).fetchall()
    except Exception as exc:
        logger.debug("thermal-twin state db error: %s", exc)
        rows = []
    rows = [r for r in reversed(rows) if r["temperature"] is not None]
    if not rows:
        return {"cell_id": cell_id, "has_data": False,
                "message": "no telemetry; use POST /thermal-twin/simulate for a synthetic feed"}

    core_arr, sigma_arr, est_name = _estimate_cores(rows)
    r = rows[-1]                                          # latest sample
    surf = float(r["temperature"])
    cur = float(r["current"]) if r["current"] is not None else 0.0
    soc = (float(r["soc"]) / 100.0) if r["soc"] is not None else 0.5
    core, sigma = float(core_arr[-1]), float(sigma_arr[-1])
    status, derate = _status_and_derate(core, sigma)
    return {"cell_id": cell_id, "has_data": True, "estimator": est_name,
            "surface": round(surf, 2), "core": round(core, 2), "core_sigma": round(sigma, 2),
            "current": round(cur, 2), "soc": round(soc, 3),
            "delta_core_surface": round(core - surf, 2),
            "status": status, "derate": derate}


@router.get("/thermal-twin/cells", summary="Cells that have telemetry in cell_timeseries")
def list_cells(limit: int = 200):
    from core.db import _conn
    try:
        with _conn() as con:
            rows = con.execute(
                "SELECT cell_id, COUNT(*) AS n, MAX(ts) AS latest "
                "FROM cell_timeseries GROUP BY cell_id ORDER BY n DESC LIMIT ?", (limit,)
            ).fetchall()
        return {"cells": [{"cell_id": r["cell_id"], "n_points": r["n"], "latest_ts": r["latest"]}
                          for r in rows]}
    except Exception as exc:
        logger.debug("thermal-twin cells: %s", exc)
        return {"cells": []}


@router.get("/thermal-twin/cell/{cell_id}/history", summary="Live core/surface trajectory from telemetry")
def cell_history(cell_id: str, limit: int = 400):
    """Pull the recent telemetry window from cell_timeseries and estimate the core
    temperature for each sample — the live trajectory the dashboard plays/streams."""
    from core.db import _conn
    try:
        with _conn() as con:
            rows = con.execute(
                "SELECT voltage,current,temperature,soc,ts FROM cell_timeseries "
                "WHERE cell_id=? ORDER BY ts DESC LIMIT ?", (cell_id, max(1, min(limit, 5000)))
            ).fetchall()
    except Exception as exc:
        logger.debug("thermal-twin history db: %s", exc)
        rows = []
    rows = [r for r in reversed(rows) if r["temperature"] is not None]   # chronological
    if not rows:
        return {"cell_id": cell_id, "has_data": False, "n": 0, "frames": []}

    core_arr, sigma_arr, est_name = _estimate_cores(rows)
    frames = []
    for i, r in enumerate(rows):
        surf = float(r["temperature"])
        cur = float(r["current"]) if r["current"] is not None else 0.0
        soc = (float(r["soc"]) / 100.0) if r["soc"] is not None else 0.5
        core, sigma = float(core_arr[i]), float(sigma_arr[i])
        status, derate = _status_and_derate(core, sigma)
        frames.append({"t": i, "ts": r["ts"], "core": round(core, 2), "surface": round(surf, 2),
                       "core_sigma": round(sigma, 2), "current": round(cur, 2),
                       "soc": round(soc, 3), "cooling": 1.0, "status": status, "derate": derate})
    return {"cell_id": cell_id, "has_data": True, "n": len(frames), "estimator": est_name,
            "fault_step": None, "clim": [20.0, CRIT_C + 5.0],
            "thresholds": {"onset": ONSET_C, "hard": HARD_C, "critical": CRIT_C}, "frames": frames}


class SimRequest(BaseModel):
    geometry:      str   = Field("cylindrical", pattern="^(cylindrical|pouch)$")
    n_steps:       int   = Field(600, ge=10, le=5000)
    dt_s:          float = Field(1.0, gt=0)
    capacity_ah:   float = Field(5.0, gt=0)
    ambient_c:     float = 25.0
    base_c_rate:   float = Field(1.3, description="baseline discharge C-rate")
    peak_c_rate:   float = Field(3.5, description="pulse C-rate")
    cooling_fault: bool  = Field(True, description="inject a cooling degradation partway")
    fault_frac:    float = Field(0.4, ge=0.05, le=0.95)


@router.post("/thermal-twin/simulate", summary="Synthetic live thermal trajectory (no hardware)")
def simulate(req: SimRequest):
    """Generate a synthetic discharge (with optional cooling fault) and return the
    core/surface trajectory — the 'live' feed the dashboard replays when no hardware
    is connected. Uses the fast 2-state thermal model."""
    from core.thermal_field import ThermalParams, simulate as sim

    n = req.n_steps
    p = ThermalParams(cell_capacity_ah=req.capacity_ah)
    rng = np.random.default_rng(0)

    # current profile: baseline discharge with periodic high-C pulses
    t = np.arange(n)
    c_rate = req.base_c_rate + (req.peak_c_rate - req.base_c_rate) * (
        0.5 * (1 + np.sin(2 * np.pi * t / 90)) ** 3) * (np.sin(2 * np.pi * t / 240) > -0.2)
    c_rate = np.clip(c_rate + rng.normal(0, 0.05, n), 0, req.peak_c_rate)
    current = c_rate * req.capacity_ah
    # SOC integrates down (Ah counting), clipped
    used_ah = np.cumsum(current * req.dt_s / 3600.0)
    soc = np.clip(1.0 - used_ah / req.capacity_ah, 0.05, 1.0)

    cooling = np.ones(n)
    fault_t = int(req.fault_frac * n)
    if req.cooling_fault:
        ramp = np.clip((t - fault_t) / (0.1 * n), 0, 1)
        cooling = 1.0 - ramp * 0.7                       # cooling capacity → 30%

    traj = sim(current, soc, req.ambient_c, p, dt_s=req.dt_s,
               cooling_factor=cooling, init_c=req.ambient_c)

    frames = []
    for i in range(n):
        core, sig = traj["core"][i], traj["core_sigma"][i]
        status, derate = _status_and_derate(core, sig)
        frames.append({"t": i, "core": core, "surface": traj["surface"][i],
                       "core_sigma": sig, "current": round(float(current[i]), 2),
                       "soc": round(float(soc[i]), 3), "cooling": round(float(cooling[i]), 3),
                       "status": status, "derate": derate})
    return {"geometry": req.geometry, "dt_s": req.dt_s, "ambient_c": req.ambient_c,
            "fault_step": fault_t if req.cooling_fault else None,
            "thresholds": {"onset": ONSET_C, "hard": HARD_C, "critical": CRIT_C},
            "n": n, "frames": frames}


class PackSimRequest(BaseModel):
    rows:          int   = Field(6, ge=1, le=24)
    cols:          int   = Field(8, ge=1, le=24)
    n_steps:       int   = Field(600, ge=10, le=5000)
    dt_s:          float = Field(1.0, gt=0)
    capacity_ah:   float = Field(5.0, gt=0)
    ambient_c:     float = 25.0
    base_c_rate:   float = 1.3
    peak_c_rate:   float = 3.5
    cooling_fault: bool  = True
    fault_frac:    float = Field(0.4, ge=0.05, le=0.95)
    weak_cell:     bool  = True


@router.post("/thermal-twin/pack/simulate", summary="Synthetic pack thermal map (per-cell live)")
def pack_simulate(req: PackSimRequest):
    """Per-cell core-temperature trajectories across a module grid — the pack thermal
    map. Models center-vs-edge cooling, a weak (hot) cell, and a localized cooling fault."""
    from core.thermal_field import ThermalParams, simulate_pack
    import numpy as np

    p = ThermalParams(cell_capacity_ah=req.capacity_ah)
    res = simulate_pack(req.rows, req.cols, req.ambient_c, p,
                        n_steps=req.n_steps, dt_s=req.dt_s, capacity_ah=req.capacity_ah,
                        base_c_rate=req.base_c_rate, peak_c_rate=req.peak_c_rate,
                        cooling_fault=req.cooling_fault, fault_frac=req.fault_frac,
                        weak_cell=req.weak_cell)
    cores = res["cores"]                                  # (n_steps, n_cells)
    keep = np.linspace(0, req.n_steps - 1, min(250, req.n_steps)).astype(int)
    frames = []
    for s in keep:
        row = cores[s]
        mx = float(row.max()); hot = int(row.argmax())
        sigma = max(0.5, 0.25 * (mx - res["surfs"][s][hot]))
        status, derate = _status_and_derate(mx, sigma)
        frames.append({"t": int(s), "cells": np.round(row, 2).tolist(),
                       "max_core": round(mx, 2), "hottest": hot,
                       "status": status, "derate": derate})
    return {"rows": res["rows"], "cols": res["cols"], "n_cells": res["n_cells"],
            "weak_idx": res["weak_idx"], "fault_step": res["fault_step"],
            "fault_region": res["fault_region"],
            "thresholds": {"onset": ONSET_C, "hard": HARD_C, "critical": CRIT_C},
            "clim": [req.ambient_c, CRIT_C + 5.0], "n_frames": len(frames), "frames": frames}

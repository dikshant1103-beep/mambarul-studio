"""
Backend router: per-cell time-series of all 42 computed features.
Serves real data from the processed numpy arrays + computes derived features on-the-fly.
"""
from fastapi import APIRouter, HTTPException
from typing import Any
import numpy as np
import pandas as pd
from scipy.signal import savgol_filter
from core.data_loader import get_meta_df, get_features_array, get_rul_array, is_loaded

router = APIRouter()

# ────────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────────

def _sg(arr: np.ndarray, window: int = 11, poly: int = 3) -> np.ndarray:
    n = len(arr)
    w = window
    while w >= n and w > 4:
        w -= 2
    if w < 5 or w >= n:
        return arr.copy()
    w = w if w % 2 == 1 else w - 1
    p = min(poly, w - 1)
    try:
        return savgol_filter(arr, window_length=w, polyorder=p)
    except Exception:
        return arr.copy()


def _rolling(arr: np.ndarray, w: int, fn: str) -> np.ndarray:
    s = pd.Series(arr.astype(float))
    r = s.rolling(w, min_periods=1)
    if fn == "mean":   return r.mean().values.astype(np.float32)
    if fn == "std":    return r.std().fillna(0).values.astype(np.float32)
    if fn == "min":    return r.min().values.astype(np.float32)
    if fn == "max":    return r.max().values.astype(np.float32)
    return r.mean().values.astype(np.float32)


def _slope(arr: np.ndarray, w: int = 5) -> np.ndarray:
    out = np.zeros(len(arr), dtype=np.float32)
    for i in range(len(arr)):
        seg = arr[max(0, i - w + 1): i + 1].astype(np.float64)
        if len(seg) >= 3:
            xi = np.arange(len(seg), dtype=np.float64)
            out[i] = float(np.polyfit(xi, seg, 1)[0])
    return out


def _curvature(arr: np.ndarray, w: int = 7) -> np.ndarray:
    if len(arr) < w + 2:
        return np.zeros(len(arr), dtype=np.float32)
    try:
        sm = _sg(arr, w, 2)
        d2 = np.gradient(np.gradient(sm))
        return d2.astype(np.float32)
    except Exception:
        return np.zeros(len(arr), dtype=np.float32)


def _ica_dva(v_raw: np.ndarray, q_raw: np.ndarray) -> dict[str, np.ndarray]:
    """Compute ICA (dQ/dV) and DVA (dV/dQ) curves for one discharge cycle."""
    if len(v_raw) < 15:
        return {}
    idx = np.argsort(v_raw)
    v_s, q_s = v_raw[idx], q_raw[idx]
    _, uniq = np.unique(v_s, return_index=True)
    v_s, q_s = v_s[uniq], q_s[uniq]
    if len(v_s) < 10:
        return {}
    q_sm = _sg(q_s)
    dqdv = np.gradient(q_sm, v_s)
    dqdv_sm = _sg(np.abs(dqdv))
    dvdq = np.where(np.abs(dqdv) > 1e-6, 1.0 / dqdv, 0.0)
    dvdq_sm = _sg(np.abs(dvdq))
    return {"voltage": v_s.tolist(), "dqdv": dqdv_sm.tolist(),
            "dvdq": dvdq_sm.tolist(), "capacity": q_s.tolist()}


def compute_42_features(cell_feat: np.ndarray) -> dict[str, list]:
    """
    Compute all 42 features for a single cell.
    cell_feat: (N, 9) raw features
    Returns dict of feature_name → list of N floats.
    """
    N = len(cell_feat)
    cap    = cell_feat[:, 0].copy()
    cct    = cell_feat[:, 1].copy()   # CC charge time
    vmean  = cell_feat[:, 2].copy()
    vend   = cell_feat[:, 3].copy()
    energy = cell_feat[:, 4].copy()
    temp   = cell_feat[:, 5].copy()
    dslope = cell_feat[:, 6].copy()
    ir     = cell_feat[:, 7].copy()

    # Smooth capacity before derived features
    cap_sm = _sg(cap)

    # SOH
    init = float(np.mean(cap_sm[:min(5, N)])) or 1.0
    soh = (cap_sm / init).astype(np.float32)

    # Delta cap
    delta_cap = np.zeros(N, np.float32)
    delta_cap[1:] = cap_sm[1:] - cap_sm[:-1]

    # Cum energy (leaky — shown for education)
    cum_energy = np.cumsum(energy).astype(np.float32)
    cum_energy_norm = (cum_energy / (cum_energy[-1] + 1e-6)).astype(np.float32)

    # Cycle index
    cycle_idx = np.arange(N, dtype=np.float32)
    cycle_norm = cycle_idx / max(N - 1, 1)

    # C-rate proxy
    cct_h = np.where(cct > 0, cct / 3600.0, np.nan)
    c_rate = np.where(cct_h > 0, cap / cct_h, 0.0).astype(np.float32)

    # Voltage range
    v_range = (vmean - vend).astype(np.float32)

    # Energy efficiency
    denom = cap * vmean
    e_eff = np.where(denom > 1e-6, energy / denom, 0.0).astype(np.float32)

    # Cum capacity Ah
    cum_cap = np.cumsum(cap).astype(np.float32)

    # SOH slope + curvature
    soh_slope = _slope(soh, 5)
    soh_curv  = _curvature(soh, 7)

    # IR slope
    ir_slope  = _slope(ir, 5) if ir.any() else np.zeros(N, np.float32)

    # CCT slope
    cct_slope = _slope(cct, 5) if cct.any() else np.zeros(N, np.float32)

    # Rolling 5-cycle stats
    cap_mean5  = _rolling(cap, 5, "mean")
    cap_std5   = _rolling(cap, 5, "std")
    cap_min5   = _rolling(cap, 5, "min")
    cap_max5   = _rolling(cap, 5, "max")
    cap_range5 = cap_max5 - cap_min5

    vm_std5   = _rolling(vmean, 5, "std")
    vm_slope5 = _slope(vmean, 5)
    ve_std5   = _rolling(vend,  5, "std")
    ve_slope5 = _slope(vend,  5)

    en_mean5  = _rolling(energy, 5, "mean")
    en_std5   = _rolling(energy, 5, "std")
    en_slope5 = _slope(energy, 5)

    temp_mean5 = _rolling(temp, 5, "mean")
    temp_max5  = _rolling(temp, 5, "max")
    temp_std5  = _rolling(temp, 5, "std")

    ir_mean5 = _rolling(ir, 5, "mean")

    def _clean(arr):
        a = np.asarray(arr, dtype=np.float32)
        a = np.where(np.isfinite(a), a, 0.0)
        return a.tolist()

    return {
        # ── 8 Raw features ─────────────────────────────────────────────────
        "capacity_Ah":         _clean(cap),
        "cc_charge_time_s":    _clean(cct),
        "voltage_mean_V":      _clean(vmean),
        "voltage_end_V":       _clean(vend),
        "energy_Wh":           _clean(energy),
        "temperature_C":       _clean(temp),
        "discharge_slope":     _clean(dslope),
        "ir_proxy_Ohm":        _clean(ir),
        # ── 4 Core derived ─────────────────────────────────────────────────
        "soh_cap_pct":         _clean(soh),
        "delta_cap":           _clean(delta_cap),
        "cum_energy_norm":     _clean(cum_energy_norm),
        "cap_roll_std_5":      _clean(cap_std5),
        # ── Rolling stats (cap) ────────────────────────────────────────────
        "cap_mean_5":          _clean(cap_mean5),
        "cap_min_5":           _clean(cap_min5),
        "cap_max_5":           _clean(cap_max5),
        "cap_range_5":         _clean(cap_range5),
        # ── Rolling stats (voltage) ────────────────────────────────────────
        "vm_std_5":            _clean(vm_std5),
        "vm_slope_5":          _clean(vm_slope5),
        "ve_std_5":            _clean(ve_std5),
        "ve_slope_5":          _clean(ve_slope5),
        # ── Rolling stats (energy) ─────────────────────────────────────────
        "energy_mean_5":       _clean(en_mean5),
        "energy_std_5":        _clean(en_std5),
        "energy_slope_5":      _clean(en_slope5),
        # ── Rolling stats (temp/IR) ────────────────────────────────────────
        "temp_mean_5":         _clean(temp_mean5),
        "temp_max_5":          _clean(temp_max5),
        "temp_std_5":          _clean(temp_std5),
        "ir_mean_5":           _clean(ir_mean5),
        # ── Physics-based ──────────────────────────────────────────────────
        "soh_slope_5":         _clean(soh_slope),
        "soh_curvature":       _clean(soh_curv),
        "c_rate_charge":       _clean(c_rate),
        "voltage_range":       _clean(v_range),
        "ir_slope_5":          _clean(ir_slope),
        "charge_time_slope_5": _clean(cct_slope),
        "energy_efficiency":   _clean(e_eff),
        "cum_capacity_Ah":     _clean(cum_cap),
        "cycle_norm":          _clean(cycle_norm),
        # ── ICA/DVA scalars per cycle (approx from vmean gradient) ─────────
        "dqdv_proxy":          _clean(np.gradient(_sg(cap), np.arange(N, dtype=float) + 1).astype(np.float32)),
        "dvdq_proxy":          _clean(np.gradient(vmean, cap + 1e-6).astype(np.float32)),
        "ce_efficiency":       _clean(np.where(en_mean5 > 0, energy / en_mean5, 1.0).astype(np.float32)),
        "fade_rate_5":         _clean(_slope(soh, 10)),
        "capacity_retention":  _clean(soh),          # alias for clarity
        "cum_energy_raw_Wh":   _clean(cum_energy),
        "cycle_index":         _clean(cycle_idx),
    }


# ────────────────────────────────────────────────────────────────────────────
# Endpoints
# ────────────────────────────────────────────────────────────────────────────

@router.get("/cells/{cell_id}/features42")
def cell_42_features(cell_id: str) -> dict[str, Any]:
    """Return all 42 computed features as time-series for one cell."""
    if not is_loaded():
        raise HTTPException(503, "Dataset not loaded")
    meta = get_meta_df()
    feats = get_features_array()
    rul_arr = get_rul_array()

    mask = meta["cell_id"] == cell_id
    if not mask.any():
        raise HTTPException(404, f"Cell '{cell_id}' not found")

    cell_feat = feats[mask]
    cell_rul  = rul_arr[mask]
    cell_meta = meta[mask].iloc[0]

    cycles = meta[mask]["cycle"].values.tolist()
    features = compute_42_features(cell_feat)

    return {
        "cell_id": cell_id,
        "chemistry": str(cell_meta.get("chemistry_name", "Unknown")),
        "dataset": str(cell_meta.get("dataset", "Unknown")),
        "n_cycles": int(mask.sum()),
        "cycles": cycles,
        "rul": cell_rul.tolist(),
        "features": features,
    }


@router.get("/cells/{cell_id}/ica-dva")
def cell_ica_dva(cell_id: str, cycle: int = -1) -> dict[str, Any]:
    """
    Return synthetic ICA/DVA curves derived from capacity gradient.
    For real ICA you need raw voltage-capacity traces; here we approximate
    using the capacity vs. cycle relationship.
    cycle=-1 → all cycles aggregated into a smooth representative curve.
    """
    if not is_loaded():
        raise HTTPException(503, "Dataset not loaded")
    meta = get_meta_df()
    feats = get_features_array()

    mask = meta["cell_id"] == cell_id
    if not mask.any():
        raise HTTPException(404, f"Cell '{cell_id}' not found")

    cell_feat = feats[mask]
    cap = _sg(cell_feat[:, 0])
    vmean = cell_feat[:, 2]
    N = len(cap)

    # Build synthetic ICA: treat cycle# as surrogate for capacity axis
    # dQ/dV ≈ -dQ/d(cycle) / (dV/d(cycle))
    dcap = np.gradient(cap)
    dv   = np.gradient(_sg(vmean))
    with np.errstate(divide="ignore", invalid="ignore"):
        dqdv = np.where(np.abs(dv) > 1e-4, dcap / dv, 0.0)
    dqdv = _sg(np.abs(dqdv))

    # DVA: dV/dQ
    with np.errstate(divide="ignore", invalid="ignore"):
        dvdq = np.where(np.abs(dcap) > 1e-4, dv / dcap, 0.0)
    dvdq = _sg(np.abs(dvdq))

    # Synthetic voltage axis (approx discharge curve)
    v_axis = np.linspace(float(vmean.min()), float(vmean.max()), N)

    return {
        "cell_id": cell_id,
        "n_cycles": N,
        "voltage_axis": v_axis.tolist(),
        "capacity_axis": cap.tolist(),
        "dqdv": dqdv.tolist(),
        "dvdq": dvdq.tolist(),
        "cycles": list(range(N)),
    }


@router.get("/cells")
def list_all_cells() -> list[dict]:
    """Return list of all cells with basic metadata."""
    if not is_loaded():
        raise HTTPException(503, "Dataset not loaded")
    meta = get_meta_df()
    result = []
    for cid in sorted(meta["cell_id"].unique()):
        cm = meta[meta["cell_id"] == cid].iloc[0]
        n = int((meta["cell_id"] == cid).sum())
        result.append({
            "cell_id": cid,
            "dataset": str(cm.get("dataset", "")),
            "chemistry": str(cm.get("chemistry_name", "")),
            "chemistry_code": int(cm.get("chemistry_code", 0)),
            "split": str(cm.get("split", "")),
            "n_cycles": n,
        })
    return result

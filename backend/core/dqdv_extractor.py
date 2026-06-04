"""
core/dqdv_extractor.py — dQ/dV Incremental Capacity Analysis (ICA) engine.

For MIT LFP cells: uses real extracted peak features from mit_dqdv_features.npy
For other chemistries: generates physics-based Gaussian peak model curves

Peak features (5 per cycle):
  [peak1_height, peak1_pos(V), peak2_height, peak2_pos(V), valley_depth]

IC features (5 per cycle):
  [IC_peak1_h, IC_peak1_pos, IC_peak2_h, IC_peak2_pos, IC_valley]

Degradation mode mapping (from peak evolution):
  Peak position shift  → LLI  (Loss of Lithium Inventory)
  Peak height drop     → LAM  (Loss of Active Material)
  Valley depth change  → SEI  (electrolyte side reactions)
"""
from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).parent.parent.parent.parent
_PROCESSED    = _PROJECT_ROOT / "processed"

# ── Chemistry electrode peak templates ────────────────────────────────────────
# Format: list of (V_center, relative_height, sigma) at 100% SOH
_CHEM_PEAKS: dict[str, list[tuple]] = {
    "LFP": [
        (3.32, 1.00, 0.015),   # main flat-plateau peak (very narrow)
        (3.38, 0.45, 0.020),   # secondary transition
    ],
    "NMC": [
        (3.55, 0.55, 0.045),
        (3.70, 1.00, 0.035),
        (3.85, 0.70, 0.040),
        (4.10, 0.40, 0.055),
    ],
    "NCA": [
        (3.58, 0.50, 0.040),
        (3.73, 1.00, 0.035),
        (3.90, 0.65, 0.045),
        (4.12, 0.38, 0.060),
    ],
    "NCM": [
        (3.55, 0.55, 0.045),
        (3.70, 1.00, 0.035),
        (3.85, 0.68, 0.042),
        (4.10, 0.38, 0.055),
    ],
    "LCO": [
        (3.85, 0.60, 0.030),
        (3.92, 1.00, 0.025),
        (4.10, 0.75, 0.035),
        (4.18, 0.45, 0.040),
    ],
}

_V_RANGE: dict[str, tuple] = {
    "LFP": (2.80, 3.65), "NMC": (3.20, 4.25), "NCA": (3.20, 4.25),
    "NCM": (3.20, 4.25), "LCO": (3.60, 4.30),
}


# ── Synthetic IC curve generator ──────────────────────────────────────────────

def compute_dqdv_peaks(voltage, current, time) -> dict:
    """Numerically compute the dominant dQ/dV (incremental-capacity) peak from a
    raw V/I/t window — e.g. a streaming telemetry window or a discharge segment.

    Charge Q = ∫|I|dt; bins Q over voltage to denoise; dQ/dV = d(Q)/d(V).
    Returns {valid, peak_dqdv, peak_voltage, n_points, v_range} or {valid:False}.
    The peak position (V) shifts as the cell ages (LLI), so tracking it over time
    is a degradation-mode signal — the same physics generate_ic_curve models.
    """
    import numpy as np
    v = np.asarray(voltage, dtype=float)
    i = np.asarray(current, dtype=float)
    t = np.asarray(time, dtype=float)
    if len(v) < 8 or len(v) != len(i) or len(v) != len(t):
        return {"valid": False, "reason": "too few / mismatched points"}
    v_range = float(v.max() - v.min())
    if v_range < 0.05:
        return {"valid": False, "reason": "voltage range too small", "v_range": round(v_range, 4)}

    dt = np.diff(t, prepend=t[0])
    q  = np.cumsum(np.abs(i) * dt / 3600.0)        # cumulative Ah

    order = np.argsort(v)
    vs, qs = v[order], q[order]
    nb = min(40, max(8, len(v) // 3))
    edges = np.linspace(vs.min(), vs.max(), nb + 1)
    idx = np.clip(np.digitize(vs, edges) - 1, 0, nb - 1)
    qb = np.array([qs[idx == b].mean() if np.any(idx == b) else np.nan for b in range(nb)])
    vb = 0.5 * (edges[:-1] + edges[1:])
    mask = ~np.isnan(qb)
    vb, qb = vb[mask], qb[mask]
    if len(vb) < 5:
        return {"valid": False, "reason": "insufficient bins"}

    dqdv = np.abs(np.gradient(qb, vb))
    k = int(np.argmax(dqdv))
    return {
        "valid":        True,
        "peak_dqdv":    round(float(dqdv[k]), 6),
        "peak_voltage": round(float(vb[k]), 4),
        "n_points":     int(len(v)),
        "v_range":      round(v_range, 4),
    }


def generate_ic_curve(
    soh:       float,         # 0–1
    chemistry: str = "NMC",
    ir:        float = 0.0,   # internal resistance (broadens peaks)
    n_points:  int  = 200,
) -> tuple[list[float], list[float]]:
    """
    Generate a synthetic dQ/dV (IC) curve for any chemistry.
    Returns (voltage_array, dqdv_array).
    """
    chem   = chemistry.upper()
    peaks  = _CHEM_PEAKS.get(chem, _CHEM_PEAKS["NMC"])
    v_lo, v_hi = _V_RANGE.get(chem, (3.0, 4.3))

    V   = np.linspace(v_lo, v_hi, n_points)
    dQdV = np.zeros(n_points)

    # SOH modulates peak heights; IR broadens peaks; LLI shifts peak positions
    lli_shift = (1.0 - soh) * 0.03        # peak shifts left as SOH drops
    ir_broad  = 1.0 + (ir / 0.04) * 0.5   # normalised by typical fresh IR

    for (v0, h0, s0) in peaks:
        h_eff = h0 * (0.3 + 0.7 * soh)    # heights drop with SOH (LAM)
        s_eff = s0 * ir_broad              # peaks broaden with IR
        v_eff = v0 - lli_shift             # positions shift with LLI
        dQdV += h_eff * np.exp(-0.5 * ((V - v_eff) / s_eff) ** 2)

    # Add small noise for realism
    rng   = np.random.default_rng(int(soh * 1000))
    dQdV += rng.normal(0, 0.005, n_points)
    dQdV  = np.clip(dQdV, 0, None)

    return V.tolist(), dQdV.tolist()


def reconstruct_from_features(
    feat_dqdv: list[float],   # [peak1_h, peak1_pos, peak2_h, peak2_pos, valley]
    v_lo: float = 2.80,
    v_hi: float = 3.65,
    n_points: int = 200,
) -> tuple[list[float], list[float]]:
    """
    Reconstruct IC curve from the 5 extracted peak features.
    Used for MIT LFP cells where real features are available.
    """
    V    = np.linspace(v_lo, v_hi, n_points)
    dQdV = np.zeros(n_points)

    p1h, p1v, p2h, p2v, valley = feat_dqdv

    # Two positive Gaussian peaks
    sig1 = 0.018
    sig2 = 0.022
    if p1h > 0 and 2.5 < p1v < 4.5:
        dQdV += p1h * np.exp(-0.5 * ((V - p1v) / sig1) ** 2)
    if p2h > 0 and 2.5 < p2v < 4.5:
        dQdV += p2h * np.exp(-0.5 * ((V - p2v) / sig2) ** 2)

    # Valley (negative Gaussian between peaks)
    if valley > 0 and p1v < p2v:
        v_mid = (p1v + p2v) / 2
        dQdV -= valley * np.exp(-0.5 * ((V - v_mid) / 0.025) ** 2)

    dQdV = np.clip(dQdV, 0, None)
    return V.tolist(), dQdV.tolist()


# ── Data loaders ──────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _load_mit_data() -> tuple[np.ndarray, np.ndarray, object]:
    """Load real MIT LFP dQ/dV features. Returns (dqdv_arr, ic_arr, meta_df)."""
    import pandas as pd
    dqdv = np.load(_PROCESSED / "mit_dqdv_features.npy")   # (N,5)
    ic   = np.load(_PROCESSED / "mit_ic_features.npy")     # (N,5)
    meta = pd.read_csv(_PROCESSED / "mit_dqdv_meta.csv")   # cell_id, cycle
    return dqdv, ic, meta


def _has_mit_data() -> bool:
    try:
        _load_mit_data()
        return True
    except Exception:
        return False


def _is_mit_cell(cell_id: str) -> bool:
    return "MIT" in cell_id.upper() or "2017" in cell_id or "2018" in cell_id


# ── Cell IC series ────────────────────────────────────────────────────────────

def get_cell_ic_series(
    cell_id: str,
    n_samples: int = 8,
    chemistry: str = "LFP",
) -> dict:
    """
    Return sampled IC curves for a cell over its cycle life.
    MIT cells → real features; others → synthetic.
    """
    if _is_mit_cell(cell_id) and _has_mit_data():
        return _mit_ic_series(cell_id, n_samples)
    return _synthetic_ic_series(cell_id, chemistry, n_samples)


def _mit_ic_series(cell_id: str, n_samples: int) -> dict:
    dqdv_arr, ic_arr, meta = _load_mit_data()
    mask    = (meta["cell_id"] == cell_id).values
    if not mask.any():
        return {"error": f"Cell {cell_id} not in MIT dQ/dV dataset"}

    cycles   = meta.loc[mask, "cycle"].values
    feats    = dqdv_arr[mask]                        # (K, 5)
    ic_feats = ic_arr[mask]                          # (K, 5)

    order    = np.argsort(cycles)
    cycles   = cycles[order];  feats = feats[order]; ic_feats = ic_feats[order]

    idxs = np.linspace(0, len(cycles) - 1, n_samples, dtype=int)

    curves  = []
    for i in idxs:
        V, dQdV = reconstruct_from_features(feats[i].tolist())
        curves.append({
            "cycle":    int(cycles[i]),
            "voltage":  [round(v, 4) for v in V],
            "dqdv":     [round(v, 4) for v in dQdV],
            "features": {
                "peak1_height": round(float(feats[i, 0]), 4),
                "peak1_pos":    round(float(feats[i, 1]), 4),
                "peak2_height": round(float(feats[i, 2]), 4),
                "peak2_pos":    round(float(feats[i, 3]), 4),
                "valley_depth": round(float(feats[i, 4]), 4),
            },
        })

    peaks_trend = _peak_trend_from_features(cycles, feats)
    deg_modes   = _degradation_modes(feats)

    return {
        "cell_id":          cell_id,
        "chemistry":        "LFP",
        "source":           "real",
        "n_cycles_total":   int(len(cycles)),
        "curves":           curves,
        "peak_trends":      peaks_trend,
        "degradation_modes": deg_modes,
    }


def _synthetic_ic_series(cell_id: str, chemistry: str, n_samples: int) -> dict:
    """Build IC series from the main dataset SOH time-series."""
    import core.data_loader as dl
    if dl._meta_df is None:
        dl.load_dataset()

    meta = dl._meta_df
    mask = meta["cell_id"].values == cell_id
    if not mask.any():
        return {"error": f"Cell {cell_id} not found"}

    import numpy as np
    idx     = np.where(mask)[0]
    grp     = meta.iloc[idx].sort_values("cycle")
    ridx    = grp.index.values

    cycles  = grp["cycle"].values
    soh_arr = dl._features[ridx, 9]    # cap_pct
    ir_arr  = dl._features[ridx, 7]    # Internal Resistance

    order   = np.argsort(cycles)
    cycles  = cycles[order];  soh_arr = soh_arr[order]; ir_arr = ir_arr[order]

    idxs    = np.linspace(0, len(cycles) - 1, n_samples, dtype=int)
    curves  = []
    for i in idxs:
        soh = float(np.clip(soh_arr[i], 0.1, 1.0))
        ir  = float(ir_arr[i]) if ir_arr[i] > 0 else 0.0
        V, dQdV = generate_ic_curve(soh, chemistry, ir)
        curves.append({
            "cycle":   int(cycles[i]),
            "voltage": [round(v, 4) for v in V],
            "dqdv":    [round(v, 4) for v in dQdV],
            "soh":     round(soh * 100, 1),
        })

    # Build synthetic peak trends from SOH curve
    peak_ref = _CHEM_PEAKS.get(chemistry.upper(), _CHEM_PEAKS["NMC"])
    p1_pos   = [peak_ref[0][0] - (1 - s) * 0.03 for s in soh_arr]
    p1_h     = [peak_ref[0][1] * (0.3 + 0.7 * s) for s in soh_arr]
    p2_pos   = [peak_ref[1][0] - (1 - s) * 0.03 for s in soh_arr] if len(peak_ref) > 1 else []
    p2_h     = [peak_ref[1][1] * (0.3 + 0.7 * s) for s in soh_arr] if len(peak_ref) > 1 else []

    deg = _degradation_modes_from_soh(float(soh_arr[0]), float(soh_arr[-1]))

    return {
        "cell_id":           cell_id,
        "chemistry":         chemistry.upper(),
        "source":            "synthetic",
        "n_cycles_total":    int(len(cycles)),
        "curves":            curves,
        "peak_trends": {
            "cycles":      [int(c) for c in cycles],
            "peak1_pos":   [round(float(v), 4) for v in p1_pos],
            "peak1_height":[round(float(v), 4) for v in p1_h],
            "peak2_pos":   [round(float(v), 4) for v in p2_pos],
            "peak2_height":[round(float(v), 4) for v in p2_h],
        },
        "degradation_modes": deg,
    }


# ── Peak trend + degradation mode analysis ────────────────────────────────────

def _peak_trend_from_features(cycles: np.ndarray, feats: np.ndarray) -> dict:
    return {
        "cycles":       [int(c) for c in cycles],
        "peak1_height": [round(float(v), 4) for v in feats[:, 0]],
        "peak1_pos":    [round(float(v), 4) for v in feats[:, 1]],
        "peak2_height": [round(float(v), 4) for v in feats[:, 2]],
        "peak2_pos":    [round(float(v), 4) for v in feats[:, 3]],
        "valley_depth": [round(float(v), 4) for v in feats[:, 4]],
    }


def _degradation_modes(feats: np.ndarray) -> dict:
    """Estimate LLI/LAM from peak evolution across feats[0] (fresh) → feats[-1] (aged)."""
    if len(feats) < 2:
        return {}
    # Cast to plain Python floats to avoid numpy.float32 JSON serialisation errors
    f0, f1, f2, f3, f4 = [float(feats[0, i]) for i in range(5)]
    a0, a1, a2, a3, a4 = [float(feats[-1, i]) for i in range(5)]

    pos_shift  = abs(a1 - f1)
    lli_pct    = min(100.0, pos_shift / 0.05 * 30)

    h1_drop    = max(0.0, f0 - a0)
    lam_ne_pct = min(100.0, h1_drop / max(f0, 1e-6) * 50)

    h2_drop    = max(0.0, f2 - a2)
    lam_pe_pct = min(100.0, h2_drop / max(f2, 1e-6) * 50)

    valley_change = a4 - f4
    sei_pct       = max(0.0, min(100.0, valley_change / max(f4, 0.01) * 20))

    return {
        "LLI":    round(lli_pct, 1),
        "LAM_NE": round(lam_ne_pct, 1),
        "LAM_PE": round(lam_pe_pct, 1),
        "SEI":    round(sei_pct, 1),
        "dominant": max(
            [("LLI", lli_pct), ("LAM_NE", lam_ne_pct),
             ("LAM_PE", lam_pe_pct), ("SEI", sei_pct)],
            key=lambda x: x[1]
        )[0],
    }


def _degradation_modes_from_soh(soh_fresh: float, soh_aged: float) -> dict:
    fade = max(0, soh_fresh - soh_aged)
    lli  = fade * 0.40 * 100
    lam  = fade * 0.35 * 100
    sei  = fade * 0.25 * 100
    return {
        "LLI":    round(lli, 1),
        "LAM_NE": round(lam * 0.6, 1),
        "LAM_PE": round(lam * 0.4, 1),
        "SEI":    round(sei, 1),
        "dominant": "LLI" if lli >= lam else "LAM_NE",
    }

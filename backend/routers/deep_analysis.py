"""
deep_analysis.py — conformal prediction, PyBaMM, ablation, Oxford extended, knee detection.
"""
from __future__ import annotations
import json, re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException

router = APIRouter()

PROJECT_ROOT  = Path(__file__).parent.parent.parent.parent
THESIS_DIR    = PROJECT_ROOT / "thesis_results"
CONF_DIR      = THESIS_DIR / "conformal_analysis"
PYBAMM_DIR    = PROJECT_ROOT / "data" / "pybamm_synthetic"
ABL_DIR       = PROJECT_ROOT / "conference_paper_legitimate" / "results"


def _clean(arr) -> list:
    a = np.asarray(arr, dtype=float)
    return np.where(np.isfinite(a), a, None).tolist()


# ── 1. CONFORMAL PREDICTION ──────────────────────────────────────────────────

def _parse_conformal_md(path: Path) -> dict:
    if not path.exists():
        return {}
    text = path.read_text(errors="ignore")

    # Extract alpha table
    intervals = []
    for m in re.finditer(r'\|\s*([\d.]+)\s*\|\s*(\d+)%\s*\|\s*±([\d.]+)', text):
        intervals.append({"alpha": float(m.group(1)), "confidence": int(m.group(2)), "half_width": float(m.group(3))})

    # Extract test coverage table
    coverage = []
    for m in re.finditer(r'\|\s*([A-Z][^\|]+)\s*\|\s*(\d+)\s*\|\s*([\d.]+)%\s*\|\s*±([\d.]+)', text):
        coverage.append({"chemistry": m.group(1).strip(), "n_windows": int(m.group(2)),
                         "empirical_coverage": float(m.group(3)), "mean_width": float(m.group(4))})
    return {"intervals": intervals, "coverage": coverage, "raw_text": text[:2000]}


@router.get("/conformal/results")
def get_conformal() -> dict[str, Any]:
    result = {}
    for name in ["conformal_results", "online_results", "stratified_results"]:
        md = CONF_DIR / f"{name}.md"
        result[name] = _parse_conformal_md(md)

    # Hardcoded from the parsed markdown (already read above)
    result["summary"] = {
        "method": "Split conformal prediction (Vovk 2005)",
        "calibration_set": "CS2_34 + CX2_37 (376 windows)",
        "guarantee": "Marginal coverage ≥ 1-α",
        "intervals": [
            {"alpha": 0.05, "confidence": 95, "half_width": 213.9},
            {"alpha": 0.10, "confidence": 90, "half_width": 195.0},
            {"alpha": 0.20, "confidence": 80, "half_width": 170.9},
        ],
        "coverage": [
            {"chemistry": "CALCE LCO",  "n_windows": 552,  "empirical_coverage": 81.5, "mean_width": 0.6},
            {"chemistry": "KJTU NMC",   "n_windows": 2397, "empirical_coverage": 78.8, "mean_width": 0.6},
            {"chemistry": "Oxford ZS",  "n_windows": 95,   "empirical_coverage": 100.0, "mean_width": 0.6},
        ],
        "per_stage": {
            "CALCE LCO": [
                {"stage": "Early", "n": 548, "coverage": 81.4},
                {"stage": "Mid",   "n": 4,   "coverage": 100.0},
            ],
            "KJTU NMC": [
                {"stage": "Early", "n": 2156, "coverage": 76.4},
                {"stage": "Mid",   "n": 241,  "coverage": 100.0},
            ],
            "Oxford ZS": [
                {"stage": "Early", "n": 6,  "coverage": 100.0},
                {"stage": "Mid",   "n": 89, "coverage": 100.0},
            ],
        },
    }
    return result


# ── 2. PYBAMM SYNTHETIC CELLS ────────────────────────────────────────────────

@router.get("/pybamm/cells")
def get_pybamm_cells() -> dict[str, Any]:
    if not PYBAMM_DIR.exists():
        raise HTTPException(404, "PyBaMM data not found")
    try:
        n_cells = int(np.load(PYBAMM_DIR / "n_cells.npy"))
    except Exception:
        n_cells = 20

    cells = []
    for i in range(n_cells):
        try:
            x  = np.load(PYBAMM_DIR / f"X_raw_{i}.npy")
            cy = np.load(PYBAMM_DIR / f"cycles_{i}.npy")
            rl = np.load(PYBAMM_DIR / f"rul_raw_{i}.npy")
            cap = x[:, 0].tolist()
            init_cap = float(cap[0]) if cap[0] else 1.0
            soh = [c / init_cap for c in cap]
            cells.append({
                "cell_id": f"PyBaMM_NMC_{i:02d}",
                "chemistry": "NMC (synthetic)",
                "lifetime_cycles": int(rl[0]) if len(rl) else 0,
                "n_snapshots": len(cy),
                "cycles": cy.tolist(),
                "capacity": _clean(cap),
                "soh_pct": _clean([s * 100 for s in soh]),
                "rul": _clean(rl),
            })
        except Exception:
            continue
    return {"n_cells": n_cells, "cells": cells,
            "description": "20 NMC cells simulated using PyBaMM DFN (Doyle-Fuller-Newman) model. Variable degradation rates. Used in MambaRUL v10 training."}


# ── 3. ABLATION STUDY ────────────────────────────────────────────────────────

@router.get("/ablation/anchors")
def get_anchor_ablation() -> dict[str, Any]:
    path = ABL_DIR / "ablation_anchors_legitimate.json"
    if not path.exists():
        raise HTTPException(404, "Anchor ablation file not found")
    data = json.loads(path.read_text())
    result = []
    for k, v in sorted(data.items(), key=lambda x: int(x[0])):
        cs37 = v["cell_results"].get("CS2_37", {})
        cs38 = v["cell_results"].get("CS2_38", {})
        avg_rmse = (cs37.get("rmse", 0) + cs38.get("rmse", 0)) / 2
        result.append({
            "n_anchors": int(k),
            "cs2_37_rmse": round(cs37.get("rmse", 0), 2),
            "cs2_38_rmse": round(cs38.get("rmse", 0), 2),
            "avg_rmse": round(avg_rmse, 2),
            "cs2_37_r2": round(cs37.get("r2", 0), 4),
            "best_epoch": v.get("best_epoch", 0),
        })
    return {"anchor_ablation": result}


@router.get("/ablation/features")
def get_feature_ablation() -> dict[str, Any]:
    path = ABL_DIR / "ablation_cappct_legitimate.json"
    if not path.exists():
        raise HTTPException(404, "Feature ablation file not found")
    data = json.loads(path.read_text())
    result = []
    for k, v in data.items():
        cs37 = v["cell_results"].get("CS2_37", {})
        cs38 = v["cell_results"].get("CS2_38", {})
        avg_r = (cs37.get("rmse", 0) + cs38.get("rmse", 0)) / 2
        result.append({
            "config": k,
            "n_features": v.get("n_features", 0),
            "cs2_37_rmse": round(cs37.get("rmse", 0), 2),
            "cs2_38_rmse": round(cs38.get("rmse", 0), 2),
            "avg_rmse": round(avg_r, 2),
            "cs2_37_r2": round(cs37.get("r2", 0), 4),
        })
    # Also add hardcoded multi-chemistry ablation from thesis
    result += [
        {"config": "no_soh_curvature", "n_features": 12, "cs2_37_rmse": 26.1, "cs2_38_rmse": 22.4, "avg_rmse": 24.3, "cs2_37_r2": 0.879},
        {"config": "no_discharge_slope", "n_features": 12, "cs2_37_rmse": 18.9, "cs2_38_rmse": 16.2, "avg_rmse": 17.6, "cs2_37_r2": 0.941},
        {"config": "no_IR_features", "n_features": 11, "cs2_37_rmse": 22.4, "cs2_38_rmse": 19.1, "avg_rmse": 20.8, "cs2_37_r2": 0.916},
        {"config": "only_raw_8", "n_features": 8, "cs2_37_rmse": 88.8, "cs2_38_rmse": 81.3, "avg_rmse": 85.1, "cs2_37_r2": 0.636},
    ]
    return {"feature_ablation": result}


# ── 4. OXFORD EXTENDED ANALYSIS ──────────────────────────────────────────────

@router.get("/oxford/loocv")
def get_oxford_loocv() -> dict[str, Any]:
    path = THESIS_DIR / "oxford_loocv" / "fold_results.csv"
    if not path.exists():
        raise HTTPException(404, "LOOCV results not found")
    df = pd.read_csv(path)
    return {"columns": df.columns.tolist(), "rows": df.to_dict("records"),
            "description": "Leave-one-out cross-validation across Oxford Cell1–Cell8. Each cell held out once while model trained on remaining 7."}


@router.get("/oxford/early-prediction")
def get_oxford_earlypred() -> dict[str, Any]:
    path = THESIS_DIR / "oxford_earlypred" / "earlypred_results.csv"
    if not path.exists():
        raise HTTPException(404, "Early prediction results not found")
    df = pd.read_csv(path)
    return {"columns": df.columns.tolist(), "rows": df.to_dict("records"),
            "description": "How prediction quality degrades when fewer calibration snapshots (K) are available. Shows minimum K for reliable deployment."}


@router.get("/oxford/anchor-analysis")
def get_oxford_anchor() -> dict[str, Any]:
    path = THESIS_DIR / "oxford_anchor" / "anchor_results.csv"
    if not path.exists():
        raise HTTPException(404, "Anchor results not found")
    df = pd.read_csv(path)
    return {"columns": df.columns.tolist(), "rows": df.to_dict("records"),
            "description": "Comparison of zero-shot, fixed anchor (cap_pct=0.35), and analytic anchor initialization strategies."}


@router.get("/oxford/ksweep-final")
def get_oxford_ksweep_final() -> dict[str, Any]:
    """Real Oxford K-sweep + M1-M6 methods comparison from published results."""
    # M1-M6 final comparison (from oxford_final/FINAL_RESULTS.md)
    methods = [
        {"method": "M1: v8 zero-shot",     "oxford_rmse": 2276.1, "oxford_r2": -1.447, "calce_rmse": 23.95, "calce_r2": 0.916,
         "cell7_rmse": 2261.6, "cell7_r2": -1.359, "cell8_rmse": 2290.6, "cell8_r2": -1.535, "label": "v8 Zero-Shot"},
        {"method": "M2: v8 self-anchor K=30", "oxford_rmse": 1340.6, "oxford_r2": 0.152, "calce_rmse": 23.95, "calce_r2": 0.916,
         "cell7_rmse": 1346.9, "cell7_r2": 0.163, "cell8_rmse": 1334.3, "cell8_r2": 0.140, "label": "v8 Anchor"},
        {"method": "M3: v9 zero-shot",       "oxford_rmse": 711.4,  "oxford_r2": 0.741, "calce_rmse": 21.53, "calce_r2": 0.932,
         "cell7_rmse": 934.5,  "cell7_r2": 0.597, "cell8_rmse": 488.2,  "cell8_r2": 0.885, "label": "v9 Zero-Shot"},
        {"method": "M4: v9 self-anchor K=30","oxford_rmse": 1796.8, "oxford_r2": -0.525,"calce_rmse": 21.53, "calce_r2": 0.932,
         "cell7_rmse": 1892.1, "cell7_r2": -0.651,"cell8_rmse": 1701.4, "cell8_r2": -0.399,"label": "v9 Anchor"},
        {"method": "M5: v9 deep-ft 30snaps", "oxford_rmse": 636.0,  "oxford_r2": 0.805, "calce_rmse": 21.53, "calce_r2": 0.932,
         "cell7_rmse": 742.4,  "cell7_r2": 0.746, "cell8_rmse": 529.6,  "cell8_r2": 0.864, "label": "v9 Deep-FT 30"},
        {"method": "M6: v9 deep-ft 50snaps", "oxford_rmse": 101.6,  "oxford_r2": 0.995, "calce_rmse": 21.53, "calce_r2": 0.932,
         "cell7_rmse": 129.5,  "cell7_r2": 0.992, "cell8_rmse": 73.6,   "cell8_r2": 0.997, "label": "v9 Deep-FT 50"},
    ]

    # K-sweep data from extended_calib_results.csv
    ksweep: list[dict] = []
    ksweep_path = THESIS_DIR / "oxford_extended_calib" / "extended_calib_results.csv"
    if ksweep_path.exists():
        df = pd.read_csv(ksweep_path)
        ksweep = df.to_dict("records")

    return {"methods": methods, "ksweep": ksweep}


@router.get("/calce/ic-curve")
def get_ic_curve(cell_id: str = "CS2_35", n_cycles: int = 5) -> dict[str, Any]:
    """Real dQ/dV curves from CALCE XLSX files. Reads actual discharge data."""
    import openpyxl
    from scipy.signal import savgol_filter

    DATA_DIR = PROJECT_ROOT / "data" / "calce" / cell_id
    if not DATA_DIR.exists():
        raise HTTPException(404, f"Cell directory not found: {cell_id}")

    # Collect all discharge data across files, sorted by filename
    all_cycles: dict[int, list[tuple[float, float]]] = {}
    for xlsx_file in sorted(DATA_DIR.glob("*.xlsx")):
        try:
            wb = openpyxl.load_workbook(str(xlsx_file), read_only=True, data_only=True)
            ws = wb.active
            rows = list(ws.iter_rows(min_row=2, values_only=True))
            for row in rows:
                try:
                    cycle_idx = int(row[5]) if row[5] is not None else None
                    voltage   = float(row[7]) if row[7] is not None else None
                    dis_cap   = float(row[9]) if row[9] is not None else None
                    if cycle_idx and voltage and dis_cap and dis_cap > 0.001:
                        all_cycles.setdefault(cycle_idx, []).append((voltage, dis_cap))
                except (TypeError, ValueError):
                    continue
            wb.close()
        except Exception:
            continue

    if not all_cycles:
        raise HTTPException(404, "No discharge data found in XLSX files")

    # Pick evenly spaced cycles
    sorted_cycles = sorted(all_cycles.keys())
    if len(sorted_cycles) <= n_cycles:
        selected = sorted_cycles
    else:
        idx = [int(i * (len(sorted_cycles) - 1) / (n_cycles - 1)) for i in range(n_cycles)]
        selected = [sorted_cycles[i] for i in idx]

    curves = []
    for cy in selected:
        pts = sorted(all_cycles[cy], key=lambda x: x[0], reverse=True)  # sort by V descending (discharge)
        if len(pts) < 10:
            continue
        voltages = [p[0] for p in pts]
        caps     = [p[1] for p in pts]
        # dQ/dV: smooth capacity then differentiate wrt voltage
        try:
            window = min(11, len(caps) if len(caps) % 2 else len(caps) - 1)
            caps_sm = savgol_filter(caps, window, 3)
        except Exception:
            caps_sm = caps
        dqdv = []
        v_out = []
        for i in range(1, len(voltages)):
            dv = voltages[i] - voltages[i - 1]
            dq = caps_sm[i] - caps_sm[i - 1]
            if abs(dv) > 1e-4:
                dqdv.append(dq / dv)
                v_out.append(voltages[i])
        # Clip extreme outliers
        if dqdv:
            q10, q90 = np.percentile(dqdv, 5), np.percentile(dqdv, 95)
            dqdv_clip = [max(q10, min(q90, v)) for v in dqdv]
            curves.append({"cycle": cy, "voltage": v_out, "dqdv": dqdv_clip,
                           "max_capacity": float(max(caps))})

    return {"cell_id": cell_id, "curves": curves, "n_curves": len(curves),
            "available_cells": [d.name for d in (PROJECT_ROOT / "data" / "calce").iterdir() if d.is_dir()]}


# ── 5. KNEE POINT DETECTION ──────────────────────────────────────────────────

@router.get("/knee-detection/{cell_id}")
def detect_knee(cell_id: str) -> dict[str, Any]:
    """Detect degradation knee point in a cell using SOH curvature."""
    from core.data_loader import get_meta_df, get_features_array, is_loaded
    from scipy.signal import savgol_filter
    if not is_loaded():
        raise HTTPException(503, "Dataset not loaded")

    meta  = get_meta_df()
    feats = get_features_array()
    mask  = meta["cell_id"] == cell_id
    if not mask.any():
        raise HTTPException(404, f"Cell '{cell_id}' not found")

    cap  = feats[mask, 0].copy()
    cyc  = meta[mask]["cycle"].values
    rul  = meta[mask]["rul"].values
    N    = len(cap)

    # Smooth + SOH
    if N >= 11:
        cap_sm = savgol_filter(cap, min(11, N if N % 2 else N - 1), 3)
    else:
        cap_sm = cap.copy()
    init = float(cap_sm[0]) or 1.0
    soh  = cap_sm / init

    # Curvature (d²SOH/di²)
    if N >= 7:
        curv = np.gradient(np.gradient(soh))
    else:
        curv = np.zeros(N)

    # Knee = cycle of maximum curvature (most negative = inflection)
    knee_idx = int(np.argmax(np.abs(curv)))
    knee_cycle = int(cyc[knee_idx])
    knee_soh   = float(soh[knee_idx])

    # Slope before/after knee
    pre  = np.polyfit(np.arange(knee_idx + 1), soh[:knee_idx + 1], 1)[0] if knee_idx > 2 else 0
    post = np.polyfit(np.arange(N - knee_idx), soh[knee_idx:], 1)[0] if N - knee_idx > 2 else 0

    return {
        "cell_id": cell_id,
        "cycles": cyc.tolist(),
        "capacity": _clean(cap),
        "soh": _clean(soh * 100),
        "curvature": _clean(curv * 1000),
        "rul": _clean(rul),
        "knee_cycle": knee_cycle,
        "knee_soh_pct": round(knee_soh * 100, 1),
        "slope_before": round(float(pre), 6),
        "slope_after":  round(float(post), 6),
        "acceleration": round(float(post - pre), 6) if pre and post else 0,
    }

"""
routers/predict.py — Live RUL prediction with real PyTorch model inference.
Supports model selection: v10-final, v10-full, v9, v8, tcn-mamba, analytical.
"""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Depends, Request
from schemas.models import (
    PredictRequest, PredictResponse, PartialCycleRequest,
    PackPredictRequest, PackPartialRequest, DodCalibrationRequest,
)
from core.middleware import require_auth

router = APIRouter()

try:
    from main import limiter as _limiter
    _rate_limit = _limiter.limit("30/minute")
except Exception:
    def _rate_limit(fn):
        return fn

_MAX_RUL = {"LCO": 309.0, "LFP": 1934.0, "NMC": 1500.0, "NCM": 1000.0, "NCA": 800.0}
_DECAY   = 2.3
_SCALE   = {"LCO": 1.00, "LFP": 0.88, "NMC": 0.95, "NCM": 0.92, "NCA": 0.90}

# 90% conformal prediction half-widths — two calibration sources per chemistry.
# HUST: proper LOOCV on held-out cells (conservative, most defensible).
# MIT:  90th-pct residual on MIT fine-tune train+val cells (tighter, in-distribution).
# Operational CI = max(HUST, MIT) — most conservative, appropriate for safety-critical use.
_CI_HUST = {
    "LCO":  34.0,   # CALCE RMSE ~20-32
    "LFP": 145.3,   # HUST 77-cell LOOCV, 25,911 pts
    "NMC": 514.3,   # Oxford LOOCV (long-life NMC, 8 cells ~8100 EOL)
    "NCM":  17.0,   # TJU RMSE ~10-12
    "NCA":  20.0,   # similar to NCM
}
_CI_MIT = {
    "LCO":  34.0,   # no MIT calibration — same as HUST
    "LFP":  47.8,   # MIT fine-tune checkpoint, 104 cells, 83,981 windows, 90th-pct residual
    "NMC": 514.3,   # no MIT calibration — same as HUST
    "NCM":  17.0,   # no MIT calibration — same as HUST
    "NCA":  20.0,   # no MIT calibration — same as HUST
}
_CONFORMAL_90 = {k: max(_CI_HUST[k], _CI_MIT[k]) for k in _CI_HUST}


def _get(d: dict, k: str, default: float) -> float:
    v = d.get(k); return float(v) if v is not None else default

def _temp_ci_multiplier(temp_c: float) -> float:
    """Widen CI when operating temperature deviates from 25°C calibration range."""
    if temp_c > 40: return 1.8
    if temp_c > 35: return 1.5
    if temp_c < 10: return 2.0
    if temp_c < 15: return 1.8
    return 1.0

def _add_conformal(result: dict, chem: str, temp_c: float = 25.0,
                   cell_id: str | None = None) -> dict:
    """Attach calibrated 90% conformal prediction interval to a result dict.

    When cell_id is provided and Layer 3 has ≥10 cycles of history, the global
    chemistry CI is replaced with the per-cell tightened CI.
    """
    c    = chem.upper()
    rul  = result.get("predicted_rul", 0.0)
    base = _CONFORMAL_90.get(c, 34.0)

    # Layer 3: use per-cell CI when available
    ci_source = "global"
    if cell_id:
        try:
            from core.online_rul import get_cell_ci
            cell_half = get_cell_ci(cell_id)
            if cell_half is not None:
                base      = cell_half
                ci_source = "per-cell"
        except Exception:
            pass

    mult = _temp_ci_multiplier(temp_c)
    half = base * mult
    result["lower_90"]          = round(max(0.0, rul - half), 1)
    result["upper_90"]          = round(rul + half, 1)
    result["confidence_width"]  = round(half * 2, 1)
    result["confidence_pct"]    = 90
    hust = _CI_HUST.get(c, base)
    mit  = _CI_MIT.get(c, base)
    result["confidence_source"] = f"conformal({ci_source},HUST=±{hust},MIT=±{mit},used=±{round(base,1)})"
    result["ci_hust"]           = hust
    result["ci_mit"]            = mit
    if mult > 1.0:
        result["ci_temp_widened"] = round(mult, 2)
    return result

def _apply_dod(result: dict, chem: str, dod_pct: float | None) -> dict:
    """Apply DoD multiplier to a result dict and widen CI accordingly."""
    if dod_pct is None or dod_pct >= 99.0:
        return result
    from core.model_loader import _dod_rul_multiplier
    rul_mult, ci_mult = _dod_rul_multiplier(dod_pct, chem)
    if rul_mult == 1.0:
        return result
    rul = result.get("predicted_rul", 0.0) * rul_mult
    # Recompute CI bounds with both DoD and existing conformal half-width
    half = (result.get("confidence_width", 0.0) / 2.0) * ci_mult
    result["predicted_rul"]     = round(rul, 1)
    result["lower_90"]          = round(max(0.0, rul - half), 1)
    result["upper_90"]          = round(rul + half, 1)
    result["confidence_width"]  = round(half * 2, 1)
    result["confidence_source"] += f"+dod({dod_pct:.0f}%,×{rul_mult:.2f})"
    result["dod_pct"]           = round(dod_pct, 1)
    result["dod_multiplier"]    = round(rul_mult, 3)
    result["dod_ci_factor"]     = round(ci_mult, 3)
    return result

def _apply_cold_start(result: dict, chem: str, req: dict) -> dict:
    """Blend analytical result with chemistry prior for cold-start cells."""
    n_cycles = req.get("n_cycles")
    if n_cycles is None or int(n_cycles) >= 30:
        return result
    from core.model_loader import _cold_start_blend
    rul_blended, cs_ci, cs_tag = _cold_start_blend(
        result["predicted_rul"], req, int(n_cycles)
    )
    half = (result.get("confidence_width", 0.0) / 2.0) * cs_ci
    result["predicted_rul"]     = round(rul_blended, 1)
    result["lower_90"]          = round(max(0.0, rul_blended - half), 1)
    result["upper_90"]          = round(rul_blended + half, 1)
    result["confidence_width"]  = round(half * 2, 1)
    result["confidence_source"] += f"+{cs_tag}"
    result["cold_start"]        = cs_tag
    result["cs_ci_factor"]      = round(cs_ci, 3)
    return result

def _analytical(req: dict) -> dict:
    chem  = (req.get("chemistry") or "LCO").upper()
    soh   = _get(req, "cap_pct", 0.85)
    ir    = _get(req, "int_resistance", 0.05)
    max_r = _MAX_RUL.get(chem, 309.0)
    scale = _SCALE.get(chem, 1.0)
    ir_f  = max(0.5, 1 - (ir - 0.03) / 0.25)
    rul   = max(0.0, max_r * scale * (soh ** _DECAY) * ir_f)
    conf  = rul * 0.15
    phase = "Fresh" if soh > 0.9 else "Aging" if soh > 0.75 else "Knee" if soh > 0.6 else "Near-EOL"
    result = {"predicted_rul": round(rul, 1), "lower_bound": round(max(0, rul - conf), 1),
              "upper_bound": round(rul + conf, 1), "health_score": round(soh * 100, 1),
              "phase": phase, "chemistry": chem, "model": "Analytical approximation (no PyTorch)",
              "model_id": "analytical", "mode": "analytical"}
    result = _add_conformal(result, chem)
    result = _apply_dod(result, chem, req.get("dod_pct"))
    return _apply_cold_start(result, chem, req)


@router.get("/predict/available-models")
def list_available_models() -> list[dict]:
    """List all models with their load status."""
    from core.model_loader import get_loaded_models
    return get_loaded_models()


@router.post("/predict", response_model=None, dependencies=[Depends(require_auth)])
@_rate_limit
def predict(req: PredictRequest, request: Request) -> dict[str, Any]:
    """
    Run RUL prediction. model_id selects which checkpoint to use.
    Falls back to analytical approximation if model not loaded.
    """
    req_dict = req.model_dump()
    model_id = req_dict.pop("model_id", "v10-final") or "v10-final"
    cell_id  = req_dict.pop("cell_id", None)

    if model_id == "analytical":
        result = _analytical(req_dict)
    else:
        try:
            from core.model_loader import run_inference
            result = run_inference(model_id, req_dict)
            chem   = req_dict.get("chemistry", "LCO")
            temp_c = float(req_dict.get("temperature", 25.0) or 25.0)
            result = _add_conformal(result, chem, temp_c, cell_id=cell_id)
            # run_inference already applied DoD + cold-start to predicted_rul;
            # now widen the conformal CI by their respective uncertainty factors.
            extra_ci = result.get("dod_ci_factor", 1.0) * result.get("cs_ci_factor", 1.0)
            if extra_ci > 1.0:
                rul  = result["predicted_rul"]
                half = result["confidence_width"] / 2.0 * extra_ci
                result["lower_90"]         = round(max(0.0, rul - half), 1)
                result["upper_90"]         = round(rul + half, 1)
                result["confidence_width"] = round(half * 2, 1)
        except Exception:
            result = _analytical(req_dict)

    # Track call for analytics (best-effort, never block)
    try:
        from core.analytics import track_call
        auth = getattr(request.state, 'auth', {})
        org  = auth.get("org", "") if auth.get("type") == "api_key" else ""
        src  = "api_key" if auth.get("type") == "api_key" else "direct"
        track_call(
            chemistry=result.get("chemistry", req_dict.get("chemistry", "UNK")),
            model_id=model_id,
            rul=result.get("predicted_rul", 0.0),
            phase=result.get("phase", "Unknown"),
            source=src,
            org=org,
        )
    except Exception:
        pass

    return result


@router.post("/predict/partial", response_model=None, dependencies=[Depends(require_auth)])
def predict_partial(req: PartialCycleRequest, request: Request) -> dict:
    """
    RUL prediction from a raw partial-cycle V/I/t/T trace.

    Designed for real BMS data where complete 0–100% discharge cycles are
    unavailable.  Reconstructs full-cycle features via completeness scaling
    and polynomial extrapolation, then runs v10-final inference.

    The response includes `completeness`, `data_quality`, and widened
    conformal intervals that reflect reconstruction uncertainty.
    """
    from core.partial_cycle import extract_features_from_trace, _rolling_slope
    from core.model_loader import run_inference

    chem = req.chemistry

    # ── Feature extraction ────────────────────────────────────────────────────
    result = extract_features_from_trace(
        v=req.voltage,
        i=req.current,
        t=req.time_s,
        T=req.temperature,
        chemistry=chem,
        soc_start=req.soc_start,
        soc_end=req.soc_end,
        nom_capacity_ah=req.nom_capacity_ah,
        charge_time_s=req.charge_time_s,
    )
    feat9 = result["features_9"]        # shape (9,)
    completeness = result["completeness"]

    # Override discharge_slope if caller provided history
    if req.capacity_history and len(req.capacity_history) >= 2:
        caps = _rolling_slope(
            arr=__import__("numpy").array(req.capacity_history, dtype="float32"),
            window=5,
        )
        feat9[6] = float(caps[-1])
        result["source"]["discharge_slope"] = "measured"
        result["warnings"] = [w for w in result["warnings"]
                              if "discharge_slope" not in w]

    # ── Run model inference via existing feature-dict pathway ─────────────────
    cap     = float(feat9[0])
    ct      = float(feat9[1])
    vm      = float(feat9[2])
    ve      = float(feat9[3])
    energy  = float(feat9[4])
    temp    = float(feat9[5])
    ir      = float(feat9[7])

    # Build the standard req dict that run_inference / analytical understands
    req_dict = {
        "chemistry":    chem,
        "capacity":     cap,
        "cap_pct":      min(cap / (req.nom_capacity_ah or max(cap, 1.0)), 1.0),
        "charge_time":  ct,
        "voltage_mean": vm,
        "voltage_end":  ve,
        "energy":       energy,
        "temperature":  temp,
        "int_resistance": ir,
    }
    # Pass operating conditions so run_inference applies DoD + cold-start
    if req.n_cycles is not None:
        req_dict["n_cycles"] = req.n_cycles
    if req.dod_pct is not None:
        req_dict["dod_pct"] = req.dod_pct

    try:
        pred = run_inference(req.model_id, req_dict)
        pred = _add_conformal(pred, chem, float(feat9[5]))
    except Exception:
        pred = _analytical(req_dict)

    # ── Widen CI for partial/low-quality data + DoD/cold-start uncertainty ────
    quality   = result["data_quality"]
    penalty   = {"high": 1.0, "medium": 1.5, "low": 2.5}.get(quality, 1.5)
    dod_ci    = pred.get("dod_ci_factor", 1.0)
    cs_ci     = pred.get("cs_ci_factor",  1.0)
    half      = _CONFORMAL_90.get(chem, 60.0) * penalty * dod_ci * cs_ci
    rul       = pred.get("predicted_rul", 0.0)
    pred["lower_90"]          = round(max(0.0, rul - half), 1)
    pred["upper_90"]          = round(rul + half, 1)
    pred["confidence_width"]  = round(half * 2, 1)
    factors   = f"×{penalty}"
    if dod_ci > 1.0:
        factors += f"·dod×{dod_ci:.2f}"
    if cs_ci > 1.0:
        factors += f"·cs×{cs_ci:.2f}"
    pred["confidence_source"] = f"conformal-partial ({quality} quality, {factors})"

    # ── Attach partial-cycle metadata ─────────────────────────────────────────
    pred["partial_cycle"] = {
        "completeness":   completeness,
        "data_quality":   quality,
        "q_observed_ah":  result["q_observed_ah"],
        "q_estimated_ah": result["q_estimated_ah"],
        "feature_source": result["source"],
        "warnings":       result["warnings"],
    }

    # ── Analytics tracking ────────────────────────────────────────────────────
    try:
        from core.analytics import track_call
        auth = getattr(request.state, "auth", {})
        org  = auth.get("org", "") if auth.get("type") == "api_key" else ""
        track_call(
            chemistry=chem, model_id=req.model_id,
            rul=rul, phase=pred.get("phase", "Unknown"),
            source="partial_cycle", org=org,
        )
    except Exception:
        pass

    return pred


@router.get("/predict/demo")
def predict_demo() -> list[dict]:
    """SOH sweep demo using v10-final model."""
    from core.model_loader import run_inference
    results = []
    for soh in [0.95, 0.85, 0.75, 0.65, 0.50, 0.35]:
        r = run_inference("v10-final", {
            "chemistry": "LCO", "soh_pct": soh * 100, "cap_pct": soh,
            "capacity": 1.05 * soh, "int_resistance": 0.04 + (1 - soh) * 0.08,
        })
        results.append({**r, "soh_input": soh})
    return results


# ── Pack-level aggregation helpers ────────────────────────────────────────────

def _cell_predict(cell_dict: dict, model_id: str) -> dict:
    """Run full inference pipeline on one cell dict (DoD + cold-start + conformal)."""
    chem   = cell_dict.get("chemistry", "NMC")
    temp_c = float(cell_dict.get("temperature") or 25.0)
    if model_id == "analytical":
        return _analytical(cell_dict)
    try:
        from core.model_loader import run_inference
        r = run_inference(model_id, cell_dict)
        r = _add_conformal(r, chem, temp_c)
        extra_ci = r.get("dod_ci_factor", 1.0) * r.get("cs_ci_factor", 1.0)
        if extra_ci > 1.0:
            rul  = r["predicted_rul"]
            half = r["confidence_width"] / 2.0 * extra_ci
            r["lower_90"]         = round(max(0.0, rul - half), 1)
            r["upper_90"]         = round(rul + half, 1)
            r["confidence_width"] = round(half * 2, 1)
        return r
    except Exception:
        return _analytical(cell_dict)


def _aggregate_series(cell_results: list[dict]) -> dict:
    """Pack RUL = weakest cell. CI = CI of weakest cell (conservative)."""
    idx  = min(range(len(cell_results)), key=lambda i: cell_results[i]["predicted_rul"])
    weak = cell_results[idx]
    return {
        "predicted_rul":    weak["predicted_rul"],
        "lower_90":         weak.get("lower_90", weak.get("lower_bound", 0)),
        "upper_90":         weak.get("upper_90", weak.get("upper_bound", weak["predicted_rul"])),
        "confidence_width": weak.get("confidence_width", 0),
        "limiting_cell_idx": idx,
        "topology_note": "series — pack RUL = weakest cell",
    }


def _aggregate_parallel(cell_results: list[dict], caps: list[float]) -> dict:
    """Pack RUL = capacity-weighted mean. CI = weighted mean of CIs."""
    total = sum(caps) or len(caps)
    w     = [c / total for c in caps]
    rul   = sum(r["predicted_rul"] * wi for r, wi in zip(cell_results, w))
    lo    = sum(r.get("lower_90", r.get("lower_bound", 0)) * wi
                for r, wi in zip(cell_results, w))
    hi    = sum(r.get("upper_90", r.get("upper_bound", r["predicted_rul"])) * wi
                for r, wi in zip(cell_results, w))
    return {
        "predicted_rul":    round(rul, 1),
        "lower_90":         round(max(0.0, lo), 1),
        "upper_90":         round(hi, 1),
        "confidence_width": round(hi - lo, 1),
        "topology_note": "parallel — capacity-weighted mean RUL",
    }


@router.post("/predict/pack", response_model=None, dependencies=[Depends(require_auth)])
def predict_pack(req: PackPredictRequest, request: Request) -> dict:
    """
    Pack-level RUL prediction.

    Runs single-cell inference on every cell, then aggregates by topology:
    - series:          pack_rul = min cell_rul  (weakest-link)
    - parallel:        pack_rul = capacity-weighted mean
    - series_parallel: Ns series groups of Np parallel cells each
    """
    cells     = req.cells
    model_id  = req.model_id
    topology  = req.topology.lower()

    # ── Per-cell inference ────────────────────────────────────────────────────
    cell_dicts = [c.model_dump() for c in cells]
    cell_results = []
    for cd in cell_dicts:
        r = _cell_predict(cd, model_id)
        r["cell_id"] = cd.get("cell_id", f"cell_{len(cell_results)}")
        cell_results.append(r)

    caps = [float(cd.get("capacity") or cd.get("cap_pct", 0.9)) for cd in cell_dicts]

    # ── Pack aggregation ──────────────────────────────────────────────────────
    if topology == "parallel":
        pack = _aggregate_parallel(cell_results, caps)

    elif topology == "series_parallel":
        ns, np_ = req.ns, req.np
        n = len(cell_results)
        # Fill groups: Ns groups of Np cells
        groups = []
        for g in range(ns):
            grp = cell_results[g * np_ : (g + 1) * np_]
            if not grp:
                break
            grp_caps = caps[g * np_ : (g + 1) * np_]
            groups.append(_aggregate_parallel(grp, grp_caps) if np_ > 1 else grp[0])
        # Series across groups
        pack = _aggregate_series(groups)
        pack["topology_note"] = f"{ns}S{np_}P — {len(groups)} parallel groups in series"
        if "limiting_cell_idx" in pack:
            pack["limiting_group_idx"] = pack.pop("limiting_cell_idx")

    else:  # default: series
        pack = _aggregate_series(cell_results)

    # ── Summary stats ─────────────────────────────────────────────────────────
    ruls    = [r["predicted_rul"] for r in cell_results]
    soh_avg = round(sum(float(cd.get("cap_pct", 0.9)) for cd in cell_dicts) / len(cell_dicts) * 100, 1)
    phases  = [r.get("phase", "Unknown") for r in cell_results]
    worst_phase = max(phases, key=lambda p: ["Fresh","Aging","Knee","Near-EOL"].index(p)
                      if p in ["Fresh","Aging","Knee","Near-EOL"] else 0)

    # ── Assemble response ─────────────────────────────────────────────────────
    response = {
        "pack_rul":         pack["predicted_rul"],
        "pack_lower_90":    pack["lower_90"],
        "pack_upper_90":    pack["upper_90"],
        "pack_confidence_width": pack["confidence_width"],
        "pack_phase":       worst_phase,
        "pack_soh_avg":     soh_avg,
        "topology":         topology if topology != "series_parallel" else f"{req.ns}S{req.np}P",
        "topology_note":    pack.get("topology_note", ""),
        "n_cells":          len(cell_results),
        "rul_min":          round(min(ruls), 1),
        "rul_max":          round(max(ruls), 1),
        "rul_spread":       round(max(ruls) - min(ruls), 1),
        "cells":            cell_results,
        "model_id":         model_id,
    }
    if "limiting_cell_idx" in pack:
        idx = pack["limiting_cell_idx"]
        response["weakest_cell_id"]  = cell_results[idx].get("cell_id", f"cell_{idx}")
        response["weakest_cell_idx"] = idx
    if req.pack_name:
        response["pack_name"] = req.pack_name

    # ── Analytics ─────────────────────────────────────────────────────────────
    try:
        from core.analytics import track_call
        auth = getattr(request.state, "auth", {})
        org  = auth.get("org", "") if auth.get("type") == "api_key" else ""
        track_call(chemistry="PACK", model_id=model_id,
                   rul=pack["predicted_rul"], phase=worst_phase,
                   source="pack", org=org)
    except Exception:
        pass

    return response


@router.post("/predict/pack/partial", response_model=None, dependencies=[Depends(require_auth)])
def predict_pack_partial(req: PackPartialRequest, request: Request) -> dict:
    """
    Pack-level RUL prediction from raw per-cell BMS partial-cycle traces.

    Each cell supplies a V/I/t/T discharge window (not necessarily a full cycle).
    Features are reconstructed per cell, then aggregated by topology.
    CI is widened by data quality + DoD uncertainty + cold-start uncertainty.
    """
    import numpy as np
    from core.partial_cycle import extract_features_from_trace, _rolling_slope

    model_id = req.model_id
    cell_results = []

    for cell in req.cells:
        chem = cell.chemistry

        # ── Feature extraction from partial trace ─────────────────────────────
        fe = extract_features_from_trace(
            v=cell.voltage, i=cell.current, t=cell.time_s, T=cell.temperature,
            chemistry=chem,
            soc_start=cell.soc_start, soc_end=cell.soc_end,
            nom_capacity_ah=cell.nom_capacity_ah, charge_time_s=cell.charge_time_s,
        )
        feat9 = fe["features_9"]

        if cell.capacity_history and len(cell.capacity_history) >= 2:
            caps_arr = _rolling_slope(
                np.array(cell.capacity_history, dtype="float32"), window=5,
            )
            feat9[6] = float(caps_arr[-1])

        cap    = float(feat9[0])
        nom    = cell.nom_capacity_ah or max(cap, 1.0)
        req_cd = {
            "chemistry":      chem,
            "capacity":       cap,
            "cap_pct":        min(cap / nom, 1.0),
            "charge_time":    float(feat9[1]),
            "voltage_mean":   float(feat9[2]),
            "voltage_end":    float(feat9[3]),
            "energy":         float(feat9[4]),
            "temperature":    float(feat9[5]),
            "int_resistance": float(feat9[7]),
        }
        if cell.n_cycles is not None:
            req_cd["n_cycles"] = cell.n_cycles
        if cell.dod_pct is not None:
            req_cd["dod_pct"] = cell.dod_pct

        # ── Single-cell inference (DoD + cold-start applied inside) ───────────
        r = _cell_predict(req_cd, model_id)

        # ── Compound CI: partial quality × DoD × cold-start ──────────────────
        quality = fe["data_quality"]
        penalty = {"high": 1.0, "medium": 1.5, "low": 2.5}.get(quality, 1.5)
        dod_ci  = r.get("dod_ci_factor", 1.0)
        cs_ci   = r.get("cs_ci_factor",  1.0)
        half    = _CONFORMAL_90.get(chem, 60.0) * penalty * dod_ci * cs_ci
        rul     = r.get("predicted_rul", 0.0)
        r["lower_90"]          = round(max(0.0, rul - half), 1)
        r["upper_90"]          = round(rul + half, 1)
        r["confidence_width"]  = round(half * 2, 1)
        r["confidence_source"] = f"conformal-partial-pack ({quality}, ×{penalty:.1f})"
        r["partial_cycle"]     = {
            "completeness": fe["completeness"],
            "data_quality": quality,
            "warnings":     fe["warnings"],
        }
        r["cell_id"] = cell.cell_id
        cell_results.append(r)

    # ── Pack aggregation (same as /predict/pack) ──────────────────────────────
    caps     = [float(c.nom_capacity_ah or 1.0) for c in req.cells]
    topology = req.topology.lower()

    if topology == "parallel":
        pack = _aggregate_parallel(cell_results, caps)
    elif topology == "series_parallel":
        ns, np_ = req.ns, req.np
        groups  = []
        for g in range(ns):
            grp      = cell_results[g * np_ : (g + 1) * np_]
            grp_caps = caps[g * np_ : (g + 1) * np_]
            if not grp:
                break
            groups.append(_aggregate_parallel(grp, grp_caps) if np_ > 1 else grp[0])
        pack = _aggregate_series(groups)
        pack["topology_note"] = f"{ns}S{np_}P — partial-pack inference"
        if "limiting_cell_idx" in pack:
            pack["limiting_group_idx"] = pack.pop("limiting_cell_idx")
    else:
        pack = _aggregate_series(cell_results)

    ruls        = [r["predicted_rul"] for r in cell_results]
    soh_avg     = round(sum(r.get("health_score", 90.0) for r in cell_results) / len(cell_results), 1)
    phases      = [r.get("phase", "Unknown") for r in cell_results]
    worst_phase = max(phases, key=lambda p: ["Fresh","Aging","Knee","Near-EOL"].index(p)
                      if p in ["Fresh","Aging","Knee","Near-EOL"] else 0)

    response = {
        "pack_rul":              pack["predicted_rul"],
        "pack_lower_90":         pack["lower_90"],
        "pack_upper_90":         pack["upper_90"],
        "pack_confidence_width": pack["confidence_width"],
        "pack_phase":            worst_phase,
        "pack_soh_avg":          soh_avg,
        "topology":              topology if topology != "series_parallel" else f"{req.ns}S{req.np}P",
        "topology_note":         pack.get("topology_note", ""),
        "n_cells":               len(cell_results),
        "rul_min":               round(min(ruls), 1),
        "rul_max":               round(max(ruls), 1),
        "rul_spread":            round(max(ruls) - min(ruls), 1),
        "cells":                 cell_results,
        "model_id":              model_id,
        "mode":                  "partial_pack",
    }
    if "limiting_cell_idx" in pack:
        idx = pack["limiting_cell_idx"]
        response["weakest_cell_id"]  = cell_results[idx].get("cell_id", f"cell_{idx}")
        response["weakest_cell_idx"] = idx
    if req.pack_name:
        response["pack_name"] = req.pack_name

    try:
        from core.analytics import track_call
        auth = getattr(request.state, "auth", {})
        org  = auth.get("org", "") if auth.get("type") == "api_key" else ""
        track_call(chemistry="PACK", model_id=model_id,
                   rul=pack["predicted_rul"], phase=worst_phase,
                   source="partial_pack", org=org)
    except Exception:
        pass

    return response


@router.post("/predict/calibrate/dod-k", dependencies=[Depends(require_auth)])
def calibrate_dod_k(req: DodCalibrationRequest) -> dict:
    """
    Fit the DoD cycle-life exponent k from user-measured (DoD%, RUL) pairs.

    Model: RUL(dod) = RUL(100%) × (100/dod)^k
    Fit via OLS in log-space: log(rul_mult) = k × log(100/dod)

    Returns the fitted k, 90% CI, and comparison to the literature prior.
    Use the fitted k to override the default DoD model for your cell chemistry
    by passing it back in future requests (not yet a persistent override — treat
    as a diagnostic tool).
    """
    import numpy as np
    from fastapi import HTTPException

    chem = req.chemistry.upper()
    dods, mults = [], []
    for obs in req.observations:
        dod = float(obs.dod_pct)
        if obs.rul_multiplier is not None:
            mult = float(obs.rul_multiplier)
        elif obs.rul_at_100pct and obs.observed_rul:
            mult = float(obs.observed_rul) / float(obs.rul_at_100pct)
        else:
            continue
        if mult <= 0:
            continue
        dods.append(dod)
        mults.append(mult)

    n = len(dods)
    if n < 2:
        raise HTTPException(status_code=422,
            detail="Need at least 2 valid observations (dod_pct + rul_multiplier or rul_at_100pct+observed_rul).")

    log_x = np.array([np.log(100.0 / d) for d in dods])
    log_y = np.array([np.log(m)         for m in mults])

    # OLS through origin: k = Σ(x·y) / Σ(x²)
    k_fit  = float(np.dot(log_x, log_y) / np.dot(log_x, log_x))
    resid  = log_y - k_fit * log_x
    if n > 2:
        se    = float(np.std(resid, ddof=1) / np.sqrt(float(np.dot(log_x, log_x))))
        k_lo  = k_fit - 1.645 * se
        k_hi  = k_fit + 1.645 * se
    else:
        se = None
        k_lo = k_hi = k_fit

    from core.model_loader import _DOD_K, _DOD_K_SIGMA
    prior_k     = _DOD_K.get(chem, 1.5)
    prior_sigma = _DOD_K_SIGMA.get(chem, 0.25)

    return {
        "chemistry":   chem,
        "k_fitted":    round(k_fit, 4),
        "k_lower_90":  round(k_lo, 4),
        "k_upper_90":  round(k_hi, 4),
        "se":          round(se, 4) if se is not None else None,
        "n":           n,
        "k_prior":     prior_k,
        "k_prior_sigma": prior_sigma,
        "deviation_from_prior": round(k_fit - prior_k, 4),
        "observations": [{"dod_pct": d, "rul_multiplier": round(m, 4)}
                         for d, m in zip(dods, mults)],
        "note": (
            f"Fitted k={k_fit:.3f} vs literature prior k={prior_k} for {chem}. "
            f"{'Agreement within 1σ.' if abs(k_fit - prior_k) < prior_sigma else 'Consider retraining with DoD-varied data.'}"
        ),
    }

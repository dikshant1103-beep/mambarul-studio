"""
routers/phase_c.py — Phase C research dashboard endpoints.

  POST /api/phase-c/spectral/features    compute the 21×2-channel spectral
                                         vector from a 30-cycle window.
  GET  /api/phase-c/spectral/status      module status (PyWavelets present? etc).
  POST /api/phase-c/cache/synthetic      launch the DFN+crack synthetic cache
                                         (background, admin-only).
  POST /api/phase-c/cache/real           launch the PyBaMM-on-real-cells label
                                         cache (background, admin-only).
  GET  /api/phase-c/cache/status         current background job state + log tail.
  GET  /api/phase-c/validation/latest    latest val_report.json with per-condition
                                         block, if a training run has produced one.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from core.middleware import require_auth, require_admin

logger = logging.getLogger(__name__)
router = APIRouter()


_REPO = Path(__file__).resolve().parent.parent.parent
_PROCESSED = _REPO / "processed" / "internal_state_head"


# ───────────────────────── Spectral / wavelet endpoints ──────────────────────

class SpectralRequest(BaseModel):
    window:      list[list[float]] = Field(..., description="(T, F) per-cycle window")
    voltage_col: int   = 2
    current_col: int   = 6
    fs:          float = 1.0


@router.post("/phase-c/spectral/features", dependencies=[Depends(require_auth)])
def spectral_features(req: SpectralRequest):
    from core.spectral_features import (
        features_from_window, compute_spectral_features, N_FEATURES_PER_CHANNEL,
    )
    arr = np.asarray(req.window, dtype=np.float32)
    if arr.ndim != 2 or arr.shape[0] < 4:
        raise HTTPException(status_code=422,
                            detail="window must be 2D with ≥4 time steps")
    vec = features_from_window(arr, voltage_col=req.voltage_col,
                               current_col=req.current_col, fs=req.fs)
    v_struct = compute_spectral_features(arr[:, req.voltage_col]
                                          if req.voltage_col < arr.shape[1]
                                          else np.zeros(arr.shape[0]), fs=req.fs)
    i_struct = compute_spectral_features(arr[:, req.current_col]
                                          if req.current_col < arr.shape[1]
                                          else np.zeros(arr.shape[0]), fs=req.fs)
    return {
        "n_features_per_channel": N_FEATURES_PER_CHANNEL,
        "concat_vector":          vec.tolist(),
        "voltage": {
            "moments":          v_struct.moments,
            "spectral_summary": v_struct.spectral_summary,
            "top_peaks":        v_struct.top_peaks,
            "band_energies":    v_struct.band_energies,
        },
        "current": {
            "moments":          i_struct.moments,
            "spectral_summary": i_struct.spectral_summary,
            "top_peaks":        i_struct.top_peaks,
            "band_energies":    i_struct.band_energies,
        },
    }


@router.get("/phase-c/spectral/status", dependencies=[Depends(require_auth)])
def spectral_status():
    from core.spectral_features import status
    return status()


# ──────────────────────────── Cache-job endpoints ─────────────────────────────

class SyntheticCacheRequest(BaseModel):
    chemistries: list[str]   = ["LFP", "NMC", "NCA", "LCO"]
    c_rates:     list[float] = [0.5, 1.0, 1.5]
    temps:       list[float] = [15.0, 25.0, 35.0]
    n_cycles:    int         = 200
    model_mode:  str         = "dfn_electrolyte_crack"


@router.post("/phase-c/cache/synthetic", dependencies=[Depends(require_admin)])
def cache_synthetic(req: SyntheticCacheRequest):
    from core.phase_c_jobs import start_synthetic_cache
    res = start_synthetic_cache(
        chemistries=req.chemistries, c_rates=req.c_rates,
        temps=req.temps, n_cycles=req.n_cycles, model_mode=req.model_mode,
    )
    if "error" in res:
        raise HTTPException(status_code=409, detail=res)
    return res


class RealLabelCacheRequest(BaseModel):
    max_cells:     int  = 120
    chemistry:     str | None = None
    n_cycles:      int  = 200
    model_mode:    str  = "dfn_electrolyte_crack"
    skip_existing: bool = True


@router.post("/phase-c/cache/real", dependencies=[Depends(require_admin)])
def cache_real(req: RealLabelCacheRequest):
    from core.phase_c_jobs import start_real_label_cache
    res = start_real_label_cache(
        max_cells=req.max_cells, chemistry=req.chemistry,
        n_cycles=req.n_cycles, model_mode=req.model_mode,
        skip_existing=req.skip_existing,
    )
    if "error" in res:
        raise HTTPException(status_code=409, detail=res)
    return res


@router.get("/phase-c/cache/status", dependencies=[Depends(require_auth)])
def cache_status():
    from core.phase_c_jobs import get_status
    return get_status()


class TwoStageTrainRequest(BaseModel):
    stage1_epochs: int   = 100
    stage2_epochs: int   = 60
    lr:            float = 3e-3
    val_frac:      float = 0.25
    no_pretrain:   bool  = False
    prefer_source: str | None = None
    out_subdir:    str | None = None


@router.post("/phase-c/train/two-stage", dependencies=[Depends(require_admin)])
def train_two_stage(req: TwoStageTrainRequest):
    from core.phase_c_jobs import start_two_stage_training
    res = start_two_stage_training(
        stage1_epochs=req.stage1_epochs, stage2_epochs=req.stage2_epochs,
        lr=req.lr, val_frac=req.val_frac, no_pretrain=req.no_pretrain,
        prefer_source=req.prefer_source, out_subdir=req.out_subdir,
    )
    if "error" in res:
        raise HTTPException(status_code=409, detail=res)
    return res


# ───────────────────────────── Validation viewer ──────────────────────────────

def _find_latest_val_report() -> Path | None:
    if not _PROCESSED.exists():
        return None
    candidates = list(_PROCESSED.rglob("val_report.json"))
    if not candidates:
        return None
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0]


@router.get("/phase-c/validation/latest", dependencies=[Depends(require_auth)])
def validation_latest():
    p = _find_latest_val_report()
    if p is None:
        return {"available": False,
                "hint": "Train the head: python scripts/train_internal_state_head.py --real"}
    try:
        report = json.loads(p.read_text())
    except Exception as exc:
        raise HTTPException(status_code=500,
                            detail=f"failed to read val report: {exc}")
    return {"available":  True,
            "path":       str(p),
            "modified_at": p.stat().st_mtime,
            "report":     report}

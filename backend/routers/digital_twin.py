"""
routers/digital_twin.py — Physics-based Digital Twin API.

POST /api/twin/fit/{cell_id}            fit analytical twin + return forecast + CI
GET  /api/twin/simulate/{job_id}        poll async PyBaMM what-if result
POST /api/twin/simulate                 run PyBaMM what-if (background, returns job_id)
GET  /api/twin/cells                    list cells available for fitting
GET  /api/twin/presets                  predefined what-if scenario presets
GET  /api/twin/summary                  fleet-level twin statistics (cached)
POST /api/twin/calendar/{cell_id}       calendar aging estimate for a cell
POST /api/twin/validate/{cell_id}       parameter validation vs literature
"""
from __future__ import annotations
import logging
import time
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()

_sim_jobs: dict[str, dict] = {}

# Fleet summary cache (invalidated after 10 min)
_fleet_cache: dict = {}
_fleet_cache_ts: float = 0.0
_FLEET_TTL = 600


class WhatIfRequest(BaseModel):
    n_cycles:    int   = Field(100, ge=10, le=300)
    c_rate_dis:  float = Field(1.0,  ge=0.1, le=5.0)
    c_rate_chg:  float = Field(0.5,  ge=0.1, le=3.0)
    temperature: float = Field(25.0, ge=-10, le=60)
    soc_max:     float = Field(1.0,  ge=0.5, le=1.0)
    Q0_scale:    float = Field(1.0,  ge=0.1, le=3.0)
    chemistry:   str   = "NMC"
    label:       str   = "custom"


class CalendarRequest(BaseModel):
    months:           int   = Field(24, ge=1, le=120)
    temperature_c:    float = Field(25.0, ge=-20, le=60)
    cycles_per_month: float = Field(30.0, ge=1, le=300)


# ── Fit twin ──────────────────────────────────────────────────────────────────

@router.post("/twin/fit/{cell_id}", summary="Fit analytical digital twin to a cell")
def fit_twin(cell_id: str):
    """
    Fit semi-empirical SEI+crack model to the cell's observed capacity curve.
    Returns: params, R², MAPE, 95% CI on params, 300-cycle forecast with 90% CI band,
    hold-out validation, calendar aging, parameter validation vs literature.
    """
    from core.digital_twin import build_twin
    result = build_twin(cell_id)
    if "error" in result:
        raise HTTPException(404, result["error"])
    return result


# ── PyBaMM what-if ────────────────────────────────────────────────────────────

@router.post("/twin/simulate", summary="Run chemistry-aware PyBaMM what-if (async)")
def simulate_whatif(req: WhatIfRequest, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())[:8]
    _sim_jobs[job_id] = {
        "status":  "running",
        "label":   req.label,
        "started": time.time(),
        "params":  req.model_dump(),
    }

    def _run():
        from core.digital_twin import run_pybamm_simulation
        result = run_pybamm_simulation(
            n_cycles    = req.n_cycles,
            c_rate_dis  = req.c_rate_dis,
            c_rate_chg  = req.c_rate_chg,
            temperature = req.temperature,
            soc_max     = req.soc_max,
            Q0_scale    = req.Q0_scale,
            chemistry   = req.chemistry,
        )
        elapsed = round(time.time() - _sim_jobs[job_id]["started"], 2)
        _sim_jobs[job_id].update({
            "status":  "done" if result.get("ok") else "failed",
            "result":  result,
            "elapsed": elapsed,
        })

    background_tasks.add_task(_run)
    return {"job_id": job_id, "status": "running"}


@router.get("/twin/simulate/{job_id}", summary="Poll what-if simulation result")
def get_sim_result(job_id: str):
    job = _sim_jobs.get(job_id)
    if not job:
        raise HTTPException(404, f"Job '{job_id}' not found")
    return job


# ── Calendar aging ────────────────────────────────────────────────────────────

@router.post("/twin/calendar/{cell_id}", summary="Calendar aging estimate for a cell")
def calendar_aging(cell_id: str, req: CalendarRequest):
    """Fit twin then compute calendar vs cycle aging over req.months months."""
    from core.digital_twin import build_twin, estimate_calendar_aging
    twin = build_twin(cell_id)
    if "error" in twin:
        raise HTTPException(404, twin["error"])
    result = estimate_calendar_aging(
        twin["fit"]["params"],
        months           = req.months,
        temperature_c    = req.temperature_c,
        cycles_per_month = req.cycles_per_month,
    )
    result["cell_id"]   = cell_id
    result["chemistry"] = twin["chemistry"]
    result["param_set"] = twin["pybamm_param_set"]
    return result


# ── Internal-state vector (Phase C foundation) ────────────────────────────────

_HEAD_CKPT = Path(__file__).parent.parent.parent.parent / \
    "processed" / "internal_state_head" / "stage2" / "checkpoint_head.pt"


def _run_phase_c_head(cell_id: str) -> dict:
    """Run the trained Phase C ML head (Run G) for a cell.
    Returns the 13-key internal-state dict de-scaled to physical units,
    tagged source='ml_head'. Falls back gracefully if checkpoint missing."""
    import torch
    import numpy as np
    from pathlib import Path as _Path
    from core.model_loader import _MODELS, _normalize, load_all_models
    from core.internal_states import INTERNAL_STATE_KEYS
    from core.bimamba_apf import BiMambaAPF, InternalStateHead, attach_internal_state_head
    import core.data_loader as dl

    if not _HEAD_CKPT.exists():
        return {"error": f"head checkpoint not found: {_HEAD_CKPT}"}

    load_all_models()
    if dl._meta_df is None:
        dl.load_dataset()

    # Build the cell's 30-cycle window (same as training pipeline)
    mask = dl._meta_df["cell_id"].values == cell_id
    if not mask.any():
        return {"error": f"cell {cell_id!r} not in dataset"}
    idx = np.where(mask)[0]
    order = dl._meta_df.iloc[idx].sort_values("cycle").index.values
    if len(order) < 5:
        return {"error": "need ≥5 cycles"}
    last30 = order[-min(30, len(order)):]
    window_raw = dl._features[last30, :9].astype(np.float32)
    entry = _MODELS.get("v12-bimamba")
    if entry is None:
        return {"error": "v12-bimamba not loaded"}
    x = _normalize(window_raw.copy(), entry["feat_mean"], entry["feat_std"])
    X = torch.tensor(x).unsqueeze(0)   # (1, 30, 13)

    # Load checkpoint and rebuild head
    ck = torch.load(str(_HEAD_CKPT), map_location="cpu", weights_only=False)
    d_spectral = ck.get("d_spectral", 0)
    backbone = BiMambaAPF()
    backbone.load_state_dict(entry["model"].state_dict(), strict=False)
    head = InternalStateHead(d_model=backbone.d_model, d_spectral=d_spectral)
    head.load_state_dict(ck["head_state_dict"], strict=False)
    backbone.eval(); head.eval()

    with torch.no_grad():
        h = backbone.forward_features(X)
        if d_spectral > 0:
            from core.spectral_features import features_from_window
            spec = torch.tensor(features_from_window(window_raw)).unsqueeze(0)
            h = torch.cat([h, spec], dim=-1)
        pred_scaled = head(h)[0].numpy()   # (13,)

    # De-scale using per-chemistry scalers from checkpoint
    chem_code = int(dl._meta_df.iloc[order[-1]]["chemistry_code"])
    chem_scalers = ck.get("chem_scalers", {})
    scaler = chem_scalers.get(chem_code) or chem_scalers.get(str(chem_code), {})
    y_min = np.array(scaler.get("y_min", [0.0] * 13), dtype=np.float32)
    y_max = np.array(scaler.get("y_max", [1.0] * 13), dtype=np.float32)
    y_rng = np.maximum(y_max - y_min, 1e-6)
    pred_phys = pred_scaled * y_rng + y_min

    keys = list(ck.get("label_keys") or INTERNAL_STATE_KEYS)
    result = {k: round(float(pred_phys[i]), 6) for i, k in enumerate(keys)}
    result["source"] = "ml_head"
    result["checkpoint"] = str(_HEAD_CKPT)
    return result


@router.get("/twin/internal-states/{cell_id}",
            summary="Reverse-estimated internal electrochemical state vector for one cell")
def get_internal_state_vector(cell_id: str, persist: bool = True,
                               source: str = "twin"):
    """Return the internal electrochemical state for a cell.

    source=twin (default): fit the digital twin (PyBaMM SPM+SEI, ~30s, high accuracy)
    source=head:           run the Phase C ML head (Run G, ~1ms, no PyBaMM needed)

    Both return the same 13-key schema. The twin path is slower but gives exact
    PyBaMM-fit values; the head path is instant and uses the trained BiMamba head.
    """
    if source == "head":
        states = _run_phase_c_head(cell_id)
        if "error" in states:
            raise HTTPException(404 if "not found" in states["error"] else 500,
                                states["error"])
        return {"cell_id": cell_id, "source": "ml_head", "states": states}

    # Default: digital twin PyBaMM fit
    from core.digital_twin import build_twin
    from core.internal_states import extract_internal_states
    from core.db import store_internal_states
    twin = build_twin(cell_id)
    if "error" in twin:
        raise HTTPException(404, twin["error"])
    states = extract_internal_states(twin)
    if "error" in states:
        raise HTTPException(500, states["error"])
    if persist:
        try:
            ts = store_internal_states(cell_id, states,
                                       chemistry=twin.get("chemistry", ""),
                                       source="twin")
            states["extracted_at"] = ts
        except Exception as exc:
            logger.warning("internal-state persist failed for %s: %s", cell_id, exc)
    return {
        "cell_id":   cell_id,
        "chemistry": twin.get("chemistry"),
        "source":    "twin",
        "states":    states,
    }


@router.get("/twin/internal-states",
            summary="List recent internal-state extractions across the fleet")
def list_internal_state_vectors(limit: int = 200, chemistry: str | None = None):
    from core.db import list_internal_states
    rows = list_internal_states(limit=limit, chemistry=chemistry)
    return {"n": len(rows), "rows": rows}


# ── Parameter validation ──────────────────────────────────────────────────────

@router.get("/twin/validate/{cell_id}", summary="Validate fitted parameters vs literature")
def validate_twin_params(cell_id: str):
    """Fit twin and check if k_SEI, k_crack, alpha are physically plausible."""
    from core.digital_twin import build_twin
    twin = build_twin(cell_id)
    if "error" in twin:
        raise HTTPException(404, twin["error"])
    return {
        "cell_id":          cell_id,
        "chemistry":        twin["chemistry"],
        "params":           twin["fit"]["params"],
        "param_ci":         twin["fit"].get("param_ci", {}),
        "validation":       twin["param_validation"],
        "holdout":          twin["holdout"],
        "degradation_split": twin["fit"].get("degradation_split", {}),
    }


# ── Fleet summary ─────────────────────────────────────────────────────────────

@router.get("/twin/summary", summary="Fleet-level digital twin statistics")
def get_fleet_summary(refresh: bool = Query(False)):
    global _fleet_cache, _fleet_cache_ts
    if not refresh and _fleet_cache and (time.time() - _fleet_cache_ts) < _FLEET_TTL:
        return _fleet_cache
    from core.digital_twin import fleet_twin_summary
    result = fleet_twin_summary(max_cells=30)
    _fleet_cache    = result
    _fleet_cache_ts = time.time()
    return result


# ── Cell list ─────────────────────────────────────────────────────────────────

@router.get("/twin/cells", summary="List cells available for digital twin fitting")
def list_twin_cells():
    import core.data_loader as dl
    if dl._meta_df is None:
        dl.load_dataset()
    if dl._meta_df is None:
        return []
    cells = []
    for cell_id, grp in dl._meta_df.groupby("cell_id"):
        cells.append({
            "cell_id":   str(cell_id),
            "dataset":   str(grp["dataset"].iloc[0]),
            "chemistry": str(grp["chemistry_name"].iloc[0]),
            "n_cycles":  int(len(grp)),
        })
    return sorted(cells, key=lambda c: -c["n_cycles"])[:100]


# ── Presets ───────────────────────────────────────────────────────────────────

@router.get("/twin/presets", summary="Predefined what-if scenario presets")
def get_presets():
    return [
        {"label": "Baseline (1C/0.5C, 25°C, NMC)",
         "n_cycles": 100, "c_rate_dis": 1.0, "c_rate_chg": 0.5,
         "temperature": 25, "soc_max": 1.0, "Q0_scale": 1.0, "chemistry": "NMC"},
        {"label": "High temperature (45°C)",
         "n_cycles": 100, "c_rate_dis": 1.0, "c_rate_chg": 0.5,
         "temperature": 45, "soc_max": 1.0, "Q0_scale": 1.0, "chemistry": "NMC"},
        {"label": "Fast charge (2C)",
         "n_cycles": 100, "c_rate_dis": 1.0, "c_rate_chg": 2.0,
         "temperature": 25, "soc_max": 1.0, "Q0_scale": 1.0, "chemistry": "NMC"},
        {"label": "Conservative (80% SOC limit)",
         "n_cycles": 100, "c_rate_dis": 1.0, "c_rate_chg": 0.5,
         "temperature": 25, "soc_max": 0.80, "Q0_scale": 1.0, "chemistry": "NMC"},
        {"label": "Cold weather (5°C)",
         "n_cycles": 100, "c_rate_dis": 0.5, "c_rate_chg": 0.3,
         "temperature": 5, "soc_max": 1.0, "Q0_scale": 1.0, "chemistry": "NMC"},
        {"label": "LFP — standard (1C/0.5C, 25°C)",
         "n_cycles": 100, "c_rate_dis": 1.0, "c_rate_chg": 0.5,
         "temperature": 25, "soc_max": 1.0, "Q0_scale": 1.0, "chemistry": "LFP"},
        {"label": "LFP — high temperature (45°C)",
         "n_cycles": 100, "c_rate_dis": 1.0, "c_rate_chg": 0.5,
         "temperature": 45, "soc_max": 1.0, "Q0_scale": 1.0, "chemistry": "LFP"},
    ]

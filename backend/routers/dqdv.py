"""
routers/dqdv.py — dQ/dV Incremental Capacity Analysis API.

GET  /api/dqdv/cell/{cell_id}         IC curves for multiple sampled cycles
GET  /api/dqdv/cell/{cell_id}/peaks   peak trend data over cycle life
GET  /api/dqdv/cells                  list cells with real dQ/dV data
POST /api/dqdv/synthetic              generate IC curve for arbitrary SOH/chemistry
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()


class SyntheticRequest(BaseModel):
    soh:       float = Field(0.80, ge=0.1, le=1.0)
    chemistry: str   = "NMC"
    ir:        float = Field(0.0, ge=0.0)
    n_points:  int   = Field(200, ge=50, le=500)


@router.get("/dqdv/cells", summary="List cells with real dQ/dV data")
def list_dqdv_cells():
    try:
        from core.dqdv_extractor import _load_mit_data
        _, _, meta = _load_mit_data()
        cells = meta["cell_id"].unique().tolist()
        return {"source": "mit_dqdv_features", "n_cells": len(cells), "cells": cells[:50]}
    except Exception as exc:
        return {"source": "none", "n_cells": 0, "cells": [], "error": str(exc)}


@router.get("/dqdv/cell/{cell_id}", summary="IC curves for a cell (sampled cycles)")
def get_cell_ic(
    cell_id: str,
    n_samples: int = Query(8, ge=2, le=20),
    chemistry: str = Query("LFP"),
):
    from core.dqdv_extractor import get_cell_ic_series
    result = get_cell_ic_series(cell_id, n_samples=n_samples, chemistry=chemistry)
    if "error" in result:
        raise HTTPException(404, result["error"])
    return result


@router.get("/dqdv/cell/{cell_id}/peaks", summary="Peak trends over cycle life")
def get_peak_trends(cell_id: str, chemistry: str = Query("LFP")):
    from core.dqdv_extractor import get_cell_ic_series
    result = get_cell_ic_series(cell_id, n_samples=200, chemistry=chemistry)
    if "error" in result:
        raise HTTPException(404, result["error"])
    return {
        "cell_id":           result["cell_id"],
        "chemistry":         result["chemistry"],
        "source":            result.get("source", "synthetic"),
        "peak_trends":       result.get("peak_trends", {}),
        "degradation_modes": result.get("degradation_modes", {}),
    }


@router.post("/dqdv/synthetic", summary="Generate IC curve for arbitrary SOH/chemistry")
def generate_synthetic(req: SyntheticRequest):
    from core.dqdv_extractor import generate_ic_curve
    V, dQdV = generate_ic_curve(req.soh, req.chemistry, req.ir, req.n_points)
    return {
        "soh":       req.soh,
        "chemistry": req.chemistry.upper(),
        "voltage":   [round(v, 4) for v in V],
        "dqdv":      [round(v, 4) for v in dQdV],
    }

"""
routers/warranty.py — Warranty intelligence endpoints.

POST /api/warranty/assess          single cell → claim probability + expected cost
POST /api/warranty/assess/fleet    list of cells → per-cell + fleet reserve

auto_predict=True (default): run the ML model on each cell's features to obtain
RUL + conformal CI, then assess against the warranty terms. auto_predict=False:
use the predicted_rul / rul_lower / rul_upper supplied in the request.
"""
from __future__ import annotations

import logging
from typing import Optional, List

from fastapi import APIRouter
from pydantic import BaseModel, Field

from core.warranty import assess_warranty, assess_fleet

logger = logging.getLogger(__name__)
router = APIRouter()


class WarrantyTerms(BaseModel):
    warranty_cycles:        float = Field(1000.0, ge=0)
    warranty_years:         float = Field(8.0,    ge=0)
    cycles_per_year:        float = Field(250.0,  gt=0)
    warranty_soh_threshold: float = Field(0.80,   ge=0.5, le=0.95)
    unit_cost:              float = Field(120.0,  ge=0)


class WarrantyCell(BaseModel):
    cell_id:        str   = "cell"
    soh:            float = Field(0.90, ge=0.0, le=1.0)
    chemistry:      str   = "NMC"
    n_cycles:       float = Field(0.0, ge=0)
    int_resistance: Optional[float] = None
    temperature:    Optional[float] = None
    capacity_ah:    Optional[float] = None
    dod_pct:        Optional[float] = None
    fade_rate:      Optional[float] = None
    # If auto_predict is False these are used directly:
    predicted_rul:  Optional[float] = None
    rul_lower:      Optional[float] = None
    rul_upper:      Optional[float] = None


class WarrantyRequest(BaseModel):
    cell:         WarrantyCell
    terms:        WarrantyTerms = WarrantyTerms()
    auto_predict: bool = True
    model_id:     str  = "v12-bimamba"


class WarrantyFleetRequest(BaseModel):
    cells:        List[WarrantyCell]
    terms:        WarrantyTerms = WarrantyTerms()
    auto_predict: bool = True
    model_id:     str  = "v12-bimamba"
    notify:       bool = False   # dispatch alerts for likely-claim cells


def _predict_rul(cell: WarrantyCell, model_id: str) -> tuple[float, float | None, float | None]:
    """Return (predicted_rul, rul_lower, rul_upper) from the ML model."""
    from core.model_loader import run_inference
    feats: dict = {
        "chemistry": cell.chemistry,
        "soh_pct":   round(cell.soh * 100, 2),
        "cap_pct":   cell.soh,
    }
    if cell.capacity_ah    is not None: feats["capacity"]       = cell.capacity_ah
    if cell.int_resistance is not None: feats["int_resistance"] = cell.int_resistance
    if cell.temperature    is not None: feats["temperature"]    = cell.temperature
    if cell.dod_pct        is not None: feats["dod_pct"]        = cell.dod_pct
    if cell.n_cycles:                   feats["n_cycles"]       = int(cell.n_cycles)
    pred = run_inference(model_id, feats)
    return (
        float(pred.get("predicted_rul", cell.predicted_rul or 300.0)),
        pred.get("lower_bound"),
        pred.get("upper_bound"),
    )


def _resolve_rul(cell: WarrantyCell, auto_predict: bool, model_id: str):
    if auto_predict:
        return _predict_rul(cell, model_id)
    return (
        float(cell.predicted_rul if cell.predicted_rul is not None else 300.0),
        cell.rul_lower, cell.rul_upper,
    )


@router.post("/warranty/assess", summary="Assess one cell against its warranty terms")
def assess_one(req: WarrantyRequest) -> dict:
    rul, lo, hi = _resolve_rul(req.cell, req.auto_predict, req.model_id)
    t = req.terms
    result = assess_warranty(
        soh=req.cell.soh, predicted_rul=rul, n_cycles=req.cell.n_cycles,
        warranty_cycles=t.warranty_cycles, warranty_years=t.warranty_years,
        cycles_per_year=t.cycles_per_year, warranty_soh_threshold=t.warranty_soh_threshold,
        rul_lower=lo, rul_upper=hi, fade_rate=req.cell.fade_rate,
        unit_cost=t.unit_cost, label=req.cell.cell_id,
    )
    result["rul_source"] = "ml" if req.auto_predict else "manual"
    result["model_used"] = req.model_id if req.auto_predict else None
    return result


@router.post("/warranty/assess/fleet", summary="Assess a fleet and aggregate warranty exposure")
def assess_fleet_endpoint(req: WarrantyFleetRequest) -> dict:
    t = req.terms
    cell_dicts = []
    for c in req.cells:
        rul, lo, hi = _resolve_rul(c, req.auto_predict, req.model_id)
        cell_dicts.append({
            "label": c.cell_id, "soh": c.soh, "predicted_rul": rul,
            "n_cycles": c.n_cycles, "rul_lower": lo, "rul_upper": hi,
            "fade_rate": c.fade_rate,
        })
    result = assess_fleet(
        cell_dicts,
        warranty_cycles=t.warranty_cycles, warranty_years=t.warranty_years,
        cycles_per_year=t.cycles_per_year, warranty_soh_threshold=t.warranty_soh_threshold,
        unit_cost=t.unit_cost,
    )
    result["rul_source"] = "ml" if req.auto_predict else "manual"
    result["model_used"] = req.model_id if req.auto_predict else None

    # Optional: alert on cells likely to file a warranty claim
    if req.notify:
        likely = [{"label": c["label"], "chem": "?", "soh": c["soh_pct"],
                   "rul": c["predicted_rul"], "phase": "Warranty risk"}
                  for c in result["per_cell"] if c["status"] == "likely_claim"]
        if likely:
            from core.notifications import dispatch_alerts
            result["notification"] = dispatch_alerts(likely, reason="warranty_risk", dry_run=True)

    return result

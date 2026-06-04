"""
routers/second_life.py — Second-life battery assessment API.

POST /api/second-life/assess          single cell
POST /api/second-life/assess/pack     multi-cell pack
POST /api/second-life/assess/fleet    batch over entire loaded fleet
GET  /api/second-life/history         past assessments (DB-stored)
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from core.second_life import assess_cell, assess_pack

logger = logging.getLogger(__name__)
router = APIRouter()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Request models ────────────────────────────────────────────────────────────

class CellInput(BaseModel):
    cell_id:            str   = "cell"
    soh:                float = Field(..., ge=0, le=1, description="0–1")
    rul_cycles:         float = Field(..., ge=0)
    chemistry:          str   = "NMC"
    ir:                 float = Field(0.0, ge=0, description="Internal resistance (Ω)")
    cycles:             int   = Field(0,   ge=0)
    capacity_ah:        float = Field(0.0, ge=0)
    voltage_v:          float = Field(3.6, ge=2.0, le=5.0)
    capacity_fade_rate: float = Field(0.0, ge=0, description="% SOH per 100 cycles")

class PackInput(BaseModel):
    pack_id: str = "pack"
    cells:   list[CellInput]

class FleetAssessRequest(BaseModel):
    model_id: str = "v10-final"


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/second-life/assess", summary="Assess single cell for second life")
def assess_single(req: CellInput):
    result = assess_cell(
        soh=req.soh,
        rul_cycles=req.rul_cycles,
        chemistry=req.chemistry,
        ir=req.ir,
        cycles=req.cycles,
        capacity_ah=req.capacity_ah,
        voltage_v=req.voltage_v,
        cell_id=req.cell_id,
        capacity_fade_rate=req.capacity_fade_rate,
    )
    _store_assessment(req.cell_id, result)
    return result


@router.post("/second-life/assess/pack", summary="Assess a pack for second life")
def assess_pack_endpoint(req: PackInput):
    cell_results = [
        assess_cell(
            soh=c.soh, rul_cycles=c.rul_cycles, chemistry=c.chemistry,
            ir=c.ir, cycles=c.cycles, capacity_ah=c.capacity_ah,
            voltage_v=c.voltage_v, cell_id=c.cell_id,
            capacity_fade_rate=c.capacity_fade_rate,
        )
        for c in req.cells
    ]
    pack_result = assess_pack(cell_results)
    return {
        "pack_id":     req.pack_id,
        "pack_summary": pack_result,
        "cells":       cell_results,
        "assessed_at": _now(),
    }


@router.post("/second-life/assess/fleet", summary="Assess entire fleet from loaded dataset")
def assess_fleet(req: FleetAssessRequest = FleetAssessRequest()):
    import numpy as np
    import core.data_loader as dl

    if not dl.is_loaded():
        raise HTTPException(503, "Dataset not loaded")

    meta = dl._meta_df
    if meta is None or len(meta) == 0:
        raise HTTPException(503, "No data available")

    results  = []
    skipped  = 0

    for cell_id, grp in meta.groupby("cell_id"):
        try:
            grp_sorted = grp.sort_values("cycle")
            ridx       = grp_sorted.index.values
            last_i     = ridx[-1]

            soh    = float(dl._features[last_i, 9])   # cap_pct (0–1)
            cap_ah = float(dl._features[last_i, 0])   # Capacity (Ah)
            ir     = float(dl._features[last_i, 7])   # IR (Ω)
            cycles = int(grp_sorted["cycle"].iloc[-1])
            chem   = str(grp_sorted["chemistry_name"].iloc[0])

            # Estimate RUL from last SOH + average fade rate
            soh_vals = dl._features[ridx, 9]
            if len(soh_vals) >= 5:
                fade_per_cycle = max(0.0, float(soh_vals[0] - soh_vals[-1])) / max(cycles, 1)
                rul = int((soh - 0.80) / (fade_per_cycle + 1e-9)) if fade_per_cycle > 0 else 1000
                rul = max(0, min(rul, 3000))
            else:
                rul = 500

            r = assess_cell(
                soh=soh, rul_cycles=rul, chemistry=chem,
                ir=ir, cycles=cycles, capacity_ah=cap_ah,
                cell_id=str(cell_id),
            )
            results.append(r)
        except Exception as exc:
            logger.debug("Skipping %s: %s", cell_id, exc)
            skipped += 1

    grade_counts = {"A": 0, "B": 0, "C": 0, "D": 0}
    for r in results:
        grade_counts[r["grade"]] = grade_counts.get(r["grade"], 0) + 1

    total_value_lo = sum(r["value"]["min_usd"] for r in results)
    total_value_hi = sum(r["value"]["max_usd"] for r in results)

    return {
        "n_cells":       len(results),
        "skipped":       skipped,
        "grade_counts":  grade_counts,
        "recycle_count": grade_counts.get("D", 0),
        "reuse_count":   sum(grade_counts.get(g, 0) for g in ("A", "B", "C")),
        "fleet_value": {
            "min_usd": round(total_value_lo, 0),
            "max_usd": round(total_value_hi, 0),
        },
        "cells":       results,
        "assessed_at": _now(),
    }


@router.get("/second-life/history", summary="Recent second-life assessments")
def get_history(limit: int = 50):
    try:
        from core.db import _conn
        with _conn() as con:
            rows = con.execute(
                "SELECT * FROM second_life_assessments ORDER BY assessed_at DESC LIMIT ?",
                (limit,)
            ).fetchall()
            return [dict(r) for r in rows]
    except Exception:
        return []


@router.get("/second-life/applications", summary="List all second-life application templates")
def list_applications():
    from core.second_life import _APPLICATIONS
    return _APPLICATIONS


# ── DB persistence (best-effort) ──────────────────────────────────────────────

def _store_assessment(cell_id: str, result: dict) -> None:
    try:
        import json
        from core.db import _conn
        with _conn() as con:
            con.execute("""
                INSERT INTO second_life_assessments
                    (id, cell_id, grade, score, soh_pct, rul_cycles, chemistry, recycle,
                     value_min_usd, value_max_usd, result_json, assessed_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                str(uuid.uuid4()), cell_id,
                result["grade"], result["score"],
                result["soh_pct"], result["rul_cycles"],
                result["chemistry"], int(result["recycle"]),
                result["value"]["min_usd"], result["value"]["max_usd"],
                json.dumps(result), _now(),
            ))
    except Exception as exc:
        logger.debug("second_life DB store failed (non-fatal): %s", exc)

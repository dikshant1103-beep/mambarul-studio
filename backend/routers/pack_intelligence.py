"""
routers/pack_intelligence.py — Pack-level weak-cell detection & health scoring.

POST /api/pack/intelligence        full report for an arbitrary cell array
GET  /api/pack/intelligence/{id}   analyze a stored pack by pack_id
GET  /api/pack/health              fleet-level pack health summary
"""
from __future__ import annotations
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()


class CellData(BaseModel):
    cell_id:     str   = "cell"
    soh:         float = Field(..., ge=0.0, le=1.0)
    rul:         float = Field(500.0, ge=0)
    capacity_ah: float = Field(5.0,   ge=0)
    ir:          float = Field(0.05,  ge=0)
    chemistry:   str   = "NMC"
    fade_rate:   float = Field(0.0001, ge=0, description="ΔSOH per cycle")


class PackAnalysisRequest(BaseModel):
    pack_id:  str            = "pack"
    cells:    list[CellData]
    topology: str            = Field("series", pattern="^(series|parallel|series-parallel)$")


@router.post("/pack/intelligence", summary="Full pack intelligence report")
def analyze_pack_intelligence(req: PackAnalysisRequest):
    from core.pack_intelligence import full_pack_intelligence
    cells = [c.model_dump() for c in req.cells]
    result = full_pack_intelligence(cells, topology=req.topology)
    result["pack_id"] = req.pack_id
    return result


@router.get("/pack/intelligence/{pack_id}", summary="Analyze a stored pack")
def analyze_stored_pack(pack_id: str, topology: str = "series"):
    """
    Load pack cell list from bms_topology DB, build cell data from
    latest telemetry + RUL predictions, return full intelligence report.
    """
    from core.pack_intelligence import full_pack_intelligence
    try:
        from core.db import _conn
        with _conn() as con:
            cells_rows = con.execute(
                "SELECT cell_id, nominal_capacity_ah, chemistry "
                "FROM pack_cells WHERE pack_id = ?", (pack_id,)
            ).fetchall()
        if not cells_rows:
            raise HTTPException(404, f"Pack '{pack_id}' not found or has no cells")

        cells = []
        for row in cells_rows:
            cid = row["cell_id"]
            # Latest telemetry for SOH/IR estimate
            with _conn() as con:
                tel = con.execute(
                    "SELECT soc FROM cell_timeseries WHERE cell_id=? ORDER BY ts DESC LIMIT 1",
                    (cid,)
                ).fetchone()
            soh = float(tel["soc"]) / 100.0 if tel else 0.90
            cells.append({
                "cell_id":     cid,
                "soh":         soh,
                "rul":         500.0,
                "capacity_ah": float(row["nominal_capacity_ah"]),
                "ir":          0.05,
                "chemistry":   row["chemistry"],
                "fade_rate":   0.0001,
            })

        result = full_pack_intelligence(cells, topology=topology)
        result["pack_id"] = pack_id
        return result
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("pack intelligence failed: %s", exc)
        raise HTTPException(500, str(exc))


@router.get("/pack/health", summary="Fleet-level pack health summary")
def fleet_pack_health():
    """Return health summary for all packs with ≥ 2 cells in the DB."""
    from core.pack_intelligence import pack_health_score, pack_rul_estimate
    try:
        from core.db import _conn
        with _conn() as con:
            packs = con.execute("SELECT id, name FROM packs").fetchall()

        summaries = []
        for pack in packs:
            pid = pack["id"]
            with _conn() as con:
                cells_rows = con.execute(
                    "SELECT cell_id FROM pack_cells WHERE pack_id=?", (pid,)
                ).fetchall()
            if len(cells_rows) < 2:
                continue
            cells = []
            for row in cells_rows:
                with _conn() as con:
                    tel = con.execute(
                        "SELECT soc FROM cell_timeseries WHERE cell_id=? ORDER BY ts DESC LIMIT 1",
                        (row["cell_id"],)
                    ).fetchone()
                soh = float(tel["soc"]) / 100.0 if tel else 0.90
                cells.append({"cell_id": row["cell_id"], "soh": soh, "rul": 500, "capacity_ah": 5.0, "ir": 0.05})

            health = pack_health_score(cells)
            rul    = pack_rul_estimate(cells)
            summaries.append({
                "pack_id":    pid,
                "pack_name":  pack["name"],
                "health":     health,
                "pack_rul":   rul["pack_rul"],
                "n_cells":    len(cells),
            })

        return {"n_packs": len(summaries), "packs": summaries}
    except Exception as exc:
        logger.debug("fleet pack health: %s", exc)
        return {"n_packs": 0, "packs": []}

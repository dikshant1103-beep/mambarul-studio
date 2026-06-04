"""
routers/bms_topology.py — Dynamic pack/module/cell topology management.

Endpoints:
  GET    /api/bms/topology           — list all packs with cells
  POST   /api/bms/topology           — create a pack
  DELETE /api/bms/topology/{id}      — delete a pack
  POST   /api/bms/topology/{id}/cells — add cells to pack
  DELETE /api/bms/topology/{id}/cells/{cell_id} — remove cell
  GET    /api/bms/topology/{id}/thermal — thermal analysis snapshot
"""
from __future__ import annotations
from typing import Optional, List
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()


class PackCreate(BaseModel):
    name:                str
    description:         str   = ""
    cells_series:        int   = Field(1, ge=1)
    cells_parallel:      int   = Field(1, ge=1)
    nominal_voltage:     float = Field(3.6, gt=0)
    nominal_capacity_ah: float = Field(50.0, gt=0)
    chemistry:           str   = "NMC"


class CellAdd(BaseModel):
    cell_id:             str
    module_id:           str   = ""
    position_series:     int   = 0
    position_parallel:   int   = 0
    nominal_capacity_ah: float = 5.0
    chemistry:           str   = "NMC"


@router.get("/bms/topology", summary="List all packs with their cells")
def list_topology() -> list:
    from core.db import list_packs, get_pack_cells, get_latest_per_cell
    packs = list_packs()
    # Enrich each pack with its cells + latest telemetry
    live  = {r["cell_id"]: r for r in get_latest_per_cell()}
    result = []
    for p in packs:
        cells = get_pack_cells(p["id"])
        for c in cells:
            tel = live.get(c["cell_id"], {})
            c["latest"] = {
                "voltage":     tel.get("voltage"),
                "current":     tel.get("current"),
                "temperature": tel.get("temperature"),
                "soc":         tel.get("soc"),
                "ts":          tel.get("ts"),
            }
        p["cells"] = cells
        p["cell_count"] = len(cells)
        result.append(p)
    return result


@router.post("/bms/topology", summary="Create a new pack")
def create_pack(body: PackCreate) -> dict:
    from core.db import create_pack as db_create
    return db_create(**body.model_dump())


@router.delete("/bms/topology/{pack_id}", summary="Delete a pack and its cell mappings")
def delete_pack(pack_id: str) -> dict:
    from core.db import delete_pack as db_delete
    if not db_delete(pack_id):
        raise HTTPException(404, "Pack not found.")
    return {"ok": True}


@router.post("/bms/topology/{pack_id}/cells", summary="Add cells to a pack")
def add_cells(pack_id: str, cells: List[CellAdd]) -> dict:
    from core.db import get_pack, add_cell_to_pack
    if not get_pack(pack_id):
        raise HTTPException(404, "Pack not found.")
    added = []
    for c in cells:
        rec = add_cell_to_pack(pack_id=pack_id, **c.model_dump())
        added.append(rec["cell_id"])
    return {"ok": True, "added": added}


@router.delete("/bms/topology/{pack_id}/cells/{cell_id}", summary="Remove cell from pack")
def remove_cell(pack_id: str, cell_id: str) -> dict:
    from core.db import remove_cell_from_pack
    if not remove_cell_from_pack(pack_id, cell_id):
        raise HTTPException(404, "Cell not found in pack.")
    return {"ok": True}


@router.get("/bms/topology/{pack_id}/thermal", summary="Thermal analysis snapshot for a pack")
def pack_thermal(pack_id: str) -> dict:
    from core.db import get_pack_cells, get_latest_per_cell
    from core.thermal_model import analyze_pack
    cells = get_pack_cells(pack_id)
    if not cells:
        raise HTTPException(404, "Pack has no cells or does not exist.")
    live  = {r["cell_id"]: r for r in get_latest_per_cell(pack_id=pack_id)}
    cell_ids = [c["cell_id"] for c in cells]
    temps    = [live.get(cid, {}).get("temperature") for cid in cell_ids]
    currents = [live.get(cid, {}).get("current")     for cid in cell_ids]
    # Filter cells with no live data
    valid = [(cid, t, i) for cid, t, i in zip(cell_ids, temps, currents) if t is not None]
    if not valid:
        return {"error": "No live telemetry for this pack's cells."}
    v_ids, v_temps, v_amps = zip(*valid)
    state = analyze_pack(list(v_ids), list(v_temps), list(v_amps))
    return {
        "pack_id":      pack_id,
        "cells_live":   len(valid),
        "mean_temp":    state.mean_temp,
        "max_temp":     state.max_temp,
        "min_temp":     state.min_temp,
        "gradient_c":   state.gradient_c,
        "runaway_risk": state.runaway_risk,
        "runaway_alert":state.runaway_alert,
        "hotspots":     state.hotspots,
    }

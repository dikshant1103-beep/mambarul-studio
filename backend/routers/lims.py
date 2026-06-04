"""
routers/lims.py — Manufacturing / lab cycler import (LIMS/MES connector).

POST /api/lims/import   upload a vendor cycler CSV (Arbin/Maccor/Neware/BioLogic/
                        generic) → detected format + per-cycle capacity-fade
                        trajectory + a normalized CSV for the prediction pipeline.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, UploadFile, File, HTTPException

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/lims/import", summary="Import a cycler export (Arbin/Maccor/Neware/BioLogic)")
async def lims_import(file: UploadFile = File(...)) -> dict:
    """Parse + persist a cycler import so it surfaces on the manufacturing dashboard."""
    from core.lims_adapter import parse_lims_csv
    from core.db import store_lims_import
    import json as _json
    content = await file.read()
    try:
        r = parse_lims_csv(content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    # Persist for the QA dashboard
    try:
        soh = r.get("soh_trajectory", [])
        soh_initial = soh[0]["soh"] if soh else None
        soh_final   = soh[-1]["soh"] if soh else None
        n_cyc = max(1, r["n_cycles"])
        fade  = round((1.0 - (soh_final or 1.0)) / n_cyc * 100, 6) if soh_final is not None else None
        iid = store_lims_import(
            filename=file.filename or "upload.csv",
            fmt=r.get("format", "generic"),
            n_cycles=r["n_cycles"], n_rows=r["n_rows"],
            nominal_capacity_ah=r.get("nominal_capacity_ah", 0.0),
            soh_initial=soh_initial, soh_final=soh_final,
            fade_rate_pct_per_cycle=fade,
            meta_json=_json.dumps({"capacity_unit": r.get("capacity_unit"),
                                   "warnings": r.get("warnings", [])}),
        )
        r["import_id"] = iid
    except Exception as exc:
        logger.warning("lims persist failed: %s", exc)
    return r


@router.get("/lims/imports", summary="List recent LIMS/cycler imports for the QA dashboard")
def list_imports(limit: int = 200) -> dict:
    """Returns the import log + a small aggregate (mean/min/max fade rate, n imports)."""
    from core.db import list_lims_imports
    rows = list_lims_imports(limit=limit)
    fades = [r["fade_rate_pct_per_cycle"] for r in rows
             if r.get("fade_rate_pct_per_cycle") is not None]
    if fades:
        import statistics as _stats
        agg = {
            "n_imports":    len(rows),
            "mean_fade":    round(_stats.fmean(fades), 5),
            "median_fade":  round(_stats.median(fades), 5),
            "min_fade":     round(min(fades), 5),
            "max_fade":     round(max(fades), 5),
            "stdev_fade":   round(_stats.pstdev(fades), 5) if len(fades) > 1 else 0.0,
        }
    else:
        agg = {"n_imports": len(rows), "mean_fade": None, "median_fade": None,
               "min_fade": None, "max_fade": None, "stdev_fade": None}
    return {"summary": agg, "imports": rows}

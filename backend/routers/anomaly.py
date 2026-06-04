"""
routers/anomaly.py — SPC anomaly detection API.

GET  /api/anomaly/fleet              scan entire fleet (cached 5 min)
GET  /api/anomaly/cell/{cell_id}     full SPC result for one cell (with control chart)
POST /api/anomaly/scan               scan arbitrary cell data posted inline
GET  /api/anomaly/events             recent stored anomaly events from DB
GET  /api/anomaly/summary            fleet-level counts (fast, used by dashboard)
"""
from __future__ import annotations
import logging
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, BackgroundTasks
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Simple 5-minute in-process cache for fleet scan ──────────────────────────
_fleet_cache: dict | None = None
_fleet_cache_ts: float    = 0.0
_FLEET_TTL: float         = 300.0   # seconds


class InlineScanRequest(BaseModel):
    cell_id:     str         = "cell"
    cycles:      list[int]
    soh:         list[float] = Field(..., description="SOH values 0–1, same length as cycles")
    ir:          list[float] = []
    temperature: list[float] = []


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/anomaly/fleet", summary="SPC scan of entire loaded fleet")
def fleet_scan(refresh: bool = False):
    global _fleet_cache, _fleet_cache_ts
    now = time.time()
    if not refresh and _fleet_cache and (now - _fleet_cache_ts) < _FLEET_TTL:
        return {**_fleet_cache, "cached": True, "cache_age_s": int(now - _fleet_cache_ts)}

    from core.anomaly_detector import scan_fleet
    result = scan_fleet()
    if "error" not in result:
        _fleet_cache    = result
        _fleet_cache_ts = now
    return {**result, "cached": False}


@router.get("/anomaly/summary", summary="Fleet anomaly counts (fast, for dashboard)")
def anomaly_summary():
    global _fleet_cache, _fleet_cache_ts
    now = time.time()
    if _fleet_cache and (now - _fleet_cache_ts) < _FLEET_TTL:
        return {
            "n_cells":    _fleet_cache["n_cells"],
            "n_critical": _fleet_cache["n_critical"],
            "n_warning":  _fleet_cache["n_warning"],
            "n_normal":   _fleet_cache["n_normal"],
            "cached":     True,
        }
    # No cache yet — return zeros so dashboard doesn't block
    return {"n_cells": 0, "n_critical": 0, "n_warning": 0, "n_normal": 0, "cached": False}


@router.get("/anomaly/cell/{cell_id}", summary="Full SPC result for one cell")
def cell_scan(cell_id: str):
    import core.data_loader as dl
    from core.anomaly_detector import detect_cell_anomalies

    if dl._meta_df is None:
        dl.load_dataset()

    import numpy as np
    meta = dl._meta_df
    feat = dl._features

    mask = meta["cell_id"].values == cell_id
    if not mask.any():
        raise HTTPException(404, f"Cell '{cell_id}' not found")

    idx    = np.where(mask)[0]
    grp    = meta.iloc[idx].sort_values("cycle")
    ridx   = grp.index.values

    cycles = grp["cycle"].tolist()
    soh    = feat[ridx, 9].tolist()
    ir     = feat[ridx, 7].tolist()
    temp   = feat[ridx, 5].tolist()

    result = detect_cell_anomalies(
        cell_id=cell_id,
        cycles=cycles,
        soh=soh,
        ir=ir,
        temperature=temp,
    )
    result["chemistry"] = str(grp["chemistry_name"].iloc[0])
    result["dataset"]   = str(grp["dataset"].iloc[0])
    _persist_events(cell_id, result.get("events", []),
                    str(grp["chemistry_name"].iloc[0]))
    return result


@router.post("/anomaly/scan", summary="Scan arbitrary inline cell data")
def scan_inline(req: InlineScanRequest):
    from core.anomaly_detector import detect_cell_anomalies
    if len(req.cycles) != len(req.soh):
        raise HTTPException(400, "cycles and soh must have the same length")
    return detect_cell_anomalies(
        cell_id=req.cell_id,
        cycles=req.cycles,
        soh=req.soh,
        ir=req.ir or None,
        temperature=req.temperature or None,
    )


@router.get("/anomaly/events", summary="Stored anomaly events from DB")
def get_events(limit: int = 100, severity: Optional[str] = None):
    try:
        from core.db import _conn
        with _conn() as con:
            if severity:
                rows = con.execute(
                    "SELECT * FROM anomaly_events WHERE severity=? "
                    "ORDER BY detected_at DESC LIMIT ?",
                    (severity, limit)
                ).fetchall()
            else:
                rows = con.execute(
                    "SELECT * FROM anomaly_events ORDER BY detected_at DESC LIMIT ?",
                    (limit,)
                ).fetchall()
            return [dict(r) for r in rows]
    except Exception as exc:
        logger.warning("anomaly_events query failed: %s", exc)
        return []


# ── Background persistence ────────────────────────────────────────────────────

def _persist_events(cell_id: str, events: list[dict], chemistry: str) -> None:
    if not events:
        return
    try:
        import json, uuid
        from datetime import datetime, timezone
        from core.db import _conn
        now = datetime.now(timezone.utc).isoformat()
        with _conn() as con:
            for e in events:
                con.execute("""
                    INSERT OR IGNORE INTO anomaly_events
                        (id, cell_id, chemistry, anomaly_type, severity,
                         cycle, value, expected, deviation_sigma,
                         description, detected_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    str(uuid.uuid4()), cell_id, chemistry,
                    e["type"], e["severity"],
                    e["cycle"], e["value"], e["expected"],
                    e["deviation_sigma"], e["description"], now,
                ))
    except Exception as exc:
        logger.debug("anomaly_events persist failed (non-fatal): %s", exc)

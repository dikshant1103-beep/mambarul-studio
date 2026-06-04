"""
routers/drift.py — Prediction-distribution drift monitoring.

GET  /api/drift/report      full Evidently drift report (cached 1 h)
GET  /api/drift/status      quick summary: drifted + counts
POST /api/drift/scan        force re-scan (busts cache)
DELETE /api/drift/cache     clear cached reference + report
"""
from __future__ import annotations
import logging

from fastapi import APIRouter

logger = logging.getLogger(__name__)
router = APIRouter()


@router.get("/drift/report", summary="Prediction drift report (Evidently)")
def drift_report(n: int = 500):
    """
    Compare last n prediction outputs to training reference distribution.
    Result cached for 1 hour. Pass ?n=200 to use fewer current samples.
    """
    from core.drift_monitor import run_drift_check
    return run_drift_check(n_current=n)


@router.get("/drift/status", summary="Quick drift status")
def drift_status():
    """
    Lightweight endpoint for the Home dashboard card.
    Returns: drifted (bool), n_drifted, n_columns, checked_at.
    """
    from core.drift_monitor import run_drift_check
    r = run_drift_check()
    return {
        "ok":            r.get("ok", False),
        "dataset_drift": r.get("dataset_drift", False),
        "n_drifted":     r.get("n_drifted", 0),
        "n_columns":     r.get("n_columns", 0),
        "drift_share":   r.get("drift_share", 0.0),
        "reason":        r.get("reason", ""),
        "checked_at":    r.get("checked_at", ""),
    }


@router.post("/drift/scan", summary="Force drift re-scan")
def force_scan(n: int = 500):
    """Bust cache and run a fresh drift check immediately."""
    from core.drift_monitor import run_drift_check
    return run_drift_check(n_current=n, force=True)


@router.delete("/drift/cache", summary="Clear drift cache and reference")
def clear_cache():
    """Reset reference dataset and cached report. Next call rebuilds from scratch."""
    from core.drift_monitor import invalidate_cache
    invalidate_cache()
    return {"ok": True, "message": "Drift cache cleared"}

"""
routers/analytics.py — prediction analytics and alert history.
GET  /api/analytics/summary      → aggregate stats (optional ?org=)
GET  /api/analytics/calls        → raw call log (optional ?org=)
GET  /api/analytics/orgs         → list distinct orgs that have made calls
GET  /api/alerts                 → alert history (optional ?org=)
GET  /api/alerts/count           → unacknowledged alert count (optional ?org=)
POST /api/alerts/{id}/ack        → mark alert as acknowledged
POST /api/alerts/ack-all         → acknowledge all alerts
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException
from core.analytics import (
    get_summary, get_calls, get_alerts, get_orgs,
    get_unack_count, acknowledge_alert,
)

router = APIRouter()


@router.get("/analytics/summary", summary="Aggregate prediction analytics")
def analytics_summary(org: str = "") -> dict:
    return get_summary(org=org)


@router.get("/analytics/calls", summary="Raw prediction call log")
def analytics_calls(limit: int = 500, org: str = "") -> list[dict]:
    return get_calls(limit=min(limit, 2000), org=org)


@router.get("/analytics/orgs", summary="Distinct orgs with call history")
def analytics_orgs() -> list[str]:
    return get_orgs()


@router.get("/alerts", summary="Alert history — critical / Near-EOL detections")
def list_alerts(unack_only: bool = False, limit: int = 200, org: str = "") -> list[dict]:
    return get_alerts(unack_only=unack_only, limit=limit, org=org)


@router.get("/alerts/count", summary="Number of unacknowledged alerts")
def alert_count(org: str = "") -> dict:
    return {"unacknowledged": get_unack_count(org=org)}


@router.post("/alerts/{alert_id}/ack", summary="Acknowledge a single alert")
def ack_alert(alert_id: str) -> dict:
    ok = acknowledge_alert(alert_id)
    if not ok:
        raise HTTPException(404, f"Alert '{alert_id}' not found.")
    return {"ok": True}


@router.post("/alerts/ack-all", summary="Acknowledge all outstanding alerts")
def ack_all(org: str = "") -> dict:
    alerts = get_alerts(unack_only=True, limit=9999, org=org)
    for a in alerts:
        acknowledge_alert(a["id"])
    return {"acknowledged": len(alerts)}

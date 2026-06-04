"""
routers/notifications.py — Alert delivery channels (email + webhook).

GET  /api/notifications/channels   which channels are configured (no secrets)
POST /api/notifications/test       send a sample alert (dry-run by default)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from core.middleware import require_admin

router = APIRouter()


@router.get("/notifications/channels", summary="Configured alert channels")
def channels() -> dict:
    from core.notifications import notification_channels
    return notification_channels()


class TestNotifyRequest(BaseModel):
    dry_run: bool = True             # default safe — reports what would fire without sending
    webhook_format: str | None = None  # "slack" | "teams" | "generic" | None (auto-detect by URL)


@router.post("/notifications/test", dependencies=[Depends(require_admin)],
             summary="Dispatch a sample alert to all configured channels")
def test_notify(req: TestNotifyRequest) -> dict:
    from core.notifications import dispatch_alerts
    sample = [{"cell_id": "TEST-CELL-01", "chem": "NMC", "soh": 79.5,
               "rul": 42.0, "phase": "Near-EOL", "severity": "warning",
               "description": "SOH below 80%"}]
    return dispatch_alerts(sample, reason="test", dry_run=req.dry_run,
                           webhook_format=req.webhook_format)


@router.get("/notifications/webhook/preview",
            summary="Preview the Slack / Teams / generic payload that would be POSTed")
def preview_webhook_payload(format: str = "slack") -> dict:
    """Useful for the Settings UI to show the exact JSON that will hit Slack /
    Teams without actually sending. No auth — read-only, no secrets."""
    from core.notifications import (
        _format_for_slack, _format_for_teams,
    )
    sample = [
        {"cell_id": "FLEET-CELL-007", "chem": "NMC", "severity": "critical",
         "description": "Predicted RUL 42 cyc (warranty horizon 200 cyc)"},
        {"cell_id": "FLEET-CELL-031", "chem": "LFP", "severity": "warning",
         "description": "Anomaly: fade acceleration 3.2σ over baseline"},
    ]
    f = (format or "generic").lower()
    if f == "slack":
        return {"format": "slack", "payload": _format_for_slack(sample, "warranty.fleet")}
    if f == "teams":
        return {"format": "teams", "payload": _format_for_teams(sample, "warranty.fleet")}
    return {"format": "generic",
            "payload": {"reason": "warranty.fleet", "n_alerts": len(sample),
                        "alerts": sample}}

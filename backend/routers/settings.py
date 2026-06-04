"""
routers/settings.py — Platform-wide configuration (SQLite-backed).
GET  /api/settings        → current config (passwords excluded)
POST /api/settings        → update config
POST /api/settings/webhook/test → fire a test payload
POST /api/settings/email/test   → send test email
"""
from __future__ import annotations
import json
import urllib.request
import urllib.error
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()


def load_settings() -> dict:
    from core.db import get_settings
    return get_settings()


def save_settings(s: dict) -> None:
    from core.db import save_settings as _save
    _save(s)


class SettingsUpdate(BaseModel):
    auth_password:     str  | None = Field(default=None, min_length=4)
    soh_healthy:       int  | None = Field(default=None, ge=50, le=99)
    soh_warning:       int  | None = Field(default=None, ge=50, le=99)
    eol_threshold:     int  | None = Field(default=None, ge=50, le=99)
    webhook_url:       str  | None = None
    webhook_enabled:   bool | None = None
    default_chemistry: str  | None = None
    alert_email:       str  | None = None
    smtp_host:         str  | None = None
    smtp_port:         int  | None = Field(default=None, ge=1, le=65535)
    smtp_user:         str  | None = None
    smtp_password:     str  | None = None
    smtp_from:         str  | None = None
    sentry_dsn:        str  | None = None


_HIDDEN = {"auth_password", "smtp_password"}


@router.get("/settings")
def get_settings_endpoint() -> dict:
    s = load_settings()
    return (
        {k: v for k, v in s.items() if k not in _HIDDEN}
        | {"has_password": True,
           "has_smtp_password": bool(s.get("smtp_password"))}
    )


@router.post("/settings")
def update_settings(body: SettingsUpdate) -> dict:
    s = load_settings()
    update = body.model_dump(exclude_none=True)
    s.update(update)
    save_settings(s)
    visible  = [k for k in update if k not in _HIDDEN]
    hidden   = [f"{k}(hidden)" for k in _HIDDEN if k in update]
    return {"ok": True, "updated": visible + hidden}


@router.post("/settings/webhook/test")
def test_webhook() -> dict:
    s = load_settings()
    url = s.get("webhook_url", "").strip()
    if not url:
        raise HTTPException(400, "No webhook URL configured.")
    payload = json.dumps({
        "event": "batteryos.test",
        "message": "BatteryOS webhook test — your integration is working.",
    }).encode()
    req = urllib.request.Request(
        url, data=payload,
        headers={"Content-Type": "application/json", "User-Agent": "BatteryOS/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=8) as resp:
            return {"ok": True, "status": resp.status, "url": url}
    except urllib.error.HTTPError as e:
        return {"ok": False, "status": e.code, "url": url, "error": str(e)}
    except Exception as e:
        raise HTTPException(502, f"Webhook delivery failed: {e}")


@router.post("/settings/email/test")
def test_email() -> dict:
    from core.notifications import send_test_email
    return send_test_email()

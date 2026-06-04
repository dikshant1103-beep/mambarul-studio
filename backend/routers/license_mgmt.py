"""
routers/license_mgmt.py — License key management.

Endpoints:
  GET  /api/license/status          → current activation state (public)
  POST /api/license/activate        → activate a key in this installation
  GET  /api/admin/licenses          → list all keys (admin only)
  POST /api/admin/licenses/generate → generate a new key (admin only)
  POST /api/admin/licenses/{id}/revoke → revoke a key (admin only)
"""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

router = APIRouter()


def _require_admin(token: str | None) -> dict:
    if not token:
        raise HTTPException(401, "Not authenticated.")
    from core.db import validate_session
    s = validate_session(token)
    if not s:
        raise HTTPException(401, "Session expired.")
    if s.get("role") != "admin":
        raise HTTPException(403, "Admin access required.")
    return s


class ActivateRequest(BaseModel):
    key: str


class GenerateRequest(BaseModel):
    plan:           str = "pro"
    seats:          int = 1
    customer_email: str = ""
    notes:          str = ""


@router.get("/license/status", summary="Get license activation state")
def license_status() -> dict:
    from core.db import get_license_status
    return get_license_status()


@router.post("/license/activate", summary="Activate a license key")
def activate_license(body: ActivateRequest) -> dict:
    from core.license import validate_key
    from core.db import save_settings, activate_license as db_try_activate
    from datetime import datetime, timezone

    key = body.key.strip().upper()
    if not validate_key(key):
        raise HTTPException(400, "Invalid license key. Please check and try again.")

    # Try to mark as activated in DB (works when key is in admin DB; no-op in customer DB)
    db_try_activate(key)

    # Persist activation state in settings_kv — this is the source of truth for status
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    save_settings({
        "license_activated":    True,
        "license_key_preview":  key[:9] + "…",
        "license_activated_at": now,
    })
    return {"ok": True}


@router.get("/admin/licenses", summary="List all license keys")
def list_licenses(x_session_token: Optional[str] = Header(default=None)) -> list:
    _require_admin(x_session_token)
    from core.db import list_licenses as db_list
    return db_list()


@router.post("/admin/licenses/generate", summary="Generate a new license key")
def generate_license(body: GenerateRequest,
                     x_session_token: Optional[str] = Header(default=None)) -> dict:
    _require_admin(x_session_token)
    from core.license import generate_key
    from core.db import create_license

    if body.seats < 1:
        raise HTTPException(422, "Seats must be at least 1.")
    valid_plans = {"starter", "pro", "enterprise"}
    if body.plan not in valid_plans:
        raise HTTPException(422, f"Plan must be one of: {', '.join(sorted(valid_plans))}")

    key = generate_key()
    record = create_license(
        key=key,
        plan=body.plan,
        seats=body.seats,
        customer_email=body.customer_email.strip(),
        notes=body.notes.strip(),
    )
    return record


@router.post("/admin/licenses/{lic_id}/revoke", summary="Revoke a license key")
def revoke_license(lic_id: str,
                   x_session_token: Optional[str] = Header(default=None)) -> dict:
    _require_admin(x_session_token)
    from core.db import revoke_license as db_revoke
    if not db_revoke(lic_id):
        raise HTTPException(404, "License not found.")
    return {"ok": True}

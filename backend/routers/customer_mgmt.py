"""
routers/customer_mgmt.py — Admin-only: customer user management + app distribution info.

Endpoints:
  GET    /api/admin/customers             → list all users
  PATCH  /api/admin/customers/{user_id}   → update user fields
  DELETE /api/admin/customers/{user_id}   → delete user
  POST   /api/admin/customers/{user_id}/verify   → force-verify email
  POST   /api/admin/customers/{user_id}/reset    → send password reset OTP
  GET    /api/admin/app-info              → BatteryOS app distribution info
"""
from __future__ import annotations
import os
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

router = APIRouter()


def _require_admin(token: Optional[str]) -> dict:
    if not token:
        raise HTTPException(401, "Not authenticated.")
    from core.db import validate_session
    session = validate_session(token)
    if not session:
        raise HTTPException(401, "Session expired.")
    if session.get("role") != "admin":
        raise HTTPException(403, "Admin access required.")
    return session


class UserPatch(BaseModel):
    is_active:      Optional[int] = None
    role:           Optional[str] = None
    email_verified: Optional[int] = None
    full_name:      Optional[str] = None


@router.get("/admin/customers", summary="List all users (admin)")
def list_customers(x_session_token: Optional[str] = Header(default=None)) -> list:
    _require_admin(x_session_token)
    from core.db import list_users
    return list_users()


@router.patch("/admin/customers/{user_id}", summary="Update user (admin)")
def patch_customer(user_id: str, body: UserPatch,
                   x_session_token: Optional[str] = Header(default=None)) -> dict:
    _require_admin(x_session_token)
    from core.db import update_user
    updates = {k: v for k, v in body.model_dump().items() if v is not None}
    if not updates:
        raise HTTPException(422, "No fields to update.")
    update_user(user_id, **updates)
    return {"ok": True}


@router.delete("/admin/customers/{user_id}", summary="Delete user (admin)")
def delete_customer(user_id: str,
                    x_session_token: Optional[str] = Header(default=None)) -> dict:
    sess = _require_admin(x_session_token)
    if sess["user_id"] == user_id:
        raise HTTPException(400, "Cannot delete your own account.")
    from core.db import delete_user
    delete_user(user_id)
    return {"ok": True}


@router.post("/admin/customers/{user_id}/verify", summary="Force-verify user email (admin)")
def force_verify(user_id: str,
                 x_session_token: Optional[str] = Header(default=None)) -> dict:
    _require_admin(x_session_token)
    from core.db import update_user
    update_user(user_id, email_verified=1)
    return {"ok": True}


@router.post("/admin/customers/{user_id}/reset", summary="Send password reset OTP (admin)")
def admin_send_reset(user_id: str,
                     x_session_token: Optional[str] = Header(default=None)) -> dict:
    _require_admin(x_session_token)
    from core.db import get_user_by_id, set_reset_token
    from core.notifications import send_otp_email
    import random
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(404, "User not found.")
    otp = str(random.randint(100000, 999999))
    set_reset_token(user_id, otp)
    smtp_ok = send_otp_email(user["email"], otp, purpose="reset")
    return {"ok": True, "smtp": smtp_ok, **({"dev_otp": otp} if not smtp_ok else {})}


@router.get("/admin/app-info", summary="BatteryOS customer app distribution info")
def app_info(x_session_token: Optional[str] = Header(default=None)) -> dict:
    _require_admin(x_session_token)
    from core.db import list_users

    backend_dir = Path(__file__).parent.parent
    studio_dir  = backend_dir.parent
    appimage_path = studio_dir / "dist" / "BatteryOS.AppImage"

    appimage_info: dict = {"exists": False}
    if appimage_path.exists():
        stat = appimage_path.stat()
        appimage_info = {
            "exists":    True,
            "path":      str(appimage_path),
            "size_mb":   round(stat.st_size / 1024 / 1024, 1),
            "modified":  Path(appimage_path).stat().st_mtime,
        }

    # User stats
    users = list_users()
    total        = len(users)
    verified     = sum(1 for u in users if u.get("email_verified"))
    active       = sum(1 for u in users if u.get("is_active"))
    admins       = sum(1 for u in users if u.get("role") == "admin")
    customers    = total - admins

    # SMTP configured?
    from core.db import get_settings
    s = get_settings()
    smtp_ready = bool(s.get("smtp_host", "").strip())

    return {
        "version":   "1.0.0",
        "app_name":  "BatteryOS",
        "appimage":  appimage_info,
        "features":  [
            "Dashboard — fleet overview with SOH & RUL",
            "Live Predict — single-cell RUL with conformal CI",
            "Pack Predict — series/parallel pack aggregation",
            "Batch Predict — CSV upload for up to 500 cells",
            "Upload & Analyze — full pipeline from raw data",
            "Calibrate — DoD multiplier & temperature correction",
            "Fleet View — real-time cell monitoring",
            "Alert History — track and acknowledge alerts",
            "Analytics — usage charts and chemistry breakdown",
            "API Keys — manage programmatic access",
        ],
        "user_stats": {
            "total":     total,
            "customers": customers,
            "admins":    admins,
            "verified":  verified,
            "active":    active,
            "unverified": total - verified,
        },
        "smtp_configured": smtp_ready,
        "auth_features": {
            "email_verification": True,
            "forgot_password":    True,
            "otp_login":          False,
        },
        "deployment_notes": [
            "Distribute BatteryOS.AppImage to customers",
            "Customers register with email + password on first launch",
            "Email verification requires SMTP to be configured in Settings",
            "Without SMTP, the 6-digit code is shown directly in the app (dev mode)",
            "Admins can force-verify any user from this panel",
        ],
    }

"""
routers/auth.py — Email + password auth with SQLite-backed session tokens.

Endpoints:
  POST /api/auth/register  { email, password, full_name }  → { user, token }
  POST /api/auth/login     { email, password }              → { user, token }
  GET  /api/auth/me        (X-Session-Token header)         → { user }
  POST /api/auth/logout    (token query param or header)    → { ok }
  GET  /api/auth/check     ?token=...                       → { valid }  (legacy compat)

Token is a UUID session key stored in SQLite with expiry.
Header name stays X-Session-Token for backward compat with existing frontend.
"""
from __future__ import annotations
from typing import Optional
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

router = APIRouter()


def _pwd_ctx():
    from passlib.context import CryptContext
    return CryptContext(schemes=["bcrypt"], deprecated="auto")


def _safe_user(u: dict) -> dict:
    return {k: v for k, v in u.items() if k not in ("password_hash",)}


class RegisterRequest(BaseModel):
    email:        str
    password:     str
    full_name:    str = ""
    tos_accepted: bool = False


class LoginRequest(BaseModel):
    email:    str = ""
    password: str = ""


@router.post("/auth/register", summary="Create a new account")
def register(body: RegisterRequest) -> dict:
    from core.config import cfg
    from core.db import get_user_by_email, create_user, create_session, is_login_blocked, record_failed_login

    if not cfg.registration_open:
        raise HTTPException(403, "Registration is closed. Contact your admin.")
    if not body.email or "@" not in body.email:
        raise HTTPException(422, "Valid email required.")
    if len(body.password) < 8:
        raise HTTPException(422, "Password must be at least 8 characters.")
    if not body.tos_accepted:
        raise HTTPException(422, "You must accept the Terms of Service to register.")
    # Rate limit: reuse login block table keyed with __reg__ prefix
    reg_key = f"__reg__:{body.email.lower()}"
    if is_login_blocked(reg_key):
        raise HTTPException(429, "Too many registration attempts. Try again in 15 minutes.")
    if get_user_by_email(body.email):
        record_failed_login(reg_key)
        raise HTTPException(409, "An account with this email already exists.")

    user  = create_user(email=body.email, password=body.password,
                        full_name=body.full_name.strip())
    token = create_session(user["id"])
    # Welcome email is sent after email verification, not here
    return {"user": _safe_user(user), "token": token}


@router.post("/auth/login", summary="Sign in")
def login(body: LoginRequest) -> dict:
    from core.db import (get_user_by_email, create_session, record_login,
                         is_login_blocked, record_failed_login, clear_failed_logins)

    # Legacy single-password mode (old frontend sends only password)
    if not body.email:
        return _legacy_password_login(body.password)

    email_lc = body.email.lower()
    if is_login_blocked(email_lc):
        raise HTTPException(429, "Too many failed attempts. Try again in 15 minutes.")

    user = get_user_by_email(email_lc)
    if not user or not _pwd_ctx().verify(body.password, user["password_hash"]):
        record_failed_login(email_lc)
        raise HTTPException(401, "Invalid email or password.")
    if not user.get("is_active"):
        raise HTTPException(403, "Account is deactivated.")
    if not user.get("email_verified"):
        raise HTTPException(403, "Email not verified. Check your inbox for the verification code.")

    clear_failed_logins(email_lc)
    record_login(user["id"])
    token = create_session(user["id"])
    return {"user": _safe_user(user), "token": token, "valid": True}


def _legacy_password_login(password: str) -> dict:
    """Single-password fallback for old frontend — ties to admin account."""
    from core.db import get_settings, create_session, get_user_by_email
    s = get_settings()
    expected = s.get("auth_password", "batteryos")
    if password != expected:
        raise HTTPException(401, "Invalid password.")
    admin = get_user_by_email("admin@batteryos.io")
    if not admin:
        raise HTTPException(500, "Admin account not configured.")
    return {"valid": True, "token": create_session(admin["id"])}


@router.get("/auth/me", summary="Get current user")
def me(x_session_token: Optional[str] = Header(default=None)) -> dict:
    if not x_session_token:
        raise HTTPException(401, "Not authenticated.")
    from core.db import validate_session
    session = validate_session(x_session_token)
    if not session:
        raise HTTPException(401, "Session expired. Please sign in again.")
    return {
        "user_id":   session["user_id"],
        "email":     session["email"],
        "full_name": session["full_name"],
        "org_id":    session["org_id"],
        "role":      session["role"],
    }


@router.get("/auth/check", summary="Validate a session token (legacy)")
def check_token(token: str) -> dict:
    from core.db import validate_session
    return {"valid": validate_session(token) is not None}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password:     str

@router.post("/auth/change-password", summary="Change password (requires current password)")
def change_password(body: ChangePasswordRequest,
                    x_session_token: Optional[str] = Header(default=None)) -> dict:
    if not x_session_token:
        raise HTTPException(401, "Not authenticated.")
    if len(body.new_password) < 8:
        raise HTTPException(422, "New password must be at least 8 characters.")
    from core.db import validate_session, get_user_by_email, update_user_password
    session = validate_session(x_session_token)
    if not session:
        raise HTTPException(401, "Session expired.")
    user = get_user_by_email(session["email"])
    if not user or not _pwd_ctx().verify(body.current_password, user["password_hash"]):
        raise HTTPException(401, "Current password is incorrect.")
    update_user_password(user["id"], body.new_password)
    return {"ok": True}


@router.post("/auth/logout", summary="Invalidate session")
def logout(token: str = "",
           x_session_token: Optional[str] = Header(default=None)) -> dict:
    from core.db import delete_session
    t = token or x_session_token
    if t:
        delete_session(t)
    return {"ok": True}


# ── Email verification ────────────────────────────────────────────────────────

class EmailBody(BaseModel):
    email: str

class OTPBody(BaseModel):
    email: str
    otp:   str

class ResetBody(BaseModel):
    email:        str
    otp:          str
    new_password: str


def _gen_otp() -> str:
    import secrets
    return str(secrets.randbelow(900000) + 100000)


@router.post("/auth/send-verification", summary="Send email verification OTP")
def send_verification(body: EmailBody) -> dict:
    import logging
    from core.db import get_user_by_email, set_verify_token
    from core.notifications import send_otp_email
    user = get_user_by_email(body.email)
    if not user:
        return {"ok": True}   # don't reveal whether account exists
    if user.get("email_verified"):
        return {"ok": True, "already_verified": True}
    otp = _gen_otp()
    set_verify_token(user["id"], otp)
    smtp_ok = send_otp_email(user["email"], otp, purpose="verify")
    if not smtp_ok:
        logging.getLogger("auth").error("SMTP failed for verify OTP — user %s", body.email)
    return {"ok": True}


@router.post("/auth/verify-email", summary="Verify email with OTP")
def verify_email(body: OTPBody) -> dict:
    from core.db import (get_user_by_verify_token, verify_user_email, create_session,
                         is_otp_blocked, record_otp_failure, clear_otp_failures)
    from core.notifications import send_welcome_email
    if is_otp_blocked(body.email, "verify"):
        raise HTTPException(429, "Too many incorrect codes. Try again in 15 minutes.")
    user = get_user_by_verify_token(body.email, body.otp)
    if not user:
        record_otp_failure(body.email, "verify")
        raise HTTPException(400, "Invalid or expired code.")
    clear_otp_failures(body.email, "verify")
    verify_user_email(user["id"])
    token = create_session(user["id"])
    try:
        send_welcome_email(user["email"], user.get("full_name", ""))
    except Exception:
        pass
    return {"ok": True, "token": token, "user": _safe_user(user)}


@router.post("/auth/forgot-password", summary="Request password reset OTP")
def forgot_password(body: EmailBody) -> dict:
    import logging
    from core.db import get_user_by_email, set_reset_token
    from core.notifications import send_otp_email
    user = get_user_by_email(body.email)
    if not user:
        return {"ok": True}   # don't reveal whether account exists
    otp = _gen_otp()
    set_reset_token(user["id"], otp)
    smtp_ok = send_otp_email(user["email"], otp, purpose="reset")
    if not smtp_ok:
        logging.getLogger("auth").error("SMTP failed for reset OTP — user %s", body.email)
    return {"ok": True}


@router.post("/auth/reset-password", summary="Reset password with OTP")
def reset_password(body: ResetBody) -> dict:
    from core.db import (get_user_by_reset_token, update_user_password, create_session,
                         is_otp_blocked, record_otp_failure, clear_otp_failures)
    if len(body.new_password) < 8:
        raise HTTPException(422, "Password must be at least 8 characters.")
    if is_otp_blocked(body.email, "reset"):
        raise HTTPException(429, "Too many incorrect codes. Try again in 15 minutes.")
    user = get_user_by_reset_token(body.email, body.otp)
    if not user:
        record_otp_failure(body.email, "reset")
        raise HTTPException(400, "Invalid or expired reset code.")
    clear_otp_failures(body.email, "reset")
    update_user_password(user["id"], body.new_password)
    token = create_session(user["id"])
    return {"ok": True, "token": token, "user": _safe_user(user)}

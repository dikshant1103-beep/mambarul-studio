"""
core/middleware.py — FastAPI auth dependency (SQLite-backed).

Validates X-Session-Token (UI sessions) OR X-API-Key (external integrations).
Rate limiting: sliding window per API key (stored in SQLite).
Quota:         monthly call cap per API key (-1 = unlimited).
"""
from __future__ import annotations
from typing import Optional
from fastapi import Header, HTTPException, Request


async def require_auth(
    request:         Request,
    x_session_token: Optional[str] = Header(default=None),
    x_api_key:       Optional[str] = Header(default=None),
) -> dict:
    """
    FastAPI dependency — apply with Depends(require_auth).
    Sets request.state.auth and returns auth context dict.
    """
    # Session token (UI / dashboard)
    if x_session_token:
        from core.db import validate_session
        session = validate_session(x_session_token)
        if not session:
            raise HTTPException(401, "Session expired. Please sign in again.")
        ctx = {
            "type":  "session",
            "id":    x_session_token,
            "org":   session.get("org_id", ""),
            "role":  session.get("role", "member"),
            "email": session.get("email", ""),
        }
        request.state.auth = ctx
        return ctx

    # API key (external integrations / SDK)
    if x_api_key:
        from core.db import (get_api_key_by_raw, check_rate_limit,
                              check_quota, increment_key_usage)

        key_rec = get_api_key_by_raw(x_api_key)
        if not key_rec:
            raise HTTPException(401, "Invalid API key.")

        kid   = key_rec["id"]
        limit = key_rec.get("rate_limit_per_min", 100)
        quota = key_rec.get("monthly_quota", 10000)

        if not check_rate_limit(kid, limit):
            raise HTTPException(
                429,
                detail=f"Rate limit exceeded ({limit} req/min). Retry after 60s.",
                headers={"Retry-After": "60"},
            )
        if not check_quota(kid, quota):
            raise HTTPException(
                429,
                detail=f"Monthly quota exhausted ({quota} calls/month). Upgrade your plan.",
                headers={"Retry-After": "3600"},
            )

        increment_key_usage(kid)
        ctx = {
            "type":  "api_key",
            "id":    kid,
            "label": key_rec.get("label", ""),
            "org":   key_rec.get("org_name", ""),
            "role":  "member",
        }
        request.state.auth = ctx
        return ctx

    raise HTTPException(
        401,
        "Authentication required. Provide X-Session-Token (UI) or X-API-Key header.",
    )


async def require_admin(
    request:         Request,
    x_session_token: Optional[str] = Header(default=None),
    x_api_key:       Optional[str] = Header(default=None),
) -> dict:
    """Like require_auth but additionally enforces role == 'admin'."""
    ctx = await require_auth(request, x_session_token, x_api_key)
    if ctx.get("role") != "admin":
        raise HTTPException(403, "Admin access required.")
    return ctx

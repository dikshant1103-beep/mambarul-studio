"""
routers/keys.py — API key management (SQLite-backed).
All key data persisted in batteryos.db; no flat JSON file.
"""
from __future__ import annotations
from fastapi import APIRouter, HTTPException, Depends, Request
from pydantic import BaseModel, Field
from core.middleware import require_auth

router = APIRouter()


class KeyCreateRequest(BaseModel):
    label:              str = "My API Key"
    org_name:           str = ""
    rate_limit_per_min: int = Field(default=100, ge=1, le=10000)
    monthly_quota:      int = Field(default=10000, ge=-1,
                                    description="-1 = unlimited")


class KeyUpdateRequest(BaseModel):
    label:              str | None = None
    org_name:           str | None = None
    rate_limit_per_min: int | None = Field(default=None, ge=1, le=10000)
    monthly_quota:      int | None = Field(default=None, ge=-1)


@router.get("/keys", summary="List API keys")
def list_keys(request: Request,
              _auth: dict = Depends(require_auth)) -> list[dict]:
    from core.db import list_api_keys
    org_id = _auth.get("org", "") if _auth.get("type") == "session" else ""
    return list_api_keys(org_id=org_id)


@router.post("/keys", summary="Generate a new API key")
def create_key(body: KeyCreateRequest,
               _auth: dict = Depends(require_auth)) -> dict:
    from core.db import create_api_key
    org_id = _auth.get("org", "default")
    return create_api_key(
        label=body.label.strip() or "Unnamed Key",
        org_id=org_id,
        org_name=body.org_name.strip(),
        rate_limit=body.rate_limit_per_min,
        monthly_quota=body.monthly_quota,
    )


@router.patch("/keys/{key_id}", summary="Update key settings")
def update_key(key_id: str, body: KeyUpdateRequest,
               _auth: dict = Depends(require_auth)) -> dict:
    from core.db import update_api_key
    fields = {}
    if body.label              is not None: fields["label"]             = body.label.strip()
    if body.org_name           is not None: fields["org_name"]          = body.org_name.strip()
    if body.rate_limit_per_min is not None: fields["rate_limit_per_min"]= body.rate_limit_per_min
    if body.monthly_quota      is not None: fields["monthly_quota"]     = body.monthly_quota
    if not update_api_key(key_id, **fields):
        raise HTTPException(404, f"Key '{key_id}' not found.")
    return {"ok": True}


@router.delete("/keys/{key_id}", summary="Revoke an API key")
def revoke_key(key_id: str,
               _auth: dict = Depends(require_auth)) -> dict:
    from core.db import delete_api_key
    if not delete_api_key(key_id):
        raise HTTPException(404, f"Key '{key_id}' not found.")
    return {"deleted": True, "key_id": key_id}

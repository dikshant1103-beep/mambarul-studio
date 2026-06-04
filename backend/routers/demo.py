"""
routers/demo.py — Seed a realistic demo fleet (admin only).

POST /api/demo/seed   populate telemetry + predictions + alerts for a demo fleet
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, Field

router = APIRouter()


class SeedRequest(BaseModel):
    n_cells:  int = Field(12, ge=2, le=200)
    model_id: str = "v10-final"


# Auth is enforced at the router-group level (dependencies=_auth). Any signed-in
# user may seed demo data into their own instance (used by first-run onboarding).
@router.post("/demo/seed", summary="Seed a realistic demo fleet (telemetry, predictions, alerts)")
def seed(req: SeedRequest) -> dict:
    from core.demo_seed import seed_demo_fleet
    return seed_demo_fleet(n_cells=req.n_cells, model_id=req.model_id)

"""
routers/grading.py — Battery grading API.

Wraps core/second_life.assess_cell() with a prediction-friendly interface:
  - soh_pct (0–100) instead of soh (0–1)
  - predicted_rul directly from /api/predict output
  - combined predict-then-grade in one call

Endpoints:
  POST /api/grade                       grade single battery
  POST /api/grade/batch                 grade up to 500 batteries
  POST /api/grade/predict-and-grade     run RUL prediction then grade
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from core.middleware import require_auth

router = APIRouter()


# ── Request models ────────────────────────────────────────────────────────────

class GradeRequest(BaseModel):
    label:         str   = Field("cell", description="Battery / cell identifier")
    chemistry:     str   = Field("NMC",  description="LCO | LFP | NMC | NCM | NCA")
    soh_pct:       float = Field(..., ge=0, le=100, description="State-of-Health (0–100 %)")
    predicted_rul: Optional[float] = Field(None, ge=0,
        description="Predicted RUL in cycles. If omitted, estimated from SOH fade curve.")
    int_resistance: Optional[float] = Field(None, ge=0,
        description="Internal resistance in Ω. Omit if unknown.")
    n_cycles:       Optional[int]   = Field(None, ge=0,
        description="Total charge/discharge cycles completed.")
    capacity_ah:    Optional[float] = Field(None, ge=0,
        description="Nameplate capacity in Ah (used for value calculation).")
    voltage_v:      Optional[float] = Field(3.6, ge=2.0, le=5.0,
        description="Nominal cell voltage in V (used for kWh / value calculation).")
    fade_rate_pct_per_100: Optional[float] = Field(None, ge=0,
        description="Capacity fade rate: % SOH lost per 100 cycles.")


class PredictThenGradeRequest(BaseModel):
    label:          str   = Field("cell")
    chemistry:      str   = Field("NMC")
    soh_pct:        float = Field(..., ge=0, le=100,
        description="State-of-Health (0–100 %) — used both as predict input and grading basis.")
    int_resistance: Optional[float] = Field(None, ge=0)
    n_cycles:       Optional[int]   = Field(None, ge=0)
    capacity_ah:    Optional[float] = Field(None, ge=0)
    temperature:    Optional[float] = Field(None,
        description="Cell temperature in °C (improves RUL prediction accuracy).")
    voltage_v:      Optional[float] = Field(3.6, ge=2.0, le=5.0)
    model_id:       str   = Field("v10-final",
        description="Which ML model to use for RUL prediction.")
    fade_rate_pct_per_100: Optional[float] = Field(None, ge=0)


# ── Core helper ───────────────────────────────────────────────────────────────

def _estimate_rul_from_soh(soh_pct: float) -> float:
    """Conservative RUL estimate when no prediction is available."""
    if soh_pct >= 80:
        return max(0, (soh_pct - 80) * 20 + 200)
    elif soh_pct >= 65:
        return max(0, (soh_pct - 65) / 15 * 150 + 50)
    elif soh_pct >= 50:
        return max(0, (soh_pct - 50) / 15 * 50)
    return 0.0


def _grade_one(req: GradeRequest) -> dict:
    from core.second_life import assess_cell

    rul = float(req.predicted_rul) if req.predicted_rul is not None \
        else _estimate_rul_from_soh(req.soh_pct)

    result = assess_cell(
        soh            = req.soh_pct / 100,
        rul_cycles     = rul,
        chemistry      = req.chemistry,
        ir             = req.int_resistance or 0.0,
        cycles         = req.n_cycles or 0,
        capacity_ah    = req.capacity_ah or 0.0,
        voltage_v      = req.voltage_v or 3.6,
        cell_id        = req.label,
        capacity_fade_rate = req.fade_rate_pct_per_100 or 0.0,
    )
    result["label"] = result.pop("cell_id", req.label)
    result["rul_source"] = "provided" if req.predicted_rul is not None else "estimated_from_soh"
    return result


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post(
    "/grade",
    summary="Grade a single battery (A/B/C/D) for second-life placement",
    dependencies=[Depends(require_auth)],
)
def grade_single(req: GradeRequest) -> dict:
    """
    Grade one battery based on SOH%, chemistry, and optional RUL/IR/cycles.

    Returns grade (A/B/C/D), score (0–100), suitable second-life applications,
    estimated residual value (USD), risk flags, and recommended tests.
    """
    return _grade_one(req)


@router.post(
    "/grade/batch",
    summary="Grade up to 500 batteries in one call",
    dependencies=[Depends(require_auth)],
)
def grade_batch(requests: list[GradeRequest]) -> list[dict]:
    """
    Batch grading — ideal for fleet snapshot CSVs.
    Each row independently graded; errors isolated per row.
    """
    if len(requests) > 500:
        requests = requests[:500]

    results = []
    for req in requests:
        try:
            results.append(_grade_one(req))
        except Exception as exc:
            results.append({
                "label":   req.label,
                "grade":   None,
                "score":   None,
                "error":   str(exc),
            })
    return results


@router.post(
    "/grade/predict-and-grade",
    summary="Run RUL prediction then grade — single-call workflow",
    dependencies=[Depends(require_auth)],
)
def predict_and_grade(req: PredictThenGradeRequest, request: Request) -> dict:
    """
    Combined predict → grade pipeline.

    1. Runs /api/predict with the provided features to get predicted_rul + CI.
    2. Feeds predicted_rul into the second-life grading engine.

    Returns the full grading result plus a `prediction` block with RUL + CI.
    """
    from schemas.models import PredictRequest
    from routers.predict import predict as single_predict

    pred_req = PredictRequest(
        model_id       = req.model_id,
        chemistry      = req.chemistry,
        cap_pct        = req.soh_pct / 100,
        soh_pct        = req.soh_pct,
        int_resistance = req.int_resistance,
        n_cycles       = req.n_cycles,
        capacity       = req.capacity_ah,
        temperature    = req.temperature,
    )
    pred = single_predict(pred_req, request)

    grade_req = GradeRequest(
        label          = req.label,
        chemistry      = req.chemistry,
        soh_pct        = req.soh_pct,
        predicted_rul  = pred.get("predicted_rul"),
        int_resistance = req.int_resistance,
        n_cycles       = req.n_cycles,
        capacity_ah    = req.capacity_ah,
        voltage_v      = req.voltage_v,
        fade_rate_pct_per_100 = req.fade_rate_pct_per_100,
    )
    grade = _grade_one(grade_req)

    return {
        **grade,
        "prediction": {
            "predicted_rul": pred.get("predicted_rul"),
            "lower_90":      pred.get("lower_90"),
            "upper_90":      pred.get("upper_90"),
            "phase":         pred.get("phase"),
            "model":         pred.get("model", req.model_id),
            "confidence_pct": pred.get("confidence_pct"),
        },
    }

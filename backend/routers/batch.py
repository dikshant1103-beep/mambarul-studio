"""
routers/batch.py — Batch RUL prediction.
POST /api/predict/batch  accepts a JSON array of predict-request objects.
Also auto-generates alerts for Near-EOL / Knee phase cells.
"""
from __future__ import annotations
from typing import Any
from fastapi import APIRouter, Depends, Request
from schemas.models import PredictRequest
from routers.predict import predict as single_predict
from core.middleware import require_auth

router = APIRouter()

_ALERT_PHASES = {"Near-EOL", "Knee"}


@router.post("/predict/batch", summary="Batch RUL prediction — up to 500 cells",
             dependencies=[Depends(require_auth)])
def predict_batch(requests: list[PredictRequest], request: Request) -> list[dict[str, Any]]:
    """
    Run RUL prediction for multiple cells in one call.
    Automatically records alerts for Near-EOL and Knee phase cells.
    """
    if len(requests) > 500:
        requests = requests[:500]

    results = []
    for i, req in enumerate(requests):
        try:
            res = single_predict(req, request)
            res["row_index"] = i
            results.append(res)
        except Exception as exc:
            results.append({
                "row_index": i,
                "error": str(exc),
                "predicted_rul": None,
            })

    # Record alerts for critical-phase results and send email (best-effort)
    try:
        from core.analytics import record_alert
        from core.notifications import try_send_alert_email
        auth     = getattr(request.state, 'auth', {})
        org      = auth.get("org", "") if auth.get("type") == "api_key" else ""
        req_list = [r.model_dump() for r in requests]
        new_alerts: list[dict] = []
        for i, res in enumerate(results):
            if res.get("phase") in _ALERT_PHASES and res.get("predicted_rul") is not None:
                req_data = req_list[i] if i < len(req_list) else {}
                chem  = res.get("chemistry", req_data.get("chemistry", "UNK"))
                soh   = req_data.get("soh_pct", 0.0)
                rul   = res.get("predicted_rul", 0.0)
                phase = res.get("phase", "Unknown")
                label = f"Row {i + 1}"
                record_alert(chemistry=chem, soh=soh, rul=rul, phase=phase,
                             label=label, source="batch", org=org)
                new_alerts.append({"chem": chem, "soh": soh, "rul": rul,
                                   "phase": phase, "label": label})
        if new_alerts:
            try_send_alert_email(new_alerts)
    except Exception:
        pass

    return results

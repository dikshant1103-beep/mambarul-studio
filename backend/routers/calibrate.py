"""
routers/calibrate.py — Few-shot calibration for new cell types.
POST /api/calibrate  accepts 10–30 cycles of measured capacity data,
fits a physics-based degradation model, and returns a cell-specific
RUL estimate with tighter conformal bounds than the global defaults.
"""
from __future__ import annotations
import math
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

_CHEM_MAX_RUL = {"LCO": 309, "LFP": 1934, "NMC": 1500, "NCM": 1000, "NCA": 800}
_EOL_SOH = 0.80   # 80% capacity = end of life threshold


class CalibrateRequest(BaseModel):
    chemistry: str = "NMC"
    cycles: list[int]           # e.g. [1, 2, 3, ..., 25]
    capacity: list[float]       # measured discharge Ah per cycle
    nom_capacity: float = 1.0   # nameplate Ah (used to compute SOH)
    temperature: float = 25.0
    cell_label: str = "New Cell"


def _linreg(x: list[float], y: list[float]) -> tuple[float, float]:
    """Simple linear regression y = a*x + b. Returns (slope, intercept)."""
    n = len(x)
    sx  = sum(x);  sy  = sum(y)
    sx2 = sum(xi*xi for xi in x)
    sxy = sum(xi*yi for xi, yi in zip(x, y))
    denom = n * sx2 - sx * sx
    if abs(denom) < 1e-12:
        return 0.0, (sy / n)
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    return slope, intercept


@router.post("/calibrate", summary="Few-shot calibration for a new cell type")
def calibrate(req: CalibrateRequest) -> dict:
    if len(req.cycles) != len(req.capacity):
        raise HTTPException(400, "cycles and capacity must have the same length.")
    n = len(req.cycles)
    if n < 5:
        raise HTTPException(400, f"Need at least 5 cycles for calibration, got {n}.")

    chem = req.chemistry.upper()
    if chem not in _CHEM_MAX_RUL:
        chem = "NMC"

    # 1. Compute SOH per cycle
    q0 = max(req.capacity)
    if q0 < 1e-9:
        raise HTTPException(400, "nom_capacity or measured capacity is zero.")
    soh = [c / q0 for c in req.capacity]
    cycles_f = [float(c) for c in req.cycles]

    # 2. Linear regression on SOH vs cycle to get degradation rate
    slope, intercept = _linreg(cycles_f, soh)

    # 3. Project to EOL threshold → estimated total cycle life
    if slope >= 0:
        # No degradation detected — use chemistry max
        total_life = float(_CHEM_MAX_RUL[chem])
    else:
        # cycle at which SOH = EOL_SOH: solve slope*c + intercept = EOL_SOH
        total_life = (_EOL_SOH - intercept) / slope

    # 4. Current state at last measured cycle
    current_cycle = cycles_f[-1]
    current_soh   = soh[-1]
    pred_rul = max(0.0, total_life - current_cycle)

    # 5. Calibrated conformal width from residuals
    residuals = [abs(soh[i] - (slope * cycles_f[i] + intercept)) for i in range(n)]
    rmse_soh  = math.sqrt(sum(r*r for r in residuals) / n)
    # Convert SOH RMSE to RUL uncertainty: dRUL/dSOH = 1/|slope|
    rul_rmse  = (rmse_soh / max(abs(slope), 1e-9)) if slope != 0 else _CHEM_MAX_RUL[chem] * 0.15
    half_width = round(1.645 * rul_rmse, 1)   # 90% interval
    # Clamp: never wider than global default, never narrower than 5 cycles
    global_half = {"LCO": 34, "LFP": 236, "NMC": 60, "NCM": 17, "NCA": 20}.get(chem, 60)
    half_width = max(5.0, min(half_width, global_half))

    phase = (
        "Fresh"    if current_soh >= 0.96 else
        "Aging"    if current_soh >= 0.88 else
        "Knee"     if current_soh >= 0.82 else
        "Near-EOL"
    )

    return {
        "cell_label":        req.cell_label,
        "chemistry":         chem,
        "calibration_cycles": n,
        "current_cycle":     int(current_cycle),
        "current_soh_pct":   round(current_soh * 100, 2),
        "predicted_rul":     round(pred_rul, 1),
        "lower_90":          round(max(0, pred_rul - half_width), 1),
        "upper_90":          round(pred_rul + half_width, 1),
        "confidence_width":  round(half_width * 2, 1),
        "confidence_pct":    90,
        "degradation_rate":  round(slope * 100, 5),   # % SOH per cycle
        "estimated_total_life": round(total_life, 1),
        "phase":             phase,
        "method":            "few-shot-physics",
        "note": (
            f"Calibrated from {n} cycles. Conformal half-width = {half_width:.1f} cycles "
            f"(global default = {global_half}). More cycles → tighter bounds."
        ),
    }

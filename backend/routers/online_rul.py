"""
routers/online_rul.py — Online RUL trend and CI endpoints

GET /api/rul/trend/{cell_id}
    Returns per-cycle RUL history, linear trend fit, acceleration alerts,
    and the current per-cell CI half-width (Layer 3).

GET /api/rul/ci
    Returns all cached per-cell CI half-widths (diagnostic / fleet view).
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from core.middleware import require_auth

router = APIRouter()


@router.get("/rul/trend/{cell_id}", dependencies=[Depends(require_auth)])
def get_rul_trend(cell_id: str, limit: int = 200) -> dict:
    """
    Per-cell RUL trend: history + linear fit + Layer 3 CI + recent alerts.

    Useful for the Fleet View cell detail panel and Digital Twin.
    """
    import numpy as np
    from core.db import get_rul_history, _conn
    from core.online_rul import get_cell_ci, MIN_HISTORY, ACCEL_WINDOW

    rows = get_rul_history(cell_id, limit=limit)
    if not rows:
        raise HTTPException(status_code=404, detail=f"No RUL history for cell '{cell_id}'")

    rows = sorted(rows, key=lambda r: r["cycle_num"])
    cycles = [r["cycle_num"] for r in rows]
    ruls   = [r["rul"]       for r in rows]

    response: dict = {
        "cell_id":     cell_id,
        "n_cycles":    len(rows),
        "history":     [{"cycle": r["cycle_num"], "rul": r["rul"],
                         "rul_lower": r["rul_lower"], "rul_upper": r["rul_upper"],
                         "soh_pct": r["soh_pct"]} for r in rows],
    }

    # Linear trend fit
    if len(rows) >= MIN_HISTORY:
        cyc_arr = np.array(cycles, dtype=np.float64)
        rul_arr = np.array(ruls,   dtype=np.float64)
        A = np.column_stack([np.ones(len(cyc_arr)), cyc_arr])
        coeffs, _, _, _ = np.linalg.lstsq(A, rul_arr, rcond=None)
        a, b = float(coeffs[0]), float(coeffs[1])
        response["trend"] = {
            "intercept":    round(a, 2),
            "slope":        round(b, 4),
            "slope_note":   "cycles of RUL per cycle (negative = degrading)",
            "fitted_ruls":  [round(float(a + b * c), 1) for c in cycles],
        }

    # Layer 3: per-cell CI
    ci = get_cell_ci(cell_id)
    response["layer3_ci"] = {
        "half_width":  round(ci, 1) if ci is not None else None,
        "source":      "per-cell (Layer 3)" if ci is not None else "not yet available",
        "min_cycles_needed": MIN_HISTORY,
    }

    # Recent fade_acceleration alerts for this cell
    try:
        with _conn() as con:
            alert_rows = con.execute(
                "SELECT cycle, severity, value, expected, deviation_sigma, description, detected_at "
                "FROM anomaly_events "
                "WHERE cell_id=? AND anomaly_type='fade_acceleration' "
                "ORDER BY detected_at DESC LIMIT 20",
                (cell_id,),
            ).fetchall()
        response["fade_alerts"] = [dict(r) for r in alert_rows]
    except Exception:
        response["fade_alerts"] = []

    return response


@router.get("/rul/layer4/status", dependencies=[Depends(require_auth)])
def get_layer4_status() -> dict:
    """Return Layer 4 EWC online fine-tuning status."""
    from core.ewc_trainer import get_status
    from core import replay_buffer as _rb
    s = get_status()
    s["replay_buffer"] = _rb.status()
    return s


@router.get("/rul/layer4/replay/status", dependencies=[Depends(require_auth)])
def get_replay_status() -> dict:
    """Return cross-cell experience replay buffer status (Layer 4 add-on)."""
    from core import replay_buffer as _rb
    return _rb.status()


@router.post("/rul/layer4/replay/persist", dependencies=[Depends(require_auth)])
def persist_replay() -> dict:
    """Force-write the in-memory replay buffer to disk."""
    from core import replay_buffer as _rb
    p = _rb.persist()
    return {"persisted_to": str(p), "exists": p.exists()}


@router.get("/rul/layer4/twin-rul/{cell_id}", dependencies=[Depends(require_auth)])
def get_twin_rul_endpoint(cell_id: str, cycle_num: int = 0) -> dict:
    """
    Physics-based (Layer 3.5) RUL estimate for a cell from its digital twin.
    Returns {rul, rul_lower, rul_upper, eol_cycle, source, r2} or 404.
    """
    from core.digital_twin import get_twin_rul
    result = get_twin_rul(cell_id, cycle_num)
    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"No digital twin available for cell '{cell_id}'",
        )
    return result


@router.get("/rul/streaming/status", dependencies=[Depends(require_auth)])
def get_streaming_status() -> dict:
    """Return Kafka streaming processor status (incl. windowed aggregation state)."""
    from core.streaming_processor import get_status
    return get_status()


@router.get("/rul/streaming/aggregates", dependencies=[Depends(require_auth)])
def get_streaming_aggregates(cell_id: str | None = None, limit: int = 20) -> dict:
    """Recent tumbling-window aggregates (per-cell roll-ups of V/I/T/SOC)."""
    from core.streaming_processor import get_aggregates
    return {"aggregates": get_aggregates(cell_id=cell_id, limit=limit)}


@router.get("/rul/ci", dependencies=[Depends(require_auth)])
def get_all_cis() -> dict:
    """
    Return all cached per-cell CI half-widths (Layer 3).

    Global chemistry CIs are included for comparison.
    Returns the tighter of per-cell vs global for each cell.
    """
    from core.online_rul import get_all_cell_cis
    from routers.predict import _CONFORMAL_90

    cell_cis = get_all_cell_cis()
    entries = []
    for cell_id, ci in sorted(cell_cis.items()):
        entries.append({
            "cell_id":    cell_id,
            "ci_half":    round(ci, 1),
            "ci_source":  "per-cell (Layer 3)",
        })

    return {
        "per_cell":     entries,
        "global_ci":    {k: round(v, 1) for k, v in _CONFORMAL_90.items()},
        "n_cells":      len(entries),
        "note": (
            "per-cell CI replaces global CI in /predict when cell_id is provided "
            "and ≥10 cycles of history are available."
        ),
    }

"""
core/online_rul.py — Online RUL Layers 2 & 3

Layer 2 — Fade Acceleration Detection:
  After each persisted cycle, compare the recent RUL decline slope to the
  historical slope. Fire anomaly_type='fade_acceleration' when the recent
  rate exceeds ACCEL_THRESHOLD × historical rate.

Layer 3 — Per-Cell CI Tightening:
  Once MIN_HISTORY cycles are available, replace the global chemistry CI
  with the 90th-percentile absolute residual from the per-cell linear trend.
  Tightens for well-behaved cells, widens for noisy ones — both correctly.
"""
from __future__ import annotations
import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

MIN_HISTORY     = 10   # minimum persisted cycles before any analysis
ACCEL_WINDOW    = 5    # "recent" window for slope comparison
ACCEL_THRESHOLD = 1.5  # alert when recent fade rate ≥ 1.5× historical rate
CI_QUANTILE     = 0.90 # 90th percentile of |residuals| → CI half-width
ALERT_COOLDOWN  = 20   # don't re-fire fade_acceleration within N cycles
TWIN_MIN_R2     = 0.85 # minimum twin fit R² to use as Layer 3.5 signal
TWIN_BLEND_W    = 0.30 # weight given to twin CI vs ML CI in layer-3.5 blend

# In-process caches (survive for the life of the backend process)
_cell_ci:    dict[str, float] = {}  # cell_id → per-cell 90% CI half-width (Layer 3)
_cell_ci_l35: dict[str, float] = {} # cell_id → CI half-width after Layer 3.5 twin blend
_last_alert: dict[str, int]   = {}  # cell_id → cycle of last fade_acceleration alert
_lock = threading.Lock()


# ── Internal helpers ──────────────────────────────────────────────────────────

def _linear_fit(cycles: np.ndarray, ruls: np.ndarray) -> tuple[float, float, np.ndarray]:
    """OLS: RUL = a + b*cycle.  Returns (intercept, slope, residuals)."""
    if len(cycles) < 2:
        return float(ruls[0]), 0.0, np.zeros(len(ruls))
    A = np.column_stack([np.ones(len(cycles)), cycles])
    coeffs, _, _, _ = np.linalg.lstsq(A, ruls, rcond=None)
    a, b = float(coeffs[0]), float(coeffs[1])
    residuals = ruls - (a + b * cycles)
    return a, b, residuals


def _fire_alert(cell_id: str, chemistry: str, cycle_num: int,
                anomaly_type: str, severity: str,
                value: float, expected: float, deviation_sigma: float,
                description: str) -> None:
    """Write to anomaly_events + publish Kafka event (both best-effort)."""
    try:
        from core.db import _conn
        now = datetime.now(timezone.utc).isoformat()
        with _conn() as con:
            con.execute(
                "INSERT OR IGNORE INTO anomaly_events "
                "(id, cell_id, chemistry, anomaly_type, severity, "
                " cycle, value, expected, deviation_sigma, description, detected_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), cell_id, chemistry.upper(),
                 anomaly_type, severity, cycle_num,
                 round(value, 4), round(expected, 4), round(deviation_sigma, 3),
                 description, now),
            )
        logger.info("online_rul alert: cell=%s type=%s cycle=%d ratio=%.2f",
                    cell_id, anomaly_type, cycle_num, deviation_sigma)
    except Exception as exc:
        logger.debug("online_rul alert insert failed: %s", exc)

    try:
        from core.kafka_client import publish
        publish("rul_alerts", {
            "cell_id":      cell_id,
            "chemistry":    chemistry,
            "anomaly_type": anomaly_type,
            "severity":     severity,
            "cycle":        cycle_num,
            "value":        value,
        })
    except Exception:
        pass


# ── Public API ────────────────────────────────────────────────────────────────

def run_online_analysis(cell_id: str, cycle_num: int, chemistry: str) -> None:
    """
    Run Layer 2 + Layer 3 analysis for one cell after a cycle is persisted.
    Designed to be called from a background daemon thread — never blocks the
    telemetry pipeline.
    """
    try:
        from core.db import get_rul_history
        rows = get_rul_history(cell_id, limit=200)
    except Exception as exc:
        logger.debug("online_rul: history fetch failed for %s: %s", cell_id, exc)
        return

    if len(rows) < MIN_HISTORY:
        return

    # get_rul_history returns newest-first; sort ascending by cycle
    rows = sorted(rows, key=lambda r: r["cycle_num"])
    cycles = np.array([r["cycle_num"] for r in rows], dtype=np.float64)
    ruls   = np.array([r["rul"]       for r in rows], dtype=np.float64)

    # ── Layer 3: per-cell CI tightening ──────────────────────────────────────
    _, _, residuals = _linear_fit(cycles, ruls)
    ci_half = float(np.quantile(np.abs(residuals), CI_QUANTILE))
    with _lock:
        _cell_ci[cell_id] = ci_half
    logger.debug("Layer3: cell=%s ci=±%.1f (n=%d cycles)", cell_id, ci_half, len(rows))

    # ── Layer 3.5: physics twin CI refinement ─────────────────────────────────
    # Blend the analytical digital-twin CI with the Layer-3 residual CI.
    # If the twin has high fit R² the blend tightens or widens the CI based on
    # whether the physics model and ML model agree on the degradation trajectory.
    try:
        from core.digital_twin import get_twin_rul
        latest_rul = float(ruls[-1])
        twin = get_twin_rul(cell_id, int(cycles[-1]))
        if twin is not None and (twin.get("r2") or 0.0) >= TWIN_MIN_R2:
            twin_rul    = float(twin["rul"])
            twin_ci     = float(twin["rul_upper"] - twin["rul_lower"]) / 2.0
            # Agreement ratio: 1.0 = identical, >1 = disagreement
            divergence  = abs(latest_rul - twin_rul) / max(abs(twin_rul), 1.0)
            # Blend: weight twin CI by TWIN_BLEND_W, penalise for divergence
            agreement_w = max(0.0, 1.0 - divergence)
            blended_ci  = (
                (1.0 - TWIN_BLEND_W) * ci_half
                + TWIN_BLEND_W * twin_ci * (1.0 + divergence)
            ) * (1.0 + 0.1 * (1.0 - agreement_w))
            blended_ci  = max(blended_ci, ci_half * 0.5)   # never tighten >50%
            with _lock:
                _cell_ci_l35[cell_id] = round(blended_ci, 2)
            logger.debug(
                "Layer3.5: cell=%s twin_rul=%.0f ml_rul=%.0f div=%.2f ci_l3=%.1f ci_l35=%.1f",
                cell_id, twin_rul, latest_rul, divergence, ci_half, blended_ci,
            )
    except Exception as exc:
        logger.debug("Layer3.5 failed for %s: %s", cell_id, exc)

    # ── Layer 2: fade acceleration ────────────────────────────────────────────
    if len(rows) < ACCEL_WINDOW + MIN_HISTORY:
        return  # need enough history to split into historical + recent windows

    hist_cycles = cycles[:-ACCEL_WINDOW]
    hist_ruls   = ruls[:-ACCEL_WINDOW]
    _, b_hist, _ = _linear_fit(hist_cycles, hist_ruls)

    rec_cycles = cycles[-ACCEL_WINDOW:]
    rec_ruls   = ruls[-ACCEL_WINDOW:]
    _, b_rec, _ = _linear_fit(rec_cycles, rec_ruls)

    # Both slopes are negative (RUL decreasing); compare absolute degradation rates
    abs_hist = abs(b_hist)
    abs_rec  = abs(b_rec)

    if abs_hist < 1e-6:
        return  # flat historical trend — ratio undefined

    ratio = abs_rec / abs_hist

    if ratio >= ACCEL_THRESHOLD:
        with _lock:
            last_fired = _last_alert.get(cell_id, -9999)
            if cycle_num - last_fired < ALERT_COOLDOWN:
                return
            _last_alert[cell_id] = cycle_num

        severity = "critical" if ratio >= 3.0 else "warning"
        description = (
            f"RUL fade rate accelerated {ratio:.1f}× vs historical baseline. "
            f"Recent slope: {b_rec:.2f} cycles/cycle over last {ACCEL_WINDOW} cycles; "
            f"historical: {b_hist:.2f} cycles/cycle."
        )
        _fire_alert(
            cell_id        = cell_id,
            chemistry      = chemistry,
            cycle_num      = cycle_num,
            anomaly_type   = "fade_acceleration",
            severity       = severity,
            value          = round(abs_rec, 4),
            expected       = round(abs_hist, 4),
            deviation_sigma= round(ratio, 3),
            description    = description,
        )


def get_cell_ci(cell_id: str) -> Optional[float]:
    """
    Return the best available per-cell CI half-width (Layer 3.5 > Layer 3).
    Returns None when there is not enough history yet.
    Callers should fall back to the global chemistry CI when None is returned.
    """
    with _lock:
        return _cell_ci_l35.get(cell_id) or _cell_ci.get(cell_id)


def get_all_cell_cis() -> dict[str, float]:
    """Return a copy of all cached per-cell CIs (Layer 3.5 when available, else Layer 3)."""
    with _lock:
        merged = dict(_cell_ci)
        merged.update(_cell_ci_l35)  # Layer 3.5 overrides Layer 3 when present
        return merged

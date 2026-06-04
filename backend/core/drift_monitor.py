"""
core/drift_monitor.py — Prediction-distribution drift monitoring via Evidently.

Detects shifts in the RUL prediction distribution (output drift) and, when
feature data is available, in input feature distributions (data drift).

Reference dataset: built from the loaded training dataset on first call.
Current dataset:   last N rows from analytics_calls table (live predictions).

Results are cached for CACHE_TTL seconds to avoid re-running on every poll.
"""
from __future__ import annotations

import logging
import time
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_ref_df: pd.DataFrame | None = None
_cache: dict = {}
_cache_ts: float = 0.0
CACHE_TTL = 3600   # 1 hour


# ── Reference dataset ─────────────────────────────────────────────────────────

def _build_reference() -> pd.DataFrame | None:
    """
    Build reference DataFrame from the loaded training dataset.
    Uses per-cell last-cycle features: SOH, capacity, IR, temperature.
    Returns None if dataset is not loaded.
    """
    try:
        import core.data_loader as dl
        if dl._meta_df is None or dl._features is None:
            return None

        meta = dl._meta_df
        records = []
        for cell_id, grp in meta.groupby("cell_id"):
            grp_sorted = grp.sort_values("cycle")
            ridx = grp_sorted.index.values
            if len(ridx) < 5:
                continue
            last_i = ridx[-1]
            chemistry = str(grp_sorted["chemistry_name"].iloc[0])
            cap = float(dl._features[last_i, 0])
            soh = float(dl._features[last_i, 9])
            ir  = float(dl._features[last_i, 7])
            tmp = float(dl._features[last_i, 5])
            n_cycles = int(grp_sorted["cycle"].iloc[-1])

            soh_vals = dl._features[ridx, 9]
            fade = max(0.0, float(soh_vals[0] - soh_vals[-1])) / max(n_cycles, 1)
            rul = int((soh - 0.80) / (fade + 1e-9)) if fade > 0 else 1000
            rul = max(0, min(rul, 3000))

            records.append({
                "chemistry": chemistry,
                "soh":       round(soh, 4),
                "capacity":  round(cap, 4),
                "ir":        round(ir, 4),
                "temp":      round(tmp, 1),
                "rul":       rul,
            })

        if not records:
            return None
        return pd.DataFrame(records)
    except Exception as exc:
        logger.debug("drift_monitor: reference build failed: %s", exc)
        return None


def _get_reference() -> pd.DataFrame | None:
    global _ref_df
    if _ref_df is None:
        _ref_df = _build_reference()
    return _ref_df


# ── Current dataset (recent predictions) ─────────────────────────────────────

def _get_current(n: int = 500) -> pd.DataFrame | None:
    """Fetch last n rows from analytics_calls as current prediction distribution."""
    try:
        from core.db import _conn
        with _conn() as con:
            rows = con.execute(
                "SELECT chemistry, rul, phase FROM analytics_calls "
                "ORDER BY ts DESC LIMIT ?", (n,)
            ).fetchall()
        if not rows:
            return None
        df = pd.DataFrame([dict(r) for r in rows])
        df["rul"] = pd.to_numeric(df["rul"], errors="coerce")
        return df.dropna(subset=["rul"])
    except Exception as exc:
        logger.debug("drift_monitor: current fetch failed: %s", exc)
        return None


# ── Drift report ──────────────────────────────────────────────────────────────

def run_drift_check(n_current: int = 500, force: bool = False) -> dict:
    """
    Run Evidently data drift check. Returns a summary dict.
    Result is cached for CACHE_TTL seconds unless force=True.
    """
    global _cache, _cache_ts

    if not force and _cache and (time.time() - _cache_ts) < CACHE_TTL:
        return _cache

    ref = _get_reference()
    cur = _get_current(n_current)

    if ref is None:
        return _no_data_result("Reference dataset not loaded")
    if cur is None or len(cur) < 30:
        return _no_data_result(
            f"Insufficient current data ({len(cur) if cur is not None else 0} rows; need ≥30)"
        )

    # Common columns only
    common = [c for c in ["chemistry", "rul"] if c in ref.columns and c in cur.columns]
    ref_sub = ref[common].copy()
    cur_sub = cur[common].copy()

    try:
        from evidently.report import Report
        from evidently.metric_preset import DataDriftPreset

        report = Report(metrics=[DataDriftPreset()])
        report.run(reference_data=ref_sub, current_data=cur_sub)
        rd = report.as_dict()

        metrics = rd.get("metrics", [])
        drift_info = next(
            (m["result"] for m in metrics
             if m.get("metric") == "DatasetDriftMetric"), {}
        )

        n_drifted   = int(drift_info.get("number_of_drifted_columns", 0))
        n_total     = int(drift_info.get("number_of_columns", len(common)))
        share       = float(drift_info.get("share_of_drifted_columns", 0.0))
        dataset_drift = bool(drift_info.get("dataset_drift", False))

        per_col = {}
        for m in metrics:
            if m.get("metric") == "ColumnDriftMetric":
                col = m["result"].get("column_name", "?")
                per_col[col] = {
                    "drift_detected": bool(m["result"].get("drift_detected", False)),
                    "stattest":       m["result"].get("stattest_name", ""),
                    "p_value":        round(float(m["result"].get("p_value", 1.0)), 4),
                    "drift_score":    round(float(m["result"].get("drift_score", 0.0)), 4),
                }

        result = {
            "ok":              True,
            "dataset_drift":   dataset_drift,
            "n_drifted":       n_drifted,
            "n_columns":       n_total,
            "drift_share":     round(share, 3),
            "per_column":      per_col,
            "n_reference":     len(ref_sub),
            "n_current":       len(cur_sub),
            "checked_at":      time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

    except ImportError:
        # Evidently not installed — fall back to scipy KS test
        result = _ks_fallback(ref_sub, cur_sub)
    except Exception as exc:
        logger.warning("Evidently drift check failed: %s", exc)
        result = {"ok": False, "error": str(exc)[:200]}

    _cache    = result
    _cache_ts = time.time()
    return result


def _ks_fallback(ref: pd.DataFrame, cur: pd.DataFrame) -> dict:
    """Fallback to scipy KS test when Evidently is not installed."""
    from scipy.stats import ks_2samp
    per_col = {}
    n_drifted = 0
    for col in ref.select_dtypes(include=[np.number]).columns:
        if col not in cur.columns:
            continue
        stat, pval = ks_2samp(ref[col].dropna(), cur[col].dropna())
        drifted = pval < 0.05
        n_drifted += int(drifted)
        per_col[col] = {
            "drift_detected": drifted,
            "stattest":       "ks_2samp",
            "p_value":        round(float(pval), 4),
            "drift_score":    round(float(stat), 4),
        }
    n_total = len(per_col)
    return {
        "ok":            True,
        "dataset_drift": n_drifted > 0,
        "n_drifted":     n_drifted,
        "n_columns":     n_total,
        "drift_share":   round(n_drifted / max(n_total, 1), 3),
        "per_column":    per_col,
        "n_reference":   len(ref),
        "n_current":     len(cur),
        "engine":        "scipy_ks (evidently not installed)",
        "checked_at":    time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def _no_data_result(reason: str) -> dict:
    return {
        "ok":            False,
        "dataset_drift": False,
        "reason":        reason,
        "checked_at":    time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def invalidate_cache() -> None:
    global _cache, _cache_ts, _ref_df
    _cache    = {}
    _cache_ts = 0.0
    _ref_df   = None

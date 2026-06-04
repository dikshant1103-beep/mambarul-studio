"""
core/analytics.py — wrappers around core.db with field-name mapping for the frontend.
"""
from __future__ import annotations
from datetime import datetime, timezone, timedelta
from core.db import (
    track_call, record_alert, acknowledge_alert,
    get_alerts as _get_alerts_raw, get_unacked_count, get_calls as _get_calls_raw,
)

# Re-export for direct use
get_unack_count = get_unacked_count


def get_calls(limit: int = 500, org: str = "") -> list[dict]:
    """Return calls with frontend-expected field names: chem, model, src."""
    rows = _get_calls_raw(limit=limit, org=org)
    result = []
    for r in rows:
        result.append({
            "ts":    r.get("ts", ""),
            "chem":  r.get("chemistry", ""),
            "model": r.get("model_id", ""),
            "rul":   r.get("rul", 0),
            "phase": r.get("phase", ""),
            "src":   r.get("source", "direct"),
            "org":   r.get("org", ""),
            # keep raw fields too
            "chemistry": r.get("chemistry", ""),
            "model_id":  r.get("model_id", ""),
            "source":    r.get("source", "direct"),
            "org_id":    r.get("org", ""),
        })
    return result


def get_alerts(unack_only: bool = False, limit: int = 200, org: str = "") -> list[dict]:
    """Wrapper translating unack_only → acked=False."""
    acked = False if unack_only else None
    return _get_alerts_raw(acked=acked, org=org, limit=limit)


def get_summary(org: str = "") -> dict:
    """Return summary shaped to match Analytics.tsx: total_predictions, chemistry_dist, etc."""
    calls = _get_calls_raw(limit=100_000, org=org)
    total = len(calls)

    by_chem: dict[str, int] = {}
    by_phase: dict[str, int] = {}
    rul_sum = 0.0
    rul_count = 0

    # Daily counts — last 14 days
    today = datetime.now(timezone.utc).date()
    daily: dict[str, int] = {}
    for i in range(13, -1, -1):
        d = (today - timedelta(days=i)).isoformat()
        daily[d] = 0

    for r in calls:
        chem = r.get("chemistry", "?")
        phase = r.get("phase", "?")
        by_chem[chem] = by_chem.get(chem, 0) + 1
        by_phase[phase] = by_phase.get(phase, 0) + 1

        rul_val = r.get("rul")
        if rul_val is not None and rul_val > 0:
            rul_sum += float(rul_val)
            rul_count += 1

        ts = r.get("ts", "")
        if ts:
            # SQLite returns an ISO string; Postgres/TimescaleDB returns a
            # datetime once `ts` is a TIMESTAMPTZ column — handle both.
            day = (ts if isinstance(ts, str) else ts.isoformat())[:10]  # "YYYY-MM-DD"
            if day in daily:
                daily[day] += 1

    avg_rul = round(rul_sum / rul_count, 1) if rul_count > 0 else None
    daily_counts = [{"date": d, "count": c} for d, c in daily.items()]

    # Alert counts
    all_alerts = _get_alerts_raw(org=org, limit=100_000)
    total_alerts = len(all_alerts)
    unack = get_unacked_count(org=org)

    return {
        "total_predictions": total,
        "avg_rul":           avg_rul,
        "chemistry_dist":    by_chem,
        "phase_dist":        by_phase,
        "total_alerts":      total_alerts,
        "unacknowledged":    unack,
        "daily_counts":      daily_counts,
        # legacy keys (in case any old code reads them)
        "total_calls":       total,
        "by_chemistry":      by_chem,
        "by_phase":          by_phase,
    }


def get_orgs() -> list[str]:
    calls = _get_calls_raw(limit=100_000)
    seen: dict[str, bool] = {}
    result = []
    for r in calls:
        o = r.get("org", "")
        if o and o not in seen:
            seen[o] = True
            result.append(o)
    return result


__all__ = [
    "track_call", "record_alert", "acknowledge_alert",
    "get_alerts", "get_unacked_count", "get_unack_count",
    "get_calls", "get_summary", "get_orgs",
]

"""
core/bms_safety.py — Safety thresholds, IEC 62619 / ISO 6469 compliance checks.

Evaluates each telemetry frame against per-chemistry limits and generates
safety events when thresholds are violated.
"""
from __future__ import annotations
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)

# ── Per-chemistry safety limits (IEC 62619 Table 3 reference values) ──────────
_LIMITS: dict[str, dict] = {
    "NMC": dict(v_min=2.50, v_max=4.25, v_warn_hi=4.20, v_warn_lo=2.70,
                t_min=-20.0, t_max=60.0,  t_warn=55.0,
                c_rate_max=3.0,  # max continuous C-rate
                c_rate_trip=10.0),  # hard trip C-rate (short-circuit indicator)
    "LFP": dict(v_min=2.50, v_max=3.70, v_warn_hi=3.65, v_warn_lo=2.60,
                t_min=-20.0, t_max=60.0, t_warn=55.0,
                c_rate_max=5.0, c_rate_trip=15.0),
    "LCO": dict(v_min=3.00, v_max=4.25, v_warn_hi=4.20, v_warn_lo=3.10,
                t_min=-20.0, t_max=55.0, t_warn=50.0,
                c_rate_max=2.0, c_rate_trip=8.0),
    "NCM": dict(v_min=2.50, v_max=4.25, v_warn_hi=4.20, v_warn_lo=2.70,
                t_min=-20.0, t_max=60.0, t_warn=55.0,
                c_rate_max=3.0, c_rate_trip=10.0),
    "NCA": dict(v_min=2.50, v_max=4.25, v_warn_hi=4.20, v_warn_lo=2.70,
                t_min=-20.0, t_max=60.0, t_warn=55.0,
                c_rate_max=3.0, c_rate_trip=10.0),
}
_DEFAULT_LIMITS = _LIMITS["NMC"]


@dataclass
class SafetyResult:
    safe: bool = True
    events: list[dict] = field(default_factory=list)
    trip:   bool = False          # hard trip — must stop charge/discharge immediately
    iec_62619_pass: bool = True


def get_limits(chemistry: str) -> dict:
    return _LIMITS.get(chemistry.upper(), _DEFAULT_LIMITS)


def check_frame(cell_id: str, voltage: float, current: float,
                temperature: float, capacity_ah: float,
                chemistry: str = "NMC",
                pack_id: str = "") -> SafetyResult:
    """
    Evaluate one telemetry frame against IEC 62619 limits.
    Returns a SafetyResult with any events that need recording.
    """
    lim = get_limits(chemistry)
    result = SafetyResult()
    c_rate = abs(current) / max(capacity_ah, 0.001)

    def _event(etype: str, severity: str, value: float, limit: float):
        result.events.append({
            "cell_id":    cell_id,
            "pack_id":    pack_id,
            "event_type": etype,
            "severity":   severity,
            "value":      round(value, 4),
            "limit_value": round(limit, 4),
        })
        result.safe = False
        result.iec_62619_pass = False
        if severity == "trip":
            result.trip = True

    # ── Voltage checks ────────────────────────────────────────────────────────
    if voltage > lim["v_max"]:
        _event("overvoltage", "trip",    voltage, lim["v_max"])
    elif voltage > lim["v_warn_hi"]:
        _event("overvoltage", "warning", voltage, lim["v_warn_hi"])
    elif voltage < lim["v_min"]:
        _event("undervoltage", "trip",    voltage, lim["v_min"])
    elif voltage < lim["v_warn_lo"]:
        _event("undervoltage", "warning", voltage, lim["v_warn_lo"])

    # ── Temperature checks ────────────────────────────────────────────────────
    if temperature > lim["t_max"]:
        _event("overtemp", "trip",    temperature, lim["t_max"])
    elif temperature > lim["t_warn"]:
        _event("overtemp", "warning", temperature, lim["t_warn"])
    elif temperature < lim["t_min"]:
        _event("undertemp", "trip",   temperature, lim["t_min"])

    # ── Current / C-rate checks ───────────────────────────────────────────────
    if c_rate > lim["c_rate_trip"]:
        _event("short_circuit", "trip",    c_rate, lim["c_rate_trip"])
    elif c_rate > lim["c_rate_max"]:
        _event("overcurrent", "warning", c_rate, lim["c_rate_max"])

    # ── Thermal runaway risk (T > 70°C or rate > 1°C/s heuristic) ────────────
    if temperature > 70.0:
        _event("thermal_runaway_risk", "trip", temperature, 70.0)

    return result


def check_pack_gradient(cell_temps: list[float], cell_ids: list[str],
                        pack_id: str = "") -> list[dict]:
    """Return events for cells with temperature > mean + 2σ (hotspot detection)."""
    if len(cell_temps) < 2:
        return []
    import statistics
    mean_t = statistics.mean(cell_temps)
    try:
        std_t = statistics.stdev(cell_temps)
    except statistics.StatisticsError:
        std_t = 0.0
    threshold = mean_t + 2 * std_t
    events = []
    for cid, t in zip(cell_ids, cell_temps):
        if t > threshold and t > mean_t + 3.0:   # at least 3°C above mean
            events.append({
                "cell_id":    cid,
                "pack_id":    pack_id,
                "event_type": "thermal_hotspot",
                "severity":   "warning",
                "value":      round(t, 2),
                "limit_value": round(threshold, 2),
            })
    return events


def iec_62619_summary(events: list[dict]) -> dict:
    """Produce a compliance summary dict from a list of active safety events."""
    trips = [e for e in events if e.get("severity") == "trip"]
    return {
        "iec_62619_compliant": len(trips) == 0,
        "violations":          [e["event_type"] for e in trips],
    }

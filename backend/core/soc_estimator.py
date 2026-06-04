"""
core/soc_estimator.py — SOC estimation: Coulomb counting + OCV lookup + temperature correction.

State is persisted to DB (soc_state table) so it survives restarts.
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# ── OCV-SOC look-up tables per chemistry ──────────────────────────────────────
# (SOC%, OCV_V) — linear interpolation used between points
_OCV_SOC: dict[str, list[tuple[float, float]]] = {
    "NMC": [(0,2.70),(5,3.30),(10,3.50),(20,3.60),(30,3.67),(40,3.72),
            (50,3.77),(60,3.82),(70,3.87),(80,3.93),(90,4.05),(100,4.20)],
    "LFP": [(0,2.50),(5,3.13),(10,3.20),(20,3.25),(30,3.28),(40,3.30),
            (50,3.31),(60,3.33),(70,3.35),(80,3.38),(90,3.45),(100,3.65)],
    "LCO": [(0,3.00),(5,3.50),(10,3.60),(20,3.68),(30,3.74),(40,3.78),
            (50,3.83),(60,3.88),(70,3.93),(80,3.98),(90,4.10),(100,4.20)],
    "NCM": [(0,2.70),(5,3.30),(10,3.50),(20,3.60),(30,3.67),(40,3.72),
            (50,3.77),(60,3.82),(70,3.87),(80,3.93),(90,4.05),(100,4.20)],
    "NCA": [(0,2.70),(5,3.35),(10,3.52),(20,3.62),(30,3.69),(40,3.74),
            (50,3.79),(60,3.84),(70,3.89),(80,3.95),(90,4.07),(100,4.20)],
}
_DEFAULT_OCV = _OCV_SOC["NMC"]

# ── Temperature capacity derating factors ─────────────────────────────────────
# Capacity as fraction of nominal at given temperature (°C)
_TEMP_DERATING = [(-20,0.60),(-10,0.75),(0,0.88),(10,0.94),(25,1.00),
                  (35,1.01),(45,0.98),(55,0.95),(60,0.90)]


def _interp(table: list[tuple[float, float]], x: float) -> float:
    """Linear interpolation on sorted (x,y) table, clamped to table range."""
    if x <= table[0][0]:  return table[0][1]
    if x >= table[-1][0]: return table[-1][1]
    for i in range(len(table)-1):
        x0,y0 = table[i]; x1,y1 = table[i+1]
        if x0 <= x <= x1:
            return y0 + (y1-y0) * (x-x0) / (x1-x0)
    return table[-1][1]


def ocv_to_soc(ocv: float, chemistry: str = "NMC") -> float:
    """Convert open-circuit voltage to SOC% using OCV-SOC table."""
    table = _OCV_SOC.get(chemistry.upper(), _DEFAULT_OCV)
    # Table is (SOC, OCV) — invert for OCV→SOC lookup
    inverted = [(v, k) for k, v in table]
    inverted.sort()
    return round(max(0.0, min(100.0, _interp(inverted, ocv))), 2)


def temperature_factor(temp_c: float) -> float:
    return max(0.5, _interp(_TEMP_DERATING, temp_c))


class CoulombCounter:
    """
    Per-cell Coulomb counter.  Thread-safe via in-place mutation (GIL protected).
    State loaded from DB on first use, saved periodically.
    """
    def __init__(self, cell_id: str, capacity_ah: float = 5.0,
                 chemistry: str = "NMC", initial_soc: float = 100.0):
        self.cell_id     = cell_id
        self.capacity_ah = capacity_ah
        self.chemistry   = chemistry.upper()
        self.soc         = initial_soc        # 0-100 %
        self.coulombs_in = 0.0               # Ah charged since last DB save
        self._last_ts: float | None = None

    def update(self, current_a: float, temperature_c: float,
               timestamp_s: float) -> float:
        """
        Update SOC with one telemetry frame.
        current_a: positive = charging, negative = discharging.
        Returns new SOC%.
        """
        if self._last_ts is None:
            self._last_ts = timestamp_s
            return self.soc

        dt_h = (timestamp_s - self._last_ts) / 3600.0
        self._last_ts = timestamp_s

        if dt_h <= 0 or dt_h > 1.0:   # sanity: ignore gaps > 1 hour
            return self.soc

        cap_eff = self.capacity_ah * temperature_factor(temperature_c)
        delta_soc = (current_a * dt_h / cap_eff) * 100.0
        self.soc = max(0.0, min(100.0, self.soc + delta_soc))
        self.coulombs_in += current_a * dt_h
        return round(self.soc, 2)

    def correct_with_ocv(self, voltage: float) -> float:
        """OCV-based correction when current ≈ 0 (rest phase)."""
        ocv_soc = ocv_to_soc(voltage, self.chemistry)
        # Blend: 70% OCV, 30% Coulomb (more trust in OCV during rest)
        self.soc = 0.70 * ocv_soc + 0.30 * self.soc
        return round(self.soc, 2)

    def save(self) -> None:
        try:
            from core.db import save_soc_state
            save_soc_state(self.cell_id, self.soc, self.capacity_ah,
                           self.coulombs_in, self.chemistry)
        except Exception as exc:
            logger.debug("SOC save failed for %s: %s", self.cell_id, exc)

    @classmethod
    def load(cls, cell_id: str, capacity_ah: float = 5.0,
             chemistry: str = "NMC") -> "CoulombCounter":
        try:
            from core.db import load_soc_state
            state = load_soc_state(cell_id)
            if state:
                cc = cls(cell_id, state["capacity_ah"],
                         state.get("chemistry", chemistry), state["soc"])
                cc.coulombs_in = state.get("coulombs_in", 0.0)
                return cc
        except Exception:
            pass
        return cls(cell_id, capacity_ah, chemistry, 100.0)


# ── In-memory registry of active counters ────────────────────────────────────
_counters: dict[str, CoulombCounter] = {}


def get_counter(cell_id: str, capacity_ah: float = 5.0,
                chemistry: str = "NMC") -> CoulombCounter:
    if cell_id not in _counters:
        _counters[cell_id] = CoulombCounter.load(cell_id, capacity_ah, chemistry)
    return _counters[cell_id]


def update_soc(cell_id: str, current_a: float, voltage: float,
               temperature_c: float, capacity_ah: float,
               chemistry: str = "NMC") -> float:
    """Top-level function: update SOC for one telemetry frame. Returns SOC%."""
    import time
    cc = get_counter(cell_id, capacity_ah, chemistry)
    if abs(current_a) < 0.01:            # rest — use OCV correction
        soc = cc.correct_with_ocv(voltage)
    else:
        soc = cc.update(current_a, temperature_c, time.time())
    cc.save()
    return soc

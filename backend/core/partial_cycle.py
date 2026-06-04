"""
core/partial_cycle.py
=====================
Reconstruct full-cycle features from a partial V/I/t/T trace.

Real BMS data never gives complete 0–100% discharge cycles.  This module
accepts whatever window is available and estimates the same 9 base features
the model was trained on.

Estimation strategy
-------------------
For each feature, three tiers of precision:
  MEASURED  — directly integrable from the trace (volt_mean, temp_mean, IR_proxy)
  SCALED    — measured value ÷ completeness_ratio (capacity, energy)
  ESTIMATED — polynomial extrapolation or chemistry-specific default (volt_end)

The output includes a `completeness_ratio` (0–1) and a `data_quality` flag
so the caller can communicate confidence to the end-user.
"""
from __future__ import annotations
import numpy as np
from typing import Optional


# Chemistry-specific nominal voltages for volt_end extrapolation fallback
_VEND_DEFAULT = {
    "LCO": 2.75, "LFP": 2.50, "NMC": 2.70,
    "NCM": 2.70, "NCA": 2.70,
}
_CHEM_CODE = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3, "NCA": 4}


def extract_features_from_trace(
    v: list[float] | np.ndarray,          # discharge voltage [V]
    i: list[float] | np.ndarray,          # discharge current [A] (positive = discharge)
    t: list[float] | np.ndarray,          # time [seconds]
    T: list[float] | np.ndarray,          # temperature [°C]
    chemistry: str = "NMC",
    soc_start: Optional[float] = None,    # SOC at start  (0-1), e.g. 0.9
    soc_end:   Optional[float] = None,    # SOC at end    (0-1), e.g. 0.2
    nom_capacity_ah: Optional[float] = None,   # nameplate Ah
    charge_time_s: Optional[float] = None,     # from charge segment (seconds)
    t_charge: Optional[np.ndarray] = None,     # charge time array for scaling
) -> dict:
    """
    Extract the 9 base features + completeness metadata from a partial trace.

    Returns
    -------
    dict with keys:
        features_9   : np.ndarray shape (9,) — ready to feed into build_x13()
        completeness : float  0–1
        data_quality : str    'high' | 'medium' | 'low'
        source       : dict   per-feature origin ('measured'/'scaled'/'estimated')
        warnings     : list[str]
    """
    v = np.asarray(v, dtype=np.float64)
    i = np.asarray(i, dtype=np.float64)
    t = np.asarray(t, dtype=np.float64)
    T = np.asarray(T, dtype=np.float64)
    chem = chemistry.upper()

    warnings: list[str] = []
    source: dict[str, str] = {}

    # ── 1. Completeness ratio ────────────────────────────────────────────────
    completeness = _estimate_completeness(v, i, t, soc_start, soc_end,
                                          nom_capacity_ah, chem, warnings)

    # ── 2. Capacity (feature 0) ──────────────────────────────────────────────
    #    Integrate current over time to get Ah, then scale up to full-cycle
    dt   = np.diff(t, prepend=t[0])
    dq   = np.abs(i) * dt / 3600.0   # Ah per time-step
    q_obs = float(np.sum(dq))

    capacity = q_obs / max(completeness, 0.05)
    source["capacity"] = "scaled" if completeness < 0.95 else "measured"
    if capacity < 1e-4:
        capacity = nom_capacity_ah or 2.0
        source["capacity"] = "estimated"
        warnings.append("capacity near zero — using nominal or default 2 Ah")

    # ── 3. Charge time (feature 1) ───────────────────────────────────────────
    if charge_time_s is not None:
        ct = float(charge_time_s) / max(completeness, 0.05)
        source["charge_time"] = "scaled"
    elif t_charge is not None and len(t_charge) > 1:
        ct = float(t_charge[-1] - t_charge[0]) / max(completeness, 0.05)
        source["charge_time"] = "scaled"
    else:
        # No charge data: estimate from C-rate (capacity / 1C ~ 1 hour baseline)
        c_rate = 1.0
        ct = (capacity / c_rate) * 3600.0
        source["charge_time"] = "estimated"
        warnings.append("charge_time estimated from capacity at 1C-rate")

    # ── 4. Voltage mean (feature 2) ──────────────────────────────────────────
    volt_mean = float(np.mean(v))
    source["volt_mean"] = "measured"

    # ── 5. Voltage end (feature 3) ───────────────────────────────────────────
    if completeness > 0.80:
        # Trace covers most of the discharge — last observed V is close to true end
        volt_end = float(v[-1])
        source["volt_end"] = "measured"
    else:
        # Polynomial extrapolation of the V(q) curve to full capacity
        q_cum = np.cumsum(dq)
        q_full = q_cum[-1] / completeness
        try:
            coeffs = np.polyfit(q_cum, v, deg=2)
            volt_end_pred = float(np.polyval(coeffs, q_full))
            vend_default  = _VEND_DEFAULT.get(chem, 2.70)
            # Clamp to plausible range
            volt_end = float(np.clip(volt_end_pred, vend_default - 0.3, vend_default + 0.2))
            source["volt_end"] = "estimated"
        except Exception:
            volt_end = _VEND_DEFAULT.get(chem, 2.70)
            source["volt_end"] = "estimated"
            warnings.append("volt_end polynomial fit failed — using chemistry default")

    # ── 6. Energy (feature 4) ────────────────────────────────────────────────
    energy_obs = float(np.trapezoid(v, q_cum)) if len(v) > 1 else 0.0
    energy = energy_obs / max(completeness, 0.05)
    source["energy"] = "scaled" if completeness < 0.95 else "measured"

    # ── 7. Temperature mean (feature 5) ──────────────────────────────────────
    temp_mean = float(np.mean(T))
    source["temp_mean"] = "measured"

    # ── 8. Discharge slope (feature 6) ───────────────────────────────────────
    #    Rolling slope across cycles — can't be computed from a single cycle.
    #    Will be filled by the caller's rolling_slope() once multiple cycles
    #    accumulate; default to 0.0 for the first/single cycle case.
    discharge_slope = 0.0
    source["discharge_slope"] = "deferred"
    warnings.append("discharge_slope=0 until ≥5 cycles are accumulated")

    # ── 9. IR proxy (feature 7) ───────────────────────────────────────────────
    #    Voltage spread: max(V) − mean(V), robust proxy for internal resistance
    ir_proxy = float(np.max(v) - volt_mean) if len(v) > 1 else 0.0
    source["ir_proxy"] = "measured"

    # ── 10. Chem code (feature 8) ─────────────────────────────────────────────
    chem_code = float(_CHEM_CODE.get(chem, 2))
    source["chem_code"] = "user-provided"

    # ── Assemble 9-feature vector ─────────────────────────────────────────────
    features_9 = np.array([
        capacity, ct, volt_mean, volt_end,
        energy, temp_mean, discharge_slope, ir_proxy, chem_code,
    ], dtype=np.float32)

    # ── Data quality flag ─────────────────────────────────────────────────────
    n_estimated = sum(1 for s in source.values() if s == "estimated")
    if completeness >= 0.7 and n_estimated <= 1:
        quality = "high"
    elif completeness >= 0.40 and n_estimated <= 2:
        quality = "medium"
    else:
        quality = "low"

    return {
        "features_9":   features_9,
        "completeness": round(completeness, 3),
        "data_quality": quality,
        "source":       source,
        "warnings":     warnings,
        "q_observed_ah": round(q_obs, 4),
        "q_estimated_ah": round(capacity, 4),
    }


def _estimate_completeness(
    v, i, t, soc_start, soc_end, nom_capacity_ah, chem, warnings
) -> float:
    """Return fraction of full cycle captured (0–1)."""

    # Tier 1: explicit SOC window (most accurate)
    if soc_start is not None and soc_end is not None:
        soc_s = float(np.clip(soc_start, 0, 1))
        soc_e = float(np.clip(soc_end,   0, 1))
        return float(np.clip(abs(soc_s - soc_e), 0.01, 1.0))

    # Tier 2: current integration vs nominal capacity
    if nom_capacity_ah is not None and nom_capacity_ah > 0:
        dt   = np.diff(t, prepend=t[0])
        q_ah = float(np.sum(np.abs(i) * dt / 3600.0))
        return float(np.clip(q_ah / nom_capacity_ah, 0.01, 1.0))

    # Tier 3: voltage window heuristic
    #   Full discharge spans ~(V_max - V_cutoff); estimate fraction covered
    v_span_obs  = float(np.max(v) - np.min(v))
    v_spans = {"LCO": 1.30, "LFP": 0.45, "NMC": 1.20, "NCM": 1.20, "NCA": 1.15}
    v_span_full = v_spans.get(chem, 1.0)
    est = float(np.clip(v_span_obs / v_span_full, 0.05, 1.0))
    warnings.append(f"completeness estimated from voltage span ({v_span_obs:.3f}V / {v_span_full:.2f}V = {est:.2f})")
    return est


class PartialCycleAccumulator:
    """
    Accumulates features across multiple partial cycles for a single cell.

    Usage
    -----
    acc = PartialCycleAccumulator(chemistry='NMC', nom_capacity_ah=3.0)
    for each cycle:
        result = acc.push(v, i, t, T, soc_start=0.9, soc_end=0.2)
        if result['ready']:
            # send result['features_13'] to model window builder
    """

    def __init__(self, chemistry: str = "NMC",
                 nom_capacity_ah: Optional[float] = None,
                 window_size: int = 30):
        self.chemistry        = chemistry.upper()
        self.nom_capacity_ah  = nom_capacity_ah
        self.window_size      = window_size
        self._history: list[np.ndarray] = []   # rows of 9-feature vectors
        self._completeness:  list[float] = []
        self._cycle_nums:    list[int]   = []
        self._cycle_counter  = 0

    def push(
        self,
        v: list[float] | np.ndarray,
        i: list[float] | np.ndarray,
        t: list[float] | np.ndarray,
        T: list[float] | np.ndarray,
        soc_start: Optional[float] = None,
        soc_end:   Optional[float] = None,
        charge_time_s: Optional[float] = None,
    ) -> dict:
        """
        Process one (partial) cycle and append to history.

        Returns dict with:
            cycle_num    : int
            completeness : float
            data_quality : str
            warnings     : list[str]
            history_len  : int   — number of cycles accumulated so far
            ready        : bool  — True once window_size cycles available
            features_9   : np.ndarray shape (9,) for latest cycle
        """
        self._cycle_counter += 1
        result = extract_features_from_trace(
            v, i, t, T,
            chemistry=self.chemistry,
            soc_start=soc_start,
            soc_end=soc_end,
            nom_capacity_ah=self.nom_capacity_ah,
            charge_time_s=charge_time_s,
        )
        feat9 = result["features_9"].copy()

        self._history.append(feat9)
        self._completeness.append(result["completeness"])
        self._cycle_nums.append(self._cycle_counter)

        # Fill discharge_slope (feature 6) retrospectively once ≥5 cycles
        if len(self._history) >= 5:
            caps = np.array([h[0] for h in self._history], dtype=np.float32)
            slopes = _rolling_slope(caps, window=5)
            for idx, h in enumerate(self._history):
                h[6] = slopes[idx]

        return {
            "cycle_num":    self._cycle_counter,
            "completeness": result["completeness"],
            "data_quality": result["data_quality"],
            "warnings":     result["warnings"],
            "history_len":  len(self._history),
            "ready":        len(self._history) >= self.window_size,
            "features_9":   feat9,
        }

    def get_latest_window(self) -> Optional[np.ndarray]:
        """
        Return the most recent window_size rows as (window_size, 9) array.
        Returns None if fewer than window_size cycles have been pushed.
        """
        if len(self._history) < self.window_size:
            return None
        return np.stack(self._history[-self.window_size:], axis=0)

    def mean_completeness(self) -> float:
        if not self._completeness:
            return 0.0
        return float(np.mean(self._completeness[-self.window_size:]))

    def reset(self):
        self._history.clear()
        self._completeness.clear()
        self._cycle_nums.clear()
        self._cycle_counter = 0


def _rolling_slope(arr: np.ndarray, window: int = 5) -> np.ndarray:
    n = len(arr); slopes = np.zeros(n, np.float32)
    for i in range(n):
        seg = arr[max(0, i - window + 1): i + 1]
        if len(seg) >= 2:
            slopes[i] = float(np.polyfit(np.arange(len(seg)), seg, 1)[0])
    return slopes

"""
core/rul_bridge.py — Live RUL inference bridge for the BMS telemetry pipeline.

Two inference triggers:
  1. Every RUL_INFER_INTERVAL frames (rolling, non-blocking) — live dashboard
  2. On new cycle detection (cycle_num changes) — persists to cell_rul_history
     for long-term trend tracking and CI tightening

Inference takes ~5–15 ms on CPU; runs outside the pipeline lock.
"""
from __future__ import annotations
import logging
import threading
from collections import deque
from typing import Optional

logger = logging.getLogger(__name__)

RUL_INFER_INTERVAL = 10   # fire inference every N frames (live dashboard)
BUFFER_SIZE        = 60   # rolling frame buffer per cell

_buffers:      dict[str, deque] = {}
_rul_cache:    dict[str, dict]  = {}
_frame_count:  dict[str, int]   = {}
_last_cycle:   dict[str, int]   = {}   # last seen cycle_num per cell
_lock = threading.Lock()

CHEM_CODE = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3, "NCA": 4}


def _extract_features(buf: list[dict], capacity_ah: float, chemistry: str) -> dict:
    voltages = [f["voltage"]     for f in buf]
    currents = [f["current"]     for f in buf]
    temps    = [f["temperature"] for f in buf]
    socs     = [f["soc"]         for f in buf if f.get("soc") is not None]

    vmean  = sum(voltages) / len(voltages)
    vend   = voltages[-1]
    temp   = float(temps[-1])
    soh    = float(sum(socs) / len(socs)) if socs else 85.0
    dslope = (voltages[-1] - voltages[0]) / max(len(voltages) - 1, 1)
    energy = sum(abs(v * i) for v, i in zip(voltages, currents)) / 3600.0
    cap    = capacity_ah * (soh / 100.0)

    return {
        "capacity":        max(cap, 0.01),
        "charge_time":     7200,
        "voltage_mean":    vmean,
        "voltage_end":     vend,
        "energy":          max(energy, 0.001),
        "temperature":     temp,
        "discharge_slope": dslope,
        "int_resistance":  0.05,
        "chemistry_code":  CHEM_CODE.get(chemistry.upper(), 0),
        "chemistry":       chemistry.upper(),
        "soh_pct":         soh,
        "nom_capacity":    capacity_ah,
    }


def _run_adapted_inference(cell_id: str, features: dict, model_id: str, entry: dict) -> Optional[dict]:
    """Run inference with per-cell EWC-adapted weights. Returns result dict or None."""
    try:
        import copy
        import torch
        from core.ewc_trainer import get_adapted_state
        from core.model_loader import _build_window, _normalize, CHEM_MAX_RUL, CALCE_RUL_MAX

        adapted_state = get_adapted_state(cell_id)
        if adapted_state is None:
            return None

        adapted = copy.deepcopy(entry["model"])
        adapted.load_state_dict(adapted_state, strict=False)
        adapted.eval()

        raw = _build_window(features)
        X13 = _normalize(raw, entry.get("feat_mean"), entry.get("feat_std"))
        inp = torch.tensor(X13).unsqueeze(0)

        with torch.no_grad():
            model_class = entry.get("class", "")
            if model_class == "BiMambaAPF":
                chem_code = max(0, min(int(inp[0, -1, 8].round().item()), 4))
                rul_mean, _, _ = adapted.predict_with_uncertainty(inp, chem_code=chem_code, k=10)
                rul_norm = float(rul_mean.item())
            elif model_class in ("MambaRULTwoHead", "TwoHead"):
                rul_t, _ = adapted(inp)
                rul_norm = float(rul_t.item())
            else:
                rul_norm = float(adapted(inp).item())

        rul_max = entry.get("rul_max", 309.0)
        chem    = features.get("chemistry", "LCO").upper()
        if entry.get("normalization") == "per_cell":
            rul_cycles = max(0.0, rul_norm * rul_max)
        else:
            chem_scale = CHEM_MAX_RUL.get(chem, CALCE_RUL_MAX) / CALCE_RUL_MAX
            rul_cycles = max(0.0, rul_norm * rul_max * chem_scale)

        conf   = rul_cycles * 0.15
        soh    = float(features.get("soh_pct", 85)) / 100.0
        phase  = "Fresh" if soh > 0.9 else "Aging" if soh > 0.75 else "Knee" if soh > 0.6 else "Near-EOL"
        return {
            "predicted_rul": round(rul_cycles, 1),
            "lower_bound":   round(max(0.0, rul_cycles - conf), 1),
            "upper_bound":   round(rul_cycles + conf, 1),
            "phase":         phase,
            "layer4_adapted": True,
        }
    except Exception as exc:
        logger.debug("Layer4 adapted inference failed for %s: %s", cell_id, exc)
        return None


def _run_inference(features: dict, cell_id: Optional[str] = None) -> Optional[dict]:
    """Run model inference. Returns result dict or None on failure."""
    try:
        from core.model_loader import run_inference, get_loaded_models, _MODELS
        loaded = [m["id"] for m in get_loaded_models() if m["loaded"]]
        if not loaded:
            return None
        model_id = "v10-final" if "v10-final" in loaded else loaded[0]

        # Layer 4: try per-cell EWC-adapted model first
        result         = None
        layer4_adapted = False
        if cell_id is not None and model_id in _MODELS:
            result = _run_adapted_inference(cell_id, features, model_id, _MODELS[model_id])
            if result is not None:
                layer4_adapted = True

        if result is None:
            result = run_inference(model_id, features)

        return {
            "rul":            round(float(result["predicted_rul"])),
            "rul_lower":      round(float(result.get("lower_bound",
                                  result["predicted_rul"] * 0.85))),
            "rul_upper":      round(float(result.get("upper_bound",
                                  result["predicted_rul"] * 1.15))),
            "phase":          result.get("phase", ""),
            "model_id":       model_id,
            "soh_pct":        round(float(features.get("soh_pct", 85)), 1),
            "chemistry":      features["chemistry"],
            "layer4_adapted": layer4_adapted,
        }
    except Exception as exc:
        logger.debug("rul_bridge inference failed: %s", exc)
        return None


def _persist_rul(cell_id: str, cycle_num: int, out: dict, features: dict) -> None:
    """Write per-cycle RUL to cell_rul_history, then run Layer 2+3+4 analysis."""
    chemistry = out.get("chemistry", "LFP")
    try:
        from core.db import store_rul_history
        store_rul_history(
            cell_id   = cell_id,
            cycle_num = cycle_num,
            rul       = out["rul"],
            rul_lower = out["rul_lower"],
            rul_upper = out["rul_upper"],
            soh_pct   = out.get("soh_pct", 0.0),
            model_id  = out.get("model_id", "v10-final"),
            chemistry = chemistry,
        )
        logger.info("RUL persisted: cell=%s cycle=%d rul=%d [%d-%d]",
                    cell_id, cycle_num, out["rul"], out["rul_lower"], out["rul_upper"])
    except Exception as exc:
        logger.debug("rul_bridge persist failed: %s", exc)
        return  # skip analysis if persist failed

    # Layer 2 + 3 — fade acceleration + CI tightening
    try:
        from core.online_rul import run_online_analysis
        run_online_analysis(cell_id, cycle_num, chemistry)
    except Exception as exc:
        logger.debug("rul_bridge online_rul failed: %s", exc)

    # Layer 4 — EWC online fine-tuning (accumulate; adaptation fires in its own thread)
    try:
        from core.ewc_trainer import accumulate
        accumulate(cell_id, features, float(out["rul"]), chemistry)
    except Exception as exc:
        logger.debug("rul_bridge ewc accumulate failed: %s", exc)


def update_cell(cell_id: str, voltage: float, current: float,
                temperature: float, soc: float,
                capacity_ah: float, chemistry: str,
                cycle_num: Optional[int] = None) -> Optional[dict]:
    """
    Add one BMS frame to the cell buffer. Returns latest cached RUL.

    Inference triggers:
      • Every RUL_INFER_INTERVAL frames (live dashboard update)
      • When cycle_num changes (new cycle) → also persists to cell_rul_history
    """
    with _lock:
        if cell_id not in _buffers:
            _buffers[cell_id]     = deque(maxlen=BUFFER_SIZE)
            _frame_count[cell_id] = 0
            _last_cycle[cell_id]  = -1

        _buffers[cell_id].append({
            "voltage": voltage, "current": current,
            "temperature": temperature, "soc": soc,
        })
        _frame_count[cell_id] += 1
        count      = _frame_count[cell_id]
        buf        = list(_buffers[cell_id])
        last_cycle = _last_cycle[cell_id]

        # Detect new cycle
        new_cycle = (cycle_num is not None and cycle_num != last_cycle
                     and cycle_num > 0)
        if new_cycle:
            _last_cycle[cell_id] = cycle_num

    # ── Trigger 1: every RUL_INFER_INTERVAL frames ────────────────────────────
    if len(buf) >= 10 and count % RUL_INFER_INTERVAL == 0:
        features = _extract_features(buf, capacity_ah, chemistry)
        out = _run_inference(features, cell_id=cell_id)
        if out:
            out["frames"] = count
            with _lock:
                _rul_cache[cell_id] = out

    # ── Trigger 2: new cycle detected → infer + persist ───────────────────────
    if new_cycle and len(buf) >= 10:
        features = _extract_features(buf, capacity_ah, chemistry)
        out = _run_inference(features, cell_id=cell_id)
        if out:
            out["frames"]    = count
            out["cycle_num"] = cycle_num
            with _lock:
                _rul_cache[cell_id] = out
            # Persist in background thread — never blocks the telemetry pipeline
            threading.Thread(
                target  = _persist_rul,
                args    = (cell_id, cycle_num, out, features),
                daemon  = True,
            ).start()

    with _lock:
        return _rul_cache.get(cell_id)


def get_cached(cell_id: str) -> Optional[dict]:
    with _lock:
        return _rul_cache.get(cell_id)


def get_all_cached() -> dict[str, dict]:
    with _lock:
        return dict(_rul_cache)

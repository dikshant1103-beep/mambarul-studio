"""
routers/ingest.py — CSV/JSON data ingestion, chemistry detection, per-cycle prediction.

Endpoints:
  POST /api/ingest           — upload CSV → feature extract → RUL predictions
  POST /api/detect-chemistry — quick chemistry fingerprint from capacity/voltage series
"""
from __future__ import annotations

import io
import logging
from typing import Any

import numpy as np
import pandas as pd
from fastapi import APIRouter, File, Form, Request, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter()

try:
    from main import limiter as _limiter
    _rate_limit = _limiter.limit("20/minute")
except Exception:
    def _rate_limit(fn):  # no-op if not wired yet (e.g. during tests)
        return fn

# ── Chemistry detection constants ────────────────────────────────────────────

# Typical mean discharge voltage ranges per chemistry (V)
_VMEAN_RANGES = {
    "LFP": (3.10, 3.40),
    "LCO": (3.60, 3.95),
    "NMC": (3.55, 3.80),
    "NCM": (3.50, 3.78),
    "NCA": (3.58, 3.82),
}

# Typical nominal capacity ranges per chemistry (Ah) — loose bounds
_CAP_RANGES = {
    "LFP": (0.5, 4.0),
    "LCO": (0.8, 2.5),
    "NMC": (0.8, 5.0),
    "NCM": (0.8, 5.0),
    "NCA": (0.8, 4.0),
}

# ── Column name aliases ───────────────────────────────────────────────────────
_ALIASES: dict[str, list[str]] = {
    "cycle":         ["cycle", "cycle_number", "cycle_index", "cyc", "step"],
    "capacity":      ["capacity", "capacity_ah", "cap", "discharge_cap", "q_d", "qd", "cap_ah"],
    "voltage_mean":  ["voltage_mean", "voltage", "v_mean", "vmean", "v_avg", "mean_voltage",
                      "discharge_voltage", "v_discharge"],
    "voltage_min":   ["voltage_min", "v_min", "vmin", "min_voltage"],
    "voltage_max":   ["voltage_max", "v_max", "vmax", "max_voltage"],
    "current_mean":  ["current_mean", "current", "i_mean", "imean", "avg_current"],
    "temperature":   ["temperature", "temp", "temperature_c", "temp_c", "t_cell", "t_amb"],
    "energy":        ["energy", "energy_wh", "e_wh", "discharge_energy"],
    "int_resistance":["int_resistance", "ir", "internal_resistance", "r_int", "resistance"],
    "chemistry":     ["chemistry", "chem", "chemistry_code"],
}


def _resolve_col(df: pd.DataFrame, canonical: str) -> str | None:
    """Return the first matching column alias present in df, or None."""
    cols_lower = {c.lower(): c for c in df.columns}
    for alias in _ALIASES[canonical]:
        if alias in cols_lower:
            return cols_lower[alias]
    return None


def _detect_chemistry(vmean_series: np.ndarray | None,
                       cap_series: np.ndarray | None,
                       chem_col_value: str | None) -> tuple[str, float]:
    """
    Return (chemistry, confidence) where confidence ∈ [0, 1].

    Priority:
    1. Explicit chemistry column in data
    2. Voltage mean fingerprinting (most reliable)
    3. Capacity range fallback
    """
    if chem_col_value:
        raw = str(chem_col_value).upper().strip()
        # numeric codes
        if raw in {"0"}: return "LCO", 1.0
        if raw in {"1"}: return "LFP", 1.0
        if raw in {"2"}: return "NMC", 1.0
        if raw in {"3"}: return "NCM", 1.0
        # string match
        for chem in ("LFP", "LCO", "NMC", "NCM", "NCA"):
            if chem in raw:
                return chem, 1.0

    if vmean_series is not None and len(vmean_series) > 0:
        v = float(np.nanmedian(vmean_series))
        scores: dict[str, float] = {}
        for chem, (lo, hi) in _VMEAN_RANGES.items():
            mid = (lo + hi) / 2
            half = (hi - lo) / 2
            dist = abs(v - mid)
            scores[chem] = max(0.0, 1.0 - dist / (half + 0.1))
        best = max(scores, key=lambda k: scores[k])
        conf = scores[best]
        if conf > 0.3:
            return best, round(conf, 3)

    if cap_series is not None and len(cap_series) > 0:
        cap_init = float(np.nanpercentile(cap_series, 95))
        # LFP cells are often larger capacity
        if cap_init > 2.5:
            return "LFP", 0.4
        if cap_init < 1.1:
            return "LCO", 0.4
        return "NMC", 0.35

    return "LCO", 0.2   # safe default


def _phase(soh: float) -> str:
    if soh > 0.90: return "Fresh"
    if soh > 0.75: return "Aging"
    if soh > 0.60: return "Knee"
    return "Near-EOL"


def _alert_level(soh: float) -> str:
    if soh > 0.85: return "healthy"
    if soh > 0.70: return "warning"
    return "critical"


# ── Conformal half-widths (same as predict.py) ────────────────────────────────
_CONFORMAL_90 = {"LCO": 34.0, "LFP": 145.3, "NMC": 514.3, "NCM": 17.0, "NCA": 20.0}

_MAX_RUL  = {"LCO": 309.0, "LFP": 1934.0, "NMC": 550.0, "NCM": 662.0, "NCA": 350.0}
_DECAY    = 2.3
_SCALE    = {"LCO": 1.00, "LFP": 0.88, "NMC": 0.95, "NCM": 0.92, "NCA": 0.90}


_WINDOW      = 30
_CHEM_CODE   = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3, "NCA": 4}
_CHEM_MAXRUL = {0: 309.0, 1: 1934.0, 2: 1500.0, 3: 1000.0, 4: 800.0}
_ARRH_REF    = 1.0     # Arrhenius factor at 25 °C
_ARRH_STD    = 0.01    # training-script value


def _arrhenius(T: np.ndarray) -> np.ndarray:
    return np.exp(-0.05 * (1.0 / (T + 273.15) - 1.0 / 298.15))


def _run_windowed_inference(
    capacity, vmean, vmin, vmax, imean, temp, ir, energy,
    chemistry: str, n: int,
) -> list[dict] | None:
    """
    Build real 30-cycle sliding windows from uploaded CSV data and run the
    loaded BiMamba-APF / fine-tuned model.  Returns one prediction per cycle
    for cycles >= WINDOW (first 29 cycles fall back to the analytical formula).
    Returns None when no model is loaded.

    Training feature layout (must match multi_dataset_pipeline.py + training scripts):
      [0] capacity_Ah
      [1] cc_charge_time_s   (CC charge phase duration)
      [2] voltage_mean_V     (mean discharge voltage)
      [3] voltage_end_V      (end-of-discharge voltage ≈ vmin)
      [4] energy_Wh          (discharge energy)
      [5] temperature_C      (raw °C, or Arrhenius-transformed depending on model)
      [6] discharge_slope    (rolling polyfit slope of capacity)
      [7] ir_proxy           (internal resistance in Ω)
      [8] chemistry_code     (0=LCO, 1=LFP, 2=NMC, 3=NCM, 4=NCA)

    Derived features appended per window (indices 9-12):
      [9]  cap_pct            cap / initial_cap of window
      [10] delta_cap          per-cycle capacity change
      [11] ec_n               cumulative energy (normalized within window)
      [12] delta_ir           per-cycle IR change
    """
    try:
        import torch
        from core.model_loader import _MODELS
        if not _MODELS:
            return None

        # Chemistry-matched model priority: fine-tuned > v12-bimamba > v10-final
        chem_up = chemistry.upper()
        priority = {
            "LFP":  ["hust-lfp",   "v12-bimamba", "v10-final"],
            "NMC":  ["oxford-nmc", "v12-bimamba", "v10-final"],
            "LCO":  ["v10-final",  "v12-bimamba"],
            "NCM":  ["v12-bimamba", "v10-final"],
            "NCA":  ["v12-bimamba", "v10-final"],
        }.get(chem_up, ["v12-bimamba", "v10-final"])
        priority += list(_MODELS.keys())   # fallback to whatever is loaded

        entry = None
        for mid in priority:
            if mid in _MODELS:
                entry = _MODELS[mid]
                break
        if entry is None:
            return None

        model       = entry["model"]
        _fm = entry.get("feat_mean"); _fs = entry.get("feat_std")
        fmean = np.array(_fm if _fm is not None else [], dtype=np.float32)
        fstd  = np.array(_fs if _fs is not None else [], dtype=np.float32)
        model_class = entry.get("class", "")
        norm_type   = entry.get("normalization", "global")
        chem_code   = _CHEM_CODE.get(chem_up, 0)

        # rul_max: BiMamba uses per-chemistry normalisation; per_cell models use
        # median_cell_rul_max directly; global models need chemistry rescaling.
        _CALCE_MAX = 309.0
        if model_class == "BiMambaAPF":
            rul_max = _CHEM_MAXRUL.get(chem_code, _CALCE_MAX)
        elif norm_type == "per_cell":
            rul_max = float(entry.get("rul_max") or 1000.0)  # no extra scaling
        else:
            model_rul_max = float(entry.get("rul_max") or _CALCE_MAX)
            rul_max = model_rul_max * (_CHEM_MAXRUL.get(chem_code, _CALCE_MAX) / _CALCE_MAX)

        # ── Build (n, 9) feature matrix in training layout ────────────────────
        cap_  = capacity if capacity is not None else np.ones(n, np.float32)

        # vmean: Li-ion discharge voltage must be in 2.0-4.5V range; treat anything
        # outside (0, mV, CC-time in seconds, etc.) as missing.
        _vm_default = float(fmean[2]) if len(fmean) > 2 and 2.0 < float(fmean[2]) < 4.5 else 3.7
        _vm_avg = float(np.nanmean(vmean)) if vmean is not None else 0.0
        if 2.0 <= _vm_avg <= 4.5:
            vm_ = vmean.astype(np.float32)
        else:
            vm_ = np.full(n, _vm_default, np.float32)

        # vend (end-of-discharge voltage ≈ lower cutoff): use vmin as proxy
        _vend_default = float(fmean[3]) if len(fmean) > 3 and 1.5 < float(fmean[3]) < 4.5 else 2.9
        _vmin_avg = float(np.nanmean(vmin)) if vmin is not None else 0.0
        if 1.5 <= _vmin_avg <= 4.5:
            vend_ = vmin.astype(np.float32)
        else:
            vend_ = np.full(n, _vend_default, np.float32)

        en_   = (energy if energy is not None
                 else (cap_ * vm_).astype(np.float32))
        T_    = temp if temp is not None else np.full(n, 25.0, np.float32)

        # ir_proxy: internal resistance (Ω). Treat 0 as missing.
        _ir_default = float(fmean[7]) if len(fmean) > 7 and float(fmean[7]) > 1e-6 else 0.05
        if ir is not None and float(np.nanmean(ir)) > 1e-6:
            ir_ = ir.astype(np.float32)
        else:
            ir_ = np.full(n, _ir_default, np.float32)

        # cc_charge_time: estimate cap/current * 3600, or fall back to training mean
        _cc_default = float(fmean[1]) if len(fmean) > 1 else 648.9
        if imean is not None and float(np.nanmean(np.abs(imean))) > 0.01:
            cc_time_ = np.clip(cap_ / np.maximum(np.abs(imean), 0.05) * 3600,
                               5.0, 50000.0).astype(np.float32)
        else:
            cc_time_ = np.full(n, _cc_default, np.float32)  # training mean → normalises to 0

        # discharge_slope: rolling 7-cycle polyfit on capacity (uses lightly smoothed cap
        # to suppress RPT measurement noise that can produce spurious positive slopes)
        cap_smooth = np.array(
            [float(np.mean(cap_[max(0, t-2): t+1])) for t in range(n)], dtype=np.float32
        )
        slope_ = np.zeros(n, np.float32)
        for t in range(n):
            lo = max(0, t - 6)
            seg = cap_smooth[lo: t + 1]
            if len(seg) >= 2:
                slope_[t] = float(np.polyfit(np.arange(len(seg)), seg, 1)[0])

        chem_arr_ = np.full(n, float(chem_code), np.float32)

        # [cap, cc_time, vmean, vend, energy, temp, slope, ir, chem_code]
        feat = np.stack([cap_, cc_time_, vm_, vend_, en_, T_, slope_, ir_, chem_arr_],
                        axis=1).astype(np.float32)

        # ── Normalize ─────────────────────────────────────────────────────────
        if len(fmean) >= 9 and len(fstd) >= 9:
            fm = fmean[:9].copy()
            fs = fstd[:9].copy()
            # Arrhenius transform for slot 5:
            #   BiMambaAPF always uses Arrhenius (training script patches fm[5]=1.0)
            #   MambaRULFinal: check if checkpoint stored Arrhenius values (mean<5)
            #     oxford-nmc: feat_mean[5]=1.0 → Arrhenius model
            #     v10-final, hust-lfp: feat_mean[5]≈32 → raw temperature
            use_arrh = (model_class == "BiMambaAPF") or (float(fm[5]) < 5.0)
            if use_arrh:
                feat[:, 5] = np.exp(
                    6000.0 * (1.0 / 298.15 - 1.0 / (T_ + 273.15))
                ).astype(np.float32)
                # BiMamba patches normalization constants; Arrhenius-stored models use checkpoint value
                if model_class == "BiMambaAPF":
                    fm[5] = 1.0; fs[5] = 0.5
            fs = np.where(fs > 1e-8, fs, 1.0)
            feat_norm = (feat - fm) / fs
        else:
            feat_norm = feat  # no normalization if checkpoint lacks stats

        # ── Add derived features matching training: [cap_pct, dc, ec_n, di] ──
        def _add_derived_training(w: np.ndarray) -> np.ndarray:
            cap_w    = w[:, 0]
            energy_w = w[:, 4]
            ir_w     = w[:, 7]
            init  = float(cap_w[0]) if abs(float(cap_w[0])) > 1e-6 else 1.0
            cap_pct = (cap_w / init).astype(np.float32)
            dc   = np.zeros(len(w), np.float32)
            dc[1:] = (cap_w[1:] - cap_w[:-1]).astype(np.float32)
            ec   = np.cumsum(energy_w).astype(np.float32)
            em   = float(ec[-1]) if abs(float(ec[-1])) > 1e-6 else 1.0
            ec_n = (ec / em).astype(np.float32)
            di   = np.zeros(len(w), np.float32)
            di[1:] = (ir_w[1:] - ir_w[:-1]).astype(np.float32)
            return np.concatenate(
                [w, np.stack([cap_pct, dc, ec_n, di], axis=1)], axis=1
            ).astype(np.float32)  # (W, 13)

        W = _WINDOW
        windows = []
        for t in range(W - 1, n):
            w = feat_norm[t - W + 1: t + 1]
            windows.append(_add_derived_training(w))

        if not windows:
            return None

        X      = torch.tensor(np.stack(windows), dtype=torch.float32)   # (M, W, 13)
        chem_t = torch.full((len(windows),), chem_code, dtype=torch.long)

        # ── Inference ─────────────────────────────────────────────────────────
        model.eval()
        with torch.no_grad():
            if model_class == "BiMambaAPF":
                rul_n, soh_n = model(X, chem_code=chem_t)
                rul_norm = rul_n.numpy()
                soh_pred = soh_n.numpy()
            elif model_class in ("MambaRULTwoHead", "TwoHead"):
                rul_n, soh_n = model(X)
                rul_norm = rul_n.numpy()
                soh_pred = soh_n.numpy()
            else:
                out = model(X)
                rul_norm = (out if isinstance(out, np.ndarray) else out.numpy())
                soh_pred = None

        rul_cycles = np.maximum(0.0, rul_norm.flatten() * rul_max)
        half = _CONFORMAL_90.get(chem_up, 34.0)

        results = []
        for j, rul in enumerate(rul_cycles):
            soh_val = float(soh_pred[j]) if soh_pred is not None else None
            results.append({
                "predicted_rul": round(float(rul), 1),
                "lower_90":      round(max(0.0, float(rul) - half), 1),
                "upper_90":      round(float(rul) + half, 1),
                "soh_model":     round(soh_val * 100, 1) if soh_val is not None else None,
                "source":        "model",
            })
        return results

    except Exception as exc:
        logger.warning("windowed inference failed: %s — falling back to analytical", exc)
        return None


def _predict_cycle(soh: float, chem: str, ir: float | None = None) -> dict:
    """Analytical RUL estimate for a single cycle — used as fast fallback."""
    ir   = ir if ir is not None else 0.05
    mr   = _MAX_RUL.get(chem, 309.0)
    sc   = _SCALE.get(chem, 1.0)
    ir_f = max(0.5, 1 - (ir - 0.03) / 0.25)
    rul  = max(0.0, mr * sc * (soh ** _DECAY) * ir_f)
    half = _CONFORMAL_90.get(chem, 34.0)
    return {
        "predicted_rul": round(rul, 1),
        "lower_90":      round(max(0.0, rul - half), 1),
        "upper_90":      round(rul + half, 1),
        "soh_pct":       round(soh * 100, 1),
        "phase":         _phase(soh),
        "alert":         _alert_level(soh),
    }


def _parse_df(raw: bytes, filename: str) -> pd.DataFrame:
    try:
        if filename.endswith(".json"):
            return pd.read_json(io.BytesIO(raw))
        return pd.read_csv(io.BytesIO(raw))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not parse file: {e}")


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/ingest", response_class=JSONResponse)
@_rate_limit
async def ingest_csv(request: Request, file: UploadFile = File(...)) -> dict[str, Any]:
    """
    Accept a CSV or JSON file of per-cycle battery data.
    Returns chemistry detection, per-cycle SOH + RUL predictions, and a summary.

    Minimum required columns (case-insensitive, many aliases accepted):
      cycle, capacity

    Optional (improve predictions):
      voltage_mean, temperature, energy, int_resistance, chemistry
    """
    raw = await file.read()
    df  = _parse_df(raw, file.filename or "")
    if df.empty:
        raise HTTPException(status_code=422, detail="File is empty.")
    return _ingest_dataframe(df)


def _ingest_dataframe(df: "pd.DataFrame") -> dict[str, Any]:
    """Core ingest: an engineered per-cycle DataFrame (cycle, capacity, voltage_mean,
    …) → chemistry detection + per-cycle SOH/RUL. Shared by /ingest (CSV of engineered
    features) and /ingest/raw (raw V/I/T → features via core.raw_telemetry)."""
    # ── Column resolution ─────────────────────────────────────────
    col = {k: _resolve_col(df, k) for k in _ALIASES}

    if col["cycle"] is None and col["capacity"] is None:
        raise HTTPException(
            status_code=422,
            detail="Could not find 'cycle' or 'capacity' columns. "
                   "Please ensure your CSV has at minimum: cycle, capacity."
        )

    # ── Pull arrays ───────────────────────────────────────────────
    def _arr(key: str) -> np.ndarray | None:
        c = col[key]
        if c is None:
            return None
        try:
            return pd.to_numeric(df[c], errors="coerce").to_numpy(dtype=np.float32)
        except Exception:
            return None

    cycles   = _arr("cycle")
    capacity = _arr("capacity")
    vmean    = _arr("voltage_mean")
    vmin     = _arr("voltage_min")
    vmax     = _arr("voltage_max")
    imean    = _arr("current_mean")
    temp     = _arr("temperature")
    energy   = _arr("energy")
    ir       = _arr("int_resistance")

    # Chemistry from column or detection
    chem_raw = None
    if col["chemistry"] is not None:
        chem_raw = str(df[col["chemistry"]].dropna().iloc[0]) if not df[col["chemistry"]].dropna().empty else None

    chemistry, chem_conf = _detect_chemistry(vmean, capacity, chem_raw)

    n = len(df)

    # ── SOH from capacity ─────────────────────────────────────────
    if capacity is not None:
        init_cap = float(np.nanpercentile(capacity[:min(5, n)], 95)) or 1.0
        soh_arr  = np.clip(capacity / init_cap, 0.0, 1.05)
    else:
        soh_arr  = np.full(n, 0.85, dtype=np.float32)

    # ── Try windowed model inference (real 30-cycle windows) ─────
    model_preds = _run_windowed_inference(
        capacity, vmean, vmin, vmax, imean, temp, ir, energy, chemistry, n
    )
    # model_preds covers cycles [W-1 .. n-1]; first W-1 cycles use analytical

    # ── Per-cycle predictions ─────────────────────────────────────
    _BLEND_CYCLES = 20  # cycles over which we ramp from analytical → model
    predictions: list[dict] = []
    _model_cycle_count = 0
    for i in range(n):
        soh  = float(soh_arr[i])
        ir_i = float(ir[i]) if ir is not None else None

        model_i = model_preds[i - (_WINDOW - 1)] if (
            model_preds is not None and i >= _WINDOW - 1
        ) else None

        anal = _predict_cycle(soh, chemistry, ir_i)

        if model_i is not None:
            # Smooth blend: alpha=0 at first model cycle, 1 after _BLEND_CYCLES
            alpha = min(1.0, (i - (_WINDOW - 1)) / _BLEND_CYCLES)
            if alpha >= 1.0:
                p = {
                    "predicted_rul": model_i["predicted_rul"],
                    "lower_90":      model_i["lower_90"],
                    "upper_90":      model_i["upper_90"],
                    "soh_pct":       round(soh * 100, 1),
                    "phase":         _phase(soh),
                    "alert":         _alert_level(soh),
                    "source":        "model",
                }
                _model_cycle_count += 1
            else:
                rul_b  = alpha * model_i["predicted_rul"]  + (1 - alpha) * anal["predicted_rul"]
                lo_b   = alpha * model_i["lower_90"]       + (1 - alpha) * anal["lower_90"]
                hi_b   = alpha * model_i["upper_90"]       + (1 - alpha) * anal["upper_90"]
                p = {
                    "predicted_rul": round(rul_b, 1),
                    "lower_90":      round(max(0.0, lo_b), 1),
                    "upper_90":      round(hi_b, 1),
                    "soh_pct":       round(soh * 100, 1),
                    "phase":         _phase(soh),
                    "alert":         _alert_level(soh),
                    "source":        "blend",
                }
        else:
            p = {**anal, "source": "analytical"}

        p["cycle"] = int(cycles[i]) if cycles is not None else i + 1
        if capacity is not None:
            p["capacity"] = round(float(capacity[i]), 4)
        if vmean is not None:
            p["voltage_mean"] = round(float(vmean[i]), 3)
        if temp is not None:
            p["temperature"] = round(float(temp[i]), 1)
        predictions.append(p)

    # ── Summary ───────────────────────────────────────────────────
    soh_final   = float(soh_arr[-1]) if len(soh_arr) else 0.85
    rul_final   = predictions[-1]["predicted_rul"] if predictions else 0.0
    lower_final = predictions[-1]["lower_90"] if predictions else 0.0
    upper_final = predictions[-1]["upper_90"] if predictions else 0.0

    # Degradation rate (cycles per 1% SOH loss)
    if len(soh_arr) > 1:
        total_cycles = int(cycles[-1]) - int(cycles[0]) if cycles is not None else n
        soh_drop = float(soh_arr[0] - soh_arr[-1])
        fade_rate = round(soh_drop / max(total_cycles, 1) * 100, 4)  # % per cycle
    else:
        fade_rate = 0.0

    columns_found = {k: c for k, c in col.items() if c is not None}
    model_pct = round(_model_cycle_count / n * 100, 1) if n > 0 else 0.0
    prediction_engine = "model" if model_pct >= 80 else ("blend" if model_pct > 0 else "analytical")

    return {
        "summary": {
            "n_cycles":                n,
            "chemistry":               chemistry,
            "chemistry_conf":          chem_conf,
            "soh_initial_pct":         round(float(soh_arr[0]) * 100, 1),
            "soh_final_pct":           round(soh_final * 100, 1),
            "soh_drop_pct":            round((float(soh_arr[0]) - soh_final) * 100, 2),
            "fade_rate_pct_per_cycle": fade_rate,
            "predicted_rul":           rul_final,
            "lower_90":                lower_final,
            "upper_90":                upper_final,
            "phase":                   _phase(soh_final),
            "alert":                   _alert_level(soh_final),
            "confidence_pct":          90,
            "prediction_engine":       prediction_engine,
            "model_cycles_pct":        model_pct,
            "columns_found":           columns_found,
        },
        "predictions": predictions,
    }


@router.post("/ingest/raw", response_class=JSONResponse)
@_rate_limit
async def ingest_raw(request: Request,
                     file: UploadFile = File(...),
                     nom_capacity_ah: float = Form(...),
                     chemistry: str = Form("auto")) -> dict[str, Any]:
    """Accept a RAW BMS telemetry CSV (voltage, current[, temperature, time, cycle]).

    Coulomb-counts capacity and derives the engineered per-cycle features, then runs
    the same prediction path as /api/ingest. The only extra input is the cell's
    nominal capacity (Ah), needed to express SOH. No pre-computed capacity required.
    """
    raw = await file.read()
    from core.raw_telemetry import raw_to_cycle_dataframe
    try:
        df, meta = raw_to_cycle_dataframe(raw, nom_capacity_ah, chemistry)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    result = _ingest_dataframe(df)
    result["raw_extraction"] = meta
    return result


@router.post("/ingest/raw/fleet", response_class=JSONResponse)
@_rate_limit
async def ingest_raw_fleet(request: Request,
                           file: UploadFile = File(...),
                           nom_capacity_ah: float = Form(...),
                           chemistry: str = Form("auto")) -> dict[str, Any]:
    """Multi-cell raw V/I/T upload → one engineered cycle table per cell → predict
    each → return a fleet-shaped result. CSV must have a `cell_id` column.
    """
    raw = await file.read()
    from core.raw_telemetry import raw_to_fleet_dataframes
    try:
        dfs, meta = raw_to_fleet_dataframes(raw, nom_capacity_ah, chemistry)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    cells_out = []
    for cell_id, df in dfs.items():
        try:
            res = _ingest_dataframe(df)
            cells_out.append({
                "cell_id":     cell_id,
                "summary":     res["summary"],
                "predictions": res["predictions"],
                "n_cycles":    res["summary"]["n_cycles"],
                "soh_final_pct": res["summary"]["soh_final_pct"],
                "predicted_rul": res["summary"]["predicted_rul"],
            })
        except Exception as exc:
            logger.warning("per-cell inference failed for %s: %s", cell_id, exc)
            cells_out.append({"cell_id": cell_id, "error": str(exc)})

    # fleet aggregate
    valid = [c for c in cells_out if "error" not in c]
    if valid:
        avg_rul = round(sum(c["predicted_rul"] for c in valid) / len(valid), 1)
        min_rul = min(c["predicted_rul"] for c in valid)
        min_soh = min(c["soh_final_pct"] for c in valid)
        weak_cell = next((c["cell_id"] for c in valid if c["predicted_rul"] == min_rul), None)
    else:
        avg_rul = min_rul = min_soh = 0.0
        weak_cell = None

    return {
        "fleet_summary": {
            "n_cells":           meta["n_cells"],
            "n_skipped":         len(meta["skipped"]),
            "avg_predicted_rul": avg_rul,
            "min_predicted_rul": min_rul,
            "min_soh_pct":       min_soh,
            "weak_cell":         weak_cell,
        },
        "cells":            cells_out,
        "raw_extraction":   meta,
    }


class DetectChemRequest(BaseModel):
    voltage_mean: list[float] | None = None
    capacity: list[float] | None = None
    chemistry_hint: str | None = None


@router.post("/detect-chemistry")
def detect_chemistry(req: DetectChemRequest) -> dict[str, Any]:
    """
    Fingerprint battery chemistry from voltage and/or capacity series.
    Returns detected chemistry, confidence score, and reasoning.
    """
    vm  = np.array(req.voltage_mean, dtype=np.float32) if req.voltage_mean else None
    cap = np.array(req.capacity,     dtype=np.float32) if req.capacity     else None
    chem, conf = _detect_chemistry(vm, cap, req.chemistry_hint)

    # Build reasoning
    reasoning = []
    if req.chemistry_hint:
        reasoning.append(f"Explicit hint '{req.chemistry_hint}' matched → {chem}")
    elif vm is not None:
        v = float(np.nanmedian(vm))
        lo, hi = _VMEAN_RANGES.get(chem, (3.5, 3.9))
        reasoning.append(f"Median discharge voltage = {v:.3f} V fits {chem} range [{lo:.2f}–{hi:.2f} V]")
    elif cap is not None:
        c0 = float(np.nanpercentile(cap, 95))
        reasoning.append(f"Initial capacity ≈ {c0:.2f} Ah → best match {chem}")
    else:
        reasoning.append("No voltage or capacity data — defaulting to LCO")

    return {
        "chemistry":    chem,
        "confidence":   conf,
        "reasoning":    reasoning,
        "all_scores":   {
            c: round(max(0.0, 1.0 - abs(float(np.nanmedian(vm)) - (lo + hi) / 2) / ((hi - lo) / 2 + 0.1)), 3)
            if vm is not None else 0.0
            for c, (lo, hi) in _VMEAN_RANGES.items()
        } if vm is not None else {},
    }

"""
routers/weak_cell.py — Weak-cell propagation analysis with ML-predicted RUL.

POST /api/pack/weak-cell/analyze
    When auto_predict=True (default): runs BiMamba-APF v12 on each cell's
    features to predict RUL, then runs pack-level analysis on those predictions.
    When auto_predict=False: uses the rul values provided in the request body.
"""
from __future__ import annotations

import io
import csv
import logging
from typing import Optional, List
import numpy as _np
from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from pydantic import BaseModel, Field
from core.partial_cycle import extract_features_from_trace as _extract_trace

from core.pack_intelligence import (
    replacement_analysis,
    project_pack_timeline,
    propagation_stress_map,
    full_pack_intelligence,
)

logger = logging.getLogger(__name__)
router = APIRouter()


class CellInput(BaseModel):
    cell_id:      str   = "cell_0"
    soh:          float = Field(1.0, ge=0.0, le=1.0)       # cap_pct for model
    rul:          float = Field(500.0, ge=0.0)              # overwritten if auto_predict
    capacity_ah:  float = Field(5.0, gt=0.0)
    ir:           float = Field(0.05, ge=0.0)               # int_resistance for model
    chemistry:    str   = "NMC"
    fade_rate:    float = Field(0.0001, ge=0.0)
    # Extra features fed to the ML model (all optional — model uses fallback if absent)
    n_cycles:     Optional[int]   = None
    dod_pct:      Optional[float] = None
    temperature:  Optional[float] = None
    voltage_mean: Optional[float] = None
    voltage_end:  Optional[float] = None
    energy:       Optional[float] = None
    charge_time:  Optional[float] = None
    # Real measured per-cycle window (from raw BMS CSV) — list of 9-feature rows.
    # When present, the model sees the cell's true degradation trajectory instead
    # of a window synthesized from a single snapshot.
    observed_window: Optional[List[List[float]]] = None


class WeakCellRequest(BaseModel):
    cells:         List[CellInput]
    topology:      str   = Field("series", pattern="^(series|parallel|series-parallel)$")
    n_cycles:      int   = Field(500, ge=50, le=5000)
    timeline_step: int   = Field(25, ge=5, le=100)
    eol_soh:       float = Field(0.80, ge=0.5, le=0.95)
    auto_predict:  bool  = True    # call ML model to predict RUL per cell
    model_id:      str   = "v12-bimamba"


def _cell_to_features(cell: CellInput) -> dict:
    """
    Map CellInput fields to the feature dict expected by run_inference().

    capacity_ah = current measured capacity (Ah) — this is what the model sees.
    nom_capacity is intentionally NOT passed here so the OOD rescaling block
    (nom_cap > 2.0) does not trigger; the raw capacity value is used as-is,
    which is the validated inference path for this model.
    """
    feats: dict = {
        "cap_pct":        cell.soh,
        "soh_pct":        round(cell.soh * 100, 2),
        "capacity":       cell.capacity_ah,
        "int_resistance": cell.ir,
        "chemistry":      cell.chemistry,
    }
    if cell.n_cycles is not None:
        feats["n_cycles"] = cell.n_cycles
    if cell.dod_pct is not None:
        feats["dod_pct"] = cell.dod_pct
    if cell.temperature is not None:
        feats["temperature"] = cell.temperature
    if cell.voltage_mean is not None:
        feats["voltage_mean"] = cell.voltage_mean
    if cell.voltage_end is not None:
        feats["voltage_end"] = cell.voltage_end
    if cell.energy is not None:
        feats["energy"] = cell.energy
    if cell.charge_time is not None:
        feats["charge_time"] = cell.charge_time
    if cell.observed_window:
        feats["_observed_window"] = cell.observed_window
    return feats


def _predict_ruls(cells: List[CellInput], model_id: str) -> list[dict]:
    """
    Run ML inference for each cell. Returns list of per-cell prediction dicts.
    Falls back to analytical model if PyTorch model is unavailable.
    """
    from core.model_loader import run_inference
    results = []
    for cell in cells:
        feats = _cell_to_features(cell)
        try:
            pred = run_inference(model_id, feats)
        except Exception as exc:
            logger.warning("ML inference failed for %s: %s — using fallback", cell.cell_id, exc)
            pred = {
                "predicted_rul": cell.rul,
                "lower_bound":   max(0.0, cell.rul * 0.85),
                "upper_bound":   cell.rul * 1.15,
                "model_id":      "fallback",
                "mode":          "fallback",
            }
        results.append({
            "cell_id":     cell.cell_id,
            "predicted_rul": pred.get("predicted_rul", cell.rul),
            "lower_bound":   pred.get("lower_bound",   max(0.0, cell.rul * 0.85)),
            "upper_bound":   pred.get("upper_bound",   cell.rul * 1.15),
            "health_score":  pred.get("health_score",  round(cell.soh * 100, 1)),
            "phase":         pred.get("phase",         "Unknown"),
            "model_id":      pred.get("model_id",      model_id),
            "mode":          pred.get("mode",          "unknown"),
            "rul_std":       pred.get("rul_std",       None),
            "soh_predicted": pred.get("soh_predicted", None),
            "history_source":    pred.get("history_source",    "synthesized"),
            "n_observed_cycles": pred.get("n_observed_cycles", 1),
        })
    return results


@router.post("/pack/weak-cell/analyze")
def analyze_weak_cell(req: WeakCellRequest) -> dict:
    """
    Full weak-cell propagation analysis.

    auto_predict=True (default): ML model predicts RUL for each cell.
    auto_predict=False: uses rul values from the request body directly.
    """
    # ── Step 1: get per-cell RUL from ML model or use manual values ──────────
    ml_predictions: list[dict] = []
    cells_for_analysis = []

    if req.auto_predict:
        ml_predictions = _predict_ruls(req.cells, req.model_id)
        pred_by_id = {p["cell_id"]: p for p in ml_predictions}

        for cell in req.cells:
            pred = pred_by_id.get(cell.cell_id, {})
            cell_dict = cell.model_dump()
            cell_dict.pop("observed_window", None)   # don't echo the large input array
            cell_dict["rul"] = pred.get("predicted_rul", cell.rul)
            cell_dict["rul_source"] = "ml"
            cell_dict["rul_lower"]  = pred.get("lower_bound", max(0.0, cell.rul * 0.85))
            cell_dict["rul_upper"]  = pred.get("upper_bound", cell.rul * 1.15)
            cell_dict["model_id"]   = pred.get("model_id", req.model_id)
            cell_dict["mode"]       = pred.get("mode", "unknown")
            cell_dict["rul_std"]    = pred.get("rul_std")
            cell_dict["soh_predicted"] = pred.get("soh_predicted")
            cell_dict["history_source"]    = pred.get("history_source", "synthesized")
            cell_dict["n_observed_cycles"] = pred.get("n_observed_cycles", 1)
            cells_for_analysis.append(cell_dict)
    else:
        for cell in req.cells:
            cell_dict = cell.model_dump()
            cell_dict.pop("observed_window", None)
            cell_dict["rul_source"] = "manual"
            cell_dict["rul_lower"]  = max(0.0, cell.rul * 0.85)
            cell_dict["rul_upper"]  = cell.rul * 1.15
            cells_for_analysis.append(cell_dict)

    # ── Step 2: run all pack intelligence analyses ───────────────────────────
    full    = full_pack_intelligence(cells_for_analysis, topology=req.topology)
    repl    = replacement_analysis(cells_for_analysis, topology=req.topology)
    tl      = project_pack_timeline(
        cells_for_analysis,
        n_cycles=req.n_cycles,
        step=req.timeline_step,
        topology=req.topology,
        eol_soh=req.eol_soh,
    )
    thermal = propagation_stress_map(cells_for_analysis)

    # ── Step 3: compute EOL crossing summary ─────────────────────────────────
    eol_no_change = next(
        (pt["cycle"] for pt in tl if pt["eol_no_change"]), None
    )
    eol_with_replacement = next(
        (pt["cycle"] for pt in tl if pt["eol_replace_weakest"]), None
    )
    # Positive = replacement extends life; negative = already past EOL both ways
    cycles_extended = None
    if eol_no_change is not None and eol_with_replacement is not None:
        cycles_extended = eol_with_replacement - eol_no_change
    elif eol_no_change is not None and eol_with_replacement is None:
        # Replacement pushes EOL past projection window
        cycles_extended = req.n_cycles - eol_no_change

    top_replacement = repl[0] if repl else None

    # ── Step 4: enrich per_cell with CI bounds and rul_source ────────────────
    rul_meta = {c["cell_id"]: c for c in cells_for_analysis}
    per_cell_enriched = []
    for pc in full["per_cell"]:
        meta = rul_meta.get(pc["cell_id"], {})
        per_cell_enriched.append({
            **pc,
            "rul_source":    meta.get("rul_source", "manual"),
            "rul_lower":     meta.get("rul_lower"),
            "rul_upper":     meta.get("rul_upper"),
            "rul_std":       meta.get("rul_std"),
            "soh_predicted": meta.get("soh_predicted"),
            "model_id":      meta.get("model_id"),
            "mode":          meta.get("mode"),
        })

    first_failure = full["first_failure"]
    # Flag cells already past EOL
    if first_failure.get("cycles_to_eol", 1) == 0:
        first_failure["already_at_eol"] = True

    return {
        "summary": {
            "pack_health_score":       full["health"]["score"],
            "pack_health_grade":       full["health"]["grade"],
            "pack_rul_cycles":         full["pack_rul"]["pack_rul"],
            "n_weak_cells":            full["health"]["n_weak"],
            "cascade_risk_level":      full["cascade"]["level"],
            "thermal_risk_level":      thermal["thermal_risk_level"],
            "top_replacement_cell":    top_replacement["cell_id"] if top_replacement else None,
            "cycles_extended_by_swap": cycles_extended,
            "eol_no_change_cycle":     eol_no_change,
            "eol_with_swap_cycle":     eol_with_replacement,
            "rul_source":              "ml" if req.auto_predict else "manual",
            "model_used":              req.model_id if req.auto_predict else None,
        },
        "ml_predictions": ml_predictions,
        "replacement":    repl,
        "timeline":       tl,
        "thermal":        thermal,
        "per_cell":       per_cell_enriched,
        "cascade":        full["cascade"],
        "first_failure":  first_failure,
        "health":         full["health"],
        "pack_rul":       full["pack_rul"],
        "topology":       req.topology,
        "n_cells":        len(req.cells),
        "auto_predict":   req.auto_predict,
    }


# ── Raw BMS CSV upload helpers ────────────────────────────────────────────────

_COL_ALIASES: dict[str, list[str]] = {
    "time":        ["time", "t", "time_s", "time_sec", "timestamp", "time(s)",
                    "time_seconds", "seconds", "elapsed_s", "elapsed"],
    "voltage":     ["voltage", "v", "volt", "voltage_v", "v_cell", "vcell",
                    "batt_v", "u", "v_batt", "cell_voltage"],
    "current":     ["current", "i", "curr", "current_a", "i_cell", "icell",
                    "batt_i", "i_batt", "ampere"],
    "temperature": ["temperature", "temp", "temp_c", "temperature_c", "t_cell",
                    "tcell", "celsius", "t_amb", "temp_celsius"],
    "cell_id":     ["cell_id", "cell", "cellid", "battery_id", "battery",
                    "id", "pack_id"],
}


def _detect_columns(headers: list[str]) -> dict[str, int]:
    normalized = [h.strip().lower().replace(" ", "_").replace("-", "_") for h in headers]
    result: dict[str, int] = {}
    for canonical, aliases in _COL_ALIASES.items():
        for alias in aliases:
            if alias in normalized:
                result[canonical] = normalized.index(alias)
                break
    return result


def _parse_bms_csv(content: bytes) -> tuple[dict[str, dict], list[str]]:
    """Parse raw BMS CSV bytes into per-cell trace dicts.

    Returns per_cell: { cell_id -> {time, voltage, current, temperature} lists }
    and a list of warning strings.
    """
    text = content.decode("utf-8-sig", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    if len(rows) < 2:
        raise ValueError("CSV has fewer than 2 rows (need header + at least 1 data row).")

    col_map = _detect_columns(rows[0])
    warnings: list[str] = []

    for req_col in ("time", "voltage", "current"):
        if req_col not in col_map:
            raise ValueError(
                f"Required column '{req_col}' not found. "
                f"CSV headers: {rows[0]}. "
                f"Accepted names: {_COL_ALIASES[req_col]}"
            )

    has_temp    = "temperature" in col_map
    has_cell_id = "cell_id"     in col_map
    if not has_temp:
        warnings.append("No temperature column — assuming 25 °C for all rows.")
    if not has_cell_id:
        warnings.append("No cell_id column — treating entire CSV as a single cell 'cell_01'.")

    per_cell: dict[str, dict] = {}
    skipped = 0
    for row in rows[1:]:
        if not row:
            continue
        try:
            t_v = float(row[col_map["time"]])
            v_v = float(row[col_map["voltage"]])
            i_v = float(row[col_map["current"]])
            T_v = float(row[col_map["temperature"]]) if has_temp else 25.0
            cid = row[col_map["cell_id"]].strip() if has_cell_id else "cell_01"
        except (ValueError, IndexError):
            skipped += 1
            continue
        if cid not in per_cell:
            per_cell[cid] = {"time": [], "voltage": [], "current": [], "temperature": []}
        per_cell[cid]["time"].append(t_v)
        per_cell[cid]["voltage"].append(v_v)
        per_cell[cid]["current"].append(i_v)
        per_cell[cid]["temperature"].append(T_v)

    if skipped:
        warnings.append(f"Skipped {skipped} rows with non-numeric values.")
    return per_cell, warnings


def _extract_cell_features_from_bms(
    cell_data: dict,
    chemistry: str,
    nom_capacity_ah: float,
) -> dict:
    """Coulomb-count a raw BMS trace and extract features for the ML model.

    Returns a dict with: measured_capacity_ah, soh, n_cycles_detected, ir_proxy,
    temperature, fade_rate, completeness, data_quality, warnings, and model
    feature fields (voltage_mean, voltage_end, energy, charge_time).
    """
    t = _np.asarray(cell_data["time"],        dtype=_np.float64)
    v = _np.asarray(cell_data["voltage"],     dtype=_np.float64)
    i = _np.asarray(cell_data["current"],     dtype=_np.float64)
    T = _np.asarray(cell_data["temperature"], dtype=_np.float64)

    fallback_defaults = {
        "measured_capacity_ah": round(nom_capacity_ah * 0.9, 4),
        "soh": 0.90,
        "n_cycles_detected": 0,
        "ir_proxy": 0.035,
        "temperature": float(_np.mean(T)) if len(T) else 25.0,
        "fade_rate": 0.0002,
        "completeness": 0.0,
        "data_quality": "low",
        "warnings": ["Insufficient data points."],
        "voltage_mean": float(_np.mean(v)) if len(v) else 3.6,
        "voltage_end": float(v[-1]) if len(v) else 3.2,
        "energy": 0.0,
        "charge_time": 3600.0,
        "observed_window": None,
    }

    if len(t) < 10:
        return fallback_defaults

    # Detect discharge sign convention (positive or negative current = discharge)
    n_pos = int(_np.sum(i >  0.05))
    n_neg = int(_np.sum(i < -0.05))
    discharge_positive = (n_pos >= n_neg) if (n_pos + n_neg) > 0 else True
    dis_mask = (i > 0.05) if discharge_positive else (i < -0.05)

    # Split trace into discharge cycle segments
    cycle_slices: list[slice] = []
    in_dis = False
    seg_start = 0
    for k in range(len(i)):
        if dis_mask[k] and not in_dis:
            in_dis = True;  seg_start = k
        elif not dis_mask[k] and in_dis:
            in_dis = False
            if k - seg_start >= 5:
                cycle_slices.append(slice(seg_start, k))
    if in_dis and len(i) - seg_start >= 5:
        cycle_slices.append(slice(seg_start, len(i)))
    if not cycle_slices:
        cycle_slices = [slice(0, len(i))]   # entire trace as one cycle

    # Extract features from each discharge segment
    all_results: list[dict] = []
    for sl in cycle_slices:
        seg_i = _np.abs(i[sl])              # partial_cycle expects |I|
        try:
            res = _extract_trace(
                v=v[sl], i=seg_i, t=t[sl], T=T[sl],
                chemistry=chemistry,
                nom_capacity_ah=nom_capacity_ah,
            )
            all_results.append(res)
        except Exception:
            continue

    if not all_results:
        try:
            res = _extract_trace(v=v, i=_np.abs(i), t=t, T=T,
                                 chemistry=chemistry, nom_capacity_ah=nom_capacity_ah)
            all_results = [res]
        except Exception:
            return fallback_defaults

    latest   = all_results[-1]
    feat9    = latest["features_9"]
    measured = float(feat9[0])
    soh      = float(_np.clip(measured / nom_capacity_ah, 0.01, 1.0))

    # Fade rate from capacity trend across detected cycles
    fade_rate = 0.0002
    if len(all_results) >= 3:
        caps = _np.array([r["q_estimated_ah"] for r in all_results], dtype=_np.float64)
        valid = caps[caps > 0.01]
        if len(valid) >= 3 and valid[0] > valid[-1]:
            total_fade = (valid[0] - valid[-1]) / valid[0]
            fade_rate  = float(_np.clip(total_fade / len(valid), 1e-5, 0.005))

    ir = float(feat9[7])
    if ir < 0.001:
        ir = 0.035  # voltage spread near zero → use typical NMC value

    # Real measured per-cycle window for the model (last 30 cycles, 9 features each)
    observed_window = [r["features_9"].astype(float).tolist() for r in all_results][-30:]

    return {
        "measured_capacity_ah": round(measured, 4),
        "soh":                  round(soh, 4),
        "n_cycles_detected":    len(all_results),
        "ir_proxy":             round(ir, 5),
        "temperature":          round(float(feat9[5]), 2),
        "fade_rate":            round(fade_rate, 6),
        "completeness":         latest["completeness"],
        "data_quality":         latest["data_quality"],
        "warnings":             latest["warnings"],
        "voltage_mean":         round(float(feat9[2]), 4),
        "voltage_end":          round(float(feat9[3]), 4),
        "energy":               round(float(feat9[4]), 4),
        "charge_time":          round(float(feat9[1]), 2),
        "observed_window":      observed_window,
    }


@router.post("/pack/weak-cell/analyze-from-csv")
async def analyze_weak_cell_from_csv(
    file:           UploadFile = File(...),
    nom_capacity_ah: float = Form(default=5.0,  gt=0.0),
    chemistry:      str   = Form(default="NMC"),
    topology:       str   = Form(default="series"),
    n_cycles_proj:  int   = Form(default=500,   ge=50,  le=5000),
    eol_soh:        float = Form(default=0.80,  ge=0.5, le=0.95),
    model_id:       str   = Form(default="v12-bimamba"),
) -> dict:
    """
    Upload raw BMS CSV (time, voltage, current; temperature optional) + nominal capacity.
    Backend Coulomb-counts each discharge cycle to derive SOH, measured capacity, and
    IR proxy, then runs ML inference → full pack analysis.

    CSV column names are detected flexibly (see _COL_ALIASES).
    A 'cell_id' column splits multi-cell data; without it, entire CSV = one cell.
    Pack analysis requires ≥ 2 cells.
    """
    content = await file.read()

    try:
        per_cell_raw, csv_warnings = _parse_bms_csv(content)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    if not per_cell_raw:
        raise HTTPException(status_code=422, detail="No valid data rows found in CSV.")

    if len(per_cell_raw) < 2:
        raise HTTPException(
            status_code=422,
            detail=(
                f"Pack analysis requires ≥ 2 cells — found {len(per_cell_raw)} in CSV. "
                "Add a 'cell_id' column to separate multi-cell rows, "
                "or use /api/predict for single-cell RUL prediction."
            ),
        )

    # Coulomb counting + feature extraction per cell
    feature_extraction: dict[str, dict] = {}
    cells_list: list[CellInput] = []

    for cid, raw in per_cell_raw.items():
        ext = _extract_cell_features_from_bms(raw, chemistry, nom_capacity_ah)
        feature_extraction[cid] = ext
        cells_list.append(CellInput(
            cell_id      = cid,
            soh          = ext["soh"],
            rul          = 0.0,
            capacity_ah  = ext["measured_capacity_ah"],
            ir           = ext["ir_proxy"],
            chemistry    = chemistry,
            fade_rate    = ext["fade_rate"],
            n_cycles     = ext["n_cycles_detected"] if ext["n_cycles_detected"] > 0 else None,
            temperature  = ext["temperature"],
            voltage_mean = ext["voltage_mean"],
            voltage_end  = ext["voltage_end"],
            energy       = ext["energy"],
            charge_time  = ext["charge_time"],
            observed_window = ext.get("observed_window"),
        ))

    req = WeakCellRequest(
        cells        = cells_list,
        topology     = topology,
        n_cycles     = n_cycles_proj,
        timeline_step= 25,
        eol_soh      = eol_soh,
        auto_predict = True,
        model_id     = model_id,
    )
    result = analyze_weak_cell(req)
    result["feature_extraction"] = feature_extraction
    result["csv_warnings"]       = csv_warnings
    return result

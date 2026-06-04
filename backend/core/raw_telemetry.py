"""
core/raw_telemetry.py — Unified raw-telemetry (V/I/T) → engineered per-cycle features.

Real BMS data is just voltage, current, temperature (plus time and/or a cycle
index). This layer turns that into the per-cycle feature table the prediction
pipeline expects — capacity (Coulomb counting), voltage stats, IR proxy, energy —
so a user uploading raw telemetry never has to pre-compute capacity.

The ONLY value that cannot be derived from V/I/T is absolute SOH, which needs the
cell's nominal (new) capacity — a single number from the spec sheet.

Output: a DataFrame with columns ingest._ingest_dataframe consumes:
    cycle, capacity, voltage_mean, voltage_min, voltage_max,
    current_mean, temperature, int_resistance, energy[, chemistry]
"""
from __future__ import annotations

import csv
import io
import logging

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_ALIASES: dict[str, list[str]] = {
    "time":        ["time", "t", "time_s", "time_sec", "timestamp", "time(s)", "seconds", "elapsed_s"],
    "voltage":     ["voltage", "v", "volt", "voltage_v", "v_cell", "vcell", "u", "cell_voltage", "ecell/v"],
    "current":     ["current", "i", "curr", "current_a", "current(a)", "current(ma)", "i_cell", "i/ma", "amps"],
    "temperature": ["temperature", "temp", "temp_c", "temperature_c", "t_cell", "celsius", "t_amb"],
    "cycle":       ["cycle", "cycle_index", "cycle_number", "cyc"],
    "cell_id":     ["cell_id", "cell", "battery_id", "battery", "id"],
}


def _norm(h: str) -> str:
    return h.strip().lower().replace(" ", "_").replace("-", "_")


def _detect_columns(headers: list[str]) -> dict[str, int]:
    norm = [_norm(h) for h in headers]
    out: dict[str, int] = {}
    for field, names in _ALIASES.items():
        for n in names:
            if n in norm:
                out[field] = norm.index(n)
                break
    return out


def _is_milli(headers: list[str], idx: int) -> bool:
    h = _norm(headers[idx])
    return ("ma" in h) or ("/ma" in h)


def _segment_by_current(i: np.ndarray, min_pts: int = 5) -> list[slice]:
    """Split a continuous trace into discharge segments (one per cycle) by current sign."""
    n_pos, n_neg = int(np.sum(i > 0.05)), int(np.sum(i < -0.05))
    discharge_pos = (n_pos >= n_neg) if (n_pos + n_neg) else True
    mask = (i > 0.05) if discharge_pos else (i < -0.05)
    segs, in_seg, start = [], False, 0
    for k in range(len(i)):
        if mask[k] and not in_seg:
            in_seg, start = True, k
        elif not mask[k] and in_seg:
            in_seg = False
            if k - start >= min_pts:
                segs.append(slice(start, k))
    if in_seg and len(i) - start >= min_pts:
        segs.append(slice(start, len(i)))
    return segs or [slice(0, len(i))]


def _cycle_features(v: np.ndarray, i: np.ndarray, t: np.ndarray, T: np.ndarray) -> dict:
    """Engineered features for one cycle's raw V/I/T trace."""
    dt = np.diff(t, prepend=t[0])
    cap = float(np.sum(np.abs(i) * dt / 3600.0))            # Ah (Coulomb counting)
    vmean = float(np.mean(v))
    energy = abs(float(np.trapezoid(v, np.cumsum(np.abs(i) * dt / 3600.0)))) if len(v) > 1 else cap * vmean
    return {
        "capacity":       round(cap, 5),
        "voltage_mean":   round(vmean, 4),
        "voltage_min":    round(float(np.min(v)), 4),
        "voltage_max":    round(float(np.max(v)), 4),
        "current_mean":   round(float(np.mean(np.abs(i))), 4),
        "temperature":    round(float(np.mean(T)), 2),
        "int_resistance": round(float(np.max(v) - vmean), 5),   # voltage-spread IR proxy
        "energy":         round(energy, 5),
    }


def _parse_raw_per_cell(content: bytes) -> tuple[dict, dict, list[str], list[str], bool]:
    """Shared parser: raw CSV → per-cell dict of {V,I,T,TS,CY arrays} + metadata.

    Returns (per_cell_arrays, cols, warnings, headers, has_cycle_col).
    """
    text = content.decode("utf-8-sig", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    if len(rows) < 3:
        raise ValueError("CSV has too few rows for raw telemetry.")
    headers = rows[0]
    cols = _detect_columns(headers)
    warnings: list[str] = []
    for req in ("voltage", "current"):
        if req not in cols:
            raise ValueError(
                f"Raw telemetry needs at least voltage + current columns "
                f"(temperature optional). Missing '{req}'. Headers: {headers}"
            )
    has_temp, has_time = "temperature" in cols, "time" in cols
    has_cycle, has_cell = "cycle" in cols, "cell_id" in cols
    if not has_temp:
        warnings.append("no temperature column — assuming 25 °C")
    if not has_time and not has_cycle:
        warnings.append("no time/cycle column — using row order as time (1 s steps)")
    milli_i = _is_milli(headers, cols["current"])
    if milli_i:
        warnings.append("current in mA → converted to A")

    per_cell: dict[str, dict[str, list]] = {}
    skipped = 0
    for ridx, row in enumerate(rows[1:]):
        try:
            cid = row[cols["cell_id"]].strip() if has_cell else "cell"
            v = float(row[cols["voltage"]])
            cur = float(row[cols["current"]]) / (1000.0 if milli_i else 1.0)
            temp = float(row[cols["temperature"]]) if has_temp else 25.0
            ts = float(row[cols["time"]]) if has_time else float(ridx)
            cyc = int(float(row[cols["cycle"]])) if has_cycle else 0
        except (ValueError, IndexError):
            skipped += 1
            continue
        d = per_cell.setdefault(cid, {"V": [], "I": [], "T": [], "TS": [], "CY": []})
        d["V"].append(v); d["I"].append(cur); d["T"].append(temp); d["TS"].append(ts); d["CY"].append(cyc)
    if skipped:
        warnings.append(f"skipped {skipped} non-numeric rows")
    return per_cell, cols, warnings, headers, has_cycle


def _cell_arrays_to_cycle_df(arrays: dict, has_cycle: bool, chemistry: str,
                             nom_capacity_ah: float) -> tuple[pd.DataFrame, str]:
    """Convert one cell's parsed arrays into the engineered per-cycle DataFrame."""
    V = np.asarray(arrays["V"])
    I = np.asarray(arrays["I"])
    T = np.asarray(arrays["T"])
    TS = np.asarray(arrays["TS"])
    CY = np.asarray(arrays["CY"])
    out_rows = []
    if has_cycle and len(np.unique(CY)) > 1:
        cycle_source = "cycle_column"
        for c in sorted(np.unique(CY)):
            m = CY == c
            if m.sum() < 3:
                continue
            f = _cycle_features(V[m], I[m], TS[m], T[m]); f["cycle"] = int(c)
            out_rows.append(f)
    else:
        cycle_source = "current_sign_segmentation"
        for n, sl in enumerate(_segment_by_current(I), start=1):
            if (sl.stop - sl.start) < 3:
                continue
            f = _cycle_features(V[sl], I[sl], TS[sl], T[sl]); f["cycle"] = n
            out_rows.append(f)
    if not out_rows:
        raise ValueError("No usable cycles detected in raw telemetry.")
    df = pd.DataFrame(out_rows).sort_values("cycle").reset_index(drop=True)
    if chemistry and chemistry.lower() != "auto":
        df["chemistry"] = chemistry
    return df, cycle_source


def raw_to_cycle_dataframe(content: bytes, nom_capacity_ah: float,
                           chemistry: str = "auto") -> tuple[pd.DataFrame, dict]:
    """Parse a raw V/I/T CSV → engineered per-cycle DataFrame + extraction metadata.

    Single-cell view: if the CSV has a `cell_id` column with multiple cells, only
    the first cell is used. For all cells, see `raw_to_fleet_dataframes`.
    """
    text = content.decode("utf-8-sig", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    per_cell, cols, warnings, headers, has_cycle = _parse_raw_per_cell(content)
    if not per_cell:
        raise ValueError("No valid telemetry rows found.")
    target_cell = next(iter(per_cell))
    if len(per_cell) > 1:
        warnings.append(f"multi-cell CSV ({len(per_cell)} cells) — using first cell "
                        f"'{target_cell}'; use /ingest/raw/fleet for all cells")
    arrays = per_cell[target_cell]
    if len(arrays["V"]) < 5:
        raise ValueError("Too few valid telemetry rows after parsing.")
    df, cycle_source = _cell_arrays_to_cycle_df(arrays, has_cycle, chemistry, nom_capacity_ah)

    meta = {
        "n_cycles":          len(df),
        "cycle_source":      cycle_source,
        "nominal_capacity_ah": nom_capacity_ah,
        "measured_capacity_ah": round(float(df["capacity"].iloc[0]), 5) if len(df) else 0.0,
        "soh_initial":       round(float(df["capacity"].iloc[0]) / nom_capacity_ah, 4) if (len(df) and nom_capacity_ah > 0) else None,
        "columns_detected":  {k: headers[v] for k, v in cols.items()},
        "warnings":          warnings,
    }
    return df, meta


def raw_to_fleet_dataframes(content: bytes, nom_capacity_ah: float,
                            chemistry: str = "auto") -> tuple[dict[str, pd.DataFrame], dict]:
    """Parse a multi-cell raw V/I/T CSV (with `cell_id` column) → one engineered
    per-cycle DataFrame per cell. Returns (per_cell_dfs, meta).

    Cells with too few rows are skipped (logged in meta.skipped).
    """
    per_cell_arrays, cols, warnings, headers, has_cycle = _parse_raw_per_cell(content)
    if not per_cell_arrays:
        raise ValueError("No valid telemetry rows found.")

    dfs: dict[str, pd.DataFrame] = {}
    per_cell_meta: dict[str, dict] = {}
    skipped: list[dict] = []
    for cid, arrays in per_cell_arrays.items():
        if len(arrays["V"]) < 5:
            skipped.append({"cell_id": cid, "reason": "too few rows", "n_rows": len(arrays["V"])})
            continue
        try:
            df, cycle_source = _cell_arrays_to_cycle_df(arrays, has_cycle, chemistry, nom_capacity_ah)
        except ValueError as exc:
            skipped.append({"cell_id": cid, "reason": str(exc)})
            continue
        dfs[cid] = df
        per_cell_meta[cid] = {
            "n_cycles":             len(df),
            "cycle_source":         cycle_source,
            "measured_capacity_ah": round(float(df["capacity"].iloc[0]), 5) if len(df) else 0.0,
            "soh_initial":          round(float(df["capacity"].iloc[0]) / nom_capacity_ah, 4)
                                    if (len(df) and nom_capacity_ah > 0) else None,
        }

    if not dfs:
        raise ValueError("No usable cells in CSV after parsing.")

    meta = {
        "n_cells":            len(dfs),
        "cells":              list(dfs.keys()),
        "skipped":            skipped,
        "nominal_capacity_ah": nom_capacity_ah,
        "columns_detected":   {k: headers[v] for k, v in cols.items()},
        "warnings":           warnings,
        "per_cell":           per_cell_meta,
    }
    return dfs, meta

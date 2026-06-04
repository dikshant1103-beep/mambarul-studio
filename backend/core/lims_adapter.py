"""
core/lims_adapter.py — Manufacturing / lab cycler import (LIMS/MES connector).

Parses vendor cycler exports (Arbin, Maccor, Neware, BioLogic EC-Lab, or a
generic cycle/capacity CSV), normalises units (mA/mAh → A/Ah), and reduces them
to a per-cycle capacity-fade trajectory — the canonical form the prediction
pipeline consumes (cycle, capacity). Opens the manufacturing/QA segment without
forcing customers to reformat their cycler output.
"""
from __future__ import annotations

import csv
import io
import logging

logger = logging.getLogger(__name__)

# logical field → accepted header names (normalized: lower, no spaces/units-spacing)
_ALIASES: dict[str, list[str]] = {
    "cycle":     ["cycle_index", "cycle", "cyc", "cycle_number", "cyclenumber"],
    "voltage":   ["voltage(v)", "voltage", "ecell/v", "v", "potential(v)", "volt"],
    "current":   ["current(a)", "current(ma)", "current", "i/ma", "i(a)", "i", "amps"],
    "dcap":      ["discharge_capacity(ah)", "discharge_capacity", "q_discharge/ma.h",
                  "qdischarge/ma.h", "discharge_capacity(mah)", "dcap", "discharge_capacity_ah"],
    "capacity":  ["capacity(mah)", "capacity(ah)", "capacity", "cap", "q/ma.h"],
    "time":      ["test_time(s)", "testtime", "time/s", "time(s)", "time", "total_time", "test_time"],
    "step":      ["step_index", "step", "md", "mode"],
}

_SIGNATURES = {
    "arbin":    ["cycle_index", "test_time(s)"],
    "neware":   ["capacity(mah)", "current(ma)"],
    "biologic": ["ecell/v"],
    "maccor":   ["cyc", "md"],
}


def _norm(h: str) -> str:
    return h.strip().lower().replace(" ", "_").replace("__", "_")


def _detect_columns(headers: list[str]) -> dict[str, int]:
    norm = [_norm(h) for h in headers]
    out: dict[str, int] = {}
    for field, names in _ALIASES.items():
        for n in names:
            if n in norm:
                out[field] = norm.index(n)
                break
    return out


def detect_format(headers: list[str]) -> str:
    norm = set(_norm(h) for h in headers)
    for fmt, sig in _SIGNATURES.items():
        if all(s in norm for s in sig):
            return fmt
    return "generic"


def _is_milli(headers: list[str], col_idx: int) -> bool:
    """True if the column's unit is milli (mA / mAh)."""
    h = _norm(headers[col_idx])
    return ("ma" in h) or ("/ma" in h)   # matches (ma), (mah), /ma.h, i/ma


def parse_lims_csv(content: bytes) -> dict:
    """Parse a cycler export → per-cycle capacity-fade trajectory.

    Returns: {format, n_rows, n_cycles, capacity_unit, cycles:[{cycle,
    discharge_capacity_ah, voltage_mean}], normalized_csv, soh_trajectory, warnings}.
    """
    text = content.decode("utf-8-sig", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    rows = [r for r in csv.reader(io.StringIO(text)) if r]
    if len(rows) < 2:
        raise ValueError("CSV has fewer than 2 rows (need header + data).")

    headers = rows[0]
    fmt = detect_format(headers)
    cols = _detect_columns(headers)
    warnings: list[str] = []

    if "cycle" not in cols:
        raise ValueError(f"No cycle column found. Headers: {headers}")
    cap_field = "dcap" if "dcap" in cols else ("capacity" if "capacity" in cols else None)
    if cap_field is None and "current" not in cols:
        raise ValueError("No capacity or current column — cannot derive capacity fade.")

    cap_idx = cols.get(cap_field) if cap_field else None
    milli_cap = _is_milli(headers, cap_idx) if cap_idx is not None else False
    if milli_cap:
        warnings.append("capacity in mAh → converted to Ah")

    # group per cycle: track max capacity (cumulative within a cycle) + mean voltage
    per_cycle: dict[int, dict] = {}
    skipped = 0
    for row in rows[1:]:
        try:
            cyc = int(float(row[cols["cycle"]]))
        except (ValueError, IndexError):
            skipped += 1
            continue
        rec = per_cycle.setdefault(cyc, {"cap": 0.0, "v_sum": 0.0, "v_n": 0})
        if cap_idx is not None:
            try:
                val = float(row[cap_idx])
                if milli_cap:
                    val /= 1000.0
                rec["cap"] = max(rec["cap"], val)
            except (ValueError, IndexError):
                pass
        if "voltage" in cols:
            try:
                rec["v_sum"] += float(row[cols["voltage"]]); rec["v_n"] += 1
            except (ValueError, IndexError):
                pass

    cycles = []
    for cyc in sorted(per_cycle):
        rec = per_cycle[cyc]
        cycles.append({
            "cycle": cyc,
            "discharge_capacity_ah": round(rec["cap"], 5),
            "voltage_mean": round(rec["v_sum"] / rec["v_n"], 4) if rec["v_n"] else None,
        })

    # SOH trajectory relative to the first (nominal) cycle capacity
    caps = [c["discharge_capacity_ah"] for c in cycles if c["discharge_capacity_ah"] > 0]
    nominal = caps[0] if caps else 0.0
    soh = []
    for c in cycles:
        if nominal > 0 and c["discharge_capacity_ah"] > 0:
            soh.append({"cycle": c["cycle"], "soh": round(c["discharge_capacity_ah"] / nominal, 4)})

    # normalized CSV the existing /api/ingest + predict pipeline understands
    norm_lines = ["cycle,capacity"]
    norm_lines += [f"{c['cycle']},{c['discharge_capacity_ah']:.5f}"
                   for c in cycles if c["discharge_capacity_ah"] > 0]

    if skipped:
        warnings.append(f"skipped {skipped} non-numeric rows")

    return {
        "format":         fmt,
        "n_rows":         len(rows) - 1,
        "n_cycles":       len(cycles),
        "capacity_unit":  "mAh→Ah" if milli_cap else "Ah",
        "nominal_capacity_ah": round(nominal, 5),
        "cycles":         cycles,
        "soh_trajectory": soh,
        "normalized_csv": "\n".join(norm_lines),
        "warnings":       warnings,
    }

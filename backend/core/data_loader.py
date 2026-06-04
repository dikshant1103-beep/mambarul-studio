"""
core/data_loader.py
-------------------
Loads processed battery dataset files into shared memory and exposes
query helpers used by routers.

Files consumed
--------------
processed/multi_dataset_meta.csv   — (N, 7): cell_id, dataset, chemistry_name,
                                      chemistry_code, cycle, rul, split
processed/multi_dataset_features.npy — (N, 9) raw feature matrix
processed/multi_dataset_rul.npy      — (N,)  RUL labels

Feature index map (raw, 0-8)
-----------------------------
0: Capacity (Ah)      4: Energy (Wh)        8: Chem. Code
1: Charge Time (s)    5: Temperature (°C)
2: Voltage Mean (V)   6: Cap. Slope
3: Voltage End (V)    7: Int. Resistance (Ω)

Derived features (added in-memory, columns 9-12)
-------------------------------------------------
9: cap_pct (SOH)      10: Delta Cap
11: Cum. Energy       12: Delta IR

Chemistry codes
---------------
0 = LCO   1 = LFP   2 = NMC   3 = NCM / NCA
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).parent.parent
_PROJECT_ROOT = _BACKEND_DIR.parent.parent
_PROCESSED = _PROJECT_ROOT / "processed"

_META_PATH = _PROCESSED / "multi_dataset_meta.csv"
_FEAT_PATH = _PROCESSED / "multi_dataset_features.npy"
_RUL_PATH = _PROCESSED / "multi_dataset_rul.npy"

# ---------------------------------------------------------------------------
# Feature metadata
# ---------------------------------------------------------------------------
RAW_FEATURE_NAMES = [
    "Capacity (Ah)",
    "Charge Time (s)",
    "Voltage Mean (V)",
    "Voltage End (V)",
    "Energy (Wh)",
    "Temperature (°C)",
    "Cap. Slope",
    "Int. Resistance (Ω)",
    "Chem. Code",
]

DERIVED_FEATURE_NAMES = [
    "cap_pct (SOH)",
    "Delta Cap",
    "Cum. Energy",
    "Delta IR",
]

ALL_FEATURE_NAMES = RAW_FEATURE_NAMES + DERIVED_FEATURE_NAMES

CHEM_CODE_MAP = {0: "LCO", 1: "LFP", 2: "NMC", 3: "NCM"}

# ---------------------------------------------------------------------------
# In-memory state
# ---------------------------------------------------------------------------
_meta_df: pd.DataFrame | None = None
_features: np.ndarray | None = None
_rul: np.ndarray | None = None
_loaded: bool = False


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------
def _build_derived_features(meta: pd.DataFrame, features: np.ndarray) -> np.ndarray:
    """Append 4 derived feature columns to the raw (N,9) feature matrix."""
    n = len(features)
    cap = features[:, 0]           # Capacity (Ah)
    energy = features[:, 4]        # Energy (Wh)
    ir = features[:, 7]            # Internal Resistance

    cap_pct = np.zeros(n, dtype=np.float32)
    delta_cap = np.zeros(n, dtype=np.float32)
    cum_energy = np.zeros(n, dtype=np.float32)
    delta_ir = np.zeros(n, dtype=np.float32)

    cell_ids = meta["cell_id"].values

    for cell in np.unique(cell_ids):
        mask = cell_ids == cell
        idx = np.where(mask)[0]
        # Sort by cycle within cell
        cycles = meta.loc[mask, "cycle"].values
        order = np.argsort(cycles)
        sidx = idx[order]

        q = cap[sidx]
        e = energy[sidx]
        r = ir[sidx]

        q0 = q[0] if q[0] != 0 else 1.0
        cap_pct[sidx] = q / q0

        delta_cap[sidx[1:]] = np.diff(q)
        delta_cap[sidx[0]] = 0.0

        cum_energy[sidx] = np.cumsum(e)

        delta_ir[sidx[1:]] = np.diff(r)
        delta_ir[sidx[0]] = 0.0

    derived = np.column_stack([cap_pct, delta_cap, cum_energy, delta_ir])
    return np.concatenate([features, derived], axis=1).astype(np.float32)


def _generate_mock_data() -> tuple[pd.DataFrame, np.ndarray, np.ndarray]:
    """Return minimal synthetic data when real files are missing."""
    logger.warning("Generating mock dataset — real processed files not found.")
    rng = np.random.default_rng(42)

    chemistries = [("LCO", 0, "CALCE"), ("LFP", 1, "MIT"), ("NMC", 2, "KJTU"), ("NCM", 3, "TJU")]
    rows: list[dict] = []
    features_list: list[np.ndarray] = []
    rul_list: list[float] = []

    for chem_name, chem_code, dataset in chemistries:
        max_rul = 300 if chem_name == "LCO" else 900 if chem_name == "LFP" else 500
        for c in range(3):
            cell_id = f"{dataset}_mock_{c}"
            n_cycles = rng.integers(150, max_rul)
            for i in range(n_cycles):
                rul_val = float(n_cycles - i)
                cap = 1.0 * (1 - 0.0007 * i) + rng.normal(0, 0.005)
                f = np.array([
                    cap, 3600 + i * 2, 3.5 - i * 0.0005, 3.0,
                    cap * 3.5, 25.0, -0.001, 0.02 + i * 0.0001, float(chem_code),
                ], dtype=np.float32)
                split = "train" if i < int(n_cycles * 0.7) else "val" if i < int(n_cycles * 0.85) else "test"
                rows.append({
                    "cell_id": cell_id, "dataset": dataset,
                    "chemistry_name": chem_name, "chemistry_code": chem_code,
                    "cycle": i + 1, "rul": rul_val, "split": split,
                })
                features_list.append(f)
                rul_list.append(rul_val)

    meta = pd.DataFrame(rows)
    feats = np.stack(features_list)
    rul = np.array(rul_list, dtype=np.float32)
    return meta, feats, rul


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
def load_dataset() -> None:
    """Load CSV + npy files into module-level globals. Idempotent."""
    global _meta_df, _features, _rul, _loaded

    if _loaded:
        return

    if not (_META_PATH.exists() and _FEAT_PATH.exists() and _RUL_PATH.exists()):
        _meta_df, raw_features, _rul = _generate_mock_data()
    else:
        _meta_df = pd.read_csv(_META_PATH)
        raw_features = np.load(_FEAT_PATH).astype(np.float32)
        _rul = np.load(_RUL_PATH).astype(np.float32)

    # Align lengths defensively
    n = min(len(_meta_df), len(raw_features), len(_rul))
    _meta_df = _meta_df.iloc[:n].reset_index(drop=True)
    raw_features = raw_features[:n]
    _rul = _rul[:n]

    _features = _build_derived_features(_meta_df, raw_features)
    _loaded = True
    logger.info(
        "Dataset loaded: %d rows, %d feature columns, %d unique cells.",
        n,
        _features.shape[1],
        _meta_df["cell_id"].nunique(),
    )


def is_loaded() -> bool:
    return _loaded


def get_row_count() -> int:
    return len(_meta_df) if _meta_df is not None else 0


def get_meta_df() -> pd.DataFrame:
    """Return the raw metadata DataFrame (no copy — read-only use)."""
    if _meta_df is None:
        load_dataset()
    return _meta_df


def get_features_array() -> np.ndarray:
    """Return the (N, 9) raw feature matrix."""
    if _features is None:
        load_dataset()
    return _features


def get_rul_array() -> np.ndarray:
    """Return the (N,) RUL array."""
    if _rul is None:
        load_dataset()
    return _rul


def get_all_meta() -> pd.DataFrame:
    """Return a copy of the full metadata DataFrame."""
    if _meta_df is None:
        load_dataset()
    return _meta_df.copy()


# ---------------------------------------------------------------------------
# Catalog / summary helpers
# ---------------------------------------------------------------------------
def get_dataset_catalog() -> list[dict[str, Any]]:
    """Return a list of dicts summarising each dataset present in the data."""
    if _meta_df is None:
        load_dataset()

    result: list[dict] = []
    for ds_name, grp in _meta_df.groupby("dataset"):
        cell_ids = grp["cell_id"].unique().tolist()
        chem = grp["chemistry_name"].iloc[0]
        chem_code = int(grp["chemistry_code"].iloc[0])
        avg_cycles = grp.groupby("cell_id")["cycle"].max().mean()
        result.append({
            "dataset": ds_name,
            "chemistry_name": chem,
            "chemistry_code": chem_code,
            "cell_count": len(cell_ids),
            "avg_cycles": round(float(avg_cycles), 1),
            "total_rows": len(grp),
        })

    result.sort(key=lambda d: d["dataset"])
    return result


def get_cells_for_dataset(dataset_name: str) -> list[dict[str, Any]]:
    """Return per-cell summary rows for a given dataset name."""
    if _meta_df is None:
        load_dataset()

    sub = _meta_df[_meta_df["dataset"] == dataset_name]
    if sub.empty:
        # Try case-insensitive / partial match
        mask = _meta_df["dataset"].str.lower().str.contains(dataset_name.lower())
        sub = _meta_df[mask]

    cells: list[dict] = []
    for cell_id, grp in sub.groupby("cell_id"):
        grp_sorted = grp.sort_values("cycle")
        max_cycle = int(grp_sorted["cycle"].max())
        min_rul = float(grp_sorted["rul"].min())
        max_rul = float(grp_sorted["rul"].max())
        cells.append({
            "cell_id": cell_id,
            "dataset": dataset_name,
            "chemistry_name": grp["chemistry_name"].iloc[0],
            "chemistry_code": int(grp["chemistry_code"].iloc[0]),
            "total_cycles": max_cycle,
            "initial_rul": round(max_rul, 1),
            "final_rul": round(min_rul, 1),
            "splits": grp["split"].unique().tolist(),
        })

    cells.sort(key=lambda c: c["cell_id"])
    return cells


def get_cell_capacity_curve(cell_id: str) -> dict[str, Any]:
    """
    Return time-series capacity / RUL arrays for a single cell.

    Returns
    -------
    {
        "cell_id": str,
        "dataset": str,
        "chemistry_name": str,
        "cycles": [int, ...],
        "capacity": [float, ...],
        "rul": [float, ...],
        "soh": [float, ...],          # cap_pct  (index 9 in _features)
        "cum_energy": [float, ...]    # derived index 11
    }
    """
    if _meta_df is None:
        load_dataset()

    mask = _meta_df["cell_id"] == cell_id
    if not mask.any():
        return {}

    grp = _meta_df[mask].copy()
    grp = grp.sort_values("cycle").reset_index()
    row_indices = grp["index"].values  # original positions in _features

    cycles = grp["cycle"].tolist()
    rul_vals = grp["rul"].tolist()
    cap = _features[row_indices, 0].tolist()            # Capacity (Ah)
    soh = _features[row_indices, 9].tolist()            # cap_pct
    cum_energy = _features[row_indices, 11].tolist()    # Cum. Energy

    return {
        "cell_id": cell_id,
        "dataset": grp["dataset"].iloc[0],
        "chemistry_name": grp["chemistry_name"].iloc[0],
        "chemistry_code": int(grp["chemistry_code"].iloc[0]),
        "cycles": [int(c) for c in cycles],
        "capacity": [round(float(v), 4) for v in cap],
        "rul": [round(float(v), 1) for v in rul_vals],
        "soh": [round(float(v), 4) for v in soh],
        "cum_energy": [round(float(v), 3) for v in cum_energy],
    }


def get_fleet_summary(snapshot_frac: float = 0.60, max_cells: int = 40) -> list[dict[str, Any]]:
    """
    Return one fleet row per cell, sampled at a pseudo-random fraction of each cell's
    total life (seeded by cell_id) to simulate a real fleet where cells entered service
    at different times.

    Fields: cell_id, dataset, chemistry, soh_pct, rul, cycles_done, max_rul,
            phase, alert, ir
    """
    if _meta_df is None:
        load_dataset()

    _CHEM_MAX_RUL = {"LCO": 309, "LFP": 1934, "NMC": 1500, "NCM": 1000, "NCA": 800}

    rows: list[dict] = []
    for cell_id, grp in _meta_df.groupby("cell_id"):
        grp_sorted = grp.sort_values("cycle").reset_index()
        n = len(grp_sorted)
        if n < 5:
            continue

        # Deterministic per-cell life-stage: split into 3 buckets (fresh / aging / late)
        # so the fleet spans all degradation phases.
        seed = sum(ord(c) for c in str(cell_id))
        bucket = seed % 3
        inner  = (seed // 3) % 20   # 0-19 for within-bucket variation
        if bucket == 0:              # ~33% fresh (0-25% of life)
            frac = 0.05 + inner * 0.01
        elif bucket == 1:            # ~33% mid-aging (35-65% of life)
            frac = 0.35 + inner * 0.015
        else:                        # ~33% late / near-EOL (70-95% of life)
            frac = 0.70 + inner * 0.013
        frac = min(frac, 0.97)
        idx = max(0, min(n - 1, int(n * frac)))
        row_idx = grp_sorted.loc[idx, "index"]   # original position in _features

        cycle_done = int(grp_sorted.loc[idx, "cycle"])
        rul_val    = round(float(grp_sorted.loc[idx, "rul"]), 1)
        soh_frac   = float(_features[row_idx, 9])   # cap_pct
        soh_pct    = round(soh_frac * 100, 1)
        ir_val     = round(float(_features[row_idx, 7]), 5)
        chem       = grp_sorted["chemistry_name"].iloc[0]
        dataset    = grp_sorted["dataset"].iloc[0]
        max_rul    = _CHEM_MAX_RUL.get(chem, 309)

        # Phase / alert — thresholds tuned to lab-cell SOH range (80–100%)
        if soh_pct >= 96:
            phase, alert = "Fresh", "healthy"
        elif soh_pct >= 88:
            phase, alert = "Aging", "warning"
        elif soh_pct >= 82:
            phase, alert = "Knee", "warning"
        else:
            phase, alert = "Near-EOL", "critical"

        rows.append({
            "cell_id": cell_id,
            "dataset": dataset,
            "chemistry": chem,
            "soh": soh_pct,
            "rul": rul_val,
            "cycles": cycle_done,
            "max_rul": max_rul,
            "phase": phase,
            "alert": alert,
            "ir": ir_val,
        })

    # Return a proportional sample so all alert levels are represented.
    # Use deterministic selection (sorted by cell_id within each group).
    groups: dict[str, list] = {"critical": [], "warning": [], "healthy": []}
    for r in rows:
        groups[r["alert"]].append(r)
    for grp in groups.values():
        grp.sort(key=lambda r: r["cell_id"])

    # Allocate max_cells proportionally with a minimum of 5 per non-empty group
    total_raw = len(rows)
    result: list[dict] = []
    for key in ("critical", "warning", "healthy"):
        grp = groups[key]
        if not grp:
            continue
        alloc = max(5, round(max_cells * len(grp) / max(total_raw, 1)))
        result.extend(grp[:alloc])

    # Trim to max_cells, then sort for display
    result = result[:max_cells]
    result.sort(key=lambda r: (0 if r["alert"] == "critical" else 1 if r["alert"] == "warning" else 2, r["soh"]))
    return result


def get_chemistry_stats() -> dict[str, Any]:
    """
    Return per-chemistry aggregate statistics.

    Keys per chemistry: cell_count, avg_cycles, avg_initial_rul,
    avg_final_rul, avg_capacity, avg_soh_at_eol, datasets.
    """
    if _meta_df is None:
        load_dataset()

    stats: dict[str, Any] = {}

    for chem, grp in _meta_df.groupby("chemistry_name"):
        cell_groups = grp.groupby("cell_id")
        avg_cycles = cell_groups["cycle"].max().mean()

        # initial / final RUL per cell
        initial_ruls = cell_groups.apply(lambda g: g.loc[g["cycle"].idxmin(), "rul"])
        final_ruls = cell_groups.apply(lambda g: g.loc[g["cycle"].idxmax(), "rul"])

        # Capacity: mean across all rows for this chemistry
        cell_indices = _meta_df[_meta_df["chemistry_name"] == chem].index
        avg_cap = float(_features[cell_indices, 0].mean())

        # SOH at end of life: last row per cell
        eol_indices = grp.groupby("cell_id").apply(lambda g: g.index[g["cycle"].argmax()])
        avg_soh_eol = float(_features[eol_indices.values, 9].mean())

        datasets = sorted(grp["dataset"].unique().tolist())

        stats[chem] = {
            "chemistry_name": chem,
            "cell_count": int(grp["cell_id"].nunique()),
            "avg_cycles": round(float(avg_cycles), 1),
            "avg_initial_rul": round(float(initial_ruls.mean()), 1),
            "avg_final_rul": round(float(final_ruls.mean()), 1),
            "avg_capacity_ah": round(avg_cap, 4),
            "avg_soh_at_eol": round(avg_soh_eol, 4),
            "datasets": datasets,
        }

    return stats


def get_fleet_anomalies(max_cells: int = 40) -> list[dict[str, Any]]:
    """
    Return fleet summary rows annotated with anomaly flags.
    A cell is anomalous if its SOH or RUL deviates > 2σ from the mean
    of its chemistry group within the fleet snapshot.
    """
    import math
    rows = get_fleet_summary(max_cells=max_cells)

    # Compute per-chemistry mean + std for SOH and RUL
    from collections import defaultdict
    chem_soh: dict[str, list[float]] = defaultdict(list)
    chem_rul: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        chem_soh[r["chemistry"]].append(r["soh"])
        chem_rul[r["chemistry"]].append(r["rul"])

    def _stats(vals: list[float]) -> tuple[float, float]:
        if len(vals) < 2:
            return vals[0] if vals else 0.0, 0.0
        mu = sum(vals) / len(vals)
        std = math.sqrt(sum((v - mu)**2 for v in vals) / len(vals))
        return mu, std

    chem_soh_stats = {c: _stats(v) for c, v in chem_soh.items()}
    chem_rul_stats = {c: _stats(v) for c, v in chem_rul.items()}

    for r in rows:
        c = r["chemistry"]
        mu_s, std_s = chem_soh_stats.get(c, (r["soh"], 0.0))
        mu_r, std_r = chem_rul_stats.get(c, (r["rul"], 0.0))
        z_soh = abs(r["soh"] - mu_s) / std_s if std_s > 0 else 0.0
        z_rul = abs(r["rul"] - mu_r) / std_r if std_r > 0 else 0.0
        r["z_soh"]      = round(z_soh, 2)
        r["z_rul"]      = round(z_rul, 2)
        r["is_anomaly"] = z_soh > 2.0 or z_rul > 2.0
        r["anomaly_reason"] = (
            ("SOH outlier " if z_soh > 2.0 else "") +
            ("RUL outlier" if z_rul > 2.0 else "")
        ).strip() or None

    return rows

"""
core/matr_loader.py — MATR (MIT/Stanford/Toyota Research) dataset utilities.

Reads from the already-processed multi_dataset arrays.  All 129 MIT LFP cells
(4 batches, 2017–2018) are available in:
  processed/multi_dataset_features_clean.npy  (N, 9)  9 base features
  processed/multi_dataset_meta.csv            (N, 7)  cell_id, dataset, rul, split …

Public API
----------
  get_matr_info()           → dataset card dict
  list_matr_cells()         → list of per-cell dicts (lifetime, split, n_cycles)
  get_matr_cell_curve(cid)  → {cycles, capacity, rul} arrays for one cell
  get_matr_train_data(split)→ (X13, y_norm, cell_ids) ready for fine-tuning
"""
from __future__ import annotations
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

import os as _os
_BACKEND  = Path(__file__).parent.parent
# PROCESSED_DIR env var is injected by Electron when running inside an AppImage
# so the frozen binary can find the live processed/ directory on the real filesystem.
_PROC_ENV = _os.getenv("PROCESSED_DIR")
_PROC     = Path(_PROC_ENV) if _PROC_ENV else (_BACKEND.parent.parent / "processed")
_META_CSV = _PROC / "multi_dataset_meta.csv"
_FEAT_NPY = _PROC / "multi_dataset_features_clean.npy"

WINDOW_SIZE = 30
RUL_MAX     = 2000.0      # normalisation cap

# 9-base feature index map (multi_dataset_features_clean columns)
_CAP_COL  = 0   # capacity_Ah
_IR_COL   = 1   # internal_resistance_Ohm
_CT_COL   = 2   # cc_charge_time_s
_NRG_COL  = 3   # energy_throughput_Wh
_VM_COL   = 4   # volt_mean_discharge


# ── Lazy-loaded shared arrays ────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _load() -> tuple[np.ndarray, pd.DataFrame]:
    if not _META_CSV.exists() or not _FEAT_NPY.exists():
        raise FileNotFoundError(
            f"Processed dataset not found at {_PROC}. "
            "Run the feature-extraction pipeline first."
        )
    meta = pd.read_csv(_META_CSV)
    X    = np.load(str(_FEAT_NPY), mmap_mode="r")
    return X, meta


def _mit_mask() -> "np.ndarray":
    _, meta = _load()
    return (meta["dataset"] == "MIT").values


# ── Derived features (replicates finetune_mit_v10.add_derived) ──────────────

def _add_derived(X9: np.ndarray) -> np.ndarray:
    """Append 4 derived features → (N, 13)."""
    cap = X9[:, _CAP_COL].astype(np.float64)
    nrg = X9[:, _NRG_COL].astype(np.float64)
    ir  = X9[:, _IR_COL].astype(np.float64)

    ic = float(np.mean(cap[:min(5, len(cap))])) or 1.0
    if ic < 1e-6:
        ic = 1.0

    cap_pct = (cap / ic).astype(np.float32)
    dc      = np.zeros(len(cap), np.float32)
    dc[1:]  = (cap[1:] - cap[:-1]).astype(np.float32)

    ec    = np.cumsum(nrg)
    em    = float(ec[-1]) or 1.0
    e_cum = (ec / em).astype(np.float32)

    di     = np.zeros(len(ir), np.float32)
    di[1:] = (ir[1:] - ir[:-1]).astype(np.float32)

    derived = np.stack([cap_pct, dc, e_cum, di], axis=1)
    return np.concatenate([X9, derived], axis=1).astype(np.float32)


def _normalise(X13: np.ndarray, feat_mean: np.ndarray,
               feat_std: np.ndarray) -> np.ndarray:
    std = np.where(feat_std > 1e-8, feat_std, 1.0)
    Xz  = (X13[:, :9] - feat_mean[:9]) / std[:9]
    return np.concatenate([Xz, X13[:, 9:]], axis=1).astype(np.float32)


def _make_windows(X13: np.ndarray,
                  y_norm: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    n = len(X13)
    if n < WINDOW_SIZE:
        return np.empty((0, WINDOW_SIZE, 13), np.float32), np.empty(0, np.float32)
    wins, labs = [], []
    for i in range(n - WINDOW_SIZE + 1):
        wins.append(X13[i: i + WINDOW_SIZE])
        labs.append(float(y_norm[i + WINDOW_SIZE - 1]))
    return np.array(wins, np.float32), np.array(labs, np.float32)


# ── Public API ────────────────────────────────────────────────────────────────

def get_matr_info() -> dict[str, Any]:
    X, meta = _load()
    mask    = _mit_mask()
    m       = meta[mask]
    cells   = m["cell_id"].unique()
    lifetimes = m.groupby("cell_id")["rul"].max()
    splits  = m.groupby("split")["cell_id"].nunique().to_dict()
    return {
        "dataset":          "MATR",
        "full_name":        "MIT/Stanford/Toyota Research Fast-Charge Dataset",
        "reference":        "Severson et al., Nature Energy 2019",
        "chemistry":        "LFP",
        "form_factor":      "Cylindrical 18650",
        "nominal_capacity": 1.1,
        "n_cells":          int(len(cells)),
        "n_rows":           int(mask.sum()),
        "splits":           {k: int(v) for k, v in splits.items()},
        "lifetime_min":     int(lifetimes.min()),
        "lifetime_max":     int(lifetimes.max()),
        "lifetime_mean":    round(float(lifetimes.mean()), 1),
        "lifetime_median":  round(float(lifetimes.median()), 1),
        "batches": [
            "2017-05-12 (46 cells, standard CC-CV)",
            "2018-02-20 (47 cells, fast-charge variants)",
            "2018-04-12 (46 cells, additional protocols)",
        ],
        "features": [
            "capacity_Ah", "internal_resistance_Ohm", "cc_charge_time_s",
            "energy_throughput_Wh", "volt_mean_discharge", "voltage_plateau_dur_s",
            "ica_peak_dqdv", "discharge_slope",
            "+ 4 derived: cap_pct, delta_cap, cum_energy, delta_ir",
        ],
    }


def list_matr_cells() -> list[dict]:
    X, meta = _load()
    mask    = _mit_mask()
    m       = meta[mask]
    rows    = []
    for cid in sorted(m["cell_id"].unique()):
        cm = m[m["cell_id"] == cid]
        rows.append({
            "cell_id":   cid,
            "split":     str(cm["split"].iloc[0]),
            "n_cycles":  int(len(cm)),
            "lifetime":  int(cm["rul"].max()),
            "min_rul":   int(cm["rul"].min()),
        })
    return sorted(rows, key=lambda r: r["lifetime"], reverse=True)


def get_matr_cell_curve(cell_id: str) -> dict[str, Any]:
    X, meta = _load()
    mask    = _mit_mask() & (meta["cell_id"].values == cell_id)
    if not mask.any():
        raise KeyError(f"Cell '{cell_id}' not found in MATR dataset.")
    m = meta[mask]
    x = X[mask]
    return {
        "cell_id":   cell_id,
        "split":     str(m["split"].iloc[0]),
        "n_cycles":  int(len(m)),
        "lifetime":  int(m["rul"].max()),
        "cycles":    m["cycle"].tolist(),
        "capacity":  x[:, _CAP_COL].tolist(),
        "rul":       m["rul"].tolist(),
    }


def get_matr_train_data(
    split: str = "train",
    feat_mean: "np.ndarray | None" = None,
    feat_std:  "np.ndarray | None" = None,
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """
    Return (X_windows, y_norm, cell_ids) for the requested split.

    X_windows : (N, 30, 13)
    y_norm    : (N,) in [0, 1]
    cell_ids  : (N,) cell_id per window
    """
    X, meta = _load()
    split_mask = (
        _mit_mask()
        & (meta["split"].values == split)
    )
    m = meta[split_mask]
    x = X[split_mask]

    # Load checkpoint norms if not provided
    if feat_mean is None or feat_std is None:
        import torch
        from pathlib import Path as P
        ckpt_path = P(__file__).parent.parent.parent.parent / \
            "thesis_results" / "v10_final" / "best_model_v10_final.pt"
        ckpt = torch.load(str(ckpt_path), map_location="cpu", weights_only=False)
        feat_mean = np.array(ckpt["feat_mean"], np.float32)
        feat_std  = np.array(ckpt["feat_std"],  np.float32)

    all_wins, all_labs, all_cids = [], [], []

    for cid in sorted(m["cell_id"].unique()):
        mask_c = m["cell_id"].values == cid
        X9     = x[mask_c].astype(np.float32)
        rul    = m[mask_c]["rul"].values.astype(np.float32)

        X13     = _add_derived(X9)
        X13_z   = _normalise(X13, feat_mean, feat_std)
        y_norm  = np.clip(rul / RUL_MAX, 0.0, 1.0)
        wins, labs = _make_windows(X13_z, y_norm)

        if len(wins) == 0:
            continue
        all_wins.append(wins)
        all_labs.append(labs)
        all_cids.extend([cid] * len(wins))

    if not all_wins:
        return (
            np.empty((0, WINDOW_SIZE, 13), np.float32),
            np.empty(0, np.float32),
            [],
        )

    return (
        np.concatenate(all_wins, axis=0),
        np.concatenate(all_labs, axis=0),
        all_cids,
    )

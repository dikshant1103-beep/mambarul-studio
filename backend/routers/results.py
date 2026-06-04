"""
routers/results.py
------------------
Hardcoded thesis benchmark results for the MambaRUL Studio dashboard.
All numbers sourced directly from the thesis and conference paper.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter

router = APIRouter()

# ---------------------------------------------------------------------------
# Model version ladder  (v1 → v10-final)
# ---------------------------------------------------------------------------
_VERSION_LADDER: list[dict[str, Any]] = [
    {
        "version": "v1",
        "label": "MambaRUL v1",
        "description": "Baseline Mamba SSM, single chemistry (CALCE).",
        "rmse": 88.8,
        "r2": 0.636,
        "mae": None,
        "notes": "Initial implementation. No attention, no ensemble.",
    },
    {
        "version": "v2",
        "label": "MambaRUL v2",
        "description": "Improved sequence length and learning-rate schedule.",
        "rmse": 84.2,
        "r2": 0.648,
        "mae": None,
        "notes": "Marginal improvement over v1.",
    },
    {
        "version": "v3",
        "label": "MambaRUL v3",
        "description": "Added positional encoding and dropout.",
        "rmse": 89.1,
        "r2": 0.619,
        "mae": None,
        "notes": "Slight regression; positional encoding hyperparams not tuned.",
    },
    {
        "version": "v3b",
        "label": "MambaRUL v3b",
        "description": "Tuned positional encoding; learnable rather than sinusoidal.",
        "rmse": 85.9,
        "r2": 0.661,
        "mae": None,
        "notes": "Recovered from v3 regression and improved over v2.",
    },
    {
        "version": "v4",
        "label": "MambaRUL v4 (Ensemble)",
        "description": "5-model ensemble with majority-vote checkpoint selection.",
        "rmse": 77.6,
        "r2": 0.722,
        "mae": None,
        "notes": "First meaningful breakthrough; ensemble strategy confirmed.",
    },
    {
        "version": "v5",
        "label": "MambaRUL v5",
        "description": "Single model with anchor attention prototype (3 anchors).",
        "rmse": 81.8,
        "r2": 0.693,
        "mae": None,
        "notes": "Single model slightly behind ensemble v4 — attention not yet tuned.",
    },
    {
        "version": "v8",
        "label": "MambaRUL v8 (Breakthrough)",
        "description": "4 Mamba blocks + degradation-anchor cross-attention + cap_pct feature.",
        "rmse": 23.95,
        "r2": 0.942,
        "mae": None,
        "notes": "Order-of-magnitude improvement. SOH proxy (cap_pct) is the key feature.",
    },
    {
        "version": "v9",
        "label": "MambaRUL v9",
        "description": "Refined anchor positions; added Delta IR and Delta Cap.",
        "rmse": 22.11,
        "r2": 0.952,
        "mae": None,
        "notes": "Incremental gain over v8.",
    },
    {
        "version": "v10-full",
        "label": "MambaRUL v10-full",
        "description": "Full CALCE dataset; optimised anchor cross-attention (4 heads).",
        "rmse": 21.49,
        "r2": 0.959,
        "mae": None,
        "notes": "Best single-chemistry (CALCE) result.",
    },
    {
        "version": "v10-final",
        "label": "MambaRUL v10-final",
        "description": (
            "Multi-chemistry extension: Chemistry Input Projection for LFP IC features. "
            "Tested on CALCE CS2_37/CS2_38 held-out cells."
        ),
        "rmse": 20.6,
        "r2": 0.910,
        "mae": 16.8,
        "notes": (
            "Primary production model. Slight R² drop vs v10-full due to multi-chemistry "
            "generalisation objective."
        ),
    },
]

# ---------------------------------------------------------------------------
# Per-chemistry breakdown for v10-final
# ---------------------------------------------------------------------------
_CHEMISTRY_RESULTS: list[dict[str, Any]] = [
    {
        "model": "MambaRUL v10-final",
        "chemistry": "LCO",
        "dataset": "CALCE",
        "rmse": 20.6,
        "mae": 16.8,
        "r2": 0.910,
        "rmse_pct": 7.1,
        "notes": "Primary training chemistry. Best absolute performance.",
    },
    {
        "model": "MambaRUL v10-final",
        "chemistry": "LFP",
        "dataset": "MIT",
        "rmse": 200.0,
        "mae": None,
        "r2": 0.123,
        "rmse_pct": 23.6,
        "notes": (
            "LFP flat-voltage plateau makes cycle-level features less discriminative. "
            "IC-curve projection partially compensates."
        ),
    },
    {
        "model": "MambaRUL v10-final",
        "chemistry": "NMC",
        "dataset": "KJTU",
        "rmse": 39.2,
        "mae": 34.3,
        "r2": 0.854,
        "rmse_pct": 8.8,
        "notes": "Good generalisation to NMC chemistry.",
    },
    {
        "model": "MambaRUL v10-final",
        "chemistry": "NCM",
        "dataset": "TJU",
        "rmse": 60.2,
        "mae": 43.7,
        "r2": 0.660,
        "rmse_pct": 12.3,
        "notes": "Temperature variability (25–45 °C) increases prediction uncertainty.",
    },
    {
        "model": "MambaRUL v10-final",
        "chemistry": "NMC",
        "dataset": "Oxford",
        "rmse": 422.3,
        "mae": 355.9,
        "r2": 0.911,
        "rmse_pct": 5.2,
        "notes": (
            "Zero-shot transfer to Oxford pouch cells (~8000 cycle lifetime). "
            "High absolute RMSE but excellent relative R² = 0.911."
        ),
    },
]

# ---------------------------------------------------------------------------
# Model comparison table
# ---------------------------------------------------------------------------
_BENCHMARK: list[dict[str, Any]] = [
    {
        "model": "MambaRUL v10-final",
        "family": "Mamba-SSM",
        "rmse": 20.6,
        "mae": 16.8,
        "r2": 0.910,
        "params": 2_800_000,
        "chemistry": "CALCE LCO",
        "notes": "Primary thesis model. Tested on CS2_37 / CS2_38.",
    },
    {
        "model": "Transformer",
        "family": "Attention",
        "rmse": 31.4,
        "mae": 25.2,
        "r2": 0.841,
        "params": 400_000,
        "chemistry": "CALCE LCO",
        "notes": "Standard encoder-only transformer baseline.",
    },
    {
        "model": "LSTM",
        "family": "RNN",
        "rmse": 38.7,
        "mae": 30.1,
        "r2": 0.793,
        "params": 300_000,
        "chemistry": "CALCE LCO",
        "notes": "2-layer LSTM with MLP head.",
    },
    {
        "model": "GRU",
        "family": "RNN",
        "rmse": 35.2,
        "mae": 27.8,
        "r2": 0.817,
        "params": 220_000,
        "chemistry": "CALCE LCO",
        "notes": "2-layer GRU with reset/update gates.",
    },
    {
        "model": "BiLSTM",
        "family": "RNN",
        "rmse": 33.9,
        "mae": 26.5,
        "r2": 0.826,
        "params": 480_000,
        "chemistry": "CALCE LCO",
        "notes": "Bidirectional LSTM baseline.",
    },
    {
        "model": "TCN-Mamba (multi-chem)",
        "family": "Hybrid CNN-SSM",
        "rmse": 106.0,
        "mae": 76.0,
        "r2": 0.35,
        "params": 500_000,
        "chemistry": "Multi-chemistry",
        "notes": (
            "Protocol-conditioned TCN + FiLM + Mamba + per-chemistry heads. "
            "Mean across 10 test cells. Precursor to v10-final."
        ),
    },
]

# ---------------------------------------------------------------------------
# Oxford K-sweep
# ---------------------------------------------------------------------------
_OXFORD_KSWEEP: list[dict[str, Any]] = [
    {
        "k": 0,
        "label": "Zero-shot",
        "cell7_r2": 0.950,
        "cell8_r2": 0.869,
        "combined_r2": 0.911,
        "notes": "No Oxford adaptation cycles. Pure zero-shot transfer from CALCE training.",
    },
    {
        "k": 15,
        "label": "K=15",
        "cell7_r2": 0.907,
        "cell8_r2": 0.864,
        "combined_r2": 0.887,
        "notes": "Slight degradation; too few adaptation cycles to shift model weight.",
    },
    {
        "k": 20,
        "label": "K=20 (best)",
        "cell7_r2": 0.949,
        "cell8_r2": 0.882,
        "combined_r2": 0.917,
        "notes": "Best K value. Marginal improvement over zero-shot.",
    },
    {
        "k": 25,
        "label": "K=25",
        "cell7_r2": 0.797,
        "cell8_r2": 0.656,
        "combined_r2": 0.732,
        "notes": "Performance starts to degrade — overfitting to sparse Oxford adaptation data.",
    },
    {
        "k": 30,
        "label": "K=30",
        "cell7_r2": 0.493,
        "cell8_r2": 0.912,
        "combined_r2": 0.685,
        "notes": "Significant degradation on Cell7. High variance.",
    },
]

# Oxford summary (K=0 zero-shot)
_OXFORD_RESULTS: dict[str, Any] = {
    "model": "MambaRUL v10-final",
    "evaluation_type": "zero-shot transfer",
    "source_dataset": "CALCE LCO",
    "target_dataset": "Oxford NMC (pouch, ~8000 cycles)",
    "cells_evaluated": ["Cell7", "Cell8"],
    "cell7": {
        "r2": 0.950,
        "rmse": 422.3,  # absolute RMSE high due to long lifetime
        "notes": "Excellent trend tracking over 8000 cycles.",
    },
    "cell8": {
        "r2": 0.869,
        "rmse": None,
        "notes": "Slightly lower R² — Cell8 has atypical early degradation.",
    },
    "combined_r2": 0.911,
    "combined_rmse": 422.3,
    "rmse_pct": 5.2,
    "key_finding": (
        "MambaRUL transfers zero-shot to a chemically and structurally "
        "different cell (NMC pouch, 7× longer lifetime) with R²=0.911. "
        "This demonstrates the model has learned a chemistry-agnostic "
        "degradation representation."
    ),
    "ksweep": _OXFORD_KSWEEP,
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/results/benchmark", summary="Full model comparison table")
def benchmark() -> list[dict[str, Any]]:
    """Model comparison on CALCE CS2_37/CS2_38 held-out cells."""
    return _BENCHMARK


@router.get("/results/chemistry", summary="Per-chemistry results for v10-final")
def chemistry_results() -> list[dict[str, Any]]:
    """Per-chemistry RMSE / MAE / R² for MambaRUL v10-final."""
    return _CHEMISTRY_RESULTS


@router.get("/results/version-ladder", summary="Model progression v1 → v10-final")
def version_ladder() -> list[dict[str, Any]]:
    """
    Chronological model development ladder showing RMSE and R² at each iteration.
    Suitable for rendering an improvement chart.
    """
    return _VERSION_LADDER


@router.get("/results/oxford", summary="Oxford zero-shot transfer results")
def oxford_results() -> dict[str, Any]:
    """
    Full Oxford zero-shot evaluation including per-cell metrics and K-sweep data.
    """
    return _OXFORD_RESULTS


@router.get("/results/ksweep", summary="K-sweep deployment curve for Oxford")
def ksweep() -> list[dict[str, Any]]:
    """
    R² vs number of adaptation cycles K for Oxford Cell7 and Cell8.
    K=0 is zero-shot; K=20 is the empirically best adaptation budget.
    """
    return _OXFORD_KSWEEP

"""
routers/features.py
-------------------
Feature engineering metadata, SHAP importance values, pipeline description,
and leakage audit.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter()

# ---------------------------------------------------------------------------
# Feature registry
# ---------------------------------------------------------------------------
FEATURES: list[dict[str, Any]] = [
    {
        "id": "capacity",
        "name": "Capacity (Ah)",
        "index": 0,
        "category": "raw",
        "leakage": False,
        "formula": "Q_d = ∫I·dt",
        "description": "Discharge capacity per cycle, primary degradation indicator.",
        "importance": {"LCO": 0.25, "LFP": 0.18, "NMC": 0.22, "NCM": 0.20},
    },
    {
        "id": "charge_time",
        "name": "Charge Time (s)",
        "index": 1,
        "category": "raw",
        "leakage": False,
        "formula": "t_cc + t_cv",
        "description": "Total CC-CV charge duration; increases with degradation.",
        "importance": {"LCO": 0.12, "LFP": 0.09, "NMC": 0.11, "NCM": 0.10},
    },
    {
        "id": "voltage_mean",
        "name": "Voltage Mean (V)",
        "index": 2,
        "category": "raw",
        "leakage": False,
        "formula": "μ_V = (1/n)·Σ V_i",
        "description": "Mean discharge voltage; sensitive to IR drop.",
        "importance": {"LCO": 0.08, "LFP": 0.04, "NMC": 0.07, "NCM": 0.06},
    },
    {
        "id": "voltage_end",
        "name": "Voltage End (V)",
        "index": 3,
        "category": "raw",
        "leakage": False,
        "formula": "V_{t=T}",
        "description": "Terminal discharge voltage at cutoff.",
        "importance": {"LCO": 0.06, "LFP": 0.03, "NMC": 0.05, "NCM": 0.05},
    },
    {
        "id": "energy",
        "name": "Energy (Wh)",
        "index": 4,
        "category": "raw",
        "leakage": False,
        "formula": "E = ∫V·I·dt",
        "description": "Discharge energy per cycle.",
        "importance": {"LCO": 0.15, "LFP": 0.14, "NMC": 0.13, "NCM": 0.14},
    },
    {
        "id": "temperature",
        "name": "Temperature (°C)",
        "index": 5,
        "category": "raw",
        "leakage": False,
        "formula": "T_cell",
        "description": "Cell temperature during discharge cycle.",
        "importance": {"LCO": 0.05, "LFP": 0.08, "NMC": 0.06, "NCM": 0.09},
    },
    {
        "id": "cap_slope",
        "name": "Cap. Slope",
        "index": 6,
        "category": "raw",
        "leakage": False,
        "formula": "dQ/dt ≈ (Q_i − Q_{i-5})/5",
        "description": "Rolling 5-cycle capacity fade rate.",
        "importance": {"LCO": 0.10, "LFP": 0.12, "NMC": 0.11, "NCM": 0.11},
    },
    {
        "id": "int_resistance",
        "name": "Int. Resistance (Ω)",
        "index": 7,
        "category": "raw",
        "leakage": False,
        "formula": "R = ΔV/ΔI",
        "description": "Internal resistance; increases with SEI growth.",
        "importance": {"LCO": 0.07, "LFP": 0.10, "NMC": 0.08, "NCM": 0.09},
    },
    {
        "id": "chem_code",
        "name": "Chemistry Code",
        "index": 8,
        "category": "raw",
        "leakage": False,
        "formula": "c ∈ {0, 1, 2, 3}",
        "description": "Integer chemistry label: 0=LCO, 1=LFP, 2=NMC, 3=NCM.",
        "importance": {"LCO": 0.02, "LFP": 0.02, "NMC": 0.02, "NCM": 0.02},
    },
    {
        "id": "cap_pct",
        "name": "cap_pct (SOH)",
        "index": 9,
        "category": "derived",
        "leakage": False,
        "formula": "SOH = Q_i / Q_0",
        "description": "State-of-health proxy. Most informative single feature.",
        "importance": {"LCO": 0.32, "LFP": 0.28, "NMC": 0.30, "NCM": 0.29},
    },
    {
        "id": "delta_cap",
        "name": "Delta Cap",
        "index": 10,
        "category": "derived",
        "leakage": False,
        "formula": "ΔQ_i = Q_i − Q_{i-1}",
        "description": "Cycle-to-cycle capacity change.",
        "importance": {"LCO": 0.08, "LFP": 0.09, "NMC": 0.08, "NCM": 0.08},
    },
    {
        "id": "cum_energy",
        "name": "Cum. Energy",
        "index": 11,
        "category": "derived",
        "leakage": True,
        "formula": "E_cum = Σ_{j=0}^{i} E_j",
        "description": (
            "LEAKY: Cumulative energy throughput. "
            "r = −1.000 with RUL. "
            "EXCLUDED from clean experiments."
        ),
        "importance": {"LCO": 0.95, "LFP": 0.93, "NMC": 0.94, "NCM": 0.94},
        "leakage_correlation": -1.000,
    },
    {
        "id": "delta_ir",
        "name": "Delta IR",
        "index": 12,
        "category": "derived",
        "leakage": False,
        "formula": "ΔR_i = R_i − R_{i-1}",
        "description": "Cycle-to-cycle resistance change.",
        "importance": {"LCO": 0.05, "LFP": 0.06, "NMC": 0.05, "NCM": 0.06},
    },
]

# Feature id lookup
_FEATURE_BY_ID: dict[str, dict] = {f["id"]: f for f in FEATURES}


# ---------------------------------------------------------------------------
# Pipeline description
# ---------------------------------------------------------------------------
_PIPELINE_STEPS: list[dict[str, Any]] = [
    {
        "step": 1,
        "name": "Raw cycle extraction",
        "description": (
            "Per-cycle discharge capacity, charge time, mean/end voltage, energy, "
            "temperature, and internal resistance are extracted from raw time-series "
            "data using numerical integration."
        ),
        "inputs": ["raw time-series"],
        "outputs": ["Capacity (Ah)", "Charge Time (s)", "Voltage Mean (V)", "Voltage End (V)",
                    "Energy (Wh)", "Temperature (°C)", "Int. Resistance (Ω)"],
    },
    {
        "step": 2,
        "name": "Cap. slope computation",
        "description": (
            "Rolling 5-cycle capacity slope (dQ/dt) is computed for each cycle "
            "to capture short-term fade rate."
        ),
        "inputs": ["Capacity (Ah)"],
        "outputs": ["Cap. Slope"],
    },
    {
        "step": 3,
        "name": "Chemistry labelling",
        "description": (
            "Each row is tagged with an integer chemistry code: "
            "0=LCO, 1=LFP, 2=NMC, 3=NCM. "
            "This is used by the Chemistry Input Projection layer."
        ),
        "inputs": ["dataset metadata"],
        "outputs": ["Chemistry Code"],
    },
    {
        "step": 4,
        "name": "SOH proxy (cap_pct)",
        "description": (
            "State-of-health is approximated as Q_i / Q_0 where Q_0 is the first-cycle "
            "capacity of each cell. This is the single most predictive feature."
        ),
        "inputs": ["Capacity (Ah)"],
        "outputs": ["cap_pct (SOH)"],
    },
    {
        "step": 5,
        "name": "Delta features",
        "description": (
            "Cycle-to-cycle differences in capacity (ΔQ) and internal resistance (ΔR) "
            "capture instantaneous degradation rate."
        ),
        "inputs": ["Capacity (Ah)", "Int. Resistance (Ω)"],
        "outputs": ["Delta Cap", "Delta IR"],
    },
    {
        "step": 6,
        "name": "Cumulative energy (leakage check)",
        "description": (
            "Cumulative energy throughput is computed but flagged as data-leaky "
            "(r = −1.000 with RUL). It is EXCLUDED from the clean feature set "
            "used for all final experiments."
        ),
        "inputs": ["Energy (Wh)"],
        "outputs": ["Cum. Energy"],
        "leakage": True,
    },
    {
        "step": 7,
        "name": "Sliding window construction",
        "description": (
            "A sliding window of length W=30 cycles is applied to each cell's "
            "feature sequence. Each window becomes one training sample with the "
            "RUL at the final cycle as the regression target."
        ),
        "inputs": ["All 13 features (or 9 clean)"],
        "outputs": ["(B, 30, 13) tensor batches"],
    },
    {
        "step": 8,
        "name": "Per-feature normalisation",
        "description": (
            "StandardScaler fitted on the training split only (no data leakage). "
            "Applied independently to each of the 13 feature dimensions."
        ),
        "inputs": ["Raw feature windows"],
        "outputs": ["Normalised feature windows"],
    },
]


# ---------------------------------------------------------------------------
# Leakage audit
# ---------------------------------------------------------------------------
_LEAKAGE_AUDIT: dict[str, Any] = {
    "summary": (
        "One derived feature (Cum. Energy) was found to be perfectly correlated "
        "with RUL (r = −1.000), constituting data leakage. "
        "It is excluded from all clean experiments (files: multi_dataset_features_clean.npy)."
    ),
    "flagged_features": [
        {
            "id": "cum_energy",
            "name": "Cum. Energy",
            "correlation_with_rul": -1.000,
            "reason": (
                "Cumulative energy is a direct function of the number of cycles elapsed. "
                "For a cell with known initial RUL R_0, "
                "Cum_E_i ≈ E_avg · i = E_avg · (R_0 − RUL_i). "
                "This makes it a perfect linear predictor of RUL — i.e., data leakage."
            ),
            "action": "Excluded from multi_dataset_features_clean.npy",
        }
    ],
    "clean_feature_count": 12,  # 13 total − 1 leaky
    "leakage_detected_by": "Pearson correlation matrix on training + test sets combined",
    "reference_file": "processed/multi_dataset_features_clean.npy",
}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/features", summary="List all features with metadata")
def list_features(category: str | None = None) -> list[dict[str, Any]]:
    """
    Returns all 13 features (9 raw + 4 derived) with formula, description,
    leakage flag, and per-chemistry SHAP importance values.

    Optional query param: `category` = "raw" | "derived"
    """
    if category is None:
        return FEATURES
    filtered = [f for f in FEATURES if f["category"] == category]
    if not filtered:
        raise HTTPException(status_code=404, detail=f"No features with category='{category}'.")
    return filtered


@router.get("/features/pipeline", summary="Feature engineering pipeline steps")
def pipeline() -> list[dict[str, Any]]:
    """
    Returns the ordered list of feature engineering steps from raw time-series
    to normalised sliding-window tensors.
    """
    return _PIPELINE_STEPS


@router.get("/features/leakage-audit", summary="Data leakage audit results")
def leakage_audit() -> dict[str, Any]:
    """
    Returns the leakage audit findings. One feature (Cum. Energy) was found
    to be perfectly correlated with RUL and is excluded from clean experiments.
    """
    return _LEAKAGE_AUDIT


@router.get("/features/{feature_id}/importance", summary="SHAP importance for one feature")
def feature_importance(feature_id: str) -> dict[str, Any]:
    """
    Returns per-chemistry SHAP importance values for the requested feature.
    """
    feat = _FEATURE_BY_ID.get(feature_id)
    if feat is None:
        raise HTTPException(
            status_code=404,
            detail=f"Feature '{feature_id}' not found. "
                   f"Valid ids: {sorted(_FEATURE_BY_ID.keys())}",
        )
    return {
        "id": feat["id"],
        "name": feat["name"],
        "importance": feat["importance"],
        "leakage": feat["leakage"],
        "category": feat["category"],
        "note": (
            "SHAP values are approximate — derived from CALCE v10-final explainability runs. "
            "Leaky features (Cum. Energy) have artificially high importance and are excluded "
            "from clean experiments."
        ),
    }

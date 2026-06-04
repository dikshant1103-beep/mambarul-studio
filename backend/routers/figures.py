"""
routers/figures.py
------------------
Figure catalogue endpoint.

Figures are served as static files from two directories:
    /static/thesis_figures/      → thesis_results/figures/
    /static/conference_figures/  → conference_final_percell/figures/

This router provides structured metadata (title, description, category)
for every known figure so the frontend can display a searchable gallery.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter()

# ---------------------------------------------------------------------------
# Paths (relative to project root, used to verify files exist)
# ---------------------------------------------------------------------------
_BACKEND_DIR = Path(__file__).parent.parent
_PROJECT_ROOT = _BACKEND_DIR.parent.parent

_THESIS_DIR = _PROJECT_ROOT / "thesis_results" / "figures"
_CONFERENCE_DIR = _PROJECT_ROOT / "conference_final_percell" / "figures"


# ---------------------------------------------------------------------------
# Static catalogue — figures with metadata
# ---------------------------------------------------------------------------

_THESIS_FIGURES: list[dict[str, Any]] = [
    {
        "filename": "architecture_diagram.png",
        "title": "MambaRUL v10-final Architecture",
        "description": (
            "Full architecture diagram of MambaRUL v10-final: Linear Embedding → "
            "Learnable Positional Encoding → 4× MambaBlock → Anchor Cross-Attention → MLP Head."
        ),
        "category": "architecture",
        "tags": ["mamba", "architecture", "v10"],
    },
    {
        "filename": "rmse_ladder.png",
        "title": "Model Version Ladder (RMSE v1 → v10-final)",
        "description": (
            "RMSE progression across all model versions from v1 (88.8) to v10-final (20.6), "
            "showing the iterative improvement trajectory."
        ),
        "category": "results",
        "tags": ["rmse", "version-ladder", "improvement"],
    },
    {
        "filename": "version_ablation.png",
        "title": "Ablation Study — Version Components",
        "description": (
            "Per-component ablation showing the contribution of anchor attention, "
            "cap_pct feature, and chemistry projection to final RMSE."
        ),
        "category": "ablation",
        "tags": ["ablation", "anchor", "cap_pct"],
    },
    {
        "filename": "shap_overall.png",
        "title": "SHAP Feature Importance (Overall)",
        "description": "Global SHAP bar chart across all features ranked by mean |SHAP| value.",
        "category": "features",
        "tags": ["shap", "importance", "feature"],
    },
    {
        "filename": "shap_beeswarm_calce.png",
        "title": "SHAP Beeswarm — CALCE LCO",
        "description": (
            "SHAP beeswarm plot for CALCE LCO cells showing the distribution of "
            "each feature's impact on the RUL prediction."
        ),
        "category": "features",
        "tags": ["shap", "beeswarm", "calce", "lco"],
    },
    {
        "filename": "shap_beeswarm_oxford.png",
        "title": "SHAP Beeswarm — Oxford NMC (Zero-Shot)",
        "description": (
            "SHAP beeswarm plot for Oxford zero-shot transfer predictions. "
            "Shows which features drive RUL estimates on unseen NMC pouch cells."
        ),
        "category": "features",
        "tags": ["shap", "beeswarm", "oxford", "nmc", "zero-shot"],
    },
    {
        "filename": "shap_heatmap.png",
        "title": "SHAP Heatmap — Feature × Chemistry",
        "description": "Heatmap of mean |SHAP| values per feature × chemistry combination.",
        "category": "features",
        "tags": ["shap", "heatmap", "chemistry"],
    },
    {
        "filename": "cross_chemistry_bar.png",
        "title": "Cross-Chemistry RMSE Comparison",
        "description": "Bar chart of per-chemistry RMSE (LCO / LFP / NMC / NCM) for all baseline models.",
        "category": "results",
        "tags": ["rmse", "chemistry", "baseline"],
    },
    {
        "filename": "chemistry_radar.png",
        "title": "Chemistry Radar Chart",
        "description": "Radar chart comparing RMSE, MAE, R², and RMSE% across all four chemistries.",
        "category": "results",
        "tags": ["radar", "chemistry", "metrics"],
    },
    {
        "filename": "feature_pipeline.png",
        "title": "Feature Engineering Pipeline",
        "description": (
            "Flowchart of the full feature engineering pipeline: raw extraction → "
            "slope → SOH proxy → derived features → leakage audit → sliding window."
        ),
        "category": "features",
        "tags": ["pipeline", "feature-engineering"],
    },
    {
        "filename": "rul_comparison_real.png",
        "title": "RUL Prediction vs Ground Truth (v10-final)",
        "description": (
            "Predicted vs actual RUL trajectories for CALCE CS2_37 and CS2_38 "
            "test cells under MambaRUL v10-final."
        ),
        "category": "results",
        "tags": ["rul", "prediction", "calce", "v10"],
    },
    {
        "filename": "oxford_loocv.png",
        "title": "Oxford LOOCV Transfer Results",
        "description": "Leave-one-out cross-validation on Oxford NMC pouch cells for zero-shot RUL prediction.",
        "category": "transfer",
        "tags": ["oxford", "loocv", "zero-shot", "transfer"],
    },
    {
        "filename": "oxford_progression.png",
        "title": "Oxford Cell Lifetime RUL Progression",
        "description": "RUL prediction trajectory for Oxford Cell7 and Cell8 across their full ~8000-cycle lifetime.",
        "category": "transfer",
        "tags": ["oxford", "rul", "lifetime"],
    },
    {
        "filename": "ksweep_deployment_final.png",
        "title": "K-Sweep Deployment Curve (Oxford)",
        "description": (
            "R² vs number of adaptation cycles K for Oxford Cell7 and Cell8. "
            "K=0 (zero-shot) and K=20 both achieve R² > 0.91."
        ),
        "category": "transfer",
        "tags": ["ksweep", "oxford", "deployment", "adaptation"],
    },
    {
        "filename": "ksweep_curves_final.png",
        "title": "K-Sweep RUL Curves",
        "description": "Predicted RUL curves for each K value (0, 15, 20, 25, 30) on Oxford Cell7/Cell8.",
        "category": "transfer",
        "tags": ["ksweep", "oxford", "rul-curves"],
    },
    {
        "filename": "ksweep_rmse_final.png",
        "title": "K-Sweep RMSE vs K",
        "description": "RMSE as a function of K for Oxford zero-shot to K=30 adaptation study.",
        "category": "transfer",
        "tags": ["ksweep", "rmse", "oxford"],
    },
    {
        "filename": "conformal_calce.png",
        "title": "Conformal Prediction Intervals — CALCE",
        "description": "95 % conformal prediction intervals for MambaRUL v10-final on CALCE test cells.",
        "category": "uncertainty",
        "tags": ["conformal", "uncertainty", "calce"],
    },
    {
        "filename": "conformal_oxford.png",
        "title": "Conformal Prediction Intervals — Oxford",
        "description": "95 % conformal prediction intervals on Oxford zero-shot transfer cells.",
        "category": "uncertainty",
        "tags": ["conformal", "uncertainty", "oxford"],
    },
    {
        "filename": "conformal_comparison.png",
        "title": "Conformal Coverage Comparison",
        "description": "Coverage vs interval width comparison across CALCE, Oxford, and multi-chemistry settings.",
        "category": "uncertainty",
        "tags": ["conformal", "coverage", "comparison"],
    },
    {
        "filename": "conformal_coverage.png",
        "title": "Conformal Coverage Plot",
        "description": "Empirical coverage vs target coverage level for the conformal predictor.",
        "category": "uncertainty",
        "tags": ["conformal", "coverage"],
    },
    {
        "filename": "conformal_online_comparison.png",
        "title": "Online Conformal Prediction Comparison",
        "description": "Comparison of split conformal vs online adaptive conformal prediction intervals.",
        "category": "uncertainty",
        "tags": ["conformal", "online", "adaptive"],
    },
    {
        "filename": "ensemble_uncertainty_oxford.png",
        "title": "Ensemble Uncertainty — Oxford",
        "description": "Ensemble-based uncertainty estimates on Oxford zero-shot transfer cells.",
        "category": "uncertainty",
        "tags": ["ensemble", "uncertainty", "oxford"],
    },
    {
        "filename": "training_composition.png",
        "title": "Training Data Composition",
        "description": "Pie/bar chart showing per-chemistry and per-dataset cell count in the training split.",
        "category": "data",
        "tags": ["data", "training", "chemistry", "composition"],
    },
    {
        "filename": "cell4_analysis.png",
        "title": "Cell-Level Analysis (Cell 4)",
        "description": "Detailed per-cycle feature analysis for a representative CALCE cell.",
        "category": "data",
        "tags": ["cell", "analysis", "calce"],
    },
    {
        "filename": "v11_improvement.png",
        "title": "v11 Improvement over Baselines",
        "description": "Bar chart showing RMSE improvement of v11 (ensemble) over individual baselines.",
        "category": "results",
        "tags": ["v11", "ensemble", "improvement"],
    },
    {
        "filename": "v11_rmse_comparison.png",
        "title": "v11 RMSE Comparison",
        "description": "Side-by-side RMSE comparison of v11 vs Transformer, LSTM, GRU, BiLSTM.",
        "category": "results",
        "tags": ["v11", "rmse", "baseline"],
    },
]

_CONFERENCE_FIGURES: list[dict[str, Any]] = [
    {
        "filename": "fig01_rul_trajectories.png",
        "title": "RUL Trajectories (Conference)",
        "description": "Predicted vs true RUL trajectories for all test cells, conference figure format.",
        "category": "results",
        "tags": ["rul", "trajectory", "conference"],
    },
    {
        "filename": "fig02_rmse_comparison.png",
        "title": "RMSE Model Comparison (Conference)",
        "description": "Bar chart of RMSE across all models: MambaRUL, Transformer, LSTM, GRU, BiLSTM.",
        "category": "results",
        "tags": ["rmse", "comparison", "baseline", "conference"],
    },
    {
        "filename": "fig03_r2_comparison.png",
        "title": "R² Model Comparison (Conference)",
        "description": "Bar chart of R² across all models.",
        "category": "results",
        "tags": ["r2", "comparison", "baseline", "conference"],
    },
    {
        "filename": "fig04_anchor_ablation.png",
        "title": "Anchor Attention Ablation (Conference)",
        "description": (
            "RMSE comparison showing the impact of removing anchor cross-attention "
            "from MambaRUL v10-final."
        ),
        "category": "ablation",
        "tags": ["ablation", "anchor", "attention", "conference"],
    },
    {
        "filename": "fig05_cappct_ablation.png",
        "title": "cap_pct (SOH) Feature Ablation (Conference)",
        "description": (
            "RMSE without cap_pct vs with cap_pct, demonstrating it as the "
            "single most important feature."
        ),
        "category": "ablation",
        "tags": ["ablation", "cap_pct", "soh", "conference"],
    },
    {
        "filename": "fig06_scatter_true_vs_pred.png",
        "title": "True vs Predicted RUL Scatter (Conference)",
        "description": "Scatter plot of true vs predicted RUL for all test cycles across all chemistries.",
        "category": "results",
        "tags": ["scatter", "rul", "prediction", "conference"],
    },
    {
        "filename": "fig07_residuals.png",
        "title": "Prediction Residuals (Conference)",
        "description": "Residual plot (predicted − true RUL) vs cycle number for all test cells.",
        "category": "results",
        "tags": ["residuals", "error", "conference"],
    },
    {
        "filename": "fig08_physics_weights.png",
        "title": "Anchor Attention Weights (Conference)",
        "description": (
            "Visualisation of the 3-anchor attention weight distribution across "
            "the degradation lifecycle (Fresh → Knee → Near-EOL)."
        ),
        "category": "architecture",
        "tags": ["anchor", "attention", "weights", "physics", "conference"],
    },
    {
        "filename": "fig09_physics_head_scatter.png",
        "title": "Anchor Head Scatter (Conference)",
        "description": "Per-anchor RUL sub-prediction scatter for each of the 3 degradation anchors.",
        "category": "architecture",
        "tags": ["anchor", "scatter", "conference"],
    },
    {
        "filename": "fig10_degradation_phases.png",
        "title": "Degradation Phase Classification (Conference)",
        "description": (
            "Capacity vs cycle coloured by degradation phase: "
            "Fresh (cap_pct > 0.9), Aging (0.7–0.9), Knee (0.5–0.7), Near-EOL (< 0.5)."
        ),
        "category": "data",
        "tags": ["degradation", "phase", "capacity", "conference"],
    },
    {
        "filename": "fig11_feature_importance.png",
        "title": "Feature Importance Summary (Conference)",
        "description": "Horizontal bar chart of mean |SHAP| values for all 12 clean features.",
        "category": "features",
        "tags": ["shap", "importance", "conference"],
    },
    {
        "filename": "fig12_summary_grid.png",
        "title": "Summary Results Grid (Conference)",
        "description": (
            "2×3 panel summary: RUL curves, scatter, RMSE bar, R² bar, "
            "feature importance, and conformal intervals."
        ),
        "category": "results",
        "tags": ["summary", "grid", "conference"],
    },
]


def _resolve_url(category_key: str, filename: str) -> str:
    """Build the static URL for a figure."""
    prefix = "/static/thesis_figures" if category_key == "thesis" else "/static/conference_figures"
    return f"{prefix}/{filename}"


def _file_exists(category_key: str, filename: str) -> bool:
    base = _THESIS_DIR if category_key == "thesis" else _CONFERENCE_DIR
    return (base / filename).exists()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/figures", summary="List all available figures with metadata")
def list_figures(
    category: str | None = None,
    tag: str | None = None,
) -> dict[str, Any]:
    """
    Returns structured metadata for all known figures from both the thesis
    and conference figure directories.

    Optional filters:
    - `category`: e.g. "results", "ablation", "features", "architecture",
                  "transfer", "uncertainty", "data"
    - `tag`: any tag string (e.g. "shap", "oxford", "calce")
    """

    def _filter(figs: list[dict], source: str) -> list[dict]:
        out = []
        for fig in figs:
            if category and fig.get("category") != category:
                continue
            if tag and tag not in fig.get("tags", []):
                continue
            entry = {
                **fig,
                "source": source,
                "url": _resolve_url(source, fig["filename"]),
                "available": _file_exists(source, fig["filename"]),
            }
            out.append(entry)
        return out

    thesis = _filter(_THESIS_FIGURES, "thesis")
    conference = _filter(_CONFERENCE_FIGURES, "conference")

    return {
        "thesis": thesis,
        "conference": conference,
        "total": len(thesis) + len(conference),
        "categories": sorted({f["category"] for f in _THESIS_FIGURES + _CONFERENCE_FIGURES}),
        "all_tags": sorted({t for f in _THESIS_FIGURES + _CONFERENCE_FIGURES for t in f.get("tags", [])}),
    }


@router.get(
    "/figures/{source}/{filename}",
    summary="Figure metadata by source and filename",
)
def get_figure_meta(source: str, filename: str) -> dict[str, Any]:
    """
    Returns metadata (title, description, url, availability) for a specific figure.

    `source` must be "thesis" or "conference".
    `filename` is the bare filename, e.g. "rmse_ladder.png".
    """
    if source not in ("thesis", "conference"):
        raise HTTPException(
            status_code=400,
            detail="source must be 'thesis' or 'conference'.",
        )

    catalog = _THESIS_FIGURES if source == "thesis" else _CONFERENCE_FIGURES
    match = next((f for f in catalog if f["filename"] == filename), None)

    if match is None:
        raise HTTPException(
            status_code=404,
            detail=f"Figure '{filename}' not found in {source} catalogue.",
        )

    return {
        **match,
        "source": source,
        "url": _resolve_url(source, filename),
        "available": _file_exists(source, filename),
    }


@router.get("/figures/scan", summary="Scan disk and return all present figure files")
def scan_figures() -> dict[str, Any]:
    """
    Scans the actual figure directories and returns all files found,
    regardless of whether they appear in the static catalogue.
    Useful for the frontend to discover new figures automatically.
    """

    def _scan_dir(directory: Path, url_prefix: str) -> list[dict]:
        if not directory.exists():
            return []
        entries = []
        for f in sorted(directory.iterdir()):
            if f.is_file() and f.suffix.lower() in {".png", ".jpg", ".jpeg", ".pdf", ".svg"}:
                entries.append({
                    "filename": f.name,
                    "url": f"{url_prefix}/{f.name}",
                    "size_kb": round(f.stat().st_size / 1024, 1),
                    "extension": f.suffix.lower(),
                })
        return entries

    thesis_files = _scan_dir(_THESIS_DIR, "/static/thesis_figures")
    conference_files = _scan_dir(_CONFERENCE_DIR, "/static/conference_figures")

    return {
        "thesis": thesis_files,
        "conference": conference_files,
        "total": len(thesis_files) + len(conference_files),
    }

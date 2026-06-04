"""
routers/models.py
-----------------
Model architecture metadata for the frontend architecture visualiser.
Each model definition includes a layer graph (nodes + edges) that can be
rendered as a directed flow diagram.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

router = APIRouter()

# ---------------------------------------------------------------------------
# Model registry
# ---------------------------------------------------------------------------
MODELS: dict[str, dict[str, Any]] = {
    "mambarul_v10final": {
        "id": "mambarul_v10final",
        "name": "MambaRUL v10-final",
        "family": "Mamba-SSM",
        "params": 2_800_000,
        "description": (
            "Primary model. Mamba SSM (4 blocks) + Degradation Anchor Cross-Attention "
            "+ Chemistry Input Projection for LFP IC features."
        ),
        "best_rmse": 20.6,
        "best_r2": 0.910,
        "best_mae": 16.8,
        "checkpoint": "thesis_results/v10_final/best_model_v10_final.pt",
        "layers": [
            {"id": "input",      "type": "input",      "label": "Input\n(B, 30, 13)",              "x": 0,  "y": 0},
            {"id": "chem_proj",  "type": "projection", "label": "Chemistry\nInput Proj\n18→13 (LFP only)", "x": 1,  "y": 0},
            {"id": "embedding",  "type": "linear",     "label": "Linear\nEmbedding\n13→256",        "x": 2,  "y": 0},
            {"id": "pos_enc",    "type": "positional", "label": "Learnable\nPos. Encoding\n(30, 256)", "x": 3,  "y": 0},
            {"id": "mamba1",     "type": "mamba",      "label": "MambaBlock 1\nd=256, s=16",        "x": 4,  "y": 0},
            {"id": "mamba2",     "type": "mamba",      "label": "MambaBlock 2\nd=256, s=16",        "x": 5,  "y": 0},
            {"id": "mamba3",     "type": "mamba",      "label": "MambaBlock 3\nd=256, s=16",        "x": 6,  "y": 0},
            {"id": "mamba4",     "type": "mamba",      "label": "MambaBlock 4\nd=256, s=16",        "x": 7,  "y": 0},
            {"id": "anchor_attn","type": "attention",  "label": "Anchor\nAttention\n3 anchors, 4 heads", "x": 8,  "y": 0},
            {"id": "mlp_head",   "type": "mlp",        "label": "MLP Head\n256→64→1",               "x": 9,  "y": 0},
            {"id": "output",     "type": "output",     "label": "RUL\n(scalar)",                    "x": 10, "y": 0},
        ],
        "connections": [
            ["input",       "chem_proj"],
            ["chem_proj",   "embedding"],
            ["embedding",   "pos_enc"],
            ["pos_enc",     "mamba1"],
            ["mamba1",      "mamba2"],
            ["mamba2",      "mamba3"],
            ["mamba3",      "mamba4"],
            ["mamba4",      "anchor_attn"],
            ["anchor_attn", "mlp_head"],
            ["mlp_head",    "output"],
        ],
        "anchors": [
            "Fresh Cell\n(early cycles)",
            "Knee Point\n(≈70% SoH)",
            "Near-EOL\n(<20% SoH)",
        ],
        "key_innovations": [
            "Degradation-anchor cross-attention: 3 learnable anchors model distinct degradation phases",
            "Chemistry Input Projection: maps 18-dim LFP IC curve to 13-dim shared feature space",
            "Learnable positional encoding: preserves cycle-order information across window",
            "cap_pct (SOH proxy) as the dominant feature (SHAP rank 1)",
        ],
    },

    "tcn_mamba": {
        "id": "tcn_mamba",
        "name": "TCN-Mamba (Protocol-Conditioned)",
        "family": "Hybrid CNN-SSM",
        "params": 500_000,
        "description": (
            "Multi-Scale TCN encoder with FiLM chemistry conditioning + "
            "Mamba SSM + chemistry-specific regression heads."
        ),
        "best_rmse": 106.0,
        "best_r2": 0.35,
        "best_mae": 76.0,
        "checkpoint": "tcn_mamba_rul/models/",
        "layers": [
            {"id": "input",     "type": "input",     "label": "Input\n(B, 30, 30)",          "x": 0,  "y": 0},
            {"id": "feat_proj", "type": "projection","label": "Feature-Aware\nProjection\n60→64", "x": 1,  "y": 0},
            {"id": "tcn1",      "type": "conv",      "label": "TCN Block 1\n64→64, k=3, d=1", "x": 2,  "y": 0},
            {"id": "tcn2",      "type": "conv",      "label": "TCN Block 2\n64→128, k=3, d=2","x": 3,  "y": 0},
            {"id": "tcn3",      "type": "conv",      "label": "TCN Block 3\n128→128, k=5, d=4","x": 4,  "y": 0},
            {"id": "chem_embed","type": "embedding", "label": "Chemistry\nEmbedding\n4→32→128","x": 3,  "y": 1},
            {"id": "film",      "type": "film",      "label": "FiLM\nModulation\nγ·x + β",    "x": 5,  "y": 0},
            {"id": "mamba1",    "type": "mamba",     "label": "Mamba 1\nd=128, s=16",         "x": 6,  "y": 0},
            {"id": "mamba2",    "type": "mamba",     "label": "Mamba 2\nd=128, s=16",         "x": 7,  "y": 0},
            {"id": "mamba3",    "type": "mamba",     "label": "Mamba 3\nd=128, s=16",         "x": 8,  "y": 0},
            {"id": "tap",       "type": "pooling",   "label": "Temporal\nAttn Pooling",        "x": 9,  "y": 0},
            {"id": "chem_head", "type": "mlp",       "label": "Chemistry\nHead (×4)\n128→64→1","x": 10, "y": 0},
            {"id": "output",    "type": "output",    "label": "RUL\n(cycles)",                 "x": 11, "y": 0},
        ],
        "connections": [
            ["input",      "feat_proj"],
            ["feat_proj",  "tcn1"],
            ["tcn1",       "tcn2"],
            ["tcn2",       "tcn3"],
            ["input",      "chem_embed"],
            ["tcn3",       "film"],
            ["chem_embed", "film"],
            ["film",       "mamba1"],
            ["mamba1",     "mamba2"],
            ["mamba2",     "mamba3"],
            ["mamba3",     "tap"],
            ["tap",        "chem_head"],
            ["chem_head",  "output"],
        ],
        "key_innovations": [
            "FiLM modulation: per-chemistry scale (γ) and shift (β) applied after TCN",
            "Multi-scale TCN: dilations 1, 2, 4 capture short/medium/long-term fade patterns",
            "Chemistry-specific regression heads: separate final layer per chemistry",
            "Temporal attention pooling: weighted summary of the sequence dimension",
        ],
    },

    "transformer": {
        "id": "transformer",
        "name": "Transformer Baseline",
        "family": "Attention",
        "params": 400_000,
        "description": (
            "Standard transformer encoder with multi-head self-attention "
            "and MLP prediction head."
        ),
        "best_rmse": 31.4,
        "best_r2": 0.841,
        "best_mae": 25.2,
        "checkpoint": "checkpoints/Transformer_best.pt",
        "layers": [
            {"id": "input", "type": "input",      "label": "Input\n(B, 30, 13)",       "x": 0, "y": 0},
            {"id": "embed", "type": "linear",     "label": "Linear\nEmbedding\n13→128", "x": 1, "y": 0},
            {"id": "pos",   "type": "positional", "label": "Positional\nEncoding",      "x": 2, "y": 0},
            {"id": "attn1", "type": "attention",  "label": "Self-Attn\n4 heads, d=128", "x": 3, "y": 0},
            {"id": "ffn1",  "type": "mlp",        "label": "FFN\n128→256→128",          "x": 4, "y": 0},
            {"id": "attn2", "type": "attention",  "label": "Self-Attn\n4 heads, d=128", "x": 5, "y": 0},
            {"id": "ffn2",  "type": "mlp",        "label": "FFN\n128→256→128",          "x": 6, "y": 0},
            {"id": "pool",  "type": "pooling",    "label": "Mean Pool\n(time dim)",      "x": 7, "y": 0},
            {"id": "head",  "type": "mlp",        "label": "MLP Head\n128→64→1",        "x": 8, "y": 0},
            {"id": "output","type": "output",     "label": "RUL",                        "x": 9, "y": 0},
        ],
        "connections": [
            ["input",  "embed"],
            ["embed",  "pos"],
            ["pos",    "attn1"],
            ["attn1",  "ffn1"],
            ["ffn1",   "attn2"],
            ["attn2",  "ffn2"],
            ["ffn2",   "pool"],
            ["pool",   "head"],
            ["head",   "output"],
        ],
    },

    "lstm": {
        "id": "lstm",
        "name": "LSTM Baseline",
        "family": "RNN",
        "params": 300_000,
        "description": "2-layer LSTM with forget/input/output gates and MLP head.",
        "best_rmse": 38.7,
        "best_r2": 0.793,
        "best_mae": 30.1,
        "checkpoint": "checkpoints/LSTM_best.pt",
        "layers": [
            {"id": "input", "type": "input",   "label": "Input\n(B, 30, 13)",                        "x": 0, "y": 0},
            {"id": "lstm1", "type": "lstm",    "label": "LSTM Layer 1\nd=128, forget/input/output gates", "x": 1, "y": 0},
            {"id": "lstm2", "type": "lstm",    "label": "LSTM Layer 2\nd=128",                        "x": 2, "y": 0},
            {"id": "last",  "type": "pooling", "label": "Last Hidden\nState h_T",                    "x": 3, "y": 0},
            {"id": "head",  "type": "mlp",     "label": "MLP Head\n128→64→1",                        "x": 4, "y": 0},
            {"id": "output","type": "output",  "label": "RUL",                                        "x": 5, "y": 0},
        ],
        "connections": [
            ["input",  "lstm1"],
            ["lstm1",  "lstm2"],
            ["lstm2",  "last"],
            ["last",   "head"],
            ["head",   "output"],
        ],
    },

    "gru": {
        "id": "gru",
        "name": "GRU Baseline",
        "family": "RNN",
        "params": 220_000,
        "description": "2-layer GRU with reset/update gates.",
        "best_rmse": 35.2,
        "best_r2": 0.817,
        "best_mae": 27.8,
        "checkpoint": "checkpoints/GRU_best.pt",
        "layers": [
            {"id": "input", "type": "input",   "label": "Input\n(B, 30, 13)",               "x": 0, "y": 0},
            {"id": "gru1",  "type": "gru",     "label": "GRU Layer 1\nd=128, reset/update gates", "x": 1, "y": 0},
            {"id": "gru2",  "type": "gru",     "label": "GRU Layer 2\nd=128",               "x": 2, "y": 0},
            {"id": "last",  "type": "pooling", "label": "Last Hidden\nState",               "x": 3, "y": 0},
            {"id": "head",  "type": "mlp",     "label": "MLP Head\n128→64→1",               "x": 4, "y": 0},
            {"id": "output","type": "output",  "label": "RUL",                               "x": 5, "y": 0},
        ],
        "connections": [
            ["input",  "gru1"],
            ["gru1",   "gru2"],
            ["gru2",   "last"],
            ["last",   "head"],
            ["head",   "output"],
        ],
    },
}

# Lightweight summary rows (no layer graph)
_MODEL_SUMMARY: list[dict[str, Any]] = [
    {
        "id": m["id"],
        "name": m["name"],
        "family": m["family"],
        "params": m["params"],
        "best_rmse": m["best_rmse"],
        "best_r2": m["best_r2"],
        "best_mae": m.get("best_mae"),
        "description": m["description"],
    }
    for m in MODELS.values()
]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/models", summary="List all models with summary metadata")
def list_models() -> list[dict[str, Any]]:
    """
    Returns a lightweight list of all models (no layer graph).
    Sorted by RMSE ascending (best first).
    """
    return sorted(_MODEL_SUMMARY, key=lambda m: m["best_rmse"])


@router.get("/models/{model_id}", summary="Full architecture definition for one model")
def get_model(model_id: str) -> dict[str, Any]:
    """
    Returns the full architecture definition for the requested model,
    including the layer graph (nodes + edges) suitable for the React Flow
    architecture visualiser.
    """
    model = MODELS.get(model_id)
    if model is None:
        valid = sorted(MODELS.keys())
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model_id}' not found. Valid ids: {valid}",
        )
    return model

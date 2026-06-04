"""
routers/pack_gnn.py — Pack GNN inference endpoints.

POST /api/predict/pack-gnn
    Run PackGraphSAGE (or physics-prior if no checkpoint) on a list of cells.
    Returns per-cell corrected RULs, interaction deltas, pack RUL + CI.

GET /api/predict/pack-gnn/status
    Returns whether the GNN checkpoint is loaded or physics-prior is active.
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
from core.middleware import require_auth, require_admin

router = APIRouter()


class GNNCellInput(BaseModel):
    cell_id:         str   = Field(default="cell", description="Cell identifier")
    chemistry:       str   = Field(default="NMC",  description="LCO|LFP|NMC|NCM|NCA")
    soh:             float = Field(default=0.85, ge=0.0, le=1.0, description="State of Health [0,1]")
    rul:             float = Field(default=300.0, ge=0,            description="Predicted RUL (cycles)")
    capacity_ah:     float = Field(default=5.0,  ge=0,            description="Current capacity (Ah)")
    nom_capacity_ah: float = Field(default=5.0,  ge=0,            description="Nominal capacity (Ah)")
    ir:              float = Field(default=0.05, ge=0,            description="Internal resistance (Ω)")
    fade_rate:       float = Field(default=0.0001, ge=0,          description="ΔSOH per cycle")
    temperature:     float = Field(default=25.0,                  description="Temperature (°C)")
    cycles:          int   = Field(default=100,  ge=0,            description="Observed cycles so far")


class PackGNNRequest(BaseModel):
    cells:    list[GNNCellInput]
    topology: str = Field(default="series", description="series|parallel|series_parallel")
    ns:       int = Field(default=1, ge=1,  description="Series groups (series_parallel only)")
    np:       int = Field(default=1, ge=1,  description="Parallel cells per group (series_parallel only)")
    pack_id:  Optional[str] = None


@router.post("/predict/pack-gnn", dependencies=[Depends(require_auth)])
def predict_pack_gnn_endpoint(req: PackGNNRequest) -> dict:
    """
    Pack GNN inference: corrects individual RUL predictions for pack-context effects.

    Models two key interaction phenomena:
      Series packs:   weak cells get over-discharged each cycle → accelerated aging;
                      high-IR cells generate more heat → faster degradation;
                      all cells pay a 'spread tax' for pack imbalance.
      Parallel packs: strong cells (low IR) carry disproportionate current →
                      they age faster than their individual RUL suggests.

    Falls back to a physics-prior correction if the GNN checkpoint is not yet
    available (e.g., before training completes).
    """
    from core.pack_gnn import predict_pack_gnn

    cells    = [c.model_dump() for c in req.cells]
    topology = req.topology.lower().replace("-", "_")

    result = predict_pack_gnn(cells, topology=topology, ns=req.ns, np_=req.np)

    # Attach cell_ids to per-cell arrays for frontend convenience
    result["cell_ids"] = [c["cell_id"] for c in cells]
    result["per_cell"] = [
        {
            "cell_id":     cells[i]["cell_id"],
            "chemistry":   cells[i]["chemistry"],
            "base_rul":    result["base_ruls"][i],
            "corrected_rul": result["corrected_ruls"][i],
            "delta_pct":   result["delta_pct"][i],
            "stressed":    result["delta_pct"][i] < -5.0,
        }
        for i in range(len(cells))
    ]

    if req.pack_id:
        result["pack_id"] = req.pack_id

    return result


@router.get("/predict/pack-gnn/status")
def pack_gnn_status() -> dict:
    """Return GNN checkpoint availability, model info, and training provenance.

    Available to both apps (admin + customer) as a read-only model-status view.
    """
    import torch
    from core.pack_gnn import CKPT_PATH, _load_model
    model = _load_model()
    ckpt_exists = CKPT_PATH.exists()

    # Read provenance metadata from the checkpoint (if our trainer wrote it)
    provenance = {}
    if ckpt_exists:
        try:
            ck = torch.load(str(CKPT_PATH), map_location="cpu", weights_only=False)
            provenance = {k: ck.get(k) for k in
                          ("source", "trained_at", "n_samples", "n_train", "n_val",
                           "epochs", "best_val_loss", "final_train_loss")
                          if k in ck}
        except Exception:
            pass

    if model is not None:
        total = sum(p.numel() for p in model.parameters())
        return {
            "status":      "gnn_loaded",
            "checkpoint":  str(CKPT_PATH),
            "params":      total,
            "description": "PackGraphSAGE (2-layer mean-aggregation SAGE, pure PyTorch)",
            "provenance":  provenance,
        }
    return {
        "status":      "physics_prior",
        "checkpoint":  str(CKPT_PATH),
        "ckpt_exists": ckpt_exists,
        "description": (
            "No GNN checkpoint found — using physics-prior corrections. "
            "Generate pack-sim data (packsim env) then train: "
            "python scripts/train_pack_gnn.py --production"
        ),
    }


# ── Admin-only training (manual trigger) ──────────────────────────────────────

class PackGNNTrainRequest(BaseModel):
    epochs:     int   = Field(default=300, ge=10, le=5000)
    lr:         float = Field(default=1e-3, gt=0)
    val_frac:   float = Field(default=0.2, ge=0.0, le=0.5)
    production: bool  = Field(default=False, description="overwrite the served checkpoint")
    chemistry:  str   = Field(default="NMC")


@router.post("/predict/pack-gnn/train", dependencies=[Depends(require_admin)])
def pack_gnn_train(req: PackGNNTrainRequest) -> dict:
    """Launch Pack-GNN training on pack-sim data in a background thread (admin only).

    Data must already exist in processed/pack_sim/ (generated by scripts/pack_sim.py
    in the isolated packsim env). Poll GET /predict/pack-gnn/train/status for progress.
    """
    from core.pack_gnn_trainer import get_train_status, train_in_background, default_data_dir

    status = get_train_status()
    if status.get("state") == "running":
        raise HTTPException(409, "A Pack-GNN training run is already in progress.")

    data_dir = default_data_dir()
    n_samples = len(list(data_dir.glob("packsim_*.json"))) if data_dir.exists() else 0
    if n_samples == 0:
        raise HTTPException(
            422,
            f"No pack-sim samples in {data_dir}. Generate them in the packsim env: "
            "python scripts/pack_sim.py --np 2 --ns 2 --samples 50",
        )

    train_in_background(epochs=req.epochs, lr=req.lr, val_frac=req.val_frac,
                        production=req.production, chemistry=req.chemistry)
    return {"started": True, "n_samples": n_samples, "production": req.production,
            "data_dir": str(data_dir)}


@router.get("/predict/pack-gnn/train/status", dependencies=[Depends(require_admin)])
def pack_gnn_train_status() -> dict:
    """Poll the background Pack-GNN training job status (admin only)."""
    from core.pack_gnn_trainer import get_train_status
    return get_train_status()

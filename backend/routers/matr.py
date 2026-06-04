"""
routers/matr.py — MATR dataset browser + built-in fine-tune endpoint.

Endpoints:
  GET  /api/matr/info                     Dataset card (cells, lifetimes, splits)
  GET  /api/matr/cells                    List all 129 cells with metadata
  GET  /api/matr/cells/{cell_id}          Capacity + RUL curve for one cell
  POST /api/finetune/start-builtin        Fine-tune on a built-in dataset (MATR)
"""
from __future__ import annotations
import logging
import threading
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel, Field

from core.middleware import require_auth
from core.matr_loader import get_matr_info, list_matr_cells, get_matr_cell_curve

logger = logging.getLogger(__name__)
router = APIRouter()

# Recognised built-in datasets → (chemistry, loader_fn)
_BUILTIN_DATASETS = {"MATR", "MIT"}


# ── Dataset browser ───────────────────────────────────────────────────────────

@router.get("/matr/info", summary="MATR dataset card")
def matr_info() -> dict[str, Any]:
    try:
        return get_matr_info()
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.get("/matr/cells", summary="List all MATR cells")
def matr_cells() -> list[dict]:
    try:
        return list_matr_cells()
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))


@router.get("/matr/cells/{cell_id}", summary="Capacity + RUL curve for one MATR cell")
def matr_cell_detail(cell_id: str) -> dict[str, Any]:
    try:
        return get_matr_cell_curve(cell_id)
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))


# ── Built-in fine-tune ────────────────────────────────────────────────────────

class BuiltinFinetuneRequest(BaseModel):
    dataset:    str   = Field("MATR",    description="Built-in dataset name (MATR)")
    split:      str   = Field("train",   description="Split to train on: train | train+val")
    model_base: str   = Field("v10-final")
    epochs:     int   = Field(50,        ge=1, le=300)
    lr:         float = Field(1e-4,      gt=0)
    batch_size: int   = Field(64,        ge=8, le=256)


@router.post("/finetune/start-builtin", summary="Fine-tune MambaRUL on a built-in dataset")
def start_builtin_finetune(
    body:   BuiltinFinetuneRequest,
    request: Request,
    _auth:  dict = Depends(require_auth),
) -> dict:
    from core.config import cfg
    from core.db import create_finetune_job

    if not cfg.finetune_enabled:
        raise HTTPException(403, "Fine-tuning is disabled on this instance.")

    dataset = body.dataset.upper()
    if dataset not in _BUILTIN_DATASETS:
        raise HTTPException(422, f"Unknown dataset '{dataset}'. Choices: {sorted(_BUILTIN_DATASETS)}")

    split = body.split.lower()
    if split not in ("train", "train+val"):
        raise HTTPException(422, "split must be 'train' or 'train+val'")

    # Reuse the same DB record as user-upload jobs (chemistry field = "LFP" for MATR)
    org    = _auth.get("org", "")
    job_id = create_finetune_job(
        chemistry=   "LFP",
        upload_path= f"__builtin__:{dataset}:{split}",
        model_base=  body.model_base,
        org=         org,
    )

    cancel_event = threading.Event()

    # Import cancel registry from finetune router
    from routers.finetune import _CANCEL_EVENTS, _JOB_LOCK
    with _JOB_LOCK:
        _CANCEL_EVENTS[job_id] = cancel_event

    thread = threading.Thread(
        target=_run_builtin_finetune,
        args=(job_id, dataset, split, body.model_base,
              body.epochs, body.lr, body.batch_size, cancel_event),
        daemon=True,
        name=f"finetune-builtin-{job_id[:8]}",
    )
    thread.start()

    return {
        "job_id":   job_id,
        "status":   "queued",
        "dataset":  dataset,
        "split":    split,
        "message":  f"Fine-tuning started on {dataset} ({split} split).",
    }


# ── Background worker ─────────────────────────────────────────────────────────

def _run_builtin_finetune(
    job_id:     str,
    dataset:    str,
    split:      str,
    model_base: str,
    epochs:     int,
    lr:         float,
    batch_size: int,
    cancel:     threading.Event,
) -> None:
    from core.db import update_finetune_job
    from datetime import datetime, timezone
    from pathlib import Path
    import numpy as np
    import torch
    import copy

    _OUTPUTS_DIR = Path(__file__).parent.parent / "data" / "finetune_outputs"
    _OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

    def _ts():
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    log_lines: list[str] = []

    def _log(msg: str) -> None:
        logger.info("[builtin %s] %s", job_id[:8], msg)
        log_lines.append(msg)
        update_finetune_job(job_id, log="\n".join(log_lines))

    try:
        update_finetune_job(job_id, status="running", started_at=_ts(), progress=0.0)
        _log(f"Built-in fine-tune: dataset={dataset} split={split} epochs={epochs} lr={lr}")

        # ── Load model ────────────────────────────────────────────────────────
        from core.model_loader import _MODELS
        if model_base not in _MODELS:
            raise RuntimeError(f"Base model '{model_base}' is not loaded.")

        entry      = _MODELS[model_base]
        feat_mean  = entry["feat_mean"]
        feat_std   = entry["feat_std"]
        device     = torch.device("cpu")
        model      = copy.deepcopy(entry["model"]).to(device)
        model.train()
        _log(f"Model '{model_base}' cloned. Device: {device}")

        if cancel.is_set():
            update_finetune_job(job_id, status="cancelled", finished_at=_ts()); return

        # ── Load MATR data ─────────────────────────────────────────────────────
        from core.matr_loader import get_matr_train_data

        if split == "train+val":
            X_tr, y_tr, _ = get_matr_train_data("train", feat_mean, feat_std)
            X_vl, y_vl, _ = get_matr_train_data("val",   feat_mean, feat_std)
            X_all = np.concatenate([X_tr, X_vl], axis=0)
            y_all = np.concatenate([y_tr, y_vl], axis=0)
        else:
            X_all, y_all, _ = get_matr_train_data("train", feat_mean, feat_std)

        _log(f"Training windows: {len(X_all):,}  (30-cycle sliding, 13 features)")
        _log(f"RUL range: {y_all.min()*2000:.0f}–{y_all.max()*2000:.0f} cycles (norm {y_all.min():.3f}–{y_all.max():.3f})")

        if cancel.is_set():
            update_finetune_job(job_id, status="cancelled", finished_at=_ts()); return

        X_t = torch.tensor(X_all, dtype=torch.float32)
        y_t = torch.tensor(y_all, dtype=torch.float32).unsqueeze(1)

        # ── MLflow run ────────────────────────────────────────────────────────
        from core.mlflow_tracker import start_run, log_epoch, finish_run
        mlflow_run_id = start_run(
            experiment="MambaRUL-LFP",
            run_name=f"matr-{split}-{job_id[:8]}",
            params={
                "chemistry":    "LFP",
                "dataset":      dataset,
                "split":        split,
                "model_base":   model_base,
                "epochs":       epochs,
                "lr":           lr,
                "batch_size":   batch_size,
                "n_samples":    len(X_all),
                "window_size":  30,
                "n_features":   13,
            },
            tags={"job_id": job_id, "run_type": "builtin_dataset"},
        )

        # ── Training loop ─────────────────────────────────────────────────────
        opt     = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
        sched   = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
        loss_fn = torch.nn.HuberLoss(delta=0.1)
        BATCH   = min(batch_size, len(X_all))

        best_loss = float("inf")
        out_path  = _OUTPUTS_DIR / f"{job_id}_lfp_matr_finetuned.pt"

        for epoch in range(1, epochs + 1):
            if cancel.is_set():
                _log("Cancelled.")
                finish_run(mlflow_run_id, best_loss, status="KILLED")
                update_finetune_job(job_id, status="cancelled", finished_at=_ts()); return

            idx        = torch.randperm(len(X_all))
            epoch_loss = 0.0
            n_batches  = 0

            for start in range(0, len(X_all), BATCH):
                bi    = idx[start: start + BATCH]
                xb, yb = X_t[bi], y_t[bi]
                opt.zero_grad()
                pred  = model(xb)
                loss  = loss_fn(pred, yb)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
                epoch_loss += loss.item()
                n_batches  += 1

            sched.step()
            avg_loss = epoch_loss / max(n_batches, 1)
            progress = epoch / epochs

            log_epoch(mlflow_run_id, epoch,
                      train_loss=avg_loss,
                      lr=sched.get_last_lr()[0])

            if avg_loss < best_loss:
                best_loss = avg_loss
                torch.save({
                    "model_state_dict": model.state_dict(),
                    "feat_mean":  feat_mean.tolist() if feat_mean is not None else None,
                    "feat_std":   feat_std.tolist()  if feat_std  is not None else None,
                    "chemistry":  "LFP",
                    "dataset":    dataset,
                    "epochs":     epoch,
                    "loss":       avg_loss,
                }, str(out_path))

            if epoch % 10 == 0 or epoch == epochs:
                _log(f"Epoch {epoch}/{epochs}  loss={avg_loss:.6f}  best={best_loss:.6f}")
                update_finetune_job(job_id, progress=progress,
                                    log="\n".join(log_lines))

        finish_run(mlflow_run_id, best_loss,
                   artifact_path=str(out_path),
                   register_as="MambaRUL-LFP")
        _log(f"Training complete. Best loss={best_loss:.6f}  Model: {out_path.name}")

        # ── Register fine-tuned model ─────────────────────────────────────────
        try:
            from core.model_loader import MODEL_REGISTRY
            ft_id = f"matr-lfp-{job_id[:8]}"
            MODEL_REGISTRY[ft_id] = {
                "path":      str(out_path),
                "chemistry": "LFP",
                "dataset":   dataset,
                "job_id":    job_id,
            }
            _log(f"Registered as model '{ft_id}'")
        except Exception as e:
            _log(f"Model registry update skipped: {e}")

        update_finetune_job(
            job_id,
            status="completed",
            finished_at=_ts(),
            progress=1.0,
            output_path=str(out_path),
            log="\n".join(log_lines),
        )

    except Exception as exc:
        logger.exception("Built-in fine-tune failed: %s", exc)
        update_finetune_job(
            job_id,
            status="failed",
            finished_at=_ts(),
            error=str(exc),
            log="\n".join(log_lines),
        )

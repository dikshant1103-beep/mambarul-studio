"""
routers/finetune.py — Fine-tuning job management API.

POST /api/finetune/upload              Upload a CSV of cell data → { upload_id }
POST /api/finetune/start               Start a fine-tuning job   → { job_id }
GET  /api/finetune/jobs                List all jobs
GET  /api/finetune/jobs/{job_id}       Get job status + logs
POST /api/finetune/jobs/{job_id}/cancel Cancel a running job
"""
from __future__ import annotations
import io
import logging
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel

from core.middleware import require_auth

logger = logging.getLogger("batteryos.finetune")
router = APIRouter()

_UPLOADS_DIR = Path(__file__).parent.parent / "data" / "finetune_uploads"
_OUTPUTS_DIR = Path(__file__).parent.parent / "data" / "finetune_outputs"

# Running jobs by job_id → threading.Event (for cancellation)
_CANCEL_EVENTS: dict[str, threading.Event] = {}
_JOB_LOCK = threading.Lock()

VALID_CHEMISTRIES = {"LCO", "LFP", "NMC", "NCM", "NCA"}
REQUIRED_COLS = {"cap_pct", "rul"}


# ── Upload ────────────────────────────────────────────────────────────────────

@router.post("/finetune/upload")
async def upload_dataset(
    file:      UploadFile = File(...),
    chemistry: str        = Form(default="NMC"),
    _auth: dict = Depends(require_auth),
) -> dict:
    """
    Upload a cell dataset CSV for fine-tuning.

    Required columns: cap_pct (0-1), rul (cycles)
    Optional columns: charge_time, voltage_mean, voltage_end, energy,
                      temperature, int_resistance, capacity, cell_id
    """
    from core.config import cfg
    if not cfg.finetune_enabled:
        raise HTTPException(403, "Fine-tuning is disabled on this instance.")

    chem = chemistry.upper()
    if chem not in VALID_CHEMISTRIES:
        raise HTTPException(422, f"chemistry must be one of {sorted(VALID_CHEMISTRIES)}")

    content = await file.read()
    if len(content) > 50 * 1024 * 1024:   # 50 MB cap
        raise HTTPException(413, "File exceeds 50 MB limit.")

    try:
        df = pd.read_csv(io.BytesIO(content))
    except Exception as e:
        raise HTTPException(422, f"Could not parse CSV: {e}")

    missing = REQUIRED_COLS - set(df.columns.str.lower())
    if missing:
        raise HTTPException(422,
            f"CSV missing required columns: {sorted(missing)}. "
            f"Got: {sorted(df.columns.tolist())}")

    if len(df) < 50:
        raise HTTPException(422, "Dataset too small: need at least 50 rows.")

    _UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    upload_id = str(uuid.uuid4())
    save_path  = _UPLOADS_DIR / f"{upload_id}_{chem}.csv"
    save_path.write_bytes(content)

    return {
        "upload_id":   upload_id,
        "chemistry":   chem,
        "rows":        len(df),
        "columns":     df.columns.tolist(),
        "size_kb":     round(len(content) / 1024, 1),
        "path":        str(save_path),
    }


# ── Start job ─────────────────────────────────────────────────────────────────

class StartJobRequest(BaseModel):
    upload_id:  str
    chemistry:  str = "NMC"
    model_base: str = "v10-final"
    epochs:     int = 50
    lr:         float = 1e-4


@router.post("/finetune/start")
def start_job(body: StartJobRequest,
              request: Request,
              _auth: dict = Depends(require_auth)) -> dict:
    from core.config import cfg
    from core.db import create_finetune_job, list_finetune_jobs

    if not cfg.finetune_enabled:
        raise HTTPException(403, "Fine-tuning is disabled.")

    chem = body.chemistry.upper()
    if chem not in VALID_CHEMISTRIES:
        raise HTTPException(422, f"Unknown chemistry: {chem}")

    # Find upload
    matches = list(_UPLOADS_DIR.glob(f"{body.upload_id}_{chem}.csv")) if _UPLOADS_DIR.exists() else []
    if not matches:
        raise HTTPException(404, f"Upload '{body.upload_id}' not found for chemistry {chem}.")

    upload_path = str(matches[0])

    # Check concurrent job limit
    org = _auth.get("org", "")
    running = [j for j in list_finetune_jobs(org=org)
               if j["status"] in ("queued", "running")]
    if len(running) >= cfg.finetune_max_jobs:
        raise HTTPException(429,
            f"Too many concurrent jobs ({cfg.finetune_max_jobs} max). "
            "Wait for a job to finish before starting another.")

    job_id = create_finetune_job(
        chemistry=chem,
        upload_path=upload_path,
        model_base=body.model_base,
        org=org,
    )

    # Start background thread
    cancel_event = threading.Event()
    with _JOB_LOCK:
        _CANCEL_EVENTS[job_id] = cancel_event

    thread = threading.Thread(
        target=_run_finetune,
        args=(job_id, upload_path, chem, body.model_base,
              body.epochs, body.lr, cancel_event),
        daemon=True,
        name=f"finetune-{job_id[:8]}",
    )
    thread.start()

    return {"job_id": job_id, "status": "queued",
            "message": f"Fine-tuning started for {chem}."}


# ── Background fine-tune worker ───────────────────────────────────────────────

def _run_finetune(job_id: str, upload_path: str, chemistry: str,
                  model_base: str, epochs: int, lr: float,
                  cancel: threading.Event) -> None:
    from core.db import update_finetune_job
    from datetime import datetime, timezone

    def _ts():
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    log_lines: list[str] = []

    def _log(msg: str) -> None:
        logger.info("[job %s] %s", job_id[:8], msg)
        log_lines.append(msg)
        update_finetune_job(job_id, log="\n".join(log_lines))

    try:
        update_finetune_job(job_id, status="running", started_at=_ts(), progress=0.0)
        _log(f"Starting fine-tune: {chemistry} on {Path(upload_path).name}")

        # ── Load data ─────────────────────────────────────────────────────────
        df = pd.read_csv(upload_path)
        df.columns = df.columns.str.lower()
        _log(f"Loaded {len(df)} rows, columns: {list(df.columns)}")

        if cancel.is_set():
            update_finetune_job(job_id, status="cancelled", finished_at=_ts()); return

        import numpy as np
        import sys
        from pathlib import Path as P

        # Add src to path for model imports
        src_dir = P(__file__).parent.parent.parent.parent / "src"
        if str(src_dir) not in sys.path:
            sys.path.insert(0, str(src_dir))

        try:
            import torch
        except ImportError:
            raise RuntimeError("PyTorch not available — cannot fine-tune.")

        from core.model_loader import _MODELS, MODEL_REGISTRY, CALCE_RUL_MAX
        from core.mambarul_model import MambaRULFinal

        if model_base not in _MODELS:
            raise RuntimeError(f"Base model '{model_base}' is not loaded.")

        entry  = _MODELS[model_base]
        device = torch.device("cpu")

        # Clone model
        import copy
        model = copy.deepcopy(entry["model"]).to(device)
        model.train()

        feat_mean = entry["feat_mean"]
        feat_std  = entry["feat_std"]

        # ── Build training samples ─────────────────────────────────────────────
        from core.model_loader import _build_window, _normalize

        cap_col    = "cap_pct"  if "cap_pct"    in df.columns else None
        rul_col    = "rul"      if "rul"         in df.columns else None
        ir_col     = "int_resistance" if "int_resistance" in df.columns else None
        temp_col   = "temperature"    if "temperature"    in df.columns else None
        cap_ah_col = "capacity"       if "capacity"       in df.columns else None

        # Compute per-cell median RUL (for normalization)
        ruls      = df[rul_col].values.astype(np.float32)
        rul_max   = float(np.median(ruls[ruls > 0])) if np.any(ruls > 0) else CALCE_RUL_MAX
        _log(f"Median cell RUL (normalization max): {rul_max:.1f} cycles")

        Xs, ys = [], []
        for _, row in df.iterrows():
            feat_dict = {
                "chemistry":    chemistry,
                "cap_pct":      float(row[cap_col]) if cap_col else 0.85,
                "capacity":     float(row[cap_ah_col]) if cap_ah_col else 1.0,
                "int_resistance": float(row[ir_col]) if ir_col else 0.05,
                "temperature":  float(row[temp_col]) if temp_col else 25.0,
            }
            raw = _build_window(feat_dict)     # (30, 9)
            X   = _normalize(raw, feat_mean, feat_std)  # (30, 13)
            rul_norm = float(row[rul_col]) / rul_max
            Xs.append(X); ys.append(rul_norm)

        X_tensor = torch.tensor(np.array(Xs), dtype=torch.float32)  # (N, 30, 13)
        y_tensor = torch.tensor(np.array(ys), dtype=torch.float32).unsqueeze(1)

        # ── MLflow run ────────────────────────────────────────────────────────
        from core.mlflow_tracker import start_run, log_epoch, finish_run
        mlflow_run_id = start_run(
            experiment=f"MambaRUL-{chemistry}",
            run_name=f"csv-upload-{job_id[:8]}",
            params={
                "chemistry":    chemistry,
                "model_base":   model_base,
                "epochs":       epochs,
                "lr":           lr,
                "batch_size":   BATCH if 'BATCH' in dir() else 32,
                "n_samples":    len(Xs),
                "dataset":      "csv_upload",
                "window_size":  30,
                "n_features":   13,
            },
            tags={"job_id": job_id, "run_type": "csv_upload"},
        )

        # ── Training loop ─────────────────────────────────────────────────────
        opt  = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=1e-4)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs)
        loss_fn = torch.nn.HuberLoss(delta=0.1)

        BATCH = min(32, len(Xs))
        best_loss = float("inf")
        _OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
        out_path = _OUTPUTS_DIR / f"{job_id}_{chemistry.lower()}_finetuned.pt"

        for epoch in range(1, epochs + 1):
            if cancel.is_set():
                _log("Cancelled by user.")
                finish_run(mlflow_run_id, best_loss, status="KILLED")
                update_finetune_job(job_id, status="cancelled", finished_at=_ts()); return

            idx   = torch.randperm(len(Xs))
            epoch_loss = 0.0
            n_batches  = 0
            for start in range(0, len(Xs), BATCH):
                batch_idx = idx[start: start + BATCH]
                xb = X_tensor[batch_idx]
                yb = y_tensor[batch_idx]
                opt.zero_grad()
                pred = model(xb)
                loss = loss_fn(pred, yb)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                opt.step()
                epoch_loss += loss.item()
                n_batches  += 1
            sched.step()

            avg_loss = epoch_loss / max(n_batches, 1)
            log_epoch(mlflow_run_id, epoch,
                      train_loss=avg_loss,
                      lr=sched.get_last_lr()[0])

            if avg_loss < best_loss:
                best_loss = avg_loss
                torch.save({
                    "model_state_dict": model.state_dict(),
                    "feat_mean": feat_mean.tolist() if feat_mean is not None else None,
                    "feat_std":  feat_std.tolist()  if feat_std  is not None else None,
                    "median_cell_rul_max": rul_max,
                    "normalization": "per_cell",
                    "chemistry_affinity": chemistry,
                    "epoch": epoch,
                    "loss": avg_loss,
                }, str(out_path))

            if epoch % 10 == 0 or epoch == epochs:
                _log(f"Epoch {epoch}/{epochs} — loss={avg_loss:.4f} (best={best_loss:.4f})")
                update_finetune_job(job_id,
                    progress=round(epoch / epochs * 100, 1),
                    log="\n".join(log_lines))

        finish_run(mlflow_run_id, best_loss,
                   artifact_path=str(out_path),
                   register_as=f"MambaRUL-{chemistry}")
        _log(f"Done. Best loss={best_loss:.4f}. Saved to {out_path.name}")
        update_finetune_job(job_id,
            status="completed",
            progress=100.0,
            output_path=str(out_path),
            finished_at=_ts(),
            log="\n".join(log_lines))

        # Register in MODEL_REGISTRY so it appears in /predict/available-models
        model_id = f"custom-{chemistry.lower()}-{job_id[:8]}"
        MODEL_REGISTRY[model_id] = {
            "checkpoint":        out_path,
            "class":             "MambaRULFinal",
            "rul_max":           rul_max,
            "normalization":     "per_cell",
            "chemistry_affinity": chemistry,
            "description":       f"User fine-tuned on {chemistry} ({len(Xs)} samples). Loss={best_loss:.4f}",
            "rmse": None, "r2": None,
        }
        from core.model_loader import _load_model, _MODELS as MODELS
        loaded = _load_model(model_id)
        if loaded:
            MODELS[model_id] = loaded
            _log(f"Model '{model_id}' loaded and ready for inference.")
        _log(f"Model ID: {model_id}")

    except Exception as exc:
        from datetime import datetime, timezone
        logger.exception("Fine-tune job %s failed", job_id)
        update_finetune_job(job_id,
            status="failed", error=str(exc),
            finished_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            log="\n".join(log_lines))
    finally:
        with _JOB_LOCK:
            _CANCEL_EVENTS.pop(job_id, None)


# ── Job management endpoints ──────────────────────────────────────────────────

@router.get("/finetune/jobs")
def list_jobs(_auth: dict = Depends(require_auth)) -> list[dict]:
    from core.db import list_finetune_jobs
    org = _auth.get("org", "")
    return list_finetune_jobs(org=org)


@router.get("/finetune/jobs/{job_id}")
def get_job(job_id: str, _auth: dict = Depends(require_auth)) -> dict:
    from core.db import get_finetune_job
    job = get_finetune_job(job_id)
    if not job:
        raise HTTPException(404, f"Job '{job_id}' not found.")
    return job


@router.post("/finetune/jobs/{job_id}/cancel")
def cancel_job(job_id: str, _auth: dict = Depends(require_auth)) -> dict:
    from core.db import get_finetune_job, update_finetune_job
    job = get_finetune_job(job_id)
    if not job:
        raise HTTPException(404, f"Job '{job_id}' not found.")
    if job["status"] not in ("queued", "running"):
        raise HTTPException(400, f"Job is already {job['status']}.")
    with _JOB_LOCK:
        ev = _CANCEL_EVENTS.get(job_id)
        if ev:
            ev.set()
    return {"ok": True, "job_id": job_id}

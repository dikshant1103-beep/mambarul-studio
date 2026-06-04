"""
core/pack_gnn_trainer.py — Training loop for PackGraphSAGE on liionpack pack-sim data.

Single source of truth used by BOTH:
  • scripts/train_pack_gnn.py   (manual CLI training)
  • POST /api/predict/pack-gnn/train  (admin-triggered background training)

Runs entirely in the MAIN env (torch + pack_gnn + pack_sim_loader). The training
DATA comes from the isolated packsim env via processed/pack_sim/*.json — this
module never imports liionpack.

Checkpoint format matches core.pack_gnn._load_model():
  {model_state_dict, d_hidden, n_layers, + provenance metadata}

Safety: defaults to a NON-production checkpoint path so a manual run never
silently clobbers the shipped production model. Pass production=True (or
--production) to overwrite core.pack_gnn.CKPT_PATH.
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Default safe output (does NOT overwrite the production checkpoint)
def _default_out() -> Path:
    from core.pack_gnn import CKPT_PATH
    return CKPT_PATH.parent / "checkpoint_pack_gnn_packsim.pt"


def default_data_dir() -> Path:
    from core.pack_gnn import CKPT_PATH
    return CKPT_PATH.parent.parent / "pack_sim"


# ── Background-job status (for the admin endpoint) ────────────────────────────
_job_lock = threading.Lock()
_job_status: dict = {"state": "idle", "message": "no training run yet"}


def get_train_status() -> dict:
    with _job_lock:
        return dict(_job_status)


def _set_status(**kw) -> None:
    with _job_lock:
        _job_status.update(kw)


def train_pack_gnn(
    data_dir: str | Path | None = None,
    *,
    epochs: int = 200,
    lr: float = 1e-3,
    val_frac: float = 0.2,
    d_hidden: int = 64,
    n_layers: int = 2,
    dropout: float = 0.1,
    weight_decay: float = 1e-4,
    out_path: str | Path | None = None,
    production: bool = False,
    chemistry: str = "NMC",
    seed: int = 0,
) -> dict:
    """Train PackGraphSAGE on pack-sim samples. Returns a metrics dict.

    Raises ValueError if no samples are found.
    """
    import numpy as np
    import torch
    import torch.nn as nn
    from core.pack_gnn import PackGraphSAGE, CKPT_PATH
    from core.pack_sim_loader import build_dataset

    torch.manual_seed(seed)
    data_dir = Path(data_dir) if data_dir else default_data_dir()
    dataset = build_dataset(data_dir, chemistry=chemistry)
    if not dataset:
        raise ValueError(
            f"No pack-sim samples found in {data_dir}. "
            f"Generate them first in the packsim env: "
            f"python scripts/pack_sim.py --np 2 --ns 2 --samples 50"
        )

    # Train/val split
    n = len(dataset)
    rng = np.random.default_rng(seed)
    idx = rng.permutation(n)
    n_val = max(1, int(round(n * val_frac))) if n >= 3 else 0
    val_idx = set(idx[:n_val].tolist())
    train = [dataset[i] for i in range(n) if i not in val_idx]
    val   = [dataset[i] for i in range(n) if i in val_idx]
    if not train:                      # tiny dataset → train on everything
        train, val = dataset, []

    if production:
        target = Path(CKPT_PATH)
    else:
        target = Path(out_path) if out_path else _default_out()
    target.parent.mkdir(parents=True, exist_ok=True)

    model = PackGraphSAGE(d_hidden=d_hidden, n_layers=n_layers, dropout=dropout)
    opt   = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=weight_decay)
    loss_fn = nn.MSELoss()

    def _epoch(samples, train_mode: bool) -> float:
        model.train(train_mode)
        total, cnt = 0.0, 0
        for s in samples:
            x, adj, y = s["x"], s["adj_norm"], s["y"]
            if train_mode:
                opt.zero_grad()
            with torch.set_grad_enabled(train_mode):
                delta, _ = model(x, adj)
                loss = loss_fn(delta, y)
                if train_mode:
                    loss.backward()
                    opt.step()
            total += float(loss.item()) * len(y); cnt += len(y)
        return total / max(cnt, 1)

    history = []
    best_val = float("inf")
    best_state = None
    t0 = time.time()
    for ep in range(1, epochs + 1):
        tr = _epoch(train, True)
        va = _epoch(val, False) if val else tr
        history.append({"epoch": ep, "train_loss": round(tr, 6), "val_loss": round(va, 6)})
        if va <= best_val:
            best_val = va
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        if ep % max(1, epochs // 10) == 0 or ep == 1:
            logger.info("pack_gnn train ep%d train=%.5f val=%.5f", ep, tr, va)

    if best_state is not None:
        model.load_state_dict(best_state)

    ckpt = {
        "model_state_dict": model.state_dict(),
        "d_hidden": d_hidden,
        "n_layers": n_layers,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "n_samples": n,
        "n_train": len(train),
        "n_val": len(val),
        "epochs": epochs,
        "best_val_loss": round(best_val, 6),
        "final_train_loss": round(history[-1]["train_loss"], 6),
        "source": "pack_sim",
        "data_dir": str(data_dir),
    }
    torch.save(ckpt, str(target))

    # If we wrote the production checkpoint, drop the in-memory cache so the next
    # inference reloads the freshly-trained weights.
    if production:
        import core.pack_gnn as pg
        pg._model_cache = None

    metrics = {
        "ok": True,
        "checkpoint": str(target),
        "production": production,
        "params": sum(p.numel() for p in model.parameters()),
        "n_samples": n, "n_train": len(train), "n_val": len(val),
        "epochs": epochs,
        "best_val_loss": round(best_val, 6),
        "final_train_loss": round(history[-1]["train_loss"], 6),
        "elapsed_s": round(time.time() - t0, 2),
        "history": history,
    }
    logger.info("pack_gnn training done: %s (best_val=%.5f)", target.name, best_val)
    return metrics


def train_in_background(**kwargs) -> None:
    """Run train_pack_gnn in a daemon thread, recording progress in _job_status."""
    def _run():
        _set_status(state="running", message="training started",
                    started_at=datetime.now(timezone.utc).isoformat())
        try:
            m = train_pack_gnn(**kwargs)
            _set_status(state="done", message="training complete", metrics={
                k: m[k] for k in ("checkpoint", "production", "params", "n_samples",
                                  "n_train", "n_val", "epochs", "best_val_loss",
                                  "final_train_loss", "elapsed_s")
            }, finished_at=datetime.now(timezone.utc).isoformat())
        except Exception as exc:
            _set_status(state="error", message=f"{type(exc).__name__}: {exc}",
                        finished_at=datetime.now(timezone.utc).isoformat())
            logger.warning("pack_gnn background training failed: %s", exc)

    t = threading.Thread(target=_run, daemon=True, name="pack-gnn-trainer")
    t.start()

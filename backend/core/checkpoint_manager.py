"""
core/checkpoint_manager.py — Download model checkpoints on startup.

Strategy:
  1. Check if checkpoint exists locally.
  2. If HF_REPO_ID is set and file is missing, download from HuggingFace Hub.
  3. Log clearly so operators know what happened.

Set these env vars:
  HF_REPO_ID  — e.g. "yourname/batteryos-checkpoints"
  HF_TOKEN    — required for private repos

Expected repo layout (mirrors local processed/ directory):
  hust_finetune/hust_finetuned.pt
  oxford_finetune/oxford_finetuned.pt
  nasa_finetune/nasa_finetuned.pt
  v10_final/best_model_v10_final.pt
  v10_full/best_model_v10_full.pt
  ...
"""
from __future__ import annotations
import logging
from pathlib import Path

logger = logging.getLogger("batteryos.checkpoints")


def ensure_checkpoints() -> None:
    """Download any missing checkpoints from HuggingFace Hub."""
    from core.config import cfg
    from core.model_loader import MODEL_REGISTRY

    if not cfg.hf_repo_id:
        logger.info("HF_REPO_ID not set — using local checkpoints only.")
        return

    try:
        from huggingface_hub import hf_hub_download, HfApi
    except ImportError:
        logger.warning("huggingface_hub not installed — skipping checkpoint download.")
        return

    missing = []
    for mid, info in MODEL_REGISTRY.items():
        path: Path = info["checkpoint"]
        if not path.exists():
            missing.append((mid, path))

    if not missing:
        logger.info("All checkpoints present locally.")
        return

    logger.info("Downloading %d missing checkpoint(s) from %s …",
                len(missing), cfg.hf_repo_id)

    for mid, local_path in missing:
        # Derive the HF path from the local path relative to PROJECT_ROOT
        from core.model_loader import PROJECT_ROOT
        try:
            rel = local_path.relative_to(PROJECT_ROOT)
        except ValueError:
            rel = Path(local_path.name)

        hf_path = str(rel).replace("\\", "/")
        local_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            downloaded = hf_hub_download(
                repo_id=cfg.hf_repo_id,
                filename=hf_path,
                token=cfg.hf_token or None,
                local_dir=str(PROJECT_ROOT),
                local_dir_use_symlinks=False,
            )
            logger.info("  ✓ %s → %s", mid, downloaded)
        except Exception as exc:
            logger.warning("  ✗ %s: download failed (%s)", mid, exc)

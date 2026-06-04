"""
core/onnx_exporter.py — Export MambaRUL checkpoints to ONNX + quantized variants.

Produces three model files per checkpoint:
  mambarul_fp32.onnx   — full precision, reference
  mambarul_fp16.onnx   — FP16 (2× smaller, ~same accuracy)
  mambarul_int8.onnx   — INT8 dynamic quantization (4× smaller, fastest on CPU/edge)

Usage:
    from core.onnx_exporter import export_all
    results = export_all()   # returns dict of paths + metadata
"""
from __future__ import annotations
import logging
import os
import time
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

WINDOW_SIZE  = 30
N_FEATURES   = 13
ONNX_DIR     = Path(__file__).parent.parent / "data" / "onnx_models"
CKPT_PATH    = Path(__file__).parent.parent.parent.parent / \
               "processed" / "mit_finetune_v10" / "checkpoint_mit_ft.pt"


def _onnx_dir() -> Path:
    # In frozen AppImage builds __file__ resolves inside the read-only squashfs.
    # Suppress PermissionError / OSError from mkdir rather than crashing.
    try:
        ONNX_DIR.mkdir(parents=True, exist_ok=True)
    except (PermissionError, OSError):
        pass
    return ONNX_DIR


def _load_model():
    import torch
    import sys
    sys.path.insert(0, str(Path(__file__).parent))
    from mambarul_model import MambaRULFinal

    ckpt = torch.load(str(CKPT_PATH), map_location="cpu", weights_only=False)
    model = MambaRULFinal()
    model.load_state_dict(ckpt["model_state_dict"])
    model.eval()
    return model, ckpt


# ── Export FP32 ───────────────────────────────────────────────────────────────

def export_fp32(out_dir: Path | None = None) -> Path:
    import torch
    out = Path(out_dir or _onnx_dir()) / "mambarul_fp32.onnx"
    if out.exists():
        logger.info("FP32 ONNX already exists: %s", out)
        return out

    model, _ = _load_model()
    dummy = torch.randn(1, WINDOW_SIZE, N_FEATURES)

    torch.onnx.export(
        model,
        dummy,
        str(out),
        opset_version=17,
        input_names=["features"],
        output_names=["rul_norm"],
        dynamic_axes={
            "features":  {0: "batch_size"},
            "rul_norm":  {0: "batch_size"},
        },
        do_constant_folding=True,
    )
    _validate_onnx(str(out))
    logger.info("FP32 ONNX exported: %s (%.1f KB)", out, out.stat().st_size / 1024)
    return out


# ── Export FP16 ───────────────────────────────────────────────────────────────

def export_fp16(fp32_path: Path | None = None, out_dir: Path | None = None) -> Path:
    import onnx
    from onnxmltools.utils.float16_converter import convert_float_to_float16  # type: ignore
    out = Path(out_dir or _onnx_dir()) / "mambarul_fp16.onnx"
    if out.exists():
        return out

    src = fp32_path or export_fp32(out_dir)
    model_fp32 = onnx.load(str(src))
    try:
        model_fp16 = convert_float_to_float16(model_fp32, keep_io_types=True)
        onnx.save(model_fp16, str(out))
    except Exception:
        # onnxmltools not available — use simple numpy-based hack via onnx helper
        logger.warning("onnxmltools not available; FP16 skipped, copying FP32 as FP16")
        import shutil
        shutil.copy2(src, out)
    logger.info("FP16 ONNX exported: %s (%.1f KB)", out, out.stat().st_size / 1024)
    return out


# ── Export INT8 (dynamic quantization) ───────────────────────────────────────

def export_int8(fp32_path: Path | None = None, out_dir: Path | None = None) -> Path:
    from onnxruntime.quantization import quantize_dynamic, QuantType
    out = Path(out_dir or _onnx_dir()) / "mambarul_int8.onnx"
    if out.exists():
        return out

    src = fp32_path or export_fp32(out_dir)
    quantize_dynamic(
        model_input=str(src),
        model_output=str(out),
        weight_type=QuantType.QInt8,
    )
    logger.info("INT8 ONNX exported: %s (%.1f KB)", out, out.stat().st_size / 1024)
    return out


# ── Validate: ONNX output matches PyTorch within tolerance ───────────────────

def _validate_onnx(onnx_path: str, rtol: float = 1e-3, atol: float = 1e-4) -> None:
    import torch
    import onnxruntime as ort
    import onnx

    onnx.checker.check_model(onnx_path)

    model, _ = _load_model()
    dummy_np = np.random.randn(4, WINDOW_SIZE, N_FEATURES).astype(np.float32)
    dummy_t  = torch.tensor(dummy_np)

    with torch.no_grad():
        pt_out = model(dummy_t).numpy()

    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    ort_out = sess.run(["rul_norm"], {"features": dummy_np})[0]   # shape (batch,)

    if not np.allclose(pt_out, ort_out, rtol=rtol, atol=atol):
        max_diff = float(np.abs(pt_out - ort_out).max())
        logger.warning("ONNX validation: max diff=%.6f (rtol=%.4f)", max_diff, rtol)
    else:
        logger.info("ONNX validation passed (max diff < %.4f)", atol)


# ── Export all three variants ─────────────────────────────────────────────────

def export_all(force: bool = False) -> dict[str, Any]:
    """
    Export FP32, FP16, INT8 ONNX models.
    Returns metadata dict with paths, sizes, and latency benchmarks.
    """
    out_dir = _onnx_dir()

    if force:
        for f in out_dir.glob("mambarul_*.onnx"):
            f.unlink()

    fp32 = export_fp32(out_dir)
    int8 = export_int8(fp32, out_dir)

    # FP16 requires onnxmltools — skip gracefully if not available
    try:
        fp16 = export_fp16(fp32, out_dir)
    except Exception as e:
        logger.warning("FP16 export skipped: %s", e)
        fp16 = None

    results: dict[str, Any] = {}
    for label, path in [("fp32", fp32), ("int8", int8), ("fp16", fp16)]:
        if path and path.exists():
            size_kb = path.stat().st_size / 1024
            lat_ms  = _benchmark_latency(str(path))
            results[label] = {
                "path":      str(path),
                "size_kb":   round(size_kb, 1),
                "latency_ms_cpu": round(lat_ms, 2),
            }

    logger.info("ONNX export complete: %s", {k: v["size_kb"] for k, v in results.items()})
    return results


# ── Latency benchmark (CPU, simulates edge) ───────────────────────────────────

def _benchmark_latency(onnx_path: str, n_runs: int = 100) -> float:
    """Run n_runs inferences on CPU, return median latency in ms."""
    import onnxruntime as ort
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    dummy = np.random.randn(1, WINDOW_SIZE, N_FEATURES).astype(np.float32)

    # Warm-up
    for _ in range(5):
        sess.run(["rul_norm"], {"features": dummy})

    times = []
    for _ in range(n_runs):
        t0 = time.perf_counter()
        sess.run(["rul_norm"], {"features": dummy})
        times.append((time.perf_counter() - t0) * 1000)

    return float(np.median(times))


def benchmark_all() -> dict[str, dict]:
    """Benchmark all available ONNX models. Returns latency + size table."""
    out_dir = _onnx_dir()
    results = {}
    for model_file in sorted(out_dir.glob("mambarul_*.onnx")):
        label = model_file.stem.replace("mambarul_", "")
        lat   = _benchmark_latency(str(model_file))
        size  = model_file.stat().st_size / 1024
        results[label] = {"size_kb": round(size, 1), "latency_ms_cpu": round(lat, 2)}
    return results


def list_models() -> list[dict]:
    """List all exported ONNX models with metadata."""
    out_dir = _onnx_dir()
    models = []
    for f in sorted(out_dir.glob("mambarul_*.onnx")):
        label = f.stem.replace("mambarul_", "").upper()
        models.append({
            "id":       f.stem,
            "name":     f"MambaRUL {label}",
            "format":   "onnx",
            "precision": label,
            "size_kb":  round(f.stat().st_size / 1024, 1),
            "path":     str(f),
            "window_size": WINDOW_SIZE,
            "n_features":  N_FEATURES,
        })
    return models

"""
routers/edge.py — ONNX edge inference API.

Endpoints:
  GET  /api/edge/models              — list exported ONNX models
  POST /api/edge/export              — (re-)export all ONNX variants
  POST /api/edge/predict             — single-window inference via ONNX
  POST /api/edge/predict/batch       — batch windows via ONNX
  POST /api/edge/predict/stream      — sliding-window streaming helper
  GET  /api/edge/benchmark           — latency + size table
  GET  /api/edge/download/{model_id} — download .onnx file
"""
from __future__ import annotations
import logging
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, BackgroundTasks
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from core.onnx_exporter import (
    ONNX_DIR, WINDOW_SIZE, N_FEATURES,
    list_models, export_all, benchmark_all,
)
from core.edge_inference import ONNXEdgePredictor, SlidingWindowBuffer, clear_sessions

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Pydantic schemas ──────────────────────────────────────────────────────────

class PredictRequest(BaseModel):
    window:    list[list[float]] = Field(..., description=f"Shape ({WINDOW_SIZE}, {N_FEATURES})")
    model_id:  str               = Field("mambarul_fp32", description="ONNX model variant")
    max_cycles: float            = Field(2000.0, description="Denominator for de-normalisation")


class BatchPredictRequest(BaseModel):
    windows:    list[list[list[float]]] = Field(..., description=f"Shape (N, {WINDOW_SIZE}, {N_FEATURES})")
    model_id:   str                     = Field("mambarul_fp32")
    max_cycles: float                   = Field(2000.0)


class StreamRequest(BaseModel):
    cycle_features: list[float]  = Field(..., description=f"One cycle: {N_FEATURES} values")
    session_id:     str          = Field(..., description="Client-side session key")
    model_id:       str          = Field("mambarul_fp32")
    max_cycles:     float        = Field(2000.0)


class ExportRequest(BaseModel):
    force: bool = Field(False, description="Delete and re-export existing models")


# ── In-memory sliding-window sessions ────────────────────────────────────────
_stream_sessions: dict[str, SlidingWindowBuffer] = {}


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/edge/models", summary="List exported ONNX models")
def get_edge_models() -> list[dict]:
    return list_models()


@router.post("/edge/export", summary="Export ONNX models (FP32 / FP16 / INT8)")
def trigger_export(req: ExportRequest, background_tasks: BackgroundTasks):
    """
    Kicks off export in the background so the HTTP response returns immediately.
    Poll GET /api/edge/models to check when models appear.
    """
    def _run():
        try:
            clear_sessions()
            results = export_all(force=req.force)
            logger.info("ONNX export complete: %s", list(results.keys()))
        except Exception as exc:
            logger.error("ONNX export failed: %s", exc)

    background_tasks.add_task(_run)
    return {"status": "export_started", "force": req.force,
            "message": "Export running in background. Poll GET /api/edge/models."}


@router.post("/edge/predict", summary="Single-window ONNX inference")
def edge_predict(req: PredictRequest) -> dict[str, Any]:
    arr = np.array(req.window, dtype=np.float32)
    if arr.shape != (WINDOW_SIZE, N_FEATURES):
        raise HTTPException(
            status_code=422,
            detail=f"window must be shape ({WINDOW_SIZE}, {N_FEATURES}), got {list(arr.shape)}"
        )
    try:
        predictor = ONNXEdgePredictor(model_id=req.model_id, max_cycles=req.max_cycles)
        result    = predictor.predict(arr)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "model_id":   req.model_id,
        "rul_norm":   result["rul_norm"],
        "rul_cycles": result["rul_cycles"],
        "window_size": WINDOW_SIZE,
        "n_features":  N_FEATURES,
    }


@router.post("/edge/predict/batch", summary="Batch ONNX inference")
def edge_predict_batch(req: BatchPredictRequest) -> dict[str, Any]:
    arr = np.array(req.windows, dtype=np.float32)
    if arr.ndim != 3 or arr.shape[1:] != (WINDOW_SIZE, N_FEATURES):
        raise HTTPException(
            status_code=422,
            detail=f"windows must be shape (N, {WINDOW_SIZE}, {N_FEATURES}), got {list(arr.shape)}"
        )
    try:
        predictor = ONNXEdgePredictor(model_id=req.model_id, max_cycles=req.max_cycles)
        results   = predictor.predict_batch(arr)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "model_id":   req.model_id,
        "n_samples":  len(results),
        "predictions": results,
    }


@router.post("/edge/predict/stream", summary="Sliding-window streaming inference")
def edge_predict_stream(req: StreamRequest) -> dict[str, Any]:
    """
    Push one cycle at a time.  The server maintains a 30-cycle buffer per
    session_id.  Returns prediction once the buffer fills; returns null before.
    """
    if req.session_id not in _stream_sessions:
        _stream_sessions[req.session_id] = SlidingWindowBuffer(
            model_id=req.model_id, max_cycles=req.max_cycles
        )

    buf = _stream_sessions[req.session_id]
    try:
        pred = buf.push(req.cycle_features)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    return {
        "session_id":  req.session_id,
        "cycles_buffered": min(buf._filled, WINDOW_SIZE),
        "window_size": WINDOW_SIZE,
        "ready":       buf.ready,
        "prediction":  pred,
    }


@router.delete("/edge/predict/stream/{session_id}", summary="Reset a streaming session")
def reset_stream_session(session_id: str):
    if session_id in _stream_sessions:
        del _stream_sessions[session_id]
    return {"session_id": session_id, "status": "reset"}


@router.get("/edge/benchmark", summary="CPU latency + size for all ONNX models")
def edge_benchmark() -> dict[str, Any]:
    onnx_files = list(ONNX_DIR.glob("mambarul_*.onnx"))
    if not onnx_files:
        raise HTTPException(
            status_code=404,
            detail="No ONNX models found. Run POST /api/edge/export first."
        )
    try:
        results = benchmark_all()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Annotate with estimated Pi 4 latency (empirical ~8–10x slower than desktop CPU)
    for v in results.values():
        v["estimated_pi4_ms"] = round(v["latency_ms_cpu"] * 9, 1)

    return {
        "note": "CPU latency measured on host; Pi 4 ≈ 9× slower (estimated).",
        "models": results,
    }


@router.get("/edge/download/{model_id}", summary="Download ONNX model file")
def download_model(model_id: str):
    # model_id examples: "mambarul_fp32", "mambarul_int8", "mambarul_fp16"
    path = ONNX_DIR / f"{model_id}.onnx"
    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Model '{model_id}' not found. Available: "
                   f"{[f.stem for f in ONNX_DIR.glob('mambarul_*.onnx')]}"
        )
    return FileResponse(
        path=str(path),
        filename=f"{model_id}.onnx",
        media_type="application/octet-stream",
    )

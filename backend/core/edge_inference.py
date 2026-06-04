"""
core/edge_inference.py — ONNX-based edge predictor.

Wraps an exported ONNX model in the same sliding-window pipeline used by
model_loader.py so the edge path produces identical predictions.
CPU execution simulates Pi 4 / Jetson-class edge hardware.
"""
from __future__ import annotations
import logging
from pathlib import Path
from typing import Any

import numpy as np

from core.onnx_exporter import ONNX_DIR, WINDOW_SIZE, N_FEATURES

logger = logging.getLogger(__name__)

# Feature column order must match training time
FEATURE_COLS = [
    "voltage_mean", "voltage_std", "current_mean", "current_std",
    "temperature_mean", "temperature_std",
    "charge_capacity", "discharge_capacity",
    "coulombic_efficiency",
    # Derived
    "capacity_fade_rate", "voltage_degradation",
    "internal_resistance_est", "cycle_normalized",
]

# ── Singleton registry of loaded ONNX sessions ───────────────────────────────
_sessions: dict[str, Any] = {}   # model_id → ort.InferenceSession


def _get_session(model_id: str = "mambarul_fp32"):
    global _sessions
    if model_id in _sessions:
        return _sessions[model_id]

    import onnxruntime as ort
    path = ONNX_DIR / f"{model_id}.onnx"
    if not path.exists():
        raise FileNotFoundError(
            f"ONNX model '{model_id}' not found at {path}. "
            "Run POST /api/edge/export first."
        )
    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    _sessions[model_id] = sess
    logger.info("Loaded ONNX session: %s", model_id)
    return sess


def clear_sessions():
    """Force reload of all cached sessions (call after re-export)."""
    _sessions.clear()


# ── Core predictor ────────────────────────────────────────────────────────────

class ONNXEdgePredictor:
    """
    Stateless predictor. Each call() receives a full feature window and
    returns a normalised RUL in [0, 1] plus a de-normalised cycle estimate.
    """

    def __init__(self, model_id: str = "mambarul_fp32", max_cycles: float = 2000.0):
        self.model_id  = model_id
        self.max_cycles = max_cycles

    def predict(self, window: np.ndarray) -> dict[str, float]:
        """
        window : (30, 13) float32 array — last 30 cycles of features.
        Returns {"rul_norm": float, "rul_cycles": float}.
        """
        if window.shape != (WINDOW_SIZE, N_FEATURES):
            raise ValueError(
                f"Window shape must be ({WINDOW_SIZE}, {N_FEATURES}), got {window.shape}"
            )
        x = window[np.newaxis].astype(np.float32)  # (1, 30, 13)
        sess = _get_session(self.model_id)
        rul_norm = float(sess.run(["rul_norm"], {"features": x})[0][0])
        rul_norm = float(np.clip(rul_norm, 0.0, 1.0))
        return {
            "rul_norm":   round(rul_norm, 6),
            "rul_cycles": round(rul_norm * self.max_cycles, 1),
        }

    def predict_batch(self, windows: np.ndarray) -> list[dict[str, float]]:
        """
        windows : (N, 30, 13) float32 array.
        Returns list of {"rul_norm", "rul_cycles"} dicts.
        """
        if windows.ndim != 3 or windows.shape[1:] != (WINDOW_SIZE, N_FEATURES):
            raise ValueError(
                f"Expected shape (N, {WINDOW_SIZE}, {N_FEATURES}), got {windows.shape}"
            )
        x = windows.astype(np.float32)
        sess = _get_session(self.model_id)
        rul_norms = sess.run(["rul_norm"], {"features": x})[0]
        rul_norms = np.clip(rul_norms, 0.0, 1.0)
        return [
            {"rul_norm": round(float(r), 6), "rul_cycles": round(float(r) * self.max_cycles, 1)}
            for r in rul_norms
        ]


# ── Sliding-window helper (streaming / IoT use) ───────────────────────────────

class SlidingWindowBuffer:
    """
    Maintains a rolling 30-cycle window.  Append one cycle at a time;
    predict() when buffer is full.
    """

    def __init__(self, model_id: str = "mambarul_fp32", max_cycles: float = 2000.0):
        self._buf      = np.zeros((WINDOW_SIZE, N_FEATURES), dtype=np.float32)
        self._filled   = 0
        self._predictor = ONNXEdgePredictor(model_id=model_id, max_cycles=max_cycles)

    @property
    def ready(self) -> bool:
        return self._filled >= WINDOW_SIZE

    def push(self, features: list[float] | np.ndarray) -> dict[str, float] | None:
        """Push one cycle. Returns prediction if window is full, else None."""
        feat = np.asarray(features, dtype=np.float32)
        if feat.shape != (N_FEATURES,):
            raise ValueError(f"Expected {N_FEATURES} features, got {feat.shape}")
        self._buf = np.roll(self._buf, -1, axis=0)
        self._buf[-1] = feat
        self._filled = min(self._filled + 1, WINDOW_SIZE)
        if self.ready:
            return self._predictor.predict(self._buf)
        return None

    def reset(self):
        self._buf    = np.zeros((WINDOW_SIZE, N_FEATURES), dtype=np.float32)
        self._filled = 0

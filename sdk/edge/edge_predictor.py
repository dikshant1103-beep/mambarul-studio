"""
BatteryOS Edge Predictor SDK
Zero extra dependencies beyond onnxruntime + numpy.

Designed to run on:
  • Raspberry Pi 4 (ARM64, ~30–50 ms/inference)
  • Jetson Nano / Orin (CUDA or CPU)
  • Any Linux x86_64 laptop/server

Quick start
-----------
from edge_predictor import EdgePredictor

predictor = EdgePredictor("mambarul_fp32.onnx")
rul = predictor.predict(window_30x13)          # returns dict
print(rul)  # {"rul_norm": 0.82, "rul_cycles": 1640.0}

Streaming / IoT
---------------
buf = StreamingPredictor("mambarul_int8.onnx")   # smallest + fastest
for cycle_data in sensor_stream():
    result = buf.push(cycle_data)                # None until 30 cycles seen
    if result:
        print(f"Remaining useful life: {result['rul_cycles']:.0f} cycles")
"""
from __future__ import annotations

__version__ = "1.1.0"

import numpy as np

WINDOW_SIZE = 30
N_FEATURES  = 13

# Feature order — must match training pipeline
FEATURE_NAMES = [
    "voltage_mean", "voltage_std",
    "current_mean", "current_std",
    "temperature_mean", "temperature_std",
    "charge_capacity", "discharge_capacity",
    "coulombic_efficiency",
    "capacity_fade_rate", "voltage_degradation",
    "internal_resistance_est", "cycle_normalized",
]


class EdgePredictor:
    """
    Single-call predictor.  Load the ONNX file once, call predict() repeatedly.

    Parameters
    ----------
    model_path : str | Path
        Path to .onnx file (e.g. "mambarul_fp32.onnx" or "mambarul_int8.onnx").
    max_cycles : float
        De-normalisation denominator.  Typical: 2000 (LFP), 500 (NMC).
    providers : list[str]
        ONNX Runtime execution providers.  Default = CPU only.
        On Jetson pass ["CUDAExecutionProvider", "CPUExecutionProvider"].
    """

    def __init__(
        self,
        model_path: str,
        max_cycles: float = 2000.0,
        providers: list[str] | None = None,
    ):
        import onnxruntime as ort   # noqa: PLC0415
        self.max_cycles = max_cycles
        _providers = providers or ["CPUExecutionProvider"]
        self._sess = ort.InferenceSession(str(model_path), providers=_providers)

    def predict(self, window: "np.ndarray | list") -> dict[str, float]:
        """
        Predict RUL from a 30-cycle feature window.

        Parameters
        ----------
        window : array-like, shape (30, 13)

        Returns
        -------
        {"rul_norm": float, "rul_cycles": float}
            rul_norm in [0, 1]; rul_cycles = rul_norm × max_cycles.
        """
        arr = np.asarray(window, dtype=np.float32)
        if arr.shape != (WINDOW_SIZE, N_FEATURES):
            raise ValueError(
                f"Expected shape ({WINDOW_SIZE}, {N_FEATURES}), got {arr.shape}. "
                f"Features: {FEATURE_NAMES}"
            )
        x        = arr[np.newaxis]                                  # (1, 30, 13)
        rul_norm = float(self._sess.run(["rul_norm"], {"features": x})[0][0])
        rul_norm = float(np.clip(rul_norm, 0.0, 1.0))
        return {
            "rul_norm":   round(rul_norm, 6),
            "rul_cycles": round(rul_norm * self.max_cycles, 1),
        }

    def predict_batch(self, windows: "np.ndarray | list") -> list[dict[str, float]]:
        """
        Predict for N windows at once.

        Parameters
        ----------
        windows : array-like, shape (N, 30, 13)

        Returns
        -------
        list of {"rul_norm", "rul_cycles"}
        """
        arr = np.asarray(windows, dtype=np.float32)
        if arr.ndim != 3 or arr.shape[1:] != (WINDOW_SIZE, N_FEATURES):
            raise ValueError(
                f"Expected shape (N, {WINDOW_SIZE}, {N_FEATURES}), got {arr.shape}"
            )
        rul_norms = self._sess.run(["rul_norm"], {"features": arr})[0]   # shape (N,)
        rul_norms = np.clip(rul_norms, 0.0, 1.0)
        return [
            {
                "rul_norm":   round(float(r), 6),
                "rul_cycles": round(float(r) * self.max_cycles, 1),
            }
            for r in rul_norms
        ]

    def benchmark(self, n_runs: int = 100) -> dict[str, float]:
        """Return p50/p95/p99 inference latency on CPU in milliseconds."""
        import time
        dummy = np.random.randn(1, WINDOW_SIZE, N_FEATURES).astype(np.float32)
        for _ in range(5):                          # warm-up
            self._sess.run(["rul_norm"], {"features": dummy})
        times = []
        for _ in range(n_runs):
            t0 = time.perf_counter()
            self._sess.run(["rul_norm"], {"features": dummy})
            times.append((time.perf_counter() - t0) * 1000)
        times_arr = np.array(times)
        return {
            "p50_ms": round(float(np.percentile(times_arr, 50)), 2),
            "p95_ms": round(float(np.percentile(times_arr, 95)), 2),
            "p99_ms": round(float(np.percentile(times_arr, 99)), 2),
            "mean_ms": round(float(times_arr.mean()), 2),
        }


class StreamingPredictor:
    """
    IoT / streaming mode: push one cycle at a time.
    Returns a prediction once the internal 30-cycle buffer is full;
    returns None while buffering.

    Parameters
    ----------
    model_path  : path to .onnx file
    max_cycles  : de-normalisation denominator
    providers   : ONNX Runtime providers
    """

    def __init__(
        self,
        model_path: str,
        max_cycles: float = 2000.0,
        providers: list[str] | None = None,
    ):
        self._predictor = EdgePredictor(model_path, max_cycles, providers)
        self._buf       = np.zeros((WINDOW_SIZE, N_FEATURES), dtype=np.float32)
        self._n         = 0

    @property
    def cycles_buffered(self) -> int:
        return min(self._n, WINDOW_SIZE)

    @property
    def ready(self) -> bool:
        return self._n >= WINDOW_SIZE

    def push(self, cycle_features: "list[float] | np.ndarray") -> dict[str, float] | None:
        """
        Push a single cycle's features.

        Parameters
        ----------
        cycle_features : 13-element list/array

        Returns
        -------
        Prediction dict if buffer is full, else None.
        """
        feat = np.asarray(cycle_features, dtype=np.float32)
        if feat.shape != (N_FEATURES,):
            raise ValueError(
                f"Expected {N_FEATURES} features, got {feat.shape}. "
                f"Order: {FEATURE_NAMES}"
            )
        self._buf = np.roll(self._buf, -1, axis=0)
        self._buf[-1] = feat
        self._n += 1
        return self._predictor.predict(self._buf) if self.ready else None

    def reset(self):
        self._buf = np.zeros((WINDOW_SIZE, N_FEATURES), dtype=np.float32)
        self._n   = 0


# ── CLI convenience ───────────────────────────────────────────────────────────
if __name__ == "__main__":
    import sys, json

    if len(sys.argv) < 2:
        print("Usage: python edge_predictor.py <model.onnx> [--benchmark]")
        sys.exit(1)

    model_path = sys.argv[1]
    do_bench   = "--benchmark" in sys.argv

    predictor = EdgePredictor(model_path)

    if do_bench:
        print("Benchmarking…")
        stats = predictor.benchmark(n_runs=200)
        print(json.dumps(stats, indent=2))
    else:
        # Demo with random data
        window = np.random.rand(WINDOW_SIZE, N_FEATURES).astype(np.float32)
        result = predictor.predict(window)
        print(json.dumps(result, indent=2))

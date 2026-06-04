"""
core/metrics.py — Prometheus metrics.

Exposes /api/metrics in Prometheus text format.
Import setup_metrics(app) in main.py.
"""
from __future__ import annotations
from prometheus_client import (
    Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
)
from fastapi import FastAPI, Response

# ── Counters ──────────────────────────────────────────────────────────────────
prediction_requests = Counter(
    "batteryos_predictions_total",
    "Total RUL prediction requests",
    ["chemistry", "model_id", "phase", "source"],
)

auth_failures = Counter(
    "batteryos_auth_failures_total",
    "Authentication failures",
    ["reason"],
)

errors_total = Counter(
    "batteryos_errors_total",
    "Unhandled exceptions",
    ["endpoint"],
)

# ── Histograms ────────────────────────────────────────────────────────────────
prediction_latency = Histogram(
    "batteryos_prediction_latency_seconds",
    "Prediction endpoint latency",
    ["model_id"],
    buckets=[0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0],
)

# ── Gauges ────────────────────────────────────────────────────────────────────
models_loaded = Gauge(
    "batteryos_models_loaded",
    "Number of PyTorch checkpoints currently loaded",
)

active_finetune_jobs = Gauge(
    "batteryos_finetune_jobs_active",
    "Fine-tune jobs currently running",
)


def record_prediction(chemistry: str, model_id: str, phase: str,
                      source: str = "direct") -> None:
    prediction_requests.labels(
        chemistry=chemistry, model_id=model_id,
        phase=phase, source=source,
    ).inc()


def setup_metrics(app: FastAPI) -> None:
    @app.get("/api/metrics", include_in_schema=False)
    def metrics_endpoint():
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

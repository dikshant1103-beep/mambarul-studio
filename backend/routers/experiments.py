"""
routers/experiments.py — MLflow experiment tracking API.

GET  /api/experiments                        List experiments
GET  /api/experiments/{exp_id}/runs          Runs in an experiment
GET  /api/experiments/runs                   All runs (all experiments)
GET  /api/experiments/runs/{run_id}          Single run detail
GET  /api/experiments/runs/{run_id}/metrics/{key}  Metric history (for charts)
GET  /api/experiments/models                 Registered model versions
GET  /api/experiments/tracking-uri          Current MLflow tracking URI
"""
from __future__ import annotations
from typing import Any

from fastapi import APIRouter, HTTPException

from core.mlflow_tracker import (
    list_experiments, list_runs, get_run,
    get_metric_history, list_registered_models, get_tracking_uri,
)

router = APIRouter()


@router.get("/experiments", summary="List MLflow experiments")
def get_experiments() -> list[dict]:
    return list_experiments()


@router.get("/experiments/runs", summary="All runs across all experiments")
def get_all_runs(limit: int = 100) -> list[dict]:
    return list_runs(limit=min(limit, 500))


@router.get("/experiments/runs/{run_id}", summary="Single run detail")
def get_run_detail(run_id: str) -> dict:
    r = get_run(run_id)
    if not r:
        raise HTTPException(404, f"Run '{run_id}' not found.")
    return r


@router.get("/experiments/runs/{run_id}/metrics/{key}", summary="Metric history for a run")
def get_metric(run_id: str, key: str) -> list[dict]:
    return get_metric_history(run_id, key)


@router.get("/experiments/{exp_id}/runs", summary="Runs for one experiment")
def get_exp_runs(exp_id: str, limit: int = 100) -> list[dict]:
    return list_runs(experiment_id=exp_id, limit=min(limit, 500))


@router.get("/experiments/models", summary="Registered models in MLflow registry")
def get_registered_models() -> list[dict]:
    return list_registered_models()


@router.get("/experiments/tracking-uri", summary="Current MLflow tracking URI")
def tracking_uri() -> dict[str, str]:
    return {"tracking_uri": get_tracking_uri()}

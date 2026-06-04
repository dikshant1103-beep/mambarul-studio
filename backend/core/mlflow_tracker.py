"""
core/mlflow_tracker.py — MLflow experiment tracking for BatteryOS fine-tuning.

Default: file-based store at backend/data/mlruns/ (zero config, no server needed).
Override with env var MLFLOW_TRACKING_URI=http://your-server:5000

Usage in fine-tune workers:
    from core.mlflow_tracker import start_run, log_epoch, finish_run

    run_id = start_run(experiment="MambaRUL-LFP", params={...})
    for epoch in ...:
        log_epoch(run_id, epoch, train_loss=..., lr=...)
    finish_run(run_id, best_loss=..., artifact_path=..., register_as="MambaRUL-LFP")
"""
from __future__ import annotations
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT_URI = str(Path(__file__).parent.parent / "data" / "mlruns")
_client = None      # mlflow.MlflowClient, lazy
_tracking_uri: str = ""


def _get_client():
    global _client, _tracking_uri
    import mlflow
    if _client is None:
        uri = os.environ.get("MLFLOW_TRACKING_URI", _DEFAULT_URI)
        _tracking_uri = uri
        mlflow.set_tracking_uri(uri)
        from mlflow.tracking import MlflowClient
        _client = MlflowClient(tracking_uri=uri)
        logger.info("MLflow tracking URI: %s", uri)
    return _client


def get_tracking_uri() -> str:
    _get_client()
    return _tracking_uri


# ── Run lifecycle ─────────────────────────────────────────────────────────────

def start_run(
    experiment: str,
    run_name:   str,
    params:     dict[str, Any],
    tags:       dict[str, str] | None = None,
) -> str:
    """
    Create and start an MLflow run.
    Returns the run_id string (pass to log_epoch / finish_run).
    """
    try:
        import mlflow
        client = _get_client()

        # Ensure experiment exists
        exp = client.get_experiment_by_name(experiment)
        if exp is None:
            exp_id = client.create_experiment(experiment)
        else:
            exp_id = exp.experiment_id

        run = client.create_run(
            experiment_id=exp_id,
            run_name=run_name,
            tags={k: str(v) for k, v in (tags or {}).items()},
        )
        run_id = run.info.run_id
        for k, v in params.items():
            client.log_param(run_id, str(k), str(v))
        logger.info("MLflow run started: %s (exp=%s)", run_id[:8], experiment)
        return run_id
    except Exception as e:
        logger.warning("MLflow start_run failed (non-fatal): %s", e)
        return ""


def log_epoch(run_id: str, epoch: int, **metrics: float) -> None:
    """Log per-epoch scalar metrics. Silently skips if run_id is empty."""
    if not run_id:
        return
    try:
        client = _get_client()
        for key, val in metrics.items():
            client.log_metric(run_id, key, float(val), step=epoch)
    except Exception as e:
        logger.debug("MLflow log_epoch failed: %s", e)


def finish_run(
    run_id:       str,
    best_loss:    float,
    artifact_path: str | None = None,
    register_as:  str | None = None,
    status:       str = "FINISHED",
) -> None:
    """
    Finish a run: log final metrics, optionally log the .pt artifact,
    optionally register in the Model Registry.
    status: "FINISHED" | "FAILED" | "KILLED"
    """
    if not run_id:
        return
    try:
        import mlflow
        client = _get_client()

        client.log_metric(run_id, "best_loss", best_loss, step=0)

        if artifact_path and Path(artifact_path).exists():
            client.log_artifact(run_id, artifact_path)
            logger.info("MLflow artifact logged: %s", Path(artifact_path).name)

        client.set_terminated(run_id, status=status)

        if register_as and artifact_path and Path(artifact_path).exists():
            _register_model(run_id, artifact_path, register_as)

    except Exception as e:
        logger.warning("MLflow finish_run failed (non-fatal): %s", e)


def _register_model(run_id: str, artifact_path: str, name: str) -> None:
    try:
        import mlflow
        client = _get_client()
        fname  = Path(artifact_path).name
        # model_uri format: runs:/<run_id>/<artifact_filename>
        model_uri = f"runs:/{run_id}/{fname}"
        try:
            client.create_registered_model(name)
        except Exception:
            pass   # already exists
        mv = client.create_model_version(name=name, source=model_uri, run_id=run_id)
        logger.info("MLflow registered model '%s' v%s", name, mv.version)
    except Exception as e:
        logger.warning("MLflow model registration failed (non-fatal): %s", e)


# ── Query helpers (used by the experiments router) ─────────────────────────

def list_experiments() -> list[dict]:
    try:
        client = _get_client()
        exps = client.search_experiments()
        return [
            {
                "experiment_id":   e.experiment_id,
                "name":            e.name,
                "artifact_location": e.artifact_location,
                "lifecycle_stage": e.lifecycle_stage,
                "run_count":       _count_runs(e.experiment_id),
            }
            for e in exps
            if e.lifecycle_stage == "active"
        ]
    except Exception as e:
        logger.warning("MLflow list_experiments failed: %s", e)
        return []


def _count_runs(exp_id: str) -> int:
    try:
        from mlflow.entities import ViewType
        client = _get_client()
        return len(client.search_runs([exp_id], max_results=1000))
    except Exception:
        return 0


def list_runs(experiment_id: str | None = None, limit: int = 200) -> list[dict]:
    try:
        from mlflow.entities import ViewType
        client = _get_client()

        if experiment_id:
            exp_ids = [experiment_id]
        else:
            exp_ids = [e["experiment_id"] for e in list_experiments()]

        if not exp_ids:
            return []

        runs = client.search_runs(
            experiment_ids=exp_ids,
            max_results=limit,
            order_by=["start_time DESC"],
        )
        return [_run_to_dict(r) for r in runs]
    except Exception as e:
        logger.warning("MLflow list_runs failed: %s", e)
        return []


def get_run(run_id: str) -> dict | None:
    try:
        client = _get_client()
        r = client.get_run(run_id)
        return _run_to_dict(r)
    except Exception:
        return None


def get_metric_history(run_id: str, key: str) -> list[dict]:
    try:
        client = _get_client()
        history = client.get_metric_history(run_id, key)
        return [{"step": m.step, "value": m.value, "timestamp": m.timestamp}
                for m in history]
    except Exception:
        return []


def list_registered_models() -> list[dict]:
    try:
        client = _get_client()
        models = client.search_registered_models()
        result = []
        for m in models:
            versions = client.search_model_versions(f"name='{m.name}'")
            result.append({
                "name":          m.name,
                "description":   m.description or "",
                "latest_version": max((int(v.version) for v in versions), default=0),
                "versions": [
                    {
                        "version":   v.version,
                        "status":    v.status,
                        "run_id":    v.run_id,
                        "source":    v.source,
                        "created":   v.creation_timestamp,
                    }
                    for v in sorted(versions, key=lambda x: int(x.version), reverse=True)[:5]
                ],
            })
        return result
    except Exception as e:
        logger.warning("MLflow list_registered_models failed: %s", e)
        return []


def _run_to_dict(r) -> dict:
    return {
        "run_id":      r.info.run_id,
        "run_name":    r.info.run_name or "",
        "experiment_id": r.info.experiment_id,
        "status":      r.info.status,
        "start_time":  r.info.start_time,
        "end_time":    r.info.end_time,
        "duration_s":  round((r.info.end_time - r.info.start_time) / 1000, 1)
                       if r.info.end_time and r.info.start_time else None,
        "params":      dict(r.data.params),
        "metrics":     {k: round(v, 6) for k, v in r.data.metrics.items()},
        "tags":        {k: v for k, v in r.data.tags.items()
                        if not k.startswith("mlflow.")},
    }

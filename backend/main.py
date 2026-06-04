"""
MambaRUL Studio — FastAPI Backend
Entry point: uvicorn main:app --reload --port 8000
"""
import logging
from contextlib import asynccontextmanager
from pathlib import Path

# Load .env FIRST so all os.getenv() calls pick up the values
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env", override=False)
except ImportError:
    pass

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address, default_limits=["200/minute"])

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
)
logger = logging.getLogger("mambaRUL_studio")

BACKEND_DIR         = Path(__file__).parent
STUDIO_DIR          = BACKEND_DIR.parent
PROJECT_ROOT        = STUDIO_DIR.parent
THESIS_FIGURES      = PROJECT_ROOT / "thesis_results" / "figures"
CONFERENCE_FIGURES  = PROJECT_ROOT / "conference_final_percell" / "figures"
import os as _os
_frontend_dist_env = _os.getenv("FRONTEND_DIST")
FRONTEND_DIST = (
    Path(_frontend_dist_env) if _frontend_dist_env
    else (
        STUDIO_DIR / "frontend_customer" / "dist"
        if _os.getenv("BATTERYOS_VARIANT") == "customer"
        else STUDIO_DIR / "frontend" / "dist"
    )
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── SQLite schema + migration ──────────────────────────────────────────
    from core.db import init_db
    init_db()

    # ── Sentry from DB (if not already set by env var) ───────────────────
    if not cfg.sentry_dsn:
        from core.db import get_settings as _gs
        _dsn = _gs().get("sentry_dsn", "")
        if _dsn:
            _init_sentry(_dsn)

    # ── Daily backup scheduler ────────────────────────────────────────────
    from core.backup import start_backup_scheduler
    start_backup_scheduler(interval_hours=24)

    # ── Dataset ───────────────────────────────────────────────────────────
    from core.data_loader import load_dataset
    try:
        load_dataset()
    except Exception as exc:
        logger.warning("Dataset load failed (%s). Falling back to mock data.", exc)

    # ── Model checkpoints (download from HF Hub if missing) ───────────────
    from core.checkpoint_manager import ensure_checkpoints
    try:
        ensure_checkpoints()
    except Exception as exc:
        logger.warning("Checkpoint download failed: %s", exc)

    # ── PyTorch models ────────────────────────────────────────────────────
    from core.model_loader import load_all_models, get_loaded_models
    try:
        load_all_models()
        loaded = [m["id"] for m in get_loaded_models() if m["loaded"]]
        logger.info("Models loaded: %s", loaded)
        from core.metrics import models_loaded
        models_loaded.set(len(loaded))
    except Exception as exc:
        logger.warning("Model loading failed (%s). Using analytical fallback.", exc)

    # ── Kafka command consumer (best-effort, no-op if Kafka unavailable) ─────
    def _handle_command(msg: dict) -> None:
        logger.info("Kafka command received: %s", msg)

    from core.kafka_client import start_command_consumer
    start_command_consumer(_handle_command)

    # ── Kafka streaming feature-extraction processor ───────────────────────
    try:
        from core.streaming_processor import start as _sp_start
        _sp_start()
    except Exception as exc:
        logger.warning("Streaming processor start failed: %s", exc)

    # ── Layer 4: pre-load EWC on-disk adapters ────────────────────────────
    try:
        from core.ewc_trainer import load_all_disk_adapters
        load_all_disk_adapters()
    except Exception as exc:
        logger.warning("EWC adapter preload failed: %s", exc)

    yield

    from core.kafka_client import close as kafka_close
    kafka_close()
    logger.info("MambaRUL Studio shutting down.")


# ── Sentry (best-effort, env var takes priority; falls back to DB) ────────────
def _init_sentry(dsn: str) -> None:
    if not dsn:
        return
    try:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration
        sentry_sdk.init(
            dsn=dsn,
            integrations=[StarletteIntegration(), FastApiIntegration()],
            traces_sample_rate=0.1,
            profiles_sample_rate=0.1,
        )
        logger.info("Sentry error tracking enabled.")
    except Exception as exc:
        logger.warning("Sentry init failed: %s", exc)

try:
    from core.config import cfg
    _sentry_dsn = cfg.sentry_dsn
    if not _sentry_dsn:
        # Try DB (settings_kv) — loaded after init_db() in lifespan, so skip here
        pass
    _init_sentry(_sentry_dsn)
except Exception:
    pass

from core.config import cfg

app = FastAPI(
    title="MambaRUL Studio API",
    description="Scientific battery RUL prediction platform.",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cfg.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Rate limiting ─────────────────────────────────────────────────────────────
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# ── Prometheus metrics ────────────────────────────────────────────────────────
from core.metrics import setup_metrics
setup_metrics(app)

# ── Static thesis figures ─────────────────────────────────────────────────────
if THESIS_FIGURES.exists():
    app.mount("/static/thesis_figures",
              StaticFiles(directory=str(THESIS_FIGURES)), name="thesis_figures")
if CONFERENCE_FIGURES.exists():
    app.mount("/static/conference_figures",
              StaticFiles(directory=str(CONFERENCE_FIGURES)), name="conference_figures")

# ── Health endpoint ───────────────────────────────────────────────────────────
@app.get("/api/health", tags=["Root"])
def health():
    from core.data_loader import is_loaded, get_row_count
    from core.model_loader import get_loaded_models
    loaded = [m["id"] for m in get_loaded_models() if m["loaded"]]
    return {"status": "ok", "data_loaded": is_loaded(), "rows": get_row_count(),
            "models_loaded": loaded, "n_models": len(loaded)}


@app.get("/api/platform/status", tags=["Root"])
def platform_status():
    """
    Full platform capability snapshot — used by the dashboard.
    Returns model engine, ONNX edge, MLflow, MATR, and recent fine-tune jobs.
    """
    from core.data_loader import is_loaded, get_row_count
    from core.model_loader import get_loaded_models
    from core.onnx_exporter import list_models as list_onnx
    from core.mlflow_tracker import list_experiments, list_runs
    from core.db import list_finetune_jobs

    # Models
    loaded_models = [m for m in get_loaded_models() if m["loaded"]]

    # ONNX (guard: _onnx_dir().mkdir() crashes on read-only squashfs in AppImage)
    try:
        onnx_models = list_onnx()
    except Exception:
        onnx_models = []

    # MLflow
    try:
        exps   = list_experiments()
        runs   = list_runs(limit=5)
        mlflow_total_runs = sum(e.get("run_count", 0) for e in exps)
    except Exception:
        exps, runs, mlflow_total_runs = [], [], 0

    # Fine-tune jobs (recent 5)
    try:
        all_jobs = list_finetune_jobs()
        recent_jobs = sorted(all_jobs, key=lambda j: j.get("created_at", ""), reverse=True)[:5]
        jobs_summary = {
            "total":     len(all_jobs),
            "completed": sum(1 for j in all_jobs if j["status"] == "completed"),
            "running":   sum(1 for j in all_jobs if j["status"] in ("queued", "running")),
            "recent":    [
                {
                    "job_id":   j["id"][:8],
                    "chemistry": j.get("chemistry", "?"),
                    "status":    j["status"],
                    "progress":  j.get("progress", 0),
                    "created_at": j.get("created_at", ""),
                    "output_path": j.get("output_path", ""),
                }
                for j in recent_jobs
            ],
        }
    except Exception:
        jobs_summary = {"total": 0, "completed": 0, "running": 0, "recent": []}

    # MATR dataset
    try:
        from core.matr_loader import get_matr_info
        matr = get_matr_info()
        matr_status = {
            "available": True,
            "n_cells":   matr["n_cells"],
            "chemistry": matr["chemistry"],
            "splits":    matr["splits"],
        }
    except Exception:
        matr_status = {"available": False}

    return {
        "status":        "ok",
        "data_loaded":   is_loaded(),
        "data_rows":     get_row_count(),
        "model_engine": {
            "n_loaded":  len(loaded_models),
            "models":    [{"id": m["id"], "loaded": m["loaded"]} for m in loaded_models],
        },
        "onnx_edge": {
            "n_models":  len(onnx_models),
            "models":    [{"id": m["id"], "precision": m["precision"], "size_kb": m["size_kb"]} for m in onnx_models],
            "ready":     len(onnx_models) > 0,
        },
        "mlflow": {
            "n_experiments": len(exps),
            "n_runs":        mlflow_total_runs,
            "recent_runs":   [
                {
                    "run_id":  r["run_id"][:8],
                    "name":    r["run_name"],
                    "status":  r["status"],
                    "metrics": r["metrics"],
                    "params":  {k: r["params"].get(k,"") for k in ["chemistry","dataset","epochs"]},
                }
                for r in runs
            ],
        },
        "matr":     matr_status,
        "finetune": jobs_summary,
    }


# ── Version endpoint (used by customer app for auto-update check) ─────────────
APP_VERSION = "1.0.0"

@app.get("/api/version", tags=["Root"])
def get_version():
    return {"version": APP_VERSION}


# ── Backup endpoints ──────────────────────────────────────────────────────────
from typing import Optional
from fastapi import Header as _FHeader, Depends
from core.middleware import require_auth as _require_auth, require_admin as _require_admin


@app.post("/api/admin/backup/now", tags=["Admin"], dependencies=[Depends(_require_admin)])
def trigger_backup():
    from core.backup import backup_now as do_backup
    return do_backup()


@app.get("/api/admin/backup/list", tags=["Admin"], dependencies=[Depends(_require_admin)])
def list_backups_endpoint():
    from core.backup import list_backups
    return list_backups()

# ── Import all routers ────────────────────────────────────────────────────────
from routers import (
    datasets, features, figures, models, predict, results,
    cell_features, science, science2, deep_analysis, insights,
    activation, roadmap, advanced, ingest, keys, batch, calibrate,
    results2,
)
from routers import settings as settings_router
from routers import auth as auth_router
from routers import analytics as analytics_router
from routers import finetune as finetune_router
from routers import fleet as fleet_router
from routers import customer_mgmt as customer_mgmt_router
from routers import license_mgmt as license_mgmt_router
from routers import bms_telemetry as bms_telemetry_router
from routers import bms_control as bms_control_router
from routers import bms_topology as bms_topology_router
from routers import can_ingest as can_ingest_router
from routers import modbus_adapter as modbus_adapter_router
from routers import edge as edge_router
from routers import matr as matr_router
from routers import experiments as experiments_router
from routers import second_life as second_life_router
from routers import grading as grading_router
from routers import anomaly as anomaly_router
from routers import dqdv as dqdv_router
from routers import digital_twin as digital_twin_router
from routers import drift as drift_router
from routers import pack_intelligence as pack_intelligence_router
from routers import thermal as thermal_router
from routers import thermal_twin as thermal_twin_router
from routers import online_rul as online_rul_router
from routers import pack_gnn as pack_gnn_router
from routers import weak_cell as weak_cell_router
from routers import warranty as warranty_router
from routers import demo as demo_router
from routers import report as report_router
from routers import notifications as notifications_router
from routers import lims as lims_router
from routers import phase_c as phase_c_router

# Dependency lists
_auth  = [Depends(_require_auth)]
_admin = [Depends(_require_admin)]

# Public — no auth (login, register, OTP flows)
app.include_router(auth_router.router, prefix="/api", tags=["Auth"])

# Member routes — any authenticated user (session or API key)
for router, prefix, tags in [
    (datasets.router,      "/api", ["Datasets"]),
    (results.router,       "/api", ["Results"]),
    (results2.router,      "/api", ["Results2"]),
    (features.router,      "/api", ["Features"]),
    (models.router,        "/api", ["Models"]),
    (predict.router,       "/api", ["Predict"]),
    (figures.router,       "/api", ["Figures"]),
    (cell_features.router, "/api", ["Cell Features"]),
    (science.router,       "/api", ["Science"]),
    (science2.router,      "/api", ["Science2"]),
    (deep_analysis.router, "/api", ["Deep Analysis"]),
    (insights.router,      "/api", ["Insights"]),
    (activation.router,    "/api", ["Activations"]),
    (roadmap.router,       "/api", ["Roadmap"]),
    (advanced.router,      "/api", ["Advanced"]),
    (ingest.router,        "/api", ["Ingest"]),
    (keys.router,          "/api", ["API Keys"]),
    (batch.router,         "/api", ["Batch"]),
    (calibrate.router,     "/api", ["Calibrate"]),
    (analytics_router.router,  "/api", ["Analytics"]),
    (fleet_router.router,      "/api", ["Fleet"]),
    (online_rul_router.router, "/api", ["Online RUL"]),
    (pack_gnn_router.router,   "/api", ["Pack GNN"]),
]:
    app.include_router(router, prefix=prefix, tags=tags, dependencies=_auth)

# Admin-only routes — role=admin required
for router, prefix, tags in [
    (settings_router.router,      "/api", ["Settings"]),
    (finetune_router.router,      "/api", ["Fine-Tune"]),
    (customer_mgmt_router.router, "/api", ["Customer Mgmt"]),
]:
    app.include_router(router, prefix=prefix, tags=tags, dependencies=_admin)

# License router — status+activate are public (called pre-auth by LicenseGate);
# /admin/licenses* endpoints enforce admin internally via _require_admin()
app.include_router(license_mgmt_router.router, prefix="/api", tags=["License"])

# BMS routers — any authenticated user
app.include_router(bms_telemetry_router.router,  prefix="/api", tags=["BMS Telemetry"],  dependencies=_auth)
app.include_router(bms_control_router.router,    prefix="/api", tags=["BMS Control"],    dependencies=_auth)
app.include_router(bms_topology_router.router,   prefix="/api", tags=["BMS Topology"],   dependencies=_auth)
app.include_router(can_ingest_router.router,     prefix="/api", tags=["BMS Adapters"],   dependencies=_auth)
app.include_router(modbus_adapter_router.router, prefix="/api", tags=["BMS Modbus"],     dependencies=_auth)
app.include_router(edge_router.router,           prefix="/api", tags=["Edge Inference"],  dependencies=_auth)
app.include_router(matr_router.router,           prefix="/api", tags=["MATR Dataset"],    dependencies=_auth)
app.include_router(experiments_router.router,    prefix="/api", tags=["Experiments"],     dependencies=_auth)
app.include_router(second_life_router.router,    prefix="/api", tags=["Second Life"],     dependencies=_auth)
app.include_router(grading_router.router,        prefix="/api", tags=["Battery Grading"], dependencies=_auth)
app.include_router(anomaly_router.router,        prefix="/api", tags=["Anomaly"],          dependencies=_auth)
app.include_router(dqdv_router.router,           prefix="/api", tags=["dQdV ICA"],          dependencies=_auth)
app.include_router(digital_twin_router.router,   prefix="/api", tags=["Digital Twin"],      dependencies=_auth)
app.include_router(drift_router.router,          prefix="/api", tags=["Drift Monitor"],      dependencies=_auth)
app.include_router(pack_intelligence_router.router, prefix="/api", tags=["Pack Intelligence"], dependencies=_auth)
app.include_router(thermal_router.router,           prefix="/api", tags=["Thermal Analysis"],  dependencies=_auth)
app.include_router(thermal_twin_router.router,      prefix="/api", tags=["Thermal Twin"],       dependencies=_auth)
app.include_router(weak_cell_router.router,         prefix="/api", tags=["Weak Cell Analysis"], dependencies=_auth)
app.include_router(warranty_router.router,          prefix="/api", tags=["Warranty Intelligence"], dependencies=_auth)
app.include_router(report_router.router,            prefix="/api", tags=["Reports"],             dependencies=_auth)
app.include_router(demo_router.router,              prefix="/api", tags=["Demo"],                dependencies=_auth)
app.include_router(notifications_router.router,     prefix="/api", tags=["Notifications"],       dependencies=_auth)
app.include_router(lims_router.router,              prefix="/api", tags=["LIMS Import"],         dependencies=_auth)
app.include_router(phase_c_router.router,            prefix="/api", tags=["Phase C Research"],   dependencies=_auth)

# ── Serve React SPA (must come LAST) ─────────────────────────────────────────
if FRONTEND_DIST.exists():
    app.mount("/assets",
              StaticFiles(directory=str(FRONTEND_DIST / "assets")), name="react_assets")

    @app.get("/", include_in_schema=False)
    def serve_index():
        return FileResponse(str(FRONTEND_DIST / "index.html"))

    @app.api_route("/{full_path:path}", methods=["GET"], include_in_schema=False)
    def serve_spa(request: Request, full_path: str):
        if full_path.startswith("api/") or full_path.startswith("static/"):
            return JSONResponse({"detail": f"Not found: /{full_path}"}, status_code=404)
        static_file = FRONTEND_DIST / full_path
        if static_file.exists() and static_file.is_file():
            return FileResponse(str(static_file))
        return FileResponse(str(FRONTEND_DIST / "index.html"))

    logger.info("Serving React frontend from %s", FRONTEND_DIST)
else:
    @app.get("/", tags=["Root"])
    def root():
        return {"service": "MambaRUL Studio API", "version": "1.0.0",
                "frontend": "not built — run npm run build in frontend/"}

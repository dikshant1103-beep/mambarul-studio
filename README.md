# MambaRUL Studio · BatteryOS

![Python](https://img.shields.io/badge/Python-3.11-blue)
![PyTorch](https://img.shields.io/badge/PyTorch-2.x-red)
![FastAPI](https://img.shields.io/badge/FastAPI-green)
![React](https://img.shields.io/badge/React-18-lightblue)
![Electron](https://img.shields.io/badge/Electron-AppImage-9cf)

**A battery-intelligence platform: scientific RUL/SoH prediction with a Mamba state-space model, a physics digital twin, pack-level GNN intelligence, and a full BMS telemetry stack — shipped as a FastAPI backend with two Electron desktop apps.**

> For a one-page technical due-diligence sheet — including the honest caveats — read
> [`ARCHITECTURE.md`](./ARCHITECTURE.md). The thermal-twin deep dive (ET AutoTech
> Hackathon 2026 entry) lives in [`docs/THERMAL_TWIN_HACKATHON.md`](./docs/THERMAL_TWIN_HACKATHON.md).

---

## What it does

| Capability | How |
|---|---|
| **RUL / SoH prediction** | BiMamba-APF v12 (1.7M params): bidirectional Mamba SSM + chemistry embedding + physics gate, MC-dropout uncertainty, per-chemistry normalization (NMC / LFP / NCA / LCO / NMC-4680) |
| **Uncertainty you can act on** | Conformal prediction intervals on every prediction; out-of-distribution guard falls back to a physics-based analytical estimate, transparently tagged |
| **Internal core temperature** | DeepONet neural-operator thermal twin reconstructs the radial field T(r,t) from standard BMS signals (RMSE 1.24 °C) — no embedded sensors |
| **Pack-level intelligence** | Pack-GNN (GraphSAGE) applies per-cell pack-context aging corrections; trainable on liionpack simulation data |
| **Physics digital twin** | PyBaMM SPM+SEI parameter fit with holdout validation |
| **BMS stack** | MQTT / CAN / Modbus ingestion, safety envelopes, alert history, IEC 62619 PDF reporting (simulator-fed until hardware is connected — labeled in the UI) |
| **Warranty economics** | Claim-probability → dollar-reserve estimation per fleet |
| **MLOps** | MLflow experiment tracking, ONNX export (FP32 + INT8), drift monitoring, online learning (EWC), model registry with safe analytical fallback |
| **Streaming** | Kafka consumer + tumbling-window aggregation; optional Flink job in `deploy/flink/` |

## Two desktop apps, one backend

- **MambaRUL Studio** (`frontend/`) — research/admin edition: model management, experiments, fleet analytics, thermal field visualization, Phase C internal-state inference.
- **BatteryOS** (`frontend_customer/`) — operator edition: SOH monitoring, RUL countdowns, degradation heatmaps, second-life grading, alerts.

Both build into self-contained Linux AppImages (Electron + the FastAPI backend).

## Quickstart

```bash
# Backend (Python 3.11)
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cd .. && bash start_backend.sh          # http://localhost:8000  (docs at /api/docs)

# Studio frontend (dev)
bash start_frontend.sh                  # Vite dev server + Electron

# Or the full stack with Docker (Postgres/TimescaleDB, Kafka, Grafana, Prometheus)
docker compose up
```

First login uses the local demo admin (see the app's login screen); all secrets —
JWT, admin password, SMTP — are environment-driven with obvious `CHANGE-ME`
defaults, and the backend refuses production mode with defaults in place.

## Python SDK

Zero-dependency client in [`sdk/`](./sdk) ([README](./sdk/README.md)):

```python
from batteryos_sdk import BatteryOSClient
client = BatteryOSClient(base_url="http://localhost:8000", api_key="bos_...")
r = client.predict(cap_pct=0.85, chemistry="NMC", temperature=25.0)
print(r["rul_cycles"], r["ci_low"], r["ci_high"])
```

## Deployment

- `docker-compose.yml` — dev stack; `docker-compose.prod.yml` + `nginx.prod.conf` / `nginx_https.conf` — hardened prod compose.
- [`deploy/helm/batteryos`](./deploy/helm/batteryos) — Kubernetes Helm chart (secrets injected out-of-band via `kubectl create secret`, never in values).
- `deploy/flink/` — streaming aggregation job.
- `grafana/` + `prometheus.yml` — dashboards and scrape config.

## Project structure

```
backend/            FastAPI app — core/ (models, physics, streaming, MLOps), routers/, tests/
frontend/           MambaRUL Studio (React + Vite + TS + Electron)
frontend_customer/  BatteryOS operator app
sdk/                Python SDK (zero-dependency)
deploy/             Helm chart + Flink job
grafana/            Dashboards; prometheus.yml scrape config
scripts/            Training / data-prep utilities
ARCHITECTURE.md     One-page technical evaluator sheet (honest caveats included)
docs/               Thermal-twin hackathon deep dive
```

Small trained artifacts ship in-repo so the app runs out of the box:
`backend/data/thermal/deeponet_thermal.pt` (221 KB), `backend/data/onnx_models/`
(3.4 MB FP32 / 1.3 MB INT8). Large checkpoints, databases, and training data are
excluded by `.gitignore`.

## Test posture

~89 backend tests (inference, endpoints, concurrency/load, warranty, streaming, LIMS)
plus frontend unit tests (vitest); Playwright e2e scaffolded in `frontend/e2e/`.

## Honest scope

This is a working research platform, not a certified BMS product. The edges are
documented plainly in [`ARCHITECTURE.md`](./ARCHITECTURE.md) — single-snapshot
history synthesis (tagged `history_source`), simulator-fed BMS demos, SQLite
default persistence, and the OOD analytical guard.

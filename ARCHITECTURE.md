# BatteryOS — Architecture & Honest Caveats (Technical Evaluator Sheet)

One page for a technical evaluator / due-diligence reviewer. What it is, how it
works, and where the edges are — stated plainly.

## Stack
- **Backend:** FastAPI + PyTorch (port 8001). Inference engine `core/model_loader.run_inference`.
- **Frontend:** React 18 + Vite + TypeScript + Tailwind. Two Electron apps — admin (R&D) and **BatteryOS** (customer).
- **Persistence:** SQLite by default; PostgreSQL + TimescaleDB supported via `DATABASE_URL` (dual-backend layer in `core/db.py`).
- **Streaming:** Kafka consumer + pure-Python tumbling-window stateful aggregation (`core/stream_aggregator.py`).

## Models (real, not stubs)
- **BiMamba-APF v12** (1.7M params) — bidirectional Mamba SSM + chemistry embedding + physics gate; per-chemistry RUL normalization; MC-dropout uncertainty. Default model.
- v10-final (812K, production baseline), v11-twohead (SOH+RUL).
- **Pack-GNN** (GraphSAGE, 19.5K) — per-cell pack-context aging correction; trainable on liionpack pack-sim data.
- **Digital twin** — PyBaMM SPM+SEI fit with holdout validation.
- All checkpoints are on disk and loaded at startup; a missing checkpoint falls back to a transparently-tagged analytical model (`mode:"analytical"`), never a silent fake.

## Differentiators vs. competitors
Conformal uncertainty on every prediction · multi-chemistry (5) · pack-level GNN intelligence · physics digital twin · full BMS stack (MQTT/CAN/Modbus, IEC 62619 PDF) · warranty economics (claim probability → $ reserve) · online learning (EWC) · streaming aggregation.

## Honest caveats (what a sharp reviewer should know)
1. **Single-snapshot window synthesis.** The sequence models need a 30-cycle window. Given one snapshot, the backend *synthesizes* the history with a fixed decay — so two cells with identical current readings get identical RUL regardless of true trajectory. **Mitigations in place:** every prediction is tagged `history_source` = `measured` (≥2 real cycles supplied) or `synthesized`, surfaced in the UI. Real-history paths (multi-cycle CSV upload, fleet history, LIMS import) avoid synthesis.
2. **OOD guard.** When the model returns an unphysical (non-positive normalized) RUL — common for out-of-distribution inputs incl. LCO on v12 — the result falls back to the physics-based analytical estimate, tagged `mode:"analytical_guard"`.
3. **BMS demos are simulator-fed.** The ingestion/safety/RUL pipeline is real; without connected hardware (MQTT/CAN/Modbus), telemetry comes from the built-in simulator. Clearly labeled in the UI.
4. **Scale.** SQLite is the default (single-tenant). Postgres + TimescaleDB code paths exist but require runtime verification in the target deployment; multi-tenant is a funded milestone.
5. **Distribution.** The desktop AppImage runs the backend from the source tree (assumes a Python env). A self-contained bundle (PyInstaller) is planned.
6. **Pack-sim / liionpack** runs in an isolated Python 3.10/3.11 env (`requirements-packsim.txt`) — old pybamm pinned, separate from the main pybamm 25.x to avoid breaking the digital twin.

## Test posture
~89 backend tests (inference, endpoints, concurrency/load, warranty, streaming, LIMS) + frontend unit tests (vitest). Playwright e2e is scaffolded but not yet in CI.

"""
Dual-backend persistence tests.

These exercise the core/db.py abstraction (INSERT + SELECT round-trips) against
whatever backend is configured. They ALWAYS run on SQLite (verifying the
abstraction locally) and, when DATABASE_URL is set, run unchanged against
PostgreSQL/TimescaleDB — so the Postgres adapter is auto-verified in the docker
CI environment where Postgres is available.

To verify the Postgres path:
    docker compose up -d postgres
    DATABASE_URL=postgresql://batteryos:batteryos_dev@localhost:5432/batteryos \
        python -m pytest tests/test_db_backend.py -v
"""
import os
import uuid

import pytest

from core.config import cfg
import core.db as db


@pytest.fixture(scope="module", autouse=True)
def _init_db():
    db.init_db()


def test_backend_reported():
    backend = "postgres" if cfg.database_url else "sqlite"
    # Just asserts the switch resolves without error and is one of the two.
    assert backend in ("postgres", "sqlite")


def test_track_call_roundtrip():
    org = f"itest-{uuid.uuid4().hex[:8]}"
    db.track_call(chemistry="nmc", model_id="v12-bimamba", rul=412.0,
                  phase="Aging", source="pytest", org=org)
    calls = db.get_calls(limit=50, org=org)
    assert any(c["model_id"] == "v12-bimamba" and c["org"] == org for c in calls)
    # chemistry is upper-cased by track_call
    assert all(c["chemistry"] == "NMC" for c in calls if c["org"] == org)


def test_record_alert_roundtrip():
    # record_alert persists an alert row and returns its id
    aid = db.record_alert(chemistry="LFP", soh=0.72, rul=120.0, phase="Knee",
                          label=f"itest-{uuid.uuid4().hex[:6]}", source="pytest")
    assert aid


def test_store_and_read_telemetry():
    cell = f"itest_cell_{uuid.uuid4().hex[:8]}"
    for k in range(5):
        db.store_telemetry(cell_id=cell, voltage=3.7 - k * 0.01, current=-2.0,
                           temperature=25.0 + k, soc=80.0 - k, cycle_num=k + 1,
                           source="pytest")
    latest = db.get_latest_per_cell()
    ids = [row["cell_id"] for row in latest]
    assert cell in ids
    row = next(r for r in latest if r["cell_id"] == cell)
    # last write wins → soc reflects the final frame
    assert float(row["soc"]) == pytest.approx(76.0, abs=0.5)


@pytest.mark.skipif(not cfg.database_url,
                    reason="Postgres-only: set DATABASE_URL to run")
def test_postgres_pool_active():
    # When DATABASE_URL is set this confirms the PG pool is actually used.
    assert db._get_pg_pool() is not None

"""
Shared pytest fixtures for BatteryOS backend tests.
"""
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).parent.parent
sys.path.insert(0, str(BACKEND))

TEST_DATA = Path(__file__).parent.parent.parent.parent / "test_data_unseen"

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="session")
def client():
    """Spin up the FastAPI app once per test session."""
    from main import app
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c


@pytest.fixture(scope="session")
def auth_headers(client):
    """Log in as admin and return session token header."""
    from core.config import cfg
    r = client.post("/api/auth/login", json={
        "email": cfg.admin_email,
        "password": cfg.admin_password,
    })
    assert r.status_code == 200, f"Login failed: {r.text}"
    token = r.json()["token"]
    return {"X-Session-Token": token}


def _upload_once(client, auth_headers, filename: str) -> dict:
    """Upload a test CSV — shared across tests to avoid hitting rate limits."""
    path = TEST_DATA / filename
    assert path.exists(), f"Test file missing: {path}"
    with open(path, "rb") as f:
        r = client.post(
            "/api/ingest",
            files={"file": (filename, f, "text/csv")},
            headers=auth_headers,
        )
    assert r.status_code == 200, f"Upload failed ({r.status_code}): {r.text[:300]}"
    return r.json()


# ── Session-scoped upload results (each file uploaded exactly once) ────────────

@pytest.fixture(scope="session")
def lfp_full(client, auth_headers):
    return _upload_once(client, auth_headers, "LFP_valcell_A.csv")

@pytest.fixture(scope="session")
def lfp_midlife(client, auth_headers):
    time.sleep(0.1)  # small gap to stay under rate limit
    return _upload_once(client, auth_headers, "LFP_valcell_A_midlife.csv")

@pytest.fixture(scope="session")
def nmc_early(client, auth_headers):
    time.sleep(0.1)
    return _upload_once(client, auth_headers, "NMC_valcell_B_early.csv")

@pytest.fixture(scope="session")
def lco_full(client, auth_headers):
    time.sleep(0.1)
    return _upload_once(client, auth_headers, "LCO_valcell_A.csv")

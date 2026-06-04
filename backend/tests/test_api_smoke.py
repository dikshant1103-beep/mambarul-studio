"""
API smoke tests — hit every major endpoint, validate response shape.
"""
import pytest


# ── Health / Status ──────────────────────────────────────────────────────────

def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    d = r.json()
    assert d["status"] == "ok"
    assert "models_loaded" in d


def test_version(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    assert "version" in r.json()


def test_platform_status(client, auth_headers):
    r = client.get("/api/platform/status", headers=auth_headers)
    assert r.status_code == 200
    d = r.json()
    assert "model_engine" in d
    assert "onnx_edge" in d


# ── Auth ─────────────────────────────────────────────────────────────────────

def test_login_invalid_credentials(client):
    r = client.post("/api/auth/login", json={"email": "bad@bad.com", "password": "wrong"})
    assert r.status_code in (401, 403, 422)


def test_protected_requires_auth(client):
    """Calling /api/predict without auth must be rejected."""
    r = client.post("/api/predict", json={
        "chemistry": "LFP", "soh": 0.85, "model_id": "v10-final"
    })
    assert r.status_code in (401, 403)


# ── Predict ──────────────────────────────────────────────────────────────────

def test_predict_lfp(client, auth_headers):
    r = client.post("/api/predict", headers=auth_headers, json={
        "chemistry": "LFP", "soh": 0.85, "model_id": "v10-final",
        "capacity_ah": 1.1, "temperature_c": 25.0,
    })
    assert r.status_code == 200
    d = r.json()
    assert "predicted_rul" in d
    assert d["predicted_rul"] >= 0


def test_predict_nmc(client, auth_headers):
    r = client.post("/api/predict", headers=auth_headers, json={
        "chemistry": "NMC", "soh": 0.80, "model_id": "v10-final",
        "capacity_ah": 2.5, "temperature_c": 30.0,
    })
    assert r.status_code == 200
    assert r.json()["predicted_rul"] >= 0


def test_predict_available_models(client, auth_headers):
    r = client.get("/api/predict/available-models", headers=auth_headers)
    assert r.status_code == 200
    models = r.json()
    assert isinstance(models, list)
    ids = [m["id"] for m in models]
    assert "v10-final" in ids


# ── Pack predict ──────────────────────────────────────────────────────────────

def test_pack_predict(client, auth_headers):
    cells = [
        {"cell_id": f"c{i}", "chemistry": "LFP", "soh": round(0.9 - i * 0.02, 2),
         "capacity_ah": 1.1, "temperature_c": 25.0}
        for i in range(4)
    ]
    r = client.post("/api/predict/pack", headers=auth_headers, json={
        "cells": cells, "topology": "series", "model_id": "v10-final",
    })
    assert r.status_code == 200
    d = r.json()
    assert "pack_rul" in d or "predicted_rul" in d


# ── Online RUL ────────────────────────────────────────────────────────────────

def test_online_rul_unknown_cell(client, auth_headers):
    """Unknown cell should 404 or return empty history gracefully."""
    r = client.get("/api/rul/trend/nonexistent_cell_xyz", headers=auth_headers)
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert "history" in r.json()


def test_online_rul_ci(client, auth_headers):
    r = client.get("/api/rul/ci", headers=auth_headers)
    assert r.status_code == 200


# ── Fleet ─────────────────────────────────────────────────────────────────────

def test_fleet_labels(client, auth_headers):
    r = client.get("/api/fleet/labels", headers=auth_headers)
    assert r.status_code == 200
    assert isinstance(r.json(), dict)


# ── Ingest edge cases ─────────────────────────────────────────────────────────

def test_ingest_empty_file(client, auth_headers):
    r = client.post(
        "/api/ingest",
        files={"file": ("empty.csv", b"", "text/csv")},
        headers=auth_headers,
    )
    assert r.status_code in (422, 400)


def test_ingest_no_required_columns(client, auth_headers):
    csv = b"col_a,col_b\n1,2\n3,4\n"
    r = client.post(
        "/api/ingest",
        files={"file": ("bad.csv", csv, "text/csv")},
        headers=auth_headers,
    )
    assert r.status_code in (422, 400)


def test_ingest_minimal_csv(client, auth_headers):
    """A CSV with only cycle + capacity columns should succeed."""
    lines = ["cycle,capacity"]
    for i in range(35):
        lines.append(f"{i+1},{1.1 - i * 0.002:.4f}")
    csv_bytes = "\n".join(lines).encode()
    r = client.post(
        "/api/ingest",
        files={"file": ("minimal.csv", csv_bytes, "text/csv")},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["summary"]["n_cycles"] == 35



def test_ingest_zero_capacity(client, auth_headers):
    """All-zero capacity must not crash — should fallback gracefully."""
    lines = ["cycle,capacity"]
    for i in range(40):
        lines.append(f"{i+1},0.0")
    csv_bytes = "\n".join(lines).encode()
    r = client.post(
        "/api/ingest",
        files={"file": ("zeros.csv", csv_bytes, "text/csv")},
        headers=auth_headers,
    )
    assert r.status_code == 200
    for p in r.json()["predictions"]:
        assert p["predicted_rul"] >= 0


# ── Chemistry detection endpoint ──────────────────────────────────────────────

def test_detect_chemistry_lfp(client, auth_headers):
    r = client.post("/api/detect-chemistry", headers=auth_headers, json={
        "voltage_mean": [3.25, 3.26, 3.27] * 10,
        "capacity": [1.1, 1.09, 1.08] * 10,
    })
    assert r.status_code == 200
    d = r.json()
    assert "chemistry" in d
    assert d["chemistry"] == "LFP"

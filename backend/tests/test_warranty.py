"""
Tests for warranty intelligence (core/warranty.py + /api/warranty endpoints).
"""
from core.warranty import assess_warranty, assess_fleet


def test_healthy_cell_is_safe():
    r = assess_warranty(soh=0.92, predicted_rul=900, n_cycles=200,
                        warranty_cycles=1000, warranty_years=8, cycles_per_year=250,
                        rul_lower=800, rul_upper=1000)
    assert r["status"] == "safe"
    assert r["p_claim"] < 0.10
    assert r["margin_cycles"] > 0


def test_weak_cell_likely_claim():
    r = assess_warranty(soh=0.80, predicted_rul=150, n_cycles=700,
                        warranty_cycles=1500, warranty_years=8, cycles_per_year=250,
                        rul_lower=100, rul_upper=220)
    assert r["status"] == "likely_claim"
    assert r["p_claim"] > 0.4
    assert r["expected_claim_cost"] > 0
    assert r["margin_cycles"] < 0


def test_p_claim_monotone_in_rul():
    """Lower RUL must never reduce claim probability."""
    base = dict(soh=0.85, n_cycles=400, warranty_cycles=1000, warranty_years=8,
                cycles_per_year=250)
    hi = assess_warranty(predicted_rul=800, **base)["p_claim"]
    lo = assess_warranty(predicted_rul=200, **base)["p_claim"]
    assert lo >= hi


def test_fleet_reserve_aggregation():
    f = assess_fleet(
        [{"cell_id": "c0", "soh": 0.92, "predicted_rul": 900, "n_cycles": 200},
         {"cell_id": "c1", "soh": 0.80, "predicted_rul": 150, "n_cycles": 700}],
        warranty_cycles=1000, warranty_years=8, cycles_per_year=250, unit_cost=120,
    )
    assert f["n_cells"] == 2
    assert f["total_exposure"] == 240.0
    assert 0 <= f["reserve_recommended"] <= f["total_exposure"]
    assert f["n_at_risk"] >= 1


def test_warranty_assess_endpoint(client, auth_headers):
    r = client.post("/api/warranty/assess", headers=auth_headers, json={
        "cell": {"cell_id": "w1", "soh": 0.85, "chemistry": "NMC", "n_cycles": 500,
                 "int_resistance": 0.04, "predicted_rul": 300, "rul_lower": 200, "rul_upper": 400},
        "terms": {"warranty_cycles": 1000, "warranty_years": 8, "cycles_per_year": 250, "unit_cost": 150},
        "auto_predict": False,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["status"] in ("safe", "at_risk", "likely_claim")
    assert "expected_claim_cost" in d and "p_claim" in d


def test_warranty_fleet_endpoint_auto_predict(client, auth_headers):
    r = client.post("/api/warranty/assess/fleet", headers=auth_headers, json={
        "cells": [
            {"cell_id": "a", "soh": 0.91, "chemistry": "NMC", "n_cycles": 200, "int_resistance": 0.03},
            {"cell_id": "b", "soh": 0.78, "chemistry": "NMC", "n_cycles": 800, "int_resistance": 0.06},
        ],
        "terms": {"warranty_cycles": 1000, "warranty_years": 8, "cycles_per_year": 250},
        "auto_predict": True, "model_id": "v10-final",
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["n_cells"] == 2
    assert "reserve_recommended" in d
    assert d["rul_source"] == "ml"

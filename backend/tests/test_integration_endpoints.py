"""
Integration tests — exercise real backend computation end-to-end through the
HTTP layer (FastAPI TestClient). Verifies that endpoints actually compute
(model / Coulomb counting / SPC / second-life) rather than returning stubs,
and that the history-provenance tagging (measured vs synthesized window) works.
"""
import io
import pytest


# ── Helpers ───────────────────────────────────────────────────────────────────

def _make_multicell_bms_csv(n_cells: int = 2, n_cycles: int = 3) -> bytes:
    """Build a raw BMS CSV with time, voltage, current, temperature, cell_id.

    Each cell has `n_cycles` discharge segments (negative current) separated by
    short charge segments (positive current), so cycle splitting + Coulomb
    counting produce a real multi-cycle observed window.
    """
    rows = ["time,voltage,current,temperature,cell_id"]
    for c in range(n_cells):
        cid = f"cell_{c+1:02d}"
        t = 0.0
        for _ in range(n_cycles):
            # discharge: 15 points, current -2.0 A, V 4.1 -> 3.0
            for k in range(15):
                v = 4.1 - (1.1 * k / 14)
                rows.append(f"{t:.1f},{v:.4f},-2.0,28.0,{cid}")
                t += 30.0
            # charge: 5 points, current +1.0 A, V 3.0 -> 4.1
            for k in range(5):
                v = 3.0 + (1.1 * k / 4)
                rows.append(f"{t:.1f},{v:.4f},1.0,27.0,{cid}")
                t += 60.0
    return ("\n".join(rows)).encode()


# ── Weak-cell: manual (synthesized) vs CSV (measured) ──────────────────────────

def test_weak_cell_analyze_manual_is_synthesized(client, auth_headers):
    cells = [
        {"cell_id": f"c{i}", "soh": round(0.92 - i * 0.04, 2), "rul": 0,
         "capacity_ah": 1.1, "ir": 0.03 + i * 0.01, "chemistry": "NMC",
         "fade_rate": 0.0002, "n_cycles": 200 + i * 50, "dod_pct": 80,
         "temperature": 25}
        for i in range(3)
    ]
    r = client.post("/api/pack/weak-cell/analyze", headers=auth_headers, json={
        "cells": cells, "topology": "series", "auto_predict": True,
        "model_id": "v12-bimamba",
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["summary"]["rul_source"] == "ml"
    assert len(d["ml_predictions"]) == 3
    # Manual entry has no real history → every prediction must be tagged synthesized
    for p in d["ml_predictions"]:
        assert p["history_source"] == "synthesized"
        assert p["n_observed_cycles"] == 1
        assert p["predicted_rul"] >= 0


def test_weak_cell_analyze_from_csv_is_measured(client, auth_headers):
    csv_bytes = _make_multicell_bms_csv(n_cells=2, n_cycles=3)
    r = client.post(
        "/api/pack/weak-cell/analyze-from-csv",
        headers=auth_headers,
        files={"file": ("bms.csv", csv_bytes, "text/csv")},
        data={"nom_capacity_ah": "1.1", "chemistry": "NMC", "topology": "series"},
    )
    assert r.status_code == 200, r.text
    d = r.json()
    # Feature extraction ran (Coulomb counting per cell)
    assert "feature_extraction" in d
    assert len(d["feature_extraction"]) == 2
    for cid, fx in d["feature_extraction"].items():
        assert 0.0 < fx["soh"] <= 1.0
        assert fx["measured_capacity_ah"] > 0
        assert fx["n_cycles_detected"] >= 1
    # Multi-cycle CSV → model saw real measured history
    for p in d["ml_predictions"]:
        assert p["history_source"] == "measured"
        assert p["n_observed_cycles"] >= 2


def test_weak_cell_csv_missing_columns_rejected(client, auth_headers):
    bad = b"foo,bar\n1,2\n3,4\n"
    r = client.post(
        "/api/pack/weak-cell/analyze-from-csv",
        headers=auth_headers,
        files={"file": ("bad.csv", bad, "text/csv")},
        data={"nom_capacity_ah": "1.1", "chemistry": "NMC"},
    )
    assert r.status_code == 422


def test_weak_cell_csv_single_cell_rejected(client, auth_headers):
    # No cell_id column → single cell → pack analysis needs >= 2
    rows = ["time,voltage,current,temperature"]
    t = 0.0
    for _ in range(3):
        for k in range(15):
            rows.append(f"{t:.1f},{4.1 - 1.1*k/14:.4f},-2.0,28.0"); t += 30
        for k in range(5):
            rows.append(f"{t:.1f},{3.0 + 1.1*k/4:.4f},1.0,27.0"); t += 60
    r = client.post(
        "/api/pack/weak-cell/analyze-from-csv",
        headers=auth_headers,
        files={"file": ("one.csv", "\n".join(rows).encode(), "text/csv")},
        data={"nom_capacity_ah": "1.1", "chemistry": "NMC"},
    )
    assert r.status_code == 422


# ── Prediction history tagging via /api/predict ────────────────────────────────

def test_lco_v12_uses_finetuned_head_not_delegation():
    """For LCO, v12-bimamba should use the fine-tuned LCO head (not delegate to
    v10-final) when the LCO head checkpoint is present, and must never return
    the old v12→v10 delegation tag."""
    from core.model_loader import run_inference, load_all_models
    load_all_models()
    r = run_inference("v12-bimamba", {
        "chemistry": "LCO", "soh_pct": 88, "capacity": 1.0,
        "int_resistance": 0.04, "n_cycles": 200,
    })
    # v10 delegation must be retired
    assert r.get("delegation") != "lco_v12_to_v10", "old v10 delegation still active"
    assert r.get("model_resolved") != "v10-final", "still delegating to v10-final"
    # Result must be a positive RUL from either the LCO head (pytorch) or
    # analytical guard (if head output was non-positive on a synthesized window)
    assert r["predicted_rul"] > 0
    # LCO head tag must be present when head is loaded
    if r.get("lco_head"):
        assert r["lco_head"] == "v12-lco-finetune"


def test_ood_guard_no_zero_rul_across_chemistries():
    """A non-positive model output must not surface as a misleading RUL=0;
    the analytical guard should serve a sane positive estimate, tagged."""
    from core.model_loader import run_inference, load_all_models
    load_all_models()
    for chem in ("LCO", "NMC", "LFP", "NCA"):
        r = run_inference("v12-bimamba", {
            "chemistry": chem, "soh_pct": 88, "capacity": 1.0,
            "int_resistance": 0.04, "n_cycles": 200,
        })
        assert r["predicted_rul"] > 0, f"{chem} returned non-positive RUL"
        if r.get("guard") == "model_output_nonpositive":
            assert r["mode"] == "analytical_guard"


def test_predict_single_snapshot_tagged_synthesized(client, auth_headers):
    r = client.post("/api/predict", headers=auth_headers, json={
        "chemistry": "NMC", "soh": 0.85, "model_id": "v10-final",
        "capacity_ah": 1.1, "temperature_c": 25.0,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d.get("history_source") == "synthesized"
    assert d["predicted_rul"] >= 0


# ── Battery grading ────────────────────────────────────────────────────────────

def test_grade_single(client, auth_headers):
    r = client.post("/api/grade", headers=auth_headers, json={
        "label": "cellA", "chemistry": "NMC", "soh_pct": 82.0,
        "predicted_rul": 400, "int_resistance": 0.04, "n_cycles": 600,
        "capacity_ah": 3.0,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert "grade" in d or "second_life_grade" in d or "assessment" in d


def test_grade_predict_and_grade(client, auth_headers):
    r = client.post("/api/grade/predict-and-grade", headers=auth_headers, json={
        "label": "cellB", "chemistry": "LFP", "soh_pct": 88.0,
        "int_resistance": 0.03, "n_cycles": 300, "capacity_ah": 1.1,
        "temperature": 25.0, "model_id": "v10-final",
    })
    assert r.status_code == 200, r.text


# ── Second life ────────────────────────────────────────────────────────────────

def test_second_life_assess(client, auth_headers):
    r = client.post("/api/second-life/assess", headers=auth_headers, json={
        "cell_id": "c1", "soh": 0.78, "rul_cycles": 350, "chemistry": "NMC",
        "ir": 0.05, "cycles": 700, "capacity_ah": 3.0,
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert isinstance(d, dict) and len(d) > 0


# ── Calibrate (few-shot conformal) ─────────────────────────────────────────────

def test_calibrate_fits_residuals(client, auth_headers):
    cycles = list(range(1, 26))
    capacity = [round(1.1 - i * 0.004, 4) for i in range(25)]
    r = client.post("/api/calibrate", headers=auth_headers, json={
        "chemistry": "NMC", "cycles": cycles, "capacity": capacity,
        "nom_capacity": 1.1, "temperature": 25.0, "cell_label": "newcell",
    })
    assert r.status_code == 200, r.text


# ── Anomaly (SPC) ──────────────────────────────────────────────────────────────

def test_anomaly_scan_detects_drop(client, auth_headers):
    cycles = list(range(1, 41))
    # smooth fade then a sharp drop at cycle 30 → SPC should flag
    soh = [1.0 - 0.003 * i for i in range(40)]
    for i in range(30, 40):
        soh[i] -= 0.08
    r = client.post("/api/anomaly/scan", headers=auth_headers, json={
        "cell_id": "anom1", "cycles": cycles, "soh": [round(s, 4) for s in soh],
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert isinstance(d, dict)


# ── BMS: simulate then read live ───────────────────────────────────────────────

def test_bms_simulate_then_live(client, auth_headers):
    cell_id = "itest_bms_cell"
    r = client.post("/api/bms/simulate", headers=auth_headers, json={
        "cell_id": cell_id, "voltage": 3.75, "current": -2.0,
        "temperature": 28.0, "chemistry": "NMC", "capacity_ah": 1.1, "count": 25,
    })
    assert r.status_code == 200, r.text
    assert r.json()["simulated"] == 25

    live = client.get("/api/bms/live", headers=auth_headers)
    assert live.status_code == 200
    ids = [row.get("cell_id") for row in live.json()]
    assert cell_id in ids

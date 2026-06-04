"""
Tests for the demo fleet seeder and the executive / safety PDF reports.
"""


def test_demo_seed_populates_fleet(client, auth_headers):
    r = client.post("/api/demo/seed", headers=auth_headers, json={"n_cells": 8, "model_id": "v10-final"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["seeded"] is True
    assert d["n_cells"] == 8
    assert d["n_predictions"] == 8
    assert d["n_alerts"] >= 0
    # seeded cells must now show up in the live fleet
    live = client.get("/api/bms/live", headers=auth_headers).json()
    ids = {row.get("cell_id") for row in live}
    assert any(cid.startswith("DEMO_") for cid in ids)


def test_executive_report_is_valid_pdf(client, auth_headers):
    client.post("/api/demo/seed", headers=auth_headers, json={"n_cells": 6})
    r = client.get("/api/report/executive.pdf", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content[:4] == b"%PDF"
    assert len(r.content) > 1000


def test_safety_report_is_valid_pdf(client, auth_headers):
    """The IEC 62619 safety PDF (called by BMSValidation) must render, not 500."""
    r = client.get("/api/bms/safety/report.pdf", headers=auth_headers)
    assert r.status_code == 200, r.text
    assert r.content[:4] == b"%PDF"

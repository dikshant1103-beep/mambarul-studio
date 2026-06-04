"""
Tests for the Phase C internal-state foundation:
- core/internal_states.extract_internal_states (twin → structured vector)
- core/db cell_internal_states persistence helpers
- GET /api/twin/internal-states (list endpoint)
"""
import uuid


def _synthetic_twin() -> dict:
    """A digital-twin-shaped dict that mimics what build_twin() returns."""
    return {
        "chemistry": "LFP",
        "fit": {
            "params": {"Q0": 1.1, "alpha": 0.55, "k_sei": 0.008, "k_crack": 1.5e-4},
            "param_ci": {},
            "degradation_split": {"sei_pct": 62.0, "crack_pct": 38.0},
            "r2":   0.987,
            "mape": 1.8,
            "eol_cycle": 1450,
        },
        "observed": {
            "cycles":      list(range(1, 401)),
            "ir":          [0.030 + i * 0.00004 for i in range(400)],
            "temperature": [25.0 + (i % 50) * 0.05 for i in range(400)],
        },
    }


def test_extract_returns_structured_vector():
    from core.internal_states import extract_internal_states, INTERNAL_STATE_KEYS
    s = extract_internal_states(_synthetic_twin())
    # every advertised key must be present
    for k in INTERNAL_STATE_KEYS:
        assert k in s, f"missing key {k}"
    # twin parameters propagate
    assert s["k_sei"] == 0.008
    assert s["alpha"] == 0.55
    # derived observables are physically sensible
    assert s["sei_thickness_nm"] > 0
    assert 0.0 <= s["lli_fraction"] <= 1.0
    assert 0.0 <= s["lam_fraction"] <= 1.0
    assert abs(s["lli_fraction"] + s["lam_fraction"] - 1.0) < 0.05
    assert s["ir_growth_pct"] > 0
    assert s["cycles_to_eol"] == 1450
    assert s["fit_r2"] == 0.987


def test_extract_handles_error_twin():
    from core.internal_states import extract_internal_states
    assert "error" in extract_internal_states({"error": "no cell"})


def test_db_roundtrip_internal_states():
    from core.db import init_db, store_internal_states, get_internal_states, list_internal_states
    init_db()
    cid = f"itest_cell_{uuid.uuid4().hex[:8]}"
    vec = {"k_sei": 0.0042, "sei_thickness_nm": 18.7, "lli_fraction": 0.58, "fit_r2": 0.96}
    ts = store_internal_states(cid, vec, chemistry="NMC", source="twin")
    assert ts
    g = get_internal_states(cid)
    assert g is not None
    assert g["cell_id"] == cid
    assert g["chemistry"] == "NMC"
    assert g["states"]["sei_thickness_nm"] == 18.7
    # the cell appears in the list
    rows = list_internal_states(limit=500)
    assert any(r["cell_id"] == cid for r in rows)


def test_list_internal_states_endpoint(client, auth_headers):
    r = client.get("/api/twin/internal-states", headers=auth_headers)
    assert r.status_code == 200
    d = r.json()
    assert "n" in d and "rows" in d

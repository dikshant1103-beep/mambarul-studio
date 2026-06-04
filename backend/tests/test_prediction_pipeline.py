"""
Regression tests for the windowed inference pipeline.
Each file is uploaded exactly once (session-scoped fixture) to avoid rate limits.
"""
import pytest


# ── Structural / field tests ──────────────────────────────────────────────────

@pytest.mark.parametrize("fixture_name", [
    "lfp_full", "lfp_midlife", "nmc_early", "lco_full",
])
def test_response_structure(request, fixture_name):
    """Every upload must return summary + predictions with required fields."""
    data = request.getfixturevalue(fixture_name)
    assert "summary" in data
    assert "predictions" in data
    s = data["summary"]
    for field in ("n_cycles", "chemistry", "predicted_rul",
                  "lower_90", "upper_90", "phase", "alert",
                  "prediction_engine", "model_cycles_pct"):
        assert field in s, f"Missing summary field: {field}"
    preds = data["predictions"]
    assert len(preds) > 0
    for p in preds[:5]:
        for field in ("cycle", "predicted_rul", "lower_90", "upper_90",
                      "soh_pct", "source"):
            assert field in p, f"Missing prediction field: {field}"


@pytest.mark.parametrize("fixture_name", [
    "lfp_full", "lfp_midlife", "nmc_early", "lco_full",
])
def test_no_nan_or_negative_rul(request, fixture_name):
    """predicted_rul must be finite and non-negative for every cycle."""
    data = request.getfixturevalue(fixture_name)
    for p in data["predictions"]:
        rul = p["predicted_rul"]
        assert rul >= 0.0, f"Negative RUL at cycle {p['cycle']}: {rul}"
        assert rul == rul, f"NaN RUL at cycle {p['cycle']}"


@pytest.mark.parametrize("fixture_name", [
    "lfp_full", "lfp_midlife", "nmc_early", "lco_full",
])
def test_ci_bands_valid(request, fixture_name):
    """lower_90 <= predicted_rul <= upper_90 for every cycle."""
    data = request.getfixturevalue(fixture_name)
    for p in data["predictions"]:
        assert p["lower_90"] <= p["predicted_rul"] + 0.1, (
            f"lower_90 > predicted_rul at cycle {p['cycle']}: "
            f"{p['lower_90']} > {p['predicted_rul']}"
        )
        assert p["predicted_rul"] <= p["upper_90"] + 0.1, (
            f"predicted_rul > upper_90 at cycle {p['cycle']}: "
            f"{p['predicted_rul']} > {p['upper_90']}"
        )


# ── Model usage tests ─────────────────────────────────────────────────────────

def test_lfp_uses_model(lfp_full):
    """Long LFP cell (1934 cycles) should have >=50% model predictions."""
    s = lfp_full["summary"]
    assert s["n_cycles"] >= 100
    assert s["model_cycles_pct"] >= 50.0, (
        f"LFP only {s['model_cycles_pct']}% model — expected >=50%"
    )
    assert s["prediction_engine"] in ("model", "blend")


def test_nmc_uses_model(nmc_early):
    """NMC early-life cell should have >=50% model predictions."""
    s = nmc_early["summary"]
    assert s["model_cycles_pct"] >= 50.0, (
        f"NMC only {s['model_cycles_pct']}% model — expected >=50%"
    )


def test_source_field_values(lfp_full):
    """source field must be one of the expected values."""
    valid = {"model", "blend", "analytical"}
    for p in lfp_full["predictions"]:
        assert p["source"] in valid, f"Invalid source '{p['source']}' at cycle {p['cycle']}"


# ── Monotonicity ──────────────────────────────────────────────────────────────

def test_rul_monotone_direction(lfp_full):
    """For full-life LFP, RUL at cycle 1 must exceed RUL at last cycle."""
    preds = lfp_full["predictions"]
    rul_first = preds[0]["predicted_rul"]
    rul_last  = preds[-1]["predicted_rul"]
    assert rul_first > rul_last, (
        f"RUL not decreasing: first={rul_first}, last={rul_last}"
    )


# ── Chemistry detection ───────────────────────────────────────────────────────

def test_lfp_chemistry_detected(lfp_full):
    assert lfp_full["summary"]["chemistry"] == "LFP"


def test_lco_chemistry_detected(lco_full):
    assert lco_full["summary"]["chemistry"] == "LCO"


# ── Cold-start / edge cases (these don't use pre-uploaded fixtures) ───────────

def test_ingest_short_csv_cold_start(client, auth_headers):
    """A 20-cycle CSV must return all analytical fallback, not crash."""
    lines = ["cycle,capacity"]
    for i in range(20):
        lines.append(f"{i+1},{1.1 - i * 0.003:.4f}")
    csv_bytes = "\n".join(lines).encode()
    r = client.post(
        "/api/ingest",
        files={"file": ("short.csv", csv_bytes, "text/csv")},
        headers=auth_headers,
    )
    assert r.status_code == 200
    s = r.json()["summary"]
    assert s["n_cycles"] == 20
    assert s["prediction_engine"] == "analytical"
    assert s["model_cycles_pct"] == 0.0

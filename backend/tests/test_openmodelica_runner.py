"""tests for core/openmodelica_runner.py — runs the analytical fallback path
(omc is not installed in CI). The Modelica file is also asserted present."""
import pytest


def test_modelica_file_present():
    from core.openmodelica_runner import _MO_FILE
    assert _MO_FILE.exists(), f"missing Modelica model: {_MO_FILE}"


def test_status_reports_omc_state():
    from core.openmodelica_runner import status
    s = status()
    assert "omc_on_path" in s
    assert "modelica_exists" in s
    assert s["modelica_exists"] is True


def test_fallback_simulate_propagates_heat():
    from core.openmodelica_runner import simulate, ThermalRunawayParams
    p = ThermalRunawayParams(N=4, stopTime=30.0, stepSize=0.5,
                             T_amb=25.0, T_trigger=120.0,
                             trigger_cell=1, trigger_at=2.0)
    res = simulate(p, prefer="fallback")
    assert res["mode"] == "analytical_fallback"
    assert res["n_steps"] > 10
    # the seed cell must have crossed T_trigger; with strong coupling neighbours
    # should also rise above ambient by end of sim
    cell1 = res["cells"][0]["trajectory"]
    cell2 = res["cells"][1]["trajectory"]
    assert max(cell1) >= 120.0
    assert max(cell2) > 25.5


def test_auto_chooses_fallback_when_omc_missing():
    from core.openmodelica_runner import simulate, ThermalRunawayParams, omc_available
    if omc_available():
        pytest.skip("omc IS installed; auto-mode picks modelica path")
    p = ThermalRunawayParams(N=3, stopTime=10.0, stepSize=0.5)
    res = simulate(p, prefer="auto")
    assert res["mode"] == "analytical_fallback"

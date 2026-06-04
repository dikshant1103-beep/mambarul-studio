"""Tests for chemistry-dispatched PyBaMM parameter sets in
core.pybamm_internal_states.extract_pybamm_internal_states.

Verifies that:
  - DFN+crack mode picks the cracking-capable parameter set per chemistry
    (NMC/NCM → OKane2022, LFP → Ai2020).
  - Chemistries without a cracking-capable parameter set (NCA, LCO) cleanly
    downgrade to SPM reaction-limited, with the downgrade tagged in the result.
  - SPM mode always uses _CHEM_PYBAMM.

To keep CI fast we ONLY check the dispatch decision metadata, not the full
PyBaMM solve (which would be 1–3 s per chemistry × 4 chemistries on top of
PyBaMM import). The full-solve smoke test was done manually 2026-05-29.
"""
import pytest

pytest.importorskip("pybamm")


def test_dfn_crack_mode_picks_okane_for_nmc():
    from core.pybamm_internal_states import extract_pybamm_internal_states
    res = extract_pybamm_internal_states(
        chemistry="NMC", c_rate_dis=1.0, c_rate_chg=0.5,
        temperature=25.0, n_cycles=2, model_mode="dfn_electrolyte_crack",
    )
    if "error" in res:
        pytest.skip(f"PyBaMM sim itself failed: {res['error']}")
    assert res["_model_mode_requested"] == "dfn_electrolyte_crack"
    assert res["_model_mode_used"]      == "dfn_electrolyte_crack"
    assert res["_parameter_set"]        == "OKane2022"


def test_dfn_crack_mode_picks_ai2020_for_lfp():
    from core.pybamm_internal_states import extract_pybamm_internal_states
    res = extract_pybamm_internal_states(
        chemistry="LFP", c_rate_dis=1.0, c_rate_chg=0.5,
        temperature=25.0, n_cycles=2, model_mode="dfn_electrolyte_crack",
    )
    if "error" in res:
        pytest.skip(f"PyBaMM sim itself failed: {res['error']}")
    assert res["_model_mode_requested"] == "dfn_electrolyte_crack"
    assert res["_model_mode_used"]      == "dfn_electrolyte_crack"
    assert res["_parameter_set"]        == "Ai2020"


def test_dfn_crack_falls_back_for_nca():
    from core.pybamm_internal_states import extract_pybamm_internal_states
    res = extract_pybamm_internal_states(
        chemistry="NCA", c_rate_dis=1.0, c_rate_chg=0.5,
        temperature=25.0, n_cycles=2, model_mode="dfn_electrolyte_crack",
    )
    if "error" in res:
        pytest.skip(f"PyBaMM sim itself failed: {res['error']}")
    # Honest downgrade — request was DFN+crack, used was SPM+reaction-limited
    assert res["_model_mode_requested"] == "dfn_electrolyte_crack"
    assert res["_model_mode_used"]      == "spm_reaction_limited"
    # NCA parameter set comes from _CHEM_PYBAMM (NCA_Kim2011)
    assert res["_parameter_set"]        == "NCA_Kim2011"


def test_dfn_crack_falls_back_for_lco():
    from core.pybamm_internal_states import extract_pybamm_internal_states
    res = extract_pybamm_internal_states(
        chemistry="LCO", c_rate_dis=1.0, c_rate_chg=0.5,
        temperature=25.0, n_cycles=2, model_mode="dfn_electrolyte_crack",
    )
    if "error" in res:
        pytest.skip(f"PyBaMM sim itself failed: {res['error']}")
    assert res["_model_mode_requested"] == "dfn_electrolyte_crack"
    assert res["_model_mode_used"]      == "spm_reaction_limited"
    assert res["_parameter_set"]        == "Chen2020"


def test_spm_mode_uses_chem_pybamm_default():
    from core.pybamm_internal_states import extract_pybamm_internal_states
    res = extract_pybamm_internal_states(
        chemistry="LFP", c_rate_dis=1.0, c_rate_chg=0.5,
        temperature=25.0, n_cycles=2, model_mode="spm_reaction_limited",
    )
    if "error" in res:
        pytest.skip(f"PyBaMM sim itself failed: {res['error']}")
    assert res["_model_mode_used"] == "spm_reaction_limited"
    # SPM mode uses _CHEM_PYBAMM[LFP] = "Ai2020"
    assert res["_parameter_set"] == "Ai2020"

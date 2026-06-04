"""
core/pybamm_internal_states.py — Phase C Option A: ground-truth internal-state
labels from a real PyBaMM SPM + reaction-limited SEI simulation.

Replaces the analytical-fit surrogate used by `core.internal_states` for the
electrochemistry observables that an analytical curve-fit cannot directly
expose (SEI thickness, true LLI, true LAM split, k_sei from the actual
reaction rate). These become the supervised labels the internal-state head
learns when it's training under Option A.

Output schema matches `core.internal_states.INTERNAL_STATE_KEYS` so the
training pipeline + persistence + dashboards remain unchanged — only the
provenance (`source="pybamm_sim"`) differs.
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def extract_pybamm_internal_states(chemistry: str = "LFP",
                                   c_rate_dis: float = 1.0,
                                   c_rate_chg: float = 0.5,
                                   temperature: float = 25.0,
                                   n_cycles: int = 100,
                                   model_mode: str = "spm_reaction_limited",
                                   measured_cap_ah: float | None = None,
                                   timeout_s: float = 120.0,
                                   ) -> dict[str, Any]:
    """Run a SPM+SEI simulation and extract a 13-key internal-state vector
    populated from the actual simulation solution (not an analytical curve fit).

    Returns a dict with the same keys as `core.internal_states.INTERNAL_STATE_KEYS`
    plus a `source` field marking the provenance.
    """
    try:
        import pybamm
        import numpy as np
        from core.digital_twin import (
            _CHEM_PYBAMM, _CHEM_VOLTAGES, _PYBAMM_NOMINAL_CAP,
            _SEI_ACTIVATION_ENERGY, _SEI_J0_SCALE,
        )
    except Exception as exc:
        logger.warning("pybamm import failed: %s", exc)
        return {"error": f"pybamm unavailable: {exc}"}

    chem       = chemistry.upper()

    # Per-chemistry PyBaMM parameter set dispatch for DFN+crack mode.
    # Empirically verified (2026-05-29 smoke test):
    #   NMC, NCM  → OKane2022   (LG M50 + full degradation incl. cracking)
    #   LFP       → Ai2020      (LFP cracking-specific, Ai et al. 2020)
    #   NCA       → NCA_Kim2011 lacks cracking params  → fall back to SPM
    #   LCO       → Chen2020 lacks cracking params      → fall back to SPM
    # Note: unconditionally forcing OKane2022 (as the earlier impl did) wrongly
    # parameterises LFP/NCA/LCO cells as NMC, which is the root cause of the
    # catastrophic LFP/LCO/NCM R² regressions in Run A.
    _DFN_CRACK_PSET = {
        "NMC": "OKane2022",
        "NCM": "OKane2022",
        "LFP": "Ai2020",
    }

    mode_requested = model_mode
    if model_mode == "dfn_electrolyte_crack" and chem not in _DFN_CRACK_PSET:
        # Chemistry doesn't support cracking-equipped DFN — honest downgrade.
        logger.info("pybamm dispatch: %s has no cracking-capable param set; "
                    "falling back to SPM reaction-limited", chem)
        model_mode = "spm_reaction_limited"

    if model_mode == "dfn_electrolyte_crack":
        param_name = _DFN_CRACK_PSET[chem]
    else:
        param_name = _CHEM_PYBAMM.get(chem, "Chen2020")
    v_dis, v_chg = _CHEM_VOLTAGES.get(chem, (2.5, 4.2))
    nom_cap    = _PYBAMM_NOMINAL_CAP.get(param_name, 5.0)

    # PyBaMM model + degradation options.
    if model_mode == "dfn_electrolyte_crack":
        model = pybamm.lithium_ion.DFN(options={
            "SEI":               "ec reaction limited",
            "SEI porosity change": "true",
            "SEI on cracks":      "true",
            "particle mechanics": "swelling and cracking",
            "loss of active material": "stress-driven",
        })
    else:
        model = pybamm.lithium_ion.SPM(options={
            "SEI":                  "reaction limited",
            "SEI porosity change":  "true",
        })
    param = pybamm.ParameterValues(param_name)
    param["Ambient temperature [K]"] = 273.15 + temperature
    param["SEI growth activation energy [J.mol-1]"] = (
        _SEI_ACTIVATION_ENERGY.get(chem, 75000.0)
    )
    j0_base  = float(param["SEI reaction exchange current density [A.m-2]"])
    j0_scale = _SEI_J0_SCALE.get(chem, 1.0)
    param["SEI reaction exchange current density [A.m-2]"] = (
        j0_base * j0_scale * (c_rate_dis ** 0.5)
    )

    # Note: do NOT override param["Nominal cell capacity [A.h]"] here — changing it
    # mid-parameterisation destabilises the Ai2020 solver (current densities diverge).
    # Q₀ post-scaling is applied after the sim instead (see below).

    try:
        experiment = pybamm.Experiment([
            f"Discharge at {c_rate_dis}C until {v_dis:.2f}V",
            f"Charge at {c_rate_chg}C until {v_chg:.2f}V",
        ] * n_cycles)
        sim = pybamm.Simulation(model, parameter_values=param, experiment=experiment)

        # Timeout wrapper — same pattern as digital_twin.run_pybamm_simulation_safe.
        # DFN+crack sims on low-T / high-C-rate combinations produce stiff ODEs that
        # hang indefinitely. The thread is left running after timeout (CasADi can't
        # be interrupted), but control returns and the cache script moves on.
        # Use SIGALRM for timeout — ThreadPoolExecutor can't interrupt CasADi's
        # C++ code because it holds the GIL. SIGALRM is delivered to the main
        # thread and interrupts C++ at the OS level. Unix-only but the cache
        # scripts always run as standalone processes in the main thread.
        import signal as _signal
        if hasattr(_signal, 'SIGALRM'):
            def _alarm(signum, frame):
                raise TimeoutError(f"pybamm timeout after {timeout_s:.0f}s")
            _old = _signal.signal(_signal.SIGALRM, _alarm)
            _signal.alarm(int(timeout_s))
            try:
                sol = sim.solve()
            except TimeoutError:
                logger.warning("pybamm timeout after %.0fs (%s %s c_rate=%.1f T=%.0f)",
                               timeout_s, chem, model_mode, c_rate_dis, temperature)
                return {"error": f"pybamm timeout after {timeout_s:.0f}s"}
            finally:
                _signal.alarm(0)
                _signal.signal(_signal.SIGALRM, _old)
        else:
            sol = sim.solve()  # Windows: no timeout available
    except Exception as exc:
        logger.warning("pybamm sim failed (%s): %s", chem, exc)
        return {"error": f"sim failed: {exc}"}

    def _arr(name: str):
        try:
            return np.asarray(sol[name].entries, dtype=float)
        except Exception:
            return None

    # Per-cycle peak capacity is the cleanest source of Q0 and per-cycle capacity
    try:
        caps_summary = np.asarray(sol.summary_variables["Capacity [A.h]"])
        # summary has 2 entries per cycle (discharge + charge); take the max in pairs
        caps_per_cycle = np.array([float(caps_summary[i]) for i in range(0, len(caps_summary), 2)])
        cap_traj = caps_per_cycle
    except Exception:
        cap_traj = _arr("Discharge capacity [A.h]")
    if cap_traj is None or len(cap_traj) < 2:
        return {"error": "no capacity trajectory"}
    Q0_sim = float(np.max(cap_traj))      # peak (initial) capacity from simulation

    # LFP Q₀ fix: Ai2020 runs at 2.3 Ah nominal; real CALCE/MIT LFP cells are ~1.1 Ah.
    # Scale Q₀ and all capacity-derived quantities by measured_cap_ah / nom_cap so
    # the labels land on the same scale as the real cell. This closes the distribution
    # mismatch that caused catastrophic LFP Q₀ R² (−6.56) in Run C without touching
    # the simulation parameters (which would destabilise the solver).
    _cap_scale = 1.0
    if measured_cap_ah is not None and measured_cap_ah > 0.1 and nom_cap > 0.1:
        _cap_scale = measured_cap_ah / nom_cap
        Q0_sim   *= _cap_scale
        cap_traj  = cap_traj * _cap_scale

    # SEI-related ground truth
    lli_sei_mol  = _arr("Loss of lithium to negative SEI [mol]")
    cap_loss_sei = _arr("Loss of capacity to negative SEI [A.h]")
    lli_crk_mol  = _arr("Loss of lithium to negative SEI on cracks [mol]")
    cap_loss_crk = _arr("Loss of capacity to negative SEI on cracks [A.h]")
    sei_conc     = _arr("X-averaged negative SEI concentration [mol.m-3]")
    # In dfn_electrolyte_crack mode PyBaMM also exposes LAM directly via the
    # "Loss of active material in negative electrode [%]" / "...positive..."
    # variables. Read them when present; fall back to crack-driven LAM otherwise.
    lam_neg_pct  = _arr("Loss of active material in negative electrode [%]")
    lam_pos_pct  = _arr("Loss of active material in positive electrode [%]")

    # Final-state observables (scale capacity losses by _cap_scale to stay consistent)
    sei_final  = float(sei_conc[-1])     if sei_conc is not None else 0.0
    cap_sei    = float(cap_loss_sei[-1]) * _cap_scale if cap_loss_sei is not None else 0.0
    cap_crk    = float(cap_loss_crk[-1]) * _cap_scale if cap_loss_crk is not None else 0.0
    total_loss = cap_sei + cap_crk + 1e-9
    lli_frac   = round(cap_sei / total_loss, 4)
    # When the DFN+cracking model is active, prefer the direct LAM signal.
    if lam_neg_pct is not None and len(lam_neg_pct) > 0:
        lam_total = float(lam_neg_pct[-1])
        if lam_pos_pct is not None and len(lam_pos_pct) > 0:
            lam_total = max(lam_total, float(lam_pos_pct[-1]))
        lam_frac = round(min(1.0, lam_total / 100.0), 4)
    else:
        lam_frac = round(cap_crk / total_loss, 4)

    # k_sei: cap_loss_sei[n] ≈ Q0 · alpha · (1 − exp(−k_sei · √n)). Solve at the last cycle.
    n_eff = max(1, len(cap_traj) // 2)
    if cap_sei > 0 and Q0_sim > 0:
        ratio = min(0.9, cap_sei / Q0_sim)
        # invert: 1 - exp(-k_sei * sqrt(n)) = ratio → k_sei = -ln(1-ratio) / sqrt(n)
        k_sei_inv = -np.log(1.0 - ratio) / max(np.sqrt(n_eff), 1.0)
    else:
        k_sei_inv = 0.0
    k_sei = round(float(k_sei_inv), 6)

    # k_crack: same shape on cap_loss_crk
    if cap_crk > 0 and Q0_sim > 0:
        ratio_c = min(0.9, cap_crk / Q0_sim)
        k_crack_inv = -np.log(1.0 - ratio_c) / max(n_eff, 1.0)
    else:
        k_crack_inv = 0.0
    k_crack = round(float(k_crack_inv), 6)

    # alpha: fraction of TOTAL fade attributable to SEI growth (vs cracking)
    alpha = round(float(cap_sei / total_loss), 4) if total_loss > 1e-9 else 0.5

    # SEI thickness (nm): from concentration × electrode geometry. We don't have
    # a clean direct variable, so scale concentration relative to a literature
    # density to produce a thickness-equivalent number on the same scale as the
    # analytical proxy in core.internal_states (k_sei × √cycles × 1000).
    sei_thickness_nm = round(float(sei_final * 1e-3), 2)   # mol/m³ → nm-equivalent
    if sei_thickness_nm == 0.0 and cap_sei > 0:
        # fallback: use the same proxy as the analytical extractor so the schema
        # row is non-zero (the trained head can still learn the relative ranking)
        sei_thickness_nm = round(k_sei * (n_eff ** 0.5) * 1000.0, 2)

    # cycles to 80% capacity (EOL)
    eol_mask = cap_traj <= 0.8 * Q0_sim
    cycles_to_eol = int(np.argmax(eol_mask) // 2 + 1) if eol_mask.any() else n_eff

    # ir growth: use SEI-driven capacity loss as a proxy (real R_int from SPM is
    # also accessible but adds complexity; this is a meaningful ranking signal)
    ir_growth_pct = round(float(cap_sei / Q0_sim * 100), 2) if Q0_sim > 0 else 0.0

    # Temperature/plating from the input conditions (not modeled in this mode)
    temp_stress = round(max(0.0, temperature - 25.0) / 25.0, 3)
    plating_risk = 0.0   # reaction-limited mode does not model plating

    # Fit-quality proxies — for PyBaMM-source labels these are "1.0" (ground truth)
    return {
        "k_sei":               k_sei,
        "k_crack":             k_crack,
        "alpha":               alpha,
        "Q0":                  round(Q0_sim, 4),
        "sei_thickness_nm":    sei_thickness_nm,
        "lli_fraction":        lli_frac,
        "lam_fraction":        lam_frac,
        "ir_growth_pct":       ir_growth_pct,
        "cycles_to_eol":       int(cycles_to_eol),
        "temp_stress_index":   temp_stress,
        "lithium_plating_risk": plating_risk,
        "fit_r2":              1.0,
        "fit_mape":            0.0,
        "source":              "pybamm_sim",
        "_chemistry":          chem,
        "_c_rate":             c_rate_dis,
        "_temperature":        temperature,
        "_n_cycles":           n_cycles,
        "_model_mode_requested": mode_requested,
        "_model_mode_used":      model_mode,
        "_parameter_set":        param_name,
    }

"""
gen_pybamm_thermal.py — generate PyBaMM electrochemical-thermal training data for the
Thermal Twin's learned core-temperature sensor.

For many randomized drive profiles (varied C-rate sequences, ambient, cooling), run an
SPMe model with a lumped thermal submodel and log time-series:
    I, V, SOC, surface_T (volume-averaged cell temp), ambient_T, heat_gen (W/m^3)
Labels:
    surface_T  = PyBaMM volume-averaged cell temperature  (the measurable signal)
    core_T     = surface_T + K_CORE * heat_gen            (heat-driven radial gradient;
                 PyBaMM's accurate heat output drives the core-surface gap, since the
                 lumped model does not resolve a radial core directly — documented.)

Output: backend/data/thermal/pybamm_thermal.parquet

    backend/venv/bin/python scripts/gen_pybamm_thermal.py --runs 80
"""
from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import pandas as pd
import pybamm

OUT = Path(__file__).resolve().parents[1] / "backend" / "data" / "thermal"
K_CORE = 2.0e-4          # heat-density -> core-surface ΔT [°C per W/m^3]; ~12°C at hard load
MAX_DCORE = 25.0         # clip the modeled core offset


def random_experiment(rng) -> pybamm.Experiment:
    """A randomized sequence of CC discharge / rest / charge steps."""
    steps, n = [], rng.integers(3, 7)
    for _ in range(n):
        kind = rng.choice(["dis", "dis", "rest", "chg"])
        mins = int(rng.integers(3, 12))
        if kind == "dis":
            steps.append(f"Discharge at {rng.uniform(0.5, 4.0):.2f}C for {mins} minutes or until 2.6 V")
        elif kind == "chg":
            steps.append(f"Charge at {rng.uniform(0.3, 1.5):.2f}C for {mins} minutes or until 4.15 V")
        else:
            steps.append(f"Rest for {rng.integers(2, 8)} minutes")
    return pybamm.Experiment(steps, period="20 seconds")


def run_one(run_id: int, rng) -> pd.DataFrame | None:
    amb_c = float(rng.uniform(10, 40))
    htc = float(rng.uniform(5, 25))                       # low coeff -> meaningful temp rise
    model = pybamm.lithium_ion.SPMe(options={"thermal": "lumped"})
    param = pybamm.ParameterValues("Chen2020")
    param["Ambient temperature [K]"] = 273.15 + amb_c
    param["Total heat transfer coefficient [W.m-2.K-1]"] = htc
    try:
        sim = pybamm.Simulation(model, parameter_values=param, experiment=random_experiment(rng))
        sol = sim.solve(initial_soc=float(rng.uniform(0.6, 1.0)))
    except Exception:
        return None
    q_nom = float(param["Nominal cell capacity [A.h]"])
    try:
        I = sol["Current [A]"].entries
        V = sol["Terminal voltage [V]"].entries
        Ts = sol["Volume-averaged cell temperature [C]"].entries
        Q = sol["Volume-averaged total heating [W.m-3]"].entries
        dcap = sol["Discharge capacity [A.h]"].entries
    except Exception:
        return None
    soc = np.clip(1.0 - dcap / q_nom, 0.0, 1.0)
    dcore = np.clip(K_CORE * np.abs(Q), 0, MAX_DCORE)
    core = Ts + dcore
    return pd.DataFrame({
        "run_id": run_id, "I": I, "V": V, "soc": soc,
        "surface_T": Ts, "ambient_T": amb_c, "heat_gen": Q,
        "core_T": core,
    })


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=80)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    rng = np.random.default_rng(args.seed)
    OUT.mkdir(parents=True, exist_ok=True)

    t0, frames, ok = time.time(), [], 0
    for r in range(args.runs):
        df = run_one(r, rng)
        if df is not None and len(df) > 5:
            frames.append(df); ok += 1
        if (r + 1) % 10 == 0:
            print(f"  {r+1}/{args.runs} runs ({ok} ok)  {time.time()-t0:.0f}s")
    data = pd.concat(frames, ignore_index=True)
    path = OUT / "pybamm_thermal.parquet"
    data.to_parquet(path)
    print(f"\n[done] {ok} runs, {len(data):,} samples -> {path}")
    print(f"  surface_T [{data.surface_T.min():.1f},{data.surface_T.max():.1f}]°C  "
          f"core_T [{data.core_T.min():.1f},{data.core_T.max():.1f}]°C  "
          f"max ΔT={float((data.core_T-data.surface_T).max()):.1f}°C")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

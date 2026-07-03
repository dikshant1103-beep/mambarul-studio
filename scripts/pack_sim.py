#!/usr/bin/env python
"""
pack_sim.py — liionpack pack-level simulation → Pack-GNN training samples.

⚠ RUN IN THE ISOLATED packsim ENV ONLY (Python 3.10/3.11, pybamm 23.9):
    conda run -n packsim python scripts/pack_sim.py --np 2 --ns 2 --samples 5
This script imports liionpack, which is NOT installed in the main backend env
and is incompatible with the main pybamm 25.x. It writes JSON sample files that
the main app reads via core/pack_sim_loader.py (no liionpack import there).

What it produces (per sample, in processed/pack_sim/):
  A coupled electrochemical pack solve with randomized cell-to-cell internal
  resistance. Real packs diverge: higher-Ri cells (series) over-discharge and
  run hotter; that imbalance is the ground-truth signal Pack-GNN learns to
  correct. Each JSON holds per-cell summary features + the measured imbalance.
"""
from __future__ import annotations

import argparse
import json
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import numpy as np


def _build_edges(ns: int, np_: int) -> list[list[int]]:
    """Series-parallel grid edges. Cell index = s * np_ + p (s in series, p in parallel)."""
    edges: list[list[int]] = []
    def idx(s, p): return s * np_ + p
    for s in range(ns):
        for p in range(np_):
            i = idx(s, p)
            if p + 1 < np_:            # parallel neighbour (same series level)
                edges.append([i, idx(s, p + 1)])
            if s + 1 < ns:             # series neighbour (next level)
                edges.append([i, idx(s + 1, p)])
    return edges


def simulate_one(np_: int, ns: int, current: float, seconds: float,
                 period: float, chemistry_param: str, ri_spread: float,
                 seed: int) -> dict:
    """Run one liionpack pack solve with per-cell Ri variation; return a sample dict."""
    import liionpack as lp
    import pybamm

    rng = np.random.default_rng(seed)
    n_cells = np_ * ns

    netlist = lp.setup_circuit(Np=np_, Ns=ns, Rb=1.5e-3, Rc=1e-2, Ri=5e-2, V=3.6, I=current)

    # Inject per-cell internal-resistance imbalance into the netlist 'Ri' resistors.
    ri_base = 5e-2
    ri_per_cell = ri_base * (1.0 + rng.uniform(-ri_spread, ri_spread, size=n_cells))
    ri_mask = netlist["desc"].astype(str).str.startswith("Ri")
    ri_rows = netlist.index[ri_mask].tolist()
    for k, row in enumerate(ri_rows[:n_cells]):
        netlist.loc[row, "value"] = float(ri_per_cell[k])

    experiment = pybamm.Experiment(
        [f"Discharge at {current} A for {int(seconds)} seconds"],
        period=f"{int(period)} seconds",
    )
    param = pybamm.ParameterValues(chemistry_param)

    out = lp.solve(
        netlist=netlist,
        parameter_values=param,
        experiment=experiment,
        output_variables=["Terminal voltage [V]"],
        initial_soc=0.9,
        nproc=1,
        manager="casadi",
    )

    # liionpack returns dict: key -> array shaped (n_steps, n_cells)
    tv = np.asarray(out["Terminal voltage [V]"], dtype=float)   # (T, N)
    cur = None
    for k in ("Cell current [A]", "Current [A]", "Pack current [A]"):
        if k in out:
            arr = np.asarray(out[k], dtype=float)
            if arr.ndim == 2 and arr.shape[1] == n_cells:
                cur = arr
                break
    if cur is None:
        # Fall back: even split of pack current (still captures topology, weak signal)
        cur = np.full_like(tv, current / max(np_, 1))

    # Per-cell summary features from the trajectories
    cells = []
    v_min_pack = float(np.min(tv))
    for c in range(n_cells):
        v_c   = tv[:, c]
        i_c   = np.abs(cur[:, c])
        cells.append({
            "cell_id":       f"c{c}",
            "ri":            round(float(ri_per_cell[c]), 6),
            "v_mean":        round(float(np.mean(v_c)), 5),
            "v_min":         round(float(np.min(v_c)), 5),
            "v_spread":      round(float(np.max(v_c) - np.min(v_c)), 5),
            "current_share": round(float(np.mean(i_c)), 5),    # higher = more stress
            "charge_throughput_ah": round(float(np.trapz(i_c, dx=period) / 3600.0), 6),
        })

    return {
        "sample_id":  uuid.uuid4().hex[:12],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "topology":   "series-parallel" if (ns > 1 and np_ > 1) else ("series" if ns > 1 else "parallel"),
        "n_series":   ns,
        "n_parallel": np_,
        "n_cells":    n_cells,
        "current_a":  current,
        "chemistry_param": chemistry_param,
        "edges":      _build_edges(ns, np_),
        "v_min_pack": round(v_min_pack, 5),
        "cells":      cells,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="liionpack pack simulation → Pack-GNN training samples")
    ap.add_argument("--np", dest="np_", type=int, default=2, help="cells in parallel")
    ap.add_argument("--ns", dest="ns", type=int, default=2, help="cells in series")
    ap.add_argument("--current", type=float, default=2.0, help="pack discharge current (A)")
    ap.add_argument("--seconds", type=float, default=200.0, help="discharge duration (s)")
    ap.add_argument("--period", type=float, default=20.0, help="sample period (s)")
    ap.add_argument("--chem-param", default="Chen2020", help="pybamm ParameterValues set")
    ap.add_argument("--ri-spread", type=float, default=0.25, help="per-cell Ri variation fraction")
    ap.add_argument("--samples", type=int, default=5, help="number of pack solves")
    ap.add_argument("--out", default=None, help="output dir (default: processed/pack_sim)")
    args = ap.parse_args()

    out_dir = Path(args.out) if args.out else (
        Path(__file__).resolve().parent.parent.parent / "processed" / "pack_sim"
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"pack_sim: {args.samples} samples, {args.np_}P{args.ns}S, "
          f"current={args.current}A → {out_dir}")
    for s in range(args.samples):
        t0 = time.time()
        try:
            sample = simulate_one(
                np_=args.np_, ns=args.ns, current=args.current, seconds=args.seconds,
                period=args.period, chemistry_param=args.chem_param,
                ri_spread=args.ri_spread, seed=1000 + s,
            )
        except Exception as exc:
            print(f"  sample {s}: FAILED — {type(exc).__name__}: {exc}")
            continue
        path = out_dir / f"packsim_{sample['sample_id']}.json"
        path.write_text(json.dumps(sample, indent=2))
        print(f"  sample {s}: {sample['n_cells']} cells, "
              f"v_min={sample['v_min_pack']:.3f}V, {time.time()-t0:.1f}s → {path.name}")
    print("pack_sim: done")


if __name__ == "__main__":
    main()

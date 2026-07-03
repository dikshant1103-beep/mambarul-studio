#!/usr/bin/env python
"""
cache_pybamm_synthetic_cells.py — Phase C synthetic cell generator.

For each (chemistry × c_rate × temperature) point on a factorial grid: runs
real PyBaMM SPM + reaction-limited SEI, extracts the 13-key internal-state
vector (the ground-truth labels) and the per-cycle capacity trajectory.
Saves everything to a single JSON file consumed by the Stage-1 trainer.

These cells are the supervised pre-training corpus for the internal-state head:
the labels here ARE physics ground truth (the head learns to reverse-engineer
the same quantities the simulator produced), so the marquee observables
(k_sei, sei_thickness) become learnable in a way that analytical-fit labels
on real cells could not support (Option A finding).
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))


_CHEM_CODE = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3, "NCA": 4}


def _log(msg: str) -> None:
    print(msg, flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--chemistries", nargs="+",
                    default=["LFP", "NMC", "NCA", "LCO"])
    ap.add_argument("--c-rates", nargs="+", type=float,
                    default=[0.5, 1.0, 1.5])
    ap.add_argument("--temps",   nargs="+", type=float,
                    default=[15.0, 25.0, 35.0])
    ap.add_argument("--n-cycles", type=int, default=80)
    ap.add_argument("--model-mode", default="spm_reaction_limited",
                    choices=["spm_reaction_limited", "dfn_electrolyte_crack"],
                    help="PyBaMM degradation model preset")
    ap.add_argument("--out",     default=None)
    args = ap.parse_args()

    from core.digital_twin import run_pybamm_simulation
    from core.pybamm_internal_states import extract_pybamm_internal_states
    from core.internal_states import INTERNAL_STATE_KEYS

    out_path = Path(args.out) if args.out else (
        Path(__file__).resolve().parent.parent.parent
        / "processed" / "internal_state_head" / "synthetic_cells.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    grid = [(chem, c, T)
            for chem in args.chemistries
            for c in args.c_rates
            for T in args.temps]
    _log(f"generating {len(grid)} synthetic cells "
         f"({len(args.chemistries)} chem × {len(args.c_rates)} c_rate × "
         f"{len(args.temps)} temp), n_cycles={args.n_cycles}")

    samples: list[dict] = []
    n_ok = n_err = n_skip = 0
    t0 = time.time()
    for k, (chem, c, T) in enumerate(grid, 1):
        ts = time.time()
        try:
            sim = run_pybamm_simulation(
                n_cycles=args.n_cycles, c_rate_dis=c,
                c_rate_chg=min(c, 1.0), temperature=T, chemistry=chem,
            )
        except Exception as exc:
            n_err += 1
            _log(f"  [{k:3d}/{len(grid)}] {chem} c={c} T={T}  SIM ERROR: {exc}")
            continue
        if not sim.get("ok") or len(sim.get("capacity", [])) < 32:
            n_skip += 1
            _log(f"  [{k:3d}/{len(grid)}] {chem} c={c} T={T}  skipped (no cap)")
            continue

        labels = extract_pybamm_internal_states(
            chemistry=chem, c_rate_dis=c, temperature=T, n_cycles=args.n_cycles,
            model_mode=args.model_mode,
        )
        if "error" in labels:
            n_err += 1
            _log(f"  [{k:3d}/{len(grid)}] {chem} c={c} T={T}  LABEL ERROR: {labels['error']}")
            continue

        samples.append({
            "cell_id":        f"PYBAMM_{chem}_c{c}_T{T}_n{args.n_cycles}",
            "chemistry":      chem,
            "chemistry_code": _CHEM_CODE.get(chem, 2),
            "c_rate":         c,
            "temperature":    T,
            "n_cycles":       args.n_cycles,
            "cycles":         sim["cycles"],
            "capacity":       sim["capacity"],
            "labels":         {key: labels.get(key) for key in INTERNAL_STATE_KEYS},
        })
        n_ok += 1
        _log(f"  [{k:3d}/{len(grid)}] {chem} c={c} T={T}  "
             f"({time.time() - ts:.1f}s)  ok={n_ok}  err={n_err}  skip={n_skip}")

    out_path.write_text(json.dumps(samples, indent=2))
    _log(f"\nwrote {len(samples)} cells → {out_path}")
    _log(f"  elapsed: {time.time() - t0:.0f}s")
    chem_counts: dict[str, int] = {}
    for s in samples:
        chem_counts[s["chemistry"]] = chem_counts.get(s["chemistry"], 0) + 1
    _log(f"  by chemistry: {chem_counts}")


if __name__ == "__main__":
    main()

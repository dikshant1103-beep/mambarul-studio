#!/usr/bin/env python
"""
cache_pybamm_real_labels.py — Phase C label-quality fix.

The 2026-05-29 transfer experiment failed because real cells have
analytical-fit labels (curve-fit k_sei, k_crack, alpha) and synthetic
cells have PyBaMM ground-truth labels. The two distributions don't match,
so head weights pretrained on synthetic pull the wrong direction on real.

This script closes the gap on the REAL side: for each cached cell, we
run a PyBaMM simulation with the cell's MEAN operating conditions
(temperature, charge-time-derived C-rate proxy) for its observed cycle
count, then extract the same 13-key internal-state vector that
extract_pybamm_internal_states already produces for synthetic cells.

Result: real cells now also carry "pybamm_sim" labels (alongside the
existing analytical_fit labels in `cell_internal_states`) and Stage-2
fine-tune can use them as targets — matching the Stage-1 synthetic label
distribution.

Output: rows persisted with `source="pybamm_sim_real_matched"` so the
trainer can prefer them via the `--label-source` flag when fine-tuning.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))


def _infer_c_rate(charge_time_s: float, nom_cap_ah: float = 1.0) -> float:
    """Convert mean charge time to a c-rate estimate.

    A C-rate-1 charge of a `nom_cap` Ah cell takes ~3600 s (Coulomb counting).
    Faster charges → higher C-rate. We clamp to [0.2, 3.0] for PyBaMM stability.
    """
    if charge_time_s <= 0:
        return 1.0
    c = 3600.0 / max(charge_time_s, 600.0)
    return float(max(0.2, min(3.0, c)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-cells", type=int, default=120)
    ap.add_argument("--chemistry", default=None,
                    help="optional filter, e.g. NMC / LFP / LCO")
    ap.add_argument("--n-cycles",  type=int, default=80,
                    help="cycles per PyBaMM run (must match Stage-1 synthetic cache)")
    ap.add_argument("--model-mode", default="dfn_electrolyte_crack",
                    choices=["spm_reaction_limited", "dfn_electrolyte_crack"])
    ap.add_argument("--out", default=None)
    ap.add_argument("--skip-existing", action="store_true",
                    help="skip cells already labeled with the same source tag")
    args = ap.parse_args()

    import core.data_loader as dl
    from core.db import store_internal_states, list_internal_states
    from core.pybamm_internal_states import extract_pybamm_internal_states
    from core.internal_states import INTERNAL_STATE_KEYS

    SOURCE_TAG = f"pybamm_sim_real_matched::{args.model_mode}"
    if dl._meta_df is None:
        dl.load_dataset()

    cached = list_internal_states(limit=10000)
    existing_keys = {(r["cell_id"], r.get("states", {}).get("source"))
                     for r in cached}

    candidate_cells: list[str] = []
    meta_by_cell: dict[str, dict] = {}
    grouped = dl._meta_df.groupby("cell_id")
    for cid, grp in grouped:
        chem = str(grp["chemistry_name"].iloc[0]).upper()
        if args.chemistry and chem != args.chemistry.upper():
            continue
        if len(grp) < 30:
            continue
        if args.skip_existing and (cid, SOURCE_TAG) in existing_keys:
            continue
        order = grp.sort_values("cycle").index.values
        last30_idx = order[-30:]
        T_mean      = float(np.mean(dl._features[last30_idx, 5]))
        ct_mean     = float(np.mean(dl._features[last30_idx, 1]))
        # col 0 = Capacity (Ah) — peak measured capacity over last 30 cycles.
        # Passed to extract_pybamm_internal_states so PyBaMM scales its nominal
        # capacity to match the real cell (fixes LFP Q₀ catastrophic R²).
        measured_cap = float(np.max(dl._features[last30_idx, 0]))
        if measured_cap < 0.05:            # sanity guard for bad rows
            measured_cap = None
        meta_by_cell[cid] = {
            "chemistry":    chem,
            "T_mean":       T_mean,
            "ct_mean":      ct_mean,
            "n_observed":   int(len(grp)),
            "measured_cap": measured_cap,
        }
        candidate_cells.append(cid)
        if len(candidate_cells) >= args.max_cells:
            break

    out_path = Path(args.out) if args.out else (
        Path(__file__).resolve().parent.parent.parent
        / "processed" / "internal_state_head" / "real_pybamm_labels.json"
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)

    print(f"generating PyBaMM-matched labels for {len(candidate_cells)} real cells "
          f"using model_mode={args.model_mode}", flush=True)
    records: list[dict] = []
    n_ok = n_err = 0
    t0 = time.time()
    for k, cid in enumerate(candidate_cells, 1):
        m = meta_by_cell[cid]
        c_rate = _infer_c_rate(m["ct_mean"])
        ts = time.time()
        try:
            labels = extract_pybamm_internal_states(
                chemistry=m["chemistry"], c_rate_dis=c_rate,
                c_rate_chg=min(c_rate, 1.0), temperature=m["T_mean"],
                n_cycles=args.n_cycles, model_mode=args.model_mode,
                measured_cap_ah=m.get("measured_cap"),
            )
        except Exception as exc:
            n_err += 1
            print(f"  [{k:3d}/{len(candidate_cells)}] {cid} ({m['chemistry']}) "
                  f"ERROR: {exc}", flush=True)
            continue
        if "error" in labels:
            n_err += 1
            print(f"  [{k:3d}/{len(candidate_cells)}] {cid} ({m['chemistry']}) "
                  f"LABEL ERROR: {labels['error']}", flush=True)
            continue
        labels["source"] = SOURCE_TAG
        labels["_real_cell_id"]    = cid
        labels["_operating_T"]     = m["T_mean"]
        labels["_operating_crate"] = c_rate
        labels["_n_observed"]      = m["n_observed"]
        store_internal_states(cell_id=cid, states=labels,
                              chemistry=m["chemistry"], source=SOURCE_TAG)
        records.append({"cell_id": cid, **labels})
        n_ok += 1
        if k % 5 == 0 or k == len(candidate_cells):
            print(f"  [{k:3d}/{len(candidate_cells)}] {cid} ({m['chemistry']}) "
                  f"T={m['T_mean']:.1f} c={c_rate:.2f} → "
                  f"k_sei={labels.get('k_sei')} ({time.time() - ts:.1f}s)  "
                  f"ok={n_ok} err={n_err}", flush=True)

    out_path.write_text(json.dumps(records, indent=2))
    print(f"\nwrote {len(records)} records → {out_path}", flush=True)
    print(f"  elapsed: {time.time() - t0:.0f}s  ok={n_ok}  err={n_err}", flush=True)


if __name__ == "__main__":
    main()

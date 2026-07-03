#!/usr/bin/env python
"""
cache_internal_state_labels.py — Phase C label pre-computation.

For every cell in the loaded dataset, fits the digital twin (PyBaMM analytical
SPM+SEI), extracts the structured 13-key internal-state vector via
`core.internal_states.extract_internal_states`, and persists it to the
`cell_internal_states` table (idempotent via `--skip-existing`).

This is an OFFLINE one-shot pass — twin fits are not cheap. Bound runtime with
`--max-cells` and `--chemistry`. Once cached, `train_internal_state_head.py
--real` consumes the table.
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))


def main() -> None:
    ap = argparse.ArgumentParser(description="Phase C: cache internal-state labels")
    ap.add_argument("--max-cells",    type=int, default=30, help="upper bound on cells to process")
    ap.add_argument("--chemistry",    default=None, help="filter to one chemistry (LFP/NMC/…)")
    ap.add_argument("--skip-existing", action="store_true",
                    help="skip cells that already have a cached vector")
    args = ap.parse_args()

    import core.data_loader as dl
    from core.digital_twin import build_twin
    from core.internal_states import extract_internal_states
    from core.db import init_db, store_internal_states, get_internal_states

    init_db()
    if dl._meta_df is None:
        dl.load_dataset()
    meta = dl._meta_df
    if args.chemistry:
        meta = meta[meta["chemistry_name"].str.upper() == args.chemistry.upper()]
    if meta is None or len(meta) == 0:
        print("No cells in dataset (filter too strict?)")
        sys.exit(2)

    cell_ids = list(meta["cell_id"].unique())[: args.max_cells]
    print(f"caching internal states for up to {len(cell_ids)} cell(s) "
          f"(chemistry={args.chemistry or 'ALL'})")

    n_ok = n_skip = n_err = 0
    t0 = time.time()
    for k, cid in enumerate(cell_ids, 1):
        if args.skip_existing and get_internal_states(cid) is not None:
            n_skip += 1
            print(f"  [{k}/{len(cell_ids)}] {cid:40s} CACHED (skip)")
            continue
        ts0 = time.time()
        try:
            twin = build_twin(cid)
            if "error" in twin:
                n_err += 1
                print(f"  [{k}/{len(cell_ids)}] {cid:40s} ERROR: {twin['error']}")
                continue
            states = extract_internal_states(twin)
            if "error" in states:
                n_err += 1
                print(f"  [{k}/{len(cell_ids)}] {cid:40s} ERROR: {states['error']}")
                continue
            store_internal_states(cid, states, chemistry=twin.get("chemistry", ""),
                                  source="twin")
            n_ok += 1
            print(f"  [{k}/{len(cell_ids)}] {cid:40s} OK  "
                  f"({time.time() - ts0:.1f}s, R²={states.get('fit_r2')})")
        except Exception as exc:
            n_err += 1
            print(f"  [{k}/{len(cell_ids)}] {cid:40s} EXC: {type(exc).__name__}: {exc}")

    print(f"\ndone — ok={n_ok}, skipped={n_skip}, errors={n_err}, "
          f"elapsed={time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()

#!/usr/bin/env python
"""
phase_c_sweep.py — Run the Phase C λ × n grid in one pass and emit a structured
comparison table. Used to produce the "data scale is the dominant lever" figure
and the per-chemistry stratification table for the paper.

For each (n_cells, λ_phys) pair: build the dataset capped at n_cells, train the
head with the given λ, evaluate on the held-out split, record per-key R².

Output: processed/internal_state_head/sweep_results.json (full) + a printed
ASCII summary table.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))


def main() -> None:
    ap = argparse.ArgumentParser(description="Phase C λ × n sweep")
    ap.add_argument("--n-values",   nargs="+", type=int,
                    default=[60, 100, 200, 320],
                    help="dataset sizes to evaluate at")
    ap.add_argument("--lam-values", nargs="+", type=float,
                    default=[0.0, 0.1, 0.5, 1.0],
                    help="λ_phys values to evaluate at")
    ap.add_argument("--epochs",     type=int, default=80)
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--val-frac",   type=float, default=0.25)
    ap.add_argument("--out",        default=None)
    args = ap.parse_args()

    from train_internal_state_head import train_real, _build_real_dataset

    # Build the full dataset once so we know the cell pool to subsample from
    print("Building full dataset…")
    full_ds = _build_real_dataset()
    n_full = full_ds["X"].shape[0]
    print(f"  pool size: {n_full} labeled cells")

    out_dir = Path(args.out) if args.out else (
        Path(__file__).resolve().parent.parent.parent / "processed" / "internal_state_head"
    )
    out_dir.mkdir(parents=True, exist_ok=True)

    # We'll capture only the validation report from each run (no checkpoints written)
    sweep: list[dict] = []
    t0 = time.time()

    # Monkey-patch `_build_real_dataset` for each run to truncate to the desired n.
    import train_internal_state_head as tish
    orig_builder = tish._build_real_dataset

    for n in args.n_values:
        n_eff = min(n, n_full)
        for lam in args.lam_values:
            label = f"n={n_eff} λ={lam}"
            print(f"\n──── {label} ────")
            def _trunc_builder(_n=n_eff, _full=full_ds):
                # Return a truncated view of the full dataset; deterministic ordering.
                d = dict(_full)
                d["X"]    = _full["X"][:_n]
                d["Yint"] = _full["Yint"][:_n]
                d["Yrul"] = _full["Yrul"][:_n]
                d["Ysoh"] = _full["Ysoh"][:_n]
                d["chem"] = _full["chem"][:_n]
                d["cells"] = _full["cells"][:_n]
                return d
            tish._build_real_dataset = _trunc_builder
            # Train into a tmp dir so we don't clobber the production head checkpoint
            run_out = out_dir / f"sweep_n{n_eff}_lam{lam}"
            run_out.mkdir(parents=True, exist_ok=True)
            try:
                m = train_real(
                    epochs=args.epochs, lr=3e-3, lam_aux=1.0,
                    freeze_backbone=True, batch_size=args.batch_size,
                    val_frac=args.val_frac, lam_phys=lam, seed=0,
                    out_dir=run_out,
                )
            except Exception as exc:
                print(f"  FAILED: {type(exc).__name__}: {exc}")
                continue
            vr = m.get("val_report") or {}
            row = {
                "n": n_eff, "lam_phys": lam,
                "n_train": m["n_train"], "n_val": m["n_val"],
                "val_loss": m["final_val_loss"],
                "rul_mae": vr.get("rul_mae_norm"),
                "soh_mae": vr.get("soh_mae"),
                "per_key_r2": {k: v["r2"] for k, v in (vr.get("per_key") or {}).items()},
                "per_chemistry": {
                    c: {k: kv["r2"] for k, kv in cd["per_key"].items()}
                    for c, cd in (vr.get("per_chemistry") or {}).items()
                },
                "elapsed_s": m["elapsed_s"],
            }
            sweep.append(row)
            print(f"  val_loss={row['val_loss']:.4f}  rul_mae={row['rul_mae']}  "
                  f"soh_mae={row['soh_mae']}")

    tish._build_real_dataset = orig_builder

    # Write structured output + print pivot
    (out_dir / "sweep_results.json").write_text(json.dumps(sweep, indent=2))

    print(f"\n════ R² pivot table (rows=n, cols=λ) — selected marquee observables ════")
    keys = ("cycles_to_eol", "lli_fraction", "lam_fraction", "k_sei",
            "sei_thickness_nm", "k_crack", "Q0", "alpha")
    ns  = sorted({r["n"] for r in sweep})
    lams = sorted({r["lam_phys"] for r in sweep})
    for key in keys:
        print(f"\n  {key}")
        hdr = "       " + "".join(f"  λ={l:<4} " for l in lams)
        print(hdr)
        for n in ns:
            cells = []
            for lam in lams:
                row = next((r for r in sweep if r["n"] == n and r["lam_phys"] == lam), None)
                v = (row or {}).get("per_key_r2", {}).get(key)
                cells.append(f" {v:+.2f} " if isinstance(v, (int, float)) else " ----- ")
            print(f"  n={n:<4}" + "  ".join(cells))

    print(f"\n  val_loss")
    print("       " + "".join(f"  λ={l:<4} " for l in lams))
    for n in ns:
        cells = []
        for lam in lams:
            row = next((r for r in sweep if r["n"] == n and r["lam_phys"] == lam), None)
            v = (row or {}).get("val_loss")
            cells.append(f" {v:.3f} " if isinstance(v, (int, float)) else " ----- ")
        print(f"  n={n:<4}" + "  ".join(cells))

    print(f"\nelapsed total: {time.time() - t0:.1f}s")
    print(f"results: {out_dir / 'sweep_results.json'}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python
"""
train_two_stage.py — Phase C end-to-end: Stage-1 pretrain on synthetic PyBaMM
ground-truth labels (where the marquee electrochemistry observables ARE
learnable), then Stage-2 fine-tune on real cells with analytical-fit labels.

Pipeline:
    Stage 1: load processed/internal_state_head/synthetic_cells.json
             (produced by scripts/cache_pybamm_synthetic_cells.py)
             → train head on PyBaMM-grounded labels (per-chemistry scaling)
             → save Stage-1 checkpoint
    Stage 2: load Stage-1 head weights
             → fine-tune on real cached cells via train_real()
             → save Stage-2 (final) checkpoint with held-out val report
    Report:  per-chemistry transfer R² on the real held-out val set, plus the
             gain over a baseline that skips Stage 1.
"""
from __future__ import annotations

import argparse
import copy
import json
import sys
import time
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))


def _build_synthetic_dataset(path: Path):
    """Build a dataset dict (same shape as `_build_real_dataset`) from the
    synthetic_cells.json file. Per-chemistry scaling matches the real path."""
    import numpy as np
    import torch
    from core.model_loader import _normalize, _MODELS, load_all_models, CHEM_MAX_RUL
    from core.internal_states import INTERNAL_STATE_KEYS

    load_all_models()
    entry = _MODELS.get("v12-bimamba")
    if entry is None:
        raise RuntimeError("v12-bimamba not loaded")
    fmean, fstd = entry["feat_mean"], entry["feat_std"]

    raw = json.loads(Path(path).read_text())
    if not raw:
        raise RuntimeError(f"no synthetic cells in {path}")

    X_list, Yint_list, Yrul_list, Ysoh_list, chem_list, cells = [], [], [], [], [], []
    for s in raw:
        caps = np.array(s["capacity"], dtype=np.float32)
        if len(caps) < 30:
            continue
        # build 30-cycle (B, 30, 9) raw window mirroring the v12 input contract
        L = 30
        caps30 = caps[-L:]
        raw_win = np.zeros((L, 9), dtype=np.float32)
        raw_win[:, 0] = caps30
        raw_win[:, 1] = 7200.0
        raw_win[:, 2] = 3.8
        raw_win[:, 3] = 2.75
        raw_win[:, 4] = caps30 * 3.8
        raw_win[:, 5] = s["temperature"]
        raw_win[:, 6] = (caps30[-1] - caps30[0]) / max(L - 1, 1)
        raw_win[:, 7] = 0.03
        raw_win[:, 8] = s["chemistry_code"]
        X_list.append(_normalize(raw_win, fmean, fstd))

        labels = s["labels"] or {}
        Yint_list.append([float(labels.get(k) or 0.0) for k in INTERNAL_STATE_KEYS])
        # synthetic RUL target: cycles_to_eol normalized to chemistry max
        chem_max = CHEM_MAX_RUL.get(s["chemistry"], 1000.0)
        Yrul_list.append(float(labels.get("cycles_to_eol") or 0.0) / chem_max)
        # synthetic SOH target: final/initial capacity
        Ysoh_list.append(float(caps[-1] / max(caps[0], 1e-6)))
        chem_list.append(int(s["chemistry_code"]))
        cells.append(s["cell_id"])

    if not X_list:
        raise RuntimeError("no usable synthetic cells (all too short)")

    X    = torch.tensor(np.stack(X_list, axis=0))
    Yint = torch.tensor(np.array(Yint_list, dtype=np.float32))
    Yrul = torch.tensor(np.array(Yrul_list, dtype=np.float32))
    Ysoh = torch.tensor(np.array(Ysoh_list, dtype=np.float32))
    chem = torch.tensor(chem_list, dtype=torch.long)

    # per-chemistry min-max scaling
    y_min_per = torch.zeros_like(Yint)
    y_max_per = torch.zeros_like(Yint)
    chem_scalers = {}
    for cc in sorted({int(c.item()) for c in chem}):
        mask = (chem == cc)
        if int(mask.sum()) >= 2:
            ymn = Yint[mask].min(0).values
            ymx = Yint[mask].max(0).values
        else:
            ymn, ymx = Yint.min(0).values, Yint.max(0).values
        chem_scalers[cc] = {"y_min": ymn.tolist(), "y_max": ymx.tolist(),
                             "n_cells": int(mask.sum())}
        y_min_per[mask] = ymn
        y_max_per[mask] = ymx
    y_rng_per = (y_max_per - y_min_per).clamp(min=1e-6)
    Yint_scaled = (Yint - y_min_per) / y_rng_per

    return {
        "X": X, "Yint": Yint_scaled, "Yrul": Yrul, "Ysoh": Ysoh, "chem": chem,
        "cells": cells,
        "y_min": y_min_per.tolist(), "y_max": y_max_per.tolist(),
        "chem_scalers": chem_scalers,
        "keys": list(INTERNAL_STATE_KEYS),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--synthetic", default=None,
                    help="path to synthetic_cells.json (default: standard location)")
    ap.add_argument("--stage1-epochs", type=int, default=120)
    ap.add_argument("--stage2-epochs", type=int, default=60)
    ap.add_argument("--lr",            type=float, default=3e-3)
    ap.add_argument("--lam-aux",       type=float, default=1.0)
    ap.add_argument("--val-frac",      type=float, default=0.25)
    ap.add_argument("--no-pretrain",   action="store_true",
                    help="skip Stage 1 (pretrain) to produce the baseline ablation")
    ap.add_argument("--prefer-source", default=None,
                    help="prefer real-cell labels whose `source` starts with this "
                         "prefix (e.g. 'pybamm_sim_real_matched' to use the new "
                         "PyBaMM-matched real-cell labels over older analytical_fit)")
    ap.add_argument("--out",           default=None)
    ap.add_argument("--use-spectral",  action="store_true",
                    help="concatenate 42-dim spectral/wavelet features to backbone "
                         "embedding before the internal-state head (ablation row)")
    args = ap.parse_args()

    from train_internal_state_head import train_real, _build_real_dataset
    syn_path = Path(args.synthetic) if args.synthetic else (
        Path(__file__).resolve().parent.parent.parent
        / "processed" / "internal_state_head" / "synthetic_cells.json"
    )
    out_dir = Path(args.out) if args.out else (
        Path(__file__).resolve().parent.parent.parent
        / "processed" / "internal_state_head"
    )
    stage1_dir = out_dir / "stage1"
    stage2_dir = out_dir / "stage2"
    stage1_dir.mkdir(parents=True, exist_ok=True)
    stage2_dir.mkdir(parents=True, exist_ok=True)

    head_init = None
    s1_metrics = None
    t0 = time.time()

    if not args.no_pretrain:
        if not syn_path.exists():
            print(f"synthetic dataset missing at {syn_path} — run "
                  f"scripts/cache_pybamm_synthetic_cells.py first")
            sys.exit(2)

        print(f"\n──── Stage 1: pretrain on synthetic ({syn_path.name}) ────")
        syn_ds = _build_synthetic_dataset(syn_path)
        print(f"  n synthetic cells: {len(syn_ds['cells'])}  "
              f"chemistries: {sorted(syn_ds['chem_scalers'])}")
        s1_metrics = train_real(
            epochs=args.stage1_epochs, lr=args.lr, lam_aux=args.lam_aux,
            freeze_backbone=True, batch_size=32, val_frac=0.2, lam_phys=0.0,
            out_dir=stage1_dir, dataset=syn_ds,
        )
        print(f"  Stage-1 val_loss: {s1_metrics['final_val_loss']}")
        # head weights to carry into Stage 2
        import torch
        ck = torch.load(s1_metrics["checkpoint"], weights_only=False)
        head_init = copy.deepcopy(ck["head_state_dict"])

    print(f"\n──── Stage 2: fine-tune on REAL cells ────")
    real_ds = _build_real_dataset(prefer_source=args.prefer_source,
                                   use_spectral=args.use_spectral) \
              if (args.prefer_source or args.use_spectral) else None
    if real_ds is not None:
        from collections import Counter
        print(f"  prefer_source={args.prefer_source} → "
              f"{len(real_ds['cells'])} real cells. "
              f"chems: {Counter(int(c) for c in real_ds['chem'])}")
    s2_metrics = train_real(
        epochs=args.stage2_epochs, lr=args.lr / 3, lam_aux=args.lam_aux,
        freeze_backbone=True, batch_size=32, val_frac=args.val_frac, lam_phys=0.0,
        out_dir=stage2_dir, head_init_state_dict=head_init,
        dataset=real_ds, use_spectral=args.use_spectral,
    )
    print(f"  Stage-2 val_loss: {s2_metrics['final_val_loss']}")
    print(f"  RUL/SOH MAE: {s2_metrics['val_report']['rul_mae_norm']} / "
          f"{s2_metrics['val_report']['soh_mae']}")

    # Print headline transfer table
    vr = s2_metrics["val_report"]
    keys = ("k_sei", "sei_thickness_nm", "cycles_to_eol", "lli_fraction",
            "lam_fraction", "k_crack", "Q0", "alpha")
    print(f"\n══ Stage-2 per-chemistry R² (after transfer from synthetic Stage-1) ══")
    print(f"  {'chem':<5} {'n':>3}   " + "  ".join(f"{k[:9]:>9s}" for k in keys))
    for chem, kv in sorted((vr.get("per_chemistry") or {}).items()):
        cells = []
        for k in keys:
            r = kv["per_key"][k]["r2"]
            cells.append(f"{r:+.2f}".rjust(9) if isinstance(r, (int, float)) else "    n/a")
        print(f"  {chem:<5} {kv['n']:>3}   " + "  ".join(cells))

    # Save consolidated report
    report = {
        "stage1": s1_metrics, "stage2": s2_metrics,
        "elapsed_s": round(time.time() - t0, 2),
        "no_pretrain": args.no_pretrain,
    }
    (out_dir / "two_stage_report.json").write_text(json.dumps(report, indent=2, default=str))
    print(f"\nfull report → {out_dir / 'two_stage_report.json'}")
    print(f"total elapsed: {report['elapsed_s']}s")


if __name__ == "__main__":
    main()

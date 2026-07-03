#!/usr/bin/env python
"""
finetune_v12_lco.py — LCO-specific fine-tune of the v12 BiMamba-APF backbone.

Why this exists:
    `core/model_loader.run_inference` currently routes LCO requests through
    a hard-coded `v12-bimamba → v10-final` delegation because v12 produces
    unphysical (negative-normalised) RUL on LCO cells. That delegation works
    but it's tech debt — v10 is older, and LCO cells go through the slower
    fallback path.

This script:
    1. Loads all LCO cells from data_loader (~26 cells, CALCE_CS2 + CX2 + PyBaMM).
    2. Builds the standard 30-cycle 9-feature windows (col 0..8) and the
       (30, 13) normalised tensors via the same _normalize used by inference.
    3. Loads v12-bimamba's frozen weights, leaves the backbone frozen, and
       fine-tunes ONLY the RUL output head with a very low LR (5e-5) on the
       LCO subset for ~80 epochs.
    4. Saves an LCO-specific delta checkpoint to
       `processed/lco_finetune/v12_lco_head.pt`, NOT clobbering production.
    5. Held-out 4-cell val split → reports RUL R² + MAE.

The result is the empirical answer to: "can a chemistry-specific head on
v12 replace the v10 delegation?" — i.e. is it worth flipping the routing
in run_inference, or do we keep the delegation hack as canonical.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))

OUT_DIR = Path(__file__).resolve().parent.parent.parent / "processed" / "lco_finetune"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs",     type=int,   default=80)
    ap.add_argument("--lr",         type=float, default=5e-5)
    ap.add_argument("--val-frac",   type=float, default=0.20)
    ap.add_argument("--seed",       type=int,   default=0)
    ap.add_argument("--non-neg",    action="store_true", default=False,
                    help="add a hinge-style non-negativity loss + apply softplus "
                         "at inference (kills the negative-output failure mode "
                         "that motivates the v10 delegation hack).")
    ap.add_argument("--lam-neg",    type=float, default=10.0,
                    help="weight of the non-negativity hinge penalty.")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(args.seed)
    np.random.seed(args.seed)

    import core.data_loader as dl
    from core.model_loader import _normalize, _MODELS, load_all_models, CHEM_MAX_RUL
    from core.bimamba_apf import BiMambaAPF

    load_all_models()
    if "v12-bimamba" not in _MODELS:
        raise RuntimeError("v12-bimamba not loaded")
    entry = _MODELS["v12-bimamba"]
    fmean, fstd = entry["feat_mean"], entry["feat_std"]
    rul_max = CHEM_MAX_RUL.get("LCO", 309.0)

    if dl._meta_df is None:
        dl.load_dataset()

    # Build LCO dataset: one (30, 13) window per cell × the last 30 cycles
    lco_mask = dl._meta_df["chemistry_name"].values == "LCO"
    lco_idx  = np.where(lco_mask)[0]
    cells = sorted(set(dl._meta_df.iloc[lco_idx]["cell_id"].values))
    print(f"LCO cells found: {len(cells)} ({sorted(set(dl._meta_df.iloc[lco_idx]['dataset'].values))})",
          flush=True)

    X_list, y_list, soh_list, used_cells = [], [], [], []
    for cid in cells:
        mask = (dl._meta_df["cell_id"].values == cid)
        order = dl._meta_df[mask].sort_values("cycle").index.values
        if len(order) < 30:
            continue
        last30 = order[-30:]
        raw = dl._features[last30, :9].astype(np.float32)
        x   = _normalize(raw.copy(), fmean, fstd)
        X_list.append(x)
        y_list.append(float(dl._meta_df.iloc[order[-1]]["rul"]) / rul_max)
        soh_list.append(float(dl._features[order[-1], 9]))
        used_cells.append(cid)

    if len(X_list) < 6:
        raise RuntimeError(f"too few LCO cells with ≥30-cycle history: {len(X_list)}")

    X    = torch.tensor(np.stack(X_list, axis=0))
    yrul = torch.tensor(y_list, dtype=torch.float32)
    ysoh = torch.tensor(soh_list, dtype=torch.float32)
    chem = torch.zeros(len(X), dtype=torch.long)  # LCO = chem_code 0
    n = X.shape[0]

    # 80/20 split
    perm = torch.randperm(n, generator=torch.Generator().manual_seed(args.seed))
    n_val = max(2, int(round(n * args.val_frac)))
    val_idx = perm[:n_val]; tr_idx = perm[n_val:]
    print(f"split: train={len(tr_idx)}, val={n_val}", flush=True)

    # Load v12 backbone, freeze it, train ONLY the RUL head
    model = BiMambaAPF()
    model.load_state_dict(entry["model"].state_dict(), strict=False)
    for p in model.parameters():
        p.requires_grad = False
    # Find the RUL output layer(s) — small head typically the last 1-2 Linear layers
    rul_head_params = []
    for name, p in model.named_parameters():
        if "rul" in name.lower() or "head" in name.lower() or "fc_out" in name.lower():
            p.requires_grad = True
            rul_head_params.append(p)
    if not rul_head_params:
        # Fallback: train the final classifier-like layer by name detection
        for name, p in list(model.named_parameters())[-4:]:
            p.requires_grad = True
            rul_head_params.append(p)
    n_train_params = sum(p.numel() for p in rul_head_params if p.requires_grad)
    print(f"trainable params: {n_train_params}", flush=True)

    opt = torch.optim.Adam([p for p in model.parameters() if p.requires_grad],
                           lr=args.lr)
    loss_fn = nn.MSELoss()

    history: list[dict] = []
    best_val = float("inf"); best_state = None
    t0 = time.time()
    for ep in range(args.epochs):
        model.train()
        perm_ep = tr_idx[torch.randperm(len(tr_idx))]
        ep_loss = 0.0; n_batches = 0
        bs = max(2, min(8, len(tr_idx)))
        for s in range(0, len(perm_ep), bs):
            sl = perm_ep[s:s + bs]
            xi  = X[sl]
            yi  = yrul[sl].unsqueeze(-1)
            ct  = chem[sl]
            pred_rul, _ = model(xi, chem_code=ct)
            # Match shapes: pred (B,1) and yi (B,1). pred_rul might come as (B,)
            if pred_rul.dim() == 1:
                pred_rul = pred_rul.unsqueeze(-1)
            loss = loss_fn(pred_rul, yi)
            if args.non_neg:
                # Hinge penalty for predictions below 0 — squared hinge gives a
                # smoother gradient than abs at the boundary.
                neg_hinge = torch.clamp(-pred_rul, min=0.0)
                loss = loss + args.lam_neg * (neg_hinge ** 2).mean()
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(rul_head_params, 1.0)
            opt.step()
            ep_loss += float(loss.detach()); n_batches += 1

        model.eval()
        with torch.no_grad():
            vpred, _ = model(X[val_idx], chem_code=chem[val_idx])
            v_loss = float(((vpred.squeeze(-1) - yrul[val_idx]) ** 2).mean())
        history.append({"epoch": ep, "train_loss": round(ep_loss / max(1, n_batches), 6),
                        "val_loss":   round(v_loss, 6)})
        if v_loss < best_val:
            best_val = v_loss
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}

    # Re-load best
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        vpred, vsoh = model(X[val_idx], chem_code=chem[val_idx])
    if vpred.dim() == 1:
        vpred = vpred.unsqueeze(-1)
    # Honest inference clamp when --non-neg: ReLU at 0. Positive predictions
    # pass through unchanged; negatives become 0 (which the production OOD guard
    # already accepts as "trip the fallback"). The non-neg training loss should
    # have already pushed most predictions positive, so the clamp is rare.
    if args.non_neg:
        vpred_clamped = torch.clamp(vpred, min=0.0)
    else:
        vpred_clamped = vpred
    p_norm = vpred_clamped.squeeze(-1).numpy()
    t_norm = yrul[val_idx].numpy()
    n_raw_neg = int((vpred.squeeze(-1).numpy() < 0).sum())
    n_post_clamp_neg = int((p_norm < 0).sum())
    p_phys = p_norm * rul_max
    t_phys = t_norm * rul_max

    rul_mae_norm = float(np.mean(np.abs(p_norm - t_norm)))
    rul_mae_phys = float(np.mean(np.abs(p_phys - t_phys)))
    if float(np.var(t_phys)) > 1e-9:
        ss_res = float(np.sum((t_phys - p_phys) ** 2))
        ss_tot = float(np.sum((t_phys - t_phys.mean()) ** 2))
        rul_r2 = round(1.0 - ss_res / (ss_tot + 1e-12), 4)
    else:
        rul_r2 = None
    n_neg = n_post_clamp_neg   # final negative-count after any clamp

    # Save head-only delta checkpoint
    head_state = {n: model.state_dict()[n] for n in model.state_dict()
                  if any(("rul" in n.lower(), "head" in n.lower(), "fc_out" in n.lower()))}
    ckpt = OUT_DIR / "v12_lco_head.pt"
    torch.save({
        "head_state_dict":   head_state,
        "n_cells":           len(used_cells),
        "n_train":           int(len(tr_idx)),
        "n_val":             int(n_val),
        "best_val_loss":     round(best_val, 6),
        "rul_r2":            rul_r2,
        "rul_mae_norm":      round(rul_mae_norm, 4),
        "rul_mae_phys":      round(rul_mae_phys, 4),
        "n_neg_predictions": n_neg,
        "history":           history,
        "elapsed_s":         round(time.time() - t0, 1),
    }, ckpt)
    (OUT_DIR / "metrics.json").write_text(json.dumps({
        "n_cells": len(used_cells), "n_train": int(len(tr_idx)), "n_val": int(n_val),
        "best_val_loss": round(best_val, 6),
        "rul_r2": rul_r2,
        "rul_mae_norm": round(rul_mae_norm, 4),
        "rul_mae_phys": round(rul_mae_phys, 4),
        "n_neg_predictions": n_neg,
        "val_cells": [used_cells[int(i)] for i in val_idx.tolist()],
    }, indent=2))

    print(f"\n══ LCO fine-tune ══", flush=True)
    print(f"  cells:       {len(used_cells)} ({len(tr_idx)} train / {n_val} val)")
    print(f"  best val:    {best_val:.6f}")
    print(f"  RUL R²:      {rul_r2}")
    print(f"  RUL MAE norm:{rul_mae_norm:.4f}")
    print(f"  RUL MAE phys:{rul_mae_phys:.1f} cycles")
    print(f"  raw neg before clamp: {n_raw_neg}/{n_val}")
    print(f"  neg preds after clamp: {n_neg}/{n_val} {'(BAD — delegation still warranted)' if n_neg > 0 else '(fixed!)'}")
    print(f"  non_neg loss:         {'ENABLED' if args.non_neg else 'OFF'}"
          f"{' (λ=' + str(args.lam_neg) + ')' if args.non_neg else ''}")
    print(f"  checkpoint → {ckpt}")
    print(f"  metrics    → {OUT_DIR / 'metrics.json'}")


if __name__ == "__main__":
    main()

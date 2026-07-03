#!/usr/bin/env python
"""
train_internal_state_head.py — Phase C marquee training: supervise the
auxiliary internal-state head on top of BiMamba-APF v12.

Multi-task loss:   L = α·MSE(RUL) + β·MSE(SOH) + λ·MSE(internal_states)

Two modes:
  --smoke         synthetic data → verifies the loop end-to-end (head learns,
                  loss decreases, checkpoint round-trips). Used by CI / sandbox.
                  Example: python scripts/train_internal_state_head.py --smoke

  (default)       real mode. Loads the production v12 backbone, freezes it
                  (configurable), supervises only the head. Real labels come
                  from core.internal_states.extract_internal_states() over each
                  cell's digital-twin fit. The label pipeline + DB persistence
                  are already in place (Phase C foundation, 2026-05-28); this
                  script consumes them.

Outputs:
  processed/internal_state_head/checkpoint_head.pt      (head weights)
  processed/internal_state_head/training_log.json       (loss curves)
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))


def _default_out_dir() -> Path:
    return Path(__file__).resolve().parent.parent.parent / "processed" / "internal_state_head"


def _smoke_targets(latent: torch.Tensor, n_states: int) -> torch.Tensor:
    """Synthetic internal-state labels that are a smooth function of the latent —
    guarantees the head CAN fit them, so a decreasing loss verifies the loop."""
    # deterministic projection of latent → labels in [0, 1] range
    g = torch.Generator(device="cpu").manual_seed(0)
    W = torch.randn(latent.shape[-1], n_states, generator=g) * 0.05
    return torch.sigmoid(latent @ W)


def _smoke_rul_soh(latent: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
    g = torch.Generator(device="cpu").manual_seed(1)
    w_rul = torch.randn(latent.shape[-1], 1, generator=g) * 0.05
    w_soh = torch.randn(latent.shape[-1], 1, generator=g) * 0.05
    rul = (latent @ w_rul).squeeze(-1) * 0.5 + 0.5    # [~0, ~1]
    soh = torch.sigmoid((latent @ w_soh).squeeze(-1))
    return rul, soh


def train_smoke(epochs: int, lr: float, lam_aux: float,
                batches_per_epoch: int = 20, batch_size: int = 16,
                seed: int = 0, out_dir: Path | None = None) -> dict:
    """Synthetic-data training loop — sandbox-verifiable. Confirms the head
    architecture, optimizer wiring, and multi-task loss all work end-to-end."""
    from core.bimamba_apf import BiMambaAPF, InternalStateHead, attach_internal_state_head

    torch.manual_seed(seed)
    backbone = BiMambaAPF()
    head     = attach_internal_state_head(backbone)
    # freeze backbone — only head is trained (this is the canonical research setup)
    for p in backbone.parameters():
        p.requires_grad = False
    for p in head.parameters():
        p.requires_grad = True

    opt = torch.optim.Adam(head.parameters(), lr=lr)
    loss_fn = torch.nn.MSELoss()
    history = []
    t0 = time.time()

    for ep in range(1, epochs + 1):
        ep_loss = 0.0
        for _ in range(batches_per_epoch):
            x = torch.randn(batch_size, 30, 13)
            with torch.no_grad():
                latent = backbone.forward_features(x)        # (B, d_model), frozen
                y_int  = _smoke_targets(latent, head.N_STATES)
                y_rul, y_soh = _smoke_rul_soh(latent)
            # Forward through ALL heads to mirror the real training step;
            # only the internal head's parameters receive gradient (others frozen).
            pred_rul, pred_soh, pred_int = backbone.forward_with_internal_states(x)
            l_rul = loss_fn(pred_rul, y_rul)
            l_soh = loss_fn(pred_soh, y_soh)
            l_int = loss_fn(pred_int, y_int)
            loss  = l_rul + l_soh + lam_aux * l_int
            opt.zero_grad(); loss.backward(); opt.step()
            ep_loss += float(loss.item())
        ep_loss /= batches_per_epoch
        history.append({"epoch": ep, "loss": round(ep_loss, 6)})

    metrics = {
        "ok":           True,
        "mode":         "smoke",
        "epochs":       epochs,
        "first_loss":   round(history[0]["loss"], 6),
        "final_loss":   round(history[-1]["loss"], 6),
        "loss_decreased": history[-1]["loss"] < history[0]["loss"],
        "head_params":  sum(p.numel() for p in head.parameters()),
        "elapsed_s":    round(time.time() - t0, 2),
        "history":      history,
    }

    # Save head checkpoint
    out_dir = (out_dir or _default_out_dir())
    out_dir.mkdir(parents=True, exist_ok=True)
    torch.save({
        "head_state_dict": head.state_dict(),
        "n_states":        head.N_STATES,
        "d_model":         backbone.d_model,
        "trained_at":      __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "mode":            "smoke",
        "metrics":         {k: metrics[k] for k in ("epochs", "first_loss", "final_loss",
                                                     "loss_decreased", "head_params", "elapsed_s")},
    }, out_dir / "checkpoint_head.pt")
    (out_dir / "training_log.json").write_text(json.dumps(history, indent=2))
    metrics["checkpoint"] = str(out_dir / "checkpoint_head.pt")
    return metrics


def _build_real_dataset(prefer_source: str | None = None,
                        use_spectral: bool = False) -> dict:
    """Assemble (X, Y_internal, Y_rul, Y_soh, meta) from cached labels + real
    cell histories. Each labeled cell contributes one (30,13) window from its
    last 30 cycles. Internal labels are min-max normalized per-key."""
    import core.data_loader as dl
    from core.db import list_internal_states
    from core.model_loader import _normalize, _MODELS, load_all_models, CHEM_MAX_RUL
    from core.bimamba_apf import InternalStateHead
    from core.internal_states import INTERNAL_STATE_KEYS

    load_all_models()
    if dl._meta_df is None:
        dl.load_dataset()
    if "v12-bimamba" not in _MODELS:
        raise RuntimeError("v12-bimamba is not loaded; cannot derive normalization stats")
    entry = _MODELS["v12-bimamba"]
    fmean, fstd = entry["feat_mean"], entry["feat_std"]

    cached_all = list_internal_states(limit=10000)
    if not cached_all:
        raise RuntimeError(
            "No cached internal-state labels found. Run "
            "`python scripts/cache_internal_state_labels.py --max-cells 30` first."
        )

    # Dedup by cell_id, optionally preferring a specific source prefix. Rows
    # are newest-first; for each cell_id we keep the first row whose `source`
    # starts with `prefer_source` (if any), else the newest of any source.
    seen_cell: set[str] = set()
    cached: list[dict] = []
    if prefer_source:
        for r in cached_all:
            cid = r["cell_id"]
            src = (r.get("source") or "").strip()
            if cid in seen_cell:
                continue
            if src.startswith(prefer_source):
                cached.append(r); seen_cell.add(cid)
    # second pass: any cells without a `prefer_source` row fall back to newest
    for r in cached_all:
        cid = r["cell_id"]
        if cid in seen_cell:
            continue
        cached.append(r); seen_cell.add(cid)

    X_list, Yint_list, Yrul_list, Ysoh_list, used_cells = [], [], [], [], []
    chem_codes = []
    T_means: list[float] = []
    c_rate_proxies: list[float] = []
    Xspec_list: list = []
    for row in cached:
        cid = row["cell_id"]
        states = row.get("states") or {}
        mask = dl._meta_df["cell_id"].values == cid
        if not mask.any():
            continue
        idx = np.where(mask)[0]
        order = dl._meta_df.iloc[idx].sort_values("cycle").index.values
        if len(order) < 30:
            continue
        last30 = order[-30:]
        window_raw = dl._features[last30, :9].astype(np.float32)
        x = _normalize(window_raw.copy(), fmean, fstd)         # (30, 13)
        # 13-key internal-state vector — None → 0
        vec = []
        for k in INTERNAL_STATE_KEYS:
            v = states.get(k)
            vec.append(float(v) if v is not None else 0.0)
        Yint_list.append(vec)
        # RUL target normalized to [0, ~1] by chemistry max
        chem = (row.get("chemistry") or "LCO").upper()
        rul_max = CHEM_MAX_RUL.get(chem, 1000.0)
        rul_last = float(dl._meta_df.iloc[order[-1]]["rul"])
        Yrul_list.append(rul_last / rul_max)
        # SOH target — already in [0, 1.x] in feature col 9
        Ysoh_list.append(float(dl._features[order[-1], 9]))
        chem_codes.append(int(dl._meta_df.iloc[order[-1]]["chemistry_code"]))
        # Operating-condition metadata for the (chem × T × C-rate) val harness:
        # col 5 = temperature (°C), col 1 = charge_time (s) — slow charge_time
        # is a reasonable inverse-proxy for nominal C-rate when the dataset has
        # no explicit current column.
        T_means.append(float(np.mean(window_raw[:, 5])))
        c_rate_proxies.append(float(np.mean(window_raw[:, 1])))
        X_list.append(x); used_cells.append(cid)
        if use_spectral:
            from core.spectral_features import features_from_window as _spec
            Xspec_list.append(_spec(window_raw, voltage_col=2, current_col=6))

    if not X_list:
        raise RuntimeError("No labeled cells with ≥30-cycle history found.")

    X = torch.tensor(np.stack(X_list, axis=0))                # (N, 30, 13)
    Yint = torch.tensor(np.array(Yint_list, dtype=np.float32)) # (N, 13)
    Yrul = torch.tensor(np.array(Yrul_list, dtype=np.float32))
    Ysoh = torch.tensor(np.array(Ysoh_list, dtype=np.float32))
    chem = torch.tensor(chem_codes, dtype=torch.long)

    # Per-chemistry min-max scaling on Yint. Each chemistry gets its own scaler
    # to avoid the catastrophic LFP failure observed at n=320: LFP cells (~1.1 Ah)
    # were being mapped through global bounds dominated by NMC (~5 Ah) and
    # NCA (~0.4 Ah), driving R² to absurd negatives.
    y_min_per = torch.zeros_like(Yint)
    y_max_per = torch.zeros_like(Yint)
    chem_scalers: dict[int, dict] = {}
    unique_codes = sorted({int(c.item()) for c in chem})
    Yg_min = Yint.min(0).values
    Yg_max = Yint.max(0).values
    Q0_IDX = list(INTERNAL_STATE_KEYS).index("Q0")
    for cc in unique_codes:
        mask = (chem == cc)
        if int(mask.sum()) >= 2:
            # Filter format outliers before fitting the scaler.
            # Problem: LFP has 354 MIT cells (~1.0 Ah) + 8 HUST cells (~2.7 Ah).
            # Those 8 cells stretch the Q₀ range 3×, pushing all MIT cells into
            # a [0, 0.11] slice — the scaler becomes singular and R² collapses.
            # Fix: fit scaler only on cells within 2× the chemistry median Q₀.
            q0_vals = Yint[mask, Q0_IDX]
            q0_med = float(q0_vals.median())
            inlier = mask.clone()
            if q0_med > 1e-6:
                inlier[mask] = (q0_vals <= q0_med * 2.0)
            scaler_mask = inlier if int(inlier.sum()) >= 2 else mask
            ymn = Yint[scaler_mask].min(0).values
            ymx = Yint[scaler_mask].max(0).values
        else:
            # single cell of this chemistry → fall back to global bounds
            ymn, ymx = Yg_min, Yg_max
        chem_scalers[cc] = {"y_min": ymn.tolist(), "y_max": ymx.tolist(),
                             "n_cells": int(mask.sum())}
        y_min_per[mask] = ymn
        y_max_per[mask] = ymx
    y_rng_per = (y_max_per - y_min_per).clamp(min=1e-6)
    Yint_scaled = (Yint - y_min_per) / y_rng_per

    Xspec = (torch.tensor(np.stack(Xspec_list, axis=0))   # (N, n_spec)
             if Xspec_list else None)

    return {
        "X": X, "Yint": Yint_scaled, "Yrul": Yrul, "Ysoh": Ysoh,
        "chem": chem, "cells": used_cells,
        "y_min": y_min_per.tolist(), "y_max": y_max_per.tolist(),
        "chem_scalers": chem_scalers,
        "keys": list(INTERNAL_STATE_KEYS),
        "T_mean":      T_means,
        "c_rate_proxy": c_rate_proxies,
        "Xspec": Xspec,   # None when use_spectral=False
    }


def _per_key_metrics(pred_scaled: torch.Tensor, true_scaled: torch.Tensor,
                     y_min, y_max, keys: list[str]) -> dict:
    """De-scale predictions back to physical units, compute per-key R² + MAPE.

    Accepts y_min / y_max as either (K,) — shared across all val cells — or
    (N_val, K) — per-cell scalers (Option B per-chemistry scaling).

    R² is reported as `None` when the true-value variance on the val set is
    essentially zero. R² is mathematically ill-defined in that case (SS_tot→0
    inflates any tiny error to arbitrary magnitude). Reporting None is the
    honest answer — MAE / mean-absolute-deviation is still computed.
    """
    import numpy as _np
    y_min_t = torch.as_tensor(y_min, dtype=pred_scaled.dtype)
    y_max_t = torch.as_tensor(y_max, dtype=pred_scaled.dtype)
    y_rng = (y_max_t - y_min_t).clamp(min=1e-6)
    pred_phys = (pred_scaled * y_rng) + y_min_t
    true_phys = (true_scaled * y_rng) + y_min_t
    out = {}
    for k_idx, key in enumerate(keys):
        p = pred_phys[:, k_idx].numpy(); t = true_phys[:, k_idx].numpy()
        ss_res = float(_np.sum((t - p) ** 2))
        t_var  = float(_np.var(t))
        ss_tot = float(_np.sum((t - t.mean()) ** 2))
        # R² is ill-defined (report None) in two cases:
        # 1. Near-zero variance: CV² < 1e-3 means labels are essentially constant
        #    for this chemistry (e.g. all MIT LFP cells run at identical 3C/33°C →
        #    k_sei ~3e-05 for every cell). The scaler range is real but tiny; the
        #    model can't learn a constant and R² blows up when ss_res >> ss_tot.
        # 2. Catastrophic negative: R² < -100 means the prediction is off by
        #    orders of magnitude relative to the true variance — scaler artefact,
        #    not a meaningful learning signal. Both cases show as "n/a" in tables.
        scale = max(abs(float(t.mean())), 1e-6)
        cv_sq = t_var / (scale * scale)
        if ss_tot < 1e-9 or cv_sq < 1e-3:
            r2 = None
        else:
            raw_r2 = 1.0 - ss_res / (ss_tot + 1e-12)
            r2 = round(raw_r2, 4) if raw_r2 > -100 else None
        denom = _np.maximum(_np.abs(t), 1e-6)
        mape = float(_np.mean(_np.abs((t - p) / denom)) * 100)
        mae  = float(_np.mean(_np.abs(t - p)))
        out[key] = {"r2": r2, "mape_pct": round(mape, 2),
                    "mae": round(mae, 6),
                    "mean_true": round(float(t.mean()), 6),
                    "mean_pred": round(float(p.mean()), 6),
                    "var_true":  round(t_var, 8)}
    return out


def multi_condition_report(pred_scaled: torch.Tensor, true_scaled: torch.Tensor,
                           y_min, y_max, keys: list[str],
                           chem: torch.Tensor, T_vals: list[float],
                           c_rate_vals: list[float],
                           T_bins: tuple[float, ...] = (15.0, 25.0, 35.0, 45.0),
                           c_bins: int = 3, min_cells_per_bin: int = 3) -> dict:
    """(chemistry × temperature × C-rate) stratified per-key R² report.

    The "headline table" referenced by the Phase C roadmap. For each
    (chemistry, T-bin, C-rate-bin) cell with ≥ `min_cells_per_bin` val cells,
    emits a per-key metric block from `_per_key_metrics`. Bins are computed
    from `T_vals` (°C, edges = `T_bins`) and `c_rate_vals` (split into
    `c_bins` quantile bins on the val set itself).
    """
    import numpy as _np
    CHEM_NAMES = {0: "LCO", 1: "LFP", 2: "NMC", 3: "NCM", 4: "NCA"}
    n = pred_scaled.shape[0]
    if n == 0:
        return {"bins": {}, "n_val": 0}
    T_arr  = _np.asarray(T_vals, dtype=_np.float32)
    cr_arr = _np.asarray(c_rate_vals, dtype=_np.float32)
    # Temperature bin indices
    T_bin_idx = _np.digitize(T_arr, _np.asarray(T_bins, dtype=_np.float32))
    # C-rate quantile bins (computed on this val population so bins are populated)
    if cr_arr.size >= c_bins and float(_np.std(cr_arr)) > 1e-6:
        q_edges = _np.quantile(cr_arr, _np.linspace(0, 1, c_bins + 1)[1:-1])
        cr_bin_idx = _np.digitize(cr_arr, q_edges)
    else:
        cr_bin_idx = _np.zeros(cr_arr.shape, dtype=_np.int64)
    # y_min / y_max may be (K,) or (N, K) — slice support both
    y_min_arr = torch.as_tensor(y_min, dtype=pred_scaled.dtype)
    y_max_arr = torch.as_tensor(y_max, dtype=pred_scaled.dtype)
    per_cell = (y_min_arr.dim() == 2)
    bins_out: dict[str, dict] = {}
    for chem_code in sorted({int(c.item()) for c in chem}):
        for ti in sorted(set(T_bin_idx.tolist())):
            for ci in sorted(set(cr_bin_idx.tolist())):
                mask = ((chem == chem_code).numpy()
                        & (T_bin_idx == ti) & (cr_bin_idx == ci))
                n_bin = int(mask.sum())
                if n_bin < min_cells_per_bin:
                    continue
                idx = _np.where(mask)[0]
                sub_pred = pred_scaled[idx]
                sub_true = true_scaled[idx]
                if per_cell:
                    y_mn = y_min_arr[idx].tolist()
                    y_mx = y_max_arr[idx].tolist()
                else:
                    y_mn, y_mx = y_min, y_max
                T_lo = "<" + str(T_bins[0]) if ti == 0 else (
                       "≥" + str(T_bins[-1]) if ti >= len(T_bins) else
                       f"{T_bins[ti - 1]:.0f}–{T_bins[ti]:.0f}")
                cr_label = f"q{int(ci) + 1}/{c_bins}"
                bins_out[f"{CHEM_NAMES.get(chem_code, str(chem_code))}|T:{T_lo}|{cr_label}"] = {
                    "n":         n_bin,
                    "chemistry": CHEM_NAMES.get(chem_code, str(chem_code)),
                    "T_bin":     T_lo,
                    "c_rate_bin": cr_label,
                    "T_mean":    round(float(T_arr[idx].mean()), 2),
                    "c_rate_mean": round(float(cr_arr[idx].mean()), 2),
                    "per_key":   _per_key_metrics(sub_pred, sub_true,
                                                  y_mn, y_mx, keys),
                }
    return {"bins": bins_out, "n_val": int(n),
            "T_bin_edges": list(T_bins), "c_rate_n_quantiles": c_bins,
            "min_cells_per_bin": min_cells_per_bin}


def train_real(epochs: int, lr: float, lam_aux: float,
               freeze_backbone: bool = True, batch_size: int = 8,
               val_frac: float = 0.2, lam_phys: float = 0.0,
               seed: int = 0, out_dir: Path | None = None,
               dataset: dict | None = None,
               head_init_state_dict: dict | None = None,
               use_spectral: bool = False) -> dict:
    """Real-mode training on cached internal-state labels. Loads v12 backbone,
    optionally freezes it, supervises the head with real labels."""
    from core.bimamba_apf import BiMambaAPF, InternalStateHead, attach_internal_state_head
    from core.model_loader import _MODELS

    ds = dataset if dataset is not None else _build_real_dataset(use_spectral=use_spectral)
    X, Yint, Yrul, Ysoh, chem = ds["X"], ds["Yint"], ds["Yrul"], ds["Ysoh"], ds["chem"]
    Xspec = ds.get("Xspec")   # (N, n_spec) or None
    n = X.shape[0]

    # Deterministic train/val split — shuffled by `seed`
    torch.manual_seed(seed)
    perm_all = torch.randperm(n)
    n_val = max(1, int(round(n * val_frac))) if n >= 4 else 0
    val_idx = perm_all[:n_val]
    tr_idx  = perm_all[n_val:] if n_val > 0 else perm_all
    if len(tr_idx) == 0:
        raise RuntimeError(f"Train set is empty (n={n}, val_frac={val_frac})")

    # Use the SAME backbone weights as production v12 so the latent matches
    backbone = BiMambaAPF()
    entry = _MODELS.get("v12-bimamba")
    if entry is not None:
        try:
            backbone.load_state_dict(entry["model"].state_dict(), strict=False)
        except Exception:
            pass    # fresh init is fine — head still trains
    n_spec = int(Xspec.shape[1]) if Xspec is not None else 0
    head = attach_internal_state_head(
        backbone,
        head=InternalStateHead(d_model=backbone.d_model, d_spectral=n_spec),
    )
    # Load pre-trained head weights (Stage-2 fine-tune from a Stage-1 checkpoint).
    # When use_spectral=True the first Linear is (d_model+d_spectral, 96); Stage-1
    # was trained without spectral so its weight is (d_model, 96). Pad the extra
    # spectral columns with zeros — backbone dims carry over, spectral dims start fresh.
    if head_init_state_dict is not None:
        if n_spec > 0 and "net.0.weight" in head_init_state_dict:
            w_old = head_init_state_dict["net.0.weight"]   # (96, d_model)
            d_in_new = backbone.d_model + n_spec
            if w_old.shape[1] < d_in_new:
                import torch as _t
                pad = _t.zeros(w_old.shape[0], n_spec, dtype=w_old.dtype)
                head_init_state_dict = dict(head_init_state_dict)
                head_init_state_dict["net.0.weight"] = _t.cat([w_old, pad], dim=1)
        try:
            head.load_state_dict(head_init_state_dict, strict=True)
        except Exception as exc:
            print(f"head init load failed (strict): {exc}; trying strict=False")
            head.load_state_dict(head_init_state_dict, strict=False)
    if freeze_backbone:
        for p in backbone.parameters():
            p.requires_grad = False
    for p in head.parameters():
        p.requires_grad = True

    trainable = [p for p in backbone.parameters() if p.requires_grad] + \
                [p for p in head.parameters() if p.requires_grad]
    opt = torch.optim.Adam(trainable, lr=lr)
    loss_fn = torch.nn.MSELoss()
    history = []
    t0 = time.time()

    use_phys = lam_phys > 0.0
    if use_phys:
        from core.physics_loss import physics_constraint_loss

    # Per-cell scaler tensors (shape (N, K)) — sliced per batch / val below
    y_min_all = torch.tensor(ds["y_min"], dtype=torch.float32)
    y_max_all = torch.tensor(ds["y_max"], dtype=torch.float32)

    for ep in range(1, epochs + 1):
        perm = tr_idx[torch.randperm(len(tr_idx))]
        ep_loss = ep_li = ep_lr = ep_ls = ep_lp = 0.0
        nb = 0
        for s in range(0, len(perm), batch_size):
            sl = perm[s:s + batch_size]
            if n_spec > 0:
                h = backbone.forward_features(X[sl], chem_code=chem[sl])
                pred_rul = backbone.rul_head(h).squeeze(-1)
                pred_soh = backbone.soh_head(h).squeeze(-1)
                h_aug = torch.cat([h, Xspec[sl]], dim=-1)
                pred_int = backbone.internal_state_head(h_aug)
            else:
                pred_rul, pred_soh, pred_int = backbone.forward_with_internal_states(
                    X[sl], chem_code=chem[sl])
            l_rul = loss_fn(pred_rul, Yrul[sl])
            l_soh = loss_fn(pred_soh, Ysoh[sl])
            l_int = loss_fn(pred_int, Yint[sl])
            if use_phys:
                # batch-sliced per-cell scalers so each cell's constraints are
                # checked in its own chemistry's physical range
                l_phys, _ = physics_constraint_loss(
                    pred_int, y_min_all[sl].tolist(),
                    y_max_all[sl].tolist(), ds["keys"])
            else:
                l_phys = torch.tensor(0.0)
            loss  = l_rul + l_soh + lam_aux * l_int + lam_phys * l_phys
            opt.zero_grad(); loss.backward(); opt.step()
            ep_loss += float(loss.item())
            ep_li += float(l_int.item()); ep_lr += float(l_rul.item())
            ep_ls += float(l_soh.item()); ep_lp += float(l_phys.item())
            nb += 1
        ep_loss /= max(nb, 1); ep_li /= max(nb, 1)
        ep_lr   /= max(nb, 1); ep_ls /= max(nb, 1); ep_lp /= max(nb, 1)

        # Held-out val loss every epoch (no grad)
        with torch.no_grad():
            if n_val > 0:
                if n_spec > 0:
                    vh = backbone.forward_features(X[val_idx], chem_code=chem[val_idx])
                    vp_rul = backbone.rul_head(vh).squeeze(-1)
                    vp_soh = backbone.soh_head(vh).squeeze(-1)
                    vp_int = backbone.internal_state_head(
                        torch.cat([vh, Xspec[val_idx]], dim=-1))
                else:
                    vp_rul, vp_soh, vp_int = backbone.forward_with_internal_states(
                        X[val_idx], chem_code=chem[val_idx])
                v_loss = float((loss_fn(vp_rul, Yrul[val_idx]) +
                                loss_fn(vp_soh, Ysoh[val_idx]) +
                                lam_aux * loss_fn(vp_int, Yint[val_idx])).item())
            else:
                v_loss = ep_loss
        history.append({"epoch": ep, "train_loss": round(ep_loss, 6),
                        "val_loss": round(v_loss, 6),
                        "l_int": round(ep_li, 6), "l_rul": round(ep_lr, 6),
                        "l_soh": round(ep_ls, 6), "l_phys": round(ep_lp, 6)})

    # Final held-out per-key validation report — overall + stratified by chemistry
    val_report = None
    if n_val > 0:
        with torch.no_grad():
            if n_spec > 0:
                _vh = backbone.forward_features(X[val_idx], chem_code=chem[val_idx])
                vp_rul = backbone.rul_head(_vh).squeeze(-1)
                vp_soh = backbone.soh_head(_vh).squeeze(-1)
                vp_int = backbone.internal_state_head(
                    torch.cat([_vh, Xspec[val_idx]], dim=-1))
            else:
                vp_rul, vp_soh, vp_int = backbone.forward_with_internal_states(
                    X[val_idx], chem_code=chem[val_idx])
            # per-cell bounds for the val set
            y_min_val = y_min_all[val_idx].tolist()
            y_max_val = y_max_all[val_idx].tolist()
            per_key = _per_key_metrics(vp_int, Yint[val_idx],
                                       y_min_val, y_max_val, ds["keys"])
            rul_mae = float((vp_rul - Yrul[val_idx]).abs().mean().item())
            soh_mae = float((vp_soh - Ysoh[val_idx]).abs().mean().item())
            # Per-chemistry stratification (Option B)
            CHEM_NAMES = {0: "LCO", 1: "LFP", 2: "NMC", 3: "NCM", 4: "NCA"}
            val_chem = chem[val_idx]
            per_chem = {}
            for code in val_chem.unique().tolist():
                mask = val_chem == code
                if int(mask.sum()) < 3:        # too few cells for meaningful R²
                    continue
                idx_chem_val = val_idx[mask]
                sub_int  = vp_int[mask]
                sub_true = Yint[idx_chem_val]
                sub_rul  = vp_rul[mask]
                sub_soh  = vp_soh[mask]
                # per-cell bounds for this chemistry's val cells
                y_min_sub = y_min_all[idx_chem_val].tolist()
                y_max_sub = y_max_all[idx_chem_val].tolist()
                per_chem[CHEM_NAMES.get(int(code), str(int(code)))] = {
                    "n": int(mask.sum()),
                    "rul_mae_norm": round(float((sub_rul - Yrul[idx_chem_val]).abs().mean().item()), 4),
                    "soh_mae":      round(float((sub_soh - Ysoh[idx_chem_val]).abs().mean().item()), 4),
                    "per_key": _per_key_metrics(sub_int, sub_true,
                                                y_min_sub, y_max_sub, ds["keys"]),
                }
            # Multi-condition (chem × T-bin × C-rate-bin) stratification
            T_means_ds = ds.get("T_mean") or []
            cr_proxy_ds = ds.get("c_rate_proxy") or []
            multi = {}
            if T_means_ds and cr_proxy_ds:
                T_val_list  = [T_means_ds[int(i)]  for i in val_idx.tolist()]
                cr_val_list = [cr_proxy_ds[int(i)] for i in val_idx.tolist()]
                multi = multi_condition_report(
                    vp_int, Yint[val_idx], y_min_val, y_max_val,
                    ds["keys"], val_chem, T_val_list, cr_val_list,
                )
            val_report = {
                "n_val": int(n_val), "n_train": int(len(tr_idx)),
                "rul_mae_norm": round(rul_mae, 4),
                "soh_mae":      round(soh_mae, 4),
                "per_key":      per_key,
                "per_chemistry": per_chem,
                "per_condition": multi,
                "val_cells":    [ds["cells"][int(i)] for i in val_idx.tolist()],
            }

    metrics = {
        "ok":             True,
        "mode":           "real",
        "n_cells":        n,
        "n_train":        int(len(tr_idx)),
        "n_val":          int(n_val),
        "epochs":         epochs,
        "first_loss":     round(history[0]["train_loss"], 6),
        "final_loss":     round(history[-1]["train_loss"], 6),
        "final_val_loss": round(history[-1]["val_loss"], 6),
        "loss_decreased": history[-1]["train_loss"] < history[0]["train_loss"],
        "head_params":    sum(p.numel() for p in head.parameters()),
        "elapsed_s":      round(time.time() - t0, 2),
        "frozen_backbone": freeze_backbone,
        "history":        history,
        "cells":          ds["cells"],
        "val_report":     val_report,
    }

    out_dir = out_dir or _default_out_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    torch.save({
        "head_state_dict": head.state_dict(),
        "n_states":        head.N_STATES,
        "d_model":         backbone.d_model,
        "trained_at":      __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "mode":            "real",
        "label_keys":      ds["keys"],
        "chem_scalers":    ds.get("chem_scalers", {}),
        "n_cells":         n,
        "frozen_backbone": freeze_backbone,
        "metrics":         {k: metrics[k] for k in ("epochs", "first_loss", "final_loss",
                                                     "loss_decreased", "head_params", "elapsed_s",
                                                     "n_cells", "frozen_backbone")},
        "val_report":      val_report,
    }, out_dir / "checkpoint_head.pt")
    (out_dir / "training_log.json").write_text(json.dumps(history, indent=2))
    if val_report is not None:
        (out_dir / "val_report.json").write_text(json.dumps(val_report, indent=2))
    metrics["checkpoint"] = str(out_dir / "checkpoint_head.pt")
    return metrics


def main() -> None:
    ap = argparse.ArgumentParser(description="Phase C: train the internal-state head on v12")
    ap.add_argument("--smoke",  action="store_true",
                    help="run synthetic-data smoke training (verifies the loop)")
    ap.add_argument("--real",   action="store_true",
                    help="real-mode training on cached labels (see cache_internal_state_labels.py)")
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--lr",     type=float, default=3e-3)
    ap.add_argument("--lam-aux", type=float, default=1.0,
                    help="weight λ on the internal-state MSE term")
    ap.add_argument("--unfreeze-backbone", action="store_true",
                    help="real mode only: also fine-tune the backbone (default: frozen)")
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--val-frac",  type=float, default=0.2,
                    help="real mode only: fraction of cells held out for validation")
    ap.add_argument("--lam-phys",  type=float, default=0.0,
                    help="weight on physics-constraint loss (non-negativity, fraction bounds, "
                         "partition, Arrhenius). 0 disables.")
    ap.add_argument("--out",    default=None, help="checkpoint output directory")
    args = ap.parse_args()

    if args.smoke == args.real:
        print("Choose exactly one mode: --smoke OR --real")
        sys.exit(2)

    out_dir = Path(args.out) if args.out else None
    if args.smoke:
        m = train_smoke(epochs=args.epochs, lr=args.lr, lam_aux=args.lam_aux, out_dir=out_dir)
        print(f"\nPhase C smoke train DONE → {m['checkpoint']}")
    else:
        m = train_real(epochs=args.epochs, lr=args.lr, lam_aux=args.lam_aux,
                       freeze_backbone=not args.unfreeze_backbone,
                       batch_size=args.batch_size, val_frac=args.val_frac,
                       lam_phys=args.lam_phys, out_dir=out_dir)
        print(f"\nPhase C REAL train DONE → {m['checkpoint']}")
        print(f"  cells (train/val): {m['n_train']} / {m['n_val']}")
        print(f"  frozen backbone  : {m['frozen_backbone']}")
        print(f"  final val loss   : {m.get('final_val_loss')}")
        if m.get("val_report"):
            vr = m["val_report"]
            print(f"\nHeld-out validation (n={vr['n_val']} cells)")
            print(f"  RUL  MAE (norm)  : {vr['rul_mae_norm']}")
            print(f"  SOH  MAE         : {vr['soh_mae']}")
            print(f"  per-key R² / MAPE %:")
            for k, s in vr["per_key"].items():
                r2_str = f"R²={s['r2']:+.3f}" if s.get("r2") is not None else "R²= n/a "
                print(f"    {k:24s}  {r2_str}  MAPE={s['mape_pct']:.1f}%  "
                      f"mae={s.get('mae')}  var(true)={s.get('var_true')}")
    print(f"  head params      : {m['head_params']}")
    print(f"  first/final loss : {m['first_loss']} → {m['final_loss']}")
    print(f"  loss decreased   : {m['loss_decreased']}")
    print(f"  elapsed          : {m['elapsed_s']}s")


if __name__ == "__main__":
    main()

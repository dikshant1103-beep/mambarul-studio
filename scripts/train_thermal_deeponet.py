"""
train_thermal_deeponet.py — train the DeepONet core-temperature sensor on the PyBaMM
thermal dataset. Branch = signals(+EWMA), trunk = radial r; supervise core at r=0 and
surface at r=1. Leak-free split by run_id. Saves backend/data/thermal/deeponet_thermal.pt.

    backend/venv/bin/python scripts/train_thermal_deeponet.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import torch

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))
from core.thermal_estimator import (  # noqa: E402
    MODEL_PATH, SAMPLE_PERIOD_S, _build_net, engineer, feature_columns,
)

LATENT, HIDDEN, EPOCHS, ENS = 64, [64, 64], 60, 3


def build_dataset(df):
    Xs, core, surf, runs = [], [], [], []
    for rid, g in df.groupby("run_id"):
        g = g.reset_index(drop=True)
        Xs.append(engineer(g, SAMPLE_PERIOD_S))
        core.append(g["core_T"].to_numpy(np.float32))
        surf.append(g["surface_T"].to_numpy(np.float32))
        runs.append(np.full(len(g), rid))
    return (np.vstack(Xs), np.concatenate(core), np.concatenate(surf), np.concatenate(runs))


def main() -> int:
    torch.manual_seed(42)
    path = BACKEND / "data" / "thermal" / "pybamm_thermal.parquet"
    df = pd.read_parquet(path)
    X, core, surf, runid = build_dataset(df)
    print(f"[*] {len(X):,} samples, {X.shape[1]} features, {df.run_id.nunique()} runs")

    rng = np.random.default_rng(0)
    ids = rng.permutation(np.unique(runid))
    n = len(ids); te = set(ids[: n // 7]); va = set(ids[n // 7: n // 5])
    tr_m = ~np.isin(runid, list(te | va)); te_m = np.isin(runid, list(te))
    xm, xs = X[tr_m].mean(0), X[tr_m].std(0) + 1e-8
    allt = np.concatenate([core[tr_m], surf[tr_m]])
    tm, ts = float(allt.mean()), float(allt.std() + 1e-8)

    Xtr = torch.tensor((X[tr_m] - xm) / xs)
    Ytr = torch.tensor(np.column_stack([(core[tr_m] - tm) / ts, (surf[tr_m] - tm) / ts]), dtype=torch.float32)
    r = torch.tensor([[0.0], [1.0]])                         # core (r=0), surface (r=1)
    Xte = torch.tensor((X[te_m] - xm) / xs)

    models, t0 = [], time.time()
    for m in range(ENS):
        torch.manual_seed(100 + m)
        net = _build_net(X.shape[1], LATENT, HIDDEN)
        opt = torch.optim.Adam(net.parameters(), lr=1e-3)
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, EPOCHS)
        N = len(Xtr); bs = 512
        for ep in range(EPOCHS):
            perm = torch.randperm(N)
            for i in range(0, N, bs):
                idx = perm[i:i + bs]
                loss = ((net(Xtr[idx], r) - Ytr[idx]) ** 2).mean()
                opt.zero_grad(); loss.backward(); opt.step()
            sched.step()
        net.eval(); models.append(net)
        print(f"    model {m+1}/{ENS} (train loss {loss.item():.4f})")
    print(f"[*] trained in {time.time()-t0:.1f}s")

    # evaluate core RMSE on held-out runs
    with torch.no_grad():
        preds = np.stack([(net(Xte, torch.zeros(1, 1)).squeeze(1).numpy() * ts + tm) for net in models])
    core_pred = preds.mean(0); core_true = core[te_m]
    rmse = float(np.sqrt(np.mean((core_pred - core_true) ** 2)))
    mae = float(np.mean(np.abs(core_pred - core_true)))
    sigma = float(preds.std(0).mean())
    print(f"\n[*] ===== held-out core-temp results =====")
    print(f"    core RMSE = {rmse:.2f} °C | MAE = {mae:.2f} °C | mean ±1σ = {sigma:.2f} °C")
    print(f"    (2-state physics baseline ΔT-only is the comparison; learned uses real signals)")

    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"state_dicts": [m.state_dict() for m in models],
                "n_in": X.shape[1], "latent": LATENT, "hidden": HIDDEN,
                "x_mean": xm.tolist(), "x_std": xs.tolist(),
                "t_mean": tm, "t_std": ts, "period_s": SAMPLE_PERIOD_S,
                "feature_cols": feature_columns(), "core_rmse": rmse}, MODEL_PATH)
    print(f"[done] saved -> {MODEL_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

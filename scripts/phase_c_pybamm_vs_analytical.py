#!/usr/bin/env python
"""
phase_c_pybamm_vs_analytical.py — Phase C Option A clean experiment.

Generate synthetic cells with PyBaMM (where the internal states ARE physics
ground truth), train two heads on the same cells but with two label sources:
  (a) analytical-fit labels via core.internal_states.extract_internal_states
  (b) PyBaMM-grounded labels via core.pybamm_internal_states.extract_pybamm_internal_states

Compare held-out R² on k_sei and sei_thickness_nm — the two marquee electrochemistry
observables that the analytical fit cannot directly expose. If PyBaMM labels give
substantially better R², the bottleneck is label quality (Option A's hypothesis).
If R² is similar, the bottleneck is elsewhere (architecture, data scale).
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--chemistry", default="NMC",
                    help="run experiment on this chemistry (LFP/NMC/NCA/LCO)")
    ap.add_argument("--n-cells",   type=int, default=24,
                    help="synthetic cells (split across (c_rate × T) grid)")
    ap.add_argument("--n-cycles",  type=int, default=80,
                    help="PyBaMM cycles per cell")
    ap.add_argument("--epochs",    type=int, default=80)
    ap.add_argument("--val-frac",  type=float, default=0.25)
    args = ap.parse_args()

    import numpy as np
    import torch
    from core.digital_twin import run_pybamm_simulation, fit_analytical
    from core.pybamm_internal_states import extract_pybamm_internal_states
    from core.internal_states import extract_internal_states, INTERNAL_STATE_KEYS
    from core.model_loader import _normalize, _MODELS, load_all_models
    from core.bimamba_apf import BiMambaAPF, attach_internal_state_head

    load_all_models()
    if "v12-bimamba" not in _MODELS:
        print("v12-bimamba not loaded; aborting"); return
    entry = _MODELS["v12-bimamba"]
    fmean, fstd = entry["feat_mean"], entry["feat_std"]

    # Build a (c_rate × T) sweep that totals ~n_cells synthetic cells
    grid = []
    c_rates = [0.5, 1.0, 1.5, 2.0]
    temps   = [15.0, 25.0, 35.0, 45.0]
    for c in c_rates:
        for T in temps:
            grid.append((c, T))
            if len(grid) >= args.n_cells:
                break
        if len(grid) >= args.n_cells:
            break

    print(f"Generating {len(grid)} {args.chemistry} cells via PyBaMM "
          f"({args.n_cycles} cycles each)…")

    samples = []
    t0 = time.time()
    for k, (c, T) in enumerate(grid, 1):
        ts = time.time()
        sim = run_pybamm_simulation(n_cycles=args.n_cycles, c_rate_dis=c,
                                    c_rate_chg=min(c, 1.0), temperature=T,
                                    chemistry=args.chemistry)
        if not sim.get("ok"):
            print(f"  [{k}] c={c} T={T} sim FAILED — {sim.get('error')}"); continue
        cycles = sim["cycles"]; caps = sim["capacity"]
        if len(cycles) < 32 or all(x == caps[0] for x in caps):
            print(f"  [{k}] c={c} T={T} skipped (flat or too short)"); continue

        # PyBaMM-grounded labels
        pb = extract_pybamm_internal_states(chemistry=args.chemistry,
                                            c_rate_dis=c, temperature=T,
                                            n_cycles=args.n_cycles)
        # Analytical-fit labels on the SAME simulated trajectory
        fit  = fit_analytical(cycles, caps)
        twin = {"chemistry": args.chemistry, "fit": fit,
                "observed": {"cycles": cycles, "ir": [0.03] * len(cycles),
                             "temperature": [T] * len(cycles)}}
        an = extract_internal_states(twin)

        samples.append({
            "label": f"syn_{args.chemistry}_c{c}_T{T}",
            "cycles": cycles, "caps": caps,
            "pybamm": pb, "analytical": an,
        })
        print(f"  [{k}/{len(grid)}] c={c} T={T}  ({time.time()-ts:.1f}s)  "
              f"PB.k_sei={pb.get('k_sei')} AN.k_sei={an.get('k_sei')}")

    if len(samples) < 8:
        print(f"too few valid samples ({len(samples)}) to train"); return

    # Build (X, Y_pb, Y_an) using the last 30 cycles of each simulated trajectory.
    # We use the v12 normalizer on a 9-feature window (we fabricate the 4 non-cap
    # columns as constants matching typical NMC values — the relative ordering of
    # cells in the window remains physical).
    X_list, Y_pb_list, Y_an_list = [], [], []
    keys = list(INTERNAL_STATE_KEYS)
    for s in samples:
        caps_arr = np.array(s["caps"][-30:], dtype=np.float32)
        if len(caps_arr) < 30:
            caps_arr = np.pad(caps_arr, (30 - len(caps_arr), 0), mode="edge")
        # 9-feature row per cycle: [cap, charge_time, vmean, vend, energy, temp, slope, ir, chem]
        L = 30
        raw = np.zeros((L, 9), dtype=np.float32)
        raw[:, 0] = caps_arr                   # capacity
        raw[:, 1] = 7200.0                     # charge time
        raw[:, 2] = 3.8                        # voltage_mean
        raw[:, 3] = 2.75                       # voltage_end
        raw[:, 4] = caps_arr * 3.8             # energy ≈ cap × vmean
        raw[:, 5] = 25.0                       # temperature (Arrhenius transformed by _normalize)
        raw[:, 6] = (caps_arr[-1] - caps_arr[0]) / max(L - 1, 1)  # discharge slope
        raw[:, 7] = 0.03                       # int_resistance
        raw[:, 8] = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3, "NCA": 4}.get(args.chemistry, 2)
        x = _normalize(raw, fmean, fstd)
        X_list.append(x)
        Y_pb_list.append([float(s["pybamm"].get(k) or 0.0) for k in keys])
        Y_an_list.append([float(s["analytical"].get(k) or 0.0) for k in keys])

    X    = torch.tensor(np.stack(X_list, axis=0))
    Y_pb = torch.tensor(np.array(Y_pb_list, dtype=np.float32))
    Y_an = torch.tensor(np.array(Y_an_list, dtype=np.float32))

    # Min-max scale targets per-key (each separately for fair MSE)
    def _scale(Y):
        y_min = Y.min(0).values; y_max = Y.max(0).values
        y_rng = (y_max - y_min).clamp(min=1e-6)
        return (Y - y_min) / y_rng, y_min, y_max
    Y_pb_s, pb_min, pb_max = _scale(Y_pb)
    Y_an_s, an_min, an_max = _scale(Y_an)

    n = X.shape[0]
    torch.manual_seed(0)
    perm = torch.randperm(n)
    n_val = max(2, int(round(n * args.val_frac)))
    val = perm[:n_val]; tr = perm[n_val:]

    # Train two heads (same architecture, same data, different labels)
    def _train_one(Y_scaled, label_min, label_max, tag):
        torch.manual_seed(0)
        backbone = BiMambaAPF()
        backbone.load_state_dict(entry["model"].state_dict(), strict=False)
        head = attach_internal_state_head(backbone)
        for p in backbone.parameters(): p.requires_grad = False
        for p in head.parameters(): p.requires_grad = True
        opt = torch.optim.Adam(head.parameters(), lr=3e-3)
        loss_fn = torch.nn.MSELoss()
        for ep in range(args.epochs):
            tr_perm = tr[torch.randperm(len(tr))]
            for s in range(0, len(tr_perm), 8):
                sl = tr_perm[s:s+8]
                _, _, pred = backbone.forward_with_internal_states(X[sl])
                loss = loss_fn(pred, Y_scaled[sl])
                opt.zero_grad(); loss.backward(); opt.step()
        # Per-key R² on val
        with torch.no_grad():
            _, _, vp = backbone.forward_with_internal_states(X[val])
        out = {}
        rng = (torch.tensor(label_max) - torch.tensor(label_min)).clamp(min=1e-6)
        for i, k in enumerate(keys):
            p = (vp[:, i] * rng[i] + label_min[i]).numpy()
            t = (Y_scaled[val][:, i] * rng[i] + label_min[i]).numpy()
            ss_res = float(((t - p) ** 2).sum()); ss_tot = float(((t - t.mean()) ** 2).sum()) + 1e-12
            out[k] = round(1.0 - ss_res / ss_tot, 4)
        return out

    print(f"\nTraining head with ANALYTICAL labels ({len(tr)} train / {n_val} val)…")
    r_an = _train_one(Y_an_s, an_min, an_max, "analytical")
    print(f"Training head with PYBAMM-GROUNDED labels…")
    r_pb = _train_one(Y_pb_s, pb_min, pb_max, "pybamm")

    print(f"\n══ Per-key R² ({args.chemistry}, n={n}, n_val={n_val}) ══")
    print(f"  {'key':24s}  {'analytical':>12s}   {'pybamm_sim':>12s}    Δ")
    for k in keys:
        a = r_an[k]; b = r_pb[k]
        delta = b - a
        flag = "  ★" if abs(delta) > 0.15 else ""
        print(f"  {k:24s}  {a:+12.3f}   {b:+12.3f}   {delta:+.3f}{flag}")

    out_dir = Path(__file__).resolve().parent.parent.parent / "processed" / "internal_state_head"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"pybamm_vs_analytical_{args.chemistry}.json").write_text(json.dumps({
        "chemistry": args.chemistry, "n": n, "n_val": n_val, "epochs": args.epochs,
        "analytical_r2": r_an, "pybamm_r2": r_pb,
        "elapsed_s": round(time.time() - t0, 1),
    }, indent=2))


if __name__ == "__main__":
    main()

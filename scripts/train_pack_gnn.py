#!/usr/bin/env python
"""
train_pack_gnn.py — Manual Pack-GNN training on liionpack pack-sim data.

Runs in the MAIN backend env (torch). Reads processed/pack_sim/*.json (produced
by scripts/pack_sim.py in the packsim env) and trains PackGraphSAGE.

Examples:
    # train to a SAFE checkpoint (does not touch the production model):
    python scripts/train_pack_gnn.py --epochs 300

    # promote to production (the model the app actually serves):
    python scripts/train_pack_gnn.py --epochs 300 --production

The app picks up the production checkpoint automatically on next inference
(core.pack_gnn._load_model). Check status at GET /api/predict/pack-gnn/status.
"""
import argparse
import sys
from pathlib import Path

# Make `core` importable when run from the repo root
BACKEND = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND))


def main() -> None:
    ap = argparse.ArgumentParser(description="Train Pack-GNN on pack-sim data")
    ap.add_argument("--data-dir", default=None, help="dir of packsim_*.json (default: processed/pack_sim)")
    ap.add_argument("--epochs", type=int, default=300)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--val-frac", type=float, default=0.2)
    ap.add_argument("--d-hidden", type=int, default=64)
    ap.add_argument("--n-layers", type=int, default=2)
    ap.add_argument("--chemistry", default="NMC")
    ap.add_argument("--out", default=None, help="checkpoint path (default: safe non-production path)")
    ap.add_argument("--production", action="store_true",
                    help="overwrite the production checkpoint the app serves")
    args = ap.parse_args()

    from core.pack_gnn_trainer import train_pack_gnn

    if args.production:
        print("⚠ --production: this WILL overwrite the served Pack-GNN checkpoint.")
    m = train_pack_gnn(
        data_dir=args.data_dir, epochs=args.epochs, lr=args.lr,
        val_frac=args.val_frac, d_hidden=args.d_hidden, n_layers=args.n_layers,
        out_path=args.out, production=args.production, chemistry=args.chemistry,
    )
    print(f"\nDone → {m['checkpoint']}")
    print(f"  samples={m['n_samples']} (train={m['n_train']}, val={m['n_val']})")
    print(f"  params={m['params']}  epochs={m['epochs']}")
    print(f"  best_val_loss={m['best_val_loss']}  final_train_loss={m['final_train_loss']}")
    print(f"  elapsed={m['elapsed_s']}s  production={m['production']}")


if __name__ == "__main__":
    main()

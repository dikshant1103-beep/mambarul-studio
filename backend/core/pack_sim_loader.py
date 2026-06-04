"""
core/pack_sim_loader.py — Read liionpack pack-simulation samples and convert
them into Pack-GNN training arrays.

This module is the MAIN-BACKEND side of the pack-sim pipeline. It imports only
numpy (no liionpack / no old pybamm), so it is safe in the production env.
The samples are produced by `scripts/pack_sim.py` running in the isolated
packsim env (see backend/requirements-packsim.txt).

Pipeline:
    scripts/pack_sim.py  (packsim env, pybamm 23.9 + liionpack)
        └─► processed/pack_sim/*.json   (per-cell imbalance under coupled solve)
                └─► load_pack_sim_samples() / to_training_arrays()  (this file)
                        └─► Pack-GNN training (core/pack_gnn.py)

Label derivation: a real pack diverges under load — cells that carry more
current and sag to a lower terminal voltage age faster. We map that measured
electrical imbalance to a per-cell aging correction δ in [-0.4, 0.4] (negative =
faster aging), which is exactly the target Pack-GNN's cell head predicts.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

DELTA_CLIP = 0.40


def load_pack_sim_samples(directory: str | Path) -> list[dict]:
    """Load all packsim_*.json sample files from a directory."""
    d = Path(directory)
    if not d.exists():
        return []
    samples = []
    for path in sorted(d.glob("packsim_*.json")):
        try:
            samples.append(json.loads(path.read_text()))
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("pack_sim_loader: skipping %s (%s)", path.name, exc)
    return samples


def derive_target_delta(sample: dict) -> np.ndarray:
    """Map measured cell imbalance → per-cell aging correction δ ∈ [-0.4, 0.4].

    Two stressors, normalized within the pack (zero-mean across cells):
      • current_share above pack mean  → more throughput → faster aging
      • v_min below pack mean          → deeper over-discharge → faster aging
    Cells worse than the pack average get negative δ; better-than-average get a
    small positive δ. Magnitudes scale with how far the pack has diverged.
    """
    cells = sample["cells"]
    n = len(cells)
    if n == 0:
        return np.zeros(0, dtype=np.float32)

    cur = np.array([c["current_share"] for c in cells], dtype=float)
    vmn = np.array([c["v_min"] for c in cells], dtype=float)

    def _z(x: np.ndarray) -> np.ndarray:
        s = x.std()
        return (x - x.mean()) / s if s > 1e-9 else np.zeros_like(x)

    # Higher current share = worse; lower v_min = worse → flip its sign.
    stress = 0.6 * _z(cur) + 0.4 * _z(-vmn)
    delta  = -0.12 * stress              # ~±0.12 per σ of imbalance
    return np.clip(delta, -DELTA_CLIP, DELTA_CLIP).astype(np.float32)


def sample_to_cells(sample: dict, chemistry: str = "NMC") -> list[dict]:
    """Convert a pack-sim sample into the per-cell dicts pack_gnn.build_node_features expects.

    SOH/IR/throughput are derived from the simulated electrical behaviour so the
    node features reflect the same physics that produced the δ labels.
    """
    cells_out = []
    v_min_pack = sample.get("v_min_pack", min((c["v_min"] for c in sample["cells"]), default=3.0))
    for c in sample["cells"]:
        # crude but monotonic SOH proxy: cells sagging lower / carrying more are "weaker"
        soh = float(np.clip(0.80 + 0.15 * (c["v_min"] - v_min_pack), 0.5, 1.0))
        cells_out.append({
            "cell_id":       c["cell_id"],
            "soh":           round(soh, 4),
            "rul":           round(soh * 1000, 1),
            "ir":            round(float(c["ri"]), 5),
            "capacity_ah":   1.0,
            "nominal_capacity": 1.0,
            "fade_rate":     round(float(c["current_share"]) * 1e-4, 8),
            "chemistry":     chemistry,
            "temperature":   25.0,
            "n_cycles":      0,
        })
    return cells_out


def to_training_arrays(sample: dict, chemistry: str = "NMC"):
    """Return (node_features [N,9] tensor, adj_norm [N,N] tensor, target_delta [N] tensor)
    ready for Pack-GNN training. Reuses pack_gnn's own feature/adjacency builders."""
    from core.pack_gnn import build_node_features, build_adjacency, _row_norm

    cells = sample_to_cells(sample, chemistry=chemistry)
    n     = len(cells)
    topo  = sample.get("topology", "series")
    x     = build_node_features(cells)
    adj   = build_adjacency(n, topo, sample.get("n_series", n), sample.get("n_parallel", 1))
    adj_n = _row_norm(adj)
    import torch
    y = torch.tensor(derive_target_delta(sample), dtype=torch.float32)
    return x, adj_n, y


def build_dataset(directory: str | Path, chemistry: str = "NMC") -> list[dict]:
    """Load every sample and return a list of {x, adj_norm, y, n_cells, sample_id}."""
    dataset = []
    for s in load_pack_sim_samples(directory):
        try:
            x, adj_n, y = to_training_arrays(s, chemistry=chemistry)
            dataset.append({
                "sample_id": s.get("sample_id"),
                "n_cells":   s.get("n_cells", len(s.get("cells", []))),
                "x": x, "adj_norm": adj_n, "y": y,
            })
        except Exception as exc:
            logger.warning("pack_sim_loader: failed to build sample %s (%s)",
                           s.get("sample_id"), exc)
    return dataset

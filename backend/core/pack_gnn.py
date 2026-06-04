"""
core/pack_gnn.py — Pack-level Graph Neural Network (pure PyTorch, no PyG).

Architecture: 2-layer GraphSAGE with mean aggregation.
  Input:  N × NODE_DIM node features (per-cell)
  Output: per-cell corrected RUL (accounts for pack context / interaction stress)

Without a checkpoint the module falls back to physics_prior_correction(),
an analytical approximation calibrated on known series/parallel stress mechanisms.

Node features (NODE_DIM=9):
  0  soh          State of Health [0,1]
  1  rul_norm     RUL / chemistry_max_rul
  2  cap_norm     capacity / nominal_capacity
  3  ir           internal resistance (Ω)
  4  fade_rate    ΔSOH per cycle × 1000 (scaled)
  5  chem_sin     sin(2π·chem_code/5)
  6  chem_cos     cos(2π·chem_code/5)
  7  temp_norm    (T°C − 25) / 15
  8  cycle_frac   cycles / chemistry_max_cycles

Physics insight encoded in training labels:
  Series:   weak cell → over-discharged each cycle → faster aging (negative correction)
            high-IR cell → more heat → faster aging
            all cells suffer from pack imbalance (spread tax)
  Parallel: strong cells carry disproportionate current → faster aging
"""
from __future__ import annotations
import logging
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

logger = logging.getLogger(__name__)

NODE_DIM = 9
CHEM_MAX_RUL    = {0: 309.0, 1: 1934.0, 2: 1500.0, 3: 1000.0, 4: 800.0}
CHEM_MAX_CYCLES = {0: 500,   1: 2500,   2: 2000,   3: 1500,   4: 1200}
CHEM_CODE       = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3, "NCA": 4}

CKPT_PATH = Path(__file__).parent.parent.parent.parent / "processed" / "pack_gnn" / "checkpoint_pack_gnn.pt"

_model_cache: Optional["PackGraphSAGE"] = None


# ── GraphSAGE building blocks ─────────────────────────────────────────────────

class SAGEConv(nn.Module):
    """Mean-aggregation GraphSAGE layer: h_i' = ReLU(LayerNorm(W[h_i || mean_j(h_j)]))"""

    def __init__(self, in_dim: int, out_dim: int):
        super().__init__()
        self.lin  = nn.Linear(in_dim * 2, out_dim)
        self.norm = nn.LayerNorm(out_dim)

    def forward(self, h: torch.Tensor, adj_norm: torch.Tensor) -> torch.Tensor:
        # h:        [N, in_dim]
        # adj_norm: [N, N] row-normalised (self-loops included)
        agg = adj_norm @ h                          # [N, in_dim]
        out = self.lin(torch.cat([h, agg], dim=-1)) # [N, out_dim]
        return F.relu(self.norm(out))


class PackGraphSAGE(nn.Module):
    """
    Two-layer GraphSAGE that outputs a per-cell RUL correction factor δ ∈ [-0.4, 0.4].

    corrected_rul_i = base_rul_i × (1 + δ_i)

    Negative δ means the GNN thinks this cell will age faster than its
    individual prediction suggests (due to pack context — IR imbalance,
    being the weak link in a series string, etc.).
    """

    def __init__(self, d_hidden: int = 64, n_layers: int = 2, dropout: float = 0.1):
        super().__init__()
        self.node_proj = nn.Linear(NODE_DIM, d_hidden)
        self.convs = nn.ModuleList([
            SAGEConv(d_hidden, d_hidden) for _ in range(n_layers)
        ])
        self.drop = nn.Dropout(dropout)
        self.cell_head = nn.Sequential(
            nn.Linear(d_hidden, 32), nn.ReLU(),
            nn.Linear(32, 1), nn.Tanh(),   # → [-1, 1], scaled ×0.4 at output
        )

    def forward(self, x: torch.Tensor, adj_norm: torch.Tensor
                ) -> tuple[torch.Tensor, torch.Tensor]:
        """
        x:        [N, NODE_DIM]
        adj_norm: [N, N]
        Returns:
          delta:  [N] correction factors in [-0.4, 0.4]
          h:      [N, d_hidden] node embeddings (for diagnostics)
        """
        h = F.relu(self.node_proj(x))
        for conv in self.convs:
            h = self.drop(conv(h, adj_norm))
        delta = self.cell_head(h).squeeze(-1) * 0.4  # scale tanh to ±0.4
        return delta, h


# ── Graph construction ────────────────────────────────────────────────────────

def _row_norm(adj: torch.Tensor) -> torch.Tensor:
    """Row-normalise adjacency (D⁻¹ A) with self-loops."""
    A = adj + torch.eye(adj.size(0), device=adj.device)
    deg = A.sum(dim=1, keepdim=True).clamp(min=1.0)
    return A / deg


def build_adjacency(n: int, topology: str,
                    ns: int = 1, np_: int = 1) -> torch.Tensor:
    """
    Build binary adjacency matrix for a pack of n cells.

    series:          fully connected (all cells share the same current)
    parallel:        fully connected within parallel groups
    series_parallel: Ns series groups of Np parallel cells each
    """
    adj = torch.zeros(n, n)
    if topology in ("series", "parallel"):
        # All cells electrically coupled → fully connected
        adj = torch.ones(n, n)
    else:  # series_parallel
        group_size = max(1, n // max(ns, 1))
        for g in range(ns):
            lo = g * group_size
            hi = min(lo + group_size, n)
            adj[lo:hi, lo:hi] = 1.0
        # Series connections: consecutive group representatives see each other
        for g in range(ns - 1):
            a = g * group_size
            b = (g + 1) * group_size
            if b < n:
                adj[a, b] = adj[b, a] = 1.0
    return adj


def build_node_features(cells: list[dict]) -> torch.Tensor:
    """
    Convert a list of cell dicts to a [N, NODE_DIM] tensor.
    Accepts any subset of keys; missing values use safe defaults.
    """
    rows = []
    for c in cells:
        chem_str  = c.get("chemistry", "NMC").upper()
        chem_code = CHEM_CODE.get(chem_str, 2)
        max_rul   = CHEM_MAX_RUL.get(chem_code, 1000.0)
        max_cyc   = CHEM_MAX_CYCLES.get(chem_code, 1500)

        soh        = float(c.get("soh",        c.get("cap_pct", 0.85)))
        rul        = float(c.get("rul",         300.0))
        capacity   = float(c.get("capacity_ah", c.get("capacity", 5.0)))
        nominal    = float(c.get("nom_capacity_ah", c.get("nom_capacity", max(capacity, 1.0))))
        ir         = float(c.get("ir",          c.get("int_resistance", 0.05)))
        fade_rate  = float(c.get("fade_rate",   0.0001))
        temperature= float(c.get("temperature", 25.0))
        cycles     = float(c.get("cycles",      c.get("n_cycles", 100)))

        rows.append([
            np.clip(soh, 0.0, 1.0),
            np.clip(rul / max_rul, 0.0, 1.5),
            np.clip(capacity / (nominal + 1e-6), 0.0, 1.5),
            np.clip(ir, 0.005, 1.0),
            np.clip(fade_rate * 1000, 0.0, 5.0),
            float(np.sin(2 * np.pi * chem_code / 5)),
            float(np.cos(2 * np.pi * chem_code / 5)),
            np.clip((temperature - 25.0) / 15.0, -3.0, 3.0),
            np.clip(cycles / max_cyc, 0.0, 1.5),
        ])
    return torch.tensor(rows, dtype=torch.float32)


# ── Physics-prior correction (no checkpoint needed) ───────────────────────────

def physics_prior_correction(cells: list[dict], topology: str) -> np.ndarray:
    """
    Analytical RUL correction factors without a trained GNN checkpoint.
    Returns δ array (same sign convention as GNN: negative = faster aging).
    """
    n = len(cells)
    if n < 2:
        return np.zeros(n)

    ruls  = np.array([float(c.get("rul", 300)) for c in cells], dtype=np.float64)
    irs   = np.array([float(c.get("ir", c.get("int_resistance", 0.05))) for c in cells])
    sohs  = np.array([float(c.get("soh", c.get("cap_pct", 0.85))) for c in cells])

    mean_rul = ruls.mean() + 1e-6
    mean_ir  = irs.mean()  + 1e-6
    std_rul  = ruls.std()

    topo = topology.lower().replace("-", "_")

    if "series" in topo:
        # Weak cells (below mean RUL): over-discharged every cycle
        rul_penalty   = -0.20 * np.maximum(0.0, mean_rul - ruls) / mean_rul
        # High-IR cells: more Joule heating
        ir_penalty    = -0.15 * np.maximum(0.0, irs - mean_ir) / mean_ir
        # Pack imbalance tax on all cells
        spread_tax    = -0.05 * (std_rul / mean_rul) * np.ones(n)
        delta = rul_penalty + ir_penalty + spread_tax

    elif "parallel" in topo:
        # Strong cells carry disproportionate current (low internal resistance → more current)
        # Use IR to determine current sharing: low IR → more current → faster aging
        ir_share = (1.0 / (irs + 1e-6))
        ir_share /= ir_share.mean()
        current_stress = -0.08 * np.maximum(0.0, ir_share - 1.0)
        delta = current_stress

    else:
        delta = np.zeros(n)

    return np.clip(delta, -0.40, 0.10)


# ── Model loader ──────────────────────────────────────────────────────────────

def _load_model() -> Optional[PackGraphSAGE]:
    global _model_cache
    if _model_cache is not None:
        return _model_cache
    if not CKPT_PATH.exists():
        return None
    try:
        ck = torch.load(str(CKPT_PATH), map_location="cpu", weights_only=False)
        model = PackGraphSAGE(
            d_hidden=ck.get("d_hidden", 64),
            n_layers=ck.get("n_layers", 2),
            dropout=0.0,
        )
        model.load_state_dict(ck["model_state_dict"])
        model.eval()
        _model_cache = model
        logger.info("PackGraphSAGE loaded from %s", CKPT_PATH)
        return model
    except Exception as exc:
        logger.warning("PackGNN checkpoint load failed: %s — using physics prior", exc)
        return None


# ── Public inference API ──────────────────────────────────────────────────────

def predict_pack_gnn(cells: list[dict], topology: str = "series",
                     ns: int = 1, np_: int = 1) -> dict:
    """
    Run Pack GNN inference on a list of cell dicts.

    Returns:
      corrected_ruls:  list[float]  per-cell RUL after pack-context correction
      deltas:          list[float]  correction factors (negative = accelerated aging)
      pack_rul:        float        pack-level RUL
      pack_lower_90:   float
      pack_upper_90:   float
      source:          str          "gnn" | "physics_prior"
      interaction_summary: dict     key stats about the interaction effects
    """
    n = len(cells)
    if n == 0:
        return {"error": "No cells provided"}

    base_ruls = np.array([float(c.get("rul", 300)) for c in cells])

    # ── Try GNN first, fall back to physics prior ─────────────────────────────
    model = _load_model()
    topo  = topology.lower().replace("-", "_")

    if model is not None:
        try:
            x        = build_node_features(cells)
            adj      = build_adjacency(n, topo, ns, np_)
            adj_norm = _row_norm(adj)
            with torch.no_grad():
                delta_t, _ = model(x, adj_norm)
            delta  = delta_t.numpy()
            source = "gnn"
        except Exception as exc:
            logger.warning("PackGNN inference failed: %s — falling back to physics prior", exc)
            delta  = physics_prior_correction(cells, topo)
            source = "physics_prior_fallback"
    else:
        delta  = physics_prior_correction(cells, topo)
        source = "physics_prior"

    # ── Apply corrections ─────────────────────────────────────────────────────
    corrected = np.maximum(0.0, base_ruls * (1.0 + delta))

    # ── Pack-level aggregation (topology-aware) ───────────────────────────────
    if "series" in topo:
        pack_rul = float(corrected.min())
        # CI: widen by imbalance spread
        spread_factor = 1.0 + float(corrected.std() / (corrected.mean() + 1e-6))
    elif "parallel" in topo:
        caps    = np.array([float(c.get("capacity_ah", c.get("capacity", 5.0))) for c in cells])
        total   = caps.sum() or n
        weights = caps / total
        pack_rul = float((corrected * weights).sum())
        spread_factor = 1.0 + 0.1 * float(corrected.std() / (corrected.mean() + 1e-6))
    else:
        pack_rul = float(corrected.min())
        spread_factor = 1.2

    # Chemistry-based base CI
    chem_str = cells[0].get("chemistry", "NMC").upper()
    base_ci  = {"LCO": 34.0, "LFP": 145.3, "NMC": 514.3, "NCM": 17.0, "NCA": 20.0}.get(chem_str, 60.0)
    ci_half  = base_ci * spread_factor
    lower_90 = round(max(0.0, pack_rul - ci_half), 1)
    upper_90 = round(pack_rul + ci_half, 1)

    # ── Interaction summary ───────────────────────────────────────────────────
    worst_idx  = int(np.argmin(corrected))
    most_stress= int(np.argmin(delta))
    interaction = {
        "limiting_cell":      cells[worst_idx].get("cell_id", f"cell_{worst_idx}"),
        "most_stressed_cell": cells[most_stress].get("cell_id", f"cell_{most_stress}"),
        "max_acceleration":   round(float(-delta.min() * 100), 1),  # % RUL reduction
        "pack_imbalance_pct": round(float(corrected.std() / (corrected.mean() + 1e-6) * 100), 1),
        "n_cells_stressed":   int((delta < -0.05).sum()),
        "topology":           topology,
    }

    return {
        "corrected_ruls":     [round(float(r), 1) for r in corrected],
        "base_ruls":          [round(float(r), 1) for r in base_ruls],
        "deltas":             [round(float(d), 4) for d in delta],
        "delta_pct":          [round(float(d * 100), 1) for d in delta],
        "pack_rul":           round(pack_rul, 1),
        "pack_lower_90":      lower_90,
        "pack_upper_90":      upper_90,
        "confidence_width":   round(ci_half * 2, 1),
        "source":             source,
        "interaction_summary": interaction,
    }

"""
core/thermal_coupling_lstm.py — Pack-level thermal coupling model.

Predicts each cell's next-step temperature given the recent per-cell
temperature history of the whole pack. Captures *coupling* — a hot cell
heats its neighbours and the neighbours' temperatures feed back.

Architecture
------------
    Input  : (B, N_cells, T, 4)   per-cell, per-time features
             [temperature, current, voltage, dt]
    Output : (B, N_cells, 1)      next-step temperature delta per cell

    Per-cell LSTM (shared) encodes each cell's time series → h_i ∈ R^d.
    Cross-cell multi-head self-attention mixes the {h_i} across cells in
    one shot so each cell can attend to every other cell — that IS the
    coupling term.
    A small MLP head reads the attended h_i and predicts ΔT_i for the
    next step.

The model is small (~50–100 K params for d=64, n_heads=4, 1 LSTM layer)
and runs on CPU in real time for packs up to ~256 cells.

Loss is MSE on ΔT_i; truth is the next observed temperature.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

logger = logging.getLogger(__name__)


N_FEATURES   = 4    # temperature, current, voltage, dt_seconds
DEFAULT_D    = 64
DEFAULT_HEADS = 4
DEFAULT_LSTM_LAYERS = 1

_CKPT_PATH = (
    Path(__file__).parent.parent.parent
    / "processed" / "thermal_coupling" / "checkpoint.pt"
)
_META_PATH = _CKPT_PATH.with_suffix(".json")


@dataclass
class ThermalCouplingPrediction:
    cell_id:        str
    current_t:      float
    predicted_t:    float
    delta_t:        float
    coupling_score: float


class ThermalCouplingLSTM(nn.Module):
    """Per-cell LSTM + cross-cell attention pack thermal model."""

    def __init__(self, d_hidden: int = DEFAULT_D, n_heads: int = DEFAULT_HEADS,
                 lstm_layers: int = DEFAULT_LSTM_LAYERS, dropout: float = 0.1):
        super().__init__()
        self.d_hidden = d_hidden
        self.n_heads  = n_heads
        self.input_proj = nn.Linear(N_FEATURES, d_hidden)
        self.lstm = nn.LSTM(
            input_size=d_hidden, hidden_size=d_hidden,
            num_layers=lstm_layers, batch_first=True,
            dropout=dropout if lstm_layers > 1 else 0.0,
        )
        self.cross_cell_attn = nn.MultiheadAttention(
            embed_dim=d_hidden, num_heads=n_heads,
            dropout=dropout, batch_first=True,
        )
        self.norm = nn.LayerNorm(d_hidden)
        self.head = nn.Sequential(
            nn.Linear(d_hidden, d_hidden), nn.ReLU(),
            nn.Linear(d_hidden, 1),
        )

    def forward(self, x: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """
        x: (B, N, T, F)  →  delta_t (B, N, 1), attn (B, N, N)
        """
        B, N, T, F = x.shape
        x = x.reshape(B * N, T, F)
        x = self.input_proj(x)
        _, (h, _) = self.lstm(x)        # h: (layers, B*N, d)
        h = h[-1]                       # (B*N, d)
        h = h.reshape(B, N, self.d_hidden)
        attended, attn_weights = self.cross_cell_attn(h, h, h, need_weights=True)
        h = self.norm(h + attended)
        delta_t = self.head(h)
        return delta_t, attn_weights


def _prepare_pack_tensor(temperatures: list[list[float]],
                         currents:     list[list[float]] | None,
                         voltages:     list[list[float]] | None,
                         dt_seconds:   float = 1.0) -> torch.Tensor:
    """
    temperatures[i][t] = cell i's temperature at step t.
    All inputs same shape (N x T). Missing channels are zero-filled.

    Returns (1, N, T, 4) tensor.
    """
    T_arr = np.array(temperatures, dtype=np.float32)
    if T_arr.ndim != 2:
        raise ValueError("temperatures must be a 2D list (N x T)")
    N, T = T_arr.shape

    def _norm_or_zero(seq, default):
        if seq is None:
            return np.zeros_like(T_arr) + float(default)
        arr = np.array(seq, dtype=np.float32)
        if arr.shape != T_arr.shape:
            raise ValueError("currents/voltages must match temperatures shape")
        return arr

    I_arr = _norm_or_zero(currents, 0.0)
    V_arr = _norm_or_zero(voltages, 3.7)
    dt_ch = np.full_like(T_arr, float(dt_seconds))
    stacked = np.stack([T_arr, I_arr, V_arr, dt_ch], axis=-1)  # (N, T, 4)
    return torch.tensor(stacked, dtype=torch.float32).unsqueeze(0)


def predict_pack(temperatures: list[list[float]],
                 currents: list[list[float]] | None = None,
                 voltages: list[list[float]] | None = None,
                 cell_ids: list[str] | None = None,
                 dt_seconds: float = 1.0,
                 model: ThermalCouplingLSTM | None = None) -> dict:
    """Run a forward pass and return structured predictions per cell.

    If `model` is None, a trained checkpoint is loaded from disk.
    If no checkpoint exists, an untrained model is used and `mode` is
    tagged so callers know predictions are random-init (honest signal).
    """
    if model is None:
        model, mode = _load_or_init_model()
    else:
        mode = "in_memory"
    x = _prepare_pack_tensor(temperatures, currents, voltages, dt_seconds)
    model.eval()
    with torch.no_grad():
        delta, attn = model(x)         # (1, N, 1), (1, N, N)
    delta = delta.squeeze(0).squeeze(-1).cpu().numpy()
    attn  = attn.squeeze(0).cpu().numpy()
    N = len(temperatures)
    if cell_ids is None or len(cell_ids) != N:
        cell_ids = [f"cell_{i}" for i in range(N)]

    last_temps = [float(row[-1]) for row in temperatures]
    coupling = attn.sum(axis=1) - np.diag(attn)
    out = []
    for i in range(N):
        out.append({
            "cell_id":        cell_ids[i],
            "current_t":      round(last_temps[i], 3),
            "predicted_t":    round(last_temps[i] + float(delta[i]), 3),
            "delta_t":        round(float(delta[i]), 4),
            "coupling_score": round(float(coupling[i]), 4),
        })
    return {
        "mode":           mode,
        "n_cells":        N,
        "predictions":    out,
        "attention":      attn.round(4).tolist(),
        "max_delta_t":    round(float(np.max(np.abs(delta))), 4),
        "hottest_predicted_cell": cell_ids[int(np.argmax([p["predicted_t"] for p in out]))],
    }


def _load_or_init_model() -> tuple[ThermalCouplingLSTM, str]:
    """Load a trained checkpoint if present, otherwise return a fresh model."""
    meta = {"d_hidden": DEFAULT_D, "n_heads": DEFAULT_HEADS,
            "lstm_layers": DEFAULT_LSTM_LAYERS}
    if _META_PATH.exists():
        try:
            meta = json.loads(_META_PATH.read_text())
        except Exception:
            pass
    model = ThermalCouplingLSTM(
        d_hidden=meta.get("d_hidden", DEFAULT_D),
        n_heads=meta.get("n_heads", DEFAULT_HEADS),
        lstm_layers=meta.get("lstm_layers", DEFAULT_LSTM_LAYERS),
    )
    if _CKPT_PATH.exists():
        try:
            state = torch.load(_CKPT_PATH, map_location="cpu", weights_only=False)
            model.load_state_dict(state["model_state_dict"], strict=False)
            return model, "trained"
        except Exception as exc:
            logger.warning("thermal LSTM checkpoint load failed: %s", exc)
    return model, "untrained"


def train_on_pack_traces(traces: list[dict], *, epochs: int = 50,
                         lr: float = 1e-3, batch_size: int = 4,
                         d_hidden: int = DEFAULT_D, n_heads: int = DEFAULT_HEADS,
                         lstm_layers: int = DEFAULT_LSTM_LAYERS,
                         out_path: Path | None = None) -> dict:
    """Train the LSTM+attention model on a list of pack traces.

    Each trace is a dict with keys:
      - "temperatures": (N x T+1) list — predict step t+1 from window 0..t.
      - "currents", "voltages": same shape (optional).
      - "dt_seconds": float (optional).

    We split each trace into (window=T, target=temperatures[:, T]).
    """
    if not traces:
        raise ValueError("no traces given")

    def _build(trace):
        T_arr = np.array(trace["temperatures"], dtype=np.float32)
        if T_arr.ndim != 2 or T_arr.shape[1] < 4:
            raise ValueError("each trace needs ≥4 time steps")
        N, Tplus1 = T_arr.shape
        window = T_arr[:, :-1]
        target = T_arr[:, -1] - T_arr[:, -2]  # ΔT_next
        I_arr = trace.get("currents") and np.array(trace["currents"], dtype=np.float32)[:, :-1]
        V_arr = trace.get("voltages") and np.array(trace["voltages"], dtype=np.float32)[:, :-1]
        dt    = float(trace.get("dt_seconds", 1.0))
        x = _prepare_pack_tensor(window.tolist(),
                                 I_arr.tolist() if I_arr is not None else None,
                                 V_arr.tolist() if V_arr is not None else None,
                                 dt_seconds=dt)
        y = torch.tensor(target, dtype=torch.float32).unsqueeze(0).unsqueeze(-1)  # (1, N, 1)
        return x.squeeze(0), y.squeeze(0)   # (N, T, 4), (N, 1)

    samples = [_build(t) for t in traces]
    model = ThermalCouplingLSTM(d_hidden=d_hidden, n_heads=n_heads,
                                lstm_layers=lstm_layers)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    loss_fn = nn.MSELoss()

    history = []
    for ep in range(epochs):
        model.train()
        ep_loss = 0.0
        np.random.shuffle(samples)
        for i in range(0, len(samples), batch_size):
            batch = samples[i:i + batch_size]
            max_N = max(b[0].shape[0] for b in batch)
            T = batch[0][0].shape[1]
            B = len(batch)
            X = torch.zeros(B, max_N, T, N_FEATURES)
            Y = torch.zeros(B, max_N, 1)
            mask = torch.zeros(B, max_N, 1)
            for bi, (xi, yi) in enumerate(batch):
                X[bi, :xi.shape[0]] = xi
                Y[bi, :yi.shape[0]] = yi
                mask[bi, :yi.shape[0]] = 1.0
            pred, _ = model(X)
            loss = ((pred - Y) * mask).pow(2).sum() / mask.sum().clamp(min=1)
            opt.zero_grad(); loss.backward(); opt.step()
            ep_loss += float(loss.detach())
        history.append({"epoch": ep, "loss": round(ep_loss / max(1, len(samples)), 6)})

    ckpt = out_path or _CKPT_PATH
    ckpt.parent.mkdir(parents=True, exist_ok=True)
    torch.save({"model_state_dict": model.state_dict(),
                "d_hidden": d_hidden, "n_heads": n_heads,
                "lstm_layers": lstm_layers}, ckpt)
    meta = {"d_hidden": d_hidden, "n_heads": n_heads,
            "lstm_layers": lstm_layers, "n_traces": len(traces),
            "epochs": epochs, "final_loss": history[-1]["loss"] if history else None}
    ckpt.with_suffix(".json").write_text(json.dumps(meta, indent=2))
    return {"checkpoint": str(ckpt), "meta": meta, "history": history}


def status() -> dict:
    return {
        "model_available": _CKPT_PATH.exists(),
        "checkpoint":      str(_CKPT_PATH) if _CKPT_PATH.exists() else None,
        "n_features":      N_FEATURES,
        "defaults":        {"d_hidden": DEFAULT_D, "n_heads": DEFAULT_HEADS,
                            "lstm_layers": DEFAULT_LSTM_LAYERS},
    }

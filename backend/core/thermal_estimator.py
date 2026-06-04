"""
core/thermal_estimator.py — learned core-temperature virtual sensor (DeepONet).

Replaces the hand-tuned 2-state physics estimate (core.thermal_field.estimate_core_temp)
with a DeepONet trained on PyBaMM electrochemical-thermal data. Branch = operating signals
(+ thermal-memory EWMAs); trunk = radial coordinate r∈[0,1]; T(r) = branch·trunk. Querying
r=0 gives the (unmeasurable) core temperature, r=1 the surface. Ensemble → uncertainty.

Shared by scripts/train_thermal_deeponet.py (training) and routers/thermal_twin.py (serving),
so feature engineering and architecture never drift. If no trained model is present,
load_estimator() returns None and the router falls back to the physics estimate.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

MODEL_PATH = Path(__file__).resolve().parent.parent / "data" / "thermal" / "deeponet_thermal.pt"
BASE_FEATURES = ["I", "i_s", "i_sq", "soc", "surface_T", "ambient_T"]
MEMORY_SIGNALS = ["i_s", "i_sq"]
HALFLIVES_S = [60, 300, 1800]
SAMPLE_PERIOD_S = 20.0


def feature_columns() -> list[str]:
    cols = list(BASE_FEATURES)
    for c in MEMORY_SIGNALS:
        for hl in HALFLIVES_S:
            cols.append(f"{c}_ewma{hl}")
    return cols


def engineer(df: pd.DataFrame, period_s: float = SAMPLE_PERIOD_S) -> np.ndarray:
    """Build the branch feature matrix from a chronological per-cell/per-run frame.
    Requires columns: I, soc, surface_T, ambient_T."""
    d = df.copy()
    d["i_s"] = d["I"].abs()
    d["i_sq"] = d["I"] ** 2
    for c in MEMORY_SIGNALS:
        for hl in HALFLIVES_S:
            d[f"{c}_ewma{hl}"] = d[c].ewm(halflife=max(1.0, hl / period_s)).mean()
    return d[feature_columns()].to_numpy(np.float32)


# ── model ────────────────────────────────────────────────────────────────────
def _build_net(n_in: int, latent: int, hidden: list[int]):
    import torch.nn as nn

    def mlp(sizes, last_act):
        L = []
        for i in range(len(sizes) - 1):
            L.append(nn.Linear(sizes[i], sizes[i + 1]))
            if i < len(sizes) - 2 or last_act:
                L.append(nn.GELU())
        return nn.Sequential(*L)

    class DeepONet(nn.Module):
        def __init__(self):
            super().__init__()
            self.branch = mlp([n_in, *hidden, latent], last_act=False)
            self.trunk = mlp([1, *hidden, latent], last_act=True)
            self.bias = nn.Parameter(__import__("torch").zeros(1))

        def forward(self, x, r):
            return self.branch(x) @ self.trunk(r).t() + self.bias  # (B, Qr)

    return DeepONet()


@dataclass
class LearnedEstimator:
    models: list
    x_mean: np.ndarray
    x_std: np.ndarray
    t_mean: float
    t_std: float
    period_s: float

    def core_from_frame(self, df: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
        """Return (core_mean, core_sigma) in °C for each row of a chronological frame."""
        import torch

        X = engineer(df, self.period_s)
        Xs = (X - self.x_mean) / self.x_std
        xt = torch.tensor(Xs, dtype=torch.float32)
        r0 = torch.zeros(1, 1)                       # query the core (r=0)
        with torch.no_grad():
            preds = np.stack([(m(xt, r0).squeeze(1).numpy() * self.t_std + self.t_mean)
                              for m in self.models])
        return preds.mean(0), preds.std(0)


_CACHE: dict = {}


def load_estimator():
    """Load the trained ensemble (cached). Returns None if no model file exists."""
    if "est" in _CACHE:
        return _CACHE["est"]
    if not MODEL_PATH.exists():
        _CACHE["est"] = None
        return None
    import torch

    ck = torch.load(MODEL_PATH, map_location="cpu", weights_only=False)
    models = []
    for sd in ck["state_dicts"]:
        net = _build_net(ck["n_in"], ck["latent"], ck["hidden"])
        net.load_state_dict(sd)
        net.eval()
        models.append(net)
    est = LearnedEstimator(models, np.asarray(ck["x_mean"], np.float32),
                           np.asarray(ck["x_std"], np.float32),
                           float(ck["t_mean"]), float(ck["t_std"]),
                           float(ck.get("period_s", SAMPLE_PERIOD_S)))
    _CACHE["est"] = est
    return est

"""
core/physics_loss.py — Physics-informed penalty terms for the Phase C
internal-state head.

The head's MSE loss says "match the label." These penalties say "stay
physical." They are defensible from first principles and don't require
extra data — they regularize the head toward valid electrochemistry.

Constraints encoded today (all differentiable, all soft):
  1. Non-negativity on physical quantities
       (k_sei, k_crack, Q0, sei_thickness_nm, cycles_to_eol, temp_stress_index)
  2. Bounded [0, 1] on fraction / probability quantities
       (alpha, lli_fraction, lam_fraction, lithium_plating_risk)
  3. Partition: lli_fraction + lam_fraction ≈ 1   (they split the total fade)
  4. Arrhenius-flavored consistency: when temperature stress is above the
     batch median, the SEI rate constant k_sei should be above its batch
     median too (smooth rank-style penalty).

All terms return scalars and are summed; an outer λ controls the total
contribution to the loss. Predictions are in min-max scaled space; the
function de-scales internally so the constraints are checked in physical
units (no surprises from the scaler).
"""
from __future__ import annotations

import torch


_NON_NEGATIVE = (
    "k_sei", "k_crack", "Q0", "sei_thickness_nm",
    "cycles_to_eol", "temp_stress_index",
)
_FRACTION_KEYS = ("alpha", "lli_fraction", "lam_fraction", "lithium_plating_risk")


def physics_constraint_loss(
    pred_int_scaled: torch.Tensor,
    y_min: list[float] | torch.Tensor,
    y_max: list[float] | torch.Tensor,
    keys: list[str],
    include_arrhenius: bool = True,
) -> tuple[torch.Tensor, dict]:
    """Compute the total physics penalty + a breakdown dict (for logging).

    pred_int_scaled : (B, n_keys), head output in min-max scaled space.
    y_min, y_max    : per-key min/max from the training-set scaler.
    keys            : ordered list matching the last dim of pred_int_scaled.
    """
    device = pred_int_scaled.device
    dtype  = pred_int_scaled.dtype
    y_min_t = torch.as_tensor(y_min, dtype=dtype, device=device)
    y_max_t = torch.as_tensor(y_max, dtype=dtype, device=device)
    y_rng   = (y_max_t - y_min_t).clamp(min=1e-6)

    idx = {k: i for i, k in enumerate(keys)}
    parts: dict[str, torch.Tensor] = {}

    # All penalties are computed in SCALED space so their magnitudes are comparable
    # across keys regardless of physical range (e.g., cycles_to_eol [0..2000] vs
    # lli_fraction [0..1] no longer fight each other). The constraint thresholds
    # in scaled space are derived from the physical bounds:
    #     scaled_for_physical(p) = (p - y_min) / y_rng

    # 1. Non-negativity — penalize predictions below the scaled image of physical 0.
    nn_terms = []
    for key in _NON_NEGATIVE:
        if key in idx:
            i = idx[key]
            scaled_zero = -y_min_t[i] / y_rng[i]   # physical 0 → scaled coord
            v = pred_int_scaled[:, i]
            nn_terms.append(torch.relu(scaled_zero - v).pow(2).mean())
    parts["non_negative"] = torch.stack(nn_terms).sum() if nn_terms \
                            else torch.tensor(0.0, device=device)

    # 2. Fraction bounds — penalize outside the scaled image of physical [0, 1].
    fr_terms = []
    for key in _FRACTION_KEYS:
        if key in idx:
            i = idx[key]
            scaled_low  = -y_min_t[i] / y_rng[i]
            scaled_high = (1.0 - y_min_t[i]) / y_rng[i]
            v = pred_int_scaled[:, i]
            fr_terms.append(torch.relu(scaled_low - v).pow(2).mean())
            fr_terms.append(torch.relu(v - scaled_high).pow(2).mean())
    parts["fraction_bounds"] = torch.stack(fr_terms).sum() if fr_terms \
                                else torch.tensor(0.0, device=device)

    # 3. Partition: physical lli + physical lam ≈ 1. Expressed via the affine
    #    de-scaling so the constraint is on real fractions, not the scaled vars.
    if "lli_fraction" in idx and "lam_fraction" in idx:
        i_lli, i_lam = idx["lli_fraction"], idx["lam_fraction"]
        lli_phys = pred_int_scaled[:, i_lli] * y_rng[i_lli] + y_min_t[i_lli]
        lam_phys = pred_int_scaled[:, i_lam] * y_rng[i_lam] + y_min_t[i_lam]
        parts["partition"] = (lli_phys + lam_phys - 1.0).pow(2).mean()
    else:
        parts["partition"] = torch.tensor(0.0, device=device)

    # 4. Arrhenius-flavored soft rank consistency: high temp_stress → high k_sei.
    #    Differentiable via sigmoid surrogate. Operates in scaled space (rank is
    #    scale-invariant).
    if include_arrhenius and "temp_stress_index" in idx and "k_sei" in idx \
            and pred_int_scaled.shape[0] >= 4:
        ts = pred_int_scaled[:, idx["temp_stress_index"]]
        ks = pred_int_scaled[:, idx["k_sei"]]
        ts_med = ts.median()
        ks_med = ks.median()
        ts_hi = torch.sigmoid(4.0 * (ts - ts_med))
        ks_hi = torch.sigmoid(4.0 * (ks - ks_med))
        # Discordant pairs: ts_hi & not ks_hi  OR  ks_hi & not ts_hi
        discord = (ts_hi * (1 - ks_hi) + ks_hi * (1 - ts_hi)).mean()
        parts["arrhenius"] = discord
    else:
        parts["arrhenius"] = torch.tensor(0.0, device=device)

    total = parts["non_negative"] + parts["fraction_bounds"] \
            + parts["partition"] + parts["arrhenius"]
    return total, {k: float(v.detach().item()) for k, v in parts.items()}

"""
Tests for core.physics_loss.physics_constraint_loss — verifies the penalty
is zero for physically valid predictions and positive when violated.
"""
import torch

from core.physics_loss import physics_constraint_loss


KEYS = (
    "k_sei", "k_crack", "alpha", "Q0",
    "sei_thickness_nm", "lli_fraction", "lam_fraction",
    "ir_growth_pct", "cycles_to_eol",
    "temp_stress_index", "lithium_plating_risk",
    "fit_r2", "fit_mape",
)


def _scaled_from_phys(phys_vals: list[float], y_min: list[float], y_max: list[float]) -> torch.Tensor:
    """Inverse the min-max scaling: given physical values + bounds, return scaled tensor."""
    out = []
    for v, lo, hi in zip(phys_vals, y_min, y_max):
        rng = max(hi - lo, 1e-6)
        out.append((v - lo) / rng)
    return torch.tensor([out], dtype=torch.float32)


def test_zero_for_valid_predictions():
    # all physically valid: k_sei>0, alpha in [0,1], lli+lam=1, etc.
    y_min = [0.0, 0.0, 0.0, 0.5, 0.0, 0.0, 0.0, -10.0, 0.0,  0.0, 0.0, 0.0, 0.0]
    y_max = [0.1, 0.01,1.0, 2.0, 100.0, 1.0, 1.0,  10.0, 2000.0, 1.0, 1.0, 1.0, 5.0]
    phys  = [0.005, 0.001, 0.55, 1.1, 12.0, 0.6, 0.4, 2.0, 800.0, 0.2, 0.1, 0.95, 1.2]
    pred  = _scaled_from_phys(phys, y_min, y_max)
    total, parts = physics_constraint_loss(pred, y_min, y_max, list(KEYS))
    assert total.item() < 1e-3, f"expected ~0 penalty for valid input, got {total.item()}"


def test_partition_violation_penalized():
    y_min = [0.0]*13; y_max = [1.0]*13
    # lli=0.7, lam=0.7 → sum = 1.4 → should be penalized
    phys = [0.005, 0.001, 0.5, 1.0, 12.0, 0.7, 0.7, 0.0, 500.0, 0.0, 0.0, 0.9, 0.5]
    pred = _scaled_from_phys(phys, y_min, y_max)
    total, parts = physics_constraint_loss(pred, y_min, y_max, list(KEYS))
    assert parts["partition"] > 0.01


def test_non_negative_violation_penalized():
    y_min = [-0.5]*13; y_max = [1.0]*13   # allow negative in scaler range
    # k_sei negative — must be penalized
    phys = [-0.3, 0.001, 0.5, 1.0, 12.0, 0.5, 0.5, 0.0, 500.0, 0.0, 0.0, 0.9, 0.5]
    pred = _scaled_from_phys(phys, y_min, y_max)
    total, parts = physics_constraint_loss(pred, y_min, y_max, list(KEYS))
    assert parts["non_negative"] > 0.0


def test_fraction_out_of_bounds_penalized():
    y_min = [-0.5]*13; y_max = [2.0]*13
    # alpha = 1.8 (>1) — must be penalized
    phys = [0.005, 0.001, 1.8, 1.0, 12.0, 0.5, 0.5, 0.0, 500.0, 0.0, 0.0, 0.9, 0.5]
    pred = _scaled_from_phys(phys, y_min, y_max)
    total, parts = physics_constraint_loss(pred, y_min, y_max, list(KEYS))
    assert parts["fraction_bounds"] > 0.01


def test_loss_is_differentiable():
    y_min = [0.0]*13; y_max = [1.0]*13
    pred = torch.full((4, 13), 1.5, requires_grad=True)
    total, _ = physics_constraint_loss(pred, y_min, y_max, list(KEYS))
    total.backward()
    assert pred.grad is not None
    assert torch.isfinite(pred.grad).all()

"""
core/thermal_field.py — Cell thermal digital twin: core-temperature virtual sensing
plus a full 2D cross-section thermal field for live visualization.

Why this exists: the dashboard measures cell SURFACE temperature, but the unmeasurable
CORE temperature is what drives degradation and thermal runaway. This module
  1. estimates core temperature from V/I/SOC/surface-T via a 2-state thermal model
     (Bernardi heat generation Q = I²·R_int(SOC) + entropic), and
  2. reconstructs the full cross-section field T(x,y) as a partition-of-unity blend of
     the core and surface temperatures — analytically, numpy-only (no FEM dependency):
         T(x,y) = core·χ_core(x,y) + surface·χ_surf(x,y),   χ_core + χ_surf ≡ 1
     Cylindrical: parabolic radial profile (uniform-generation analytic solution).
     Pouch:       separable (1-(x/a)²)(1-(y/b)²) bowl.

The frontend fetches the geometry + χ basis ONCE, then streams only {core, surface} per
tick and reconstructs the field client-side (tiny payload, smooth real-time).

PyBaMM (already in this repo) is the higher-fidelity offline label/validation source;
this module is the fast real-time engine.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np


# ── 2-state thermal + simple ECM parameters (typical 21700-class cell) ───────
@dataclass
class ThermalParams:
    C_core: float = 80.0      # core heat capacity [J/K]
    C_surf: float = 12.0      # surface/can heat capacity [J/K]
    R_cc:   float = 2.0       # core↔surface thermal resistance [K/W]
    R_cu:   float = 6.0       # surface↔coolant/ambient resistance [K/W] (cooling)
    R0:     float = 0.030     # ohmic internal resistance [Ω]
    soc_r_gain: float = 0.6   # extra resistance at SOC extremes (U-shape)
    entropic_mv_per_k: float = 0.2   # |dU/dT| ~ mV/K, small entropic heat
    cell_capacity_ah: float = 5.0

    def r_internal(self, soc: float) -> float:
        """Internal resistance rises at low/high SOC (mild U-shape)."""
        s = float(np.clip(soc, 0.0, 1.0))
        return self.R0 * (1.0 + self.soc_r_gain * (2.0 * s - 1.0) ** 2)


def heat_generation(current_a: float, soc: float, surf_t_c: float, p: ThermalParams) -> float:
    """Bernardi heat: ohmic I²R + entropic I·T·dU/dT  [W]."""
    r = p.r_internal(soc)
    q_ohmic = current_a ** 2 * r
    q_entropic = abs(current_a) * (surf_t_c + 273.15) * (p.entropic_mv_per_k * 1e-3)
    return q_ohmic + q_entropic


def estimate_core_temp(surf_t_c: float, current_a: float, soc: float,
                       p: ThermalParams) -> tuple[float, float]:
    """Quasi-steady core-temp virtual sensor from measurable signals.

    At quasi-steady state the core-surface gradient is ΔT ≈ R_cc · Q. Returns
    (core_temp_c, sigma_c) where sigma reflects parameter uncertainty on the gradient.
    """
    q = heat_generation(current_a, soc, surf_t_c, p)
    dT = p.R_cc * q
    core = surf_t_c + dT
    sigma = max(0.5, 0.25 * dT)          # ~25% gradient uncertainty, floor 0.5 °C
    return float(core), float(sigma)


# ── analytic χ basis + mesh for both geometries ─────────────────────────────
def _polar_disk(nr: int, nth: int):
    r = np.linspace(0.0, 1.0, nr + 1)
    th = np.linspace(0.0, 2 * np.pi, nth, endpoint=False)
    R, TH = np.meshgrid(r, th, indexing="ij")
    x = (R * np.cos(TH)).ravel()
    y = (R * np.sin(TH)).ravel()
    tris = []
    nid = lambda i, j: i * nth + (j % nth)  # noqa: E731
    for i in range(nr):
        for j in range(nth):
            a, b, c, d = nid(i, j), nid(i + 1, j), nid(i + 1, j + 1), nid(i, j + 1)
            if i == 0:                       # center fan (avoid degenerate triangles)
                tris.append([nid(0, 0), b, c])
            else:
                tris.append([a, b, c]); tris.append([a, c, d])
    return np.vstack([x, y]), np.array(tris, dtype=int).T, np.sqrt(x ** 2 + y ** 2)


def _rect_plate(nx: int, ny: int):
    gx = np.linspace(-1.0, 1.0, nx)
    gy = np.linspace(-1.0, 1.0, ny)
    X, Y = np.meshgrid(gx, gy, indexing="ij")
    x, y = X.ravel(), Y.ravel()
    tris = []
    nid = lambda i, j: i * ny + j  # noqa: E731
    for i in range(nx - 1):
        for j in range(ny - 1):
            a, b, c, d = nid(i, j), nid(i + 1, j), nid(i + 1, j + 1), nid(i, j + 1)
            tris.append([a, b, c]); tris.append([a, c, d])
    return np.vstack([x, y]), np.array(tris, dtype=int).T, x, y


def build_field_basis(geometry: str = "cylindrical", n: int = 36) -> dict:
    """Mesh + χ_core (partition basis) for a cell cross-section, + a 2D heatmap grid.

    Returns the static payload the frontend caches once. Field at any time is then
    T = core·χ_core + surface·(1-χ_core), reconstructed client-side.
    """
    if geometry == "cylindrical":
        nodes, tris, r = _polar_disk(n, max(48, 2 * n))
        chi_core = 1.0 - r ** 2                                  # parabolic, 1 center → 0 edge
        # heatmap grid (Cartesian, masked outside the disk → NaN)
        g = np.linspace(-1.0, 1.0, 80)
        GX, GY = np.meshgrid(g, g, indexing="xy")
        rg = np.sqrt(GX ** 2 + GY ** 2)
        chi_grid = np.where(rg <= 1.0, 1.0 - rg ** 2, np.nan).ravel()
        grid_x, grid_y, nx, ny = g, g, 80, 80
    elif geometry == "pouch":
        nodes, tris, x, y = _rect_plate(n, n)
        chi_core = (1.0 - x ** 2) * (1.0 - y ** 2)               # separable bowl
        g = np.linspace(-1.0, 1.0, 80)
        GX, GY = np.meshgrid(g, g, indexing="xy")
        chi_grid = ((1.0 - GX ** 2) * (1.0 - GY ** 2)).ravel()
        grid_x, grid_y, nx, ny = g, g, 80, 80
    else:
        raise ValueError(f"unknown geometry '{geometry}' (use cylindrical|pouch)")

    chi_core = np.clip(chi_core, 0.0, 1.0)
    return {
        "geometry": geometry,
        "x": np.round(nodes[0], 4).tolist(),
        "y": np.round(nodes[1], 4).tolist(),
        "i": tris[0].tolist(), "j": tris[1].tolist(), "k": tris[2].tolist(),
        "chi_core": np.round(chi_core, 4).tolist(),               # χ_surf = 1 - χ_core
        "grid_x": np.round(grid_x, 4).tolist(),
        "grid_y": np.round(grid_y, 4).tolist(),
        "nx": nx, "ny": ny,
        "chi_core_grid": [None if not np.isfinite(v) else round(float(v), 4) for v in chi_grid],
    }


# ── fast 2-state forward simulation (for the synthetic live demo) ────────────
def simulate(current_a: np.ndarray, soc: np.ndarray, ambient_c: float,
             p: ThermalParams, dt_s: float = 1.0,
             cooling_factor: np.ndarray | None = None,
             init_c: float | None = None) -> dict:
    """Integrate the 2-state thermal model over a current/SOC profile.

    cooling_factor (per step, ≤1) degrades R_cu → simulates a cooling fault.
    Returns time-series of core/surface temps + heat — the synthetic 'live' trajectory.
    """
    n = len(current_a)
    cf = np.ones(n) if cooling_factor is None else np.asarray(cooling_factor)
    T0 = ambient_c if init_c is None else init_c
    Tc, Ts = T0, T0
    out = {k: np.empty(n) for k in ("core", "surface", "heat_w", "core_sigma")}
    for t in range(n):
        q = heat_generation(float(current_a[t]), float(soc[t]), Ts, p)
        r_cu = p.R_cu / max(cf[t], 1e-3)                          # cooling fault ↑ resistance
        dTc = (q - (Tc - Ts) / p.R_cc) / p.C_core
        dTs = ((Tc - Ts) / p.R_cc - (Ts - ambient_c) / r_cu) / p.C_surf
        Tc += dt_s * dTc; Ts += dt_s * dTs
        out["core"][t] = Tc; out["surface"][t] = Ts; out["heat_w"][t] = q
        out["core_sigma"][t] = max(0.5, 0.25 * (Tc - Ts))
    return {k: np.round(v, 3).tolist() for k, v in out.items()}


def _pulsed_current(n: int, base_c: float, peak_c: float, cap_ah: float, seed: int = 0):
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    c_rate = base_c + (peak_c - base_c) * (0.5 * (1 + np.sin(2 * np.pi * t / 90)) ** 3) * \
        (np.sin(2 * np.pi * t / 240) > -0.2)
    c_rate = np.clip(c_rate + rng.normal(0, 0.05, n), 0, peak_c)
    current = c_rate * cap_ah
    soc = np.clip(1.0 - np.cumsum(current / 3600.0) / cap_ah, 0.05, 1.0)
    return current, soc


def simulate_pack(rows: int, cols: int, ambient_c: float, p: ThermalParams,
                  n_steps: int = 600, dt_s: float = 1.0,
                  base_c_rate: float = 1.3, peak_c_rate: float = 3.5, capacity_ah: float = 5.0,
                  cooling_fault: bool = True, fault_frac: float = 0.4,
                  weak_cell: bool = True, seed: int = 0):
    """Per-cell 2-state thermal simulation across a module grid (vectorized over cells).

    Models real pack effects: center cells cool worse than edges, one weak (high-R) cell,
    and a localized cooling fault in one quadrant. Returns per-cell core temps over time.
    """
    n = rows * cols
    rng = np.random.default_rng(seed)
    rc = np.array([(i // cols, i % cols) for i in range(n)], float)
    cy, cx = (rows - 1) / 2.0, (cols - 1) / 2.0
    # baseline cooling: edge cells cool better (→1.0), center worse (→0.55) — dist↑ ⇒ cooling↑
    dist = np.sqrt(((rc[:, 0] - cy) / (rows / 2 + 1e-9)) ** 2 + ((rc[:, 1] - cx) / (cols / 2 + 1e-9)) ** 2)
    cool_pos = np.clip(0.55 + 0.45 * dist, 0.55, 1.0)
    r_scale = 1.0 + rng.normal(0, 0.06, n)                       # ±6% internal-resistance spread
    weak_idx = int(np.argmin(cool_pos)) if weak_cell else -1
    if weak_idx >= 0:
        r_scale[weak_idx] *= 1.45                                # a hot weak cell

    current, soc = _pulsed_current(n_steps, base_c_rate, peak_c_rate, capacity_ah, seed)
    fault_t = int(fault_frac * n_steps)
    # localized fault region: bottom-right quadrant loses cooling
    fault_region = ((rc[:, 0] >= rows / 2) & (rc[:, 1] >= cols / 2)).astype(float)

    Tc = np.full(n, ambient_c); Ts = np.full(n, ambient_c)
    cores = np.empty((n_steps, n)); surfs = np.empty((n_steps, n))
    for s in range(n_steps):
        ramp = 0.0
        if cooling_fault and s >= fault_t:
            ramp = min(1.0, (s - fault_t) / (0.1 * n_steps))
        cooling = cool_pos * (1.0 - fault_region * ramp * 0.65)
        I = current[s]
        q = I ** 2 * (p.R0 * r_scale) + abs(I) * (Ts + 273.15) * (p.entropic_mv_per_k * 1e-3)
        r_cu = p.R_cu / np.clip(cooling, 1e-3, None)
        Tc += dt_s * (q - (Tc - Ts) / p.R_cc) / p.C_core
        Ts += dt_s * ((Tc - Ts) / p.R_cc - (Ts - ambient_c) / r_cu) / p.C_surf
        cores[s] = Tc; surfs[s] = Ts
    return {"rows": rows, "cols": cols, "n_cells": n, "weak_idx": weak_idx,
            "fault_step": fault_t if cooling_fault else None,
            "fault_region": fault_region.astype(int).tolist(),
            "current": current, "cores": cores, "surfs": surfs}


def default_params_dict() -> dict:
    return asdict(ThermalParams())

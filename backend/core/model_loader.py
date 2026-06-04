"""
model_loader.py — loads real PyTorch checkpoints and runs inference.

Supported models:
  v10-final  : MambaRULFinal (cip + core), d_model=128, n_mamba=3, n_anchors=3
  v10-full   : MambaRULCore, same arch, no CIP
  v9         : MambaRULCore, same arch
  v8         : MambaRULCore, same arch (no anchors or with anchors)
  tcn-mamba  : TCNMambaModel

Each model:
  - Loaded once at startup into _MODELS dict
  - Runs on CPU (no GPU needed for inference)
  - Input: (1, 30, 13) normalized tensor
  - Output: scalar normalized RUL → multiply by CALCE_RUL_MAX
"""
from __future__ import annotations
import logging
import sys
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent.parent.parent   # mamba_rul_project/
SRC_DIR      = PROJECT_ROOT / "src"
RESULTS_DIR  = PROJECT_ROOT / "thesis_results"
TCN_DIR      = PROJECT_ROOT / "tcn_mamba_rul"

# Add src to path for model imports
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

CALCE_RUL_MAX  = 309.0   # normalization constant used during training
WINDOW_SIZE    = 30
REF_CAP        = 1.05    # CALCE CS2 nominal capacity (Ah)
REF_IR_FRESH   = 0.040   # CALCE fresh-cell internal resistance (Ω)
IR_BASE_COEFF  = 0.15    # irScenario base: IR_fresh = 0.15 / nomCap

# Chemistry-specific cycle life for output rescaling (CALCE LCO = 309)
CHEM_MAX_RUL = {"LCO": 309, "LFP": 1934, "NMC": 1500, "NCM": 1000, "NCA": 800}

# ── Model registry ───────────────────────────────────────────────
MODEL_REGISTRY = {
    "v10-final": {
        "checkpoint": RESULTS_DIR / "v10_final" / "best_model_v10_final.pt",
        "class": "MambaRULFinal",
        "rul_max": CALCE_RUL_MAX,
        "description": "Best overall. +LFP IC features. Oxford ZS R²=0.911.",
        "rmse": 20.6, "r2": 0.910,
    },
    "v10-full": {
        "checkpoint": RESULTS_DIR / "v10_full" / "best_model_v10_full.pt",
        "class": "MambaRULCore",
        "rul_max": CALCE_RUL_MAX,
        "description": "Primary clean-split model. CALCE RMSE=21.49.",
        "rmse": 21.49, "r2": 0.959,
    },
    "v9": {
        "checkpoint": RESULTS_DIR / "v9_oxford" / "best_model_v9.pt",
        "class": "MambaRULCore",
        "rul_max": CALCE_RUL_MAX,
        "description": "v8 + Oxford in training. CALCE RMSE=22.11.",
        "rmse": 22.11, "r2": 0.952,
    },
    "v8": {
        "checkpoint": RESULTS_DIR / "v8_multidataset_sg" / "best_model_v8.pt",
        "class": "MambaRULCore",
        "rul_max": CALCE_RUL_MAX,
        "description": "BREAKTHROUGH model. stride=1+SG. RMSE=23.95.",
        "rmse": 23.95, "r2": 0.942,
    },
    "tcn-mamba": {
        "checkpoint": TCN_DIR / "checkpoints" / "best_model_run4_backup.pt",
        "class": "TCNMambaModel",
        "rul_max": 550.0,
        "description": "Protocol-conditioned TCN+Mamba. Multi-chemistry.",
        "rmse": 106, "r2": 0.35,
    },
    # ── Fine-tuned checkpoints (per-cell normalization) ──────────────
    "hust-lfp": {
        "checkpoint": PROJECT_ROOT / "processed/hust_finetune/hust_finetuned.pt",
        "class": "MambaRULFinal",
        "rul_max": 1694.0,          # fallback; actual median loaded from checkpoint
        "normalization": "per_cell",
        "chemistry_affinity": "LFP",
        "description": "Fine-tuned on HUST LFP (77 cells). RMSE=60, R²=0.987.",
        "rmse": 60.0, "r2": 0.987,
    },
    "oxford-nmc": {
        "checkpoint": PROJECT_ROOT / "processed/oxford_finetune/oxford_finetuned.pt",
        "class": "MambaRULFinal",
        "rul_max": 8100.0,
        "normalization": "per_cell",
        "chemistry_affinity": "NMC",
        "description": "Fine-tuned on Oxford NMC (8 cells). RMSE=357, R²=0.940. All cells ~8100-cycle EOL — per-cell and global norm are equivalent here.",
        "rmse": 357.0, "r2": 0.940,
    },
    "nasa-nmc": {
        "checkpoint": PROJECT_ROOT / "processed/nasa_finetune/nasa_finetuned.pt",
        "class": "MambaRULFinal",
        "rul_max": 168.0,
        "normalization": "per_cell",
        "chemistry_affinity": "NMC",
        "description": "Fine-tuned on NASA PCoE NMC (4 cells). RMSE=37 cycles (~125-cycle lifetime). Low confidence: 4-cell LOOCV is insufficient for reliable R².",
        "rmse": 37.0, "r2": 0.005,
        "low_confidence": True,
        "low_confidence_reason": "Only 4 cells in dataset; LOOCV R²≈0 due to irregular degradation patterns and dataset size. RMSE=37 on ~125-cycle lifetime is acceptable but predictions have high variance.",
    },
    # ── v12 BiMamba-APF: bidirectional + physics gate ───────────────
    "v12-bimamba": {
        "checkpoint": PROJECT_ROOT / "processed/bimamba_v12/checkpoint_v12.pt",
        "class": "BiMambaAPF",
        "rul_max": CALCE_RUL_MAX,
        "description": "v12: BiMamba-Attention-Physics Fusion. BiSSM + CNN + physics gate + MC Dropout uncertainty. (Dikshant Patel 2026)",
        "rmse": None, "r2": None,
    },
    # ── v11 Two-Head: joint SOH + RUL ───────────────────────────────
    "v11-twohead": {
        "checkpoint": PROJECT_ROOT / "processed/twohead_v11/checkpoint_v11.pt",
        "class": "MambaRULTwoHead",
        "rul_max": CALCE_RUL_MAX,
        "description": "v11: joint SOH + RUL prediction. Backbone=v10, soh_head trained from scratch.",
        "rmse": None, "r2": None,
    },
}

_MODELS: dict[str, Any] = {}
_LOADED = False


def _load_model(model_id: str) -> Any | None:
    """Load a single model checkpoint. Returns None on failure."""
    try:
        import torch
        from core.mambarul_model import MambaRULFinal, MambaRULCore, TCNMambaModel, MambaRULTwoHead
        from core.bimamba_apf import BiMambaAPF
    except ImportError as e:
        logger.error("PyTorch not available: %s", e)
        return None

    info = MODEL_REGISTRY.get(model_id)
    if not info:
        logger.warning("Unknown model: %s", model_id)
        return None

    ckpt_path = info["checkpoint"]
    if not ckpt_path.exists():
        logger.warning("Checkpoint not found: %s", ckpt_path)
        return None

    try:
        import torch
        ck = torch.load(str(ckpt_path), map_location="cpu", weights_only=False)

        # Extract state dict and norm stats
        sd_key = "model_state_dict" if "model_state_dict" in ck else "model_state"
        sd = ck[sd_key]

        feat_mean = np.array(ck["feat_mean"], dtype=np.float32) if "feat_mean" in ck else None
        feat_std  = np.array(ck["feat_std"],  dtype=np.float32) if "feat_std"  in ck else None

        # Instantiate architecture
        cls_name = info["class"]
        if cls_name == "MambaRULFinal":
            n_mamba = len([k for k in sd if "mamba_blocks" in k and "A_log" in k])
            n_mamba = n_mamba if n_mamba > 0 else 3
            model = MambaRULFinal(n_features=13, d_model=128, n_mamba=n_mamba)
        elif cls_name == "MambaRULCore":
            n_mamba = len([k for k in sd if "mamba_blocks" in k and "A_log" in k])
            n_mamba = n_mamba if n_mamba > 0 else 3
            has_anchors = any("cross_attn" in k for k in sd)
            model = MambaRULCore(n_features=13, d_model=128, n_mamba=n_mamba,
                                  n_anchors=3 if has_anchors else 0)
        elif cls_name == "TCNMambaModel":
            model = TCNMambaModel(n_features=30, hidden=64)
        elif cls_name == "MambaRULTwoHead":
            n_mamba = len([k for k in sd if "mamba_blocks" in k and "A_log" in k])
            n_mamba = n_mamba if n_mamba > 0 else 3
            model = MambaRULTwoHead(n_features=13, d_model=128, n_mamba=n_mamba)
        elif cls_name == "BiMambaAPF":
            n_bi = len([k for k in sd if "bimamba_blocks" in k and "fwd.A_log" in k])
            n_bi = n_bi if n_bi > 0 else 3
            model = BiMambaAPF(n_features=13, d_model=128, n_bimamba=n_bi)
        else:
            return None

        # Load weights (allow missing/unexpected keys gracefully)
        missing, unexpected = model.load_state_dict(sd, strict=False)
        if missing:
            logger.debug("%s: missing keys: %s", model_id, missing[:3])
        if unexpected:
            logger.debug("%s: unexpected keys: %s", model_id, unexpected[:3])

        model.eval()
        logger.info("Loaded %s from %s", model_id, ckpt_path.name)

        # Per-cell fine-tuned checkpoints store their own median_cell_rul_max
        med = ck.get("median_cell_rul_max")
        norm = ck.get("normalization") or info.get("normalization", "global")

        # For BiMambaAPF: also load the LCO-specific fine-tuned head into a separate
        # model instance so LCO inference bypasses the v10 delegation entirely.
        lco_model = None
        if cls_name == "BiMambaAPF":
            lco_ckpt_path = PROJECT_ROOT / "processed/lco_finetune/v12_lco_head.pt"
            if lco_ckpt_path.exists():
                try:
                    import torch as _torch
                    lco_ck = _torch.load(str(lco_ckpt_path), map_location="cpu", weights_only=False)
                    lco_m = BiMambaAPF(n_features=13, d_model=128, n_bimamba=n_bi)
                    lco_m.load_state_dict(sd, strict=False)          # same backbone
                    head_sd = lco_ck["head_state_dict"]
                    # head_sd keys are "rul_head.*" / "soh_head.*" — load into submodules
                    rul_sd = {k[len("rul_head."):]: v for k, v in head_sd.items() if k.startswith("rul_head.")}
                    soh_sd = {k[len("soh_head."):]: v for k, v in head_sd.items() if k.startswith("soh_head.")}
                    if rul_sd:
                        lco_m.rul_head.load_state_dict(rul_sd, strict=False)
                    if soh_sd:
                        lco_m.soh_head.load_state_dict(soh_sd, strict=False)
                    lco_m.eval()
                    lco_model = lco_m
                    logger.info("Loaded LCO fine-tuned head for %s (MAE≈4.7 cyc, 0/5 neg)", model_id)
                except Exception as _e:
                    logger.warning("LCO head load failed (%s) — delegation to v10 still active", _e)

        return {
            "model": model,
            "feat_mean": feat_mean,
            "feat_std": feat_std,
            "rul_max": float(med) if med else info["rul_max"],
            "class": cls_name,
            "normalization": norm,
            "median_cell_rul_max": float(med) if med else None,
            "chemistry_affinity": info.get("chemistry_affinity"),
            "lco_model": lco_model,
        }
    except Exception as exc:
        logger.error("Failed to load %s: %s", model_id, exc)
        return None


def load_all_models():
    global _LOADED
    logger.info("Loading MambaRUL checkpoints…")
    for mid in MODEL_REGISTRY:
        m = _load_model(mid)
        if m:
            _MODELS[mid] = m
            logger.info("  ✓ %s ready", mid)
        else:
            logger.warning("  ✗ %s skipped (checkpoint missing or error)", mid)
    _LOADED = True
    logger.info("Models loaded: %d/%d", len(_MODELS), len(MODEL_REGISTRY))


def get_loaded_models() -> list[dict]:
    rows = []
    _EXPOSE = {"checkpoint", "rul_max"}   # always excluded from raw registry dump
    for mid in MODEL_REGISTRY:
        reg = MODEL_REGISTRY[mid]
        entry = {
            "id": mid,
            "loaded": mid in _MODELS,
            **{k: v for k, v in reg.items() if k not in _EXPOSE},
        }
        # Actual rul_max from loaded checkpoint (may differ from registry default)
        if mid in _MODELS:
            entry["rul_max"] = _MODELS[mid]["rul_max"]
            if _MODELS[mid].get("median_cell_rul_max"):
                entry["median_cell_rul_max"] = _MODELS[mid]["median_cell_rul_max"]
        else:
            entry["rul_max"] = reg["rul_max"]
        # Surface low_confidence flag so the UI can warn users
        if reg.get("low_confidence"):
            entry["low_confidence"]        = True
            entry["low_confidence_reason"] = reg.get("low_confidence_reason", "")
        rows.append(entry)
    return rows


# ── Inference ─────────────────────────────────────────────────────

def _v(d: dict, key: str, default: float) -> float:
    """Get float from dict, using default if value is None or missing."""
    v = d.get(key)
    return float(v) if v is not None else default


def _build_window(features_dict: dict) -> np.ndarray:
    """Build a (30, 9) feature window.

    If `_observed_window` is supplied (a list/array of real per-cycle 9-feature
    rows in the order [cap, ct, vmean, vend, energy, temp, dslope, ir, chem]),
    the real measured history is used (last 30 cycles; left-padded with the
    oldest observed row if fewer than 30). Otherwise the window is *synthesized*
    by back-projecting the single snapshot with a fixed decay — in that case the
    model cannot see the cell's true degradation trajectory.
    """
    # ── Real measured history path ────────────────────────────────────────────
    obs = features_dict.get("_observed_window")
    if obs is not None:
        arr = np.asarray(obs, dtype=np.float32)
        if arr.ndim == 2 and arr.shape[1] == 9 and len(arr) >= 2:
            nom_cap = _v(features_dict, "nom_capacity", REF_CAP)
            if nom_cap > 2.0:   # same OOD rescaling as the synthetic path, per row
                arr = arr.copy()
                arr[:, 0] = REF_CAP * (arr[:, 0] / nom_cap)
                ir_fresh_cell = IR_BASE_COEFF / nom_cap
                arr[:, 7] = REF_IR_FRESH * (arr[:, 7] / max(ir_fresh_cell, 1e-9))
                arr[:, 4] = arr[:, 4] * (REF_CAP / nom_cap)
            W = WINDOW_SIZE
            if len(arr) >= W:
                return arr[-W:].astype(np.float32)
            pad = np.repeat(arr[:1], W - len(arr), axis=0)
            return np.concatenate([pad, arr], axis=0).astype(np.float32)

    # ── Synthetic window (single snapshot) ──────────────────────────────────────
    cap        = _v(features_dict, "capacity", 1.0)
    cct        = _v(features_dict, "charge_time", 7200)
    vmean      = _v(features_dict, "voltage_mean", 3.8)
    vend       = _v(features_dict, "voltage_end", 2.75)
    energy     = _v(features_dict, "energy", cap * vmean)
    temp       = _v(features_dict, "temperature", 25)
    dslope     = _v(features_dict, "discharge_slope", -0.001)
    ir         = _v(features_dict, "int_resistance", 0.05)
    chem_code  = _v(features_dict, "chemistry_code", 0)

    # Scale large-format cells to CALCE training distribution.
    # Model was trained on ~1 Ah research cells; large EV cells (25+ Ah)
    # are out-of-distribution by ~23x in capacity and ~100x in IR.
    nom_cap = _v(features_dict, "nom_capacity", REF_CAP)
    if nom_cap > 2.0:
        # Rescale capacity: preserve SOH ratio, shift absolute range to CALCE
        cap = REF_CAP * (cap / nom_cap)
        # Rescale IR: map to same degradation ratio relative to fresh CALCE IR
        ir_fresh_cell = IR_BASE_COEFF / nom_cap
        ir = REF_IR_FRESH * (ir / max(ir_fresh_cell, 1e-9))
        # Energy is cap × voltage — rescale capacity component
        energy = energy * (REF_CAP / nom_cap)

    # Build 30-cycle history: cycle 0 = 30 cycles ago, cycle 29 = now
    W = WINDOW_SIZE
    decay = 0.0008   # capacity gain per cycle going backwards
    noise = 0.005

    rng = np.random.default_rng(42)
    rows = []
    for i in range(W):
        t = i / (W - 1)          # 0 = past, 1 = now (current)
        ago = (1 - t) * 30       # cycles ago
        n   = rng.normal(0, noise)

        # Capacity slightly higher in the past
        q   = cap * (1 + decay * ago) + n * 0.01
        # CCT slightly lower in the past (faster charge)
        ct  = cct * (1 - decay * ago * 0.5) + n * 10
        # Voltage slightly higher in the past
        vm  = vmean * (1 + decay * ago * 0.3) + n * 0.002
        ve  = vend  * (1 + decay * ago * 0.2) + n * 0.002
        e   = energy * (1 + decay * ago * 0.4) + n * 0.02
        T   = temp + rng.normal(0, 0.2)
        ds  = dslope * (1 + (1 - t) * 0.5)  # less negative in the past
        R   = ir * (1 - decay * ago * 2) + rng.normal(0, 0.0002)
        cc  = chem_code

        rows.append([q, ct, vm, ve, e, T, ds, R, cc])

    return np.array(rows, dtype=np.float32)   # (30, 9)


_ARRH_MEAN = 1.0   # Arrhenius factor = 1.0 at 25°C reference
_ARRH_STD  = 0.5   # covers 15°C–45°C operating range

def _arrhenius_transform(T_celsius: np.ndarray) -> np.ndarray:
    """Convert temp_mean (°C) to Arrhenius rate factor relative to 25°C."""
    T_k = np.clip(np.asarray(T_celsius, np.float32) + 273.15, 253.15, 333.15)
    return np.exp(6000.0 * (1.0 / 298.15 - 1.0 / T_k))

# DoD-to-cycle-life exponents per chemistry (empirical, Li-ion degradation literature).
# cycle_life ∝ (1 / DoD)^k. Training data ≈ 100% DoD (CALCE/HUST discharge to cutoff).
_DOD_K = {"LCO": 1.8, "LFP": 1.2, "NMC": 1.5, "NCM": 1.5, "NCA": 1.5}
# 1-σ uncertainty on k from published literature spread (±1.645σ ≈ 90% band).
# Larger k_sigma → CI grows faster with correction magnitude.
_DOD_K_SIGMA = {"LCO": 0.30, "LFP": 0.20, "NMC": 0.25, "NCM": 0.25, "NCA": 0.25}
_DOD_MULT_CAP = 10.0   # never claim more than 10× life extension

def _dod_rul_multiplier(dod_pct: float | None, chem: str) -> tuple[float, float]:
    """Return (rul_multiplier, ci_widening) for operating at partial DoD.

    rul_multiplier: how many more cycles vs. 100% DoD training baseline.
    ci_widening:    CI widens because:
                    (a) model was not trained on this DoD regime (OOD penalty), and
                    (b) the exponent k itself has literature uncertainty (k-sigma).
                    At DoD=50%, LFP: base ×1.75 × k-uncertainty ×1.149 = ×2.01.
    """
    if dod_pct is None or dod_pct >= 99.0:
        return 1.0, 1.0
    dod    = max(float(dod_pct), 5.0)
    chem_u = chem.upper()
    k      = _DOD_K.get(chem_u, 1.5)
    k_sig  = _DOD_K_SIGMA.get(chem_u, 0.25)
    ratio  = 100.0 / dod                          # always ≥ 1
    rul_mult = min(ratio ** k, _DOD_MULT_CAP)
    # OOD penalty: linearly from ×1.0 at 100% DoD to ×2.5 at 0% DoD
    base_ci = 1.0 + 1.5 * max(0.0, 1.0 - dod / 100.0)
    # k-uncertainty: propagate 1σ error via ratio^k_sigma
    k_unc   = ratio ** k_sig                      # > 1 for ratio > 1
    ci_mult = base_ci * k_unc
    return round(rul_mult, 4), round(ci_mult, 4)

# Chemistry-specific expected cycle life at fresh (cap_pct=1.0).
# LFP from HUST median_cell_rul_max; others from literature / training datasets.
_COLD_START_PRIORS = {
    "LCO": 300,    # CALCE cylindrical (training reference)
    "LFP": 1694,   # HUST median (measured from 61-cell training set)
    "NMC": 1000,   # typical research-grade NMC
    "NCM": 700,
    "NCA": 800,
}
_COLD_DECAY = 2.3   # same exponent as analytical model

def _cold_start_blend(model_rul: float, features: dict, n_cycles: int,
                      median_cell_rul_max: float | None = None) -> tuple[float, float, str]:
    """Blend model prediction with chemistry prior when history is short (<30 cycles).

    Returns (blended_rul, ci_multiplier, source_tag).
    - alpha=0 at n=0  → 100% prior
    - alpha=1 at n=30 → 100% model (smooth power-law ramp)
    """
    if n_cycles >= 30:
        return model_rul, 1.0, "model"

    chem    = features.get("chemistry", "LCO").upper()
    cap_pct = float(features.get("cap_pct") or
                    (features.get("soh_pct", 85) / 100.0))

    # Use checkpoint's measured median if available (more accurate than generic prior)
    prior_base = float(median_cell_rul_max or _COLD_START_PRIORS.get(chem, 1000.0))
    prior_rul  = prior_base * (cap_pct ** _COLD_DECAY)

    # Smooth power-law ramp: negligible model weight before cycle 5, full at cycle 30
    alpha   = min(1.0, (max(n_cycles, 0) / 30.0) ** 1.5)
    blended = (1.0 - alpha) * prior_rul + alpha * model_rul

    # CI widens quadratically: ×2.5 at cycle 0, ×1.0 at cycle 30
    ci_mult = 1.0 + 1.5 * (1.0 - alpha)

    return blended, round(ci_mult, 3), f"cold-start(n={n_cycles},α={alpha:.2f})"

def temperature_ci_multiplier(temp_celsius: float) -> float:
    """CI widening factor based on operating temperature deviation from 25°C."""
    if temp_celsius > 40: return 1.8
    if temp_celsius > 35: return 1.5
    if temp_celsius < 10: return 2.0
    if temp_celsius < 15: return 1.8
    return 1.0

def _add_derived(X: np.ndarray) -> np.ndarray:
    """Add cap_pct, delta_cap, cum_energy_norm, delta_ir → (30, 13)."""
    cap    = X[:, 0]
    energy = X[:, 4]
    ir     = X[:, 7]

    init    = float(cap[0]) if cap[0] > 1e-6 else 1.0
    cap_pct = cap / init

    dc      = np.zeros(len(cap), np.float32)
    dc[1:]  = cap[1:] - cap[:-1]

    ec      = np.cumsum(energy).astype(np.float32)
    ec_n    = ec / (float(ec[-1]) + 1e-6)

    di      = np.zeros(len(ir), np.float32)
    di[1:]  = ir[1:] - ir[:-1]

    extra = np.stack([cap_pct, dc, ec_n, di], axis=1)
    return np.concatenate([X, extra], axis=1).astype(np.float32)   # (30, 13)


def _normalize(X: np.ndarray, feat_mean: np.ndarray | None,
               feat_std: np.ndarray | None) -> np.ndarray:
    """Z-score normalize the 9 raw features (with Arrhenius temp transform), append derived."""
    X9 = X[:, :9].copy()
    X9[:, 5] = _arrhenius_transform(X9[:, 5])   # temp_mean → Arrhenius factor
    if feat_mean is not None and feat_std is not None:
        fm = feat_mean[:9].copy()
        fs = feat_std[:9].copy()
        fm[5] = _ARRH_MEAN
        fs[5] = _ARRH_STD
        std = np.where(fs > 1e-8, fs, 1.0)
        X9  = (X9 - fm) / std
    return _add_derived(X9)   # (30, 13)


_CHEM_STR_TO_CODE = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3, "NCA": 4, "LMO": 0}


def run_inference(model_id: str, features: dict) -> dict:
    """
    Run real PyTorch inference.
    Returns: {predicted_rul, lower, upper, health_score, phase, model, model_id, mode}
    """
    # Ensure soh_pct is always present (derive from cap_pct if missing)
    if "soh_pct" not in features or features["soh_pct"] is None:
        cap_pct = float(features.get("cap_pct", 0.85))
        features = {**features, "soh_pct": cap_pct * 100}

    # Inject chemistry_code so the model's embedding layer gets the right token.
    # Previously this defaulted to 0 (LCO) for all chemistries — fixed here.
    chem_str = str(features.get("chemistry", "LCO")).upper()
    if "chemistry_code" not in features:
        features = {**features, "chemistry_code": _CHEM_STR_TO_CODE.get(chem_str, 0)}

    # LCO routing: use the fine-tuned LCO head on the v12 backbone when available
    # (MAE ≈ 4.7 cyc, 0/5 negatives after non-negativity training). Falls back to
    # v10-final delegation if the head checkpoint was not loaded at startup.
    if chem_str == "LCO" and model_id == "v12-bimamba":
        lco_model = (_MODELS.get("v12-bimamba") or {}).get("lco_model")
        if lco_model is not None:
            import torch as _torch
            entry  = _MODELS["v12-bimamba"]
            fmean  = entry["feat_mean"]
            fstd   = entry["feat_std"]
            rul_max = entry["rul_max"]
            raw  = _build_window(features)
            X13  = _normalize(raw, fmean, fstd)
            inp  = _torch.tensor(X13).unsqueeze(0)
            chem_code = int(inp[0, -1, 8].round().item()) if inp.shape[-1] > 8 else 0
            chem_code = max(0, min(chem_code, 4))
            with _torch.no_grad():
                rul_mean, rul_std_t, soh_t = lco_model.predict_with_uncertainty(
                    inp, chem_code=chem_code, k=50)
            rul_norm = float(_torch.clamp(rul_mean, min=0.0).item())
            if rul_norm <= 0.0:
                fb = _analytical_fallback(features, model_id)
                fb["mode"]  = "analytical_guard"
                fb["guard"] = "lco_head_output_nonpositive"
                fb["lco_head"] = "v12-lco-finetune"
                return fb
            chem_scale = CHEM_MAX_RUL.get("LCO", CALCE_RUL_MAX) / CALCE_RUL_MAX
            rul_cycles = max(0.0, rul_norm * rul_max * chem_scale)
            dod_pct = features.get("dod_pct")
            dod_mult, _ = _dod_rul_multiplier(dod_pct, "LCO")
            rul_cycles *= dod_mult
            n_cycles = features.get("n_cycles")
            if n_cycles is not None:
                med = entry.get("median_cell_rul_max")
                rul_cycles, _, _ = _cold_start_blend(rul_cycles, features, int(n_cycles), med)
            confidence = rul_cycles * 0.15
            soh = float(features.get("soh_pct", 85)) / 100.0
            health = round(soh * 100, 1)
            phase = "Fresh" if soh > 0.9 else "Aging" if soh > 0.75 else "Knee" if soh > 0.6 else "Near-EOL"
            _obs   = features.get("_observed_window")
            _n_obs = len(_obs) if _obs is not None else 0
            return {
                "predicted_rul":   round(rul_cycles, 1),
                "lower_bound":     round(max(0, rul_cycles - confidence), 1),
                "upper_bound":     round(rul_cycles + confidence, 1),
                "health_score":    health,
                "phase":           phase,
                "chemistry":       features.get("chemistry", "LCO"),
                "model":           "MambaRUL v12-bimamba + LCO fine-tuned head (real inference)",
                "model_id":        "v12-bimamba",
                "mode":            "pytorch",
                "lco_head":        "v12-lco-finetune",
                "rul_std":         round(float(rul_std_t.item()), 6),
                "soh_predicted":   round(float(soh_t.item()), 4),
                "history_source":  "measured" if _n_obs >= 2 else "synthesized",
                "n_observed_cycles": int(_n_obs) if _n_obs else 1,
            }
        elif "v10-final" in _MODELS:
            result = run_inference("v10-final", features)
            result["model_requested"] = "v12-bimamba"
            result["model_resolved"]  = "v10-final"
            result["delegation"]      = "lco_v12_to_v10_fallback"
            return result

    if model_id not in _MODELS:
        return _analytical_fallback(features, model_id)

    try:
        import torch
        entry  = _MODELS[model_id]
        model  = entry["model"]
        fmean  = entry["feat_mean"]
        fstd   = entry["feat_std"]
        rul_max = entry["rul_max"]

        # Build (1, 30, 13) input
        raw    = _build_window(features)          # (30, 9) raw
        X13    = _normalize(raw, fmean, fstd)     # (30, 13)
        inp    = torch.tensor(X13).unsqueeze(0)   # (1, 30, 13)

        # For TCN-Mamba: needs (B, L, 30) features — use zero-padded
        if entry["class"] == "TCNMambaModel":
            X30 = np.zeros((30, 30), dtype=np.float32)
            X30[:, :13] = X13
            inp = torch.tensor(X30).unsqueeze(0)

        with torch.no_grad():
            out = model(inp)

        # v11-twohead → (rul_norm, soh)
        # v12-bimamba → predict_with_uncertainty → (rul_mean, rul_std, soh)
        soh_predicted = None
        rul_std_out   = None
        if entry["class"] == "BiMambaAPF":
            chem_code = int(inp[0, -1, 8].round().item()) if inp.shape[-1] > 8 else 0
            chem_code = max(0, min(chem_code, 4))
            rul_mean, rul_std_t, soh_t = model.predict_with_uncertainty(
                inp, chem_code=chem_code, k=50)
            rul_norm      = float(rul_mean.item())
            rul_std_out   = round(float(rul_std_t.item()), 6)
            soh_predicted = round(float(soh_t.item()), 4)
        elif isinstance(out, tuple):
            rul_norm, soh_out = out
            rul_norm      = float(rul_norm.item())
            soh_predicted = round(float(soh_out.item()), 4)
        else:
            rul_norm = float(out.item())
        chem = features.get("chemistry", "LCO").upper()

        # ── OOD guard ────────────────────────────────────────────────────────
        # A negative *normalized* RUL is unphysical — it means the model is
        # extrapolating outside its trained regime (common when the 30-cycle
        # window was synthesized from a single snapshot, esp. for v12-bimamba
        # and for LCO). Returning a clamped 0 would be misleading, so fall back
        # to the physics-based analytical estimate, transparently tagged.
        if rul_norm <= 0.0:
            _obs   = features.get("_observed_window")
            _n_obs = len(_obs) if _obs is not None else 0
            fb = _analytical_fallback(features, model_id)
            fb["mode"]            = "analytical_guard"
            fb["guard"]           = "model_output_nonpositive"
            fb["rul_normalized"]  = round(rul_norm, 6)
            fb["history_source"]  = "measured" if _n_obs >= 2 else "synthesized"
            fb["n_observed_cycles"] = int(_n_obs) if _n_obs else 1
            if soh_predicted is not None:
                fb["soh_predicted"] = soh_predicted
            return fb

        # Per-cell fine-tuned models: output is fraction of median cell life.
        # Base models: output is fraction of CALCE_RUL_MAX → scale to chemistry.
        if entry.get("normalization") == "per_cell":
            rul_cycles = max(0.0, rul_norm * rul_max)   # rul_max = median_cell_rul_max
        else:
            chem_scale = CHEM_MAX_RUL.get(chem, CALCE_RUL_MAX) / CALCE_RUL_MAX
            rul_cycles = max(0.0, rul_norm * rul_max * chem_scale)

        # DoD correction: scale RUL up for partial-DoD operation
        dod_pct   = features.get("dod_pct")
        dod_mult, dod_ci = _dod_rul_multiplier(dod_pct, chem)
        rul_cycles = rul_cycles * dod_mult

        # Cold-start prior blend: stabilise early-life predictions (<30 cycles)
        n_cycles = features.get("n_cycles")
        cs_ci    = 1.0
        cs_tag   = "model"
        if n_cycles is not None:
            n_int = int(n_cycles)
            med   = entry.get("median_cell_rul_max")
            rul_cycles, cs_ci, cs_tag = _cold_start_blend(
                rul_cycles, features, n_int, med
            )

        confidence = rul_cycles * 0.15
        soh = float(features.get("soh_pct", 85)) / 100.0
        health = round(soh * 100, 1)
        phase  = "Fresh" if soh > 0.9 else "Aging" if soh > 0.75 else "Knee" if soh > 0.6 else "Near-EOL"

        # History provenance: did the model see real measured cycles, or a
        # window synthesized from a single snapshot?
        _obs   = features.get("_observed_window")
        _n_obs = len(_obs) if _obs is not None else 0
        history_source = "measured" if _n_obs >= 2 else "synthesized"

        result = {
            "predicted_rul":   round(rul_cycles, 1),
            "lower_bound":     round(max(0, rul_cycles - confidence), 1),
            "upper_bound":     round(rul_cycles + confidence, 1),
            "health_score":    health,
            "phase":           phase,
            "chemistry":       features.get("chemistry", "LCO"),
            "model":           f"MambaRUL {model_id} (real inference)",
            "model_id":        model_id,
            "mode":            "pytorch",
            "rul_normalized":  round(rul_norm, 6),
            "history_source":    history_source,
            "n_observed_cycles": int(_n_obs) if _n_obs else 1,
        }
        if soh_predicted is not None:
            result["soh_predicted"] = soh_predicted
        if rul_std_out is not None:
            result["rul_std"]       = round(rul_std_out * entry["rul_max"], 2)
            result["rul_std_norm"]  = rul_std_out
        if dod_mult != 1.0:
            result["dod_pct"]        = round(dod_pct, 1)
            result["dod_multiplier"] = round(dod_mult, 3)
            result["dod_ci_factor"]  = round(dod_ci, 3)
        if cs_ci != 1.0:
            result["cold_start"]    = cs_tag
            result["cs_ci_factor"]  = round(cs_ci, 3)
        return result
    except Exception as exc:
        logger.error("Inference error for %s: %s", model_id, exc)
        return _analytical_fallback(features, model_id)


def _analytical_fallback(features: dict, model_id: str) -> dict:
    """Analytical approximation when model not loaded."""
    chem  = features.get("chemistry", "LCO") or "LCO"
    soh   = _v(features, "soh_pct", 85) / 100.0
    ir    = _v(features, "int_resistance", 0.05)
    max_rul = {"LCO": 309, "LFP": 1934, "NMC": 550, "NCM": 662}.get(chem, 309)
    ir_f  = max(0.5, 1 - (ir - 0.03) / 0.25)
    rul   = max(0.0, max_rul * (soh ** 2.3) * ir_f)
    conf  = rul * 0.15
    phase = "Fresh" if soh > 0.9 else "Aging" if soh > 0.75 else "Knee" if soh > 0.6 else "Near-EOL"
    return {
        "predicted_rul": round(rul, 1),
        "lower_bound":   round(max(0, rul - conf), 1),
        "upper_bound":   round(rul + conf, 1),
        "health_score":  round(soh * 100, 1),
        "phase": phase, "chemistry": chem,
        "model": f"{model_id} (analytical fallback — model not loaded)",
        "model_id": model_id, "mode": "analytical",
        "history_source": "synthesized", "n_observed_cycles": 1,
    }

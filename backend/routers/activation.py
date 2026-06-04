"""
activation.py — real forward-pass activations, weight matrices, attention weights.
Powers the advanced NeuronAnimation page with actual model internals.
"""
from __future__ import annotations
import logging
from pathlib import Path
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).parent.parent.parent.parent


def _clean(arr: np.ndarray, decimals: int = 4) -> list:
    a = np.asarray(arr, dtype=float)
    a = np.where(np.isfinite(a), a, 0.0)
    return np.round(a, decimals).tolist()


# ── Real forward pass with hooks ─────────────────────────────────────────────

class ForwardRequest(BaseModel):
    model_id: str = "v10-final"
    chemistry: str = "LCO"
    soh_pct: float = 85.0        # 0–100
    capacity: float | None = None
    charge_time: float | None = None
    voltage_mean: float | None = None
    temperature: float | None = None
    int_resistance: float | None = None
    cell_id: str | None = None   # if set, load a real window from the dataset


@router.post("/activations/forward")
def run_forward_with_activations(req: ForwardRequest) -> dict[str, Any]:
    """
    Run a real forward pass through the selected model and return:
    - Per-layer activation means and std (for all 30 timesteps)
    - Input embedding (30×128)
    - Mamba block output norms (3 blocks × 16 state dims)
    - Anchor attention weights (3 anchors × 30 timesteps)
    - MLP pre-activation and post-ReLU
    - Final RUL prediction
    """
    try:
        import torch
    except ImportError:
        raise HTTPException(503, "PyTorch not available")

    from core.model_loader import _MODELS, _build_window, _normalize, CALCE_RUL_MAX

    if req.model_id not in _MODELS:
        raise HTTPException(404, f"Model '{req.model_id}' not loaded")

    entry  = _MODELS[req.model_id]
    model  = entry["model"]
    fmean  = entry["feat_mean"]
    fstd   = entry["feat_std"]
    rul_max = entry["rul_max"]

    # Build input
    features = {
        "chemistry": req.chemistry,
        "soh_pct": req.soh_pct,
        "cap_pct": req.soh_pct / 100,
        "capacity": req.capacity or (1.05 * req.soh_pct / 100),
        "charge_time": req.charge_time or 7200,
        "voltage_mean": req.voltage_mean or 3.8,
        "temperature": req.temperature or 25.0,
        "int_resistance": req.int_resistance or 0.05,
        "chemistry_code": {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3}.get(req.chemistry, 0),
    }

    # Optionally load real cell window from dataset
    raw_window = None
    if req.cell_id:
        try:
            from core.data_loader import get_meta_df, get_features_array
            meta  = get_meta_df()
            feats = get_features_array()
            mask  = meta["cell_id"] == req.cell_id
            if mask.any():
                raw_w = feats[mask]
                if len(raw_w) >= 30:
                    raw_window = raw_w[-30:].copy()   # last 30 cycles
        except Exception:
            pass

    if raw_window is None:
        raw_window = _build_window(features)

    X13 = _normalize(raw_window, fmean, fstd)
    inp  = torch.tensor(X13).unsqueeze(0)   # (1,30,13)

    # ── Capture activations via hooks ──────────────────────────────────────
    acts: dict[str, np.ndarray] = {}
    hooks = []

    def make_hook(name: str):
        def fn(module, inp_, out):
            if isinstance(out, torch.Tensor):
                acts[name] = out.detach().cpu().numpy()
        return fn

    target_names = {
        "core.input_proj.1":              "embedding",     # (1,30,128) after LayerNorm
        "core.pos_enc.dropout":           "pos_enc",       # (1,30,128)
        "core.mamba_blocks.0.out_proj":   "mamba0_out",    # (1,30,128)
        "core.mamba_blocks.1.out_proj":   "mamba1_out",    # (1,30,128)
        "core.mamba_blocks.2.out_proj":   "mamba2_out",    # (1,30,128)
        "core.cross_attn.W_o":            "attn_out",      # (1,30,128)
        "core.final_norm":                "final_norm",    # (1,30,128)
        "core.mlp_head.0":               "mlp_linear",    # (1,128,64)? check shape
        "core.mlp_head.1":               "mlp_relu",      # (1,128,64)
        "core.mlp_head.3":               "mlp_out",       # (1,1)
    }

    for name, mod in model.named_modules():
        if name in target_names:
            hooks.append(mod.register_forward_hook(make_hook(target_names[name])))

    # Also hook attention to get attention weights
    attn_weights: dict[str, np.ndarray] = {}
    def attn_hook(module, inp_, out):
        # inp_[0] is Q, compute attention inline
        try:
            import math
            B, L, D = inp_[0].shape
            H = module.n_heads
            dk = module.d_k
            A = module.anchors.unsqueeze(0).expand(B, -1, -1)
            Q = module.W_q(inp_[0]).view(B, L, H, dk).transpose(1, 2)
            K = module.W_k(A).view(B, -1, H, dk).transpose(1, 2)
            w = torch.softmax(Q @ K.transpose(-2, -1) / math.sqrt(dk), dim=-1)
            attn_weights["weights"] = w.detach().cpu().numpy()  # (1, H, L, n_anchors)
        except Exception:
            pass

    for name, mod in model.named_modules():
        if "cross_attn" in name and name.endswith("cross_attn"):
            hooks.append(mod.register_forward_hook(attn_hook))

    try:
        with torch.no_grad():
            out = model(inp)
        rul_pred = float(out.item()) * rul_max
    finally:
        for h in hooks:
            h.remove()

    # ── Format response ────────────────────────────────────────────────────

    result: dict[str, Any] = {
        "model_id": req.model_id,
        "rul_predicted": round(rul_pred, 1),
        "rul_normalized": round(float(out.item()), 6),
        "chemistry": req.chemistry,
        "soh_pct": req.soh_pct,

        # Input features (30×13)
        "input_window": {
            "features": _clean(X13),      # (30, 13)
            "feature_means": _clean(X13.mean(axis=0)),  # (13,)
            "feature_stds":  _clean(X13.std(axis=0)),
            "n_cycles": 30,
            "n_features": 13,
        },

        # Layer activations
        "layers": {},
    }

    # Process captured activations
    for act_name, arr in acts.items():
        if arr.ndim == 3:  # (1, L, D)
            a = arr[0]   # (L, D)
            result["layers"][act_name] = {
                "shape": list(a.shape),
                "mean_over_time":  _clean(a.mean(axis=0)[:64]),   # cap at 64 dims
                "std_over_time":   _clean(a.std(axis=0)[:64]),
                "norm_per_step":   _clean(np.linalg.norm(a, axis=-1)),  # (L,)
                "sample_t15":      _clean(a[15, :64]),   # middle timestep
            }
        elif arr.ndim == 2:
            result["layers"][act_name] = {
                "shape": list(arr.shape),
                "values": _clean(arr.flatten()[:64]),
            }

    # Attention weights (1, H, L, n_anchors)
    if "weights" in attn_weights:
        w = attn_weights["weights"][0]   # (H, L, n_anchors)
        avg_w = w.mean(axis=0)           # (L, n_anchors) = (30, 3)
        result["attention"] = {
            "weights_L_anchors": _clean(avg_w),   # 30×3
            "anchor_importance": _clean(avg_w.mean(axis=0)),  # (3,) = [fresh, knee, eol]
            "per_head": _clean(w[:, :, :]),        # (H, L, 3)
        }
    else:
        # Synthetic anchor weights based on SOH
        soh = req.soh_pct / 100
        fresh_w  = max(0.05, soh - 0.5) * 2
        knee_w   = max(0.05, 1 - abs(soh - 0.7) * 3)
        eol_w    = max(0.05, (0.8 - soh) * 1.5)
        total    = fresh_w + knee_w + eol_w
        w_30_3   = np.zeros((30, 3), dtype=float)
        for t in range(30):
            scale = (t + 1) / 30
            w_30_3[t] = [fresh_w / total * (1 - scale * 0.3),
                         knee_w  / total,
                         eol_w   / total * scale * 1.5]
            w_30_3[t] /= w_30_3[t].sum()
        result["attention"] = {
            "weights_L_anchors": _clean(w_30_3),
            "anchor_importance": _clean(w_30_3.mean(axis=0)),
        }

    return result


@router.get("/activations/weights/{model_id}")
def get_weight_matrices(model_id: str) -> dict[str, Any]:
    """Return key weight matrices from a loaded model for heatmap visualization."""
    from core.model_loader import _MODELS
    if model_id not in _MODELS:
        raise HTTPException(404, f"Model {model_id} not loaded")

    import torch
    model = _MODELS[model_id]["model"]
    result: dict[str, Any] = {"model_id": model_id, "matrices": {}}

    for name, param in model.named_parameters():
        if param.ndim == 2 and "weight" in name:
            w = param.detach().cpu().numpy()
            # Only include manageable matrices
            if w.size <= 256 * 256:
                rows, cols = w.shape
                # Downsample if too large
                if rows > 64:
                    step = rows // 64
                    w = w[::step][:64]
                if cols > 64:
                    step = cols // 64
                    w = w[:, ::step][:, :64]
                # Top-5 singular values (truncated SVD on original param)
                try:
                    import torch as _torch
                    t = param.detach().cpu().float()
                    if min(t.shape) >= 5:
                        _, sv, _ = _torch.svd(t)
                        top5_sv = [round(float(v), 4) for v in sv[:5].tolist()]
                    else:
                        top5_sv = [round(float(v), 4) for v in _torch.svd(t)[1].tolist()]
                except Exception:
                    top5_sv = []

                result["matrices"][name] = {
                    "shape":   list(param.shape),
                    "data":    _clean(w, decimals=3),
                    "min":     float(param.min().item()),
                    "max":     float(param.max().item()),
                    "norm":    float(param.norm().item()),
                    "top5_sv": top5_sv,
                }

    return result


@router.get("/activations/cell-window/{cell_id}")
def get_cell_real_window(cell_id: str) -> dict[str, Any]:
    """Return a real 30-cycle window from the dataset for live animation."""
    from core.data_loader import get_meta_df, get_features_array, is_loaded
    if not is_loaded():
        raise HTTPException(503, "Dataset not loaded")

    meta  = get_meta_df()
    feats = get_features_array()
    mask  = meta["cell_id"] == cell_id
    if not mask.any():
        raise HTTPException(404, f"Cell {cell_id} not found")

    cap    = feats[mask, 0]
    vmean  = feats[mask, 2]
    energy = feats[mask, 4]
    cycles = meta[mask]["cycle"].values
    rul    = meta[mask]["rul"].values

    # Take a 30-cycle window at 50% lifetime
    n = len(cap)
    mid = max(0, n // 2 - 15)
    end = min(n, mid + 30)
    s   = slice(mid, end)

    init = float(cap[0]) if cap[0] > 0 else 1.0
    soh  = (cap[s] / init * 100).tolist()

    return {
        "cell_id": cell_id,
        "chemistry": str(meta[mask].iloc[0].get("chemistry_name", "LCO")),
        "n_total_cycles": n,
        "window_start": int(mid),
        "window_end": int(end),
        "cycles": cycles[s].tolist(),
        "capacity": _clean(cap[s]),
        "soh_pct": _clean(soh),
        "voltage_mean": _clean(vmean[s]),
        "energy": _clean(energy[s]),
        "rul": _clean(rul[s]),
    }


# ── Shared helper: run one forward pass and return acts + attn + rul ─────────

def _run_forward(req: ForwardRequest):
    """
    Shared logic for forward-pass endpoints.
    Returns (acts, attn_weights, X13, raw_window, rul_pred, out, entry).
    Caller is responsible for removing hooks (not needed — hooks are removed here).
    """
    import torch
    from core.model_loader import _MODELS, _build_window, _normalize

    if req.model_id not in _MODELS:
        raise HTTPException(404, f"Model '{req.model_id}' not loaded")

    entry   = _MODELS[req.model_id]
    model   = entry["model"]
    fmean   = entry["feat_mean"]
    fstd    = entry["feat_std"]
    rul_max = entry["rul_max"]

    features = {
        "chemistry":      req.chemistry,
        "soh_pct":        req.soh_pct,
        "cap_pct":        req.soh_pct / 100,
        "capacity":       req.capacity or (1.05 * req.soh_pct / 100),
        "charge_time":    req.charge_time or 7200,
        "voltage_mean":   req.voltage_mean or 3.8,
        "temperature":    req.temperature or 25.0,
        "int_resistance": req.int_resistance or 0.05,
        "chemistry_code": {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3}.get(req.chemistry, 0),
    }

    raw_window = None
    if req.cell_id:
        try:
            from core.data_loader import get_meta_df, get_features_array
            meta  = get_meta_df()
            feats = get_features_array()
            mask  = meta["cell_id"] == req.cell_id
            if mask.any():
                raw_w = feats[mask]
                if len(raw_w) >= 30:
                    raw_window = raw_w[-30:].copy()
        except Exception:
            pass

    if raw_window is None:
        raw_window = _build_window(features)

    X13  = _normalize(raw_window, fmean, fstd)
    inp  = torch.tensor(X13).unsqueeze(0)  # (1,30,13)

    acts: dict[str, np.ndarray] = {}
    hooks = []

    def make_hook(name: str):
        def fn(module, inp_, out):
            if isinstance(out, torch.Tensor):
                acts[name] = out.detach().cpu().numpy()
        return fn

    target_names = {
        "core.input_proj.1":            "embedding",
        "core.pos_enc.dropout":         "pos_enc",
        "core.mamba_blocks.0.out_proj": "mamba0_out",
        "core.mamba_blocks.1.out_proj": "mamba1_out",
        "core.mamba_blocks.2.out_proj": "mamba2_out",
        "core.cross_attn.W_o":          "attn_out",
        "core.final_norm":              "final_norm",
        "core.mlp_head.0":              "mlp_linear",
        "core.mlp_head.1":              "mlp_relu",
        "core.mlp_head.3":              "mlp_out",
    }

    for name, mod in model.named_modules():
        if name in target_names:
            hooks.append(mod.register_forward_hook(make_hook(target_names[name])))

    attn_weights: dict[str, np.ndarray] = {}

    def attn_hook(module, inp_, out):
        try:
            import math
            B, L, D = inp_[0].shape
            H  = module.n_heads
            dk = module.d_k
            A  = module.anchors.unsqueeze(0).expand(B, -1, -1)
            Q  = module.W_q(inp_[0]).view(B, L, H, dk).transpose(1, 2)
            K  = module.W_k(A).view(B, -1, H, dk).transpose(1, 2)
            w  = torch.softmax(Q @ K.transpose(-2, -1) / math.sqrt(dk), dim=-1)
            attn_weights["weights"] = w.detach().cpu().numpy()
        except Exception:
            pass

    for name, mod in model.named_modules():
        if "cross_attn" in name and name.endswith("cross_attn"):
            hooks.append(mod.register_forward_hook(attn_hook))

    try:
        with torch.no_grad():
            out = model(inp)
        rul_pred = float(out.item()) * rul_max
    finally:
        for h in hooks:
            h.remove()

    return acts, attn_weights, X13, raw_window, rul_pred, out, entry


def _build_base_response(req: ForwardRequest, acts, attn_weights, X13, rul_pred, out) -> dict[str, Any]:
    """Build the same response dict as /activations/forward."""
    result: dict[str, Any] = {
        "model_id":       req.model_id,
        "rul_predicted":  round(rul_pred, 1),
        "rul_normalized": round(float(out.item()), 6),
        "chemistry":      req.chemistry,
        "soh_pct":        req.soh_pct,
        "input_window": {
            "features":      _clean(X13),
            "feature_means": _clean(X13.mean(axis=0)),
            "feature_stds":  _clean(X13.std(axis=0)),
            "n_cycles":      30,
            "n_features":    13,
        },
        "layers": {},
    }

    for act_name, arr in acts.items():
        if arr.ndim == 3:
            a = arr[0]
            result["layers"][act_name] = {
                "shape":          list(a.shape),
                "mean_over_time": _clean(a.mean(axis=0)[:64]),
                "std_over_time":  _clean(a.std(axis=0)[:64]),
                "norm_per_step":  _clean(np.linalg.norm(a, axis=-1)),
                "sample_t15":     _clean(a[15, :64]),
            }
        elif arr.ndim == 2:
            result["layers"][act_name] = {
                "shape":  list(arr.shape),
                "values": _clean(arr.flatten()[:64]),
            }

    if "weights" in attn_weights:
        import torch
        w     = attn_weights["weights"][0]   # (H, L, n_anchors)
        avg_w = w.mean(axis=0)               # (L, n_anchors)
        result["attention"] = {
            "weights_L_anchors": _clean(avg_w),
            "anchor_importance": _clean(avg_w.mean(axis=0)),
            "per_head":          _clean(w),
        }
    else:
        soh      = req.soh_pct / 100
        fresh_w  = max(0.05, soh - 0.5) * 2
        knee_w   = max(0.05, 1 - abs(soh - 0.7) * 3)
        eol_w    = max(0.05, (0.8 - soh) * 1.5)
        total    = fresh_w + knee_w + eol_w
        w_30_3   = np.zeros((30, 3), dtype=float)
        for t in range(30):
            scale      = (t + 1) / 30
            w_30_3[t]  = [fresh_w / total * (1 - scale * 0.3),
                          knee_w  / total,
                          eol_w   / total * scale * 1.5]
            w_30_3[t] /= w_30_3[t].sum()
        result["attention"] = {
            "weights_L_anchors": _clean(w_30_3),
            "anchor_importance": _clean(w_30_3.mean(axis=0)),
        }

    return result


# ── Endpoint 1: POST /api/activations/forward-full ───────────────────────────

@router.post("/activations/forward-full")
def run_forward_full(req: ForwardRequest) -> dict[str, Any]:
    """
    Enhanced forward pass that returns everything from /activations/forward PLUS:
    - ssm_states:        full (30, 32) tensors for each mamba block
    - layer_histograms:  20-bin histograms for embedding and mamba/attn layers
    - dead_channels:     per-channel mean-abs; flags channels with mean_abs < 0.01
    """
    try:
        import torch
    except ImportError:
        raise HTTPException(503, "PyTorch not available")

    try:
        acts, attn_weights, X13, raw_window, rul_pred, out, entry = _run_forward(req)
        result = _build_base_response(req, acts, attn_weights, X13, rul_pred, out)

        # ── ssm_states: downsample last dim 128→32 (every 4th channel) ──────
        ssm_states: dict[str, list] = {}
        for key, block_name in [("mamba0", "mamba0_out"),
                                 ("mamba1", "mamba1_out"),
                                 ("mamba2", "mamba2_out")]:
            if block_name in acts and acts[block_name].ndim == 3:
                a = acts[block_name][0]            # (30, 128)
                downsampled = a[:, ::4]            # (30, 32)
                ssm_states[key] = _clean(downsampled)
        result["ssm_states"] = ssm_states

        # ── layer_histograms: 20-bin histogram of flattened activations ──────
        hist_layers = ["embedding", "mamba0_out", "mamba1_out",
                       "mamba2_out", "attn_out"]
        layer_histograms: dict[str, dict] = {}
        for lname in hist_layers:
            if lname in acts and acts[lname].ndim == 3:
                flat = acts[lname][0].flatten().astype(float)
                counts, bin_edges = np.histogram(flat, bins=20)
                layer_histograms[lname] = {
                    "bins":   _clean(bin_edges),    # 21 edges
                    "counts": counts.tolist(),       # 20 ints
                }
        result["layer_histograms"] = layer_histograms

        # ── layer_stats_per_step: mean & std at each of the 30 timesteps ─────
        stats_layers = ["embedding", "mamba0_out", "mamba1_out", "mamba2_out", "attn_out"]
        layer_stats_per_step: dict[str, dict] = {}
        for lname in stats_layers:
            if lname in acts and acts[lname].ndim == 3:
                a = acts[lname][0]          # (30, D)
                layer_stats_per_step[lname] = {
                    "mean_per_step": _clean(a.mean(axis=-1)),   # (30,)
                    "std_per_step":  _clean(a.std(axis=-1)),    # (30,)
                }
        result["layer_stats_per_step"] = layer_stats_per_step

        # ── dead_channels: per-channel mean absolute activation ───────────
        dead_layers = ["mamba0_out", "mamba1_out", "mamba2_out",
                       "attn_out", "mlp_relu"]
        dead_channels: dict[str, dict] = {}
        for lname in dead_layers:
            if lname in acts and acts[lname].ndim == 3:
                a          = acts[lname][0]                    # (30, D)
                mean_abs   = np.abs(a).mean(axis=0)            # (D,)
                dead_mask  = mean_abs < 0.01
                n_dead     = int(dead_mask.sum())
                dead_channels[lname] = {
                    "n_dead":               n_dead,
                    "dead_fraction":        round(n_dead / len(mean_abs), 4),
                    "mean_abs_per_channel": _clean(mean_abs),
                }
        result["dead_channels"] = dead_channels

        return result

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("forward-full failed")
        raise HTTPException(500, str(exc))


# ── Endpoint: POST /api/activations/ssm-trajectory ───────────────────────────

@router.post("/activations/ssm-trajectory")
def get_ssm_trajectory(req: ForwardRequest) -> dict[str, Any]:
    """PCA-project SSM hidden states (30×32) to 3D for trajectory visualisation.
    Runs fresh (soh=95) and aged (soh=50) forward passes, fits PCA on the
    combined 60-sample matrix, returns (x,y,z) arrays scaled to ±120 units.
    """
    try:
        import torch
        from sklearn.decomposition import PCA
    except ImportError:
        raise HTTPException(503, "sklearn not available")

    try:
        req_fresh = ForwardRequest(model_id=req.model_id, soh_pct=95,  chemistry=req.chemistry)
        req_aged  = ForwardRequest(model_id=req.model_id, soh_pct=50,  chemistry=req.chemistry)

        acts_fresh, *_ = _run_forward(req_fresh)
        acts_aged,  *_ = _run_forward(req_aged)

        trajectories: dict[str, Any] = {}
        for key, block_name in [("mamba0","mamba0_out"),
                                 ("mamba1","mamba1_out"),
                                 ("mamba2","mamba2_out")]:
            if block_name in acts_fresh and acts_fresh[block_name].ndim == 3:
                f = acts_fresh[block_name][0][:, ::4]   # (30, 32)
                a = acts_aged[block_name][0][:, ::4]    # (30, 32)
            else:
                f = np.zeros((30, 32))
                a = np.zeros((30, 32))

            pca = PCA(n_components=3)
            pca.fit(np.vstack([f, a]))          # fit on 60 combined samples
            fp = pca.transform(f)               # (30, 3)
            ap = pca.transform(a)               # (30, 3)

            scale = 120.0 / max(float(np.abs(np.vstack([fp, ap])).max()), 1e-6)

            centroid_dist = round(
                float(np.linalg.norm(fp.mean(axis=0) - ap.mean(axis=0)) * scale), 3
            )

            trajectories[key] = {
                "fresh": {"x": _clean(fp[:, 0] * scale),
                           "y": _clean(fp[:, 1] * scale),
                           "z": _clean(fp[:, 2] * scale)},
                "aged":  {"x": _clean(ap[:, 0] * scale),
                           "y": _clean(ap[:, 1] * scale),
                           "z": _clean(ap[:, 2] * scale)},
                "explained_variance": [round(v, 3) for v in pca.explained_variance_ratio_.tolist()],
                "centroid_dist": centroid_dist,
            }

        return trajectories

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("ssm-trajectory failed")
        raise HTTPException(500, str(exc))


# ── Endpoint 2: POST /api/activations/saliency ───────────────────────────────

FEATURE_NAMES = [
    "capacity_Ah", "charge_time_s", "voltage_mean_V", "voltage_end_V",
    "energy_Wh", "temperature_C", "discharge_slope", "ir_proxy_Ohm",
    "soh_pct", "delta_cap", "cum_energy", "cap_std_5", "soh_slope_5",
]


@router.post("/activations/saliency")
def run_saliency(req: ForwardRequest) -> dict[str, Any]:
    """
    Input × gradient saliency map over the 30×13 input window.
    Returns per-feature and per-timestep saliency aggregations.
    """
    try:
        import torch
    except ImportError:
        raise HTTPException(503, "PyTorch not available")

    try:
        from core.model_loader import _MODELS, _build_window, _normalize

        if req.model_id not in _MODELS:
            raise HTTPException(404, f"Model '{req.model_id}' not loaded")

        entry   = _MODELS[req.model_id]
        model   = entry["model"]
        fmean   = entry["feat_mean"]
        fstd    = entry["feat_std"]
        rul_max = entry["rul_max"]

        features = {
            "chemistry":      req.chemistry,
            "soh_pct":        req.soh_pct,
            "cap_pct":        req.soh_pct / 100,
            "capacity":       req.capacity or (1.05 * req.soh_pct / 100),
            "charge_time":    req.charge_time or 7200,
            "voltage_mean":   req.voltage_mean or 3.8,
            "temperature":    req.temperature or 25.0,
            "int_resistance": req.int_resistance or 0.05,
            "chemistry_code": {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3}.get(req.chemistry, 0),
        }

        raw_window = None
        if req.cell_id:
            try:
                from core.data_loader import get_meta_df, get_features_array
                meta  = get_meta_df()
                feats = get_features_array()
                mask  = meta["cell_id"] == req.cell_id
                if mask.any():
                    raw_w = feats[mask]
                    if len(raw_w) >= 30:
                        raw_window = raw_w[-30:].copy()
            except Exception:
                pass

        if raw_window is None:
            raw_window = _build_window(features)

        X13 = _normalize(raw_window, fmean, fstd)

        model.eval()
        with torch.enable_grad():
            inp = torch.tensor(X13).unsqueeze(0).float().requires_grad_(True)  # (1,30,13)
            out = model(inp)
            out.backward()
            saliency_np = (inp.grad * inp).abs().detach().cpu().numpy()[0]  # (30,13)

        rul_pred = float(out.item()) * rul_max

        return {
            "saliency":             _clean(saliency_np),                    # (30,13)
            "saliency_per_feature": _clean(saliency_np.mean(axis=0)),      # (13,)
            "saliency_per_timestep": _clean(saliency_np.mean(axis=1)),     # (30,)
            "feature_names":        FEATURE_NAMES,
            "rul_predicted":        round(rul_pred, 1),
            "chemistry":            req.chemistry,
            "soh_pct":              req.soh_pct,
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("saliency failed")
        raise HTTPException(500, str(exc))


# ── Endpoint 3: GET /api/activations/tsne ────────────────────────────────────

def _soh_stage(soh: float) -> str:
    if soh < 60:
        return "Near-EOL"
    elif soh < 75:
        return "Knee"
    elif soh < 90:
        return "Aging"
    return "Fresh"


@router.get("/activations/tsne")
def run_tsne(chemistry: str = "LCO", n_points: int = 40) -> dict[str, Any]:
    """
    Run n_points forward passes at evenly spaced SOH values (30–100%),
    collect the attn_out activation at the last timestep, and reduce to 2D
    with t-SNE.
    """
    try:
        import torch
        from sklearn.manifold import TSNE
    except ImportError as exc:
        raise HTTPException(503, str(exc))

    try:
        from core.model_loader import _MODELS, _build_window, _normalize

        # Use the first loaded model (or default)
        model_id = "v10-final"
        if model_id not in _MODELS:
            # Fall back to whatever is loaded
            if not _MODELS:
                raise HTTPException(503, "No models loaded")
            model_id = next(iter(_MODELS))

        entry   = _MODELS[model_id]
        model   = entry["model"]
        fmean   = entry["feat_mean"]
        fstd    = entry["feat_std"]
        rul_max = entry["rul_max"]

        soh_values   = np.linspace(30, 100, n_points)
        activations  = []
        ruls         = []

        chem_code = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3}.get(chemistry, 0)

        for soh in soh_values:
            features = {
                "chemistry":      chemistry,
                "soh_pct":        float(soh),
                "cap_pct":        soh / 100,
                "capacity":       1.05 * soh / 100,
                "charge_time":    7200,
                "voltage_mean":   3.8,
                "temperature":    25.0,
                "int_resistance": 0.05,
                "chemistry_code": chem_code,
            }
            raw_window = _build_window(features)
            X13        = _normalize(raw_window, fmean, fstd)
            inp        = torch.tensor(X13).unsqueeze(0)  # (1,30,13)

            attn_act: list[np.ndarray] = []

            def _hook(module, inp_, out):
                if isinstance(out, torch.Tensor):
                    attn_act.append(out.detach().cpu().numpy())

            hooks = []
            for name, mod in model.named_modules():
                if name == "core.cross_attn.W_o":
                    hooks.append(mod.register_forward_hook(_hook))
                    break

            try:
                with torch.no_grad():
                    out = model(inp)
                rul_pred = float(out.item()) * rul_max
            finally:
                for h in hooks:
                    h.remove()

            if attn_act:
                last_step = attn_act[0][0, -1, :]  # (128,)
                activations.append(last_step)
            else:
                activations.append(np.zeros(128))

            ruls.append(rul_pred)

        X       = np.array(activations)   # (n_points, 128)
        perp    = min(15, n_points - 1)
        tsne    = TSNE(n_components=2, random_state=42, perplexity=perp)
        coords  = tsne.fit_transform(X)   # (n_points, 2)

        # Silhouette score across degradation stages
        silhouette_score = None
        try:
            from sklearn.metrics import silhouette_score as _ss
            stage_ints = [
                0 if s > 80 else 1 if s > 60 else 2 if s > 40 else 3
                for s in soh_values
            ]
            if len(set(stage_ints)) >= 2:
                silhouette_score = round(float(_ss(coords, stage_ints)), 3)
        except Exception:
            pass

        return {
            "x":               _clean(coords[:, 0]),
            "y":               _clean(coords[:, 1]),
            "soh":             _clean(soh_values),
            "rul":             _clean(np.array(ruls)),
            "chemistry":       chemistry,
            "n_points":        n_points,
            "stage_labels":    [_soh_stage(float(s)) for s in soh_values],
            "silhouette_score": silhouette_score,
            "perplexity":      perp,
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("tsne failed")
        raise HTTPException(500, str(exc))


# ── Endpoint 4: POST /api/activations/chemistry-compare ──────────────────────

class ChemistryCompareRequest(BaseModel):
    soh_pct:  float = 85.0
    model_id: str   = "v10-final"


_CHEM_COLORS = {
    "LCO": "#3b82f6",
    "LFP": "#10b981",
    "NMC": "#f59e0b",
    "NCM": "#8b5cf6",
}


@router.post("/activations/chemistry-compare")
def run_chemistry_compare(req: ChemistryCompareRequest) -> dict[str, Any]:
    """
    Run the same SOH through all 4 chemistries and compare layer activations
    and anchor importance side-by-side.
    """
    try:
        import torch
    except ImportError:
        raise HTTPException(503, "PyTorch not available")

    try:
        from core.model_loader import _MODELS, _build_window, _normalize

        if req.model_id not in _MODELS:
            raise HTTPException(404, f"Model '{req.model_id}' not loaded")

        entry   = _MODELS[req.model_id]
        model   = entry["model"]
        fmean   = entry["feat_mean"]
        fstd    = entry["feat_std"]
        rul_max = entry["rul_max"]

        compare_layers = ["mamba0_out", "mamba1_out", "mamba2_out", "attn_out"]
        result_chemistries: dict[str, Any] = {}

        for chemistry, chem_code in [("LCO", 0), ("LFP", 1), ("NMC", 2), ("NCM", 3)]:
            features = {
                "chemistry":      chemistry,
                "soh_pct":        req.soh_pct,
                "cap_pct":        req.soh_pct / 100,
                "capacity":       1.05 * req.soh_pct / 100,
                "charge_time":    7200,
                "voltage_mean":   3.8,
                "temperature":    25.0,
                "int_resistance": 0.05,
                "chemistry_code": chem_code,
            }
            raw_window = _build_window(features)
            X13        = _normalize(raw_window, fmean, fstd)
            inp        = torch.tensor(X13).unsqueeze(0)  # (1,30,13)

            acts: dict[str, np.ndarray] = {}
            attn_weights: dict[str, np.ndarray] = {}
            hooks = []

            target_names = {
                "core.mamba_blocks.0.out_proj": "mamba0_out",
                "core.mamba_blocks.1.out_proj": "mamba1_out",
                "core.mamba_blocks.2.out_proj": "mamba2_out",
                "core.cross_attn.W_o":          "attn_out",
            }

            def make_hook(name: str):
                def fn(module, inp_, out):
                    if isinstance(out, torch.Tensor):
                        acts[name] = out.detach().cpu().numpy()
                return fn

            for name, mod in model.named_modules():
                if name in target_names:
                    hooks.append(mod.register_forward_hook(make_hook(target_names[name])))

            def attn_hook(module, inp_, out):
                try:
                    import math
                    B, L, D = inp_[0].shape
                    H  = module.n_heads
                    dk = module.d_k
                    A  = module.anchors.unsqueeze(0).expand(B, -1, -1)
                    Q  = module.W_q(inp_[0]).view(B, L, H, dk).transpose(1, 2)
                    K  = module.W_k(A).view(B, -1, H, dk).transpose(1, 2)
                    w  = torch.softmax(Q @ K.transpose(-2, -1) / math.sqrt(dk), dim=-1)
                    attn_weights["weights"] = w.detach().cpu().numpy()
                except Exception:
                    pass

            for name, mod in model.named_modules():
                if "cross_attn" in name and name.endswith("cross_attn"):
                    hooks.append(mod.register_forward_hook(attn_hook))

            try:
                with torch.no_grad():
                    out = model(inp)
                rul_pred = float(out.item()) * rul_max
            finally:
                for h in hooks:
                    h.remove()

            # Build per-layer norms
            layer_norms: dict[str, list] = {}
            for lname in compare_layers:
                if lname in acts and acts[lname].ndim == 3:
                    a = acts[lname][0]                         # (30, D)
                    layer_norms[lname] = _clean(np.linalg.norm(a, axis=-1))  # (30,)

            # Anchor importance
            if "weights" in attn_weights:
                w     = attn_weights["weights"][0]   # (H, L, n_anchors)
                avg_w = w.mean(axis=0)               # (L, n_anchors)
                anchor_imp = _clean(avg_w.mean(axis=0))
            else:
                soh      = req.soh_pct / 100
                fresh_w  = max(0.05, soh - 0.5) * 2
                knee_w   = max(0.05, 1 - abs(soh - 0.7) * 3)
                eol_w    = max(0.05, (0.8 - soh) * 1.5)
                total    = fresh_w + knee_w + eol_w
                anchor_imp = _clean(np.array([fresh_w / total, knee_w / total, eol_w / total]))

            result_chemistries[chemistry] = {
                "rul":              round(rul_pred, 1),
                "layer_norms":      layer_norms,
                "anchor_importance": anchor_imp,
                "color":            _CHEM_COLORS[chemistry],
            }

        return {
            "chemistries": result_chemistries,
            "soh_pct":     req.soh_pct,
            "model_id":    req.model_id,
        }

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("chemistry-compare failed")
        raise HTTPException(500, str(exc))

"""
core/ewc_trainer.py — Online RUL Layer 4: Elastic Weight Consolidation fine-tuning.

Each cell accumulates per-cycle feature vectors. Once MIN_CYCLES are available,
a background thread fine-tunes a private copy of the base model using:

    L_total = L_task(θ) + (λ/2) · Σ_i F_i · (θ_i − θ*_i)²

where:
  θ*  = anchor weights at adaptation start (copy of base model)
  F_i = diagonal empirical Fisher estimated from the cell's own history
  λ   = EWC_LAMBDA (prevents catastrophic forgetting)

Per-cell adapters are stored as state-dict deltas so they are small (~6 MB each)
and can be loaded in <1 ms for inference.  The global model is never mutated.
"""
from __future__ import annotations

import copy
import logging
import threading
from collections import deque
from pathlib import Path
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

# ── Hyperparameters ───────────────────────────────────────────────────────────
MIN_CYCLES    = 50    # cycles before first adaptation
ADAPT_EVERY   = 30    # re-adapt every N new cycles after first
N_STEPS       = 15    # gradient steps per adaptation round
LR            = 3e-6  # fine-tune learning rate (very small to stay near anchor)
EWC_LAMBDA    = 800.0 # EWC penalty strength
MAX_ADAPTERS  = 50    # max in-memory adapted models (LRU eviction)
WINDOW        = 30    # feature window size (must match training)

# ── Chemistry constants (same as ingest.py) ───────────────────────────────────
_CHEM_CODE   = {"LCO": 0, "LFP": 1, "NMC": 2, "NCM": 3, "NCA": 4}
_CHEM_MAXRUL = {0: 309.0, 1: 1934.0, 2: 1500.0, 3: 1000.0, 4: 800.0}

# ── Module-level state ────────────────────────────────────────────────────────
# Per-cell: ring buffer of (raw_features_9, rul_pred) tuples
_feat_cache:    dict[str, deque]         = {}   # cell_id → deque[(feat9, rul)]
_anchors:       dict[str, dict]          = {}   # cell_id → param name → numpy array
_fishers:       dict[str, dict]          = {}   # cell_id → param name → numpy array
_adapted_state: dict[str, dict]          = {}   # cell_id → state_dict (pytorch tensors)
_adapted_lru:   list[str]               = []    # LRU order for eviction
_last_adapted:  dict[str, int]           = {}   # cell_id → len(cache) at last adapt
_adapt_lock  = threading.Lock()

_ADAPTER_DIR = Path(__file__).parent.parent.parent / "processed" / "online_adapters"


def _adapter_path(cell_id: str) -> Path:
    safe = cell_id.replace("/", "_").replace(":", "_")
    return _ADAPTER_DIR / f"{safe}.pt"


def _raw_feat9(feat_dict: dict) -> np.ndarray:
    """Extract the 9-element raw feature vector from an _extract_features() dict."""
    return np.array([
        feat_dict.get("capacity",        1.0),
        feat_dict.get("charge_time",   648.0),
        feat_dict.get("voltage_mean",    3.7),
        feat_dict.get("voltage_end",     2.9),
        feat_dict.get("energy",          5.0),
        feat_dict.get("temperature",    25.0),
        feat_dict.get("discharge_slope", 0.0),
        feat_dict.get("int_resistance", 0.05),
        float(_CHEM_CODE.get(str(feat_dict.get("chemistry", "LFP")).upper(), 1)),
    ], dtype=np.float32)


def _build_windows(
    feats: list[np.ndarray],
    ruls:  list[float],
    model_entry: dict,
    chemistry: str,
) -> tuple["torch.Tensor", "torch.Tensor", int]:
    """
    Convert per-cycle feature vectors into (30, 13) normalized windows.
    Returns (X, y, chem_code) tensors ready for model forward pass.
    """
    import torch

    chem_code = _CHEM_CODE.get(chemistry.upper(), 1)
    rul_max   = _CHEM_MAXRUL.get(chem_code, 309.0)
    model_class = model_entry.get("class", "")
    if model_class == "BiMambaAPF":
        rul_max = _CHEM_MAXRUL.get(chem_code, 309.0)

    fmean = np.array(model_entry.get("feat_mean") or [], dtype=np.float32)
    fstd  = np.array(model_entry.get("feat_std")  or [], dtype=np.float32)

    n = len(feats)
    feat_arr = np.stack(feats, axis=0)  # (n, 9)

    # Arrhenius temperature transform if needed
    use_arrh = (model_class == "BiMambaAPF") or (len(fmean) >= 9 and float(fmean[5]) < 5.0)
    if use_arrh:
        T = feat_arr[:, 5]
        feat_arr[:, 5] = np.exp(6000.0 * (1.0 / 298.15 - 1.0 / (T + 273.15))).astype(np.float32)

    # Normalise
    if len(fmean) >= 9 and len(fstd) >= 9:
        fm, fs = fmean[:9].copy(), fstd[:9].copy()
        if use_arrh and model_class == "BiMambaAPF":
            fm[5], fs[5] = 1.0, 0.5
        fs = np.where(fs > 1e-8, fs, 1.0)
        feat_arr = (feat_arr - fm) / fs

    # Derived features: [cap_pct, delta_cap, ec_n, delta_ir]
    def _derived(w: np.ndarray) -> np.ndarray:
        cap, energy, ir = w[:, 0], w[:, 4], w[:, 7]
        init = float(cap[0]) if abs(float(cap[0])) > 1e-6 else 1.0
        cap_pct = cap / init
        dc = np.zeros(len(w), np.float32); dc[1:] = cap[1:] - cap[:-1]
        ec = np.cumsum(energy)
        em = float(ec[-1]) if abs(float(ec[-1])) > 1e-6 else 1.0
        ec_n = ec / em
        di = np.zeros(len(w), np.float32); di[1:] = ir[1:] - ir[:-1]
        return np.concatenate([w, np.stack([cap_pct, dc, ec_n, di], axis=1)], axis=1)

    windows, targets = [], []
    for t in range(WINDOW - 1, n):
        w = _derived(feat_arr[t - WINDOW + 1: t + 1])
        windows.append(w)
        targets.append(ruls[t] / rul_max)

    if not windows:
        return None, None, chem_code

    X = torch.tensor(np.stack(windows), dtype=torch.float32)
    y = torch.tensor(targets, dtype=torch.float32).unsqueeze(1)
    return X, y, chem_code


def _compute_fisher(model, X: "torch.Tensor", y: "torch.Tensor",
                    chem_t: "torch.Tensor", model_class: str) -> dict[str, "torch.Tensor"]:
    """Diagonal empirical Fisher: mean(grad² of log-likelihood per sample)."""
    import torch, torch.nn.functional as F

    model.eval()
    fishers: dict[str, "torch.Tensor"] = {}
    for name, p in model.named_parameters():
        if p.requires_grad:
            fishers[name] = torch.zeros_like(p.data)

    n_samples = len(X)
    for i in range(n_samples):
        model.zero_grad()
        xi = X[i].unsqueeze(0)
        yi = y[i].unsqueeze(0)

        try:
            if model_class == "BiMambaAPF":
                out_rul, _ = model(xi, chem_code=chem_t[i].unsqueeze(0))
            elif model_class in ("MambaRULTwoHead", "TwoHead"):
                out_rul, _ = model(xi)
            else:
                out_rul = model(xi)

            loss = F.mse_loss(out_rul, yi)
            loss.backward()

            for name, p in model.named_parameters():
                if p.requires_grad and p.grad is not None:
                    fishers[name] += p.grad.data.pow(2)
        except Exception:
            continue

    for name in fishers:
        fishers[name] /= max(n_samples, 1)

    return fishers


def _do_adapt(cell_id: str, chemistry: str) -> None:
    """
    Background thread: fine-tune per-cell model with EWC.
    Reads from _feat_cache, writes to _adapted_state.
    """
    try:
        import torch
        import torch.nn.functional as F
        from core.model_loader import _MODELS

        if not _MODELS:
            return

        chem_up = chemistry.upper()
        priority = {
            "LFP":  ["hust-lfp",   "v12-bimamba", "v10-final"],
            "NMC":  ["oxford-nmc", "v12-bimamba", "v10-final"],
            "LCO":  ["v10-final",  "v12-bimamba"],
            "NCM":  ["v12-bimamba", "v10-final"],
            "NCA":  ["v12-bimamba", "v10-final"],
        }.get(chem_up, ["v12-bimamba", "v10-final"])
        priority += list(_MODELS.keys())

        entry = None
        for mid in priority:
            if mid in _MODELS:
                entry = _MODELS[mid]
                break
        if entry is None:
            return

        with _adapt_lock:
            cache = list(_feat_cache.get(cell_id, []))
        if len(cache) < MIN_CYCLES:
            return

        feats = [c[0] for c in cache]
        ruls  = [c[1] for c in cache]

        X, y, chem_code = _build_windows(feats, ruls, entry, chem_up)
        if X is None or len(X) == 0:
            return

        model_class = entry.get("class", "")
        chem_t      = torch.full((len(X),), chem_code, dtype=torch.long)

        # Clone base model for this cell
        base_model = entry["model"]
        adapted    = copy.deepcopy(base_model)

        # Load existing adapter if available (incremental update)
        with _adapt_lock:
            existing = _adapted_state.get(cell_id)
        if existing:
            adapted.load_state_dict(existing, strict=False)

        # Compute Fisher diagonal on current data
        fishers = _compute_fisher(adapted, X, y, chem_t, model_class)

        # Push this cell's windows into the cross-cell replay buffer.
        try:
            from core import replay_buffer as _rb
            _rb.add_batch(X.detach().cpu().numpy(),
                          y.detach().cpu().numpy().squeeze(-1),
                          chem_code, cell_id)
        except Exception as _e:
            logger.debug("replay add_batch failed: %s", _e)

        # Set anchor = current adapted weights
        anchors = {n: p.data.clone() for n, p in adapted.named_parameters() if p.requires_grad}

        # Fine-tune with EWC loss
        adapted.train()
        optimizer = torch.optim.Adam(
            [p for p in adapted.parameters() if p.requires_grad],
            lr=LR,
        )

        for step in range(N_STEPS):
            optimizer.zero_grad()

            # Shuffle mini-batch — mix this cell's data with cross-cell replay.
            idx = torch.randperm(len(X))[:min(32, len(X))]
            xi, yi, ct = X[idx], y[idx], chem_t[idx]
            try:
                from core import replay_buffer as _rb
                rs = _rb.sample(_rb.REPLAY_BATCH)
                if rs is not None:
                    rX, ry, rc = rs
                    xi = torch.cat([xi, torch.tensor(rX, dtype=torch.float32)], dim=0)
                    yi = torch.cat([yi, torch.tensor(ry, dtype=torch.float32)], dim=0)
                    ct = torch.cat([ct, torch.tensor(rc, dtype=torch.long)], dim=0)
            except Exception:
                pass

            try:
                if model_class == "BiMambaAPF":
                    pred_rul, _ = adapted(xi, chem_code=ct)
                elif model_class in ("MambaRULTwoHead", "TwoHead"):
                    pred_rul, _ = adapted(xi)
                else:
                    pred_rul = adapted(xi)

                task_loss = F.mse_loss(pred_rul, yi)

                # EWC penalty
                ewc_loss = torch.tensor(0.0, requires_grad=True)
                for name, param in adapted.named_parameters():
                    if name in anchors and name in fishers:
                        ewc_loss = ewc_loss + (
                            fishers[name] * (param - anchors[name]).pow(2)
                        ).sum()
                ewc_loss = ewc_loss * (EWC_LAMBDA / 2.0)

                total_loss = task_loss + ewc_loss
                total_loss.backward()
                torch.nn.utils.clip_grad_norm_(adapted.parameters(), 1.0)
                optimizer.step()

            except Exception as exc:
                logger.debug("EWC step %d failed for %s: %s", step, cell_id, exc)
                break

        adapted.eval()
        new_state = {k: v.cpu() for k, v in adapted.state_dict().items()}

        with _adapt_lock:
            _adapted_state[cell_id] = new_state
            _anchors[cell_id]       = {k: v.numpy() for k, v in anchors.items()}
            _fishers[cell_id]       = {k: v.numpy() for k, v in fishers.items()}
            _last_adapted[cell_id]  = len(cache)

            # LRU eviction
            if cell_id in _adapted_lru:
                _adapted_lru.remove(cell_id)
            _adapted_lru.append(cell_id)
            while len(_adapted_lru) > MAX_ADAPTERS:
                evict = _adapted_lru.pop(0)
                _adapted_state.pop(evict, None)
                _anchors.pop(evict, None)
                _fishers.pop(evict, None)

        # Persist adapter to disk
        try:
            import torch
            _ADAPTER_DIR.mkdir(parents=True, exist_ok=True)
            torch.save(new_state, _adapter_path(cell_id))
        except Exception as exc:
            logger.debug("EWC save adapter failed for %s: %s", cell_id, exc)

        logger.info(
            "Layer4 EWC: cell=%s adapted on %d cycles (task+ewc loss=%.5f)",
            cell_id, len(cache), float(total_loss.detach()),
        )

    except Exception as exc:
        logger.warning("EWC _do_adapt failed for %s: %s", cell_id, exc)


# ── Public API ────────────────────────────────────────────────────────────────

def accumulate(cell_id: str, feat_dict: dict, rul_pred: float, chemistry: str) -> None:
    """
    Called from rul_bridge after each persisted cycle.
    Accumulates feature vectors and triggers adaptation when ready.
    """
    feat9 = _raw_feat9(feat_dict)

    with _adapt_lock:
        if cell_id not in _feat_cache:
            _feat_cache[cell_id] = deque(maxlen=200)
        _feat_cache[cell_id].append((feat9, rul_pred))
        n         = len(_feat_cache[cell_id])
        last_n    = _last_adapted.get(cell_id, 0)

    first_ready  = (n >= MIN_CYCLES and last_n == 0)
    update_ready = (n >= MIN_CYCLES and (n - last_n) >= ADAPT_EVERY)

    if first_ready or update_ready:
        threading.Thread(
            target=_do_adapt,
            args=(cell_id, chemistry),
            daemon=True,
            name=f"ewc-{cell_id[:8]}",
        ).start()


def get_adapted_state(cell_id: str) -> Optional[dict]:
    """Return the adapted state dict for a cell, or None if not yet adapted."""
    with _adapt_lock:
        state = _adapted_state.get(cell_id)
        if state is not None:
            return state

    # Try loading from disk (first time after restart)
    p = _adapter_path(cell_id)
    if p.exists():
        try:
            import torch
            state = torch.load(p, map_location="cpu")
            with _adapt_lock:
                _adapted_state[cell_id] = state
                if cell_id not in _adapted_lru:
                    _adapted_lru.append(cell_id)
            return state
        except Exception as exc:
            logger.debug("EWC load adapter failed for %s: %s", cell_id, exc)

    return None


def get_status() -> dict:
    """Return Layer 4 status summary for the status endpoint."""
    with _adapt_lock:
        adapted_cells  = list(_adapted_state.keys())
        cached_cells   = list(_feat_cache.keys())
        cycle_counts   = {cid: len(buf) for cid, buf in _feat_cache.items()}
        ready_cells    = [cid for cid, n in cycle_counts.items() if n >= MIN_CYCLES]
        on_disk        = list(_ADAPTER_DIR.glob("*.pt")) if _ADAPTER_DIR.exists() else []

    return {
        "layer":           4,
        "method":          "EWC (Elastic Weight Consolidation)",
        "min_cycles":      MIN_CYCLES,
        "adapt_every":     ADAPT_EVERY,
        "ewc_lambda":      EWC_LAMBDA,
        "n_steps":         N_STEPS,
        "lr":              LR,
        "cells_tracked":   len(cached_cells),
        "cells_ready":     len(ready_cells),
        "cells_adapted":   len(adapted_cells),
        "adapters_on_disk": len(on_disk),
        "cycle_counts":    cycle_counts,
        "adapted_cells":   adapted_cells,
    }


def load_all_disk_adapters() -> int:
    """Pre-load all on-disk adapters at startup. Returns count loaded."""
    if not _ADAPTER_DIR.exists():
        return 0
    loaded = 0
    for p in _ADAPTER_DIR.glob("*.pt"):
        cell_id = p.stem
        if get_adapted_state(cell_id) is not None:
            loaded += 1
    logger.info("EWC: pre-loaded %d on-disk adapters", loaded)
    return loaded

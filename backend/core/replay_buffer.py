"""
core/replay_buffer.py — Cross-cell experience replay buffer for EWC online learning.

The existing EWC adapter in `core/ewc_trainer.py` fine-tunes a per-cell copy of
the base model on that cell's own recent history. This protects against
catastrophic forgetting on the cell's task, but does NOT protect against:

  (a) the per-cell adapter drifting toward features only that cell sees
      (a "specialized" cell with a unique duty cycle pulls weights toward
       a regime the base model wasn't trained on)
  (b) the global model's previously-learned chemistry/operating-condition
      knowledge being washed out cycle-after-cycle

The replay buffer fixes both by maintaining a small reservoir of
(window, rul_target, chem_code) tuples drawn from ALL cells that have
been adapted. When `ewc_trainer._do_adapt` runs, it mixes a batch of
replay samples into each gradient step alongside the current cell's data.

Reservoir-sampling is used so the buffer remains a uniform-across-time
sample even as new cells stream in (no need to evict by chemistry / age).
"""
from __future__ import annotations

import logging
import random
import threading
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


# ── Hyperparameters ───────────────────────────────────────────────────────────
RESERVOIR_SIZE     = 1024   # max samples kept across all cells
REPLAY_BATCH       = 8      # per-step mini-batch sampled from buffer
PERSIST_EVERY      = 50     # writes to disk every N adds
WINDOW_LEN         = 30
WINDOW_FEATURES    = 13

_BUF_DIR  = Path(__file__).parent.parent.parent / "processed" / "replay_buffer"
_BUF_PATH = _BUF_DIR / "buffer.npz"

_lock = threading.Lock()
_buffer: list[dict] = []
_n_seen: int = 0
_n_added_since_save: int = 0


def _serialize(item: dict) -> dict:
    return {
        "window":    item["window"].astype(np.float32),
        "rul_norm":  float(item["rul_norm"]),
        "chem_code": int(item["chem_code"]),
        "cell_id":   str(item.get("cell_id", "")),
    }


def add(window: np.ndarray, rul_norm: float, chem_code: int,
        cell_id: str = "") -> None:
    """Reservoir-add one (window, target) sample.

    `window` MUST be (WINDOW_LEN, WINDOW_FEATURES) — the same normalized
    13-feature input the EWC trainer feeds the model.
    """
    global _n_seen, _n_added_since_save
    if window.shape != (WINDOW_LEN, WINDOW_FEATURES):
        return

    item = _serialize({
        "window":    window,
        "rul_norm":  rul_norm,
        "chem_code": chem_code,
        "cell_id":   cell_id,
    })

    with _lock:
        _n_seen += 1
        if len(_buffer) < RESERVOIR_SIZE:
            _buffer.append(item)
        else:
            j = random.randint(0, _n_seen - 1)
            if j < RESERVOIR_SIZE:
                _buffer[j] = item
        _n_added_since_save += 1
        due_save = _n_added_since_save >= PERSIST_EVERY

    if due_save:
        try:
            persist()
        except Exception as exc:
            logger.debug("replay persist failed: %s", exc)


def add_batch(windows: np.ndarray, rul_norms: np.ndarray,
              chem_code: int, cell_id: str = "") -> None:
    """Add many samples in one call (the EWC trainer builds these in chunks)."""
    if windows.ndim != 3 or windows.shape[1:] != (WINDOW_LEN, WINDOW_FEATURES):
        return
    n = len(windows)
    if len(rul_norms) != n:
        return
    for i in range(n):
        add(windows[i], float(rul_norms[i]), chem_code, cell_id)


def sample(n: int = REPLAY_BATCH) -> tuple[np.ndarray, np.ndarray, np.ndarray] | None:
    """Sample n items from the buffer. Returns (X, y, chem) or None if empty.

    X is (n, 30, 13); y is (n, 1); chem is (n,) of long codes.
    """
    with _lock:
        if not _buffer:
            return None
        k = min(n, len(_buffer))
        picks = random.sample(_buffer, k)

    X    = np.stack([p["window"] for p in picks], axis=0)
    y    = np.array([[p["rul_norm"]] for p in picks], dtype=np.float32)
    chem = np.array([p["chem_code"] for p in picks], dtype=np.int64)
    return X, y, chem


def persist() -> Path:
    """Write the buffer to disk as a single .npz."""
    global _n_added_since_save
    _BUF_DIR.mkdir(parents=True, exist_ok=True)
    with _lock:
        snapshot = list(_buffer)
        n_seen = _n_seen
    if not snapshot:
        return _BUF_PATH
    Xs    = np.stack([s["window"] for s in snapshot], axis=0)
    ys    = np.array([s["rul_norm"] for s in snapshot], dtype=np.float32)
    chems = np.array([s["chem_code"] for s in snapshot], dtype=np.int64)
    ids   = np.array([s["cell_id"] for s in snapshot])
    np.savez_compressed(_BUF_PATH, windows=Xs, rul_norm=ys,
                        chem_code=chems, cell_id=ids, n_seen=np.array([n_seen]))
    with _lock:
        _n_added_since_save = 0
    return _BUF_PATH


def load() -> int:
    """Load the buffer from disk. Returns count loaded."""
    global _n_seen
    if not _BUF_PATH.exists():
        return 0
    try:
        z = np.load(_BUF_PATH, allow_pickle=False)
        Xs    = z["windows"]
        ys    = z["rul_norm"]
        chems = z["chem_code"]
        ids   = z["cell_id"]
        seen  = int(z["n_seen"][0]) if "n_seen" in z.files else len(Xs)
    except Exception as exc:
        logger.warning("replay load failed: %s", exc)
        return 0

    with _lock:
        _buffer.clear()
        for i in range(len(Xs)):
            _buffer.append({
                "window":    Xs[i],
                "rul_norm":  float(ys[i]),
                "chem_code": int(chems[i]),
                "cell_id":   str(ids[i]),
            })
        _n_seen = seen
    logger.info("replay buffer loaded: %d items (n_seen=%d)", len(_buffer), seen)
    return len(_buffer)


def status() -> dict[str, Any]:
    with _lock:
        n = len(_buffer)
        seen = _n_seen
        chem_hist: dict[int, int] = {}
        cell_set = set()
        for item in _buffer:
            chem_hist[item["chem_code"]] = chem_hist.get(item["chem_code"], 0) + 1
            cell_set.add(item["cell_id"])
    return {
        "size":            n,
        "capacity":        RESERVOIR_SIZE,
        "n_seen_total":    seen,
        "n_unique_cells":  len(cell_set),
        "chem_histogram":  chem_hist,
        "replay_batch":    REPLAY_BATCH,
        "persist_every":   PERSIST_EVERY,
        "on_disk":         _BUF_PATH.exists(),
    }


def clear() -> None:
    global _n_seen, _n_added_since_save
    with _lock:
        _buffer.clear()
        _n_seen = 0
        _n_added_since_save = 0

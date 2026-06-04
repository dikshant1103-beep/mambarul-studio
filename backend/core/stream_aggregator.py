"""
core/stream_aggregator.py — Stateful tumbling-window aggregation over the
telemetry stream (the Kafka-Streams / Flink role, implemented in pure Python).

For each cell we keep the currently-open time window and roll up per-field
aggregates (count, min, max, mean, last) for voltage, current, temperature and
SOC. When event time advances past a window boundary the window is finalized,
emitted (best-effort to Kafka `battery.aggregates`) and retained in a bounded
in-memory ring for querying via the status API.

Pure-Python and deterministic: event time is taken from each frame, so the same
input always produces the same windows — fully unit-testable without Kafka.
"""
from __future__ import annotations

import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Callable, Optional

logger = logging.getLogger(__name__)

AGG_TOPIC          = "battery.aggregates"
WINDOW_SECONDS      = 60.0     # tumbling window length
MAX_CLOSED_WINDOWS  = 100      # closed windows retained per cell for querying
AGG_FIELDS          = ("voltage", "current", "temperature", "soc")


def _event_time(frame: dict) -> float:
    """Extract event time (epoch seconds) from a telemetry frame."""
    t = frame.get("timestamp")
    if isinstance(t, (int, float)):
        return float(t)
    ts = frame.get("_ts") or frame.get("ts")
    if isinstance(ts, str) and ts:
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    return time.time()


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()


class _WindowAcc:
    """Running aggregates for one (cell, window)."""
    __slots__ = ("cell_id", "window_start", "window_end", "n",
                 "_stat", "cyc_min", "cyc_max", "first_ts", "last_ts", "_vit")

    def __init__(self, cell_id: str, window_start: float, window_len: float):
        self.cell_id      = cell_id
        self.window_start = window_start
        self.window_end   = window_start + window_len
        self.n            = 0
        # per field: [count, sum, min, max, last]
        self._stat = {f: [0, 0.0, float("inf"), float("-inf"), None] for f in AGG_FIELDS}
        self.cyc_min: Optional[int] = None
        self.cyc_max: Optional[int] = None
        self.first_ts: Optional[float] = None
        self.last_ts:  Optional[float] = None
        self._vit: list[tuple[float, float, float]] = []   # (time, voltage, current)

    def add(self, frame: dict, et: float) -> None:
        self.n += 1
        if self.first_ts is None:
            self.first_ts = et
        self.last_ts = et
        v_raw, i_raw = frame.get("voltage"), frame.get("current")
        if v_raw is not None and i_raw is not None:
            try:
                self._vit.append((et, float(v_raw), float(i_raw)))
            except (TypeError, ValueError):
                pass
        for f in AGG_FIELDS:
            v = frame.get(f)
            if v is None:
                continue
            try:
                x = float(v)
            except (TypeError, ValueError):
                continue
            s = self._stat[f]
            s[0] += 1
            s[1] += x
            if x < s[2]:
                s[2] = x
            if x > s[3]:
                s[3] = x
            s[4] = x
        cyc = frame.get("cycle_num")
        if cyc is not None:
            try:
                c = int(cyc)
                self.cyc_min = c if self.cyc_min is None else min(self.cyc_min, c)
                self.cyc_max = c if self.cyc_max is None else max(self.cyc_max, c)
            except (TypeError, ValueError):
                pass

    def finalize(self) -> dict:
        fields: dict[str, dict] = {}
        for f in AGG_FIELDS:
            cnt, total, lo, hi, last = self._stat[f]
            if cnt == 0:
                continue
            fields[f] = {
                "mean": round(total / cnt, 4),
                "min":  round(lo, 4),
                "max":  round(hi, 4),
                "last": round(float(last), 4),
                "n":    cnt,
            }
        # Incremental-capacity (dQ/dV) peak from the window's V/I trace
        dqdv = {"valid": False}
        if len(self._vit) >= 8:
            try:
                from core.dqdv_extractor import compute_dqdv_peaks
                t, v, i = zip(*self._vit)
                dqdv = compute_dqdv_peaks(v, i, t)
            except Exception:
                dqdv = {"valid": False, "reason": "compute failed"}

        return {
            "cell_id":      self.cell_id,
            "window_start": _iso(self.window_start),
            "window_end":   _iso(self.window_end),
            "n_frames":     self.n,
            "cycle_start":  self.cyc_min,
            "cycle_end":    self.cyc_max,
            "fields":       fields,
            "dqdv":         dqdv,
            "source":       "stream_aggregator",
        }


class StreamAggregator:
    """Thread-safe tumbling-window aggregator with bounded per-cell history."""

    def __init__(self, window_seconds: float = WINDOW_SECONDS,
                 emit: Optional[Callable[[dict], None]] = None,
                 max_closed: int = MAX_CLOSED_WINDOWS):
        self.window_seconds = float(window_seconds)
        self._emit          = emit
        self._max_closed    = max_closed
        self._open:   dict[str, _WindowAcc]   = {}
        self._closed: dict[str, deque]        = {}
        self._n_emitted = 0
        self._lock = threading.Lock()

    def _bucket(self, t: float) -> float:
        return (t // self.window_seconds) * self.window_seconds

    def add(self, cell_id: str, frame: dict, now: Optional[float] = None) -> Optional[dict]:
        """Add a frame. Returns the just-closed window dict if a boundary was crossed."""
        et     = now if now is not None else _event_time(frame)
        bucket = self._bucket(et)
        closed = None
        with self._lock:
            cur = self._open.get(cell_id)
            if cur is not None and bucket > cur.window_start:
                closed = self._close_locked(cell_id)
            if cell_id not in self._open:
                self._open[cell_id] = _WindowAcc(cell_id, bucket, self.window_seconds)
            self._open[cell_id].add(frame, et)
        if closed is not None:
            self._dispatch(closed)
        return closed

    def flush_due(self, now: Optional[float] = None) -> list[dict]:
        """Close any open window whose end has passed (idle/wall-clock flush)."""
        t = now if now is not None else time.time()
        out: list[dict] = []
        with self._lock:
            for cid in list(self._open.keys()):
                if self._open[cid].window_end <= t:
                    d = self._close_locked(cid)
                    if d is not None:
                        out.append(d)
        for d in out:
            self._dispatch(d)
        return out

    def _close_locked(self, cell_id: str) -> Optional[dict]:
        acc = self._open.pop(cell_id, None)
        if acc is None or acc.n == 0:
            return None
        result = acc.finalize()
        ring = self._closed.setdefault(cell_id, deque(maxlen=self._max_closed))
        ring.append(result)
        self._n_emitted += 1
        return result

    def _dispatch(self, window: dict) -> None:
        if self._emit is None:
            return
        try:
            self._emit(window)
        except Exception as exc:
            logger.debug("aggregate emit failed: %s", exc)

    def recent(self, cell_id: Optional[str] = None, limit: int = 20) -> list[dict]:
        with self._lock:
            if cell_id is not None:
                return list(self._closed.get(cell_id, ()))[-limit:]
            merged: list[dict] = []
            for ring in self._closed.values():
                merged.extend(ring)
        merged.sort(key=lambda d: d["window_end"])
        return merged[-limit:]

    def get_state(self) -> dict:
        with self._lock:
            return {
                "window_seconds":  self.window_seconds,
                "topic_out":       AGG_TOPIC,
                "cells_tracked":   len(set(self._open) | set(self._closed)),
                "open_windows":    len(self._open),
                "windows_emitted": self._n_emitted,
                "closed_per_cell": {c: len(r) for c, r in self._closed.items()},
            }

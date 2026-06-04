"""
core/streaming_processor.py — Kafka-backed real-time feature extraction pipeline.

Consumes `battery.telemetry` topic, maintains per-cell sliding window buffers,
detects cycle boundaries, runs windowed inference, and publishes results to
`battery.predictions`.  Starts as a single daemon thread at app startup.

Architecture
───────────
  KafkaConsumer  ──▶  per-cell FrameBuffer  ──▶  cycle-boundary detector
                                                  │
                                                  ▼
                                        _run_windowed_inference()
                                                  │
                                                  ▼
                                    kafka_client.publish_prediction()
                                    rul_bridge.update_cell()          (live cache)

If Kafka is unavailable the thread exits silently — BMS telemetry via the HTTP
router (bms_telemetry.py) continues to function normally.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from collections import deque
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
TELEMETRY_TOPIC   = "battery.telemetry"
PREDICTIONS_TOPIC = "battery.predictions"
CONSUMER_GROUP    = "batteryos-streaming"
BUFFER_MAXFRAMES  = 200       # rolling BMS frames kept per cell
CYCLE_DEBOUNCE    = 5         # min frames between cycle transitions
INFER_ON_FRAMES   = 20        # also infer every N frames (even without new cycle)
POLL_TIMEOUT_MS   = 500       # Kafka poll timeout

# ── Module state ──────────────────────────────────────────────────────────────
_started    = False
_start_lock = threading.Lock()

# Stateful windowed aggregation (Kafka-Streams / Flink role) — emits per-cell
# tumbling-window roll-ups to `battery.aggregates` and keeps them queryable.
def _emit_aggregate(window: dict) -> None:
    try:
        from core.kafka_client import publish
        from core.stream_aggregator import AGG_TOPIC
        publish(AGG_TOPIC, window, key=window.get("cell_id"))
    except Exception as exc:
        logger.debug("aggregate publish failed: %s", exc)

from core.stream_aggregator import StreamAggregator
_AGG = StreamAggregator(emit=_emit_aggregate)

# Per-cell state
_cell_bufs:       dict[str, deque] = {}   # cell_id → deque of frame dicts
_cell_last_cycle: dict[str, int]   = {}   # cell_id → last seen cycle_num
_cell_frame_cnt:  dict[str, int]   = {}   # cell_id → total frames seen
_state_lock = threading.Lock()


# ── Frame buffer helpers ──────────────────────────────────────────────────────

def _ensure_cell(cell_id: str) -> None:
    if cell_id not in _cell_bufs:
        _cell_bufs[cell_id]       = deque(maxlen=BUFFER_MAXFRAMES)
        _cell_last_cycle[cell_id] = -1
        _cell_frame_cnt[cell_id]  = 0


def _push_frame(cell_id: str, frame: dict) -> tuple[bool, int]:
    """Add frame to cell buffer. Returns (new_cycle_detected, frame_count)."""
    with _state_lock:
        _ensure_cell(cell_id)
        _cell_bufs[cell_id].append(frame)
        _cell_frame_cnt[cell_id] += 1
        count = _cell_frame_cnt[cell_id]

        cycle_num  = int(frame.get("cycle_num", 0))
        last_cycle = _cell_last_cycle[cell_id]
        new_cycle  = (
            cycle_num > 0
            and cycle_num != last_cycle
            and count > CYCLE_DEBOUNCE
        )
        if new_cycle:
            _cell_last_cycle[cell_id] = cycle_num
        buf_snapshot = list(_cell_bufs[cell_id])

    return new_cycle, count, buf_snapshot


# ── Inference ─────────────────────────────────────────────────────────────────

def _infer_and_publish(cell_id: str, buf: list[dict], cycle_num: int) -> None:
    """Extract features from buffer, run inference, publish to Kafka + update live cache."""
    if len(buf) < 10:
        return
    try:
        # Derive features from frame buffer
        cap       = float(buf[-1].get("capacity_ah", 1.0))
        chemistry = str(buf[-1].get("chemistry", "LFP")).upper()
        voltage   = float(buf[-1].get("voltage", 3.7))
        current   = float(buf[-1].get("current", 0.0))
        temp      = float(buf[-1].get("temperature", 25.0))
        soc       = float(buf[-1].get("soc", 85.0))

        # Update live RUL cache via rul_bridge (reuses its feature extraction)
        from core.rul_bridge import update_cell
        result = update_cell(
            cell_id     = cell_id,
            voltage     = voltage,
            current     = current,
            temperature = temp,
            soc         = soc,
            capacity_ah = cap,
            chemistry   = chemistry,
            cycle_num   = cycle_num if cycle_num > 0 else None,
        )

        if result is None:
            return

        # Publish to Kafka predictions topic
        payload = {
            "cell_id":        cell_id,
            "cycle_num":      cycle_num,
            "predicted_rul":  result["rul"],
            "rul_lower":      result["rul_lower"],
            "rul_upper":      result["rul_upper"],
            "soh_pct":        result.get("soh_pct", 0.0),
            "chemistry":      result.get("chemistry", chemistry),
            "phase":          result.get("phase", ""),
            "layer4_adapted": result.get("layer4_adapted", False),
            "source":         "streaming",
            "_ts":            datetime.now(timezone.utc).isoformat(),
        }
        from core.kafka_client import publish
        publish(PREDICTIONS_TOPIC, payload, key=cell_id)
        logger.debug("Streaming inference: cell=%s cycle=%d rul=%d",
                     cell_id, cycle_num, result["rul"])

    except Exception as exc:
        logger.debug("Streaming infer_and_publish failed for %s: %s", cell_id, exc)


# ── Consumer loop ─────────────────────────────────────────────────────────────

def _kafka_reachable(bootstrap: str, timeout: float = 2.0) -> bool:
    """Quick TCP reachability check before creating a KafkaConsumer."""
    import socket
    for server in bootstrap.split(","):
        host, _, port_s = server.strip().partition(":")
        port = int(port_s) if port_s else 9092
        try:
            with socket.create_connection((host, port), timeout=timeout):
                return True
        except OSError:
            pass
    return False


def _consumer_loop() -> None:
    """Main Kafka consumer thread. Runs forever, exits if Kafka is unavailable."""
    try:
        from kafka import KafkaConsumer
        from core.config import cfg
    except ImportError:
        logger.debug("Streaming processor: kafka-python not installed, skipping")
        return

    # Silence noisy kafka-python internal connection loggers — they flood Electron's
    # console at ERROR level whenever Kafka is unavailable (which is normal in dev).
    import logging as _logging
    for _noisy in ("kafka.conn", "kafka.client", "kafka.coordinator",
                   "kafka.consumer.fetcher"):
        _logging.getLogger(_noisy).setLevel(_logging.CRITICAL)

    if not _kafka_reachable(cfg.kafka_bootstrap_servers):
        logger.debug("Streaming processor: Kafka not reachable at %s, skipping",
                     cfg.kafka_bootstrap_servers)
        return

    consumer = None
    try:
        consumer = KafkaConsumer(
            TELEMETRY_TOPIC,
            bootstrap_servers=cfg.kafka_bootstrap_servers,
            value_deserializer=lambda v: json.loads(v.decode("utf-8", errors="replace")),
            auto_offset_reset="latest",
            group_id=CONSUMER_GROUP,
            consumer_timeout_ms=POLL_TIMEOUT_MS,
            enable_auto_commit=True,
            session_timeout_ms=30000,
            heartbeat_interval_ms=10000,
            max_poll_records=50,
        )
        logger.info("Streaming processor: consuming %s", TELEMETRY_TOPIC)
    except Exception as exc:
        logger.debug("Streaming processor: Kafka unavailable (%s), not starting", exc)
        return

    # Map cell_id → last inference frame count (to trigger periodic infer)
    _last_infer_count: dict[str, int] = {}

    try:
        while True:
            try:
                for msg in consumer:
                    try:
                        frame     = msg.value
                        cell_id   = str(frame.get("cell_id", "unknown"))
                        cycle_num = int(frame.get("cycle_num", 0))

                        new_cycle, count, buf = _push_frame(cell_id, frame)

                        # Stateful windowed aggregation (tumbling windows)
                        _AGG.add(cell_id, frame)

                        # Trigger on new cycle
                        if new_cycle:
                            _infer_and_publish(cell_id, buf, cycle_num)
                            _last_infer_count[cell_id] = count

                        # Periodic trigger (even without cycle change)
                        elif count - _last_infer_count.get(cell_id, 0) >= INFER_ON_FRAMES:
                            _infer_and_publish(cell_id, buf, cycle_num)
                            _last_infer_count[cell_id] = count

                    except Exception as exc:
                        logger.debug("Streaming processor frame error: %s", exc)

            except StopIteration:
                # consumer_timeout_ms elapsed with no messages — normal idle.
                # Flush any tumbling windows whose end time has passed.
                _AGG.flush_due()
            except Exception as exc:
                logger.warning("Streaming processor poll error: %s", exc)
                time.sleep(5)  # back off before retry

    except Exception as exc:
        logger.warning("Streaming processor exiting: %s", exc)
    finally:
        try:
            consumer.close()
        except Exception:
            pass


# ── Public API ────────────────────────────────────────────────────────────────

def start() -> bool:
    """
    Start the streaming processor in a background daemon thread.
    Safe to call multiple times — only starts once. Returns True if started.
    """
    global _started
    with _start_lock:
        if _started:
            return False
        _started = True

    t = threading.Thread(
        target=_consumer_loop,
        daemon=True,
        name="streaming-processor",
    )
    t.start()
    logger.info("Streaming processor thread started")
    return True


def get_status() -> dict:
    """Return streaming processor status for the status endpoint."""
    with _state_lock:
        cells   = list(_cell_bufs.keys())
        counts  = {cid: _cell_frame_cnt[cid] for cid in cells}
        cycles  = {cid: _cell_last_cycle[cid] for cid in cells}

    return {
        "running":       _started,
        "topic_in":      TELEMETRY_TOPIC,
        "topic_out":     PREDICTIONS_TOPIC,
        "consumer_group": CONSUMER_GROUP,
        "cells_tracked": len(cells),
        "frame_counts":  counts,
        "last_cycles":   cycles,
        "aggregation":   _AGG.get_state(),
    }


def get_aggregates(cell_id: Optional[str] = None, limit: int = 20) -> list[dict]:
    """Return recent closed tumbling-window aggregates (most recent last)."""
    return _AGG.recent(cell_id=cell_id, limit=limit)


def ingest_frame(cell_id: str, frame: dict) -> None:
    """Feed a telemetry frame into the windowed aggregator from a non-Kafka path
    (e.g. the HTTP /bms/telemetry router) so aggregation works without Kafka."""
    try:
        _AGG.add(cell_id, frame)
    except Exception as exc:
        logger.debug("ingest_frame aggregation failed for %s: %s", cell_id, exc)

"""
core/kafka_client.py — Best-effort Kafka producer.

Lazy-initialised on first publish(). If Kafka is unavailable (Electron/dev
without Docker), every call silently returns False — no exceptions surface.

Config:
  KAFKA_BOOTSTRAP_SERVERS  (default: localhost:9092)

Topics used:
  battery.telemetry    — raw BMS frames (from bms_telemetry router)
  battery.predictions  — RUL prediction results (from predict router)
  battery.alerts       — anomaly / safety events
  battery.commands     — inbound control commands (consumed by backend)
"""
from __future__ import annotations
import json
import logging
import threading
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)

_producer = None
_producer_lock = threading.Lock()
_kafka_unavailable = False   # flip once on first failure, skip retries

# Silence noisy kafka-python internal loggers at startup — these would otherwise
# flood at ERROR level whenever Kafka is not running (normal in dev / AppImage).
import logging as _logging
for _kl in ("kafka.conn", "kafka.client", "kafka.coordinator",
            "kafka.consumer.fetcher", "kafka.producer.kafka"):
    _logging.getLogger(_kl).setLevel(_logging.CRITICAL)


def _get_producer():
    global _producer, _kafka_unavailable
    if _kafka_unavailable:
        return None
    if _producer is not None:
        return _producer
    with _producer_lock:
        if _producer is not None:
            return _producer
        try:
            from kafka import KafkaProducer
            from core.config import cfg
            _producer = KafkaProducer(
                bootstrap_servers=cfg.kafka_bootstrap_servers,
                value_serializer=lambda v: json.dumps(v).encode(),
                key_serializer=lambda k: k.encode() if k else None,
                acks=0,             # fire-and-forget — don't block inference
                retries=0,
                request_timeout_ms=1000,
                connections_max_idle_ms=30000,
            )
            logger.info("Kafka producer connected to %s", cfg.kafka_bootstrap_servers)
            return _producer
        except Exception as exc:
            _kafka_unavailable = True
            logger.debug("Kafka unavailable (%s) — publishing disabled", exc)
            return None


def publish(topic: str, payload: dict, key: str | None = None) -> bool:
    """
    Publish payload to topic. Returns True on success, False if Kafka is
    not available (silently). Never raises.
    """
    producer = _get_producer()
    if producer is None:
        return False
    try:
        payload.setdefault("_ts", datetime.now(timezone.utc).isoformat())
        producer.send(topic, value=payload, key=key)
        return True
    except Exception as exc:
        logger.debug("Kafka publish failed: %s", exc)
        return False


def publish_telemetry(frame: dict) -> bool:
    return publish("battery.telemetry", frame, key=frame.get("cell_id"))


def publish_prediction(result: dict) -> bool:
    return publish("battery.predictions", result, key=result.get("cell_id"))


def publish_alert(alert: dict) -> bool:
    return publish("battery.alerts", alert, key=alert.get("cell_id"))


def start_command_consumer(handler) -> threading.Thread | None:
    """
    Start a background thread that consumes battery.commands topic.
    handler(msg_dict) is called for each message. Returns thread or None.
    """
    from core.config import cfg
    if _kafka_unavailable:
        return None
    try:
        from kafka import KafkaConsumer

        def _consume():
            try:
                consumer = KafkaConsumer(
                    "battery.commands",
                    bootstrap_servers=cfg.kafka_bootstrap_servers,
                    value_deserializer=lambda v: json.loads(v.decode()),
                    auto_offset_reset="latest",
                    group_id="batteryos-backend",
                    consumer_timeout_ms=5000,
                )
                logger.info("Kafka command consumer started")
                for msg in consumer:
                    try:
                        handler(msg.value)
                    except Exception as exc:
                        logger.warning("Command handler error: %s", exc)
            except Exception as exc:
                logger.debug("Kafka consumer failed: %s", exc)

        t = threading.Thread(target=_consume, daemon=True, name="kafka-consumer")
        t.start()
        return t
    except Exception:
        return None


def close() -> None:
    global _producer
    if _producer is not None:
        try:
            _producer.flush(timeout=2)
            _producer.close()
        except Exception:
            pass
        _producer = None

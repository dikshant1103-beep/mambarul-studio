"""
flink_streaming_job.py — PyFlink streaming aggregation job for BatteryOS.

Replaces the pure-Python stream_aggregator.py with a proper Flink job that
can run on a distributed cluster. Does the same work:
  - Reads raw BMS telemetry from Kafka topic `battery.telemetry`
  - Applies a 60-second tumbling window per cell
  - Emits per-window roll-ups (min/max/mean/last for V/I/T/SOC + dQ/dV peak)
  - Writes results to Kafka topic `battery.aggregates`

Run locally (requires Flink + PyFlink installed):
    python scripts/flink_streaming_job.py

Run on a Flink cluster:
    flink run -py scripts/flink_streaming_job.py \
        --pyFiles backend/core/dqdv_extractor.py \
        -D kafka.bootstrap.servers=localhost:9092

Docker deployment: see deploy/flink/docker-compose.flink.yml
"""
from __future__ import annotations

import json
import os
import time


KAFKA_BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")
TOPIC_IN  = "battery.telemetry"
TOPIC_OUT = "battery.aggregates"
WINDOW_S  = 60    # tumbling window width in seconds


def _dqdv_peak(voltages: list[float], currents: list[float]) -> float | None:
    """Compute the dominant dQ/dV peak height from a window's V/I trace."""
    try:
        import sys, os as _os
        _os.path.insert = lambda *a: None   # no-op — import path already set
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
        from core.dqdv_extractor import compute_dqdv_peaks
        result = compute_dqdv_peaks(voltages, currents, [i * 1.0 for i in range(len(voltages))])
        return result.get("dominant_peak_height") if result.get("valid") else None
    except Exception:
        return None


def _agg_window(records: list[dict]) -> dict:
    """Aggregate a list of telemetry records into one summary dict."""
    if not records:
        return {}
    cell_id = records[0].get("cell_id", "unknown")
    ts_first = records[0].get("timestamp", 0)
    ts_last  = records[-1].get("timestamp", 0)

    def _stats(key: str) -> dict:
        vals = [float(r[key]) for r in records if key in r and r[key] is not None]
        if not vals:
            return {"count": 0, "min": None, "max": None, "mean": None, "last": None}
        return {
            "count": len(vals),
            "min":   round(min(vals), 4),
            "max":   round(max(vals), 4),
            "mean":  round(sum(vals) / len(vals), 4),
            "last":  round(vals[-1], 4),
        }

    voltages  = [float(r["voltage"]) for r in records if "voltage" in r]
    currents  = [float(r["current"]) for r in records if "current" in r]

    return {
        "cell_id":    cell_id,
        "window_start": ts_first,
        "window_end":   ts_last,
        "n_records":  len(records),
        "voltage":    _stats("voltage"),
        "current":    _stats("current"),
        "temperature": _stats("temperature"),
        "soc":        _stats("soc"),
        "dqdv_peak":  _dqdv_peak(voltages, currents),
        "emitted_at": time.time(),
    }


def run_pyflink():
    """Run the job using PyFlink (requires pyflink + Flink cluster)."""
    from pyflink.datastream import StreamExecutionEnvironment
    from pyflink.datastream.connectors.kafka import (
        KafkaSource, KafkaSink, KafkaRecordSerializationSchema,
        KafkaOffsetResetStrategy,
    )
    from pyflink.common import WatermarkStrategy, Duration, Types
    from pyflink.common.serialization import SimpleStringSchema
    from pyflink.datastream.window import TumblingEventTimeWindows

    env = StreamExecutionEnvironment.get_execution_environment()
    env.set_parallelism(2)

    source = (
        KafkaSource.builder()
        .set_bootstrap_servers(KAFKA_BOOTSTRAP)
        .set_topics(TOPIC_IN)
        .set_group_id("batteryos-flink-aggregator")
        .set_starting_offsets(KafkaOffsetResetStrategy.LATEST)
        .set_value_only_deserializer(SimpleStringSchema())
        .build()
    )

    sink = (
        KafkaSink.builder()
        .set_bootstrap_servers(KAFKA_BOOTSTRAP)
        .set_record_serializer(
            KafkaRecordSerializationSchema.builder()
            .set_topic(TOPIC_OUT)
            .set_value_serialization_schema(SimpleStringSchema())
            .build()
        )
        .build()
    )

    watermark = WatermarkStrategy.for_bounded_out_of_orderness(
        Duration.of_seconds(5)
    ).with_timestamp_assigner(
        lambda event, _: json.loads(event).get("timestamp", 0) * 1000
    )

    (
        env.from_source(source, watermark, "Kafka-telemetry")
        .map(lambda raw: json.loads(raw), output_type=Types.MAP(Types.STRING(), Types.PICKLED_BYTE_ARRAY()))
        .key_by(lambda r: r.get("cell_id", "unknown"))
        .window(TumblingEventTimeWindows.of(Duration.of_seconds(WINDOW_S)))
        .apply(lambda _key, _window, records: [json.dumps(_agg_window(list(records)))])
        .sink_to(sink)
    )

    env.execute("BatteryOS Streaming Aggregation")


def run_python_fallback():
    """
    Pure-Python fallback (no Flink required) — same logic as core/stream_aggregator.py
    but wired to Kafka directly via kafka-python. Use this for development/testing.
    """
    try:
        from kafka import KafkaConsumer, KafkaProducer
    except ImportError:
        print("kafka-python not installed. Run: pip install kafka-python")
        return

    consumer = KafkaConsumer(
        TOPIC_IN,
        bootstrap_servers=KAFKA_BOOTSTRAP,
        value_deserializer=lambda b: json.loads(b),
        auto_offset_reset="latest",
        group_id="batteryos-python-aggregator",
    )
    producer = KafkaProducer(
        bootstrap_servers=KAFKA_BOOTSTRAP,
        value_serializer=lambda v: json.dumps(v).encode(),
    )

    windows: dict[str, list[dict]] = {}
    window_starts: dict[str, float] = {}

    print(f"[flink_fallback] listening on {TOPIC_IN} (window={WINDOW_S}s)")
    for msg in consumer:
        record = msg.value
        cid = record.get("cell_id", "unknown")
        now = time.time()

        if cid not in window_starts:
            window_starts[cid] = now
            windows[cid] = []

        windows[cid].append(record)

        if now - window_starts[cid] >= WINDOW_S:
            agg = _agg_window(windows[cid])
            producer.send(TOPIC_OUT, agg)
            print(f"  [{cid}] window emitted: n={agg['n_records']} "
                  f"v_mean={agg['voltage'].get('mean')}")
            windows[cid] = []
            window_starts[cid] = now


if __name__ == "__main__":
    import sys
    mode = sys.argv[1] if len(sys.argv) > 1 else "auto"
    if mode == "flink":
        run_pyflink()
    elif mode == "python":
        run_python_fallback()
    else:
        # Auto: try PyFlink, fall back to Python consumer
        try:
            import pyflink  # noqa: F401
            print("[flink_job] PyFlink available — running on Flink runtime")
            run_pyflink()
        except ImportError:
            print("[flink_job] PyFlink not installed — using Python fallback")
            run_python_fallback()

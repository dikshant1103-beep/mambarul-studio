"""
Unit + integration tests for the stateful tumbling-window stream aggregator
(the Kafka-Streams / Flink role). Deterministic — event time is injected.
"""
from core.stream_aggregator import StreamAggregator


def _frame(v, i=-2.0, t=25.0, soc=80.0, cyc=1):
    return {"voltage": v, "current": i, "temperature": t, "soc": soc, "cycle_num": cyc}


def test_window_closes_on_boundary_and_aggregates():
    emitted = []
    agg = StreamAggregator(window_seconds=60, emit=emitted.append)

    # window [0,60): three frames with known voltages
    assert agg.add("c1", _frame(3.6, cyc=1), now=0)  is None
    assert agg.add("c1", _frame(3.7, cyc=1), now=20) is None
    assert agg.add("c1", _frame(3.8, cyc=2), now=50) is None

    # crossing into window [60,120) closes the first window
    closed = agg.add("c1", _frame(3.5, cyc=3), now=60)
    assert closed is not None
    assert closed["cell_id"] == "c1"
    assert closed["n_frames"] == 3
    assert closed["cycle_start"] == 1 and closed["cycle_end"] == 2
    vf = closed["fields"]["voltage"]
    assert vf["min"] == 3.6 and vf["max"] == 3.8
    assert vf["mean"] == round((3.6 + 3.7 + 3.8) / 3, 4)
    assert vf["last"] == 3.8 and vf["n"] == 3
    # the close was emitted exactly once
    assert len(emitted) == 1 and emitted[0]["n_frames"] == 3


def test_flush_due_closes_open_window():
    agg = StreamAggregator(window_seconds=60)
    agg.add("c1", _frame(3.7), now=10)
    # nothing closed yet
    assert agg.recent("c1") == []
    # wall clock past window end → flush closes it
    out = agg.flush_due(now=61)
    assert len(out) == 1 and out[0]["n_frames"] == 1
    assert len(agg.recent("c1")) == 1


def test_multi_cell_isolation_and_state():
    agg = StreamAggregator(window_seconds=30)
    for k in range(3):
        agg.add("a", _frame(3.6 + k * 0.1), now=k * 5)
        agg.add("b", _frame(4.0), now=k * 5)
    agg.flush_due(now=100)
    ra = agg.recent("a"); rb = agg.recent("b")
    assert len(ra) == 1 and len(rb) == 1
    assert ra[0]["fields"]["voltage"]["n"] == 3
    st = agg.get_state()
    assert st["windows_emitted"] == 2
    assert st["window_seconds"] == 30


def test_missing_fields_skipped():
    agg = StreamAggregator(window_seconds=60)
    agg.add("c1", {"voltage": 3.7}, now=0)       # only voltage
    agg.add("c1", {"temperature": 30.0}, now=10)  # only temp
    out = agg.flush_due(now=61)[0]
    assert out["fields"]["voltage"]["n"] == 1
    assert out["fields"]["temperature"]["n"] == 1
    assert "current" not in out["fields"]


# ── Integration: HTTP telemetry → aggregator state ─────────────────────────────

def test_dqdv_peaks_from_voltage_ramp():
    """compute_dqdv_peaks should find a peak on a discharge with real voltage span."""
    import numpy as np
    from core.dqdv_extractor import compute_dqdv_peaks
    t = np.arange(0, 300, 5.0)
    v = 4.1 - 1.0 * (t / t.max())          # 4.1 → 3.1 V ramp
    i = np.full_like(t, -2.0)               # 2 A discharge
    r = compute_dqdv_peaks(v, i, t)
    assert r["valid"] is True
    assert 3.0 <= r["peak_voltage"] <= 4.1
    assert r["peak_dqdv"] > 0


def test_dqdv_rejects_flat_window():
    import numpy as np
    from core.dqdv_extractor import compute_dqdv_peaks
    t = np.arange(0, 60, 5.0)
    v = np.full_like(t, 3.70)               # no voltage span
    i = np.full_like(t, -2.0)
    assert compute_dqdv_peaks(v, i, t)["valid"] is False


def test_aggregator_window_includes_dqdv():
    agg = StreamAggregator(window_seconds=60)
    # frames spanning a voltage ramp within one window, then cross the boundary
    for k in range(11):
        agg.add("c1", {"voltage": 4.1 - 0.08 * k, "current": -2.0,
                       "temperature": 25.0, "soc": 90 - k}, now=k * 5)
    closed = agg.add("c1", {"voltage": 3.2, "current": -2.0}, now=60)
    assert closed is not None
    assert "dqdv" in closed
    assert closed["dqdv"]["valid"] is True
    assert closed["dqdv"]["peak_voltage"] > 0


def test_streaming_status_exposes_aggregation(client, auth_headers):
    # push frames via the simulator → they flow into the aggregator
    r = client.post("/api/bms/simulate", headers=auth_headers, json={
        "cell_id": "agg_itest", "voltage": 3.75, "current": -2.0,
        "temperature": 28.0, "chemistry": "NMC", "capacity_ah": 1.1, "count": 15,
    })
    assert r.status_code == 200

    s = client.get("/api/rul/streaming/status", headers=auth_headers)
    assert s.status_code == 200
    agg = s.json().get("aggregation")
    assert agg is not None
    assert "window_seconds" in agg and agg["window_seconds"] > 0
    assert agg["cells_tracked"] >= 1

    a = client.get("/api/rul/streaming/aggregates", headers=auth_headers)
    assert a.status_code == 200
    assert "aggregates" in a.json()

"""tests for core/replay_buffer.py (cross-cell experience replay)."""
import numpy as np
import pytest


def _w():
    return np.random.randn(30, 13).astype(np.float32)


def test_add_and_sample_roundtrip():
    from core import replay_buffer as rb
    rb.clear()
    for i in range(20):
        rb.add(_w(), float(0.5 + 0.01 * i), chem_code=i % 5, cell_id=f"c{i}")
    s = rb.status()
    assert s["size"] == 20
    assert s["n_seen_total"] >= 20
    out = rb.sample(8)
    assert out is not None
    X, y, c = out
    assert X.shape == (8, 30, 13)
    assert y.shape == (8, 1)
    assert c.shape == (8,)


def test_reject_wrong_shape():
    from core import replay_buffer as rb
    rb.clear()
    rb.add(np.zeros((10, 13), dtype=np.float32), 0.5, 1)  # wrong T
    rb.add(np.zeros((30, 9),  dtype=np.float32), 0.5, 1)  # wrong F
    assert rb.status()["size"] == 0


def test_reservoir_capacity_capped():
    from core import replay_buffer as rb
    rb.clear()
    cap = rb.RESERVOIR_SIZE
    for i in range(cap + 50):
        rb.add(_w(), 0.5, chem_code=1, cell_id=f"c{i}")
    assert rb.status()["size"] == cap
    assert rb.status()["n_seen_total"] == cap + 50


def test_sample_when_empty_returns_none():
    from core import replay_buffer as rb
    rb.clear()
    assert rb.sample(4) is None


def test_persist_and_reload(tmp_path, monkeypatch):
    from core import replay_buffer as rb
    monkeypatch.setattr(rb, "_BUF_DIR",  tmp_path)
    monkeypatch.setattr(rb, "_BUF_PATH", tmp_path / "buffer.npz")
    rb.clear()
    for i in range(7):
        rb.add(_w(), float(i) / 10.0, chem_code=2, cell_id=f"cell_{i}")
    rb.persist()
    rb.clear()
    assert rb.status()["size"] == 0
    n = rb.load()
    assert n == 7
    assert rb.status()["size"] == 7

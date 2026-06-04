"""tests for core/thermal_coupling_lstm.py — LSTM + cross-cell attention."""
import numpy as np
import pytest

torch = pytest.importorskip("torch")


def _trace(N=3, T=8, base=25.0):
    t = np.arange(T) * 0.3
    arr = base + np.outer(np.linspace(0.5, 1.5, N), t)   # rising at different rates
    return arr.tolist()


def test_predict_pack_shapes():
    from core.thermal_coupling_lstm import predict_pack
    res = predict_pack(_trace(N=4, T=10), cell_ids=["a", "b", "c", "d"])
    assert res["n_cells"] == 4
    assert len(res["predictions"]) == 4
    for p in res["predictions"]:
        assert {"cell_id", "current_t", "predicted_t", "delta_t",
                "coupling_score"} <= set(p)


def test_predict_pack_returns_attention_matrix():
    from core.thermal_coupling_lstm import predict_pack
    res = predict_pack(_trace(N=3, T=6))
    attn = np.array(res["attention"])
    assert attn.shape == (3, 3)
    assert np.allclose(attn.sum(axis=1), 1.0, atol=1e-4)  # softmax rows


def test_predict_untrained_mode_tagged():
    from core.thermal_coupling_lstm import predict_pack, _CKPT_PATH
    # Note: relies on no checkpoint present
    if _CKPT_PATH.exists():
        pytest.skip("trained checkpoint present — untrained-mode test n/a")
    res = predict_pack(_trace())
    assert res["mode"] == "untrained"


def test_train_smoke(tmp_path, monkeypatch):
    from core.thermal_coupling_lstm import train_on_pack_traces, _CKPT_PATH
    ckpt = tmp_path / "ckpt.pt"
    traces = [{"temperatures": _trace(N=3, T=8, base=25.0 + 0.5 * i)}
              for i in range(6)]
    r = train_on_pack_traces(traces, epochs=2, batch_size=2, out_path=ckpt)
    assert ckpt.exists()
    assert r["meta"]["epochs"] == 2
    assert r["history"][-1]["loss"] >= 0.0

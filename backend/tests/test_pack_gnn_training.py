"""
Tests for the Pack-GNN training loop (core/pack_gnn_trainer.py) and the
admin training/status endpoints. Self-contained — synthesizes pack-sim sample
JSONs, so it does not depend on the liionpack-generated files.
"""
import json

import pytest
import torch


def _write_samples(d, n=6):
    """Write n synthetic packsim_*.json samples (4-cell series-parallel packs)."""
    import numpy as np
    rng = np.random.default_rng(0)
    for k in range(n):
        cur = 1.0 + rng.uniform(-0.05, 0.05, size=4)
        vmin = 3.3 - (cur - 1.0) * 0.8 + rng.uniform(-0.01, 0.01, size=4)
        cells = [{
            "cell_id": f"c{i}", "ri": 0.05 * (1 + 0.2 * (cur[i] - 1)),
            "v_mean": 3.6, "v_min": float(vmin[i]), "v_spread": 0.3,
            "current_share": float(cur[i]), "charge_throughput_ah": 0.05,
        } for i in range(4)]
        sample = {
            "sample_id": f"syn{k:03d}", "topology": "series-parallel",
            "n_series": 2, "n_parallel": 2, "n_cells": 4,
            "v_min_pack": float(vmin.min()),
            "edges": [[0, 1], [0, 2], [1, 3], [2, 3]], "cells": cells,
        }
        (d / f"packsim_syn{k:03d}.json").write_text(json.dumps(sample))


def test_trainer_produces_loadable_checkpoint(tmp_path):
    from core.pack_gnn_trainer import train_pack_gnn
    from core.pack_gnn import PackGraphSAGE

    data = tmp_path / "pack_sim"; data.mkdir()
    _write_samples(data, n=8)
    out = tmp_path / "ckpt.pt"

    m = train_pack_gnn(data_dir=data, epochs=40, out_path=out, production=False)
    assert m["ok"] is True
    assert m["params"] == 19521          # matches production PackGraphSAGE arch
    assert m["n_samples"] == 8
    assert out.exists()

    # loss should improve from first to last epoch
    assert m["history"][-1]["train_loss"] <= m["history"][0]["train_loss"]

    # checkpoint must load back into the model the app serves
    ck = torch.load(str(out), weights_only=False)
    assert ck["source"] == "pack_sim"
    mdl = PackGraphSAGE(d_hidden=ck["d_hidden"], n_layers=ck["n_layers"])
    mdl.load_state_dict(ck["model_state_dict"])


def test_trainer_raises_on_empty_dir(tmp_path):
    from core.pack_gnn_trainer import train_pack_gnn
    empty = tmp_path / "empty"; empty.mkdir()
    with pytest.raises(ValueError):
        train_pack_gnn(data_dir=empty, epochs=5)


def test_pack_gnn_status_endpoint(client, auth_headers):
    r = client.get("/api/predict/pack-gnn/status", headers=auth_headers)
    assert r.status_code == 200
    d = r.json()
    assert d["status"] in ("gnn_loaded", "physics_prior")
    assert "checkpoint" in d


def test_pack_gnn_train_status_endpoint(client, auth_headers):
    r = client.get("/api/predict/pack-gnn/train/status", headers=auth_headers)
    assert r.status_code == 200
    assert "state" in r.json()

"""
Tests for core/pack_sim_loader.py — the main-backend side of the pack-sim
pipeline (reads liionpack sample JSON → Pack-GNN training arrays). Runs entirely
in the main env (no liionpack / no old pybamm).
"""
import json

import numpy as np

from core.pack_sim_loader import (
    load_pack_sim_samples, derive_target_delta, to_training_arrays, build_dataset,
)


def _sample() -> dict:
    # 2P × 2S = 4 cells. c1 is the stressed cell: highest current share + lowest v_min.
    return {
        "sample_id": "test123",
        "topology": "series-parallel",
        "n_series": 2, "n_parallel": 2, "n_cells": 4,
        "v_min_pack": 3.10,
        "edges": [[0, 1], [0, 2], [1, 3], [2, 3]],
        "cells": [
            {"cell_id": "c0", "ri": 0.050, "v_mean": 3.60, "v_min": 3.30, "v_spread": 0.30, "current_share": 1.0, "charge_throughput_ah": 0.050},
            {"cell_id": "c1", "ri": 0.062, "v_mean": 3.50, "v_min": 3.10, "v_spread": 0.40, "current_share": 1.4, "charge_throughput_ah": 0.070},
            {"cell_id": "c2", "ri": 0.048, "v_mean": 3.62, "v_min": 3.35, "v_spread": 0.27, "current_share": 0.9, "charge_throughput_ah": 0.045},
            {"cell_id": "c3", "ri": 0.051, "v_mean": 3.58, "v_min": 3.28, "v_spread": 0.30, "current_share": 1.0, "charge_throughput_ah": 0.050},
        ],
    }


def test_derive_target_delta_range_and_worst_cell():
    d = derive_target_delta(_sample())
    assert d.shape == (4,)
    assert np.all(d >= -0.4) and np.all(d <= 0.4)
    # c1 (highest current share, lowest v_min) must age fastest → most negative δ
    assert int(np.argmin(d)) == 1
    # zero-mean construction → deltas roughly balance
    assert abs(float(d.sum())) < 0.2


def test_to_training_arrays_shapes():
    x, adj, y = to_training_arrays(_sample())
    assert tuple(x.shape) == (4, 9)        # NODE_DIM = 9
    assert tuple(adj.shape) == (4, 4)
    assert tuple(y.shape) == (4,)


def test_load_and_build_dataset(tmp_path):
    d = tmp_path / "pack_sim"
    d.mkdir()
    (d / "packsim_test123.json").write_text(json.dumps(_sample()))
    samples = load_pack_sim_samples(d)
    assert len(samples) == 1 and samples[0]["sample_id"] == "test123"
    ds = build_dataset(d)
    assert len(ds) == 1
    assert ds[0]["n_cells"] == 4
    assert tuple(ds[0]["x"].shape) == (4, 9)
    assert tuple(ds[0]["y"].shape) == (4,)


def test_empty_dir_returns_nothing(tmp_path):
    assert load_pack_sim_samples(tmp_path) == []
    assert build_dataset(tmp_path) == []

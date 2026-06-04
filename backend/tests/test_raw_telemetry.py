"""
Tests for the unified raw-telemetry (V/I/T) ingestion layer:
core/raw_telemetry.py + POST /api/ingest/raw.
"""
import numpy as np

from core.raw_telemetry import raw_to_cycle_dataframe


def _raw_csv(n_cycles=30, with_cycle_col=True, milli=False, nom=2.0) -> bytes:
    """Synthetic raw V/I/T with fading capacity. Optionally mA + cycle column."""
    # mA is detected from the column NAME, so use a unit-tagged header when milli
    cur_col = "current(mA)" if milli else "current"
    hdr = f"time,voltage,{cur_col},temperature" + (",cycle" if with_cycle_col else "")
    lines = [hdr]
    t = 0.0
    for cyc in range(1, n_cycles + 1):
        cap_frac = 1.0 - (cyc - 1) * 0.005
        npts = 20
        for k in range(npts):
            v = 4.1 - 1.0 * (k / (npts - 1))
            cur = -(cap_frac * nom) * 3600 / (npts * 30)     # A, integrates to ~cap_frac*nom Ah
            if milli:
                cur *= 1000.0
            row = f"{t:.1f},{v:.4f},{cur:.5f},25.0"
            if with_cycle_col:
                row += f",{cyc}"
            lines.append(row); t += 30
    return "\n".join(lines).encode()


def test_raw_to_cycle_dataframe_coulomb_counting():
    df, meta = raw_to_cycle_dataframe(_raw_csv(30, nom=2.0), nom_capacity_ah=2.0)
    assert meta["n_cycles"] == 30
    assert meta["cycle_source"] == "cycle_column"
    # first cycle capacity Coulomb-counted from V/I/T (no capacity column) — in the
    # right ballpark of nominal (exact value depends on sampling density)
    assert 1.5 < df["capacity"].iloc[0] < 2.1
    # capacity fades over cycles
    assert df["capacity"].iloc[0] > df["capacity"].iloc[-1]
    # required engineered columns are present
    for c in ("cycle", "capacity", "voltage_mean", "int_resistance", "energy", "temperature"):
        assert c in df.columns


def test_raw_mA_converted_to_A():
    df, meta = raw_to_cycle_dataframe(_raw_csv(20, milli=True, nom=2.0), nom_capacity_ah=2.0)
    # despite mA input, capacity comes out in Ah (~2.0), not 2000
    assert df["capacity"].iloc[0] < 5.0


def test_raw_segments_without_cycle_column():
    df, meta = raw_to_cycle_dataframe(_raw_csv(10, with_cycle_col=False, nom=2.0), nom_capacity_ah=2.0)
    assert meta["cycle_source"] == "current_sign_segmentation"
    assert meta["n_cycles"] >= 1


def test_raw_missing_current_rejected():
    bad = b"time,voltage,temperature\n0,3.7,25\n1,3.6,25\n2,3.5,25\n"
    try:
        raw_to_cycle_dataframe(bad, nom_capacity_ah=2.0)
        assert False, "should have raised"
    except ValueError:
        pass


def test_ingest_raw_endpoint(client, auth_headers):
    r = client.post("/api/ingest/raw", headers=auth_headers,
                    files={"file": ("raw.csv", _raw_csv(35, nom=2.0), "text/csv")},
                    data={"nom_capacity_ah": "2.0", "chemistry": "auto"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert "raw_extraction" in d
    assert d["raw_extraction"]["n_cycles"] == 35
    assert len(d["predictions"]) == 35
    assert d["summary"]["soh_final_pct"] < d["summary"]["soh_initial_pct"]


def _multicell_raw_csv(n_cells=3, n_cycles=15, nom=2.0) -> bytes:
    """Synthetic raw CSV with cell_id, each cell at a different fade rate."""
    lines = ["time,voltage,current,temperature,cycle,cell_id"]
    for c in range(n_cells):
        cid = f"cell_{c + 1:02d}"
        fade_per_cyc = 0.004 * (c + 1)              # cell 1 fades slow, cell N fast
        t = 0.0
        for cyc in range(1, n_cycles + 1):
            cap_frac = max(0.6, 1.0 - (cyc - 1) * fade_per_cyc)
            npts = 20
            for k in range(npts):
                v = 4.1 - 1.0 * (k / (npts - 1))
                cur = -(cap_frac * nom) * 3600 / (npts * 30)
                lines.append(f"{t:.1f},{v:.4f},{cur:.5f},25.0,{cyc},{cid}")
                t += 30
    return "\n".join(lines).encode()


def test_raw_to_fleet_dataframes_returns_per_cell():
    from core.raw_telemetry import raw_to_fleet_dataframes
    dfs, meta = raw_to_fleet_dataframes(_multicell_raw_csv(3, 12), nom_capacity_ah=2.0)
    assert meta["n_cells"] == 3
    assert set(dfs.keys()) == {"cell_01", "cell_02", "cell_03"}
    # cell_03 fades fastest → smallest final capacity
    finals = {cid: float(df["capacity"].iloc[-1]) for cid, df in dfs.items()}
    assert finals["cell_03"] < finals["cell_01"]


def test_ingest_raw_fleet_endpoint(client, auth_headers):
    r = client.post("/api/ingest/raw/fleet", headers=auth_headers,
                    files={"file": ("multi.csv", _multicell_raw_csv(3, 12), "text/csv")},
                    data={"nom_capacity_ah": "2.0", "chemistry": "auto"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["fleet_summary"]["n_cells"] == 3
    assert len(d["cells"]) == 3
    # weakest cell should be cell_03 (highest fade rate)
    assert d["fleet_summary"]["weak_cell"] == "cell_03"
    # each cell has its own predictions array
    for c in d["cells"]:
        assert c["n_cycles"] >= 1
        assert isinstance(c["predictions"], list) and c["predictions"]


def test_ingest_engineered_still_works(client, auth_headers):
    """Refactor guard: the original /api/ingest (engineered CSV) must still work."""
    lines = ["cycle,capacity"] + [f"{i+1},{1.1 - i*0.002:.4f}" for i in range(40)]
    r = client.post("/api/ingest", headers=auth_headers,
                    files={"file": ("eng.csv", "\n".join(lines).encode(), "text/csv")})
    assert r.status_code == 200, r.text
    assert len(r.json()["predictions"]) == 40

"""
Tests for the LIMS/MES cycler import adapter (core/lims_adapter.py + /api/lims/import).
Synthesizes Arbin-style (Ah) and Neware-style (mAh) exports.
"""
from core.lims_adapter import parse_lims_csv, detect_format


def _arbin_csv(n_cycles=5) -> bytes:
    rows = ["Test_Time(s),Cycle_Index,Current(A),Voltage(V),Discharge_Capacity(Ah)"]
    t = 0.0
    for cyc in range(1, n_cycles + 1):
        cap = 1.10 - (cyc - 1) * 0.01           # fade 0.01 Ah/cycle
        for k in range(6):
            v = 4.1 - 0.1 * k
            rows.append(f"{t:.1f},{cyc},-2.0,{v:.3f},{cap * (k + 1) / 6:.5f}")
            t += 30
    return "\n".join(rows).encode()


def _neware_csv(n_cycles=4) -> bytes:
    # Neware reports mAh — adapter must convert to Ah
    rows = ["Record ID,Cycle,Current(mA),Voltage(V),Capacity(mAh)"]
    rid = 0
    for cyc in range(1, n_cycles + 1):
        cap_mah = 1100 - (cyc - 1) * 10          # mAh
        for k in range(6):
            rows.append(f"{rid},{cyc},-2000,{4.1 - 0.1 * k:.3f},{cap_mah * (k + 1) / 6:.2f}")
            rid += 1
    return "\n".join(rows).encode()


def test_detect_arbin():
    assert detect_format(["Test_Time(s)", "Cycle_Index", "Current(A)", "Voltage(V)", "Discharge_Capacity(Ah)"]) == "arbin"


def test_parse_arbin_capacity_fade():
    r = parse_lims_csv(_arbin_csv(5))
    assert r["format"] == "arbin"
    assert r["n_cycles"] == 5
    assert r["capacity_unit"] == "Ah"
    caps = [c["discharge_capacity_ah"] for c in r["cycles"]]
    assert caps[0] > caps[-1]                    # capacity fades
    assert abs(caps[0] - 1.10) < 0.02
    # SOH trajectory normalized to first cycle
    assert r["soh_trajectory"][0]["soh"] == 1.0
    assert r["soh_trajectory"][-1]["soh"] < 1.0
    assert r["normalized_csv"].startswith("cycle,capacity")


def test_parse_neware_mah_converted_to_ah():
    r = parse_lims_csv(_neware_csv(4))
    assert r["format"] == "neware"
    assert r["capacity_unit"] == "mAh→Ah"
    # 1100 mAh → ~1.1 Ah
    assert abs(r["cycles"][0]["discharge_capacity_ah"] - 1.10) < 0.02


def test_import_endpoint(client, auth_headers):
    r = client.post("/api/lims/import", headers=auth_headers,
                    files={"file": ("arbin.csv", _arbin_csv(6), "text/csv")})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["format"] == "arbin"
    assert d["n_cycles"] == 6
    assert len(d["soh_trajectory"]) == 6


def test_lims_imports_persisted_and_listable(client, auth_headers):
    """Importing a cycler file persists it; /lims/imports returns it + fade aggregates."""
    r = client.post("/api/lims/import", headers=auth_headers,
                    files={"file": ("arbin_a.csv", _arbin_csv(8), "text/csv")})
    assert r.status_code == 200
    assert "import_id" in r.json()

    r2 = client.get("/api/lims/imports", headers=auth_headers)
    assert r2.status_code == 200
    d = r2.json()
    assert d["summary"]["n_imports"] >= 1
    # the file we just uploaded should be in the list
    assert any(row["filename"] == "arbin_a.csv" for row in d["imports"])
    # fade-rate aggregates exist when there's at least one valid fade
    if d["summary"]["mean_fade"] is not None:
        assert d["summary"]["min_fade"] <= d["summary"]["mean_fade"] <= d["summary"]["max_fade"]


def test_import_rejects_bad_csv(client, auth_headers):
    r = client.post("/api/lims/import", headers=auth_headers,
                    files={"file": ("bad.csv", b"foo,bar\n1,2\n", "text/csv")})
    assert r.status_code == 422

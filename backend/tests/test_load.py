"""
Load / concurrency tests — confirm the prediction path and DB-backed endpoints
stay correct and don't deadlock under concurrent requests (the inference model
and SQLite/WAL connection layer are shared across threads).
"""
import concurrent.futures as cf
import time


def test_concurrent_predict_no_5xx_and_deterministic(client, auth_headers):
    """Under burst load: no server errors / deadlock, served results are correct
    and deterministic, and the rate limiter (429) engages gracefully."""
    def one(_):
        r = client.post("/api/predict", headers=auth_headers, json={
            "chemistry": "NMC", "soh": 0.85, "model_id": "v10-final",
            "capacity_ah": 1.1, "temperature_c": 25.0,
        })
        return r.status_code, (r.json().get("predicted_rul") if r.status_code == 200 else None)

    t0 = time.time()
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(one, range(40)))
    elapsed = time.time() - t0

    codes = [s for s, _ in results]
    assert all(s < 500 for s in codes), f"server error under load: {codes}"   # no 5xx / deadlock
    assert all(s in (200, 429) for s in codes), f"unexpected codes: {set(codes)}"
    served = [p for s, p in results if s == 200]
    assert served, "rate limiter blocked everything — unexpected"
    assert all(p is not None and p >= 0 for p in served)
    assert len(set(served)) == 1, f"non-deterministic under concurrency: {set(served)}"
    assert elapsed < 60, f"40 concurrent predicts took {elapsed:.1f}s (possible contention)"


def test_concurrent_grade_no_5xx(client, auth_headers):
    def grade(_):
        return client.post("/api/grade", headers=auth_headers, json={
            "label": "L", "chemistry": "LFP", "soh_pct": 84.0,
            "predicted_rul": 500, "n_cycles": 400, "capacity_ah": 1.1,
        }).status_code

    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        codes = list(ex.map(grade, range(30)))
    assert all(c < 500 for c in codes), f"server error under load: {codes}"
    assert any(c == 200 for c in codes)


def test_concurrent_db_writes_consistent(client, auth_headers):
    """Concurrent predicts log analytics calls via the shared SQLite/WAL layer;
    no 5xx, and the analytics read stays coherent afterwards."""
    def one(_):
        return client.post("/api/predict", headers=auth_headers, json={
            "chemistry": "LFP", "soh": 0.80, "model_id": "v10-final",
            "capacity_ah": 1.1, "temperature_c": 25.0,
        }).status_code

    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        codes = list(ex.map(one, range(24)))
    assert all(c < 500 for c in codes), f"server error / DB lock under load: {codes}"

    r = client.get("/api/analytics/summary", headers=auth_headers)
    assert r.status_code == 200
    d = r.json()
    assert d["total_predictions"] >= 0
    assert isinstance(d.get("daily_counts"), list)

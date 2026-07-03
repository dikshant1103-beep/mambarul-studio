# BatteryOS Python SDK

Zero-dependency Python client for the BatteryOS API. Requires Python 3.8+.

## Installation

Copy `batteryos_sdk.py` into your project, or install it as a local package:

```bash
pip install -e /path/to/mambaRUL_studio/sdk
```

## Quick start

```python
from batteryos_sdk import BatteryOSClient

client = BatteryOSClient(
    base_url="https://your-batteryos-instance.io",
    api_key="bos_your_key_here",
)

# Single-cell prediction
result = client.predict(cap_pct=0.85, chemistry="NMC", temperature=25.0)
print(f"RUL: {result['rul_cycles']} cycles  [{result['ci_low']}–{result['ci_high']}]")
print(f"SOH: {result['soh_pct']:.1f}%  Phase: {result['phase']}")
```

## Authentication

Set `BATTERYOS_API_KEY` in your environment, or pass `api_key=` explicitly:

```bash
export BATTERYOS_API_KEY=bos_xxx...
```

## Core methods

### `predict(cap_pct, chemistry, **kwargs) → dict`

Single-cell RUL. Optional kwargs: `temperature`, `int_resistance`, `capacity`,
`voltage`, `current`, `cycle_number`, `dod_pct`, `model_id`, `cell_id`.

```python
result = client.predict(
    cap_pct=0.72,
    chemistry="LFP",
    temperature=35.0,
    dod_pct=80.0,
    model_id="v10-final",
)
```

Returns `{rul_cycles, ci_low, ci_high, soh_pct, phase, model_id}`.

### `predict_pack(cells, topology, model_id) → dict`

Pack-level aggregated RUL.

```python
result = client.predict_pack(
    cells=[
        {"cap_pct": 0.90, "chemistry": "NMC", "cell_id": "S1"},
        {"cap_pct": 0.85, "chemistry": "NMC", "cell_id": "S2"},
    ],
    topology="series",   # "series" | "parallel" | "series-parallel"
)
```

### `batch(cells, model_id) → list[dict]`

Up to 500 cells in one call.

```python
results = client.batch([
    {"cell_id": "A1", "cap_pct": 0.90, "chemistry": "NMC"},
    {"cell_id": "A2", "cap_pct": 0.72, "chemistry": "LFP", "temperature": 35.0},
])
for r in results:
    print(r["cell_id"], r["rul_cycles"])
```

### `batch_csv(csv_path, model_id) → dict`

Upload a CSV file and run batch prediction.

```python
results = client.batch_csv("fleet_snapshot.csv")
```

CSV columns: `cell_id`, `cap_pct`, `chemistry` (required) + optional feature columns.

### Fine-tuning

```python
# Start a fine-tune job
job_id = client.finetune_start(
    "my_training_data.csv",
    chemistry="LFP",
    epochs=100,
)

# Poll until done
final = client.finetune_wait(job_id)
print(final["status"], final.get("output_path"))
```

CSV columns for training: `cell_id`, `cap_pct`, `rul` (required) + optional features.

## Error handling

```python
from batteryos_sdk import BatteryOSClient, BatteryOSError

try:
    result = client.predict(cap_pct=0.85, chemistry="NMC")
except BatteryOSError as e:
    print(f"API error {e.status}: {e.detail}")
```

## Rate limits & quotas

The server enforces per-key rate limits (60 req/min by default) and optional monthly
quotas. Exceeded limits return HTTP 429; the SDK raises `BatteryOSError(429, ...)`.

## Environment variables

| Variable | Description |
|---|---|
| `BATTERYOS_API_KEY` | API key (alternative to passing `api_key=`) |
| `BATTERYOS_BASE_URL` | Override base URL |

# WarrantyLens Battery Health Report (BHR) Export

`export_battery_health_report.py` is an **additive** bridge between BatteryOS and
the WarrantyLens warranty platform. It does **not** modify any BatteryOS code or
data — it is a standalone consumer of the existing `batteryos_sdk` that writes a
JSON report WarrantyLens imports.

## Run
```bash
export BATTERYOS_API_KEY=bos_...        # if the API requires a key
python scripts/export_battery_health_report.py \
    --vin 1HGBH41JXMN109186 --cap-pct 0.78 --chemistry NMC --temperature 30 \
    --pack-id PK-2231 \
    --abuse frequent_hot_fast_charge,deep_discharge \
    --out battery_health_report.json
```
- Needs the BatteryOS API running (default `http://localhost:8000`) for real
  SoH/RUL via `BatteryOSClient.predict()`.
- If the API is unreachable, SoH is derived from `--cap-pct` and RUL is left null
  (noted in the file) so a report is still produced.

## Consume in WarrantyLens
Open the claim → **Attach battery report** → upload the JSON. WarrantyLens parses
SoH/RUL/faults/abuse, derives a defect-vs-abuse leaning, and folds it into the
unified warranty verdict.

## Contract (BHR v1.0)
```json
{
  "schema_version": "1.0", "source": "BatteryOS", "generated_at": "...",
  "vehicle": {"vin": "...", "pack_id": "..."}, "chemistry": "NMC",
  "soh_percent": 78.0, "rul": {"cycles": 640, "ci_low": 520, "ci_high": 770},
  "capacity_fade_percent": 22.0, "charging": {...},
  "faults": [{"code":"...","severity":"high"}],
  "abuse_indicators": ["frequent_hot_fast_charge"]
}
```

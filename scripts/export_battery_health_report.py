"""Export a Battery Health Report (BHR) for WarrantyLens.

ADDITIVE bridge — this is a standalone consumer of the existing BatteryOS Python
SDK. It does NOT modify any BatteryOS code or data; it only READS predictions and
writes a JSON file that the WarrantyLens warranty platform imports and attaches to
a claim.

Usage
-----
    # Against a running BatteryOS API:
    export BATTERYOS_API_KEY=bos_...
    python export_battery_health_report.py --vin 1HGBH41JXMN109186 \
        --cap-pct 0.78 --chemistry NMC --temperature 30 \
        --pack-id PK-2231 --abuse frequent_hot_fast_charge,deep_discharge \
        --out battery_health_report.json

    # If the BatteryOS API is not reachable, SoH is derived from --cap-pct and
    # RUL is left null (clearly noted in the output).

The resulting JSON is uploaded in WarrantyLens via:
    Claim → "Attach battery report"
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

# Use BatteryOS's OWN SDK (no WarrantyLens dependency).
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk"))
from batteryos_sdk import BatteryOSClient, BatteryOSError  # noqa: E402

SCHEMA_VERSION = "1.0"


def _csv_list(v: str | None) -> list[str]:
    return [x.strip() for x in v.split(",") if x.strip()] if v else []


def build_report(args) -> dict:
    rul: dict = {}
    soh_percent: float | None = None
    note = None

    client = BatteryOSClient(base_url=args.api_url, api_key=args.api_key)
    try:
        client.health()
        res = client.predict(
            cap_pct=args.cap_pct, chemistry=args.chemistry, temperature=args.temperature
        )
        soh_percent = res.get("soh_pct")
        rul = {
            "cycles": res.get("rul_cycles"),
            "ci_low": res.get("ci_low"),
            "ci_high": res.get("ci_high"),
            "confidence": res.get("confidence"),
        }
        model = {"model_id": res.get("model_id"), "phase": res.get("phase")}
    except (BatteryOSError, OSError, Exception) as exc:  # noqa: BLE001
        # Non-breaking fallback so a report is still produced for review.
        soh_percent = round(args.cap_pct * 100, 1)
        model = {"model_id": None, "phase": None}
        note = (
            f"BatteryOS API unreachable ({str(exc)[:80]}); SoH derived from capacity, "
            "RUL unavailable."
        )

    fade = round(100 - soh_percent, 1) if soh_percent is not None else None

    report = {
        "schema_version": SCHEMA_VERSION,
        "source": "BatteryOS",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "vehicle": {"vin": args.vin.upper(), "pack_id": args.pack_id},
        "chemistry": args.chemistry,
        "soh_percent": soh_percent,
        "rul": rul,
        "capacity_fade_percent": fade,
        "charging": {
            "avg_charge_temp_c": args.temperature,
        },
        "faults": json.loads(args.faults) if args.faults else [],
        "abuse_indicators": _csv_list(args.abuse),
        "model": model,
    }
    if note:
        report["note"] = note
    return report


def main() -> None:
    p = argparse.ArgumentParser(description="Export a Battery Health Report for WarrantyLens.")
    p.add_argument("--vin", required=True, help="Vehicle VIN to tag the report with.")
    p.add_argument("--cap-pct", type=float, required=True,
                   help="Current capacity retention (0-1), e.g. 0.78.")
    p.add_argument("--chemistry", default="NMC")
    p.add_argument("--temperature", type=float, default=25.0)
    p.add_argument("--pack-id", default=None)
    p.add_argument("--abuse", default=None,
                   help="Comma-separated abuse indicators, e.g. frequent_hot_fast_charge,deep_discharge")
    p.add_argument("--faults", default=None, help='JSON list, e.g. \'[{"code":"P0A80","severity":"high"}]\'')
    p.add_argument("--api-url", default="http://localhost:8000")
    p.add_argument("--api-key", default=None)
    p.add_argument("--out", default=None)
    args = p.parse_args()

    report = build_report(args)
    out = args.out or f"battery_health_report_{args.vin.upper()}.json"
    Path(out).write_text(json.dumps(report, indent=2))
    print(f"Wrote {out}")
    print(f"  SoH: {report['soh_percent']}%  RUL: {report['rul'].get('cycles')}  "
          f"VIN: {report['vehicle']['vin']}")
    if report.get("note"):
        print(f"  NOTE: {report['note']}")


if __name__ == "__main__":
    main()

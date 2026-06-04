"""
core/demo_seed.py — Populate the platform with a realistic demo fleet.

One call seeds telemetry, logged predictions (analytics), alerts, and a spread of
healthy→weak cells across chemistries so a fresh install / pitch / trial shows a
populated product in seconds instead of an empty dashboard.

Uses only existing persistence + the real inference engine — the demo data is
produced by the same code paths a real fleet would exercise (not hardcoded rows).
"""
from __future__ import annotations

import logging
import random

logger = logging.getLogger(__name__)

_DEMO_PACK = "DEMO-PACK-01"
_CHEMS = ["NMC", "LFP", "NCA", "NMC", "LFP"]   # weighted toward common chemistries


def seed_demo_fleet(n_cells: int = 12, model_id: str = "v10-final", seed: int = 7) -> dict:
    """Seed a demo fleet. Returns a summary dict. Idempotent-ish (appends rows)."""
    from core.db import store_telemetry, track_call, record_alert
    from core.model_loader import run_inference

    rng = random.Random(seed)
    n_alerts = 0
    n_pred = 0
    cells = []

    for i in range(n_cells):
        cell_id = f"DEMO_{i + 1:02d}"
        chem    = _CHEMS[i % len(_CHEMS)]
        # spread of ages: a few weak cells, most healthy
        soh     = round(rng.uniform(0.70, 0.97), 3)
        n_cyc   = int((1.0 - soh) * rng.uniform(2500, 4000))
        ir      = round(0.03 + (1.0 - soh) * rng.uniform(0.05, 0.12), 4)
        temp    = round(rng.uniform(22, 34), 1)
        voltage = round(3.4 + soh * 0.6, 3)
        current = round(rng.uniform(-2.5, -1.0), 3)

        # 1) telemetry → /bms/live, fleet, SOC
        store_telemetry(cell_id=cell_id, voltage=voltage, current=current,
                        temperature=temp, soc=round(soh * 100, 1), cycle_num=n_cyc,
                        source="demo", pack_id=_DEMO_PACK)

        # 2) real prediction → analytics (track_call) inside run_inference path
        pred = run_inference(model_id, {
            "chemistry": chem, "soh_pct": soh * 100, "cap_pct": soh,
            "int_resistance": ir, "temperature": temp, "n_cycles": n_cyc,
        })
        rul   = float(pred.get("predicted_rul", 0))
        phase = pred.get("phase", "Aging")
        track_call(chemistry=chem, model_id=model_id, rul=rul, phase=phase,
                   source="demo", org="")
        n_pred += 1

        # 3) alert for weak / near-EOL cells → Alert History
        if soh < 0.80 or phase == "Near-EOL":
            record_alert(chemistry=chem, soh=round(soh * 100, 1), rul=rul,
                         phase=phase, label=cell_id, source="demo", org="")
            n_alerts += 1

        cells.append({"cell_id": cell_id, "chemistry": chem, "soh_pct": round(soh * 100, 1),
                      "rul": round(rul, 1), "phase": phase})

    logger.info("Demo fleet seeded: %d cells, %d predictions, %d alerts", n_cells, n_pred, n_alerts)
    return {
        "seeded": True,
        "pack_id": _DEMO_PACK,
        "n_cells": n_cells,
        "n_predictions": n_pred,
        "n_alerts": n_alerts,
        "model_id": model_id,
        "cells": cells,
    }

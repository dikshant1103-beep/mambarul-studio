"""
routers/bms_telemetry.py — Unified telemetry ingestion pipeline.

Sources: HTTP POST (this router), MQTT subscriber (background thread), CAN bus, Modbus.
All sources converge here via process_frame().

Endpoints:
  POST /api/bms/telemetry           — push one or many telemetry frames
  GET  /api/bms/live                — latest reading per cell (dashboard)
  GET  /api/bms/timeseries/{cell}   — historical time-series
  GET  /api/bms/soc                 — all SOC states
  GET  /api/bms/safety/events       — safety event log
  POST /api/bms/safety/{id}/clear   — clear a safety event
  GET  /api/bms/safety/summary      — IEC 62619 compliance summary
  GET  /api/bms/stats               — aggregate stats
"""
from __future__ import annotations
import logging
import threading
from typing import Optional, List
from fastapi import APIRouter, HTTPException, Header, Query
from pydantic import BaseModel, Field

router = APIRouter()
logger = logging.getLogger(__name__)

_pipeline_lock = threading.Lock()


# ── Telemetry frame model ─────────────────────────────────────────────────────

class TelemetryFrame(BaseModel):
    cell_id:       str
    voltage:       float = Field(..., ge=0.0, le=6.0,    description="Cell voltage (V)")
    current:       float = Field(..., ge=-500.0, le=500.0, description="+charge/-discharge (A)")
    temperature:   float = Field(..., ge=-40.0, le=100.0, description="°C")
    pack_id:       str   = ""
    cycle_num:     Optional[int] = None
    capacity_ah:   float = 5.0
    chemistry:     str   = "NMC"
    source:        str   = "http"
    soc_override:  Optional[float] = Field(None, ge=0, le=100,
                                           description="Skip Coulomb counting if provided")


# ── Core pipeline ─────────────────────────────────────────────────────────────

def process_frame(f: TelemetryFrame) -> dict:
    """Run one frame through the full BMS pipeline. Thread-safe."""
    from core.db import (store_telemetry, record_safety_event,
                         log_command, get_pack_cells, list_packs)
    from core.bms_safety import check_frame
    from core.soc_estimator import update_soc

    with _pipeline_lock:
        # 1. SOC estimation
        if f.soc_override is not None:
            soc = f.soc_override
        else:
            soc = update_soc(f.cell_id, f.current, f.voltage,
                             f.temperature, f.capacity_ah, f.chemistry)

        # 2. Store raw telemetry
        store_telemetry(
            cell_id=f.cell_id, voltage=f.voltage, current=f.current,
            temperature=f.temperature, soc=soc, cycle_num=f.cycle_num,
            source=f.source, pack_id=f.pack_id,
        )

        # 3. Safety check
        result = check_frame(
            cell_id=f.cell_id, voltage=f.voltage, current=f.current,
            temperature=f.temperature, capacity_ah=f.capacity_ah,
            chemistry=f.chemistry, pack_id=f.pack_id,
        )
        for ev in result.events:
            record_safety_event(**ev)
            if ev["severity"] == "trip":
                logger.warning("TRIP: cell=%s type=%s val=%.3f",
                               f.cell_id, ev["event_type"], ev["value"])

        # 4. Auto-issue control command on trip
        if result.trip:
            cmd = "emergency_stop" if "thermal_runaway" in str(result.events) else "charge_cutoff"
            log_command(cmd, target_id=f.cell_id,
                        parameters={"reason": result.events[0]["event_type"],
                                    "value": result.events[0]["value"]},
                        issued_by="safety_system")

        # 5. Live RUL inference (every 10 frames + on new cycle; non-blocking)
        rul_result = None
        try:
            from core.rul_bridge import update_cell as _rul_update
            rul_result = _rul_update(
                f.cell_id, f.voltage, f.current, f.temperature,
                soc, f.capacity_ah, f.chemistry,
                cycle_num=f.cycle_num,
            )
        except Exception:
            pass

        out = {
            "cell_id": f.cell_id,
            "soc":     round(soc, 2),
            "safe":    result.safe,
            "trip":    result.trip,
            "events":  len(result.events),
        }
        if rul_result:
            out["rul"]       = rul_result["rul"]
            out["rul_lower"] = rul_result["rul_lower"]
            out["rul_upper"] = rul_result["rul_upper"]
            out["phase"]     = rul_result.get("phase", "")

        # Stateful windowed aggregation (works even without Kafka)
        try:
            from core.streaming_processor import ingest_frame
            ingest_frame(f.cell_id, {
                "cell_id": f.cell_id, "voltage": f.voltage,
                "current": f.current, "temperature": f.temperature,
                "soc": round(soc, 2), "cycle_num": f.cycle_num,
                "chemistry": f.chemistry,
            })
        except Exception:
            pass

        # Publish to Kafka (best-effort — no-op if Kafka unavailable)
        try:
            from core.kafka_client import publish_telemetry, publish_alert
            publish_telemetry({
                "cell_id": f.cell_id, "voltage": f.voltage,
                "current": f.current, "temperature": f.temperature,
                "soc": round(soc, 2), "pack_id": f.pack_id,
                "chemistry": f.chemistry, "source": f.source,
            })
            if result.trip or result.events:
                for ev in result.events:
                    publish_alert({"cell_id": f.cell_id, **ev})
        except Exception:
            pass

        return out


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/bms/telemetry", summary="Ingest telemetry (single or batch)")
def ingest_telemetry(frames: List[TelemetryFrame] | TelemetryFrame) -> dict:
    if isinstance(frames, TelemetryFrame):
        frames = [frames]
    results = []
    trips   = 0
    for f in frames:
        try:
            r = process_frame(f)
            results.append(r)
            if r["trip"]:
                trips += 1
        except Exception as exc:
            logger.error("Frame processing error for %s: %s", f.cell_id, exc)
            results.append({"cell_id": f.cell_id, "error": str(exc)})
    return {"processed": len(results), "trips": trips, "results": results}


@router.get("/bms/live", summary="Latest reading per cell")
def live_readings(pack_id: str = Query("")) -> list:
    from core.db import get_latest_per_cell
    return get_latest_per_cell(pack_id)


@router.get("/bms/timeseries/{cell_id}", summary="Historical time-series for a cell")
def cell_history(cell_id: str, limit: int = Query(500, le=5000),
                 since: str = Query("")) -> list:
    from core.db import get_telemetry
    return get_telemetry(cell_id, limit=limit, since=since or None)


@router.get("/bms/soc", summary="SOC state for all cells")
def soc_states() -> list:
    from core.db import get_all_soc_states
    return get_all_soc_states()


@router.get("/bms/safety/events", summary="Safety event log")
def safety_events(cleared: Optional[bool] = Query(None),
                  cell_id: str = Query(""),
                  limit: int = Query(200, le=1000)) -> list:
    from core.db import get_safety_events
    return get_safety_events(cleared=cleared, limit=limit, cell_id=cell_id)


@router.post("/bms/safety/{event_id}/clear", summary="Clear a safety event")
def clear_event(event_id: str) -> dict:
    from core.db import clear_safety_event
    if not clear_safety_event(event_id):
        raise HTTPException(404, "Event not found.")
    return {"ok": True}


@router.get("/bms/safety/summary", summary="IEC 62619 compliance summary")
def safety_summary() -> dict:
    from collections import Counter
    from core.db import get_safety_events, get_active_trip_count
    from core.bms_safety import iec_62619_summary
    active_events = get_safety_events(cleared=False, limit=500)
    all_events    = get_safety_events(limit=2000)
    summary = iec_62619_summary(active_events)
    summary["active_trips"]    = get_active_trip_count()
    summary["active_warnings"] = sum(1 for e in active_events if e["severity"] == "warning")
    summary["trip_count"]      = sum(1 for e in all_events if e["severity"] == "trip")
    summary["warning_count"]   = sum(1 for e in all_events if e["severity"] == "warning")
    summary["total_events"]    = len(all_events)
    summary["event_types"]     = dict(Counter(e["event_type"] for e in all_events))
    return summary


@router.get("/bms/rul", summary="Live RUL estimates for all cells (from MambaRUL)")
def live_rul() -> dict:
    from core.rul_bridge import get_all_cached
    return get_all_cached()


@router.get("/bms/safety/report.pdf", summary="IEC 62619 compliance PDF report")
def safety_report_pdf():
    """Generate and return an IEC 62619 compliance report as a PDF."""
    from datetime import datetime, timezone
    from fastapi.responses import Response
    from core.db import get_safety_events, get_active_trip_count, get_latest_per_cell
    from core.bms_safety import iec_62619_summary
    from fpdf import FPDF

    active_events = get_safety_events(cleared=False, limit=500)
    all_events    = get_safety_events(limit=500)
    summary       = iec_62619_summary(active_events)
    summary["active_trips"]    = get_active_trip_count()
    summary["active_warnings"] = len([e for e in active_events if e["severity"] == "warning"])
    live_cells = get_latest_per_cell()
    now_str    = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    class PDF(FPDF):
        def header(self):
            self.set_fill_color(10, 14, 26)
            self.rect(0, 0, 210, 22, "F")
            self.set_text_color(255, 255, 255)
            self.set_font("Helvetica", "B", 14)
            self.set_xy(10, 6)
            self.cell(0, 10, "BatteryOS - IEC 62619 Safety Compliance Report")
            self.set_text_color(0, 0, 0)

        def footer(self):
            self.set_y(-12)
            self.set_font("Helvetica", "I", 8)
            self.set_text_color(120, 120, 120)
            self.cell(0, 10, f"Generated {now_str}  |  Page {self.page_no()}", align="C")

    pdf = PDF()
    pdf.add_page()
    pdf.set_auto_page_break(auto=True, margin=15)

    # ── Report meta ────────────────────────────────────────────────────────
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(100, 100, 100)
    pdf.set_y(26)
    pdf.cell(0, 5, f"Report Date: {now_str}    Standard: IEC 62619:2022    Cells Monitored: {len(live_cells)}", ln=True)
    pdf.ln(3)

    # ── Compliance verdict ─────────────────────────────────────────────────
    compliant = summary.get("iec_62619_compliant", False)
    pdf.set_font("Helvetica", "B", 13)
    if compliant:
        pdf.set_fill_color(16, 185, 129)
        pdf.set_text_color(255, 255, 255)
        pdf.cell(0, 12, "  COMPLIANT - No active IEC 62619 violations detected", ln=True, fill=True)
    else:
        pdf.set_fill_color(239, 68, 68)
        pdf.set_text_color(255, 255, 255)
        pdf.cell(0, 12, f"  NON-COMPLIANT - {len(summary.get('violations', []))} violation(s) found", ln=True, fill=True)
    pdf.set_text_color(0, 0, 0)
    pdf.ln(5)

    # ── Summary table ──────────────────────────────────────────────────────
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "Safety Summary", ln=True)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_fill_color(240, 240, 240)

    cols = [
        ("Active Trips",    str(summary.get("active_trips", 0))),
        ("Active Warnings", str(summary.get("active_warnings", 0))),
        ("Total Trips",     str(summary.get("trip_count", 0))),
        ("Total Warnings",  str(summary.get("warning_count", 0))),
        ("Total Events",    str(summary.get("total_events", 0))),
        ("Cells Online",    str(len(live_cells))),
    ]
    col_w = 95
    for i, (label, val) in enumerate(cols):
        fill = (i % 2 == 0)
        pdf.set_fill_color(245, 245, 245) if fill else pdf.set_fill_color(255, 255, 255)
        x = pdf.get_x()
        pdf.cell(col_w, 7, f"  {label}", border=1, fill=fill)
        pdf.set_font("Helvetica", "B", 9)
        pdf.cell(col_w, 7, f"  {val}", border=1, fill=fill, ln=True)
        pdf.set_font("Helvetica", "", 9)
    pdf.ln(4)

    # ── Violations ─────────────────────────────────────────────────────────
    violations = summary.get("violations", [])
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, "Violations", ln=True)
    pdf.set_font("Helvetica", "", 9)
    if violations:
        for v in violations:
            pdf.set_fill_color(255, 240, 240)
            pdf.cell(0, 6, f"  [!]  {v}", border=1, fill=True, ln=True)
    else:
        pdf.set_fill_color(240, 255, 240)
        pdf.cell(0, 6, "  [OK]  No violations - all thresholds within IEC 62619 limits", border=1, fill=True, ln=True)
    pdf.ln(4)

    # ── Event type breakdown ───────────────────────────────────────────────
    event_types = summary.get("event_types", {})
    if event_types:
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(0, 6, "Event Type Breakdown", ln=True)
        pdf.set_font("Helvetica", "", 9)
        for i, (etype, count) in enumerate(sorted(event_types.items(), key=lambda x: -x[1])):
            fill = (i % 2 == 0)
            pdf.set_fill_color(245, 245, 245) if fill else pdf.set_fill_color(255, 255, 255)
            pdf.cell(130, 6, f"  {etype.replace('_', ' ').title()}", border=1, fill=fill)
            pdf.set_font("Helvetica", "B", 9)
            pdf.cell(60, 6, f"  {count}", border=1, fill=fill, ln=True)
            pdf.set_font("Helvetica", "", 9)
        pdf.ln(4)

    # ── Recent active events ───────────────────────────────────────────────
    recent = [e for e in all_events if not e.get("cleared")][:20]
    if recent:
        pdf.set_font("Helvetica", "B", 10)
        pdf.cell(0, 6, f"Active Safety Events (showing {len(recent)})", ln=True)
        pdf.set_font("Helvetica", "B", 8)
        pdf.set_fill_color(220, 220, 220)
        for h, w in [("Severity", 22), ("Cell ID", 38), ("Event Type", 60), ("Value", 28), ("Time", 42)]:
            pdf.cell(w, 6, h, border=1, fill=True)
        pdf.ln()
        pdf.set_font("Helvetica", "", 8)
        for i, ev in enumerate(recent):
            fill = (i % 2 == 0)
            pdf.set_fill_color(255, 240, 240) if ev["severity"] == "trip" else (
                pdf.set_fill_color(255, 250, 230) if ev["severity"] == "warning" else
                pdf.set_fill_color(245, 245, 245)
            )
            ts = ev.get("ts", "")[:16]
            pdf.cell(22, 5, ev["severity"].upper(), border=1, fill=fill)
            pdf.cell(38, 5, str(ev.get("cell_id", ""))[:16], border=1, fill=fill)
            pdf.cell(60, 5, ev.get("event_type", "").replace("_", " ")[:30], border=1, fill=fill)
            pdf.cell(28, 5, f"{ev.get('value', 0):.3f}", border=1, fill=fill)
            pdf.cell(42, 5, ts, border=1, fill=fill, ln=True)
        pdf.ln(4)

    # ── Certification note ─────────────────────────────────────────────────
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(120, 120, 120)
    pdf.multi_cell(0, 4,
        "This report is generated automatically by BatteryOS v1.0 using real-time telemetry data. "
        "It reflects the system state at the time of generation and is intended for engineering "
        "review. For formal IEC 62619 certification, independent third-party testing is required.")

    pdf_bytes = pdf.output()
    return Response(
        content=bytes(pdf_bytes),
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="iec62619_report_{now_str[:10]}.pdf"'},
    )


@router.get("/bms/stats", summary="Aggregate BMS stats")
def bms_stats() -> dict:
    from core.db import get_latest_per_cell, get_all_soc_states, get_active_trip_count
    live  = get_latest_per_cell()
    socs  = get_all_soc_states()
    n     = len(live)
    temps = [r["temperature"] for r in live if r.get("temperature") is not None]
    volts = [r["voltage"]     for r in live if r.get("voltage") is not None]
    soc_vals = [s["soc"] for s in socs]
    return {
        "cells_online":   n,
        "avg_temp":       round(sum(temps)/len(temps), 2) if temps else None,
        "max_temp":       round(max(temps), 2) if temps else None,
        "avg_voltage":    round(sum(volts)/len(volts), 4) if volts else None,
        "avg_soc":        round(sum(soc_vals)/len(soc_vals), 2) if soc_vals else None,
        "min_soc":        round(min(soc_vals), 2) if soc_vals else None,
        "active_trips":   get_active_trip_count(),
    }

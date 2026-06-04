"""
routers/report.py — Executive fleet report (PDF leave-behind for pitches / reviews).

GET /api/report/executive.pdf
    Fleet health + prediction stats + warranty reserve + alert summary, rendered
    to a one-page PDF. Aggregates live data through the same engines the app uses
    (run_inference, warranty.assess_fleet), so the report reflects real state.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter
from fastapi.responses import Response

logger = logging.getLogger(__name__)
router = APIRouter()


def _fleet_warranty(live_cells: list[dict], model_id: str = "v10-final") -> dict:
    """Run inference + warranty on the live fleet; return the fleet warranty summary."""
    from core.model_loader import run_inference
    from core.warranty import assess_fleet

    cell_dicts = []
    for c in live_cells:
        soc = c.get("soc")
        soh = float(soc) / 100.0 if soc is not None else 0.85
        chem = c.get("chemistry", "NMC") or "NMC"
        pred = run_inference(model_id, {
            "chemistry": chem, "soh_pct": soh * 100, "cap_pct": soh,
            "int_resistance": c.get("ir", 0.05),
        })
        cell_dicts.append({
            "label": c.get("cell_id", "cell"), "soh": soh,
            "predicted_rul": float(pred.get("predicted_rul", 0)),
            "rul_lower": pred.get("lower_bound"), "rul_upper": pred.get("upper_bound"),
            "n_cycles": c.get("cycle_num", 0) or 0,
        })
    if not cell_dicts:
        return {"n_cells": 0, "reserve_recommended": 0.0, "total_exposure": 0.0,
                "by_status": {}, "n_at_risk": 0, "per_cell": []}
    return assess_fleet(cell_dicts, warranty_cycles=1000, warranty_years=8,
                        cycles_per_year=250, unit_cost=120.0)


@router.get("/report/executive.pdf", summary="Executive fleet report (PDF)")
def executive_report():
    from fpdf import FPDF
    from core.db import get_latest_per_cell, get_unacked_count
    from core.analytics import get_summary

    now_str    = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    live_cells = get_latest_per_cell()
    summary    = get_summary()
    unacked    = get_unacked_count()
    warranty   = _fleet_warranty(live_cells)

    soc_vals   = [float(c["soc"]) for c in live_cells if c.get("soc") is not None]
    mean_soh   = round(sum(soc_vals) / len(soc_vals), 1) if soc_vals else 0.0
    min_soh    = round(min(soc_vals), 1) if soc_vals else 0.0

    class PDF(FPDF):
        def header(self):
            self.set_fill_color(10, 14, 26); self.rect(0, 0, 210, 22, "F")
            self.set_text_color(255, 255, 255); self.set_font("Helvetica", "B", 14)
            self.set_xy(10, 6); self.cell(0, 10, "BatteryOS - Executive Fleet Report")
            self.set_text_color(0, 0, 0)

        def footer(self):
            self.set_y(-12); self.set_font("Helvetica", "I", 8)
            self.set_text_color(120, 120, 120)
            self.cell(0, 10, f"Generated {now_str}  |  Page {self.page_no()}", align="C")

    pdf = PDF(); pdf.add_page(); pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_y(26); pdf.set_font("Helvetica", "", 9); pdf.set_text_color(100, 100, 100)
    pdf.cell(0, 5, f"Report Date: {now_str}    Fleet size: {len(live_cells)} cells", ln=True)
    pdf.ln(3)

    def kpi_row(items):
        pdf.set_font("Helvetica", "", 9)
        w = 190 / len(items)
        pdf.set_fill_color(241, 245, 249); pdf.set_text_color(100, 100, 100)
        for label, _ in items:
            pdf.cell(w, 7, f"  {label}", border=0, fill=True)
        pdf.ln()
        pdf.set_font("Helvetica", "B", 12); pdf.set_text_color(15, 23, 42)
        for _, val in items:
            pdf.cell(w, 9, f"  {val}", border=0)
        pdf.ln(12)

    # Fleet health
    pdf.set_font("Helvetica", "B", 11); pdf.set_text_color(15, 23, 42)
    pdf.cell(0, 8, "Fleet Health", ln=True)
    kpi_row([("Cells", str(len(live_cells))), ("Mean SOH", f"{mean_soh}%"),
             ("Min SOH", f"{min_soh}%"), ("Open alerts", str(unacked))])

    # Prediction activity
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 8, "Prediction Activity", ln=True)
    kpi_row([("Predictions", str(summary.get("total_predictions", 0))),
             ("Avg RUL", f"{summary.get('avg_rul') or 0} cyc"),
             ("Total alerts", str(summary.get("total_alerts", 0))),
             ("Chemistries", str(len(summary.get("chemistry_dist", {}))))])

    # Warranty exposure
    pdf.set_font("Helvetica", "B", 11)
    pdf.cell(0, 8, "Warranty Exposure", ln=True)
    bs = warranty.get("by_status", {})
    kpi_row([("Reserve recommended", f"${warranty.get('reserve_recommended', 0):,.0f}"),
             ("Total exposure", f"${warranty.get('total_exposure', 0):,.0f}"),
             ("At risk", str(warranty.get("n_at_risk", 0))),
             ("Likely claims", str(bs.get("likely_claim", 0)))])

    # Top at-risk cells
    at_risk = sorted([c for c in warranty.get("per_cell", []) if c["status"] != "safe"],
                     key=lambda c: -c["p_claim"])[:8]
    if at_risk:
        pdf.set_font("Helvetica", "B", 11); pdf.cell(0, 8, "Top At-Risk Cells", ln=True)
        pdf.set_font("Helvetica", "B", 9); pdf.set_fill_color(241, 245, 249)
        pdf.set_text_color(100, 100, 100)
        for h, w in (("Cell", 50), ("SOH", 30), ("RUL", 35), ("P(claim)", 35), ("Status", 40)):
            pdf.cell(w, 7, f"  {h}", fill=True)
        pdf.ln()
        pdf.set_font("Helvetica", "", 9); pdf.set_text_color(15, 23, 42)
        for c in at_risk:
            pdf.cell(50, 7, f"  {c['label']}")
            pdf.cell(30, 7, f"  {c['soh_pct']}%")
            pdf.cell(35, 7, f"  {c['predicted_rul']:.0f} cyc")
            pdf.cell(35, 7, f"  {c['p_claim']*100:.0f}%")
            pdf.cell(40, 7, f"  {c['status'].replace('_', ' ')}")
            pdf.ln()

    out = pdf.output()
    pdf_bytes = bytes(out) if isinstance(out, (bytearray, memoryview)) else out
    return Response(
        content=pdf_bytes, media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="batteryos_executive_report_{now_str[:10]}.pdf"'},
    )

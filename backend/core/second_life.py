"""
core/second_life.py — Second-life battery assessment engine.

Grades a cell/pack based on SOH, RUL, IR, chemistry, and cycle count,
then recommends second-life applications and estimates residual value.

Grade scale (aligned with IEC 62984 / USDOE second-life guidelines):
  A  80-100% SOH  — direct reuse or high-demand second-life
  B  65-80%  SOH  — grid BESS, residential solar
  C  50-65%  SOH  — low-power stationary, UPS, telecom backup
  D  <50%    SOH  — recycle recommended

Value reference prices (USD/kWh, conservative 2026 market):
  NMC/NCA new ~$130, LFP new ~$100, LCO new ~$150
"""
from __future__ import annotations
import math
from dataclasses import dataclass, field
from typing import Optional

# ── Application catalogue ─────────────────────────────────────────────────────

_APPLICATIONS = [
    {
        "id":          "grid_bess",
        "name":        "Grid Energy Storage (BESS)",
        "min_soh":     65,
        "min_rul":     500,
        "max_ir_mult": 3.0,   # max IR relative to fresh baseline
        "revenue":     "High",
        "description": "Utility-scale or behind-the-meter grid storage. "
                       "Requires good cycle life, tolerates lower power density.",
    },
    {
        "id":          "residential_solar",
        "name":        "Residential Solar Storage",
        "min_soh":     60,
        "min_rul":     300,
        "max_ir_mult": 3.5,
        "revenue":     "Medium-High",
        "description": "Home solar self-consumption buffer. "
                       "Low C-rate cycling extends life considerably.",
    },
    {
        "id":          "ev_charging_buffer",
        "name":        "EV Fast-Charge Buffer",
        "min_soh":     70,
        "min_rul":     600,
        "max_ir_mult": 2.5,
        "revenue":     "High",
        "description": "Peak-shaving buffer for EV charging hubs. "
                       "Moderate power demand, reduces grid connection cost.",
    },
    {
        "id":          "telecom_backup",
        "name":        "Telecom / UPS Backup",
        "min_soh":     50,
        "min_rul":     200,
        "max_ir_mult": 4.0,
        "revenue":     "Medium",
        "description": "Backup power for cell towers and data centres. "
                       "Very infrequent deep discharge — extends battery life.",
    },
    {
        "id":          "microgrid",
        "name":        "Off-Grid / Microgrid",
        "min_soh":     55,
        "min_rul":     250,
        "max_ir_mult": 3.5,
        "revenue":     "Medium",
        "description": "Rural electrification and island microgrids. "
                       "Tolerates older cells if cycle life is sufficient.",
    },
    {
        "id":          "low_power_iot",
        "name":        "Low-Power IoT / Sensors",
        "min_soh":     40,
        "min_rul":     100,
        "max_ir_mult": 5.0,
        "revenue":     "Low",
        "description": "Very light-duty: sensors, trackers, wearables. "
                       "Minimal cycle demand — nearly any degraded cell qualifies.",
    },
    {
        "id":          "recycle",
        "name":        "Responsible Recycling",
        "min_soh":     0,
        "min_rul":     0,
        "max_ir_mult": 99,
        "revenue":     "Low (material recovery)",
        "description": "Cell below economical reuse threshold. "
                       "Hydromet / pyrometallurgical recovery of Li, Co, Ni.",
    },
]

# New-battery reference value (USD/kWh) by chemistry
_NEW_PRICE_PER_KWH: dict[str, float] = {
    "LFP": 100, "NMC": 130, "NCA": 135,
    "NCM": 130, "LCO": 150,
}
_DEFAULT_NEW_PRICE = 120

# Nominal capacity baseline (Ah) — used when capacity_ah not provided
_NOMINAL_AH: dict[str, float] = {
    "LFP": 50, "NMC": 50, "NCA": 50, "NCM": 50, "LCO": 30,
}
_DEFAULT_AH = 50

# Fresh-cell internal resistance baseline (Ω) by chemistry
_FRESH_IR: dict[str, float] = {
    "LFP": 0.030, "NMC": 0.025, "NCA": 0.025, "NCM": 0.025, "LCO": 0.035,
}
_DEFAULT_FRESH_IR = 0.030


# ── Core assessment ───────────────────────────────────────────────────────────

@dataclass
class AppResult:
    id:          str
    name:        str
    suitability: float        # 0–1
    suitable:    bool
    revenue:     str
    description: str
    reasons:     list[str] = field(default_factory=list)


@dataclass
class AssessmentResult:
    grade:        str           # A / B / C / D
    score:        float         # 0–100
    soh:          float         # 0–1
    rul_cycles:   float
    chemistry:    str
    cell_id:      str
    verdict:      str
    recycle:      bool
    applications: list[AppResult]
    value_min_usd: float
    value_max_usd: float
    value_per_kwh: float
    risk_flags:   list[str]
    recommended_tests: list[str]


def assess_cell(
    soh:            float,          # 0–1 (e.g. 0.74 = 74%)
    rul_cycles:     float,          # remaining cycles
    chemistry:      str   = "NMC",
    ir:             float = 0.0,    # internal resistance (Ω), 0 = unknown
    cycles:         int   = 0,      # total cycles completed
    capacity_ah:    float = 0.0,    # rated capacity (Ah), 0 = use default
    voltage_v:      float = 3.6,    # nominal voltage for value calc
    cell_id:        str   = "cell",
    capacity_fade_rate: float = 0.0,  # % SOH lost per 100 cycles, 0 = unknown
) -> dict:
    """
    Assess a single cell for second-life suitability.
    Returns a plain dict suitable for JSON serialisation.
    """
    chemistry = chemistry.upper()
    soh_pct   = soh * 100 if soh <= 1.0 else soh
    soh_norm  = soh_pct / 100

    # ── Grade ─────────────────────────────────────────────────────────────────
    if soh_pct >= 80:
        grade = "A"
    elif soh_pct >= 65:
        grade = "B"
    elif soh_pct >= 50:
        grade = "C"
    else:
        grade = "D"

    recycle = grade == "D"

    # ── Score (0–100) ─────────────────────────────────────────────────────────
    soh_score = soh_pct                               # 0–100
    rul_score = min(100, rul_cycles / 20)             # 2000 cycles → 100
    ir_score  = 100.0
    if ir > 0:
        fresh_ir = _FRESH_IR.get(chemistry, _DEFAULT_FRESH_IR)
        ir_mult  = ir / fresh_ir
        ir_score = max(0, 100 - (ir_mult - 1) * 25)  # each x1 fresh = -25pts

    score = round(0.5 * soh_score + 0.3 * rul_score + 0.2 * ir_score, 1)

    # ── Verdicts ──────────────────────────────────────────────────────────────
    _VERDICTS = {
        "A": "Excellent — suitable for direct reuse or high-demand second-life applications.",
        "B": "Good — well-suited for grid energy storage and solar buffering.",
        "C": "Fair — viable for low-power stationary and backup applications.",
        "D": "End-of-life — responsible recycling recommended.",
    }
    verdict = _VERDICTS[grade]

    # ── Application scoring ───────────────────────────────────────────────────
    fresh_ir = _FRESH_IR.get(chemistry, _DEFAULT_FRESH_IR)
    ir_mult  = (ir / fresh_ir) if ir > 0 else 1.5   # assume moderate if unknown

    app_results = []
    for app in _APPLICATIONS:
        reasons: list[str] = []
        s = 1.0

        # SOH check
        soh_margin = soh_pct - app["min_soh"]
        if soh_margin < 0:
            s *= 0.0
            reasons.append(f"SOH {soh_pct:.0f}% below minimum {app['min_soh']}%")
        else:
            s *= min(1.0, 0.5 + soh_margin / 60)

        # RUL check
        rul_margin = rul_cycles - app["min_rul"]
        if rul_margin < 0:
            s *= 0.0
            reasons.append(f"RUL {rul_cycles:.0f} cycles below minimum {app['min_rul']}")
        else:
            s *= min(1.0, 0.5 + rul_margin / 1000)

        # IR check
        if ir_mult > app["max_ir_mult"]:
            s *= 0.0
            reasons.append(f"IR {ir_mult:.1f}× baseline exceeds limit {app['max_ir_mult']}×")

        # Fade rate penalty
        if capacity_fade_rate > 0:
            if capacity_fade_rate > 5:
                s *= 0.5
                reasons.append(f"High fade rate {capacity_fade_rate:.1f}%/100 cyc")
            elif capacity_fade_rate > 2:
                s *= 0.8

        suitable = s > 0.3
        if not reasons and suitable:
            reasons.append("Meets all minimum requirements")

        app_results.append({
            "id":          app["id"],
            "name":        app["name"],
            "suitability": round(s, 2),
            "suitable":    suitable,
            "revenue":     app["revenue"],
            "description": app["description"],
            "reasons":     reasons,
        })

    # Sort: suitable first, then by suitability desc
    app_results.sort(key=lambda a: (-int(a["suitable"]), -a["suitability"]))

    # ── Risk flags ────────────────────────────────────────────────────────────
    risk_flags: list[str] = []
    if ir > 0 and ir_mult > 2.0:
        risk_flags.append(f"Elevated internal resistance ({ir_mult:.1f}× fresh baseline)")
    if capacity_fade_rate > 3:
        risk_flags.append(f"Accelerated capacity fade ({capacity_fade_rate:.1f}%/100 cycles)")
    if cycles > 2000:
        risk_flags.append(f"High cycle count ({cycles:,} cycles)")
    if rul_cycles < 300:
        risk_flags.append(f"Low remaining life ({rul_cycles:.0f} cycles)")
    if soh_pct < 60 and rul_cycles > 500:
        risk_flags.append("SOH/RUL mismatch — verify with capacity test")

    # ── Recommended tests ─────────────────────────────────────────────────────
    tests: list[str] = []
    if ir == 0:
        tests.append("HPPC test — measure internal resistance at 50% SOC")
    if capacity_ah == 0:
        tests.append("Capacity check at C/5 rate — confirm actual capacity")
    if ir > 0 and ir_mult > 1.8:
        tests.append("EIS (Electrochemical Impedance Spectroscopy) — characterise degradation modes")
    if capacity_fade_rate > 3:
        tests.append("3-cycle capacity verification — confirm fade rate estimate")
    tests.append("Visual inspection — check for swelling, electrolyte leakage, terminal corrosion")

    # ── Value estimate ────────────────────────────────────────────────────────
    new_price  = _NEW_PRICE_PER_KWH.get(chemistry, _DEFAULT_NEW_PRICE)
    cap_ah     = capacity_ah if capacity_ah > 0 else _NOMINAL_AH.get(chemistry, _DEFAULT_AH)
    kwh        = (cap_ah * voltage_v * soh_norm) / 1000

    grade_factors = {"A": (0.45, 0.60), "B": (0.25, 0.40), "C": (0.10, 0.20), "D": (0.02, 0.06)}
    lo_f, hi_f = grade_factors[grade]

    # IR penalty on value
    ir_penalty = max(0.5, 1 - (ir_mult - 1) * 0.1) if ir > 0 else 0.85

    val_lo = round(kwh * new_price * lo_f * ir_penalty, 0)
    val_hi = round(kwh * new_price * hi_f * ir_penalty, 0)
    per_kwh = round(new_price * (lo_f + hi_f) / 2, 0)

    return {
        "cell_id":      cell_id,
        "grade":        grade,
        "score":        score,
        "soh_pct":      round(soh_pct, 1),
        "rul_cycles":   round(rul_cycles, 0),
        "chemistry":    chemistry,
        "recycle":      recycle,
        "verdict":      verdict,
        "applications": app_results,
        "value": {
            "min_usd":    val_lo,
            "max_usd":    val_hi,
            "per_kwh_usd": per_kwh,
            "kwh_remaining": round(kwh, 3),
            "basis":      "SOH-adjusted market rate, 2026",
        },
        "risk_flags":         risk_flags,
        "recommended_tests":  tests,
        "inputs": {
            "ir_ohm":            ir,
            "ir_mult_vs_fresh":  round(ir_mult, 2),
            "cycles":            cycles,
            "capacity_fade_rate": capacity_fade_rate,
        },
    }


def assess_pack(cells: list[dict]) -> dict:
    """
    Pack-level second-life assessment.
    cells: list of assess_cell() result dicts (or raw input dicts).
    """
    if not cells:
        return {"error": "No cells provided"}

    sohs    = [c["soh_pct"] if "soh_pct" in c else c.get("soh", 0) * 100 for c in cells]
    ruls    = [c.get("rul_cycles", 0) for c in cells]
    grades  = [c.get("grade", "D") for c in cells]

    avg_soh  = sum(sohs) / len(sohs)
    min_soh  = min(sohs)
    max_soh  = max(sohs)
    soh_var  = max_soh - min_soh
    avg_rul  = sum(ruls) / len(ruls)
    min_rul  = min(ruls)

    # Pack grade is limited by weakest cell
    grade_order = {"A": 4, "B": 3, "C": 2, "D": 1}
    pack_grade  = min(grades, key=lambda g: grade_order.get(g, 0))

    # Variance penalty — high cell-to-cell spread degrades pack usability
    variance_penalty = min(1.0, soh_var / 30)   # 30% spread → full penalty
    pack_score = max(0, assess_cell(avg_soh / 100, avg_rul)["score"] * (1 - 0.3 * variance_penalty))

    risk_flags = []
    if soh_var > 15:
        risk_flags.append(f"High cell SOH variance ({soh_var:.1f}% spread) — balancing required")
    if soh_var > 25:
        risk_flags.append("Severe cell imbalance — consider replacing weak cells before reuse")
    weak_cells = [c.get("cell_id", f"cell_{i}") for i, s in enumerate(sohs) if s < avg_soh - 10]
    if weak_cells:
        risk_flags.append(f"Weak cells dragging pack: {', '.join(weak_cells[:5])}")

    cell_grade_dist = {g: grades.count(g) for g in ["A", "B", "C", "D"] if g in grades}

    return {
        "pack_grade":   pack_grade,
        "pack_score":   round(pack_score, 1),
        "n_cells":      len(cells),
        "avg_soh_pct":  round(avg_soh, 1),
        "min_soh_pct":  round(min_soh, 1),
        "max_soh_pct":  round(max_soh, 1),
        "soh_variance": round(soh_var, 1),
        "avg_rul":      round(avg_rul, 0),
        "min_rul":      round(min_rul, 0),
        "cell_grade_distribution": cell_grade_dist,
        "risk_flags":   risk_flags,
        "weakest_cells": weak_cells[:5],
        "recommendation": (
            "Suitable as a pack unit" if soh_var < 10 else
            "Rebalance or sort cells by SOH before pack assembly" if soh_var < 20 else
            "Individual cell reassembly recommended — high variance"
        ),
    }

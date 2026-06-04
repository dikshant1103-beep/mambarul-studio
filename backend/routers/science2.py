"""
science2.py — endpoints for training logs, NASA zero-shot, conformal prediction,
and SHAP feature importance. All data served from real thesis files.
"""
from __future__ import annotations

import csv
import io
import logging
import math
import re
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException

router = APIRouter()
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).parent.parent.parent.parent  # mamba_rul_project/
THESIS = PROJECT_ROOT / "thesis_results"


# ── helpers ──────────────────────────────────────────────────────────────────

def _safe_float(value: Any) -> Optional[float]:
    """Cast to float; return None for NaN/inf."""
    try:
        f = float(value)
        return None if math.isnan(f) or math.isinf(f) else f
    except (TypeError, ValueError):
        return None


def _require_file(path: Path) -> Path:
    """Raise 404 if *path* does not exist."""
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    return path


# ═══════════════════════════════════════════════════════════════════════════
# 1. GET /api/training-logs
# ═══════════════════════════════════════════════════════════════════════════

# Matches epoch table rows:  "   1 |  0.026570 |     70.34 |  +0.362 |  0.9717 | *"
_EPOCH_RE = re.compile(
    r"^\s+(\d+)\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|\s+([+\-][\d.]+)\s+\|\s+([\d.]+)\s+\|(.*)$"
)
# Matches: "  Best epoch: 7  |  CALCE val RMSE: 52.33  |  Oxford R²: +0.362"
_BEST_RE = re.compile(
    r"Best epoch:\s*(\d+)\s+\|.*?CALCE val RMSE:\s*([\d.]+)\s+\|.*?Oxford R.{0,3}:\s*([+\-]?[\d.]+)"
)
# Matches: "  Early stop at epoch 37 (patience=30)"
_EARLY_RE = re.compile(r"Early stop at epoch\s+(\d+)")


def _parse_training_log(path: Path) -> dict:
    text = path.read_text(encoding="utf-8", errors="replace")

    epochs: list[int] = []
    tr_loss: list[float] = []
    calce_val: list[float] = []
    ox_r2: list[float] = []
    score: list[float] = []
    is_best: list[bool] = []

    for line in text.splitlines():
        m = _EPOCH_RE.match(line)
        if m:
            ep, loss, cv, r2, sc, tail = m.groups()
            epochs.append(int(ep))
            tr_loss.append(float(loss))
            calce_val.append(float(cv))
            ox_r2.append(float(r2))
            score.append(float(sc))
            is_best.append(tail.strip().endswith("*"))

    best_epoch: Optional[int] = None
    best_calce_val: Optional[float] = None
    best_ox_r2: Optional[float] = None
    early_stop_epoch: Optional[int] = None

    m_best = _BEST_RE.search(text)
    if m_best:
        best_epoch = int(m_best.group(1))
        best_calce_val = _safe_float(m_best.group(2))
        best_ox_r2 = _safe_float(m_best.group(3))

    m_early = _EARLY_RE.search(text)
    if m_early:
        early_stop_epoch = int(m_early.group(1))

    return {
        "epochs": epochs,
        "tr_loss": tr_loss,
        "calce_val": calce_val,
        "ox_r2": ox_r2,
        "score": score,
        "is_best": is_best,
        "best_epoch": best_epoch,
        "best_calce_val": best_calce_val,
        "best_ox_r2": best_ox_r2,
        "early_stop_epoch": early_stop_epoch,
    }


@router.get("/training-logs")
def get_training_logs() -> dict:
    """
    Parse the four ensemble training log files and return per-epoch metrics
    for seeds 123, 2024, 7 and 999.
    """
    seed_files = {
        "123": THESIS / "train_seed123.log",
        "2024": THESIS / "train_seed2024.log",
        "7": THESIS / "train_seed7.log",
        "999": THESIS / "train_seed999.log",
    }

    seeds: dict[str, dict] = {}
    for seed, path in seed_files.items():
        _require_file(path)
        try:
            seeds[seed] = _parse_training_log(path)
        except Exception as exc:
            logger.exception("Failed to parse %s", path)
            raise HTTPException(status_code=500, detail=f"Parse error for seed {seed}: {exc}") from exc

    return {"seeds": seeds}


# ═══════════════════════════════════════════════════════════════════════════
# 2. GET /api/nasa-zeroshot
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/nasa-zeroshot")
def get_nasa_zeroshot() -> dict:
    """
    Return NASA zero-shot transfer results from v3_nasa_zero_shot/nasa_results.csv
    plus the README.txt description.
    """
    nasa_dir = THESIS / "v3_nasa_zero_shot"
    csv_path = _require_file(nasa_dir / "nasa_results.csv")
    readme_path = nasa_dir / "README.txt"

    # Parse CSV
    cells: list[dict] = []
    combined: Optional[dict] = None

    with csv_path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            battery = row["battery"].strip()
            entry = {
                "battery": battery,
                "n_windows": int(row["n_windows"]),
                "rmse": _safe_float(row["rmse"]),
                "mae": _safe_float(row["mae"]),
                "r2": _safe_float(row["r2"]),
                "naive_rmse": _safe_float(row["naive_rmse"]),
                "beats_naive": row["beats_naive"].strip().lower() == "true",
            }
            if battery.upper() == "COMBINED":
                combined = {
                    "rmse": entry["rmse"],
                    "mae": entry["mae"],
                    "r2": entry["r2"],
                }
            else:
                cells.append(entry)

    # Read README
    readme_text = ""
    if readme_path.exists():
        try:
            readme_text = readme_path.read_text(encoding="utf-8", errors="replace").strip()
        except Exception:
            logger.warning("Could not read %s", readme_path)

    return {
        "cells": cells,
        "combined": combined,
        "readme": readme_text,
    }


# ═══════════════════════════════════════════════════════════════════════════
# 3. GET /api/conformal-real
# ═══════════════════════════════════════════════════════════════════════════

def _parse_md_table_rows(lines: list[str]) -> list[list[str]]:
    """
    Return data rows from a markdown table (skip header and separator lines).
    A header row is one where every cell contains only letters/spaces/%.
    A separator row contains only dashes and pipes.
    """
    rows: list[list[str]] = []
    for line in lines:
        line = line.strip()
        if not line.startswith("|"):
            continue
        # Skip separator rows (contain only -, |, space)
        if re.fullmatch(r"[\|\-\s:]+", line):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        # Skip header rows (cells are purely alphabetic/symbolic labels)
        if all(re.fullmatch(r"[A-Za-z%\s/\-\.()]+", c) for c in cells if c):
            continue
        rows.append(cells)
    return rows


@router.get("/conformal-real")
def get_conformal_real() -> dict:
    """
    Parse conformal_analysis/conformal_results.md and return calibration
    results, test-set coverage table, method description and calibration count.
    """
    md_path = _require_file(THESIS / "conformal_analysis" / "conformal_results.md")
    text = md_path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    # ── locate sections ───────────────────────────────────────────────────
    calib_start = next(
        (i for i, l in enumerate(lines) if "Calibration Results" in l), None
    )
    coverage_start = next(
        (i for i, l in enumerate(lines) if "Test Set Coverage" in l), None
    )

    # ── calibration table ─────────────────────────────────────────────────
    calibration: list[dict] = []
    if calib_start is not None:
        # Collect lines until next section header (---) or empty then #
        section_lines = []
        for line in lines[calib_start:]:
            if line.startswith("---") and section_lines:
                break
            section_lines.append(line)
        for row in _parse_md_table_rows(section_lines):
            if len(row) >= 3:
                # row: [alpha, confidence, interval_half_width]
                # alpha cell: "0.05", confidence: "95%", hw: "±213.9 cycles"
                alpha_str = row[0].strip()
                conf_str = row[1].strip().rstrip("%")
                hw_str = row[2].strip()
                # Extract numeric part of half-width (strip ± and "cycles")
                hw_num = re.search(r"[\d.]+", hw_str)
                try:
                    calibration.append(
                        {
                            "alpha": float(alpha_str),
                            "confidence": float(conf_str),
                            "half_width": float(hw_num.group()) if hw_num else None,
                        }
                    )
                except ValueError:
                    pass

    # ── coverage table ────────────────────────────────────────────────────
    coverage: list[dict] = []
    if coverage_start is not None:
        section_lines = []
        for line in lines[coverage_start:]:
            if line.startswith("---") and section_lines:
                break
            section_lines.append(line)
        for row in _parse_md_table_rows(section_lines):
            if len(row) >= 5:
                # row: [test_set, n_windows, empirical_coverage, mean_interval_width, late_life_coverage]
                test_set = row[0].strip()
                n_windows_str = row[1].strip()
                emp_cov_str = row[2].strip().rstrip("%")
                miw_str = row[3].strip()
                llc_str = row[4].strip().rstrip("%")

                # Extract numeric part of mean_interval_width (e.g. "±0.6 cyc" → 0.6)
                miw_num = re.search(r"[\d.]+", miw_str)

                try:
                    coverage.append(
                        {
                            "test_set": test_set,
                            "n_windows": int(n_windows_str),
                            "empirical_coverage": _safe_float(emp_cov_str),
                            "mean_interval_width": _safe_float(miw_num.group()) if miw_num else None,
                            "late_life_coverage": _safe_float(llc_str),
                        }
                    )
                except (ValueError, AttributeError):
                    pass

    # ── method summary ────────────────────────────────────────────────────
    # Extract method description and calibration count from the text
    method_match = re.search(r"\*\*Split conformal prediction\*\*[^\n]*", text)
    method = "Split conformal prediction. Calibration: 376 windows from CS2_34 and CX2_37."
    if method_match:
        method = method_match.group(0).replace("**", "").strip()

    n_calib_match = re.search(r"N_calibration\s*=\s*(\d+)", text)
    n_calibration = int(n_calib_match.group(1)) if n_calib_match else 376

    return {
        "calibration": calibration,
        "coverage": coverage,
        "method": method,
        "n_calibration": n_calibration,
    }


# ═══════════════════════════════════════════════════════════════════════════
# 4. GET /api/shap-real
# ═══════════════════════════════════════════════════════════════════════════

# Matches the chemistry section headers, e.g. "## CALCE LCO — Feature Importance"
_CHEM_HEADER_RE = re.compile(r"^##\s+(CALCE LCO|KJTU NMC|Oxford NMC)\s*[—–\-]")
# Matches Top-3 line: "**Top-3 features**: Cum. Energy, Voltage Mean, Chem Code"
_TOP3_RE = re.compile(r"\*\*Top-3 features\*\*:\s*(.+)")
# Matches physical interpretation line
_INTERP_RE = re.compile(r"\*\*Physical interpretation\*\*:\s*(.+)")


def _parse_shap_table_rows(lines: list[str]) -> list[list[str]]:
    """Extract data rows from a SHAP markdown table (skip header/separators)."""
    rows = []
    for line in lines:
        line = line.strip()
        if not line.startswith("|"):
            continue
        if re.fullmatch(r"[\|\-\s:]+", line):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        # Skip header row (first cell is "Rank" or similar label)
        if cells and cells[0].lower() in ("rank", ""):
            continue
        rows.append(cells)
    return rows


@router.get("/shap-real")
def get_shap_real() -> dict:
    """
    Parse shap_analysis/shap_results.md and return per-chemistry SHAP feature
    importance tables, top-3 features, physical interpretations, and method.
    """
    md_path = _require_file(THESIS / "shap_analysis" / "shap_results.md")
    text = md_path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()

    # ── extract method ────────────────────────────────────────────────────
    method_match = re.search(
        r"\*\*Integrated Gradients \(IG\)\*\*[^\n]+", text
    )
    method = (
        method_match.group(0).replace("**", "").strip()
        if method_match
        else "Integrated Gradients (IG) — path integral from zero baseline."
    )

    # ── split into per-chemistry sections ─────────────────────────────────
    chemistries: dict[str, dict] = {}

    # Find all section boundaries
    section_indices: list[tuple[int, str]] = []
    for i, line in enumerate(lines):
        m = _CHEM_HEADER_RE.match(line)
        if m:
            section_indices.append((i, m.group(1)))

    for idx, (start_line, chem_name) in enumerate(section_indices):
        end_line = section_indices[idx + 1][0] if idx + 1 < len(section_indices) else len(lines)
        section = lines[start_line:end_line]
        section_text = "\n".join(section)

        # Parse feature table
        features: list[dict] = []
        for row in _parse_shap_table_rows(section):
            if len(row) >= 6:
                try:
                    features.append(
                        {
                            "rank": int(row[0]),
                            "name": row[1],
                            "early": _safe_float(row[2]),
                            "mid": _safe_float(row[3]),
                            "late": _safe_float(row[4]),
                            "overall": _safe_float(row[5]),
                        }
                    )
                except (ValueError, IndexError):
                    pass

        # Parse top-3
        top3: list[str] = []
        m_top3 = _TOP3_RE.search(section_text)
        if m_top3:
            top3 = [t.strip() for t in m_top3.group(1).split(",")]

        # Parse physical interpretation
        interpretation = ""
        m_interp = _INTERP_RE.search(section_text)
        if m_interp:
            interpretation = m_interp.group(1).strip()

        chemistries[chem_name] = {
            "features": features,
            "top3": top3,
            "interpretation": interpretation,
        }

    return {
        "chemistries": chemistries,
        "method": method,
    }

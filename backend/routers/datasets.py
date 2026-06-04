"""
routers/datasets.py
-------------------
Endpoints for dataset exploration: catalog, per-cell capacity / RUL curves,
and per-chemistry statistics.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException

from core.data_loader import (
    get_cells_for_dataset,
    get_cell_capacity_curve,
    get_chemistry_stats,
    get_dataset_catalog,
    get_all_meta,
    get_fleet_summary,
    get_fleet_anomalies,
)

router = APIRouter()

# ---------------------------------------------------------------------------
# Static catalogue — enriched with domain knowledge the CSV lacks
# ---------------------------------------------------------------------------
DATASET_CATALOG: dict[str, dict[str, Any]] = {
    "CALCE": {
        "chemistry": "LCO",
        "chemistry_code": 0,
        "form_factor": "Prismatic",
        "nominal_capacity": 1.1,
        "temperature": 25,
        "protocol": "CC-CV (1C charge, 1C discharge)",
        "cell_count": 11,
        "avg_cycles": 250,
        "description": (
            "CALCE CS2 and CX2 series LCO prismatic cells cycled at 25 °C "
            "under standard CC-CV protocol."
        ),
    },
    "MIT": {
        "chemistry": "LFP",
        "chemistry_code": 1,
        "form_factor": "Cylindrical (18650)",
        "nominal_capacity": 1.1,
        "temperature": 30,
        "protocol": "Fast charge (C/10 to 3.6 V then CC at various rates)",
        "cell_count": 129,
        "avg_cycles": 833,
        "description": (
            "MATR — MIT/Stanford/Toyota Research LFP fast-charge dataset. "
            "129 cells across 4 batches (2017–2018). 79 train / 25 val / 25 test split. "
            "Severson et al., Nature Energy 2019."
        ),
        "reference": "Severson et al., Nature Energy 2019",
        "splits": {"train": 79, "val": 25, "test": 25},
    },
    "KJTU": {
        "chemistry": "NMC",
        "chemistry_code": 2,
        "form_factor": "Cylindrical (18650)",
        "nominal_capacity": 2.0,
        "temperature": 25,
        "protocol": "CC-CV (0.5C charge, 0.5C discharge)",
        "cell_count": 5,
        "avg_cycles": 480,
        "description": "KJTU NMC cylindrical cells at 25 °C standard cycling.",
    },
    "TJU": {
        "chemistry": "NCM",
        "chemistry_code": 3,
        "form_factor": "Cylindrical (18650)",
        "nominal_capacity": 2.0,
        "temperature": "25–45 °C",
        "protocol": "CC-CV (0.5C charge, 1C discharge)",
        "cell_count": 3,
        "avg_cycles": 538,
        "description": "TJU NCM cells at variable temperatures (25 °C and 45 °C).",
    },
    "Oxford": {
        "chemistry": "NMC",
        "chemistry_code": 2,
        "form_factor": "Pouch",
        "nominal_capacity": 0.74,
        "temperature": 40,
        "protocol": "EIS + discharge snapshots every ~100 cycles",
        "cell_count": 8,
        "avg_cycles": 8000,
        "description": (
            "Oxford NMC pouch cells with ~8000 cycle lifetime. "
            "Measured in EIS snapshots every ~100 cycles. "
            "Used for zero-shot transfer evaluation."
        ),
    },
    "NASA": {
        "chemistry": "LCO",
        "chemistry_code": 0,
        "form_factor": "Cylindrical (18650)",
        "nominal_capacity": 2.0,
        "temperature": 24,
        "protocol": "CC-CV charge, CC discharge at 2 A",
        "cell_count": 3,
        "avg_cycles": 167,
        "description": (
            "NASA PCoE B0005/B0006/B0007 LCO cells. "
            "Classic benchmark dataset. Used for cross-dataset zero-shot evaluation."
        ),
    },
}

# Map dataset names in the actual CSV to catalogue keys
_DATASET_ALIAS: dict[str, str] = {
    "CALCE_CS2_orig": "CALCE",
    "CALCE_CS2_extra": "CALCE",
    "CX2": "CALCE",
    "MIT": "MIT",
    "KJTU": "KJTU",
    "TJU_NCM": "TJU",
    "TJU_NCA": "TJU",
    "NASA": "NASA",
    # Oxford is not present in the processed multi_dataset files
}


def _enrich_with_catalog(ds_entry: dict[str, Any]) -> dict[str, Any]:
    """Add static catalogue metadata to a data-derived dataset entry."""
    raw_name: str = ds_entry["dataset"]
    catalog_key = _DATASET_ALIAS.get(raw_name, raw_name.split("_")[0])
    catalog_entry = DATASET_CATALOG.get(catalog_key, {})
    return {**catalog_entry, **ds_entry}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/datasets", summary="List all datasets with metadata")
def list_datasets() -> list[dict[str, Any]]:
    """
    Returns one entry per logical dataset group (CALCE, MIT, KJTU, TJU, NASA)
    merged from the processed data catalog and the hardcoded domain catalogue.
    """
    raw_catalog = get_dataset_catalog()

    # Merge data-driven entries by catalogue key
    merged: dict[str, dict] = {}
    for entry in raw_catalog:
        raw_name = entry["dataset"]
        key = _DATASET_ALIAS.get(raw_name, raw_name.split("_")[0])
        if key not in merged:
            merged[key] = {**DATASET_CATALOG.get(key, {}), "dataset": key, "sub_datasets": []}
        merged[key]["sub_datasets"].append(raw_name)
        # Accumulate cell counts
        if "cell_count" in merged[key]:
            existing = merged[key].get("_cell_count_acc", 0)
            merged[key]["_cell_count_acc"] = existing + entry["cell_count"]

    # Resolve accumulated counts
    for key, entry in merged.items():
        if "_cell_count_acc" in entry:
            entry["cell_count"] = entry.pop("_cell_count_acc")

    # Also expose the static-only entries (Oxford)
    for key, static in DATASET_CATALOG.items():
        if key not in merged:
            merged[key] = {"dataset": key, **static, "sub_datasets": []}

    return sorted(merged.values(), key=lambda d: d["dataset"])


@router.get("/datasets/{dataset_name}/cells", summary="List cells in a dataset")
def list_cells(dataset_name: str) -> list[dict[str, Any]]:
    """
    Returns per-cell summary rows for all cells belonging to the requested dataset.
    The `dataset_name` can be either a logical name (e.g. "CALCE") or a raw CSV name
    (e.g. "CALCE_CS2_orig").
    """
    # Resolve logical → raw names
    raw_names: list[str] = [dataset_name]  # try as-is first

    # If it is a catalogue key, collect all matching raw sub-datasets
    matching_raws = [k for k, v in _DATASET_ALIAS.items() if v.upper() == dataset_name.upper()]
    if matching_raws:
        raw_names = matching_raws

    cells: list[dict] = []
    for raw in raw_names:
        cells.extend(get_cells_for_dataset(raw))

    if not cells:
        raise HTTPException(status_code=404, detail=f"Dataset '{dataset_name}' not found.")

    return cells


@router.get(
    "/datasets/{dataset_name}/cells/{cell_id}/capacity",
    summary="Capacity fade curve for a cell",
)
def get_capacity_curve(dataset_name: str, cell_id: str) -> dict[str, Any]:
    """
    Returns arrays of cycle numbers, capacity (Ah), and SOH for the requested cell.
    """
    data = get_cell_capacity_curve(cell_id)
    if not data:
        raise HTTPException(status_code=404, detail=f"Cell '{cell_id}' not found.")
    return {
        "cell_id": data["cell_id"],
        "dataset": data["dataset"],
        "chemistry_name": data["chemistry_name"],
        "cycles": data["cycles"],
        "capacity": data["capacity"],
        "soh": data["soh"],
        "cum_energy": data["cum_energy"],
    }


@router.get(
    "/datasets/{dataset_name}/cells/{cell_id}/rul",
    summary="RUL trajectory for a cell",
)
def get_rul_curve(dataset_name: str, cell_id: str) -> dict[str, Any]:
    """
    Returns arrays of cycle numbers and RUL values for the requested cell.
    """
    data = get_cell_capacity_curve(cell_id)
    if not data:
        raise HTTPException(status_code=404, detail=f"Cell '{cell_id}' not found.")
    return {
        "cell_id": data["cell_id"],
        "dataset": data["dataset"],
        "chemistry_name": data["chemistry_name"],
        "chemistry_code": data["chemistry_code"],
        "cycles": data["cycles"],
        "rul": data["rul"],
    }


@router.get("/fleet/summary", summary="Fleet summary — one row per cell at mid-life snapshot")
def fleet_summary(snapshot_frac: float = 0.60, max_cells: int = 40) -> list[dict]:
    """
    Returns fleet cells sampled at snapshot_frac of each cell's total cycle life.
    Sorted: critical first, then warning, then healthy; within each group by SOH ascending.
    """
    return get_fleet_summary(snapshot_frac=snapshot_frac, max_cells=max_cells)


@router.get("/fleet/anomalies", summary="Fleet anomaly detection — cells deviating >2σ from chemistry baseline")
def fleet_anomalies(max_cells: int = 40) -> list[dict]:
    """
    Returns fleet cells annotated with anomaly flags.
    Fields added per cell: z_soh, z_rul, is_anomaly, anomaly_reason.
    """
    return get_fleet_anomalies(max_cells=max_cells)


@router.get("/datasets/stats/chemistry", summary="Per-chemistry aggregate statistics")
def chemistry_stats() -> dict[str, Any]:
    """
    Returns aggregate statistics (cell count, avg cycles, avg capacity, etc.)
    broken down by battery chemistry.
    """
    return get_chemistry_stats()

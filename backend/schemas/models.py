"""
schemas/models.py
-----------------
Pydantic v2 request/response schemas for MambaRUL Studio API.
"""

from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, Field, field_validator, model_validator


# ---------------------------------------------------------------------------
# Prediction
# ---------------------------------------------------------------------------

VALID_CHEMISTRIES = {"LCO", "LFP", "NMC", "NCM", "NCA"}


class PredictRequest(BaseModel):
    """
    Input features for the RUL prediction endpoint.

    Only `chemistry` and `cap_pct` are strictly required.
    The remaining features improve the prediction accuracy when available.
    """

    model_id: str = Field(
        default="v10-final",
        description="Model to use: v10-final | v10-full | v9 | v8 | tcn-mamba | analytical",
    )
    chemistry: str = Field(
        default="LCO",
        description="Battery chemistry: LCO | LFP | NMC | NCM | NCA",
        examples=["LCO", "LFP", "NMC", "NCM"],
    )
    cap_pct: float = Field(
        default=0.85, ge=0.0, le=1.0,
        description="State-of-Health proxy (Q_i / Q_0). Must be in [0, 1].",
    )
    soh_pct: Optional[float] = Field(
        default=None,
        description="State of Health as percentage (0-100). Derived from cap_pct if not provided.",
    )
    capacity: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Discharge capacity in Ah.",
    )
    charge_time: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Total charge time in seconds.",
    )
    voltage_mean: Optional[float] = Field(
        default=None,
        description="Mean discharge voltage in V.",
    )
    voltage_end: Optional[float] = Field(
        default=None,
        description="Terminal discharge voltage in V.",
    )
    energy: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Discharge energy in Wh.",
    )
    temperature: Optional[float] = Field(
        default=None,
        description="Cell temperature during discharge in °C.",
    )
    cap_slope: Optional[float] = Field(
        default=None,
        description="Rolling 5-cycle capacity fade slope (dQ/dt).",
    )
    int_resistance: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Internal resistance in Ohm.",
    )
    nom_capacity: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Nominal (nameplate) capacity of the cell in Ah. Used to rescale large-format cells to training distribution.",
    )
    delta_cap: Optional[float] = Field(
        default=None,
        description="Cycle-to-cycle capacity change (Q_i − Q_{i-1}) in Ah.",
    )
    delta_ir: Optional[float] = Field(
        default=None,
        description="Cycle-to-cycle resistance change (R_i − R_{i-1}) in Ohm.",
    )
    n_cycles: Optional[int] = Field(
        default=None, ge=0,
        description=(
            "Number of observed charge/discharge cycles so far. "
            "When < 30, the prediction is blended with a chemistry-specific "
            "prior (α=0 → 100% prior at cycle 0; α=1 → 100% model at cycle 30). "
            "Omit or set to None if ≥30 cycles are available."
        ),
    )
    dod_pct: Optional[float] = Field(
        default=None, ge=5.0, le=100.0,
        description=(
            "Depth of Discharge in percent (5–100). "
            "Default 100 = full discharge (training distribution). "
            "For EV cells cycled 20–80% SOC, set dod_pct=60. "
            "RUL is scaled up by an empirical DoD-to-cycle-life exponent; "
            "confidence interval is widened to reflect out-of-distribution uncertainty."
        ),
    )
    cell_id: Optional[str] = Field(
        default=None,
        description=(
            "Optional cell identifier. When provided and the cell has ≥10 cycles "
            "of persisted history, the global chemistry CI is replaced with a "
            "per-cell tightened CI (Layer 3 online RUL)."
        ),
    )

    @field_validator("chemistry")
    @classmethod
    def validate_chemistry(cls, v: str) -> str:
        upper = v.upper()
        if upper not in VALID_CHEMISTRIES:
            raise ValueError(
                f"chemistry='{v}' is not recognised. "
                f"Valid options: {sorted(VALID_CHEMISTRIES)}"
            )
        return upper

    model_config = {
        "json_schema_extra": {
            "examples": [
                {
                    "chemistry": "LCO",
                    "cap_pct": 0.82,
                    "capacity": 0.90,
                    "charge_time": 3720,
                    "voltage_mean": 3.68,
                    "energy": 3.31,
                    "temperature": 25.0,
                    "int_resistance": 0.025,
                    "cap_slope": -0.0008,
                    "delta_cap": -0.003,
                    "n_cycles": 15,
                    "dod_pct": 80.0,
                }
            ]
        }
    }


class PredictResponse(BaseModel):
    """RUL prediction result with uncertainty bounds and health metadata."""

    predicted_rul: float = Field(description="Point-estimate predicted RUL in cycles.")
    lower_bound: float = Field(description="Lower bound of 85 % confidence interval.")
    upper_bound: float = Field(description="Upper bound of 85 % confidence interval.")
    health_score: float = Field(
        description="State-of-Health score as a percentage (0–100).",
        ge=0.0,
        le=100.0,
    )
    phase: str = Field(
        description="Degradation phase: Fresh | Aging | Knee | Near-EOL"
    )
    chemistry: str = Field(description="Resolved battery chemistry.")
    model: str = Field(description="Model identifier / description.")
    inputs_used: Optional[dict[str, Any]] = Field(
        default=None,
        description="Echo of key model inputs and calibration constants.",
    )


# ---------------------------------------------------------------------------
# Dataset / cell data
# ---------------------------------------------------------------------------

class CellData(BaseModel):
    """Time-series data for a single battery cell."""

    cell_id: str = Field(description="Unique cell identifier, e.g. 'CS2_37'.")
    dataset: str = Field(description="Source dataset name, e.g. 'CALCE_CS2_orig'.")
    chemistry: str = Field(description="Battery chemistry string.")
    chemistry_code: Optional[int] = Field(
        default=None,
        description="Integer chemistry code: 0=LCO, 1=LFP, 2=NMC, 3=NCM.",
    )
    cycles: list[int] = Field(description="Cycle numbers (1-indexed).")
    capacity: list[float] = Field(description="Discharge capacity per cycle in Ah.")
    rul: list[float] = Field(description="Remaining useful life per cycle in cycles.")
    soh: Optional[list[float]] = Field(
        default=None,
        description="State-of-Health (cap_pct = Q_i / Q_0) per cycle.",
    )
    cum_energy: Optional[list[float]] = Field(
        default=None,
        description="Cumulative energy throughput per cycle in Wh (diagnostic only).",
    )

    @model_validator(mode="after")
    def check_array_lengths(self) -> "CellData":
        n = len(self.cycles)
        if len(self.capacity) != n:
            raise ValueError("capacity must have same length as cycles.")
        if len(self.rul) != n:
            raise ValueError("rul must have same length as cycles.")
        if self.soh is not None and len(self.soh) != n:
            raise ValueError("soh must have same length as cycles.")
        if self.cum_energy is not None and len(self.cum_energy) != n:
            raise ValueError("cum_energy must have same length as cycles.")
        return self


# ---------------------------------------------------------------------------
# Benchmark results
# ---------------------------------------------------------------------------

class PartialCycleRequest(BaseModel):
    """
    Raw partial-cycle trace for RUL prediction without complete cycle data.

    Accepts whatever discharge window the BMS captured (e.g. 30-80% SOC).
    The backend reconstructs full-cycle features and applies conformal uncertainty.
    """
    chemistry: str = Field(default="NMC",
        description="Battery chemistry: LCO | LFP | NMC | NCM | NCA")
    model_id: str = Field(default="v10-final",
        description="Model checkpoint to use")

    # Raw trace arrays (must all be same length)
    voltage:     list[float] = Field(description="Discharge voltage samples [V]")
    current:     list[float] = Field(description="Discharge current samples [A], positive=discharge")
    time_s:      list[float] = Field(description="Time stamps [seconds] relative to cycle start")
    temperature: list[float] = Field(description="Cell temperature samples [°C]")

    # Optional context to improve completeness estimation
    soc_start:        Optional[float] = Field(default=None, ge=0.0, le=1.0,
        description="SOC at start of captured window (0-1). Improves completeness estimate.")
    soc_end:          Optional[float] = Field(default=None, ge=0.0, le=1.0,
        description="SOC at end of captured window (0-1). Improves completeness estimate.")
    nom_capacity_ah:  Optional[float] = Field(default=None, ge=0.0,
        description="Nameplate capacity in Ah. Enables current-integration completeness.")
    charge_time_s:    Optional[float] = Field(default=None, ge=0.0,
        description="Duration of preceding charge step in seconds.")

    # History for rolling-slope feature (optional but improves accuracy)
    capacity_history: Optional[list[float]] = Field(default=None,
        description="Last ≤30 cycle capacities [Ah] in chronological order. "
                    "Enables discharge_slope feature without accumulator.")

    # Operating-condition fields (same semantics as PredictRequest)
    n_cycles: Optional[int] = Field(
        default=None, ge=0,
        description="Observed cycles so far. When <30, blends with chemistry prior (cold-start).",
    )
    dod_pct: Optional[float] = Field(
        default=None, ge=5.0, le=100.0,
        description="Depth of Discharge in percent. Default 100 = full discharge.",
    )

    @field_validator("chemistry")
    @classmethod
    def validate_chemistry(cls, v: str) -> str:
        upper = v.upper()
        if upper not in VALID_CHEMISTRIES:
            raise ValueError(f"chemistry='{v}' not recognised. Valid: {sorted(VALID_CHEMISTRIES)}")
        return upper

    @model_validator(mode="after")
    def check_array_lengths(self) -> "PartialCycleRequest":
        n = len(self.voltage)
        if n < 2:
            raise ValueError("voltage must have at least 2 samples")
        for name, arr in [("current", self.current), ("time_s", self.time_s),
                           ("temperature", self.temperature)]:
            if len(arr) != n:
                raise ValueError(f"{name} must have same length as voltage ({n})")
        return self


class BenchmarkResult(BaseModel):
    """Single row in the model comparison table."""

    model: str = Field(description="Model name / version.")
    family: Optional[str] = Field(
        default=None,
        description="Model family: Mamba-SSM | Attention | RNN | Hybrid CNN-SSM",
    )
    rmse: float = Field(description="Root Mean Squared Error in cycles.", ge=0.0)
    mae: Optional[float] = Field(
        default=None,
        description="Mean Absolute Error in cycles.",
        ge=0.0,
    )
    r2: float = Field(description="Coefficient of determination R².", le=1.0)
    params: Optional[int] = Field(
        default=None,
        description="Number of trainable parameters.",
        ge=0,
    )
    chemistry: Optional[str] = Field(
        default=None,
        description="Chemistry / dataset evaluated on.",
    )
    notes: Optional[str] = Field(
        default=None,
        description="Free-text notes about this result.",
    )


# ---------------------------------------------------------------------------
# Pack-level prediction
# ---------------------------------------------------------------------------

class PackCellInput(BaseModel):
    """Single cell within a pack prediction request."""
    cell_id: str = Field(default="cell", description="Unique label for this cell.")
    chemistry: str = Field(default="NMC")
    cap_pct: float = Field(default=0.90, ge=0.0, le=1.0)
    capacity: Optional[float] = Field(default=None, ge=0.0)
    int_resistance: Optional[float] = Field(default=None, ge=0.0)
    temperature: Optional[float] = Field(default=None)
    voltage_mean: Optional[float] = Field(default=None)
    n_cycles: Optional[int] = Field(default=None, ge=0)
    dod_pct: Optional[float] = Field(default=None, ge=5.0, le=100.0)
    nom_capacity: Optional[float] = Field(default=None, ge=0.0)

    @field_validator("chemistry")
    @classmethod
    def validate_chemistry(cls, v: str) -> str:
        upper = v.upper()
        if upper not in VALID_CHEMISTRIES:
            raise ValueError(f"chemistry='{v}' not recognised. Valid: {sorted(VALID_CHEMISTRIES)}")
        return upper


class PackPredictRequest(BaseModel):
    """
    Pack-level RUL prediction.

    topology:
      - "series"          — pack fails at weakest cell (e.g. 96S EV string)
      - "parallel"        — capacity-weighted mean (e.g. 2P bus)
      - "series_parallel" — Ns series groups × Np parallel per group (e.g. 96S2P)
    """
    cells: list[PackCellInput] = Field(
        min_length=1, max_length=512,
        description="List of cells in the pack (up to 512)."
    )
    topology: str = Field(
        default="series",
        description="Pack wiring: 'series' | 'parallel' | 'series_parallel'",
    )
    ns: int = Field(default=1, ge=1, description="Series cells (or groups) — used with series_parallel.")
    np: int = Field(default=1, ge=1, description="Parallel cells per group — used with series_parallel.")
    model_id: str = Field(default="v10-final")
    pack_name: Optional[str] = Field(default=None, description="Optional label for this pack.")


# ---------------------------------------------------------------------------
# Pack-level prediction from partial-cycle BMS traces
# ---------------------------------------------------------------------------

class PackPartialCellInput(BaseModel):
    """One cell in a pack, described by a raw partial-cycle V/I/t/T trace."""
    cell_id: str = Field(default="cell", description="Unique label for this cell.")
    chemistry: str = Field(default="NMC")

    # Raw trace (same contract as PartialCycleRequest)
    voltage:     list[float] = Field(description="Discharge voltage samples [V]")
    current:     list[float] = Field(description="Discharge current samples [A], positive=discharge")
    time_s:      list[float] = Field(description="Time stamps [s] relative to cycle start")
    temperature: list[float] = Field(description="Cell temperature samples [°C]")

    # Optional context for feature reconstruction
    soc_start:       Optional[float] = Field(default=None, ge=0.0, le=1.0)
    soc_end:         Optional[float] = Field(default=None, ge=0.0, le=1.0)
    nom_capacity_ah: Optional[float] = Field(default=None, ge=0.0)
    charge_time_s:   Optional[float] = Field(default=None, ge=0.0)
    capacity_history: Optional[list[float]] = Field(default=None)

    # Operating conditions
    n_cycles: Optional[int]   = Field(default=None, ge=0)
    dod_pct:  Optional[float] = Field(default=None, ge=5.0, le=100.0)

    @field_validator("chemistry")
    @classmethod
    def validate_chemistry(cls, v: str) -> str:
        upper = v.upper()
        if upper not in VALID_CHEMISTRIES:
            raise ValueError(f"chemistry='{v}' not recognised. Valid: {sorted(VALID_CHEMISTRIES)}")
        return upper

    @model_validator(mode="after")
    def check_array_lengths(self) -> "PackPartialCellInput":
        n = len(self.voltage)
        if n < 2:
            raise ValueError("voltage must have at least 2 samples")
        for name, arr in [("current", self.current), ("time_s", self.time_s),
                           ("temperature", self.temperature)]:
            if len(arr) != n:
                raise ValueError(f"{name} must have same length as voltage ({n})")
        return self


class PackPartialRequest(BaseModel):
    """Pack-level RUL prediction from raw per-cell BMS traces."""
    cells: list[PackPartialCellInput] = Field(
        min_length=1, max_length=128,
        description="One trace entry per cell in the pack."
    )
    topology: str = Field(default="series",
        description="Pack wiring: 'series' | 'parallel' | 'series_parallel'")
    ns: int = Field(default=1, ge=1)
    np: int = Field(default=1, ge=1)
    model_id: str = Field(default="v10-final")
    pack_name: Optional[str] = Field(default=None)


# ---------------------------------------------------------------------------
# DoD exponent calibration
# ---------------------------------------------------------------------------

class DodObservation(BaseModel):
    """A single (DoD, observed-RUL-ratio) measurement for k-fitting."""
    dod_pct: float = Field(ge=5.0, le=99.0, description="Actual DoD in percent (5–99).")
    rul_multiplier: Optional[float] = Field(
        default=None, gt=0,
        description="Direct RUL ratio: observed_rul(at this DoD) / rul_at_100pct."
    )
    rul_at_100pct: Optional[float] = Field(
        default=None, gt=0,
        description="Expected RUL at 100% DoD (same cell type / SOH)."
    )
    observed_rul: Optional[float] = Field(
        default=None, gt=0,
        description="Observed RUL at this DoD. Pair with rul_at_100pct."
    )


class DodCalibrationRequest(BaseModel):
    """Fit DoD exponent k from user-measured (DoD, RUL) pairs."""
    chemistry: str = Field(default="NMC")
    observations: list[DodObservation] = Field(
        min_length=2,
        description="At least 2 observations needed to fit k."
    )

    @field_validator("chemistry")
    @classmethod
    def validate_chemistry(cls, v: str) -> str:
        upper = v.upper()
        if upper not in VALID_CHEMISTRIES:
            raise ValueError(f"chemistry='{v}' not recognised. Valid: {sorted(VALID_CHEMISTRIES)}")
        return upper

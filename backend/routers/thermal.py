"""
routers/thermal.py — Thermal analysis endpoints.

POST /api/thermal/analyze          full thermal analysis for an arbitrary cell array
GET  /api/thermal/pack/{pack_id}   thermal analysis of a stored pack (latest telemetry)
GET  /api/thermal/risk-map         fleet-level thermal risk summary
"""
from __future__ import annotations
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)
router = APIRouter()


class CellThermalData(BaseModel):
    cell_id:     str   = "cell"
    temp_c:      float = Field(..., description="Current temperature °C")
    prev_temp_c: Optional[float] = Field(None, description="Previous snapshot °C (for rate-of-rise)")
    soh:         float = Field(1.0, ge=0.0, le=1.0)
    current_a:   float = Field(0.0, description="Discharge current A")
    capacity_ah: float = Field(5.0, ge=0)


class ThermalAnalysisRequest(BaseModel):
    pack_id:    str  = "pack"
    cells:      list[CellThermalData]
    topology:   str  = Field("series", pattern="^(series|parallel|series-parallel)$")
    dt_seconds: float = Field(1.0, gt=0, description="Seconds since last snapshot")


@router.post("/thermal/analyze", summary="Full thermal analysis for a cell array")
def thermal_analyze(req: ThermalAnalysisRequest):
    from core.thermal_model import full_thermal_analysis
    cell_ids    = [c.cell_id    for c in req.cells]
    temps       = [c.temp_c     for c in req.cells]
    prev_temps  = [c.prev_temp_c if c.prev_temp_c is not None else c.temp_c for c in req.cells]
    sohs        = [c.soh        for c in req.cells]
    currents    = [c.current_a  for c in req.cells]
    capacities  = [c.capacity_ah for c in req.cells]

    result = full_thermal_analysis(
        cell_ids    = cell_ids,
        temperatures = temps,
        sohs        = sohs,
        currents    = currents,
        capacities_ah = capacities,
        prev_temps  = prev_temps,
        dt_seconds  = req.dt_seconds,
        topology    = req.topology,
    )
    result["pack_id"] = req.pack_id
    return result


@router.get("/thermal/pack/{pack_id}", summary="Thermal analysis for a stored pack")
def thermal_pack(pack_id: str, topology: str = "series"):
    """
    Fetch latest temperature + current telemetry for all cells in a pack,
    then run full thermal analysis.
    """
    from core.thermal_model import full_thermal_analysis
    try:
        from core.db import _conn
        with _conn() as con:
            cells_rows = con.execute(
                "SELECT cell_id FROM pack_cells WHERE pack_id = ?", (pack_id,)
            ).fetchall()
        if not cells_rows:
            raise HTTPException(404, f"Pack '{pack_id}' not found or has no cells")

        cell_ids   = []
        temps      = []
        currents   = []
        sohs       = []
        capacities = []

        for row in cells_rows:
            cid = row["cell_id"]
            with _conn() as con:
                tel = con.execute(
                    "SELECT temperature, current, soc FROM cell_timeseries "
                    "WHERE cell_id=? ORDER BY ts DESC LIMIT 1",
                    (cid,)
                ).fetchone()
            cell_ids.append(cid)
            temps.append(float(tel["temperature"]) if tel and tel["temperature"] else 25.0)
            currents.append(float(tel["current"]) if tel and tel["current"] else 0.0)
            soh = float(tel["soc"]) / 100.0 if tel and tel["soc"] else 0.90
            sohs.append(soh)
            capacities.append(5.0)

        result = full_thermal_analysis(
            cell_ids    = cell_ids,
            temperatures = temps,
            sohs        = sohs,
            currents    = currents,
            capacities_ah = capacities,
            topology    = topology,
        )
        result["pack_id"] = pack_id
        return result

    except HTTPException:
        raise
    except Exception as exc:
        logger.warning("thermal pack analysis failed: %s", exc)
        raise HTTPException(500, str(exc))


@router.get("/thermal/risk-map", summary="Fleet-level thermal risk summary")
def thermal_risk_map():
    """Return thermal risk levels for all packs in the DB."""
    from core.thermal_model import analyze_pack
    try:
        from core.db import _conn
        with _conn() as con:
            packs = con.execute("SELECT id, name FROM packs").fetchall()

        summaries = []
        for pack in packs:
            pid = pack["id"]
            with _conn() as con:
                cells_rows = con.execute(
                    "SELECT cell_id FROM pack_cells WHERE pack_id=?", (pid,)
                ).fetchall()
            if not cells_rows:
                continue

            cell_ids = []
            temps    = []
            for row in cells_rows:
                with _conn() as con:
                    tel = con.execute(
                        "SELECT temperature FROM cell_timeseries "
                        "WHERE cell_id=? ORDER BY ts DESC LIMIT 1",
                        (row["cell_id"],)
                    ).fetchone()
                cell_ids.append(row["cell_id"])
                temps.append(float(tel["temperature"]) if tel and tel["temperature"] else 25.0)

            state = analyze_pack(cell_ids, temps)
            summaries.append({
                "pack_id":      pid,
                "pack_name":    pack["name"],
                "mean_temp_c":  state.mean_temp,
                "max_temp_c":   state.max_temp,
                "gradient_c":   state.gradient_c,
                "runaway_risk": state.runaway_risk,
                "runaway_alert": state.runaway_alert,
                "n_hotspots":   len(state.hotspots),
                "n_cells":      len(cell_ids),
            })

        summaries.sort(key=lambda x: -x["runaway_risk"])
        return {"n_packs": len(summaries), "packs": summaries}

    except Exception as exc:
        logger.debug("thermal risk map: %s", exc)
        return {"n_packs": 0, "packs": []}


class CouplingTrace(BaseModel):
    cell_ids:     Optional[list[str]] = None
    temperatures: list[list[float]]   = Field(..., description="N x T °C history")
    currents:     Optional[list[list[float]]] = None
    voltages:     Optional[list[list[float]]] = None
    dt_seconds:   float = 1.0


@router.post("/thermal/coupling/predict", summary="LSTM + cross-cell attention pack thermal prediction")
def thermal_coupling_predict(req: CouplingTrace):
    from core.thermal_coupling_lstm import predict_pack
    try:
        return predict_pack(
            temperatures=req.temperatures, currents=req.currents,
            voltages=req.voltages, cell_ids=req.cell_ids, dt_seconds=req.dt_seconds,
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"thermal coupling predict: {exc}")


@router.get("/thermal/coupling/status", summary="Thermal coupling LSTM checkpoint status")
def thermal_coupling_status():
    from core.thermal_coupling_lstm import status
    return status()


class CouplingTrainRequest(BaseModel):
    traces:        list[CouplingTrace]
    epochs:        int   = 50
    lr:            float = 1e-3
    batch_size:    int   = 4
    d_hidden:      int   = 64
    n_heads:       int   = 4
    lstm_layers:   int   = 1


class RunawaySimRequest(BaseModel):
    N:            int   = 4
    Cth:          float = 80.0
    Rint:         float = 0.04
    Rcoup:        float = 1.5
    Rext:         float = 8.0
    T_amb:        float = 25.0
    I_load:       float = 30.0
    T_trigger:    float = 120.0
    Q_decomp:     float = 1.5e5
    tau_decomp:   float = 8.0
    Ea_over_R:    float = 12000.0
    trigger_cell: int   = 1
    trigger_at:   float = 5.0
    stopTime:     float = 60.0
    stepSize:     float = 0.5
    prefer:       str   = "auto"


@router.post("/thermal/runaway/simulate", summary="OpenModelica thermal-runaway propagation (fallback if omc missing)")
def runaway_simulate(req: RunawaySimRequest):
    from core.openmodelica_runner import simulate, ThermalRunawayParams
    p = ThermalRunawayParams(
        N=req.N, Cth=req.Cth, Rint=req.Rint, Rcoup=req.Rcoup, Rext=req.Rext,
        T_amb=req.T_amb, I_load=req.I_load, T_trigger=req.T_trigger,
        Q_decomp=req.Q_decomp, tau_decomp=req.tau_decomp,
        Ea_over_R=req.Ea_over_R, trigger_cell=req.trigger_cell,
        trigger_at=req.trigger_at, stopTime=req.stopTime, stepSize=req.stepSize,
    )
    return simulate(p, prefer=req.prefer)


@router.get("/thermal/runaway/status", summary="OpenModelica runner availability")
def runaway_status():
    from core.openmodelica_runner import status
    return status()


@router.post("/thermal/coupling/train", summary="Train the thermal coupling LSTM on provided traces")
def thermal_coupling_train(req: CouplingTrainRequest):
    from core.thermal_coupling_lstm import train_on_pack_traces
    traces = [t.model_dump() for t in req.traces]
    try:
        return train_on_pack_traces(
            traces, epochs=req.epochs, lr=req.lr, batch_size=req.batch_size,
            d_hidden=req.d_hidden, n_heads=req.n_heads, lstm_layers=req.lstm_layers,
        )
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"thermal coupling train: {exc}")

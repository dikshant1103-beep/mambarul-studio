"""
routers/modbus_adapter.py — Modbus TCP adapter for PLC / BMS controllers.

Reads cell voltages, temperatures, and currents from Modbus TCP registers,
converts them to telemetry frames, and feeds the BMS pipeline.

Standard register map (configurable):
  40001–40100  : Cell voltages    (×0.001 V)
  40101–40200  : Cell temperatures (×0.1 °C)
  40201        : Pack current      (×0.01 A, signed)
  40202        : Pack SOC          (×0.1 %)
  40203        : Fault flags       (bitmask)

Endpoints:
  GET  /api/bms/modbus/status     — connection status + register map
  POST /api/bms/modbus/config     — configure Modbus TCP target
  POST /api/bms/modbus/poll       — manually trigger one poll cycle
  POST /api/bms/modbus/start-poll — start automatic polling (interval seconds)
  POST /api/bms/modbus/stop-poll  — stop automatic polling
"""
from __future__ import annotations
import logging
import threading
import time
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()
logger = logging.getLogger(__name__)

_modbus_cfg = {
    "host":        "",
    "port":        502,
    "unit_id":     1,
    "connected":   False,
    "poll_active": False,
    "poll_interval": 5,
    "cells":       8,         # number of cells to read
    "pack_id":     "PACK-MB-01",
    "chemistry":   "NMC",
    "capacity_ah": 5.0,
}
_modbus_client    = None
_poll_thread      = None
_poll_stop        = threading.Event()


def get_modbus_status() -> dict:
    return {k: v for k, v in _modbus_cfg.items()}


def _get_client():
    global _modbus_client
    if _modbus_client:
        return _modbus_client
    if not _modbus_cfg["host"]:
        return None
    try:
        from pymodbus.client import ModbusTcpClient
        client = ModbusTcpClient(_modbus_cfg["host"], port=_modbus_cfg["port"],
                                  timeout=5)
        if client.connect():
            _modbus_client = client
            _modbus_cfg["connected"] = True
            logger.info("Modbus TCP connected to %s:%d", _modbus_cfg["host"], _modbus_cfg["port"])
        else:
            _modbus_cfg["connected"] = False
    except Exception as exc:
        logger.warning("Modbus connect failed: %s", exc)
        _modbus_cfg["connected"] = False
    return _modbus_client


def _poll_once() -> list[dict]:
    """Read one full cycle from the Modbus device."""
    client = _get_client()
    if not client:
        return []
    try:
        from pymodbus.exceptions import ModbusException
        n = _modbus_cfg["cells"]
        unit = _modbus_cfg["unit_id"]
        frames = []

        # Read voltages: registers 40001-40100 (address 0-99)
        v_resp = client.read_holding_registers(0, count=n, slave=unit)
        # Read temperatures: registers 40101-40200 (address 100-199)
        t_resp = client.read_holding_registers(100, count=n, slave=unit)
        # Read pack current: register 40201 (address 200)
        i_resp = client.read_holding_registers(200, count=1, slave=unit)

        if v_resp.isError() or t_resp.isError() or i_resp.isError():
            logger.warning("Modbus read error")
            return []

        volts = [r * 0.001 for r in v_resp.registers]
        temps = [r * 0.1   for r in t_resp.registers]
        # Signed current (16-bit two's complement)
        raw_i = i_resp.registers[0]
        current = (raw_i if raw_i < 32768 else raw_i - 65536) * 0.01

        from routers.bms_telemetry import TelemetryFrame, process_frame
        for i in range(n):
            f = TelemetryFrame(
                cell_id     = f"MB-{_modbus_cfg['pack_id']}-{i+1:03d}",
                voltage     = volts[i],
                current     = current,
                temperature = temps[i],
                pack_id     = _modbus_cfg["pack_id"],
                chemistry   = _modbus_cfg["chemistry"],
                capacity_ah = _modbus_cfg["capacity_ah"],
                source      = "modbus",
            )
            r = process_frame(f)
            frames.append(r)
        return frames
    except Exception as exc:
        logger.warning("Modbus poll error: %s", exc)
        _modbus_cfg["connected"] = False
        _modbus_client = None
        return []


def _poll_loop():
    while not _poll_stop.wait(_modbus_cfg["poll_interval"]):
        _poll_once()


# ── Endpoints ─────────────────────────────────────────────────────────────────

class ModbusConfig(BaseModel):
    host:        str
    port:        int   = Field(502, ge=1, le=65535)
    unit_id:     int   = Field(1, ge=1, le=247)
    cells:       int   = Field(8, ge=1, le=200)
    pack_id:     str   = "PACK-MB-01"
    chemistry:   str   = "NMC"
    capacity_ah: float = 5.0


class PollConfig(BaseModel):
    interval_seconds: int = Field(5, ge=1, le=3600)


@router.get("/bms/modbus/status", summary="Modbus adapter status")
def modbus_status() -> dict:
    return get_modbus_status()


@router.post("/bms/modbus/config", summary="Configure Modbus TCP connection")
def configure_modbus(body: ModbusConfig) -> dict:
    global _modbus_client
    _modbus_client = None          # force reconnect
    _modbus_cfg.update(
        host=body.host, port=body.port, unit_id=body.unit_id,
        cells=body.cells, pack_id=body.pack_id,
        chemistry=body.chemistry, capacity_ah=body.capacity_ah,
        connected=False,
    )
    client = _get_client()
    if not client:
        raise HTTPException(503, f"Cannot connect to Modbus TCP at {body.host}:{body.port}")
    return {"ok": True, "connected": _modbus_cfg["connected"]}


@router.post("/bms/modbus/poll", summary="Trigger one Modbus poll cycle")
def manual_poll() -> dict:
    if not _modbus_cfg["host"]:
        raise HTTPException(400, "Modbus not configured. POST /api/bms/modbus/config first.")
    frames = _poll_once()
    return {"polled": len(frames), "frames": frames}


@router.post("/bms/modbus/start-poll", summary="Start automatic Modbus polling")
def start_poll(body: PollConfig) -> dict:
    global _poll_thread
    _modbus_cfg["poll_interval"] = body.interval_seconds
    _poll_stop.clear()
    if not _poll_thread or not _poll_thread.is_alive():
        _poll_thread = threading.Thread(target=_poll_loop, daemon=True,
                                         name="modbus-poller")
        _poll_thread.start()
        _modbus_cfg["poll_active"] = True
    return {"ok": True, "interval_seconds": body.interval_seconds}


@router.post("/bms/modbus/stop-poll", summary="Stop automatic Modbus polling")
def stop_poll() -> dict:
    _poll_stop.set()
    _modbus_cfg["poll_active"] = False
    return {"ok": True}

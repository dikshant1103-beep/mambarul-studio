"""
routers/bms_control.py — Control command API.

Commands are logged to bms_commands table and published to the configured
MQTT broker so the BMS hardware receives them.

Endpoints:
  POST /api/bms/control/charge-cutoff   — cut off charging on a cell/pack
  POST /api/bms/control/discharge-cutoff — cut off discharging
  POST /api/bms/control/balance         — trigger cell balancing
  POST /api/bms/control/thermal         — thermal management action
  POST /api/bms/control/emergency-stop  — full emergency stop
  GET  /api/bms/control/commands        — command history
  POST /api/bms/control/{id}/ack        — acknowledge command
"""
from __future__ import annotations
import json
import logging
from typing import Optional
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

router = APIRouter()
logger = logging.getLogger(__name__)


def _publish_mqtt(topic: str, payload: dict) -> bool:
    """Best-effort MQTT publish for control commands."""
    try:
        from routers.can_ingest import get_mqtt_client
        client = get_mqtt_client()
        if client:
            client.publish(topic, json.dumps(payload), qos=1)
            return True
    except Exception as exc:
        logger.debug("MQTT publish failed: %s", exc)
    return False


class ChargeCutoffRequest(BaseModel):
    target_id:   str
    enabled:     bool = True
    reason:      str  = "manual"
    issued_by:   str  = "admin"


class BalanceRequest(BaseModel):
    pack_id:        str
    target_voltage: float = 3.65
    cells:          list[str] = []     # empty = balance all
    issued_by:      str = "admin"


class ThermalRequest(BaseModel):
    target_id: str
    action:    str = "cool"            # cool / heat / emergency_stop
    issued_by: str = "admin"


class EmergencyStopRequest(BaseModel):
    target_id: str
    reason:    str = "manual"
    issued_by: str = "admin"


@router.post("/bms/control/charge-cutoff", summary="Cut off charging")
def charge_cutoff(body: ChargeCutoffRequest) -> dict:
    from core.db import log_command, ack_command
    params = {"enabled": body.enabled, "reason": body.reason}
    cmd_id = log_command("charge_cutoff", body.target_id, params, body.issued_by)
    ok = _publish_mqtt(f"batteryos/control/{body.target_id}/charge_cutoff",
                       {"enabled": body.enabled, "cmd_id": cmd_id, "reason": body.reason})
    ack_command(cmd_id, "sent" if ok else "pending")
    logger.info("Charge cutoff %s → %s (mqtt=%s)", body.target_id, body.enabled, ok)
    return {"ok": True, "cmd_id": cmd_id, "mqtt_delivered": ok}


@router.post("/bms/control/discharge-cutoff", summary="Cut off discharging")
def discharge_cutoff(body: ChargeCutoffRequest) -> dict:
    from core.db import log_command, ack_command
    params = {"enabled": body.enabled, "reason": body.reason}
    cmd_id = log_command("discharge_cutoff", body.target_id, params, body.issued_by)
    ok = _publish_mqtt(f"batteryos/control/{body.target_id}/discharge_cutoff",
                       {"enabled": body.enabled, "cmd_id": cmd_id})
    ack_command(cmd_id, "sent" if ok else "pending")
    return {"ok": True, "cmd_id": cmd_id, "mqtt_delivered": ok}


@router.post("/bms/control/balance", summary="Trigger cell balancing")
def trigger_balance(body: BalanceRequest) -> dict:
    from core.db import log_command, ack_command
    params = {"target_voltage": body.target_voltage, "cells": body.cells}
    cmd_id = log_command("balance", body.pack_id, params, body.issued_by)
    ok = _publish_mqtt(f"batteryos/control/{body.pack_id}/balance",
                       {"target_voltage": body.target_voltage,
                        "cells": body.cells, "cmd_id": cmd_id})
    ack_command(cmd_id, "sent" if ok else "pending")
    return {"ok": True, "cmd_id": cmd_id, "mqtt_delivered": ok}


@router.post("/bms/control/thermal", summary="Thermal management command")
def thermal_command(body: ThermalRequest) -> dict:
    if body.action not in ("cool", "heat", "emergency_stop"):
        raise HTTPException(422, "action must be: cool | heat | emergency_stop")
    from core.db import log_command, ack_command
    params = {"action": body.action}
    cmd_id = log_command("thermal", body.target_id, params, body.issued_by)
    ok = _publish_mqtt(f"batteryos/control/{body.target_id}/thermal",
                       {"action": body.action, "cmd_id": cmd_id})
    ack_command(cmd_id, "sent" if ok else "pending")
    return {"ok": True, "cmd_id": cmd_id, "mqtt_delivered": ok}


@router.post("/bms/control/emergency-stop", summary="Emergency stop all operations")
def emergency_stop(body: EmergencyStopRequest) -> dict:
    from core.db import log_command, ack_command, record_safety_event
    params = {"reason": body.reason}
    cmd_id = log_command("emergency_stop", body.target_id, params, body.issued_by)
    # Log safety event
    record_safety_event(body.target_id, body.target_id, "emergency_stop",
                        "trip", 0.0, 0.0, source="manual")
    ok = _publish_mqtt(f"batteryos/control/{body.target_id}/emergency_stop",
                       {"reason": body.reason, "cmd_id": cmd_id})
    ack_command(cmd_id, "sent" if ok else "pending")
    logger.warning("EMERGENCY STOP: target=%s reason=%s", body.target_id, body.reason)
    return {"ok": True, "cmd_id": cmd_id, "mqtt_delivered": ok}


@router.get("/bms/control/commands", summary="Command history")
def command_history(limit: int = 100) -> list:
    from core.db import get_commands
    return get_commands(limit=limit)


@router.post("/bms/control/{cmd_id}/ack", summary="Acknowledge a command")
def ack_command_endpoint(cmd_id: str) -> dict:
    from core.db import ack_command
    ack_command(cmd_id, "ack")
    return {"ok": True}

"""
routers/can_ingest.py — CAN bus + MQTT adapter.

CAN bus: uses python-can with socketcan (Linux) or virtual bus for testing.
MQTT:    paho-mqtt subscriber runs in background thread, feeds process_frame().

Endpoints:
  GET  /api/bms/adapters/status     — adapter status (MQTT, CAN, Modbus)
  POST /api/bms/adapters/mqtt       — configure MQTT broker
  POST /api/bms/adapters/can        — configure CAN interface
  POST /api/bms/can/frame           — inject CAN frame (dev/test mode)
  POST /api/bms/simulate            — push simulated telemetry (dev mode)
"""
from __future__ import annotations
import json
import logging
import threading
import time
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router  = APIRouter()
logger  = logging.getLogger(__name__)

# ── MQTT state ────────────────────────────────────────────────────────────────
_mqtt_client  = None
_mqtt_cfg     = {"host": "", "port": 1883, "user": "", "password": "", "connected": False}
_mqtt_thread  = None
_mqtt_stop    = threading.Event()

# ── CAN state ─────────────────────────────────────────────────────────────────
_can_bus      = None
_can_cfg      = {"interface": "", "channel": "", "bitrate": 500000, "connected": False}
_can_thread   = None
_can_stop     = threading.Event()


def get_mqtt_client():
    return _mqtt_client


# ── MQTT subscriber ───────────────────────────────────────────────────────────

def _on_mqtt_connect(client, userdata, flags, rc):
    if rc == 0:
        _mqtt_cfg["connected"] = True
        client.subscribe("batteryos/#", qos=1)
        logger.info("MQTT connected, subscribed to batteryos/#")
    else:
        _mqtt_cfg["connected"] = False
        logger.warning("MQTT connect failed rc=%d", rc)


def _on_mqtt_disconnect(client, userdata, rc):
    _mqtt_cfg["connected"] = False
    logger.warning("MQTT disconnected rc=%d", rc)


def _on_mqtt_message(client, userdata, msg):
    try:
        payload = json.loads(msg.payload.decode())
        topic   = msg.topic  # e.g. batteryos/cell/CELL-001/telemetry
        parts   = topic.split("/")
        if len(parts) >= 4 and parts[1] == "cell" and parts[3] == "telemetry":
            cell_id = parts[2]
            from routers.bms_telemetry import TelemetryFrame, process_frame
            frame = TelemetryFrame(
                cell_id     = cell_id,
                voltage     = float(payload.get("voltage", 3.7)),
                current     = float(payload.get("current", 0.0)),
                temperature = float(payload.get("temperature", 25.0)),
                pack_id     = payload.get("pack_id", ""),
                cycle_num   = payload.get("cycle_num"),
                capacity_ah = float(payload.get("capacity_ah", 5.0)),
                chemistry   = payload.get("chemistry", "NMC"),
                source      = "mqtt",
            )
            process_frame(frame)
    except Exception as exc:
        logger.debug("MQTT message parse error: %s", exc)


def start_mqtt(host: str, port: int = 1883, user: str = "", password: str = "") -> bool:
    global _mqtt_client, _mqtt_thread
    try:
        import paho.mqtt.client as mqtt_client
        _mqtt_cfg.update(host=host, port=port, user=user, password=password)
        client = mqtt_client.Client(client_id="batteryos-studio", clean_session=True)
        client.on_connect    = _on_mqtt_connect
        client.on_disconnect = _on_mqtt_disconnect
        client.on_message    = _on_mqtt_message
        if user:
            client.username_pw_set(user, password)
        client.connect_async(host, port, keepalive=60)
        client.loop_start()
        _mqtt_client = client
        logger.info("MQTT adapter started → %s:%d", host, port)
        return True
    except Exception as exc:
        logger.warning("MQTT start failed: %s", exc)
        return False


def stop_mqtt():
    global _mqtt_client
    if _mqtt_client:
        try:
            _mqtt_client.loop_stop()
            _mqtt_client.disconnect()
        except Exception:
            pass
        _mqtt_client = None
        _mqtt_cfg["connected"] = False


# ── CAN bus listener ──────────────────────────────────────────────────────────

# Generic CAN signal map: CAN ID → (signal_name, byte_offset, scale, unit)
# Override via /api/bms/adapters/can endpoint.
_can_signal_map: dict[int, dict] = {
    0x100: {"type": "voltage",     "scale": 0.001, "cell_base": 0},
    0x200: {"type": "temperature", "scale": 0.1,   "cell_base": 0},
    0x300: {"type": "current",     "scale": 0.01,  "pack_id": "PACK-001"},
}

def _decode_can_frame(msg) -> Optional[dict]:
    """Decode a raw CAN frame into a telemetry dict using _can_signal_map."""
    cid = msg.arbitration_id
    if cid not in _can_signal_map:
        return None
    sig = _can_signal_map[cid]
    try:
        data = msg.data
        value = (int(data[0]) << 8 | int(data[1])) * sig["scale"]
        return {"type": sig["type"], "value": value, "can_id": cid}
    except Exception:
        return None


def _can_listener_loop():
    global _can_bus
    while not _can_stop.is_set():
        try:
            if _can_bus is None:
                time.sleep(1)
                continue
            msg = _can_bus.recv(timeout=1.0)
            if msg is None:
                continue
            decoded = _decode_can_frame(msg)
            if decoded:
                logger.debug("CAN frame: %s", decoded)
        except Exception as exc:
            logger.debug("CAN recv error: %s", exc)
            time.sleep(0.5)


def start_can(interface: str = "virtual", channel: str = "vcan0",
              bitrate: int = 500000) -> bool:
    global _can_bus, _can_thread
    try:
        import can
        _can_cfg.update(interface=interface, channel=channel, bitrate=bitrate)
        _can_bus = can.interface.Bus(bustype=interface, channel=channel,
                                     bitrate=bitrate)
        _can_cfg["connected"] = True
        _can_stop.clear()
        _can_thread = threading.Thread(target=_can_listener_loop,
                                       daemon=True, name="can-listener")
        _can_thread.start()
        logger.info("CAN adapter started: %s/%s@%d", interface, channel, bitrate)
        return True
    except Exception as exc:
        logger.warning("CAN start failed: %s", exc)
        _can_cfg["connected"] = False
        return False


# ── Endpoints ─────────────────────────────────────────────────────────────────

class MQTTConfig(BaseModel):
    host:     str
    port:     int  = 1883
    user:     str  = ""
    password: str  = ""


class CANConfig(BaseModel):
    interface: str  = "virtual"
    channel:   str  = "vcan0"
    bitrate:   int  = 500000


class CANFrame(BaseModel):
    can_id:   int
    data:     list[int]   # up to 8 bytes
    cell_id:  str = ""


class SimFrame(BaseModel):
    cell_id:     str
    voltage:     float = 3.75
    current:     float = -2.0
    temperature: float = 28.0
    pack_id:     str   = ""
    chemistry:   str   = "NMC"
    capacity_ah: float = 5.0
    count:       int   = 1    # how many frames to generate


@router.get("/bms/adapters/status", summary="Hardware adapter status")
def adapter_status() -> dict:
    from routers.modbus_adapter import get_modbus_status
    return {
        "mqtt":   {**_mqtt_cfg, "password": "***" if _mqtt_cfg.get("password") else ""},
        "can":    _can_cfg,
        "modbus": get_modbus_status(),
    }


@router.post("/bms/adapters/mqtt", summary="Configure and start MQTT subscriber")
def configure_mqtt(body: MQTTConfig) -> dict:
    stop_mqtt()
    ok = start_mqtt(body.host, body.port, body.user, body.password)
    if not ok:
        raise HTTPException(503, "Could not connect to MQTT broker. Check host/port.")
    return {"ok": True, "host": body.host, "port": body.port}


@router.post("/bms/adapters/can", summary="Configure and start CAN listener")
def configure_can(body: CANConfig) -> dict:
    ok = start_can(body.interface, body.channel, body.bitrate)
    if not ok:
        raise HTTPException(503, "CAN interface failed. Install python-can and check interface name.")
    return {"ok": True, **body.model_dump()}


@router.post("/bms/can/frame", summary="Inject a raw CAN frame (dev/test)")
def inject_can_frame(body: CANFrame) -> dict:
    """Manually inject a CAN frame for development without physical hardware."""
    try:
        import can
        msg = can.Message(arbitration_id=body.can_id,
                          data=bytes(body.data[:8]),
                          is_extended_id=False)
        decoded = _decode_can_frame(msg)
        return {"ok": True, "decoded": decoded}
    except ImportError:
        raise HTTPException(503, "python-can not installed.")


@router.post("/bms/simulate", summary="Push simulated telemetry frames (dev/test)")
def simulate_frames(body: SimFrame) -> dict:
    """Generate and ingest synthetic telemetry — useful for testing without hardware."""
    import random
    from routers.bms_telemetry import TelemetryFrame, process_frame
    results = []
    for i in range(min(body.count, 1000)):
        # Add small random noise
        f = TelemetryFrame(
            cell_id     = body.cell_id,
            voltage     = round(body.voltage + random.uniform(-0.02, 0.02), 4),
            current     = round(body.current + random.uniform(-0.1, 0.1), 3),
            temperature = round(body.temperature + random.uniform(-0.5, 0.5), 2),
            pack_id     = body.pack_id,
            chemistry   = body.chemistry,
            capacity_ah = body.capacity_ah,
            source      = "simulator",
        )
        results.append(process_frame(f))
    return {"simulated": len(results), "trips": sum(1 for r in results if r.get("trip"))}

"""
routers/fleet.py — Persistent cell labels + WebSocket real-time updates.

REST:
  GET  /api/fleet/labels              → { cell_id: {label, tags, notes} }
  POST /api/fleet/labels/{cell_id}    → upsert label/tags/notes
  DELETE /api/fleet/labels/{cell_id}  → remove label

WebSocket:
  WS /api/ws/fleet   — streams fleet prediction updates every 10s
"""
from __future__ import annotations
import asyncio
import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from core.middleware import require_auth

logger = logging.getLogger("batteryos.fleet")
router = APIRouter()

# ── Active WebSocket connections ──────────────────────────────────────────────
_ws_clients: list[WebSocket] = []
_ws_lock = asyncio.Lock()


# ── REST: cell labels ─────────────────────────────────────────────────────────

class LabelUpsert(BaseModel):
    label: str = ""
    tags:  list[str] = []
    notes: str = ""


@router.get("/fleet/labels")
def get_labels(_auth: dict = Depends(require_auth)) -> dict:
    from core.db import get_cell_labels
    return get_cell_labels()


@router.post("/fleet/labels/{cell_id}")
def upsert_label(cell_id: str, body: LabelUpsert,
                 _auth: dict = Depends(require_auth)) -> dict:
    from core.db import upsert_cell_label
    upsert_cell_label(cell_id, label=body.label,
                      tags=body.tags, notes=body.notes)
    return {"ok": True, "cell_id": cell_id}


@router.delete("/fleet/labels/{cell_id}")
def delete_label(cell_id: str, _auth: dict = Depends(require_auth)) -> dict:
    from core.db import delete_cell_label
    delete_cell_label(cell_id)
    return {"ok": True, "cell_id": cell_id}


# ── WebSocket: real-time fleet updates ───────────────────────────────────────

@router.websocket("/ws/fleet")
async def fleet_ws(ws: WebSocket, token: Optional[str] = None) -> None:
    """
    WebSocket endpoint for live fleet prediction streaming.
    Client sends: { "cells": [ { "cell_id", "chemistry", "cap_pct", ... } ] }
    Server responds: prediction results every 10s (or on demand).
    """
    # Auth check via query param token
    if token:
        from core.db import validate_session
        session = validate_session(token)
        if not session:
            await ws.close(code=4401, reason="Invalid token")
            return
    # In dev allow unauthenticated WebSocket connections
    # (production should always pass token)

    await ws.accept()
    async with _ws_lock:
        _ws_clients.append(ws)

    logger.info("WebSocket client connected (%d total)", len(_ws_clients))

    try:
        # Keep-alive + on-demand prediction loop
        while True:
            try:
                # Wait for a message (with 10s timeout for heartbeat)
                raw = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
                msg = json.loads(raw)
                if msg.get("type") == "ping":
                    await ws.send_text(json.dumps({"type": "pong"}))
                    continue

                # If client sends cell data, run predictions and reply
                if "cells" in msg:
                    result = await _predict_fleet(msg["cells"],
                                                  msg.get("model_id", "v10-final"))
                    await ws.send_text(json.dumps({"type": "update", "data": result}))

            except asyncio.TimeoutError:
                # Push a heartbeat so client knows connection is alive
                await ws.send_text(json.dumps({"type": "heartbeat",
                                               "ts": _utcnow()}))
    except WebSocketDisconnect:
        logger.info("WebSocket client disconnected")
    except Exception as exc:
        logger.warning("WebSocket error: %s", exc)
    finally:
        async with _ws_lock:
            try:
                _ws_clients.remove(ws)
            except ValueError:
                pass


async def _predict_fleet(cells: list[dict], model_id: str) -> list[dict]:
    """Run inference on a list of cell dicts and return results."""
    from core.model_loader import run_inference
    results = []
    for cell in cells[:200]:   # cap at 200 cells per WebSocket message
        cell_id = cell.get("cell_id", "?")
        try:
            r = run_inference(model_id, cell)
            r["cell_id"] = cell_id
            results.append(r)
        except Exception as e:
            results.append({"cell_id": cell_id, "error": str(e)})
    return results


def _utcnow() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


async def broadcast_alert(alert: dict) -> None:
    """Push a new alert to all connected WebSocket clients."""
    msg = json.dumps({"type": "alert", "data": alert})
    dead = []
    for ws in list(_ws_clients):
        try:
            await ws.send_text(msg)
        except Exception:
            dead.append(ws)
    async with _ws_lock:
        for ws in dead:
            try:
                _ws_clients.remove(ws)
            except ValueError:
                pass

"""
BatteryOS Python SDK
====================
Minimal, zero-dependency client for the BatteryOS API.

Usage
-----
from batteryos_sdk import BatteryOSClient

client = BatteryOSClient(base_url="http://localhost:8000", api_key="bos_...")

# Single-cell prediction
result = client.predict(cap_pct=0.85, chemistry="NMC", temperature=25.0)
print(result["rul_cycles"], result["ci_low"], result["ci_high"])

# Batch prediction from a list of dicts
results = client.batch(cells=[
    {"cell_id": "A1", "cap_pct": 0.90, "chemistry": "NMC"},
    {"cell_id": "A2", "cap_pct": 0.72, "chemistry": "LFP", "temperature": 35.0},
])

# Upload CSV and run batch
results = client.batch_csv("my_cells.csv")

# Fine-tune a model
job_id = client.finetune_start("training_data.csv", chemistry="LFP", epochs=50)
status = client.finetune_status(job_id)
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


class BatteryOSError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(f"HTTP {status}: {detail}")
        self.status = status
        self.detail = detail


class BatteryOSClient:
    """Thin HTTP client for the BatteryOS API."""

    def __init__(
        self,
        base_url: str = "http://localhost:8000",
        api_key: str | None = None,
        timeout: int = 30,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key or os.getenv("BATTERYOS_API_KEY", "")
        self.timeout = timeout

    # ── Internal helpers ──────────────────────────────────────────────────

    def _headers(self, extra: dict | None = None) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["X-Api-Key"] = self.api_key
        if extra:
            h.update(extra)
        return h

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("detail", detail)
            except Exception:
                pass
            raise BatteryOSError(exc.code, detail) from exc

    def _upload(self, path: str, file_path: str, fields: dict) -> Any:
        """Multipart upload using stdlib only."""
        boundary = "BatteryOSBoundary7a3f"
        url = f"{self.base_url}{path}"
        parts: list[bytes] = []

        for key, val in fields.items():
            parts.append(
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{val}\r\n".encode()
            )

        fp = Path(file_path)
        file_bytes = fp.read_bytes()
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fp.name}"\r\n'
            f"Content-Type: text/csv\r\n\r\n".encode() + file_bytes + b"\r\n"
        )
        parts.append(f"--{boundary}--\r\n".encode())
        body = b"".join(parts)

        headers = self._headers({"Content-Type": f"multipart/form-data; boundary={boundary}"})
        del headers["Content-Type"]  # rebuild with boundary
        headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        headers["Content-Length"] = str(len(body))

        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            try:
                detail = json.loads(detail).get("detail", detail)
            except Exception:
                pass
            raise BatteryOSError(exc.code, detail) from exc

    # ── Public API ────────────────────────────────────────────────────────

    def health(self) -> dict:
        """Check backend health."""
        return self._request("GET", "/api/health")

    def predict(
        self,
        cap_pct: float,
        chemistry: str = "NMC",
        temperature: float = 25.0,
        int_resistance: float | None = None,
        capacity: float | None = None,
        voltage: float | None = None,
        current: float | None = None,
        cycle_number: int | None = None,
        dod_pct: float = 100.0,
        model_id: str = "v10-final",
        cell_id: str | None = None,
    ) -> dict:
        """
        Run a single-cell RUL prediction.

        Returns
        -------
        dict with keys: rul_cycles, ci_low, ci_high, soh_pct, phase, model_id
        """
        payload: dict = {
            "cap_pct": cap_pct,
            "chemistry": chemistry,
            "temperature": temperature,
            "dod_pct": dod_pct,
            "model_id": model_id,
        }
        if int_resistance is not None:
            payload["int_resistance"] = int_resistance
        if capacity is not None:
            payload["capacity"] = capacity
        if voltage is not None:
            payload["voltage"] = voltage
        if current is not None:
            payload["current"] = current
        if cycle_number is not None:
            payload["cycle_number"] = cycle_number
        if cell_id is not None:
            payload["cell_id"] = cell_id
        return self._request("POST", "/api/predict", payload)

    def predict_pack(
        self,
        cells: list[dict],
        topology: str = "series",
        model_id: str = "v10-final",
    ) -> dict:
        """
        Pack-level RUL prediction.

        Parameters
        ----------
        cells    : list of cell dicts (same fields as predict())
        topology : "series" | "parallel" | "series-parallel"
        """
        return self._request("POST", "/api/predict/pack", {
            "cells": cells,
            "topology": topology,
            "model_id": model_id,
        })

    def batch(self, cells: list[dict], model_id: str = "v10-final") -> list[dict]:
        """
        Batch prediction for up to 500 cells.

        Each cell dict: {cell_id, cap_pct, chemistry, temperature?, ...}
        Returns list of prediction dicts in the same order.
        """
        return self._request("POST", "/api/batch/predict", {
            "cells": cells,
            "model_id": model_id,
        })

    def batch_csv(self, csv_path: str, model_id: str = "v10-final") -> dict:
        """
        Upload a CSV file and run batch prediction.
        CSV must have columns: cell_id, cap_pct, chemistry (+ optional features).
        Returns: {results: [...], alerts: [...]}
        """
        upload = self._upload("/api/batch/upload", csv_path, {})
        upload_id = upload["upload_id"]
        return self._request("POST", "/api/batch/run", {
            "upload_id": upload_id,
            "model_id": model_id,
        })

    # ── Fine-tune ─────────────────────────────────────────────────────────

    def finetune_start(
        self,
        csv_path: str,
        chemistry: str = "NMC",
        model_base: str = "v10-final",
        epochs: int = 50,
    ) -> str:
        """
        Upload training CSV and start a fine-tune job.
        Returns the job ID string.
        """
        upload = self._upload("/api/finetune/upload", csv_path, {"chemistry": chemistry})
        upload_id = upload["upload_id"]
        job = self._request("POST", "/api/finetune/start", {
            "upload_id": upload_id,
            "chemistry": chemistry,
            "model_base": model_base,
            "epochs": epochs,
        })
        return job["job_id"]

    def finetune_status(self, job_id: str) -> dict:
        """Get fine-tune job status. Returns dict with status, progress, log."""
        return self._request("GET", f"/api/finetune/jobs/{job_id}")

    def finetune_wait(self, job_id: str, poll_interval: int = 5) -> dict:
        """Block until the fine-tune job completes or fails. Returns final status dict."""
        while True:
            status = self.finetune_status(job_id)
            if status["status"] in ("completed", "failed", "cancelled"):
                return status
            time.sleep(poll_interval)

    # ── API key management ─────────────────────────────────────────────────

    def create_key(self, label: str, monthly_quota: int = -1) -> dict:
        """Create a new API key. Returns {raw_key, key_id, ...}."""
        return self._request("POST", "/api/keys", {
            "label": label,
            "monthly_quota": monthly_quota,
        })

    def list_keys(self) -> list[dict]:
        """List all API keys (masked)."""
        return self._request("GET", "/api/keys")

    def delete_key(self, key_id: str) -> dict:
        return self._request("DELETE", f"/api/keys/{key_id}")

    # ── Analytics ─────────────────────────────────────────────────────────

    def analytics(self) -> dict:
        """Return call analytics summary."""
        return self._request("GET", "/api/analytics/summary")

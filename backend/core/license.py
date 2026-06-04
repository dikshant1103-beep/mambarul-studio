"""
core/license.py — HMAC offline license key generation and validation.

Format: BATT-XXXX-XXXX-XXXX-YYYYYYYY
  XXXX segments = random uppercase hex (3 × 4 chars = 12 chars of entropy)
  YYYYYYYY = HMAC-SHA256(SECRET, "BATT-X1-X2-X3")[:8] uppercased

Validation is pure offline — recomputes MAC and compares.
Plan/seats are stored in the DB, not in the key itself.
"""
from __future__ import annotations
import hashlib
import hmac
import os
import secrets
import logging

logger = logging.getLogger(__name__)

_SECRET = os.getenv("LICENSE_SECRET", "batteryos-license-secret-v1").encode()


def _mac(body: str) -> str:
    return hmac.new(_SECRET, body.encode(), hashlib.sha256).hexdigest()[:8].upper()


def generate_key() -> str:
    """Generate a new signed license key."""
    rand = secrets.token_hex(6).upper()          # 12 hex chars
    p1, p2, p3 = rand[0:4], rand[4:8], rand[8:12]
    body = f"BATT-{p1}-{p2}-{p3}"
    return f"{body}-{_mac(body)}"


def validate_key(key: str) -> bool:
    """Return True if the key has a valid HMAC signature."""
    key = key.strip().upper()
    parts = key.split("-")
    if len(parts) != 5 or parts[0] != "BATT":
        return False
    body = f"BATT-{parts[1]}-{parts[2]}-{parts[3]}"
    return hmac.compare_digest(_mac(body), parts[4])

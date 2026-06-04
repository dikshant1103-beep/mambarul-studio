"""
core/config.py — Typed, env-var-driven configuration.

Loaded once at import time. All secrets come from environment variables
(or a .env file loaded by main.py before this module is first imported).

Usage:
    from core.config import cfg
    secret = cfg.jwt_secret
"""
from __future__ import annotations
import os
from pathlib import Path


def _bool(v: str | None) -> bool:
    return str(v or "").lower() in ("1", "true", "yes")


def _int(v: str | None, default: int) -> int:
    try:
        return int(v) if v is not None else default
    except (ValueError, TypeError):
        return default


_BACKEND = Path(__file__).parent.parent


class _Config:
    # ── Security ──────────────────────────────────────────────────────────────
    @property
    def jwt_secret(self) -> str:
        return os.environ.get("JWT_SECRET", "CHANGE-ME-jwt-secret-at-least-32-chars!!")

    @property
    def jwt_expire_days(self) -> int:
        return _int(os.environ.get("JWT_EXPIRE_DAYS"), 30)

    @property
    def admin_email(self) -> str:
        return os.environ.get("ADMIN_EMAIL", "admin@batteryos.io")

    @property
    def admin_password(self) -> str:
        return os.environ.get("ADMIN_PASSWORD", "batteryos")

    @property
    def registration_open(self) -> bool:
        return _bool(os.environ.get("REGISTRATION_OPEN", "1"))

    # ── Database ──────────────────────────────────────────────────────────────
    @property
    def db_path(self) -> Path:
        raw = os.environ.get("DB_PATH", "")
        return Path(raw) if raw else _BACKEND / "data" / "batteryos.db"

    @property
    def database_url(self) -> str:
        """PostgreSQL DSN. When set, PostgreSQL is used instead of SQLite."""
        return os.environ.get("DATABASE_URL", "")

    @property
    def timescale_enabled(self) -> bool:
        """True when DATABASE_URL is set and TimescaleDB extension should be activated."""
        return bool(self.database_url) and _bool(os.environ.get("TIMESCALE_ENABLED", "1"))

    # ── Kafka ─────────────────────────────────────────────────────────────────
    @property
    def kafka_bootstrap_servers(self) -> str:
        """Comma-separated Kafka broker list. Empty = Kafka disabled."""
        return os.environ.get("KAFKA_BOOTSTRAP_SERVERS", "localhost:9092")

    # ── Checkpoints ───────────────────────────────────────────────────────────
    @property
    def hf_repo_id(self) -> str:
        return os.environ.get("HF_REPO_ID", "")

    @property
    def hf_token(self) -> str:
        return os.environ.get("HF_TOKEN", "")

    # ── Sentry ────────────────────────────────────────────────────────────────
    @property
    def sentry_dsn(self) -> str:
        return os.environ.get("SENTRY_DSN", "")

    # ── SMTP ──────────────────────────────────────────────────────────────────
    @property
    def smtp_host(self) -> str:
        return os.environ.get("SMTP_HOST", "")

    @property
    def smtp_port(self) -> int:
        return _int(os.environ.get("SMTP_PORT"), 587)

    @property
    def smtp_user(self) -> str:
        return os.environ.get("SMTP_USER", "")

    @property
    def smtp_password(self) -> str:
        return os.environ.get("SMTP_PASSWORD", "")

    @property
    def smtp_from(self) -> str:
        return os.environ.get("SMTP_FROM", "BatteryOS <noreply@batteryos.io>")

    @property
    def alert_email(self) -> str:
        return os.environ.get("ALERT_EMAIL", "")

    # ── Fine-tuning ───────────────────────────────────────────────────────────
    @property
    def finetune_enabled(self) -> bool:
        return _bool(os.environ.get("FINETUNE_ENABLED", "1"))

    @property
    def finetune_max_jobs(self) -> int:
        return _int(os.environ.get("FINETUNE_MAX_JOBS"), 2)

    # ── CORS ──────────────────────────────────────────────────────────────────
    @property
    def cors_origins(self) -> list[str]:
        raw = os.environ.get("CORS_ORIGINS", "")
        defaults = ["http://localhost:5173", "http://localhost:3000",
                    "http://127.0.0.1:5173", "http://127.0.0.1:3000"]
        if not raw:
            return defaults
        return [o.strip() for o in raw.split(",") if o.strip()] + defaults


cfg = _Config()

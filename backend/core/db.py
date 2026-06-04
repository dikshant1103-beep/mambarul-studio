"""
core/db.py — Dual-backend persistence layer (SQLite default, PostgreSQL via DATABASE_URL).

SQLite:     default for dev/Electron; set DB_PATH env var to override path.
PostgreSQL: set DATABASE_URL=postgresql://user:pass@host:5432/dbname to activate.

All public functions have identical signatures regardless of backend.
Thread-safe: SQLite uses WAL + per-call connections; PostgreSQL uses ThreadedConnectionPool.
"""
from __future__ import annotations
import json
import logging
import re
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Generator

logger = logging.getLogger(__name__)

_DB_PATH: Path | None = None
_PG_POOL = None


def _get_db_path() -> Path:
    global _DB_PATH
    if _DB_PATH is None:
        from core.config import cfg
        _DB_PATH = cfg.db_path
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    return _DB_PATH


def _get_pg_pool():
    global _PG_POOL
    if _PG_POOL is None:
        import psycopg2.pool
        from core.config import cfg
        _PG_POOL = psycopg2.pool.ThreadedConnectionPool(1, 20, dsn=cfg.database_url)
        logger.info("PostgreSQL connection pool created (max=20)")
    return _PG_POOL


# ── Primary key map for INSERT OR REPLACE → UPSERT translation ───────────────

_PK_MAP: dict[str, str] = {
    "settings_kv": "key",
    "cell_labels": "cell_id",
    "soc_state": "cell_id",
    "pack_cells": "id",
    "api_keys": "id",
    "orgs": "id",
    "users": "id",
    "sessions": "token",
    "licenses": "id",
    "packs": "id",
}


def _pg_adapt(sql: str) -> str:
    """Translate SQLite SQL dialect to PostgreSQL."""
    sql = sql.replace("?", "%s")
    # INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING
    if re.search(r"\bINSERT\s+OR\s+IGNORE\b", sql, re.IGNORECASE):
        sql = re.sub(r"\bINSERT\s+OR\s+IGNORE\b", "INSERT", sql, flags=re.IGNORECASE)
        sql = sql.rstrip().rstrip(";") + " ON CONFLICT DO NOTHING"
        return sql
    # INSERT OR REPLACE → UPSERT with explicit ON CONFLICT
    m = re.search(
        r"\bINSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES",
        sql, re.IGNORECASE
    )
    if m:
        table = m.group(1).lower()
        cols = [c.strip() for c in m.group(2).split(",")]
        pk = _PK_MAP.get(table, cols[0])
        update_cols = [c for c in cols if c != pk]
        sql = re.sub(r"\bINSERT\s+OR\s+REPLACE\b", "INSERT", sql, flags=re.IGNORECASE)
        sql = sql.rstrip().rstrip(";")
        if update_cols:
            sets = ", ".join(f"{c}=EXCLUDED.{c}" for c in update_cols)
            sql += f" ON CONFLICT ({pk}) DO UPDATE SET {sets}"
        else:
            sql += f" ON CONFLICT ({pk}) DO NOTHING"
    return sql


def _adapt_schema_for_pg(sql: str) -> str:
    """Adapt SQLite DDL to PostgreSQL DDL."""
    sql = re.sub(
        r"\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b",
        "BIGSERIAL PRIMARY KEY",
        sql, flags=re.IGNORECASE,
    )
    sql = re.sub(r"\bAUTOINCREMENT\b", "", sql, flags=re.IGNORECASE)
    return sql


# ── PostgreSQL connection wrapper ─────────────────────────────────────────────

class _DictRow:
    """sqlite3.Row-compatible wrapper for psycopg2 RealDictRow."""
    __slots__ = ("_d",)

    def __init__(self, data: dict):
        self._d = dict(data)

    def __getitem__(self, key):
        if isinstance(key, int):
            return list(self._d.values())[key]
        return self._d[key]

    def __iter__(self):
        return iter(self._d)

    def __contains__(self, key):
        return key in self._d

    def keys(self):
        return self._d.keys()

    def get(self, key, default=None):
        return self._d.get(key, default)


class _PGCursor:
    __slots__ = ("_cur", "_lastrowid")

    def __init__(self, cur):
        self._cur = cur
        self._lastrowid = None

    def fetchone(self):
        row = self._cur.fetchone()
        return _DictRow(row) if row is not None else None

    def fetchall(self):
        return [_DictRow(r) for r in (self._cur.fetchall() or [])]

    @property
    def rowcount(self):
        return self._cur.rowcount

    @property
    def lastrowid(self):
        return self._lastrowid


class _PGConn:
    """Wraps a psycopg2 connection to mimic the sqlite3.Connection interface."""
    __slots__ = ("_con",)

    def __init__(self, con):
        self._con = con

    def execute(self, sql: str, params=()):
        import psycopg2.extras
        cur = self._con.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        adapted = _pg_adapt(sql)
        cur.execute(adapted, params if params else None)
        wrapper = _PGCursor(cur)
        # Capture RETURNING id if present
        if re.search(r"\bINSERT\b", adapted, re.IGNORECASE) and cur.rowcount == 1:
            try:
                row = cur.fetchone()
                if row and "id" in row:
                    wrapper._lastrowid = row["id"]
                    cur.scroll(-1)  # put it back so fetchone() still works
            except Exception:
                pass
        return wrapper

    def executescript(self, sql: str):
        """Execute a multi-statement DDL block (schema creation)."""
        adapted = _adapt_schema_for_pg(sql)
        cur = self._con.cursor()
        for stmt in adapted.split(";"):
            stmt = stmt.strip()
            if stmt:
                try:
                    cur.execute(stmt)
                except Exception as e:
                    if "already exists" not in str(e).lower():
                        raise
                    self._con.rollback()
        return _PGCursor(cur)


@contextmanager
def _conn():
    from core.config import cfg
    if cfg.database_url:
        pool = _get_pg_pool()
        con = pool.getconn()
        try:
            yield _PGConn(con)
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            pool.putconn(con)
    else:
        path = _get_db_path()
        con = sqlite3.connect(str(path), check_same_thread=False, timeout=10)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA foreign_keys=ON")
        try:
            yield con
            con.commit()
        except Exception:
            con.rollback()
            raise
        finally:
            con.close()


# ── Schema ────────────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS orgs (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    plan          TEXT NOT NULL DEFAULT 'free',
    monthly_quota INTEGER NOT NULL DEFAULT 100,
    calls_this_month INTEGER NOT NULL DEFAULT 0,
    quota_reset_at TEXT NOT NULL,
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL DEFAULT '',
    org_id        TEXT NOT NULL REFERENCES orgs(id),
    role          TEXT NOT NULL DEFAULT 'member',
    is_active     INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT NOT NULL,
    last_login    TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
    token      TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
    id                  TEXT PRIMARY KEY,
    key_hash            TEXT NOT NULL,
    key_preview         TEXT NOT NULL,
    label               TEXT NOT NULL,
    org_id              TEXT NOT NULL,
    org_name            TEXT NOT NULL DEFAULT '',
    rate_limit_per_min  INTEGER NOT NULL DEFAULT 100,
    monthly_quota       INTEGER NOT NULL DEFAULT 10000,
    calls_this_month    INTEGER NOT NULL DEFAULT 0,
    quota_reset_at      TEXT NOT NULL,
    call_count          INTEGER NOT NULL DEFAULT 0,
    created_at          TEXT NOT NULL,
    last_used           TEXT
);

CREATE TABLE IF NOT EXISTS analytics_calls (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT NOT NULL,
    chemistry TEXT NOT NULL,
    model_id  TEXT NOT NULL,
    rul       REAL NOT NULL,
    phase     TEXT NOT NULL,
    source    TEXT NOT NULL DEFAULT 'direct',
    org       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS alerts (
    id        TEXT PRIMARY KEY,
    ts        TEXT NOT NULL,
    chemistry TEXT NOT NULL,
    soh       REAL NOT NULL,
    rul       REAL NOT NULL,
    phase     TEXT NOT NULL,
    label     TEXT NOT NULL DEFAULT '',
    source    TEXT NOT NULL DEFAULT 'batch',
    org       TEXT NOT NULL DEFAULT '',
    ack       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings_kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cell_labels (
    cell_id    TEXT PRIMARY KEY,
    label      TEXT NOT NULL DEFAULT '',
    tags       TEXT NOT NULL DEFAULT '[]',
    notes      TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_windows (
    key_id TEXT NOT NULL,
    ts     REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rw_key ON rate_windows(key_id);
CREATE INDEX IF NOT EXISTS idx_rw_ts  ON rate_windows(ts);

CREATE TABLE IF NOT EXISTS finetune_jobs (
    id           TEXT PRIMARY KEY,
    chemistry    TEXT NOT NULL,
    model_base   TEXT NOT NULL DEFAULT 'v10-final',
    status       TEXT NOT NULL DEFAULT 'queued',
    progress     REAL NOT NULL DEFAULT 0.0,
    log          TEXT NOT NULL DEFAULT '',
    upload_path  TEXT NOT NULL DEFAULT '',
    output_path  TEXT NOT NULL DEFAULT '',
    error        TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    started_at   TEXT,
    finished_at  TEXT,
    org          TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS licenses (
    id             TEXT PRIMARY KEY,
    key_hash       TEXT UNIQUE NOT NULL,
    key_preview    TEXT NOT NULL,
    plan           TEXT NOT NULL DEFAULT 'pro',
    seats          INTEGER NOT NULL DEFAULT 1,
    customer_email TEXT NOT NULL DEFAULT '',
    notes          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'active',
    activated_at   TEXT,
    created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS failed_logins (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ts    REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fl_email ON failed_logins(email);
CREATE INDEX IF NOT EXISTS idx_fl_ts    ON failed_logins(ts);

-- ── BMS: cycle-by-cycle raw telemetry ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cell_timeseries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cell_id     TEXT NOT NULL,
    ts          TEXT NOT NULL,
    voltage     REAL NOT NULL,
    current     REAL NOT NULL,
    temperature REAL NOT NULL,
    soc         REAL,
    cycle_num   INTEGER,
    source      TEXT NOT NULL DEFAULT 'http',
    pack_id     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_cts_cell ON cell_timeseries(cell_id);
CREATE INDEX IF NOT EXISTS idx_cts_ts   ON cell_timeseries(ts);
CREATE INDEX IF NOT EXISTS idx_cts_pack ON cell_timeseries(pack_id);

-- ── BMS: pack topology ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS packs (
    id                  TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT NOT NULL DEFAULT '',
    cells_series        INTEGER NOT NULL DEFAULT 1,
    cells_parallel      INTEGER NOT NULL DEFAULT 1,
    nominal_voltage     REAL NOT NULL DEFAULT 3.6,
    nominal_capacity_ah REAL NOT NULL DEFAULT 50.0,
    chemistry           TEXT NOT NULL DEFAULT 'NMC',
    created_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pack_cells (
    id                  TEXT PRIMARY KEY,
    pack_id             TEXT NOT NULL REFERENCES packs(id),
    cell_id             TEXT NOT NULL,
    module_id           TEXT NOT NULL DEFAULT '',
    position_series     INTEGER NOT NULL DEFAULT 0,
    position_parallel   INTEGER NOT NULL DEFAULT 0,
    nominal_capacity_ah REAL NOT NULL DEFAULT 5.0,
    chemistry           TEXT NOT NULL DEFAULT 'NMC',
    added_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pc_pack ON pack_cells(pack_id);
CREATE INDEX IF NOT EXISTS idx_pc_cell ON pack_cells(cell_id);

-- ── BMS: safety events ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS safety_events (
    id          TEXT PRIMARY KEY,
    ts          TEXT NOT NULL,
    cell_id     TEXT NOT NULL DEFAULT '',
    pack_id     TEXT NOT NULL DEFAULT '',
    event_type  TEXT NOT NULL,
    severity    TEXT NOT NULL DEFAULT 'warning',
    value       REAL NOT NULL,
    limit_value REAL NOT NULL,
    cleared     INTEGER NOT NULL DEFAULT 0,
    cleared_at  TEXT,
    source      TEXT NOT NULL DEFAULT 'auto'
);
CREATE INDEX IF NOT EXISTS idx_se_ts   ON safety_events(ts);
CREATE INDEX IF NOT EXISTS idx_se_cell ON safety_events(cell_id);

-- ── BMS: control command log ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bms_commands (
    id         TEXT PRIMARY KEY,
    ts         TEXT NOT NULL,
    command    TEXT NOT NULL,
    target_id  TEXT NOT NULL DEFAULT '',
    parameters TEXT NOT NULL DEFAULT '{}',
    issued_by  TEXT NOT NULL DEFAULT 'system',
    status     TEXT NOT NULL DEFAULT 'pending',
    ack_at     TEXT
);

-- ── BMS: SOC state per cell ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS soc_state (
    cell_id     TEXT PRIMARY KEY,
    soc         REAL NOT NULL DEFAULT 100.0,
    capacity_ah REAL NOT NULL DEFAULT 5.0,
    coulombs_in REAL NOT NULL DEFAULT 0.0,
    last_update TEXT NOT NULL,
    chemistry   TEXT NOT NULL DEFAULT 'NMC'
);

CREATE TABLE IF NOT EXISTS anomaly_events (
    id              TEXT PRIMARY KEY,
    cell_id         TEXT NOT NULL,
    chemistry       TEXT NOT NULL DEFAULT '',
    anomaly_type    TEXT NOT NULL,
    severity        TEXT NOT NULL,
    cycle           INTEGER NOT NULL,
    value           REAL NOT NULL,
    expected        REAL NOT NULL,
    deviation_sigma REAL NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    detected_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS second_life_assessments (
    id            TEXT PRIMARY KEY,
    cell_id       TEXT NOT NULL,
    grade         TEXT NOT NULL,
    score         REAL NOT NULL,
    soh_pct       REAL NOT NULL,
    rul_cycles    REAL NOT NULL,
    chemistry     TEXT NOT NULL,
    recycle       INTEGER NOT NULL DEFAULT 0,
    value_min_usd REAL NOT NULL DEFAULT 0,
    value_max_usd REAL NOT NULL DEFAULT 0,
    result_json   TEXT NOT NULL DEFAULT '{}',
    assessed_at   TEXT NOT NULL
);

-- ── Per-cycle RUL history (auto-populated by BMS telemetry pipeline) ──────────
CREATE TABLE IF NOT EXISTS cell_rul_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    cell_id     TEXT    NOT NULL,
    cycle_num   INTEGER NOT NULL,
    ts          TEXT    NOT NULL,
    rul         REAL    NOT NULL,
    rul_lower   REAL    NOT NULL,
    rul_upper   REAL    NOT NULL,
    soh_pct     REAL    NOT NULL DEFAULT 0,
    model_id    TEXT    NOT NULL DEFAULT 'v10-final',
    chemistry   TEXT    NOT NULL DEFAULT 'LFP'
);
CREATE INDEX IF NOT EXISTS idx_rul_hist_cell  ON cell_rul_history(cell_id);
CREATE INDEX IF NOT EXISTS idx_rul_hist_cycle ON cell_rul_history(cell_id, cycle_num);
CREATE TABLE IF NOT EXISTS lims_imports (
    id                  TEXT PRIMARY KEY,
    imported_at         TEXT NOT NULL,
    filename            TEXT,
    format              TEXT,
    n_cycles            INTEGER,
    n_rows              INTEGER,
    nominal_capacity_ah REAL,
    soh_initial         REAL,
    soh_final           REAL,
    fade_rate_pct_per_cycle REAL,
    meta_json           TEXT
);
CREATE INDEX IF NOT EXISTS idx_lims_imports_at ON lims_imports(imported_at);
CREATE TABLE IF NOT EXISTS cell_internal_states (
    cell_id      TEXT NOT NULL,
    extracted_at TEXT NOT NULL,
    chemistry    TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT 'twin',
    states_json  TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (cell_id, extracted_at)
);
CREATE INDEX IF NOT EXISTS idx_int_states_cell ON cell_internal_states(cell_id);
CREATE INDEX IF NOT EXISTS idx_int_states_at   ON cell_internal_states(extracted_at);
"""


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _next_month() -> str:
    now = datetime.now(timezone.utc)
    nxt = (now.replace(day=1) + timedelta(days=32)).replace(day=1)
    return nxt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Init + migration ──────────────────────────────────────────────────────────

def init_db() -> None:
    """Create schema; import existing JSON files when using SQLite (runs once)."""
    from core.config import cfg
    with _conn() as con:
        con.executescript(_SCHEMA)
    if not cfg.database_url:
        _migrate_json()
    _migrate_user_auth_columns()
    _migrate_extra_columns()
    _bootstrap_admin()
    if cfg.timescale_enabled:
        _upgrade_to_timescale()
    backend = "PostgreSQL" if cfg.database_url else f"SQLite @ {_get_db_path()}"
    logger.info("Database ready — %s", backend)


def _upgrade_to_timescale() -> None:
    """
    Activate TimescaleDB extension and convert time-series tables to hypertables.
    Silently no-ops if TimescaleDB is not installed (standard PostgreSQL).
    Safe to call on an already-upgraded database.
    """
    try:
        with _conn() as con:
            # Enable extension (requires timescaledb image)
            con.execute("CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE")

        # Tables to convert: (table_name, time_column)
        hypertables = [
            ("cell_timeseries",          "ts"),
            ("safety_events",            "ts"),
            ("anomaly_events",           "detected_at"),
            ("second_life_assessments",  "assessed_at"),
            ("analytics_calls",          "ts"),
        ]
        # NOTE: these time columns are declared TEXT (ISO-8601 strings) so the
        # SQLite schema stays portable. TimescaleDB's create_hypertable() requires
        # the partitioning column to be TIMESTAMP/TIMESTAMPTZ/DATE or an integer —
        # a TEXT column is rejected, so each conversion below first promotes the
        # column to TIMESTAMPTZ (Postgres casts the existing ISO strings via
        # `USING ts::timestamptz`). This runs ONLY on the Postgres+TimescaleDB
        # path; the SQLite path is untouched.
        #
        # ⚠ Runtime-verify in docker before relying on this in production:
        #     docker compose up -d postgres && TIMESCALE_ENABLED=1 <start backend>
        #   After conversion, psycopg2 returns datetime objects (not ISO strings)
        #   for these columns; confirm read/serialization paths that consume `ts`
        #   handle datetimes (FastAPI's jsonable_encoder does, raw json.dumps does
        #   not). This is why the conversion is gated and not enabled blindly.
        for table, time_col in hypertables:
            try:
                with _conn() as con:
                    con.execute(
                        f"ALTER TABLE {table} ALTER COLUMN {time_col} "
                        f"TYPE TIMESTAMPTZ USING {time_col}::timestamptz"
                    )
            except Exception as exc:
                logger.debug("TimescaleDB: column promote skipped %s.%s: %s",
                             table, time_col, exc)
            try:
                with _conn() as con:
                    con.execute(
                        "SELECT create_hypertable(%s, %s, "
                        "if_not_exists => TRUE, migrate_data => TRUE)",
                        (table, time_col),
                    )
                logger.info("TimescaleDB: hypertable ready — %s(%s)", table, time_col)
            except Exception as exc:
                # Table may not exist yet or column type incompatible — skip
                logger.debug("TimescaleDB: skipping %s: %s", table, exc)

        logger.info("TimescaleDB upgrade complete")
    except Exception as exc:
        # Standard PostgreSQL without timescaledb extension — this is fine
        logger.debug("TimescaleDB not available (%s) — using standard PostgreSQL", exc)


def _migrate_json() -> None:
    """Import flat JSON files into SQLite on first run, then leave them alone."""
    base = _get_db_path().parent

    # sessions.json → sessions table (skip: old UUID sessions are incompatible with JWT)
    # Just remove the old file if present — new sessions use JWT.

    # keys.json → api_keys
    keys_file = base / "keys.json"
    if keys_file.exists():
        try:
            data = json.loads(keys_file.read_text())
            with _conn() as con:
                for kid, r in data.items():
                    existing = con.execute(
                        "SELECT id FROM api_keys WHERE id=?", (kid,)
                    ).fetchone()
                    if existing:
                        continue
                    import hashlib
                    raw_key = r.get("key", "")
                    key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
                    con.execute("""
                        INSERT OR IGNORE INTO api_keys
                        (id,key_hash,key_preview,label,org_id,org_name,
                         rate_limit_per_min,monthly_quota,calls_this_month,
                         quota_reset_at,call_count,created_at,last_used)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """, (kid, key_hash, raw_key[:12], r.get("label","Key"),
                          "default", r.get("org_name",""),
                          r.get("rate_limit_per_min", 100), 10000, 0,
                          _next_month(), r.get("call_count", 0),
                          r.get("created_at", _now()), r.get("last_used")))
            keys_file.rename(base / "keys.json.migrated")
            logger.info("Migrated keys.json → SQLite")
        except Exception as e:
            logger.warning("keys.json migration failed: %s", e)

    # analytics.json → analytics_calls + alerts
    analytics_file = base / "analytics.json"
    if analytics_file.exists():
        try:
            data = json.loads(analytics_file.read_text())
            with _conn() as con:
                for call in data.get("calls", []):
                    con.execute("""
                        INSERT OR IGNORE INTO analytics_calls
                        (ts,chemistry,model_id,rul,phase,source,org)
                        VALUES (?,?,?,?,?,?,?)
                    """, (call.get("ts", _now()), call.get("chem","?"),
                          call.get("model","?"), call.get("rul",0),
                          call.get("phase","?"), call.get("src","direct"),
                          call.get("org","")))
                for alert in data.get("alerts", []):
                    con.execute("""
                        INSERT OR IGNORE INTO alerts
                        (id,ts,chemistry,soh,rul,phase,label,source,org,ack)
                        VALUES (?,?,?,?,?,?,?,?,?,?)
                    """, (alert.get("id", str(uuid.uuid4())),
                          alert.get("ts", _now()), alert.get("chem","?"),
                          alert.get("soh",0), alert.get("rul",0),
                          alert.get("phase","?"), alert.get("label",""),
                          alert.get("src","batch"), alert.get("org",""),
                          1 if alert.get("ack") else 0))
            analytics_file.rename(base / "analytics.json.migrated")
            logger.info("Migrated analytics.json → SQLite")
        except Exception as e:
            logger.warning("analytics.json migration failed: %s", e)

    # settings.json → settings_kv
    settings_file = base / "settings.json"
    if settings_file.exists():
        try:
            data = json.loads(settings_file.read_text())
            with _conn() as con:
                for k, v in data.items():
                    con.execute("""
                        INSERT OR IGNORE INTO settings_kv(key,value)
                        VALUES (?,?)
                    """, (k, json.dumps(v)))
            settings_file.rename(base / "settings.json.migrated")
            logger.info("Migrated settings.json → SQLite")
        except Exception as e:
            logger.warning("settings.json migration failed: %s", e)


def _migrate_extra_columns() -> None:
    """Add tos_accepted column to users (idempotent)."""
    with _conn() as con:
        try:
            con.execute("ALTER TABLE users ADD COLUMN tos_accepted INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass


def _migrate_user_auth_columns() -> None:
    """Add email-verification and password-reset columns to existing users rows."""
    new_cols = [
        "email_verified INTEGER NOT NULL DEFAULT 0",
        "email_verify_token TEXT",
        "verify_token_expires TEXT",
        "reset_token TEXT",
        "reset_token_expires TEXT",
    ]
    with _conn() as con:
        for col_def in new_cols:
            try:
                con.execute(f"ALTER TABLE users ADD COLUMN {col_def}")
            except Exception:
                pass
        # Existing admin/admin-role users are pre-verified
        con.execute("UPDATE users SET email_verified=1 WHERE role='admin' AND email_verified=0")


def _bootstrap_admin() -> None:
    """Create default org + admin user if none exist. Always syncs password from env."""
    import os
    from core.config import cfg
    from passlib.context import CryptContext
    pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

    with _conn() as con:
        existing = con.execute(
            "SELECT id, password_hash FROM users WHERE email=?", (cfg.admin_email,)
        ).fetchone()

        if existing:
            # If ADMIN_PASSWORD env var is explicitly set, enforce it every startup.
            if os.environ.get("ADMIN_PASSWORD"):
                if not pwd_ctx.verify(cfg.admin_password, existing["password_hash"]):
                    con.execute(
                        "UPDATE users SET password_hash=? WHERE email=?",
                        (pwd_ctx.hash(cfg.admin_password), cfg.admin_email)
                    )
                    logger.info("Admin password updated from ADMIN_PASSWORD env var.")
            return

        if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
            return  # Other users exist but not admin — don't create

        # First-ever run: create default org + admin
        org_id = str(uuid.uuid4())
        con.execute("""
            INSERT INTO orgs(id,name,plan,monthly_quota,quota_reset_at,created_at)
            VALUES (?,?,?,?,?,?)
        """, (org_id, "Default Org", "pro", -1, _next_month(), _now()))
        user_id = str(uuid.uuid4())
        con.execute("""
            INSERT INTO users(id,email,password_hash,full_name,org_id,role,created_at,email_verified)
            VALUES (?,?,?,?,?,?,?,1)
        """, (user_id, cfg.admin_email,
              pwd_ctx.hash(cfg.admin_password),
              "Admin", org_id, "admin", _now()))
    logger.info("Bootstrap admin created: %s", cfg.admin_email)


# ── Settings ──────────────────────────────────────────────────────────────────

_SETTING_DEFAULTS: dict[str, Any] = {
    "soh_healthy": 88, "soh_warning": 80, "eol_threshold": 80,
    "webhook_url": "", "webhook_enabled": False,
    "default_chemistry": "NMC", "alert_email": "",
    "smtp_host": "", "smtp_port": 587, "smtp_user": "",
    "smtp_password": "", "smtp_from": "",
}


def get_settings() -> dict:
    from core.config import cfg
    result = dict(_SETTING_DEFAULTS)
    with _conn() as con:
        rows = con.execute("SELECT key, value FROM settings_kv").fetchall()
    for row in rows:
        try:
            result[row["key"]] = json.loads(row["value"])
        except Exception:
            result[row["key"]] = row["value"]
    # Env overrides for SMTP (env always wins)
    if cfg.smtp_host:
        result["smtp_host"]     = cfg.smtp_host
        result["smtp_port"]     = cfg.smtp_port
        result["smtp_user"]     = cfg.smtp_user
        result["smtp_password"] = cfg.smtp_password
        result["smtp_from"]     = cfg.smtp_from
    if cfg.alert_email:
        result["alert_email"] = cfg.alert_email
    return result


def save_settings(data: dict) -> None:
    with _conn() as con:
        for k, v in data.items():
            con.execute(
                "INSERT OR REPLACE INTO settings_kv(key,value) VALUES(?,?)",
                (k, json.dumps(v))
            )


# ── Analytics ─────────────────────────────────────────────────────────────────

def track_call(chemistry: str, model_id: str, rul: float, phase: str,
               source: str = "direct", org: str = "") -> None:
    with _conn() as con:
        con.execute("""
            INSERT INTO analytics_calls(ts,chemistry,model_id,rul,phase,source,org)
            VALUES (?,?,?,?,?,?,?)
        """, (_now(), chemistry.upper(), model_id, round(rul, 1), phase, source, org))
        # Keep only last 10000 rows
        con.execute("""
            DELETE FROM analytics_calls WHERE id NOT IN (
                SELECT id FROM analytics_calls ORDER BY id DESC LIMIT 10000
            )
        """)


def get_calls(limit: int = 500, org: str = "") -> list[dict]:
    with _conn() as con:
        if org:
            rows = con.execute(
                "SELECT * FROM analytics_calls WHERE org=? ORDER BY id DESC LIMIT ?",
                (org, limit)
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM analytics_calls ORDER BY id DESC LIMIT ?", (limit,)
            ).fetchall()
    return [dict(r) for r in rows]


def record_alert(chemistry: str, soh: float, rul: float, phase: str,
                 label: str = "", source: str = "batch", org: str = "") -> str:
    alert_id = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO alerts(id,ts,chemistry,soh,rul,phase,label,source,org,ack)
            VALUES (?,?,?,?,?,?,?,?,?,0)
        """, (alert_id, _now(), chemistry.upper(), round(soh, 2),
              round(rul, 1), phase, label, source, org))
    return alert_id


def get_alerts(acked: bool | None = None, org: str = "",
               limit: int = 200) -> list[dict]:
    clauses, params = [], []
    if acked is not None:
        clauses.append("ack=?")
        params.append(1 if acked else 0)
    if org:
        clauses.append("org=?")
        params.append(org)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    with _conn() as con:
        rows = con.execute(
            f"SELECT * FROM alerts {where} ORDER BY ts DESC LIMIT ?", params
        ).fetchall()
    return [dict(r) for r in rows]


def acknowledge_alert(alert_id: str) -> bool:
    with _conn() as con:
        cur = con.execute("UPDATE alerts SET ack=1 WHERE id=?", (alert_id,))
    return cur.rowcount > 0


def get_unacked_count(org: str = "") -> int:
    with _conn() as con:
        if org:
            return con.execute(
                "SELECT COUNT(*) FROM alerts WHERE ack=0 AND org=?", (org,)
            ).fetchone()[0]
        return con.execute(
            "SELECT COUNT(*) FROM alerts WHERE ack=0"
        ).fetchone()[0]


# ── API Keys ──────────────────────────────────────────────────────────────────

import hashlib


def _hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def create_api_key(label: str, org_id: str = "default", org_name: str = "",
                   rate_limit: int = 100, monthly_quota: int = 10000) -> dict:
    import secrets
    kid = str(uuid.uuid4())
    raw = "bos_" + secrets.token_hex(16)
    with _conn() as con:
        con.execute("""
            INSERT INTO api_keys
            (id,key_hash,key_preview,label,org_id,org_name,
             rate_limit_per_min,monthly_quota,calls_this_month,
             quota_reset_at,call_count,created_at)
            VALUES (?,?,?,?,?,?,?,?,0,?,0,?)
        """, (kid, _hash_key(raw), raw[:12], label, org_id, org_name,
              rate_limit, monthly_quota, _next_month(), _now()))
    return {"key_id": kid, "key": raw, "label": label, "org_name": org_name,
            "created_at": _now(),
            "note": "Copy this key now — it will not be shown again."}


def list_api_keys(org_id: str = "") -> list[dict]:
    with _conn() as con:
        if org_id:
            rows = con.execute(
                "SELECT * FROM api_keys WHERE org_id=? ORDER BY created_at DESC", (org_id,)
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM api_keys ORDER BY created_at DESC"
            ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        d.pop("key_hash", None)   # never expose hash
        d["preview"] = d.pop("key_preview", "")
        result.append(d)
    return result


def get_api_key_by_raw(raw_key: str) -> dict | None:
    h = _hash_key(raw_key)
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM api_keys WHERE key_hash=?", (h,)
        ).fetchone()
    return dict(row) if row else None


def update_api_key(key_id: str, **fields) -> bool:
    allowed = {"label", "org_name", "rate_limit_per_min", "monthly_quota"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return False
    sql = "UPDATE api_keys SET " + ", ".join(f"{k}=?" for k in sets)
    sql += " WHERE id=?"
    with _conn() as con:
        cur = con.execute(sql, [*sets.values(), key_id])
    return cur.rowcount > 0


def delete_api_key(key_id: str) -> bool:
    with _conn() as con:
        cur = con.execute("DELETE FROM api_keys WHERE id=?", (key_id,))
    return cur.rowcount > 0


def increment_key_usage(key_id: str) -> None:
    with _conn() as con:
        con.execute("""
            UPDATE api_keys SET
                call_count = call_count + 1,
                calls_this_month = calls_this_month + 1,
                last_used = ?
            WHERE id=?
        """, (_now(), key_id))
        # Reset monthly counter if past quota_reset_at
        row = con.execute(
            "SELECT quota_reset_at FROM api_keys WHERE id=?", (key_id,)
        ).fetchone()
        if row and row["quota_reset_at"] < _now():
            con.execute("""
                UPDATE api_keys SET calls_this_month=1, quota_reset_at=?
                WHERE id=?
            """, (_next_month(), key_id))


# ── Rate limiting (sliding window, in-process) ────────────────────────────────

def check_rate_limit(key_id: str, limit_per_min: int) -> bool:
    """Return True if request is allowed, False if rate-limited."""
    now = time.time()
    cutoff = now - 60.0
    with _conn() as con:
        # Purge old timestamps
        con.execute("DELETE FROM rate_windows WHERE key_id=? AND ts<?",
                    (key_id, cutoff))
        count = con.execute(
            "SELECT COUNT(*) FROM rate_windows WHERE key_id=?", (key_id,)
        ).fetchone()[0]
        if count >= limit_per_min:
            return False
        con.execute("INSERT INTO rate_windows(key_id,ts) VALUES(?,?)",
                    (key_id, now))
    return True


def check_quota(key_id: str, monthly_quota: int) -> bool:
    """Return True if within monthly quota (-1 = unlimited)."""
    if monthly_quota < 0:
        return True
    with _conn() as con:
        row = con.execute(
            "SELECT calls_this_month, quota_reset_at FROM api_keys WHERE id=?",
            (key_id,)
        ).fetchone()
    if not row:
        return True
    # Reset if past reset date
    if row["quota_reset_at"] < _now():
        return True  # increment_key_usage will handle reset
    return row["calls_this_month"] < monthly_quota


# ── Sessions ──────────────────────────────────────────────────────────────────

def create_session(user_id: str) -> str:
    from core.config import cfg
    token = str(uuid.uuid4())
    expires = (datetime.now(timezone.utc) + timedelta(days=cfg.jwt_expire_days)
               ).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _conn() as con:
        con.execute(
            "INSERT INTO sessions(token,user_id,created_at,expires_at) VALUES(?,?,?,?)",
            (token, user_id, _now(), expires)
        )
    return token


def validate_session(token: str) -> dict | None:
    with _conn() as con:
        row = con.execute("""
            SELECT s.token, s.user_id, s.expires_at,
                   u.email, u.full_name, u.org_id, u.role, u.is_active
            FROM sessions s JOIN users u ON s.user_id = u.id
            WHERE s.token=?
        """, (token,)).fetchone()
    if not row:
        return None
    if row["expires_at"] < _now():
        delete_session(token)
        return None
    if not row["is_active"]:
        return None
    return dict(row)


def delete_session(token: str) -> None:
    with _conn() as con:
        con.execute("DELETE FROM sessions WHERE token=?", (token,))


# ── Users ─────────────────────────────────────────────────────────────────────

def get_user_by_email(email: str) -> dict | None:
    with _conn() as con:
        row = con.execute("SELECT * FROM users WHERE email=?", (email.lower(),)).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: str) -> dict | None:
    with _conn() as con:
        row = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return dict(row) if row else None


def create_user(email: str, password: str, full_name: str = "",
                org_id: str = "", role: str = "member") -> dict:
    from passlib.context import CryptContext
    from core.config import cfg

    pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

    # Default: join the global default org
    if not org_id:
        with _conn() as con:
            row = con.execute("SELECT id FROM orgs LIMIT 1").fetchone()
        org_id = row["id"] if row else _create_default_org()

    user_id = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO users(id,email,password_hash,full_name,org_id,role,created_at)
            VALUES (?,?,?,?,?,?,?)
        """, (user_id, email.lower(), pwd_ctx.hash(password),
              full_name, org_id, role, _now()))
    return get_user_by_id(user_id)   # type: ignore[return-value]


def _create_default_org() -> str:
    oid = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO orgs(id,name,plan,monthly_quota,quota_reset_at,created_at)
            VALUES (?,?,?,?,?,?)
        """, (oid, "Default Org", "free", 100, _next_month(), _now()))
    return oid


def record_login(user_id: str) -> None:
    with _conn() as con:
        con.execute("UPDATE users SET last_login=? WHERE id=?", (_now(), user_id))


# ── Email verification + password reset ───────────────────────────────────────

def set_verify_token(user_id: str, otp: str) -> None:
    from datetime import timedelta
    expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _conn() as con:
        con.execute(
            "UPDATE users SET email_verify_token=?, verify_token_expires=? WHERE id=?",
            (otp, expires, user_id),
        )


def verify_user_email(user_id: str) -> None:
    with _conn() as con:
        con.execute(
            "UPDATE users SET email_verified=1, email_verify_token=NULL, verify_token_expires=NULL WHERE id=?",
            (user_id,),
        )


def set_reset_token(user_id: str, otp: str) -> None:
    from datetime import timedelta
    expires = (datetime.now(timezone.utc) + timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    with _conn() as con:
        con.execute(
            "UPDATE users SET reset_token=?, reset_token_expires=? WHERE id=?",
            (otp, expires, user_id),
        )


def get_user_by_reset_token(email: str, otp: str) -> dict | None:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM users WHERE email=? AND reset_token=?",
            (email.lower(), otp),
        ).fetchone()
    if not row:
        return None
    r = dict(row)
    expires = r.get("reset_token_expires") or ""
    if expires and expires < _now():
        return None
    return r


def get_user_by_verify_token(email: str, otp: str) -> dict | None:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM users WHERE email=? AND email_verify_token=?",
            (email.lower(), otp),
        ).fetchone()
    if not row:
        return None
    r = dict(row)
    expires = r.get("verify_token_expires") or ""
    if expires and expires < _now():
        return None
    return r


def update_user_password(user_id: str, password: str) -> None:
    from passlib.context import CryptContext
    pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
    with _conn() as con:
        con.execute(
            "UPDATE users SET password_hash=?, reset_token=NULL, reset_token_expires=NULL WHERE id=?",
            (pwd_ctx.hash(password), user_id),
        )


# ── User management (admin) ───────────────────────────────────────────────────

def list_users(limit: int = 500) -> list[dict]:
    safe_fields = ("id", "email", "full_name", "org_id", "role", "is_active",
                   "email_verified", "created_at", "last_login")
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM users ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [{k: dict(r).get(k) for k in safe_fields} for r in rows]


def update_user(user_id: str, **fields) -> bool:
    allowed = {"full_name", "role", "is_active", "email_verified", "org_id"}
    safe = {k: v for k, v in fields.items() if k in allowed}
    if not safe:
        return False
    cols = ", ".join(f"{k}=?" for k in safe)
    with _conn() as con:
        con.execute(f"UPDATE users SET {cols} WHERE id=?", (*safe.values(), user_id))
    return True


def delete_user(user_id: str) -> bool:
    with _conn() as con:
        con.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))
        con.execute("DELETE FROM users WHERE id=?", (user_id,))
    return True


# ── Cell labels ───────────────────────────────────────────────────────────────

def upsert_cell_label(cell_id: str, label: str = "", tags: list[str] | None = None,
                      notes: str = "") -> None:
    with _conn() as con:
        con.execute("""
            INSERT OR REPLACE INTO cell_labels(cell_id,label,tags,notes,updated_at)
            VALUES (?,?,?,?,?)
        """, (cell_id, label, json.dumps(tags or []), notes, _now()))


def get_cell_labels() -> dict[str, dict]:
    with _conn() as con:
        rows = con.execute("SELECT * FROM cell_labels").fetchall()
    result = {}
    for r in rows:
        d = dict(r)
        try:
            d["tags"] = json.loads(d["tags"])
        except Exception:
            d["tags"] = []
        result[d["cell_id"]] = d
    return result


def delete_cell_label(cell_id: str) -> None:
    with _conn() as con:
        con.execute("DELETE FROM cell_labels WHERE cell_id=?", (cell_id,))


# ── Fine-tune jobs ────────────────────────────────────────────────────────────

def create_finetune_job(chemistry: str, upload_path: str,
                        model_base: str = "v10-final", org: str = "") -> str:
    job_id = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO finetune_jobs
            (id,chemistry,model_base,status,progress,upload_path,created_at,org)
            VALUES (?,?,?,?,?,?,?,?)
        """, (job_id, chemistry.upper(), model_base,
              "queued", 0.0, upload_path, _now(), org))
    return job_id


def update_finetune_job(job_id: str, **fields) -> None:
    allowed = {"status", "progress", "log", "output_path",
               "error", "started_at", "finished_at"}
    sets = {k: v for k, v in fields.items() if k in allowed}
    if not sets:
        return
    sql = "UPDATE finetune_jobs SET " + ", ".join(f"{k}=?" for k in sets)
    sql += " WHERE id=?"
    with _conn() as con:
        con.execute(sql, [*sets.values(), job_id])


def get_finetune_job(job_id: str) -> dict | None:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM finetune_jobs WHERE id=?", (job_id,)
        ).fetchone()
    return dict(row) if row else None


def list_finetune_jobs(org: str = "") -> list[dict]:
    with _conn() as con:
        if org:
            rows = con.execute(
                "SELECT * FROM finetune_jobs WHERE org=? ORDER BY created_at DESC",
                (org,)
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM finetune_jobs ORDER BY created_at DESC"
            ).fetchall()
    return [dict(r) for r in rows]


# ── Licenses ──────────────────────────────────────────────────────────────────

def create_license(key: str, plan: str = "pro", seats: int = 1,
                   customer_email: str = "", notes: str = "") -> dict:
    lid = str(uuid.uuid4())
    h = hashlib.sha256(key.encode()).hexdigest()
    preview = key[:9] + "…"
    with _conn() as con:
        con.execute("""
            INSERT INTO licenses(id,key_hash,key_preview,plan,seats,
                                  customer_email,notes,status,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (lid, h, preview, plan, seats, customer_email, notes, "active", _now()))
    return {"id": lid, "key": key, "plan": plan, "seats": seats,
            "customer_email": customer_email, "status": "active", "created_at": _now()}


def activate_license(key: str) -> dict | None:
    h = hashlib.sha256(key.encode()).hexdigest()
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM licenses WHERE key_hash=? AND status='active'", (h,)
        ).fetchone()
        if not row:
            return None
        con.execute("UPDATE licenses SET activated_at=? WHERE key_hash=?",
                    (_now(), h))
    return dict(row)


def list_licenses() -> list[dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT id,key_preview,plan,seats,customer_email,notes,status,activated_at,created_at "
            "FROM licenses ORDER BY created_at DESC"
        ).fetchall()
    return [dict(r) for r in rows]


def revoke_license(lic_id: str) -> bool:
    with _conn() as con:
        cur = con.execute("UPDATE licenses SET status='revoked' WHERE id=?", (lic_id,))
    return cur.rowcount > 0


def get_license_status() -> dict:
    """Returns current activation state stored in settings_kv.
    Falls back to 'activated' (trial mode) when license system has never been configured."""
    # Check raw settings_kv so we know if admin has ever set the key
    with _conn() as con:
        row = con.execute(
            "SELECT value FROM settings_kv WHERE key='license_activated'"
        ).fetchone()
    if row is None:
        # License system not configured — allow access (trial/dev mode)
        return {"activated": True, "plan": "trial", "seats": -1,
                "key_preview": "", "activated_at": ""}
    s = get_settings()
    return {
        "activated": bool(s.get("license_activated")),
        "key_preview": s.get("license_key_preview", ""),
        "plan": s.get("license_plan", ""),
        "seats": s.get("license_seats", 0),
        "activated_at": s.get("license_activated_at", ""),
    }


# ── Brute-force protection ────────────────────────────────────────────────────

_BF_WINDOW = 15 * 60   # seconds
_BF_MAX    = 5          # attempts before lockout


def record_failed_login(email: str) -> None:
    with _conn() as con:
        con.execute("INSERT INTO failed_logins(email,ts) VALUES(?,?)",
                    (email.lower(), time.time()))
        # Prune entries older than window
        con.execute("DELETE FROM failed_logins WHERE ts<?",
                    (time.time() - _BF_WINDOW,))


def is_login_blocked(email: str) -> bool:
    cutoff = time.time() - _BF_WINDOW
    with _conn() as con:
        count = con.execute(
            "SELECT COUNT(*) FROM failed_logins WHERE email=? AND ts>=?",
            (email.lower(), cutoff)
        ).fetchone()[0]
    return count >= _BF_MAX


def clear_failed_logins(email: str) -> None:
    with _conn() as con:
        con.execute("DELETE FROM failed_logins WHERE email=?", (email.lower(),))


# OTP brute-force — reuses failed_logins table with namespaced keys
_OTP_MAX = 5

def record_otp_failure(email: str, purpose: str) -> None:
    key = f"__otp_{purpose}__:{email.lower()}"
    with _conn() as con:
        con.execute("INSERT INTO failed_logins(email,ts) VALUES(?,?)", (key, time.time()))
        con.execute("DELETE FROM failed_logins WHERE ts<?", (time.time() - _BF_WINDOW,))

def is_otp_blocked(email: str, purpose: str) -> bool:
    key = f"__otp_{purpose}__:{email.lower()}"
    cutoff = time.time() - _BF_WINDOW
    with _conn() as con:
        count = con.execute(
            "SELECT COUNT(*) FROM failed_logins WHERE email=? AND ts>=?",
            (key, cutoff)
        ).fetchone()[0]
    return count >= _OTP_MAX

def clear_otp_failures(email: str, purpose: str) -> None:
    key = f"__otp_{purpose}__:{email.lower()}"
    with _conn() as con:
        con.execute("DELETE FROM failed_logins WHERE email=?", (key,))


# ── BMS: Telemetry time-series ────────────────────────────────────────────────

def store_telemetry(cell_id: str, voltage: float, current: float,
                    temperature: float, soc: float | None = None,
                    cycle_num: int | None = None, source: str = "http",
                    pack_id: str = "") -> int:
    with _conn() as con:
        cur = con.execute("""
            INSERT INTO cell_timeseries
            (cell_id,ts,voltage,current,temperature,soc,cycle_num,source,pack_id)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (cell_id, _now(), round(voltage, 4), round(current, 4),
              round(temperature, 2), soc, cycle_num, source, pack_id))
        # Keep last 100k rows per cell to bound storage
        con.execute("""
            DELETE FROM cell_timeseries WHERE cell_id=? AND id NOT IN (
                SELECT id FROM cell_timeseries WHERE cell_id=?
                ORDER BY id DESC LIMIT 100000
            )
        """, (cell_id, cell_id))
    return cur.lastrowid


def get_telemetry(cell_id: str, limit: int = 500,
                  since: str | None = None) -> list[dict]:
    with _conn() as con:
        if since:
            rows = con.execute(
                "SELECT * FROM cell_timeseries WHERE cell_id=? AND ts>? "
                "ORDER BY id DESC LIMIT ?", (cell_id, since, limit)
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM cell_timeseries WHERE cell_id=? ORDER BY id DESC LIMIT ?",
                (cell_id, limit)
            ).fetchall()
    return [dict(r) for r in rows]


def get_latest_per_cell(pack_id: str = "") -> list[dict]:
    """Latest single reading per cell (for live dashboard)."""
    with _conn() as con:
        if pack_id:
            rows = con.execute("""
                SELECT * FROM cell_timeseries
                WHERE id IN (
                    SELECT MAX(id) FROM cell_timeseries
                    WHERE pack_id=? GROUP BY cell_id
                ) ORDER BY cell_id
            """, (pack_id,)).fetchall()
        else:
            rows = con.execute("""
                SELECT * FROM cell_timeseries
                WHERE id IN (
                    SELECT MAX(id) FROM cell_timeseries GROUP BY cell_id
                ) ORDER BY cell_id
            """).fetchall()
    return [dict(r) for r in rows]


# ── BMS: Pack topology ────────────────────────────────────────────────────────

def create_pack(name: str, description: str = "", cells_series: int = 1,
                cells_parallel: int = 1, nominal_voltage: float = 3.6,
                nominal_capacity_ah: float = 50.0,
                chemistry: str = "NMC") -> dict:
    pid = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO packs(id,name,description,cells_series,cells_parallel,
                              nominal_voltage,nominal_capacity_ah,chemistry,created_at)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (pid, name, description, cells_series, cells_parallel,
              nominal_voltage, nominal_capacity_ah, chemistry.upper(), _now()))
    return {"id": pid, "name": name}


def list_packs() -> list[dict]:
    with _conn() as con:
        rows = con.execute("SELECT * FROM packs ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_pack(pack_id: str) -> dict | None:
    with _conn() as con:
        row = con.execute("SELECT * FROM packs WHERE id=?", (pack_id,)).fetchone()
    return dict(row) if row else None


def delete_pack(pack_id: str) -> bool:
    with _conn() as con:
        con.execute("DELETE FROM pack_cells WHERE pack_id=?", (pack_id,))
        cur = con.execute("DELETE FROM packs WHERE id=?", (pack_id,))
    return cur.rowcount > 0


def add_cell_to_pack(pack_id: str, cell_id: str, module_id: str = "",
                     pos_series: int = 0, pos_parallel: int = 0,
                     capacity_ah: float = 5.0, chemistry: str = "NMC") -> dict:
    cid = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT OR REPLACE INTO pack_cells
            (id,pack_id,cell_id,module_id,position_series,position_parallel,
             nominal_capacity_ah,chemistry,added_at)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (cid, pack_id, cell_id, module_id, pos_series, pos_parallel,
              capacity_ah, chemistry.upper(), _now()))
    return {"id": cid, "pack_id": pack_id, "cell_id": cell_id}


def get_pack_cells(pack_id: str) -> list[dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM pack_cells WHERE pack_id=? ORDER BY position_series,position_parallel",
            (pack_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def remove_cell_from_pack(pack_id: str, cell_id: str) -> bool:
    with _conn() as con:
        cur = con.execute(
            "DELETE FROM pack_cells WHERE pack_id=? AND cell_id=?", (pack_id, cell_id)
        )
    return cur.rowcount > 0


# ── Per-cycle RUL history ─────────────────────────────────────────────────────

def store_rul_history(cell_id: str, cycle_num: int, rul: float,
                      rul_lower: float, rul_upper: float, soh_pct: float = 0.0,
                      model_id: str = "v10-final", chemistry: str = "LFP") -> None:
    """Persist one per-cycle RUL reading. Called automatically by rul_bridge on new cycle."""
    with _conn() as con:
        con.execute(
            "INSERT INTO cell_rul_history "
            "(cell_id, cycle_num, ts, rul, rul_lower, rul_upper, soh_pct, model_id, chemistry) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (cell_id, cycle_num, _now(), round(rul, 1), round(rul_lower, 1),
             round(rul_upper, 1), round(soh_pct, 2), model_id, chemistry.upper()),
        )


def get_rul_history(cell_id: str, limit: int = 500) -> list[dict]:
    """Return per-cycle RUL history for a cell, newest first."""
    with _conn() as con:
        rows = con.execute(
            "SELECT cycle_num, ts, rul, rul_lower, rul_upper, soh_pct, model_id "
            "FROM cell_rul_history WHERE cell_id=? ORDER BY cycle_num DESC LIMIT ?",
            (cell_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# ── BMS: Safety events ────────────────────────────────────────────────────────

def record_safety_event(cell_id: str, pack_id: str, event_type: str,
                        severity: str, value: float, limit_value: float,
                        source: str = "auto") -> str:
    eid = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO safety_events
            (id,ts,cell_id,pack_id,event_type,severity,value,limit_value,source)
            VALUES (?,?,?,?,?,?,?,?,?)
        """, (eid, _now(), cell_id, pack_id, event_type, severity,
              round(value, 4), round(limit_value, 4), source))
    return eid


def get_safety_events(cleared: bool | None = None, limit: int = 200,
                      cell_id: str = "") -> list[dict]:
    clauses, params = [], []
    if cleared is not None:
        clauses.append("cleared=?"); params.append(1 if cleared else 0)
    if cell_id:
        clauses.append("cell_id=?"); params.append(cell_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    with _conn() as con:
        rows = con.execute(
            f"SELECT * FROM safety_events {where} ORDER BY ts DESC LIMIT ?", params
        ).fetchall()
    return [dict(r) for r in rows]


def clear_safety_event(event_id: str) -> bool:
    with _conn() as con:
        cur = con.execute(
            "UPDATE safety_events SET cleared=1, cleared_at=? WHERE id=?",
            (_now(), event_id)
        )
    return cur.rowcount > 0


def get_active_trip_count() -> int:
    with _conn() as con:
        return con.execute(
            "SELECT COUNT(*) FROM safety_events WHERE cleared=0 AND severity='trip'"
        ).fetchone()[0]


# ── BMS: Control commands ─────────────────────────────────────────────────────

def log_command(command: str, target_id: str = "", parameters: dict | None = None,
                issued_by: str = "system") -> str:
    cid = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO bms_commands(id,ts,command,target_id,parameters,issued_by,status)
            VALUES (?,?,?,?,?,?,?)
        """, (cid, _now(), command, target_id,
              json.dumps(parameters or {}), issued_by, "pending"))
    return cid


def ack_command(cmd_id: str, status: str = "sent") -> None:
    with _conn() as con:
        con.execute(
            "UPDATE bms_commands SET status=?, ack_at=? WHERE id=?",
            (status, _now(), cmd_id)
        )


def get_commands(limit: int = 100) -> list[dict]:
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM bms_commands ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
    result = []
    for r in rows:
        d = dict(r)
        try: d["parameters"] = json.loads(d["parameters"])
        except Exception: pass
        result.append(d)
    return result


# ── BMS: SOC state ────────────────────────────────────────────────────────────

def save_soc_state(cell_id: str, soc: float, capacity_ah: float,
                   coulombs_in: float, chemistry: str) -> None:
    with _conn() as con:
        con.execute("""
            INSERT OR REPLACE INTO soc_state
            (cell_id,soc,capacity_ah,coulombs_in,last_update,chemistry)
            VALUES (?,?,?,?,?,?)
        """, (cell_id, round(soc, 3), round(capacity_ah, 4),
              round(coulombs_in, 4), _now(), chemistry.upper()))


def load_soc_state(cell_id: str) -> dict | None:
    with _conn() as con:
        row = con.execute(
            "SELECT * FROM soc_state WHERE cell_id=?", (cell_id,)
        ).fetchone()
    return dict(row) if row else None


def get_all_soc_states() -> list[dict]:
    with _conn() as con:
        rows = con.execute("SELECT * FROM soc_state ORDER BY cell_id").fetchall()
    return [dict(r) for r in rows]


# ── LIMS / cycler imports ─────────────────────────────────────────────────────

def store_lims_import(filename: str, fmt: str, n_cycles: int, n_rows: int,
                      nominal_capacity_ah: float, soh_initial: float | None,
                      soh_final: float | None, fade_rate_pct_per_cycle: float | None,
                      meta_json: str = "{}") -> str:
    """Persist a LIMS/cycler import row and return its UUID."""
    iid = str(uuid.uuid4())
    with _conn() as con:
        con.execute("""
            INSERT INTO lims_imports
              (id, imported_at, filename, format, n_cycles, n_rows,
               nominal_capacity_ah, soh_initial, soh_final,
               fade_rate_pct_per_cycle, meta_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (iid, _now(), filename, fmt, int(n_cycles), int(n_rows),
              float(nominal_capacity_ah), soh_initial, soh_final,
              fade_rate_pct_per_cycle, meta_json))
    return iid


def list_lims_imports(limit: int = 200) -> list[dict]:
    """Most-recent LIMS imports (newest first), bounded by `limit`."""
    with _conn() as con:
        rows = con.execute(
            "SELECT * FROM lims_imports ORDER BY imported_at DESC LIMIT ?",
            (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


# ── Cell internal-state vectors (Phase C foundation) ──────────────────────────

def store_internal_states(cell_id: str, states: dict, chemistry: str = "",
                          source: str = "twin") -> str:
    """Persist an extracted internal-state vector for a cell. Returns the
    extraction timestamp (also the row key alongside cell_id)."""
    import json as _json
    ts = _now()
    with _conn() as con:
        con.execute("""
            INSERT INTO cell_internal_states (cell_id, extracted_at, chemistry, source, states_json)
            VALUES (?,?,?,?,?)
        """, (cell_id, ts, chemistry, source, _json.dumps(states)))
    return ts


def get_internal_states(cell_id: str) -> dict | None:
    """Return the most recent internal-state vector for a cell (or None)."""
    import json as _json
    with _conn() as con:
        row = con.execute("""
            SELECT * FROM cell_internal_states
            WHERE cell_id=? ORDER BY extracted_at DESC LIMIT 1
        """, (cell_id,)).fetchone()
    if row is None:
        return None
    d = dict(row)
    try:
        d["states"] = _json.loads(d.pop("states_json", "{}"))
    except Exception:
        d["states"] = {}
    return d


def list_internal_states(limit: int = 200, chemistry: str | None = None) -> list[dict]:
    """List recent internal-state extractions (newest first), optionally filtered."""
    import json as _json
    with _conn() as con:
        if chemistry:
            rows = con.execute("""
                SELECT * FROM cell_internal_states WHERE chemistry=?
                ORDER BY extracted_at DESC LIMIT ?
            """, (chemistry.upper(), limit)).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM cell_internal_states ORDER BY extracted_at DESC LIMIT ?",
                (limit,)
            ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["states"] = _json.loads(d.pop("states_json", "{}"))
        except Exception:
            d["states"] = {}
        out.append(d)
    return out

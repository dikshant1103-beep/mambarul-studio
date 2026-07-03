#!/usr/bin/env python3
"""
migrate_to_postgres.py — One-shot migration from SQLite → PostgreSQL.

Usage:
    DATABASE_URL=postgresql://batteryos:pass@localhost:5432/batteryos \
    SQLITE_PATH=backend/data/batteryos.db \
    python3 scripts/migrate_to_postgres.py

The script:
  1. Reads all rows from the SQLite DB.
  2. Connects to PostgreSQL (must already have schema created via init_db()).
  3. Inserts all rows into PostgreSQL using ON CONFLICT DO NOTHING (safe to re-run).
  4. Prints row counts before/after for each table.
"""
from __future__ import annotations
import os
import sqlite3
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

SQLITE_PATH = os.environ.get("SQLITE_PATH", "backend/data/batteryos.db")
DATABASE_URL = os.environ.get("DATABASE_URL", "")

if not DATABASE_URL:
    print("ERROR: DATABASE_URL env var not set.")
    sys.exit(1)

TABLES = [
    "orgs",
    "users",
    "sessions",
    "api_keys",
    "analytics_calls",
    "alerts",
    "settings_kv",
    "cell_labels",
    "rate_windows",
    "finetune_jobs",
    "licenses",
    "failed_logins",
    "cell_timeseries",
    "packs",
    "pack_cells",
    "safety_events",
    "bms_commands",
    "soc_state",
]


def sqlite_rows(sqlite_con: sqlite3.Connection, table: str) -> list[dict]:
    sqlite_con.row_factory = sqlite3.Row
    try:
        cur = sqlite_con.execute(f"SELECT * FROM {table}")
        return [dict(r) for r in cur.fetchall()]
    except sqlite3.OperationalError:
        return []


def pg_insert(pg_con, table: str, rows: list[dict]) -> int:
    if not rows:
        return 0
    cols = list(rows[0].keys())
    placeholders = ", ".join(["%s"] * len(cols))
    col_names = ", ".join(cols)
    sql = (
        f"INSERT INTO {table} ({col_names}) VALUES ({placeholders}) "
        f"ON CONFLICT DO NOTHING"
    )
    with pg_con.cursor() as cur:
        inserted = 0
        for row in rows:
            try:
                cur.execute(sql, [row[c] for c in cols])
                inserted += cur.rowcount
            except Exception as e:
                pg_con.rollback()
                print(f"  WARNING: row skipped in {table}: {e}")
        pg_con.commit()
    return inserted


def main():
    if not Path(SQLITE_PATH).exists():
        print(f"ERROR: SQLite file not found: {SQLITE_PATH}")
        sys.exit(1)

    print(f"Source:      SQLite @ {SQLITE_PATH}")
    print(f"Destination: {DATABASE_URL[:40]}...")
    print()

    sqlite_con = sqlite3.connect(SQLITE_PATH)
    pg_con = psycopg2.connect(DATABASE_URL)

    total_rows = 0
    total_inserted = 0

    for table in TABLES:
        rows = sqlite_rows(sqlite_con, table)
        inserted = pg_insert(pg_con, table, rows)
        total_rows += len(rows)
        total_inserted += inserted
        status = "✓" if inserted == len(rows) else f"! ({len(rows) - inserted} skipped)"
        print(f"  {table:<25} {len(rows):>6} rows  →  {inserted:>6} inserted  {status}")

    sqlite_con.close()
    pg_con.close()

    print()
    print(f"Migration complete: {total_inserted}/{total_rows} rows transferred.")


if __name__ == "__main__":
    main()

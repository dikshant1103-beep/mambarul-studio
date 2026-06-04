"""
core/backup.py — Daily SQLite backup, keeps last 7 copies.

Usage:
  from core.backup import start_backup_scheduler, backup_now, list_backups
  start_backup_scheduler()   # call from lifespan
"""
from __future__ import annotations
import logging
import shutil
import threading
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

_stop_event = threading.Event()
_thread: threading.Thread | None = None
_KEEP = 7


def _src_path() -> Path:
    from core.db import _get_db_path
    return _get_db_path()


def _do_backup() -> Path | None:
    try:
        src = _src_path()
        backup_dir = src.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        dst = backup_dir / f"batteryos_{stamp}.db"
        shutil.copy2(src, dst)
        logger.info("Backup created: %s (%.1f KB)", dst.name, dst.stat().st_size / 1024)
        copies = sorted(backup_dir.glob("batteryos_*.db"))
        for old in copies[:-_KEEP]:
            old.unlink(missing_ok=True)
            logger.debug("Pruned old backup: %s", old.name)
        return dst
    except Exception as exc:
        logger.warning("Backup failed: %s", exc)
        return None


def backup_now() -> dict:
    dst = _do_backup()
    if dst:
        return {"ok": True, "name": dst.name,
                "size_kb": round(dst.stat().st_size / 1024, 1)}
    return {"ok": False, "error": "Backup failed — check server logs."}


def list_backups() -> list[dict]:
    try:
        backup_dir = _src_path().parent / "backups"
        if not backup_dir.exists():
            return []
        files = sorted(backup_dir.glob("batteryos_*.db"), reverse=True)
        return [
            {"name": f.name,
             "size_kb": round(f.stat().st_size / 1024, 1),
             "ts": f.stem.replace("batteryos_", "")}
            for f in files
        ]
    except Exception:
        return []


def _scheduler_loop(interval_seconds: int) -> None:
    while not _stop_event.wait(interval_seconds):
        _do_backup()


def start_backup_scheduler(interval_hours: int = 24) -> None:
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop_event.clear()
    _thread = threading.Thread(
        target=_scheduler_loop,
        args=(interval_hours * 3600,),
        daemon=True,
        name="backup-scheduler",
    )
    _thread.start()
    logger.info("Backup scheduler started (every %dh, keep last %d)", interval_hours, _KEEP)


def stop_backup_scheduler() -> None:
    _stop_event.set()

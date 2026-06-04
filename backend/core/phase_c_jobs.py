"""
core/phase_c_jobs.py — Background job runner for Phase C heavy compute.

Two job types:
  - `synthetic_cache`  → invokes scripts/cache_pybamm_synthetic_cells.py
  - `real_label_cache` → invokes scripts/cache_pybamm_real_labels.py

Single-slot scheduler (only one job at a time). Live status + rolling log
tail (last 200 lines) consumable by the admin dashboard.
"""
from __future__ import annotations

import logging
import shlex
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

logger = logging.getLogger(__name__)

_REPO = Path(__file__).resolve().parent.parent.parent
_SCRIPTS = _REPO / "scripts"

_LOG_TAIL_MAX = 200
_lock  = threading.Lock()
_state: dict = {
    "state":   "idle",          # idle | running | completed | failed
    "job":     None,            # synthetic_cache | real_label_cache
    "started_at":  None,
    "ended_at":    None,
    "exit_code":   None,
    "cmd":         None,
    "log_path":    None,
    "summary":     None,
}
_log_tail: deque[str] = deque(maxlen=_LOG_TAIL_MAX)


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


def get_status() -> dict:
    with _lock:
        snap = dict(_state)
        snap["log_tail"] = list(_log_tail)
        return snap


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


def _run_subprocess(cmd: list[str], log_path: Path) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with open(log_path, "w", buffering=1) as fh:
        proc = subprocess.Popen(
            cmd, stdout=fh, stderr=subprocess.STDOUT,
            cwd=str(_REPO),
        )
    # tail the log file while the process runs
    tailer = threading.Thread(target=_tail_log_file, args=(log_path, proc),
                              daemon=True, name="phase-c-log-tail")
    tailer.start()
    rc = proc.wait()
    tailer.join(timeout=2)
    return rc


def _tail_log_file(log_path: Path, proc: subprocess.Popen) -> None:
    """Mirror the most recent lines from the on-disk log into the in-memory
    deque so the dashboard can render them. Runs until the process exits."""
    try:
        # wait for the file to exist
        for _ in range(50):
            if log_path.exists():
                break
            time.sleep(0.1)
        with open(log_path) as fh:
            while True:
                line = fh.readline()
                if line:
                    with _lock:
                        _log_tail.append(line.rstrip("\n"))
                else:
                    if proc.poll() is not None:
                        break
                    time.sleep(0.5)
    except Exception as exc:
        logger.debug("phase-c log tail failed: %s", exc)


def _job_thread(job: str, cmd: list[str], log_path: Path) -> None:
    rc = -1
    try:
        rc = _run_subprocess(cmd, log_path)
        ok = rc == 0
        _set(state="completed" if ok else "failed", exit_code=rc,
             ended_at=_now(),
             summary=f"{job} {'OK' if ok else 'FAILED'} (exit {rc})")
    except Exception as exc:
        _set(state="failed", exit_code=-1, ended_at=_now(),
             summary=f"{job} crashed: {exc}")


def _launch(job: str, cmd: list[str]) -> dict:
    log_path = _REPO / "processed" / "phase_c" / f"{job}_{int(time.time())}.log"
    with _lock:
        if _state["state"] == "running":
            return {"error": "another phase-c job is already running",
                    "current_job": _state["job"]}
        _state.update({
            "state":      "running",
            "job":        job,
            "started_at": _now(),
            "ended_at":   None,
            "exit_code":  None,
            "cmd":        " ".join(shlex.quote(c) for c in cmd),
            "log_path":   str(log_path),
            "summary":    f"{job} started",
        })
        _log_tail.clear()
    threading.Thread(target=_job_thread, args=(job, cmd, log_path),
                     daemon=True, name=f"phase-c-{job}").start()
    return {"ok": True, "job": job, "log_path": str(log_path)}


def start_synthetic_cache(chemistries: list[str], c_rates: list[float],
                          temps: list[float], n_cycles: int,
                          model_mode: str) -> dict:
    cmd = [
        "python", str(_SCRIPTS / "cache_pybamm_synthetic_cells.py"),
        "--chemistries", *chemistries,
        "--c-rates",  *(str(c) for c in c_rates),
        "--temps",    *(str(t) for t in temps),
        "--n-cycles", str(n_cycles),
        "--model-mode", model_mode,
    ]
    return _launch("synthetic_cache", cmd)


def start_real_label_cache(max_cells: int, chemistry: str | None,
                           n_cycles: int, model_mode: str,
                           skip_existing: bool) -> dict:
    cmd = [
        "python", str(_SCRIPTS / "cache_pybamm_real_labels.py"),
        "--max-cells", str(max_cells),
        "--n-cycles",  str(n_cycles),
        "--model-mode", model_mode,
    ]
    if chemistry:
        cmd += ["--chemistry", chemistry]
    if skip_existing:
        cmd += ["--skip-existing"]
    return _launch("real_label_cache", cmd)


def start_two_stage_training(stage1_epochs: int, stage2_epochs: int,
                             lr: float, val_frac: float,
                             no_pretrain: bool, prefer_source: str | None,
                             out_subdir: str | None) -> dict:
    """Launch scripts/train_two_stage.py as a background job. Same single-slot
    contract as the other phase-c jobs."""
    out_dir = (_REPO / "processed" / "internal_state_head"
               / (out_subdir or f"train_{int(time.time())}"))
    cmd = [
        "python", str(_SCRIPTS / "train_two_stage.py"),
        "--stage1-epochs", str(stage1_epochs),
        "--stage2-epochs", str(stage2_epochs),
        "--lr",            str(lr),
        "--val-frac",      str(val_frac),
        "--out",           str(out_dir),
    ]
    if no_pretrain:
        cmd.append("--no-pretrain")
    if prefer_source:
        cmd += ["--prefer-source", prefer_source]
    return _launch("two_stage_training", cmd)

"""
backend/launcher.py — PyInstaller-bundled standalone entrypoint.

When BatteryOS is shipped as a self-contained AppImage (no system Python
required on the customer machine), this is the file PyInstaller wraps. It
boots uvicorn against `backend.main:app` on a fixed host/port the Electron
shell knows about.

Usage outside the AppImage:
    python -m backend.launcher [--host 127.0.0.1] [--port 8765]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path


def main():
    ap = argparse.ArgumentParser(description="BatteryOS backend launcher")
    ap.add_argument("--host", default=os.environ.get("BATTERYOS_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int,
                    default=int(os.environ.get("BATTERYOS_PORT", "8765")))
    ap.add_argument("--log-level", default=os.environ.get("LOG_LEVEL", "info"))
    args = ap.parse_args()

    # Ensure backend/ is on sys.path so `core.*` imports work both when run
    # via `python -m backend.launcher` and when frozen by PyInstaller.
    here = Path(__file__).resolve().parent
    if str(here) not in sys.path:
        sys.path.insert(0, str(here))

    # Tell main.py where the frontend dist lives. In the AppImage, both the
    # backend binary and the frontend dist sit under the same resources dir.
    if getattr(sys, "frozen", False):
        # PyInstaller-frozen: resources are next to the binary
        binary_dir = Path(sys.executable).parent
        os.environ.setdefault("FRONTEND_DIST",
                              str(binary_dir / "frontend_dist"))
    # Import the app object directly so PyInstaller-bundled binaries don't
    # need to resolve "main:app" from the filesystem at runtime.
    import uvicorn
    from main import app
    uvicorn.run(app, host=args.host, port=args.port,
                log_level=args.log_level, reload=False, workers=1)


if __name__ == "__main__":
    main()

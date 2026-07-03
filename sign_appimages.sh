#!/usr/bin/env bash
# sign_appimages.sh — Mark BatteryOS AppImages as trusted and executable.
# Run once after building AppImages, or after downloading a new release.
set -e

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_DIR="$STUDIO_DIR/dist"

mark_trusted() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo "[SKIP] $f — not found"
    return
  fi
  chmod +x "$f"
  # Remove quarantine flag (macOS only, ignored on Linux)
  xattr -d com.apple.quarantine "$f" 2>/dev/null || true
  # Mark as trusted in the desktop database (Linux)
  gio set "$f" metadata::trusted true 2>/dev/null || true
  echo "[OK]  $f — marked executable & trusted"
}

echo "BatteryOS AppImage signing"
echo "=========================="
mark_trusted "$DIST_DIR/MambaRUL-Studio.AppImage"
mark_trusted "$DIST_DIR/BatteryOS.AppImage"

# Also mark anything in the home dist location
if [ -d "$HOME/mamba_rul_project/mambaRUL_studio/dist" ]; then
  mark_trusted "$HOME/mamba_rul_project/mambaRUL_studio/dist/MambaRUL-Studio.AppImage"
  mark_trusted "$HOME/mamba_rul_project/mambaRUL_studio/dist/BatteryOS.AppImage"
fi

echo ""
echo "Done. You can now double-click the AppImages to launch them."

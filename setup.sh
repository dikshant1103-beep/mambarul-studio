#!/usr/bin/env bash
set -e

STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$STUDIO_DIR/backend"
FRONTEND_DIR="$STUDIO_DIR/frontend"
CUSTOMER_DIR="$STUDIO_DIR/frontend_customer"

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║       MambaRUL Studio — Setup            ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ── Preflight checks ───────────────────────────────────────────
echo "[0/5] Checking requirements..."

if ! command -v python3 &> /dev/null; then
  echo "  ERROR: Python 3 not found. Install Python 3.10+ from https://python.org"
  exit 1
fi

PY_VER=$(python3 -c "import sys; print(sys.version_info.minor)")
if [ "$PY_VER" -lt 10 ]; then
  echo "  ERROR: Python 3.10+ required (found 3.$PY_VER)"
  exit 1
fi

if ! command -v node &> /dev/null; then
  echo "  ERROR: Node.js not found. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi

echo "  Python $(python3 --version) ✓"
echo "  Node $(node --version) ✓"

# ── Backend setup ──────────────────────────────────────────────
echo "[1/5] Setting up Python backend..."
cd "$BACKEND_DIR"

if [ ! -d "venv" ]; then
  python3 -m venv venv
  echo "  Created venv"
fi

source venv/bin/activate
pip install --upgrade pip -q
pip install -r requirements.txt -q
# Extra packages not always in requirements.txt
pip install fpdf2 paho-mqtt pymodbus python-can -q 2>/dev/null || true
echo "  Backend dependencies installed"
deactivate

# ── Admin frontend setup ───────────────────────────────────────
echo "[2/5] Setting up admin frontend..."
cd "$FRONTEND_DIR"
npm install --silent
echo "  Admin frontend dependencies installed"

# ── Customer frontend setup ────────────────────────────────────
echo "[3/5] Setting up customer frontend..."
cd "$CUSTOMER_DIR"
# Reuse admin node_modules if symlink already exists
if [ ! -d "node_modules" ]; then
  if [ -d "$FRONTEND_DIR/node_modules" ]; then
    ln -s "$FRONTEND_DIR/node_modules" node_modules
    echo "  Symlinked node_modules from admin frontend"
  else
    npm install --silent
    echo "  Customer frontend dependencies installed"
  fi
else
  echo "  node_modules already present"
fi

# ── Start scripts ──────────────────────────────────────────────
echo "[4/5] Creating start scripts..."

cat > "$STUDIO_DIR/start_backend.sh" << 'BACKEND_EOF'
#!/usr/bin/env bash
cd "$(dirname "${BASH_SOURCE[0]}")/backend"
source venv/bin/activate
echo "Starting MambaRUL Studio backend on http://localhost:8000"
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
BACKEND_EOF
chmod +x "$STUDIO_DIR/start_backend.sh"

cat > "$STUDIO_DIR/start_frontend.sh" << 'FRONTEND_EOF'
#!/usr/bin/env bash
cd "$(dirname "${BASH_SOURCE[0]}")/frontend"
echo "Starting MambaRUL Studio frontend on http://localhost:5173"
npm run dev
FRONTEND_EOF
chmod +x "$STUDIO_DIR/start_frontend.sh"

cat > "$STUDIO_DIR/start_all.sh" << 'ALL_EOF'
#!/usr/bin/env bash
STUDIO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo ""
echo "  Starting MambaRUL Studio..."
echo "  Backend  → http://localhost:8000"
echo "  Frontend → http://localhost:5173"
echo ""
echo "  Press Ctrl+C to stop both servers"
echo ""

# Start backend
(cd "$STUDIO_DIR/backend" && source venv/bin/activate && uvicorn main:app --host 0.0.0.0 --port 8000 2>&1 | sed 's/^/  [backend] /') &
BACKEND_PID=$!

# Wait for backend
sleep 2

# Start frontend
(cd "$STUDIO_DIR/frontend" && npm run dev 2>&1 | sed 's/^/  [frontend] /') &
FRONTEND_PID=$!

# Wait and handle Ctrl+C
cleanup() {
  echo ""
  echo "  Stopping MambaRUL Studio..."
  kill $BACKEND_PID $FRONTEND_PID 2>/dev/null
  exit 0
}
trap cleanup INT TERM
wait
ALL_EOF
chmod +x "$STUDIO_DIR/start_all.sh"

echo "[5/5] Setup complete!"
echo ""
echo "  ╔══════════════════════════════════════════════════════╗"
echo "  ║  Setup complete! Launch options:                     ║"
echo "  ║                                                      ║"
echo "  ║  AppImage (recommended):                             ║"
echo "  ║    ./dist/MambaRUL-Studio.AppImage  (admin)          ║"
echo "  ║    ./dist/BatteryOS.AppImage         (customer)       ║"
echo "  ║                                                      ║"
echo "  ║  Dev mode:                                           ║"
echo "  ║    ./start_all.sh   → http://localhost:5173          ║"
echo "  ╚══════════════════════════════════════════════════════╝"
echo ""

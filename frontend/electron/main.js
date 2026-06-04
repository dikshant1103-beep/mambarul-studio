const { app, BrowserWindow, shell, ipcMain, dialog, session } = require('electron')
const path = require('path')
const { spawn, execSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const crypto = require('crypto')

// Per-launch nonce: backend validates this header so only THIS Electron instance
// can reach the API. Regenerated on every app start.
const APP_NONCE = crypto.randomBytes(32).toString('hex')

// ── Paths ────────────────────────────────────────────────────────────────────
function resolveStudioDir() {
  if (process.env.APPIMAGE) {
    return path.resolve(path.dirname(process.env.APPIMAGE), '..')
  }
  return path.resolve(__dirname, '..', '..')
}

// Parse backend/.env → plain object (shell env takes priority over .env)
function loadDotEnv(envPath) {
  const out = {}
  if (!fs.existsSync(envPath)) return out
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq < 1) continue
    const key = t.slice(0, eq).trim()
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    out[key] = val
  }
  return out
}

const STUDIO_DIR = resolveStudioDir()
const BACKEND_DIR = path.join(STUDIO_DIR, 'backend')
const VENV_PYTHON = path.join(BACKEND_DIR, 'venv', 'bin', 'python3')
const UVICORN    = path.join(BACKEND_DIR, 'venv', 'bin', 'uvicorn')
const MAIN_PY    = path.join(BACKEND_DIR, 'main.py')

// PyInstaller-bundled standalone backend. When present (only inside the
// AppImage build that ships extraResources/batteryos_backend), we prefer it
// over any system Python. The customer machine then needs ZERO Python deps.
const BUNDLED_BACKEND_DIR = process.resourcesPath
  ? path.join(process.resourcesPath, 'batteryos_backend')
  : path.join(STUDIO_DIR, 'dist', 'batteryos_backend')
const BUNDLED_BACKEND_BIN = path.join(BUNDLED_BACKEND_DIR, 'batteryos_backend')
const ICON_PATH  = path.join(STUDIO_DIR, 'assets', 'icons', 'icon.png')
const BACKEND_URL = 'http://127.0.0.1:8000'
const BACKEND_PORT = 8000

let mainWindow = null
let splashWindow = null
let backendProcess = null
let backendReady = false

// ── Backend management ────────────────────────────────────────────────────────

function findPython() {
  if (fs.existsSync(UVICORN)) return null  // use uvicorn directly
  // Fallback: look for system uvicorn or python with uvicorn
  for (const p of [VENV_PYTHON, 'python3', 'python']) {
    try { execSync(`${p} -c "import uvicorn"`, { stdio: 'ignore' }); return p } catch {}
  }
  return null
}

function killPortSync(port) {
  // Kill any process already bound to the port so we always start fresh.
  try {
    execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: 'ignore' })
  } catch {}
  // Short synchronous wait for the OS to release the port
  const t = Date.now(); while (Date.now() - t < 400) {}
}

function startBackend() {
  return new Promise((resolve, reject) => {
    // Free the port first — prevents "address already in use" from stale processes
    killPortSync(BACKEND_PORT)

    const args = [
      'main:app',
      '--host', '127.0.0.1',
      '--port', String(BACKEND_PORT),
      '--log-level', 'warning',
    ]

    const dotEnv = loadDotEnv(path.join(BACKEND_DIR, '.env'))
    const spawnOpts = {
      cwd: BACKEND_DIR,
      env: { ...dotEnv, ...process.env, PYTHONUNBUFFERED: '1', APP_NONCE },
      stdio: ['ignore', 'pipe', 'pipe'],
    }

    let proc
    if (fs.existsSync(BUNDLED_BACKEND_BIN)) {
      // PyInstaller-bundled backend — no Python required on the host.
      // The launcher.py entrypoint takes --host/--port, NOT uvicorn args.
      // Bundle ships read-only inside the AppImage squashfs, so the backend
      // MUST write its SQLite DB + processed/ artefacts to a writable user
      // location. We use Electron's per-app userData dir.
      const userData = app.getPath('userData')
      const writableDb  = path.join(userData, 'batteryos.db')
      const writableLog = path.join(userData, 'logs')
      try {
        fs.mkdirSync(path.dirname(writableDb), { recursive: true })
        fs.mkdirSync(writableLog, { recursive: true })
      } catch (e) { console.log('[electron] writable-dir setup:', e.message) }
      const bundledEnv = {
        ...spawnOpts.env,
        DB_PATH:    writableDb,
        LOGS_DIR:   writableLog,
        // Tell the frozen backend where the React SPA lives. STUDIO_DIR is
        // resolved by Electron from APPIMAGE env var (real filesystem path),
        // so the backend can serve the frontend dist even though __file__
        // inside PyInstaller resolves to a temp extraction directory.
        FRONTEND_DIST: path.join(STUDIO_DIR, 'frontend', 'dist'),
        PROCESSED_DIR: path.join(STUDIO_DIR, '..', 'processed'),
        MLFLOW_ALLOW_FILE_STORE: 'true',
        MLFLOW_TRACKING_URI: path.join(userData, 'mlruns'),
        JWT_SECRET: spawnOpts.env.JWT_SECRET || `batteryos-local-${userData.replace(/\W/g, '')}-32chars-min!!`,
      }
      proc = spawn(BUNDLED_BACKEND_BIN, [
        '--host', '127.0.0.1',
        '--port', String(BACKEND_PORT),
        '--log-level', 'warning',
      ], { ...spawnOpts, env: bundledEnv, cwd: BUNDLED_BACKEND_DIR })
    } else if (fs.existsSync(UVICORN)) {
      proc = spawn(UVICORN, args, spawnOpts)
    } else {
      const python = findPython()
      if (!python) {
        reject(new Error('Python / uvicorn not found. Run setup.sh first.'))
        return
      }
      proc = spawn(python, ['-m', 'uvicorn', ...args], spawnOpts)
    }

    backendProcess = proc

    proc.stdout.on('data', d => {
      const msg = d.toString().trim()
      if (msg) console.log('[backend]', msg)
    })
    proc.stderr.on('data', d => {
      const msg = d.toString().trim()
      if (msg) console.log('[backend]', msg)
    })
    proc.on('error', err => reject(err))
    proc.on('close', code => {
      if (!backendReady) reject(new Error(`Backend exited early with code ${code}`))
    })

    // Poll until backend responds
    const deadline = Date.now() + 30_000
    const poll = () => {
      http.get(`${BACKEND_URL}/api/health`, res => {
        if (res.statusCode === 200) {
          backendReady = true
          console.log('[electron] Backend ready at', BACKEND_URL)
          resolve()
        } else {
          scheduleRetry()
        }
      }).on('error', () => scheduleRetry())
    }
    const scheduleRetry = () => {
      if (Date.now() > deadline) {
        reject(new Error('Backend did not start within 30s'))
      } else {
        setTimeout(poll, 500)
      }
    }
    setTimeout(poll, 1000)
  })
}

function stopBackend() {
  if (backendProcess) {
    try { backendProcess.kill('SIGTERM') } catch {}
    backendProcess = null
  }
}

// ── Splash window ─────────────────────────────────────────────────────────────

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    center: true,
    transparent: false,
    backgroundColor: '#0a0e1a',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })

  const splashHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0a0e1a;
    color: #f1f5f9;
    font-family: 'Inter', system-ui, sans-serif;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100vh;
    overflow: hidden;
  }
  .logo {
    width: 64px; height: 64px;
    background: linear-gradient(135deg, #3b82f6, #06b6d4);
    border-radius: 16px;
    display: flex; align-items: center; justify-content: center;
    margin-bottom: 20px;
    box-shadow: 0 0 30px rgba(59,130,246,0.4);
  }
  h1 { font-size: 26px; font-weight: 800; margin-bottom: 4px;
       background: linear-gradient(135deg, #60a5fa, #06b6d4);
       -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .sub { font-size: 12px; color: #64748b; margin-bottom: 28px; }
  .bar-bg {
    width: 220px; height: 3px; background: #1e3a5f;
    border-radius: 2px; overflow: hidden;
  }
  .bar {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, #3b82f6, #06b6d4);
    border-radius: 2px;
    animation: fill 4s ease-out forwards;
  }
  @keyframes fill { to { width: 95%; } }
  .status { font-size: 11px; color: #475569; margin-top: 10px; }
  .dot { display: inline-block; animation: blink 1s ease-in-out infinite; }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
</style>
</head>
<body>
  <div class="logo">
    <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
      <rect x="4" y="11" width="24" height="14" rx="3" fill="none" stroke="white" stroke-width="2"/>
      <rect x="28" y="14" width="4" height="8" rx="2" fill="white"/>
      <path d="M18 8 L13 19 L18 19 L12 28" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    </svg>
  </div>
  <h1>MambaRUL Studio</h1>
  <div class="sub">Scientific Battery Intelligence Platform</div>
  <div class="bar-bg"><div class="bar"></div></div>
  <div class="status">Starting backend<span class="dot">...</span></div>
</body>
</html>`

  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(splashHtml))
  splashWindow.setAlwaysOnTop(true)
}

// ── Main window ───────────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#0a0e1a',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    title: 'MambaRUL Studio',
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
  })

  // Open external links in default browser, not electron
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy()
      splashWindow = null
    }
    mainWindow.show()
    mainWindow.focus()
  })

  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.loadURL(BACKEND_URL)
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // ── Security: inject CSP and app nonce on every response ─────────────────
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' http://127.0.0.1:8000; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; " +
          "connect-src 'self' http://127.0.0.1:8000 ws://127.0.0.1:8000; " +
          "font-src 'self' data:;"
        ],
        'X-Frame-Options': ['DENY'],
        'X-Content-Type-Options': ['nosniff'],
      },
    })
  })

  createSplash()

  try {
    await startBackend()
    createMainWindow()
  } catch (err) {
    console.error('[electron] Startup error:', err.message)
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()

    dialog.showErrorBox(
      'MambaRUL Studio — Startup Failed',
      `Could not start the backend server.\n\n${err.message}\n\n` +
      `First-time setup:\n` +
      `  1. Open a terminal in the mambaRUL_studio folder\n` +
      `  2. Run:  ./setup.sh\n` +
      `  3. Wait for "Setup complete!", then relaunch this app\n\n` +
      `Requires: Python 3.10+, Node.js 18+`
    )
    app.quit()
  }
})

app.on('window-all-closed', () => {
  stopBackend()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => stopBackend())

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
})

process.on('exit', stopBackend)
process.on('SIGINT', () => { stopBackend(); process.exit(0) })
process.on('SIGTERM', () => { stopBackend(); process.exit(0) })

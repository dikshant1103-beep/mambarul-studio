const { app, BrowserWindow, shell, dialog, session } = require('electron')
const path = require('path')
const { spawn, execSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const crypto = require('crypto')

const APP_NONCE = crypto.randomBytes(32).toString('hex')

// ── Paths ─────────────────────────────────────────────────────────────────────
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

const STUDIO_DIR   = resolveStudioDir()
const BACKEND_DIR  = path.join(STUDIO_DIR, 'backend')
const VENV_PYTHON  = path.join(BACKEND_DIR, 'venv', 'bin', 'python3')
const UVICORN      = path.join(BACKEND_DIR, 'venv', 'bin', 'uvicorn')

// PyInstaller-bundled standalone backend (see backend/batteryos_backend.spec).
// When present inside the AppImage's extraResources, prefer it over Python.
const BUNDLED_BACKEND_DIR = process.resourcesPath
  ? path.join(process.resourcesPath, 'batteryos_backend')
  : path.join(STUDIO_DIR, 'dist', 'batteryos_backend')
const BUNDLED_BACKEND_BIN = path.join(BUNDLED_BACKEND_DIR, 'batteryos_backend')
const ICON_PATH    = path.join(STUDIO_DIR, 'assets', 'icons', 'icon.png')
const BACKEND_PORT = 8001   // API-only backend
const STATIC_PORT  = 8002   // customer frontend server
const BACKEND_URL  = `http://127.0.0.1:${BACKEND_PORT}`
const STATIC_URL   = `http://127.0.0.1:${STATIC_PORT}`

let mainWindow     = null
let splashWindow   = null
let backendProcess = null
let staticServer   = null
let backendReady   = false

// ── Resolve customer frontend dist ─────────────────────────────────────────────
// When packaged, dist/ is bundled inside app.asar; Electron patches fs to read it.
function resolveFrontendDist() {
  const bundled = path.join(app.getAppPath(), 'dist')
  if (fs.existsSync(path.join(bundled, 'index.html'))) return bundled
  return path.join(STUDIO_DIR, 'frontend_customer', 'dist')
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function killPortSync(port) {
  try { execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: 'ignore' }) } catch {}
  const t = Date.now(); while (Date.now() - t < 400) {}
}

function findPython() {
  if (fs.existsSync(UVICORN)) return null
  for (const p of [VENV_PYTHON, 'python3', 'python']) {
    try { execSync(`${p} -c "import uvicorn"`, { stdio: 'ignore' }); return p } catch {}
  }
  return null
}

// ── Backend ───────────────────────────────────────────────────────────────────
function startBackend() {
  return new Promise((resolve, reject) => {
    killPortSync(BACKEND_PORT)

    const args = ['main:app', '--host', '127.0.0.1', '--port', String(BACKEND_PORT), '--log-level', 'warning']

    const dotEnv = loadDotEnv(path.join(BACKEND_DIR, '.env'))
    const merged = { ...dotEnv, ...process.env }

    // DB isolation: PostgreSQL uses CUSTOMER_DATABASE_URL (separate DB from admin).
    // SQLite fallback uses customer.db (separate file from admin batteryos.db).
    const customerDbPath = path.join(STUDIO_DIR, 'backend', 'data', 'customer.db')
    const dbEnv = merged.CUSTOMER_DATABASE_URL
      ? { DATABASE_URL: merged.CUSTOMER_DATABASE_URL }
      : merged.DATABASE_URL
        ? { DATABASE_URL: merged.DATABASE_URL }
        : { DB_PATH: customerDbPath }

    const spawnOpts = {
      cwd: BACKEND_DIR,
      env: {
        ...merged,
        ...dbEnv,
        PYTHONUNBUFFERED: '1',
        BATTERYOS_VARIANT: 'customer',
        APP_NONCE,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }

    let proc
    if (fs.existsSync(BUNDLED_BACKEND_BIN)) {
      // Bundle ships read-only — SQLite + logs must go to a writable user dir.
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
        FRONTEND_DIST: path.join(STUDIO_DIR, 'frontend_customer', 'dist'),
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
      if (!python) { reject(new Error('Python / uvicorn not found. Run setup.sh first.')); return }
      proc = spawn(python, ['-m', 'uvicorn', ...args], spawnOpts)
    }

    backendProcess = proc
    proc.stdout.on('data', d => { const m = d.toString().trim(); if (m) console.log('[backend]', m) })
    proc.stderr.on('data', d => { const m = d.toString().trim(); if (m) console.log('[backend]', m) })
    proc.on('error', err => reject(err))
    proc.on('close', code => { if (!backendReady) reject(new Error(`Backend exited early with code ${code}`)) })

    const deadline = Date.now() + 30_000
    const poll = () => {
      http.get(`${BACKEND_URL}/api/health`, res => {
        if (res.statusCode === 200) { backendReady = true; console.log('[electron] Backend ready'); resolve() }
        else scheduleRetry()
      }).on('error', () => scheduleRetry())
    }
    const scheduleRetry = () => {
      if (Date.now() > deadline) reject(new Error('Backend did not start within 30s'))
      else setTimeout(poll, 500)
    }
    setTimeout(poll, 1000)
  })
}

function stopBackend() {
  if (backendProcess) { try { backendProcess.kill('SIGTERM') } catch {} backendProcess = null }
}

// ── Static + API proxy server ─────────────────────────────────────────────────
// Serves customer frontend from dist/ and proxies /api/ calls to the backend.
// This guarantees the customer bundle is always shown regardless of backend config.
function startStaticServer() {
  return new Promise((resolve, reject) => {
    killPortSync(STATIC_PORT)

    const DIST = resolveFrontendDist()
    console.log('[electron] Customer frontend dist:', DIST)

    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js':   'application/javascript',
      '.css':  'text/css',
      '.png':  'image/png',
      '.jpg':  'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg':  'image/svg+xml',
      '.ico':  'image/x-icon',
      '.json': 'application/json',
      '.woff': 'font/woff',
      '.woff2':'font/woff2',
      '.ttf':  'font/ttf',
    }

    staticServer = http.createServer((req, res) => {
      const urlPath = (req.url || '/').split('?')[0]

      // Proxy /api/ and /static/ to the backend
      if (urlPath.startsWith('/api/') || urlPath.startsWith('/static/')) {
        const options = {
          hostname: '127.0.0.1',
          port: BACKEND_PORT,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `127.0.0.1:${BACKEND_PORT}` },
        }
        const proxyReq = http.request(options, proxyRes => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers)
          proxyRes.pipe(res)
        })
        proxyReq.on('error', () => { try { res.writeHead(502).end('Backend unavailable') } catch {} })
        req.pipe(proxyReq)
        return
      }

      // Serve static file or fall back to index.html (SPA routing)
      const decoded = decodeURIComponent(urlPath)
      let filePath = path.join(DIST, decoded === '/' ? 'index.html' : decoded)

      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        filePath = path.join(DIST, 'index.html')
      }

      const ext = path.extname(filePath).toLowerCase()
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
      fs.createReadStream(filePath).pipe(res)
    })

    staticServer.listen(STATIC_PORT, '127.0.0.1', () => {
      console.log('[electron] Customer static server ready on port', STATIC_PORT)
      resolve()
    })
    staticServer.on('error', reject)
  })
}

function stopStaticServer() {
  if (staticServer) { try { staticServer.close() } catch {} staticServer = null }
}

// ── Splash ────────────────────────────────────────────────────────────────────
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420, height: 260, frame: false, resizable: false, center: true,
    transparent: false, backgroundColor: '#0a0e1a',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:#0a0e1a;color:#f1f5f9;font-family:system-ui,sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh}
  .logo{width:56px;height:56px;background:linear-gradient(135deg,#3b82f6,#06b6d4);
        border-radius:14px;display:flex;align-items:center;justify-content:center;
        margin-bottom:16px;box-shadow:0 0 24px rgba(59,130,246,.4)}
  h1{font-size:22px;font-weight:800;margin-bottom:2px;
     background:linear-gradient(135deg,#60a5fa,#06b6d4);
     -webkit-background-clip:text;-webkit-text-fill-color:transparent}
  .sub{font-size:11px;color:#64748b;margin-bottom:24px}
  .bar-bg{width:200px;height:2px;background:#1e3a5f;border-radius:2px;overflow:hidden}
  .bar{height:100%;width:0%;background:linear-gradient(90deg,#3b82f6,#06b6d4);
       border-radius:2px;animation:fill 4s ease-out forwards}
  @keyframes fill{to{width:90%}}
  .status{font-size:10px;color:#475569;margin-top:8px}
</style></head><body>
  <div class="logo">
    <svg width="30" height="30" viewBox="0 0 36 36" fill="none">
      <rect x="4" y="11" width="24" height="14" rx="3" fill="none" stroke="white" stroke-width="2"/>
      <rect x="28" y="14" width="4" height="8" rx="2" fill="white"/>
      <path d="M18 8 L13 19 L18 19 L12 28" stroke="white" stroke-width="1.8" fill="none" stroke-linecap="round"/>
    </svg>
  </div>
  <h1>BatteryOS</h1>
  <div class="sub">RUL Intelligence Platform</div>
  <div class="bar-bg"><div class="bar"></div></div>
  <div class="status">Starting…</div>
</body></html>`
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  splashWindow.setAlwaysOnTop(true)
}

// ── Main window ───────────────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1300, height: 860, minWidth: 1000, minHeight: 650,
    show: false, backgroundColor: '#0a0e1a',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    title: 'BatteryOS',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.once('ready-to-show', () => {
    if (splashWindow && !splashWindow.isDestroyed()) { splashWindow.destroy(); splashWindow = null }
    mainWindow.show(); mainWindow.focus()
  })
  mainWindow.on('closed', () => { mainWindow = null })
  // Load from static server (guaranteed customer bundle, not backend)
  mainWindow.loadURL(STATIC_URL)
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' http://127.0.0.1:8002 http://127.0.0.1:8001; " +
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; " +
          "connect-src 'self' http://127.0.0.1:8002 http://127.0.0.1:8001 ws://127.0.0.1:8001; " +
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
    await startStaticServer()
    createMainWindow()
  } catch (err) {
    console.error('[electron] Startup error:', err.message)
    if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy()
    dialog.showErrorBox(
      'BatteryOS — Startup Failed',
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

app.on('window-all-closed', () => { stopBackend(); stopStaticServer(); if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { stopBackend(); stopStaticServer() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow() })
process.on('exit', () => { stopBackend(); stopStaticServer() })
process.on('SIGINT', () => { stopBackend(); stopStaticServer(); process.exit(0) })
process.on('SIGTERM', () => { stopBackend(); stopStaticServer(); process.exit(0) })

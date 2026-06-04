/**
 * AuthGate — email+password auth with email verification, forgot password, OTP reset.
 */
import { useState, useEffect, createContext, useContext } from 'react'
import { Activity, Eye, EyeOff, RefreshCw, UserPlus, LogIn, Mail, KeyRound, ArrowLeft } from 'lucide-react'

interface AuthCtx { token: string; role: string; logout: () => void }
const AuthContext = createContext<AuthCtx>({ token: '', role: '', logout: () => {} })
export const useAuth = () => useContext(AuthContext)

const TOKEN_KEY = 'bos_token'
type Mode = 'login' | 'register' | 'verify' | 'forgot' | 'reset'

// Inject X-Session-Token into all /api/ requests (except /api/auth/)
const _orig = window.fetch.bind(window)
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input
    : input instanceof Request ? input.url : String(input)
  if (url.startsWith('/api/') && !url.startsWith('/api/auth/')) {
    const token = localStorage.getItem(TOKEN_KEY)
    if (token)
      init = { ...init, headers: { ...(init?.headers ?? {}), 'X-Session-Token': token } }
  }
  return _orig(input, init)
}

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [token,    setToken]    = useState<string | null>(null)
  const [checking, setChecking] = useState(true)
  const [role,     setRole]     = useState('')
  const [mode,     setMode]     = useState<Mode>('login')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [name,     setName]     = useState('')
  const [otp,      setOtp]      = useState('')
  const [newPass,  setNewPass]  = useState('')
  const [show,     setShow]     = useState(false)
  const [error,    setError]    = useState('')
  const [info,     setInfo]     = useState('')
  const [loading,  setLoading]  = useState(false)

  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_KEY)
    if (!stored) { setChecking(false); return }
    fetch(`/api/auth/check?token=${stored}`)
      .then(r => r.json())
      .then(d => {
        if (d.valid) {
          setToken(stored)
          fetch('/api/auth/me', { headers: { 'X-Session-Token': stored } })
            .then(r => r.json()).then(d => setRole(d.role || '')).catch(() => {})
        } else {
          localStorage.removeItem(TOKEN_KEY)
        }
      })
      .catch(() => localStorage.removeItem(TOKEN_KEY))
      .finally(() => setChecking(false))
  }, [])

  const saveToken = (t: string) => {
    localStorage.setItem(TOKEN_KEY, t)
    setToken(t)
    // Fetch role immediately after login
    fetch('/api/auth/me', { headers: { 'X-Session-Token': t } })
      .then(r => r.json())
      .then(d => setRole(d.role || ''))
      .catch(() => {})
  }

  const reset = (m: Mode) => { setMode(m); setError(''); setInfo(''); setOtp('') }

  // ── Login / Register ────────────────────────────────────────────────────────
  const submitAuth = async () => {
    setLoading(true); setError('')
    try {
      const body = mode === 'login'
        ? { email, password }
        : { email, password, full_name: name }
      const res  = await fetch(`/api/auth/${mode}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        // Email not verified — redirect to verify screen and send a fresh OTP
        if (res.status === 403 && data.detail?.includes('Email not verified')) {
          await fetch('/api/auth/send-verification', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          })
          setInfo('Check your email for a 6-digit verification code.')
          reset('verify')
          setLoading(false)
          return
        }
        setError(data.detail || 'Error'); setLoading(false); return
      }

      if (mode === 'register') {
        // Trigger verification OTP
        await fetch('/api/auth/send-verification', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
        setInfo('Check your email for a 6-digit code.')
        reset('verify')
      } else if (data.token) {
        saveToken(data.token)
      }
    } catch { setError('Could not reach server') }
    setLoading(false)
  }

  // ── Email verification ──────────────────────────────────────────────────────
  const submitVerify = async () => {
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth/verify-email', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      })
      const data = await res.json()
      if (res.ok && data.token) {
        saveToken(data.token)
      } else {
        setError(data.detail || 'Invalid code.')
      }
    } catch { setError('Could not reach server') }
    setLoading(false)
  }

  const resendOtp = async () => {
    setError(''); setInfo('')
    await fetch('/api/auth/send-verification', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
    setInfo('A new code has been sent.')
  }

  // ── Forgot password ─────────────────────────────────────────────────────────
  const submitForgot = async () => {
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth/forgot-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.detail || 'Error'); setLoading(false); return }
      setInfo('Check your email for a reset code.')
      reset('reset')
    } catch { setError('Could not reach server') }
    setLoading(false)
  }

  // ── Reset password ──────────────────────────────────────────────────────────
  const submitReset = async () => {
    if (newPass.length < 8) { setError('Password must be at least 8 characters.'); return }
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/auth/reset-password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp, new_password: newPass }),
      })
      const data = await res.json()
      if (res.ok && data.token) {
        saveToken(data.token)
      } else {
        setError(data.detail || 'Invalid or expired code.')
      }
    } catch { setError('Could not reach server') }
    setLoading(false)
  }

  const logout = () => {
    const t = localStorage.getItem(TOKEN_KEY)
    if (t) fetch(`/api/auth/logout?token=${t}`, { method: 'POST' }).catch(() => {})
    localStorage.removeItem(TOKEN_KEY)
    setToken(null); setEmail(''); setPassword(''); setName(''); reset('login')
  }

  // ── Loading screen ──────────────────────────────────────────────────────────
  if (checking) return (
    <div className="h-screen flex items-center justify-center bg-bg-primary">
      <RefreshCw size={20} className="animate-spin text-text-muted" />
    </div>
  )

  if (token) return <AuthContext.Provider value={{ token, role, logout }}>{children}</AuthContext.Provider>

  // ── Auth UI ─────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen flex items-center justify-center bg-bg-primary">
      <div className="w-80 space-y-5">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-blue to-brand-cyan flex items-center justify-center shadow-glow-sm">
            <Activity size={28} className="text-white" />
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-text-primary">BatteryOS</div>
            <div className="text-xs text-text-muted mt-0.5">RUL Intelligence Platform</div>
          </div>
        </div>

        {/* ── Login / Register mode ── */}
        {(mode === 'login' || mode === 'register') && (<>
          <div className="flex bg-bg-panel border border-border-subtle rounded-xl p-1 gap-1">
            {(['login', 'register'] as const).map(m => (
              <button key={m} onClick={() => reset(m)}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  mode === m ? 'bg-brand-blue text-white' : 'text-text-secondary hover:text-text-primary'}`}>
                {m === 'login' ? <LogIn size={12}/> : <UserPlus size={12}/>}
                {m === 'login' ? 'Sign in' : 'Register'}
              </button>
            ))}
          </div>
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-6 space-y-3">
            {mode === 'register' && (
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="Full name (optional)"
                className="w-full px-3 py-2.5 text-sm bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            )}
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitAuth()} placeholder="Email address"
              className="w-full px-3 py-2.5 text-sm bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            <div className="relative">
              <input type={show ? 'text' : 'password'} value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submitAuth()}
                placeholder={mode === 'register' ? 'Password (min 8 chars)' : 'Password'}
                className="w-full px-3 py-2.5 pr-9 text-sm bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
              <button onClick={() => setShow(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary">
                {show ? <EyeOff size={14}/> : <Eye size={14}/>}
              </button>
            </div>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button onClick={submitAuth} disabled={loading || !password}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
              {loading && <RefreshCw size={13} className="animate-spin"/>}
              {mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
            {mode === 'login' && (
              <button onClick={() => reset('forgot')}
                className="w-full text-xs text-text-muted hover:text-brand-blue transition-colors text-center py-0.5">
                Forgot password?
              </button>
            )}
          </div>
          {mode === 'login' && (
            <div className="text-center text-[10px] text-text-muted">
              Default: <code className="text-text-secondary">admin@batteryos.io</code> / <code className="text-text-secondary">batteryos</code>
            </div>
          )}
        </>)}

        {/* ── Email verification mode ── */}
        {mode === 'verify' && (
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <Mail size={16} className="text-brand-cyan" /> Verify your email
            </div>
            <p className="text-xs text-text-muted">
              Enter the 6-digit code sent to <span className="text-text-secondary">{email}</span>
            </p>
            {info && <div className="text-xs text-emerald-400">{info}</div>}
            <input type="text" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
              onKeyDown={e => e.key === 'Enter' && submitVerify()}
              placeholder="6-digit code"
              className="w-full px-3 py-2.5 text-sm text-center font-mono tracking-widest bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button onClick={submitVerify} disabled={loading || otp.length !== 6}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
              {loading && <RefreshCw size={13} className="animate-spin"/>}
              Verify email
            </button>
            <div className="flex items-center justify-between">
              <button onClick={() => reset('login')}
                className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors">
                <ArrowLeft size={11}/> Back
              </button>
              <button onClick={resendOtp} className="text-xs text-brand-blue hover:underline">
                Resend code
              </button>
            </div>
          </div>
        )}

        {/* ── Forgot password mode ── */}
        {mode === 'forgot' && (
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <KeyRound size={16} className="text-brand-cyan" /> Reset password
            </div>
            <p className="text-xs text-text-muted">Enter your email to receive a reset code.</p>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitForgot()}
              placeholder="Email address"
              className="w-full px-3 py-2.5 text-sm bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button onClick={submitForgot} disabled={loading || !email}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
              {loading && <RefreshCw size={13} className="animate-spin"/>}
              Send reset code
            </button>
            <button onClick={() => reset('login')}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors">
              <ArrowLeft size={11}/> Back to sign in
            </button>
          </div>
        )}

        {/* ── Reset password mode ── */}
        {mode === 'reset' && (
          <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <KeyRound size={16} className="text-brand-cyan" /> New password
            </div>
            {info && <div className="text-xs text-emerald-400">{info}</div>}
            <input type="text" value={otp} onChange={e => setOtp(e.target.value.replace(/\D/g,'').slice(0,6))}
              placeholder="6-digit reset code" maxLength={6}
              className="w-full px-3 py-2.5 text-sm text-center font-mono tracking-widest bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            <div className="relative">
              <input type={show ? 'text' : 'password'} value={newPass}
                onChange={e => setNewPass(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && submitReset()}
                placeholder="New password (min 8 chars)"
                className="w-full px-3 py-2.5 pr-9 text-sm bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
              <button onClick={() => setShow(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted hover:text-text-secondary">
                {show ? <EyeOff size={14}/> : <Eye size={14}/>}
              </button>
            </div>
            {error && <div className="text-xs text-red-400">{error}</div>}
            <button onClick={submitReset} disabled={loading || otp.length !== 6 || newPass.length < 8}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
              {loading && <RefreshCw size={13} className="animate-spin"/>}
              Reset password
            </button>
            <button onClick={() => reset('login')}
              className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors">
              <ArrowLeft size={11}/> Back to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

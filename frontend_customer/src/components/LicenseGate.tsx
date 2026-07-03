/**
 * LicenseGate — blocks the app until a valid license key is activated.
 * Wraps children; shows activation UI if /api/license/status returns activated=false.
 */
import { useState, useEffect } from 'react'
import { Key, RefreshCw, CheckCircle2, AlertTriangle, Activity } from 'lucide-react'

interface LicenseStatus {
  activated: boolean
  plan: string
  seats: number
  key_preview: string
}

export default function LicenseGate({ children }: { children: React.ReactNode }) {
  const [status,   setStatus]   = useState<LicenseStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [key,      setKey]      = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [success,  setSuccess]  = useState(false)

  const check = () => {
    fetch('/api/license/status')
      .then(r => r.json())
      .then(d => setStatus(d))
      .catch(() => setStatus({ activated: true, plan: '', seats: 0, key_preview: '' })) // fail open
      .finally(() => setChecking(false))
  }

  useEffect(() => { check() }, [])

  const activate = async () => {
    if (!key.trim()) { setError('Enter your license key.'); return }
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: key.trim() }),
      })
      const data = await res.json()
      if (res.ok) {
        setSuccess(true)
        setTimeout(() => check(), 1200)
      } else {
        setError(data.detail || 'Activation failed.')
      }
    } catch { setError('Could not reach server.') }
    setLoading(false)
  }

  if (checking) return (
    <div className="h-screen flex items-center justify-center bg-bg-primary">
      <RefreshCw size={20} className="animate-spin text-text-muted" />
    </div>
  )

  if (status?.activated) return <>{children}</>

  return (
    <div className="h-screen flex items-center justify-center bg-bg-primary">
      <div className="w-80 space-y-5">
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-brand-blue to-brand-cyan flex items-center justify-center shadow-glow-sm">
            <Activity size={28} className="text-white" />
          </div>
          <div className="text-center">
            <div className="text-xl font-bold text-text-primary">BatteryOS</div>
            <div className="text-xs text-text-muted mt-0.5">License Activation Required</div>
          </div>
        </div>

        <div className="bg-bg-secondary border border-border-subtle rounded-2xl p-6 space-y-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Key size={15} className="text-brand-blue" /> Activate your license
          </div>
          <p className="text-xs text-text-muted">
            Enter the license key provided by your BatteryOS admin.
            Format: <span className="font-mono">BATT-XXXX-XXXX-XXXX-XXXXXXXX</span>
          </p>
          <input
            value={key}
            onChange={e => setKey(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && activate()}
            placeholder="BATT-XXXX-XXXX-XXXX-XXXXXXXX"
            className="w-full px-3 py-2.5 text-sm font-mono bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50 tracking-wider"
          />
          {error && (
            <div className="flex items-center gap-1.5 text-xs text-red-400">
              <AlertTriangle size={11} /> {error}
            </div>
          )}
          {success && (
            <div className="flex items-center gap-1.5 text-xs text-emerald-400">
              <CheckCircle2 size={11} /> License activated! Loading…
            </div>
          )}
          <button onClick={activate} disabled={loading || !key.trim()}
            className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-sm font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
            {loading ? <RefreshCw size={13} className="animate-spin" /> : <Key size={13} />}
            Activate
          </button>
          <p className="text-[10px] text-text-muted text-center">
            Don't have a key? Contact <a href="mailto:support@batteryos.io" className="text-brand-blue hover:underline">support@batteryos.io</a>
          </p>
        </div>
      </div>
    </div>
  )
}

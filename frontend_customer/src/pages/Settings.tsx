/**
 * Settings — account-level settings for customer users.
 * Route: /settings
 * Only exposes: password change + sign out. No admin config.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  Lock, RefreshCw, CheckCircle2, AlertTriangle, Eye, EyeOff
} from 'lucide-react'
import { useAuth } from '../components/AuthGate'

function Section({ title, icon: Icon, children }: {
  title: string; icon: React.ElementType; children: React.ReactNode
}) {
  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-xl p-5 space-y-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Icon size={15} className="text-brand-blue" /> {title}
      </div>
      {children}
    </div>
  )
}

export default function Settings() {
  const { token, logout } = useAuth()
  const [toast,   setToast]   = useState<string | null>(null)

  const [curPw,   setCurPw]   = useState('')
  const [newPw,   setNewPw]   = useState('')
  const [confPw,  setConfPw]  = useState('')
  const [showPw,  setShowPw]  = useState(false)
  const [pwErr,   setPwErr]   = useState('')
  const [saving,  setSaving]  = useState(false)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  const savePassword = async () => {
    setPwErr('')
    if (!curPw) { setPwErr('Enter your current password'); return }
    if (newPw.length < 8) { setPwErr('New password must be at least 8 characters'); return }
    if (newPw !== confPw) { setPwErr('Passwords do not match'); return }
    setSaving(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-session-token': token } : {}),
        },
        body: JSON.stringify({ current_password: curPw, new_password: newPw }),
      })
      const data = await res.json()
      if (!res.ok) { setPwErr(data.detail || 'Save failed'); setSaving(false); return }
      setCurPw(''); setNewPw(''); setConfPw('')
      showToast('Password updated — you will be signed out.')
      setTimeout(logout, 1500)
    } catch { setPwErr('Network error') }
    setSaving(false)
  }

  return (
    <div className="p-6 max-w-xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Account Settings</h1>
        <p className="text-sm text-text-muted mt-0.5">Manage your account credentials.</p>
      </div>

      {toast && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-400">
          <CheckCircle2 size={12} /> {toast}
        </motion.div>
      )}

      <Section title="Change Password" icon={Lock}>
        <p className="text-xs text-text-muted">
          You will be signed out after a successful password change.
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">Current Password</label>
            <div className="relative mt-1">
              <input type={showPw ? 'text' : 'password'} value={curPw}
                onChange={e => setCurPw(e.target.value)}
                placeholder="your current password"
                className="w-full px-2.5 py-1.5 pr-8 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
              <button onClick={() => setShowPw(v => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted">
                {showPw ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
            </div>
          </div>
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">New Password</label>
            <input type={showPw ? 'text' : 'password'} value={newPw}
              onChange={e => setNewPw(e.target.value)}
              placeholder="min 8 characters"
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
          </div>
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">Confirm New Password</label>
            <input type={showPw ? 'text' : 'password'} value={confPw}
              onChange={e => setConfPw(e.target.value)}
              placeholder="repeat new password"
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
          </div>
        </div>
        {pwErr && (
          <div className="text-[10px] text-red-400 flex items-center gap-1">
            <AlertTriangle size={10} /> {pwErr}
          </div>
        )}
        <div className="flex justify-end">
          <button onClick={savePassword} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
            {saving ? <RefreshCw size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
            Save
          </button>
        </div>
      </Section>

      <div className="border border-red-500/20 rounded-xl p-4 space-y-2">
        <div className="text-xs font-semibold text-red-400">Sign out</div>
        <p className="text-[10px] text-text-muted">Clear your session from this browser.</p>
        <button onClick={logout}
          className="px-3 py-1.5 border border-red-500/30 text-xs text-red-400 rounded-lg hover:bg-red-500/10 transition-colors">
          Sign out
        </button>
      </div>
    </div>
  )
}

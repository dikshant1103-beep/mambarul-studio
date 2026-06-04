/**
 * Settings — platform configuration.
 * Route: /settings
 * Sections: Auth, Alert Thresholds, Webhook, Defaults
 */
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import {
  Settings2, Lock, Bell, Webhook, RefreshCw,
  CheckCircle2, AlertTriangle, Eye, EyeOff, Send, Mail,
  Database, Shield, Download
} from 'lucide-react'
import { useAuth } from '../components/AuthGate'

interface PlatformSettings {
  soh_healthy:        number
  soh_warning:        number
  eol_threshold:      number
  webhook_url:        string
  webhook_enabled:    boolean
  default_chemistry:  string
  alert_email:        string
  has_password:       boolean
  smtp_host:          string
  smtp_port:          number
  smtp_user:          string
  smtp_from:          string
  has_smtp_password:  boolean
}

const CHEMISTRIES = ['NMC', 'LFP', 'LCO', 'NCM', 'NCA']

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

function SaveBtn({ saving, onClick }: { saving: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} disabled={saving}
      className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
      {saving ? <RefreshCw size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
      Save
    </button>
  )
}

export default function Settings() {
  const { logout } = useAuth()
  const [cfg,     setCfg]     = useState<PlatformSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [toast,   setToast]   = useState<string | null>(null)

  // Auth section state
  const [curPw,   setCurPw]   = useState('')
  const [newPw,   setNewPw]   = useState('')
  const [confPw,  setConfPw]  = useState('')
  const [showPw,  setShowPw]  = useState(false)
  const [pwErr,   setPwErr]   = useState('')
  const [savingPw, setSavingPw] = useState(false)

  // Thresholds state
  const [healthy, setHealthy] = useState(88)
  const [warning, setWarning] = useState(80)
  const [eol,     setEol]     = useState(80)
  const [savingThr, setSavingThr] = useState(false)

  // SMTP state
  const [smtpHost,  setSmtpHost]  = useState('')
  const [smtpPort,  setSmtpPort]  = useState(587)
  const [smtpUser,  setSmtpUser]  = useState('')
  const [smtpPass,  setSmtpPass]  = useState('')
  const [smtpFrom,  setSmtpFrom]  = useState('')
  const [savingSMTP, setSavingSMTP] = useState(false)
  const [testingEmail, setTestingEmail] = useState(false)
  const [emailMsg,   setEmailMsg]  = useState<{ ok: boolean; text: string } | null>(null)

  // Webhook state
  const [webhookUrl, setWebhookUrl]     = useState('')
  const [webhookOn,  setWebhookOn]      = useState(false)
  const [savingWh,   setSavingWh]       = useState(false)
  const [testingWh,  setTestingWh]      = useState(false)
  const [webhookMsg, setWebhookMsg]     = useState<{ ok: boolean; text: string } | null>(null)

  // Defaults state
  const [defChem, setDefChem]   = useState('NMC')
  const [email,   setEmail]     = useState('')
  const [savingDef, setSavingDef] = useState(false)

  // Sentry DSN state
  const [sentryDsn,   setSentryDsn]   = useState('')
  const [savingSentry, setSavingSentry] = useState(false)

  // Backup state
  const [backups,       setBackups]       = useState<{ name: string; size_kb: number; ts: string }[]>([])
  const [backingUp,     setBackingUp]     = useState(false)
  const [backupMsg,     setBackupMsg]     = useState<{ ok: boolean; text: string } | null>(null)

  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((d: PlatformSettings & { sentry_dsn?: string }) => {
        setCfg(d)
        setHealthy(d.soh_healthy)
        setWarning(d.soh_warning)
        setEol(d.eol_threshold)
        setSmtpHost(d.smtp_host ?? '')
        setSmtpPort(d.smtp_port ?? 587)
        setSmtpUser(d.smtp_user ?? '')
        setSmtpFrom(d.smtp_from ?? '')
        setWebhookUrl(d.webhook_url ?? '')
        setWebhookOn(d.webhook_enabled ?? false)
        setDefChem(d.default_chemistry ?? 'NMC')
        setEmail(d.alert_email ?? '')
        setSentryDsn(d.sentry_dsn ?? '')
      })
      .catch(() => {})
      .finally(() => setLoading(false))
    // Load backup list
    fetch('/api/admin/backup/list').then(r => r.json()).then(setBackups).catch(() => {})
  }, [])

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error('Save failed')
  }

  const savePassword = async () => {
    setPwErr('')
    if (!curPw) { setPwErr('Enter your current password'); return }
    if (newPw.length < 8) { setPwErr('New password must be at least 8 characters'); return }
    if (newPw !== confPw) { setPwErr('Passwords do not match'); return }
    setSavingPw(true)
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: curPw, new_password: newPw }),
      })
      const data = await res.json()
      if (!res.ok) { setPwErr(data.detail || 'Save failed'); setSavingPw(false); return }
      setCurPw(''); setNewPw(''); setConfPw('')
      showToast('Password updated — you will be signed out.')
      setTimeout(logout, 1500)
    } catch { setPwErr('Save failed') }
    setSavingPw(false)
  }

  const saveThresholds = async () => {
    setSavingThr(true)
    try {
      await patch({ soh_healthy: healthy, soh_warning: warning, eol_threshold: eol })
      showToast('Alert thresholds saved.')
    } catch { showToast('Save failed.') }
    setSavingThr(false)
  }

  const saveSMTP = async () => {
    setSavingSMTP(true)
    try {
      const body: Record<string, unknown> = { smtp_host: smtpHost, smtp_port: smtpPort, smtp_user: smtpUser, smtp_from: smtpFrom }
      if (smtpPass) body.smtp_password = smtpPass
      await patch(body)
      setSmtpPass('')
      showToast('SMTP settings saved.')
    } catch { showToast('Save failed.') }
    setSavingSMTP(false)
  }

  const testEmail = async () => {
    setTestingEmail(true); setEmailMsg(null)
    try {
      const res = await fetch('/api/settings/email/test', { method: 'POST' })
      const d = await res.json()
      setEmailMsg({ ok: d.ok, text: d.message })
    } catch { setEmailMsg({ ok: false, text: 'Network error' }) }
    setTestingEmail(false)
  }

  const saveWebhook = async () => {
    setSavingWh(true)
    try {
      await patch({ webhook_url: webhookUrl, webhook_enabled: webhookOn })
      showToast('Webhook settings saved.')
    } catch { showToast('Save failed.') }
    setSavingWh(false)
  }

  const testWebhook = async () => {
    setTestingWh(true); setWebhookMsg(null)
    try {
      const res = await fetch('/api/settings/webhook/test', { method: 'POST' })
      const d = await res.json()
      setWebhookMsg({ ok: d.ok, text: d.ok ? `Delivered (HTTP ${d.status})` : `Failed: ${d.error ?? d.status}` })
    } catch { setWebhookMsg({ ok: false, text: 'Network error' }) }
    setTestingWh(false)
  }

  const saveDefaults = async () => {
    setSavingDef(true)
    try {
      await patch({ default_chemistry: defChem, alert_email: email })
      showToast('Defaults saved.')
    } catch { showToast('Save failed.') }
    setSavingDef(false)
  }

  const saveSentry = async () => {
    setSavingSentry(true)
    try {
      await patch({ sentry_dsn: sentryDsn })
      showToast('Sentry DSN saved. Restart the server to apply.')
    } catch { showToast('Save failed.') }
    setSavingSentry(false)
  }

  const triggerBackup = async () => {
    setBackingUp(true); setBackupMsg(null)
    try {
      const res = await fetch('/api/admin/backup/now', { method: 'POST' })
      const d = await res.json()
      if (d.ok) {
        setBackupMsg({ ok: true, text: `Backup created: ${d.name} (${d.size_kb} KB)` })
        fetch('/api/admin/backup/list').then(r => r.json()).then(setBackups).catch(() => {})
      } else {
        setBackupMsg({ ok: false, text: d.error || 'Backup failed.' })
      }
    } catch { setBackupMsg({ ok: false, text: 'Network error.' }) }
    setBackingUp(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-text-muted text-xs gap-2">
        <RefreshCw size={13} className="animate-spin" /> Loading settings…
      </div>
    )
  }

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Settings</h1>
        <p className="text-sm text-text-muted mt-0.5">Platform configuration — thresholds, auth, and integrations.</p>
      </div>

      {/* Toast */}
      {toast && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-xs text-emerald-400">
          <CheckCircle2 size={12} /> {toast}
        </motion.div>
      )}

      {/* Auth */}
      <Section title="Change Password" icon={Lock}>
        <p className="text-xs text-text-muted">
          You will be signed out after saving.
        </p>
        <div className="space-y-2">
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
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">New Password</label>
              <input type={showPw ? 'text' : 'password'} value={newPw}
                onChange={e => setNewPw(e.target.value)}
                placeholder="min 8 characters"
                className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">Confirm</label>
              <input type={showPw ? 'text' : 'password'} value={confPw}
                onChange={e => setConfPw(e.target.value)}
                placeholder="repeat new password"
                className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            </div>
          </div>
        </div>
        {pwErr && <div className="text-[10px] text-red-400 flex items-center gap-1"><AlertTriangle size={10} />{pwErr}</div>}
        <div className="flex justify-end">
          <SaveBtn saving={savingPw} onClick={savePassword} />
        </div>
      </Section>

      {/* Thresholds */}
      <Section title="Alert Thresholds" icon={Bell}>
        <p className="text-xs text-text-muted">
          SOH thresholds used to classify cells as healthy / warning / critical across Fleet View, Dashboard, and reports.
        </p>
        <div className="space-y-4">
          {[
            { label: 'Healthy ≥', value: healthy, set: setHealthy, color: '#10b981', min: 70, max: 99 },
            { label: 'Warning ≥',  value: warning, set: setWarning, color: '#f59e0b', min: 50, max: 95 },
            { label: 'EOL at',     value: eol,     set: setEol,     color: '#ef4444', min: 60, max: 85 },
          ].map(({ label, value, set, color, min, max }) => (
            <div key={label} className="flex items-center gap-4">
              <div className="w-24 text-xs text-text-muted shrink-0">{label}</div>
              <input type="range" min={min} max={max} value={value}
                onChange={e => set(+e.target.value)}
                className="flex-1 accent-brand-blue" />
              <div className="w-14 text-right font-mono text-sm font-bold" style={{ color }}>{value}%</div>
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <SaveBtn saving={savingThr} onClick={saveThresholds} />
        </div>
      </Section>

      {/* Webhook */}
      <Section title="Webhook Alerts" icon={Webhook}>
        <p className="text-xs text-text-muted">
          BatteryOS will POST a JSON payload to this URL when critical cells are detected in a batch run.
        </p>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">Webhook URL</label>
            <input value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/…"
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
          </div>
          <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
            <input type="checkbox" checked={webhookOn} onChange={e => setWebhookOn(e.target.checked)}
              className="accent-brand-blue" />
            Enable webhook alerts
          </label>
          {webhookMsg && (
            <div className={`text-[10px] flex items-center gap-1.5 ${webhookMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
              {webhookMsg.ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
              {webhookMsg.text}
            </div>
          )}
          <div className="flex justify-between items-center">
            <button onClick={testWebhook} disabled={testingWh || !webhookUrl}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
              {testingWh ? <RefreshCw size={11} className="animate-spin" /> : <Send size={11} />}
              Test Webhook
            </button>
            <SaveBtn saving={savingWh} onClick={saveWebhook} />
          </div>
        </div>
      </Section>

      {/* SMTP / Email */}
      <Section title="Email Alerts (SMTP)" icon={Mail}>
        <p className="text-xs text-text-muted">
          When a batch prediction detects Near-EOL or Knee cells, BatteryOS will email the alert recipient.
          Leave SMTP Host blank to disable email.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">SMTP Host</label>
            <input value={smtpHost} onChange={e => setSmtpHost(e.target.value)}
              placeholder="smtp.gmail.com"
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
          </div>
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">Port</label>
            <input type="number" value={smtpPort} onChange={e => setSmtpPort(+e.target.value)}
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
          </div>
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">SMTP User</label>
            <input value={smtpUser} onChange={e => setSmtpUser(e.target.value)}
              placeholder="you@gmail.com"
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
          </div>
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">SMTP Password</label>
            <input type="password" value={smtpPass} onChange={e => setSmtpPass(e.target.value)}
              placeholder={cfg?.has_smtp_password ? '••••••• (saved)' : 'App password'}
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
          </div>
          <div className="col-span-2">
            <label className="text-[10px] text-text-muted uppercase tracking-wide">From Address</label>
            <input value={smtpFrom} onChange={e => setSmtpFrom(e.target.value)}
              placeholder="BatteryOS <alerts@yourcompany.com>"
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
          </div>
        </div>
        {emailMsg && (
          <div className={`text-[10px] flex items-center gap-1.5 ${emailMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {emailMsg.ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
            {emailMsg.text}
          </div>
        )}
        <div className="flex justify-between items-center">
          <button onClick={testEmail} disabled={testingEmail || !smtpHost}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
            {testingEmail ? <RefreshCw size={11} className="animate-spin" /> : <Send size={11} />}
            Send Test Email
          </button>
          <SaveBtn saving={savingSMTP} onClick={saveSMTP} />
        </div>
      </Section>

      {/* Defaults */}
      <Section title="Defaults" icon={Settings2}>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">Default Chemistry</label>
            <select value={defChem} onChange={e => setDefChem(e.target.value)}
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50">
              {CHEMISTRIES.map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-text-muted uppercase tracking-wide">Alert Email (optional)</label>
            <input value={email} onChange={e => setEmail(e.target.value)}
              type="email" placeholder="ops@company.com"
              className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
          </div>
        </div>
        <div className="flex justify-end">
          <SaveBtn saving={savingDef} onClick={saveDefaults} />
        </div>
      </Section>

      {/* Sentry DSN */}
      <Section title="Error Tracking (Sentry)" icon={Shield}>
        <p className="text-xs text-text-muted">
          Paste your Sentry DSN to enable automatic error reporting. Leave blank to disable.
          Requires a server restart to take effect.
        </p>
        <div>
          <label className="text-[10px] text-text-muted uppercase tracking-wide">Sentry DSN</label>
          <input value={sentryDsn} onChange={e => setSentryDsn(e.target.value)}
            placeholder="https://xxxx@oXXXXX.ingest.sentry.io/XXXXXXX"
            className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
        </div>
        <div className="flex justify-end">
          <SaveBtn saving={savingSentry} onClick={saveSentry} />
        </div>
      </Section>

      {/* Database Backup */}
      <Section title="Database Backup" icon={Database}>
        <p className="text-xs text-text-muted">
          A backup runs automatically every 24 hours (last 7 kept). Trigger a manual backup any time.
        </p>
        {backupMsg && (
          <div className={`text-[10px] flex items-center gap-1.5 ${backupMsg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
            {backupMsg.ok ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />}
            {backupMsg.text}
          </div>
        )}
        <div className="flex justify-between items-center">
          <button onClick={triggerBackup} disabled={backingUp}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
            {backingUp ? <RefreshCw size={11} className="animate-spin" /> : <Download size={11} />}
            Backup Now
          </button>
          <span className="text-[10px] text-text-muted">{backups.length} backup(s) on disk</span>
        </div>
        {backups.length > 0 && (
          <div className="rounded-lg border border-border-subtle overflow-hidden">
            {backups.slice(0, 5).map(b => (
              <div key={b.name} className="flex items-center justify-between px-3 py-1.5 text-[10px] border-b border-border-subtle last:border-b-0">
                <span className="font-mono text-text-secondary">{b.name}</span>
                <span className="text-text-muted">{b.size_kb} KB</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Danger zone */}
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

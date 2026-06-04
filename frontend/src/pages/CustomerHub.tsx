import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Users, ShieldCheck, UserX, Trash2, RefreshCw, Mail,
  CheckCircle, XCircle, Package, Download, ChevronRight,
  Search, AlertTriangle, Settings, Key, Copy, Ban
} from 'lucide-react'
import clsx from 'clsx'

interface User {
  id: string
  email: string
  full_name: string
  role: string
  is_active: number
  email_verified: number
  created_at: string
  last_login: string | null
  org_id: string
}

interface AppInfo {
  version: string
  app_name: string
  appimage: { exists: boolean; path: string; size_mb: number; modified: number }
  features: string[]
  auth_features: { email_verification: boolean; forgot_password: boolean; otp_login: boolean }
  user_stats: { total: number; customers: number; admins: number; verified: number; active: number; unverified: number }
  smtp_configured: boolean
  deployment_notes: string[]
}

interface License {
  id: string
  key_preview: string
  plan: string
  seats: number
  customer_email: string
  notes: string
  status: string
  activated_at: string | null
  created_at: string
}

type Tab = 'users' | 'app' | 'licenses'

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: any; color: string }) {
  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 flex items-center gap-3">
      <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={16} className="text-white" />
      </div>
      <div>
        <div className="text-xl font-bold text-text-primary">{value}</div>
        <div className="text-[10px] text-text-muted uppercase tracking-wide">{label}</div>
      </div>
    </div>
  )
}

export default function CustomerHub() {
  const [tab, setTab]       = useState<Tab>('users')
  const [users, setUsers]   = useState<User[]>([])
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch]   = useState('')
  const [filter, setFilter]   = useState<'all' | 'unverified' | 'inactive'>('all')
  const [busy, setBusy]       = useState<string | null>(null)
  const [msg, setMsg]         = useState<{ id: string; text: string; ok: boolean } | null>(null)

  // License state
  const [licenses,    setLicenses]    = useState<License[]>([])
  const [licPlan,     setLicPlan]     = useState('pro')
  const [licSeats,    setLicSeats]    = useState(1)
  const [licEmail,    setLicEmail]    = useState('')
  const [licNotes,    setLicNotes]    = useState('')
  const [generating,  setGenerating]  = useState(false)
  const [genResult,   setGenResult]   = useState<{ key: string } | null>(null)
  const [copied,      setCopied]      = useState(false)

  const load = () => {
    setLoading(true)
    Promise.all([
      fetch('/api/admin/customers').then(r => r.json()),
      fetch('/api/admin/app-info').then(r => r.json()),
    ]).then(([u, a]) => {
      if (Array.isArray(u)) setUsers(u)
      if (a.version) setAppInfo(a)
    }).catch(() => {}).finally(() => setLoading(false))
  }

  const loadLicenses = () => {
    fetch('/api/admin/licenses').then(r => r.json()).then(d => {
      if (Array.isArray(d)) setLicenses(d)
    }).catch(() => {})
  }

  useEffect(() => { load(); loadLicenses() }, [])

  const toast = (id: string, text: string, ok: boolean) => {
    setMsg({ id, text, ok })
    setTimeout(() => setMsg(null), 3000)
  }

  const doAction = async (userId: string, action: string, body?: object) => {
    setBusy(userId + action)
    try {
      let res: Response
      if (action === 'delete') {
        res = await fetch(`/api/admin/customers/${userId}`, { method: 'DELETE' })
      } else if (action === 'verify') {
        res = await fetch(`/api/admin/customers/${userId}/verify`, { method: 'POST' })
      } else if (action === 'reset') {
        res = await fetch(`/api/admin/customers/${userId}/reset`, { method: 'POST' })
      } else {
        res = await fetch(`/api/admin/customers/${userId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      }
      const d = await res.json()
      if (res.ok) {
        toast(userId, action === 'reset'
          ? (d.smtp ? 'Reset email sent.' : `Dev OTP: ${d.dev_otp}`)
          : `Done: ${action}`, true)
        load()
      } else {
        toast(userId, d.detail || 'Error', false)
      }
    } catch { toast(userId, 'Request failed', false) }
    setBusy(null)
  }

  const generateLicense = async () => {
    setGenerating(true); setGenResult(null)
    try {
      const res = await fetch('/api/admin/licenses/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: licPlan, seats: licSeats, customer_email: licEmail, notes: licNotes }),
      })
      const d = await res.json()
      if (res.ok && d.key) {
        setGenResult(d)
        setLicEmail(''); setLicNotes('')
        loadLicenses()
      }
    } catch {}
    setGenerating(false)
  }

  const revokeLicense = async (id: string) => {
    if (!confirm('Revoke this license key? This cannot be undone.')) return
    await fetch(`/api/admin/licenses/${id}/revoke`, { method: 'POST' })
    loadLicenses()
  }

  const copyKey = (key: string) => {
    navigator.clipboard.writeText(key).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000) })
  }

  const filtered = users.filter(u => {
    const q = search.toLowerCase()
    const matches = !q || u.email.toLowerCase().includes(q) || u.full_name.toLowerCase().includes(q)
    if (!matches) return false
    if (filter === 'unverified') return !u.email_verified
    if (filter === 'inactive') return !u.is_active
    return true
  })

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }} className="p-6 max-w-6xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary">Customer Hub</h1>
          <p className="text-xs text-text-muted mt-0.5">Manage users and BatteryOS customer app distribution</p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg hover:bg-bg-secondary transition-colors">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-bg-panel border border-border-subtle rounded-xl p-1 w-fit">
        {([['users', Users, 'Users'], ['app', Package, 'App Distribution'], ['licenses', Key, 'Licenses']] as const).map(([id, Icon, label]) => (
          <button key={id} onClick={() => setTab(id as Tab)}
            className={clsx('flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-medium transition-all',
              tab === id ? 'bg-brand-blue text-white' : 'text-text-secondary hover:text-text-primary')}>
            <Icon size={12} /> {label}
          </button>
        ))}
      </div>

      {/* ── Users tab ── */}
      {tab === 'users' && (
        <div className="space-y-4">
          {/* Stats */}
          {appInfo && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard label="Total Users"  value={appInfo.user_stats.total}     icon={Users}       color="bg-brand-blue" />
              <StatCard label="Customers"    value={appInfo.user_stats.customers} icon={Users}       color="bg-brand-cyan" />
              <StatCard label="Verified"     value={appInfo.user_stats.verified}  icon={ShieldCheck} color="bg-emerald-500" />
              <StatCard label="Unverified"   value={appInfo.user_stats.unverified} icon={AlertTriangle} color="bg-amber-500" />
            </div>
          )}

          {/* Search + filter */}
          <div className="flex gap-2">
            <div className="relative flex-1 max-w-xs">
              <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search by email or name…"
                className="w-full pl-8 pr-3 py-2 text-xs bg-bg-secondary border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            </div>
            <select value={filter} onChange={e => setFilter(e.target.value as any)}
              className="px-3 py-2 text-xs bg-bg-secondary border border-border-subtle rounded-lg text-text-secondary focus:outline-none">
              <option value="all">All users</option>
              <option value="unverified">Unverified</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>

          {/* User table */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-panel">
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">User</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Role</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Verified</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Status</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Last Login</th>
                  <th className="text-right px-4 py-2.5 text-text-muted font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6} className="text-center py-8 text-text-muted">
                    <RefreshCw size={14} className="animate-spin inline mr-2" />Loading…
                  </td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={6} className="text-center py-8 text-text-muted">No users found.</td></tr>
                ) : filtered.map(u => (
                  <tr key={u.id} className="border-t border-border-subtle hover:bg-bg-panel/50 transition-colors">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-text-primary">{u.email}</div>
                      {u.full_name && <div className="text-text-muted">{u.full_name}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-medium',
                        u.role === 'admin' ? 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                          : 'bg-brand-blue/10 text-brand-blue border border-brand-blue/20')}>
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {u.email_verified
                        ? <CheckCircle size={14} className="text-emerald-400" />
                        : <XCircle    size={14} className="text-amber-400" />}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-medium',
                        u.is_active ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-red-500/10 text-red-400 border border-red-500/20')}>
                        {u.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-text-muted">
                      {u.last_login ? u.last_login.slice(0, 10) : '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {msg?.id === u.id && (
                          <span className={`text-[10px] mr-1 ${msg.ok ? 'text-emerald-400' : 'text-red-400'}`}>
                            {msg.text}
                          </span>
                        )}
                        {!u.email_verified && (
                          <button title="Force verify email"
                            onClick={() => doAction(u.id, 'verify')}
                            disabled={busy === u.id + 'verify'}
                            className="p-1.5 rounded-md hover:bg-emerald-500/10 hover:text-emerald-400 text-text-muted transition-colors">
                            <ShieldCheck size={13} />
                          </button>
                        )}
                        <button title="Send password reset email"
                          onClick={() => doAction(u.id, 'reset')}
                          disabled={busy === u.id + 'reset'}
                          className="p-1.5 rounded-md hover:bg-brand-blue/10 hover:text-brand-blue text-text-muted transition-colors">
                          <Mail size={13} />
                        </button>
                        <button title={u.is_active ? 'Deactivate' : 'Activate'}
                          onClick={() => doAction(u.id, 'toggle', { is_active: u.is_active ? 0 : 1 })}
                          className="p-1.5 rounded-md hover:bg-amber-500/10 hover:text-amber-400 text-text-muted transition-colors">
                          <UserX size={13} />
                        </button>
                        <button title="Delete user"
                          onClick={() => { if (confirm(`Delete ${u.email}?`)) doAction(u.id, 'delete') }}
                          className="p-1.5 rounded-md hover:bg-red-500/10 hover:text-red-400 text-text-muted transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── App Distribution tab ── */}
      {tab === 'app' && appInfo && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* AppImage info */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-5 space-y-4">
              <div className="flex items-center gap-2">
                <Package size={16} className="text-brand-blue" />
                <span className="text-sm font-semibold text-text-primary">BatteryOS AppImage</span>
                <span className="ml-auto text-xs text-text-muted">v{appInfo.version}</span>
              </div>
              {appInfo.appimage.exists ? (
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between">
                    <span className="text-text-muted">File</span>
                    <span className="text-text-secondary font-mono text-[10px] truncate max-w-[200px]"
                      title={appInfo.appimage.path}>
                      BatteryOS.AppImage
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Size</span>
                    <span className="text-text-secondary">{appInfo.appimage.size_mb} MB</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-muted">Built</span>
                    <span className="text-text-secondary">
                      {new Date(appInfo.appimage.modified * 1000).toLocaleString()}
                    </span>
                  </div>
                  <div className="pt-1 flex items-center gap-1 text-emerald-400">
                    <CheckCircle size={12} />
                    <span>Ready to distribute</span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-amber-400">
                  <AlertTriangle size={12} />
                  AppImage not found — run electron:build in frontend_customer/
                </div>
              )}
            </div>

            {/* Auth status */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-5 space-y-3">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} className="text-brand-cyan" />
                <span className="text-sm font-semibold text-text-primary">Auth Features</span>
              </div>
              <div className="space-y-2 text-xs">
                {[
                  ['Email Verification', appInfo.auth_features.email_verification],
                  ['Forgot Password',    appInfo.auth_features.forgot_password],
                  ['OTP 2FA',           appInfo.auth_features.otp_login],
                ].map(([label, enabled]) => (
                  <div key={String(label)} className="flex items-center justify-between">
                    <span className="text-text-muted">{label as string}</span>
                    {enabled
                      ? <CheckCircle size={12} className="text-emerald-400" />
                      : <XCircle    size={12} className="text-text-muted" />}
                  </div>
                ))}
                <div className="border-t border-border-subtle pt-2 flex items-center justify-between">
                  <span className="text-text-muted">SMTP configured</span>
                  {appInfo.smtp_configured
                    ? <CheckCircle size={12} className="text-emerald-400" />
                    : <span className="text-amber-400 text-[10px]">Not set — OTPs shown in-app</span>}
                </div>
                {!appInfo.smtp_configured && (
                  <a href="/settings" className="flex items-center gap-1 text-brand-blue hover:underline text-[10px]">
                    <Settings size={10} /> Configure SMTP in Settings <ChevronRight size={10} />
                  </a>
                )}
              </div>
            </div>
          </div>

          {/* Features list */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-5">
            <div className="text-sm font-semibold text-text-primary mb-3">Customer App Features</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {appInfo.features.map(f => (
                <div key={f} className="flex items-start gap-2 text-xs text-text-secondary">
                  <CheckCircle size={11} className="text-emerald-400 mt-0.5 flex-shrink-0" />
                  {f}
                </div>
              ))}
            </div>
          </div>

          {/* Deployment notes */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-5">
            <div className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
              <Download size={14} className="text-brand-blue" /> Deployment Notes
            </div>
            <ol className="space-y-1.5">
              {appInfo.deployment_notes.map((note, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-text-secondary">
                  <span className="w-4 h-4 rounded-full bg-brand-blue/10 text-brand-blue text-[10px] font-bold
                                   flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
                  {note}
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
      {/* ── Licenses tab ── */}
      {tab === 'licenses' && (
        <div className="space-y-4">
          {/* Generate form */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-5 space-y-4">
            <div className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Key size={14} className="text-brand-blue" /> Generate License Key
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide">Plan</label>
                <select value={licPlan} onChange={e => setLicPlan(e.target.value)}
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50">
                  <option value="starter">Starter</option>
                  <option value="pro">Pro</option>
                  <option value="enterprise">Enterprise</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide">Seats</label>
                <input type="number" min={1} max={100} value={licSeats}
                  onChange={e => setLicSeats(+e.target.value)}
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide">Customer Email</label>
                <input type="email" value={licEmail} onChange={e => setLicEmail(e.target.value)}
                  placeholder="customer@company.com"
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide">Notes</label>
                <input value={licNotes} onChange={e => setLicNotes(e.target.value)}
                  placeholder="e.g. 1-year contract"
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button onClick={generateLicense} disabled={generating}
                className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
                {generating ? <RefreshCw size={11} className="animate-spin" /> : <Key size={11} />}
                Generate Key
              </button>
              {genResult && (
                <div className="flex items-center gap-2 flex-1">
                  <code className="flex-1 px-3 py-1.5 bg-bg-panel border border-emerald-500/20 rounded-lg text-xs font-mono text-emerald-400 select-all">
                    {genResult.key}
                  </code>
                  <button onClick={() => copyKey(genResult.key)}
                    className="p-1.5 rounded-md hover:bg-bg-panel text-text-muted hover:text-text-primary transition-colors"
                    title="Copy key">
                    <Copy size={13} />
                  </button>
                  {copied && <span className="text-[10px] text-emerald-400">Copied!</span>}
                </div>
              )}
            </div>
            {genResult && (
              <p className="text-[10px] text-amber-400 flex items-center gap-1">
                <AlertTriangle size={10} /> Copy this key now — the full key will not be shown again.
              </p>
            )}
          </div>

          {/* License list */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-panel">
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Key</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Plan</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Seats</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Customer</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Status</th>
                  <th className="text-left px-4 py-2.5 text-text-muted font-medium">Activated</th>
                  <th className="text-right px-4 py-2.5 text-text-muted font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {licenses.length === 0 ? (
                  <tr><td colSpan={7} className="text-center py-8 text-text-muted">No licenses generated yet.</td></tr>
                ) : licenses.map(l => (
                  <tr key={l.id} className="border-t border-border-subtle hover:bg-bg-panel/50">
                    <td className="px-4 py-2.5 font-mono text-text-secondary">{l.key_preview}</td>
                    <td className="px-4 py-2.5">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-brand-blue/10 text-brand-blue border border-brand-blue/20 capitalize">
                        {l.plan}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-text-secondary">{l.seats}</td>
                    <td className="px-4 py-2.5 text-text-muted">{l.customer_email || '—'}</td>
                    <td className="px-4 py-2.5">
                      <span className={clsx('px-2 py-0.5 rounded-full text-[10px] font-medium',
                        l.status === 'active'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                          : 'bg-red-500/10 text-red-400 border border-red-500/20')}>
                        {l.status}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-text-muted">
                      {l.activated_at ? l.activated_at.slice(0, 10) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {l.status === 'active' && (
                        <button onClick={() => revokeLicense(l.id)}
                          title="Revoke license"
                          className="p-1.5 rounded-md hover:bg-red-500/10 hover:text-red-400 text-text-muted transition-colors">
                          <Ban size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </motion.div>
  )
}

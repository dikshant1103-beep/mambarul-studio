/**
 * AlertHistory — persistent log of all Near-EOL / Knee cell detections.
 * Route: /alerts
 * Cells are recorded automatically when batch predict returns critical phases.
 */
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { ShieldAlert, CheckCircle2, RefreshCw, Bell, BellOff, Filter } from 'lucide-react'

interface Alert {
  id:    string
  ts:    string
  chem:  string
  soh:   number
  rul:   number
  phase: string
  label: string
  src:   string
  ack:   boolean
}

const PHASE_COLOR: Record<string, string> = {
  Fresh: '#10b981', Aging: '#3b82f6', Knee: '#f59e0b', 'Near-EOL': '#ef4444',
}
const CHEM_COLOR: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4',
}

export default function AlertHistory() {
  const [alerts,    setAlerts]    = useState<Alert[]>([])
  const [loading,   setLoading]   = useState(true)
  const [filter,    setFilter]    = useState<'all' | 'unack'>('all')
  const [acking,    setAcking]    = useState<string | null>(null)
  const [ackingAll, setAckingAll] = useState(false)

  const load = () => {
    setLoading(true)
    const q = filter === 'unack' ? '?unack_only=true' : ''
    fetch(`/api/alerts${q}`)
      .then(r => r.json())
      .then(setAlerts)
      .catch(() => setAlerts([]))
      .finally(() => setLoading(false))
  }

  useEffect(load, [filter])

  const ack = async (id: string) => {
    setAcking(id)
    try {
      await fetch(`/api/alerts/${id}/ack`, { method: 'POST' })
      setAlerts(prev => prev.map(a => a.id === id ? { ...a, ack: true } : a))
    } finally {
      setAcking(null)
    }
  }

  const ackAll = async () => {
    setAckingAll(true)
    try {
      await fetch('/api/alerts/ack-all', { method: 'POST' })
      setAlerts(prev => prev.map(a => ({ ...a, ack: true })))
    } finally {
      setAckingAll(false)
    }
  }

  const unackCount = alerts.filter(a => !a.ack).length

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Alert History</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Cells flagged as Near-EOL or Knee during batch prediction.
            {unackCount > 0 && (
              <span className="ml-2 text-red-400 font-medium">{unackCount} unacknowledged</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {unackCount > 0 && (
            <button onClick={ackAll} disabled={ackingAll}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
              {ackingAll ? <RefreshCw size={11} className="animate-spin" /> : <CheckCircle2 size={11} />}
              Acknowledge All
            </button>
          )}
          <button onClick={load} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1 bg-bg-secondary border border-border-subtle rounded-lg p-1 w-fit">
        {[
          { key: 'all',   label: 'All',           icon: Filter },
          { key: 'unack', label: 'Unacknowledged', icon: Bell   },
        ].map(({ key, label, icon: Icon }) => (
          <button key={key}
            onClick={() => setFilter(key as 'all' | 'unack')}
            className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded transition-all ${
              filter === key
                ? 'bg-brand-blue text-white font-semibold'
                : 'text-text-muted hover:text-text-secondary'
            }`}>
            <Icon size={11} /> {label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-text-muted text-xs gap-2">
          <RefreshCw size={13} className="animate-spin" /> Loading alerts…
        </div>
      ) : alerts.length === 0 ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          className="flex flex-col items-center justify-center py-20 gap-3 text-text-muted">
          <BellOff size={32} className="opacity-20" />
          <div className="text-xs">
            {filter === 'unack' ? 'No unacknowledged alerts.' : 'No alerts yet. Run a batch prediction to generate alerts for critical cells.'}
          </div>
        </motion.div>
      ) : (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="border-b border-border-subtle text-text-muted">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Cell / Label</th>
                  <th className="px-4 py-2.5 text-left font-medium">Chemistry</th>
                  <th className="px-4 py-2.5 text-right font-medium">SOH %</th>
                  <th className="px-4 py-2.5 text-right font-medium">RUL</th>
                  <th className="px-4 py-2.5 text-left font-medium">Phase</th>
                  <th className="px-4 py-2.5 text-left font-medium">Source</th>
                  <th className="px-4 py-2.5 text-left font-medium">Detected</th>
                  <th className="px-4 py-2.5 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map(a => (
                  <tr key={a.id}
                    className={`border-b border-border-subtle/40 transition-colors ${
                      a.ack ? 'opacity-50' : 'hover:bg-bg-panel'
                    }`}>
                    <td className="px-4 py-3 font-mono text-text-primary">{a.label || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                        style={{
                          background: (CHEM_COLOR[a.chem] ?? '#6b7280') + '20',
                          color: CHEM_COLOR[a.chem] ?? '#6b7280',
                        }}>{a.chem}</span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      <span className={a.soh < 80 ? 'text-red-400' : a.soh < 88 ? 'text-amber-400' : 'text-emerald-400'}>
                        {a.soh}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-text-primary">{a.rul}</td>
                    <td className="px-4 py-3">
                      <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
                        style={{
                          background: (PHASE_COLOR[a.phase] ?? '#6b7280') + '20',
                          color: PHASE_COLOR[a.phase] ?? '#6b7280',
                        }}>{a.phase}</span>
                    </td>
                    <td className="px-4 py-3 text-text-muted text-[10px]">{a.src}</td>
                    <td className="px-4 py-3 text-text-muted font-mono text-[10px]">
                      {a.ts.slice(0, 10)} {a.ts.slice(11, 16)}
                    </td>
                    <td className="px-4 py-3">
                      {a.ack ? (
                        <span className="flex items-center gap-1 text-[9px] text-emerald-400">
                          <CheckCircle2 size={10} /> Acknowledged
                        </span>
                      ) : (
                        <button onClick={() => ack(a.id)} disabled={acking === a.id}
                          className="flex items-center gap-1 text-[9px] text-amber-400 hover:text-amber-300 transition-colors disabled:opacity-50">
                          {acking === a.id
                            ? <RefreshCw size={10} className="animate-spin" />
                            : <ShieldAlert size={10} />}
                          Acknowledge
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-text-muted text-center mt-2">
            Showing {alerts.length} alert{alerts.length !== 1 ? 's' : ''}.
            Alerts are auto-generated when batch predictions return Near-EOL or Knee phase cells.
          </p>
        </motion.div>
      )}
    </div>
  )
}

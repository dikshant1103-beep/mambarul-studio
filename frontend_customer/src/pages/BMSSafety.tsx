/**
 * BMSSafety.tsx — Safety event log + IEC 62619 compliance summary.
 */
import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, ShieldCheck, ShieldAlert, CheckCircle, RefreshCw, X } from 'lucide-react'

interface SafetyEvent {
  id: string
  cell_id: string
  pack_id: string
  event_type: string
  severity: 'trip' | 'warning' | 'info'
  value: number
  limit_value: number
  cleared: boolean | number
  ts: string
  source: string
}

interface SafetySummary {
  total_events: number
  trip_count: number
  warning_count: number
  event_types: Record<string, number>
  active_trips: number
  active_warnings: number
  iec_62619_compliant: boolean
  violations: string[]
}

const SEV_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  trip:    { color: '#ef4444', bg: 'bg-red-500/10 border-red-500/30',    label: 'TRIP' },
  warning: { color: '#f59e0b', bg: 'bg-amber-500/10 border-amber-500/30', label: 'WARN' },
  info:    { color: '#3b82f6', bg: 'bg-blue-500/10 border-blue-500/30',   label: 'INFO' },
}

export default function BMSSafety() {
  const [events, setEvents]   = useState<SafetyEvent[]>([])
  const [summary, setSummary] = useState<SafetySummary | null>(null)
  const [filter, setFilter]   = useState<'all' | 'trip' | 'warning' | 'active'>('all')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const [evRes, sumRes] = await Promise.all([
        fetch('/api/bms/safety/events?limit=200'),
        fetch('/api/bms/safety/summary'),
      ])
      if (evRes.ok)  setEvents(await evRes.json())
      if (sumRes.ok) setSummary(await sumRes.json())
    } catch { /* offline */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load(); const t = setInterval(load, 10000); return () => clearInterval(t) }, [load])

  async function clearEvent(id: string) {
    await fetch(`/api/bms/safety/${id}/clear`, { method: 'POST' })
    load()
  }

  const visible = events.filter(e => {
    if (filter === 'trip')    return e.severity === 'trip'
    if (filter === 'warning') return e.severity === 'warning'
    if (filter === 'active')  return !e.cleared
    return true
  })

  return (
    <div className="px-6 py-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <ShieldAlert size={20} className="text-brand-blue" />
            <h1 className="text-xl font-bold text-text-primary">Safety Events</h1>
            {summary && (
              <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold border
                ${summary.iec_62619_compliant
                  ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                  : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
                {summary.iec_62619_compliant ? <><ShieldCheck size={10}/> IEC 62619 OK</> : <><ShieldAlert size={10}/> IEC 62619 FAIL</>}
              </span>
            )}
          </div>
          <p className="text-text-muted text-xs">Hardware trip signals, threshold violations, compliance monitoring</p>
        </div>
        <button onClick={load}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-secondary hover:text-text-primary transition-all">
          <RefreshCw size={11} /> Refresh
        </button>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Active Trips',    value: summary.active_trips,    color: '#ef4444', icon: AlertTriangle },
            { label: 'Active Warnings', value: summary.active_warnings, color: '#f59e0b', icon: AlertTriangle },
            { label: 'Total Trips',     value: summary.trip_count,      color: '#ef4444', icon: ShieldAlert },
            { label: 'Total Warnings',  value: summary.warning_count,   color: '#f59e0b', icon: ShieldAlert },
          ].map(s => (
            <div key={s.label} className="panel p-4">
              <div className="flex items-center gap-2 mb-2">
                <s.icon size={13} style={{ color: s.color }} />
                <span className="text-xs text-text-muted uppercase tracking-wider">{s.label}</span>
              </div>
              <div className="font-mono font-bold text-2xl" style={{ color: s.value > 0 ? s.color : '#64748b' }}>
                {s.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Violations */}
      {summary && summary.violations.length > 0 && (
        <div className="mb-4 p-4 rounded-xl border border-red-500/30 bg-red-500/5">
          <div className="flex items-center gap-2 mb-2">
            <ShieldAlert size={14} className="text-red-400" />
            <span className="text-sm font-semibold text-red-400">IEC 62619 Violations</span>
          </div>
          <ul className="space-y-1">
            {summary.violations.map((v, i) => (
              <li key={i} className="text-xs text-red-300 flex items-center gap-2">
                <span className="w-1 h-1 rounded-full bg-red-400 flex-shrink-0" />
                {v}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-1 mb-3">
        {(['all', 'active', 'trip', 'warning'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all
              ${filter === f ? 'bg-brand-blue/10 text-brand-blue border border-brand-blue/30' : 'text-text-muted hover:text-text-primary'}`}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
            {f === 'trip' && summary && summary.trip_count > 0 && (
              <span className="ml-1 px-1 py-0.5 rounded bg-red-500/20 text-red-400 text-[10px]">{summary.trip_count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Events table */}
      <div className="panel overflow-hidden">
        {loading ? (
          <div className="px-4 py-12 text-center text-text-muted text-sm">Loading events…</div>
        ) : visible.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <CheckCircle size={32} className="text-emerald-400/40 mx-auto mb-3" />
            <div className="text-sm text-text-muted">No safety events</div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-panel/50">
                  {['Severity', 'Cell', 'Pack', 'Event Type', 'Value', 'Threshold', 'Source', 'Time', ''].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map(ev => {
                  const sty = SEV_STYLE[ev.severity] ?? SEV_STYLE.info
                  return (
                    <tr key={ev.id} className={`border-b border-border-subtle/50 ${ev.cleared ? 'opacity-40' : ''}`}>
                      <td className="px-3 py-2">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${sty.bg}`}
                          style={{ color: sty.color }}>{sty.label}</span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-brand-blue">{ev.cell_id}</td>
                      <td className="px-3 py-2 text-xs text-text-muted">{ev.pack_id || '—'}</td>
                      <td className="px-3 py-2 text-xs text-text-primary font-medium">{ev.event_type.replace(/_/g, ' ')}</td>
                      <td className="px-3 py-2 font-mono text-xs" style={{ color: sty.color }}>
                        {(ev.value ?? 0).toFixed(3)}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs text-text-muted">{(ev.limit_value ?? 0).toFixed(3)}</td>
                      <td className="px-3 py-2 text-xs text-text-muted">{ev.source}</td>
                      <td className="px-3 py-2 text-xs text-text-muted">
                        {new Date(ev.ts).toLocaleString()}
                      </td>
                      <td className="px-3 py-2">
                        {!ev.cleared && (
                          <button onClick={() => clearEvent(ev.id)}
                            className="flex items-center gap-1 px-2 py-0.5 text-[10px] rounded border border-border-subtle text-text-muted hover:text-text-primary hover:border-brand-blue/40 transition-all">
                            <X size={9} /> Clear
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

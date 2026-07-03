/**
 * Analytics — prediction usage dashboard.
 * Route: /analytics
 * Shows: call volume over time, chemistry distribution, phase distribution, recent calls.
 */
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import Plot from 'react-plotly.js'
import { BarChart3, RefreshCw, Zap, Activity, TrendingUp, AlertTriangle, Building2 } from 'lucide-react'

interface Summary {
  total_predictions: number
  total_alerts:      number
  unacknowledged:    number
  avg_rul:           number | null
  chemistry_dist:    Record<string, number>
  phase_dist:        Record<string, number>
  daily_counts:      { date: string; count: number }[]
}

interface CallRow {
  ts:    string
  chem:  string
  model: string
  rul:   number
  phase: string
  src:   string
  org:   string
}

const CHEM_COLORS: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4',
}
const PHASE_COLORS: Record<string, string> = {
  Fresh: '#10b981', Aging: '#3b82f6', Knee: '#f59e0b', 'Near-EOL': '#ef4444',
}
const PLOT_BASE = {
  paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
  font: { family: 'Inter, sans-serif', color: '#94a3b8', size: 10 },
  margin: { t: 10, b: 40, l: 50, r: 10 },
  xaxis: { gridcolor: '#1e2d45', linecolor: '#1e2d45', zerolinecolor: '#1e2d45' },
  yaxis: { gridcolor: '#1e2d45', linecolor: '#1e2d45', zerolinecolor: '#1e2d45' },
}

function KpiCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: string | number; sub?: string
  icon: React.ElementType; color: string
}) {
  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 flex gap-3 items-start">
      <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
        style={{ background: color + '20' }}>
        <Icon size={15} style={{ color }} />
      </div>
      <div>
        <div className="text-[10px] text-text-muted uppercase tracking-widest">{label}</div>
        <div className="text-xl font-bold font-mono text-text-primary mt-0.5">{value}</div>
        {sub && <div className="text-[10px] text-text-muted mt-0.5">{sub}</div>}
      </div>
    </div>
  )
}

export default function Analytics() {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [calls,   setCalls]   = useState<CallRow[]>([])
  const [orgs,    setOrgs]    = useState<string[]>([])
  const [org,     setOrg]     = useState('')
  const [loading, setLoading] = useState(true)

  const load = (selectedOrg = org) => {
    setLoading(true)
    const q = selectedOrg ? `?org=${encodeURIComponent(selectedOrg)}` : ''
    Promise.all([
      fetch(`/api/analytics/summary${q}`).then(r => r.json()),
      fetch(`/api/analytics/calls?limit=50${selectedOrg ? `&org=${encodeURIComponent(selectedOrg)}` : ''}`).then(r => r.json()),
      fetch('/api/analytics/orgs').then(r => r.json()),
    ])
      .then(([s, c, o]) => { setSummary(s); setCalls(c); setOrgs(o) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const topChem = summary
    ? Object.entries(summary.chemistry_dist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '—'
    : '—'

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Analytics</h1>
          <p className="text-sm text-text-muted mt-0.5">Prediction volume, chemistry mix, and usage trends.</p>
        </div>
        <div className="flex items-center gap-2 ml-auto">
          {orgs.length > 0 && (
            <div className="flex items-center gap-1.5">
              <Building2 size={12} className="text-text-muted" />
              <select
                value={org}
                onChange={e => { setOrg(e.target.value); load(e.target.value) }}
                className="px-2 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none"
              >
                <option value="">All orgs</option>
                {orgs.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          )}
          <button onClick={() => load()} disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {loading && !summary ? (
        <div className="flex items-center justify-center py-20 text-text-muted text-xs gap-2">
          <RefreshCw size={13} className="animate-spin" /> Loading analytics…
        </div>
      ) : summary ? (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-5">

          {/* KPI strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KpiCard label="Total Predictions"
              value={summary.total_predictions.toLocaleString()}
              sub="all time" icon={Zap} color="#3b82f6" />
            <KpiCard label="Avg RUL"
              value={summary.avg_rul != null ? `${summary.avg_rul} cyc` : '—'}
              sub="across all calls" icon={TrendingUp} color="#10b981" />
            <KpiCard label="Top Chemistry"
              value={topChem}
              sub={summary.chemistry_dist[topChem] ? `${summary.chemistry_dist[topChem]} calls` : ''}
              icon={Activity} color="#f59e0b" />
            <KpiCard label="Unack. Alerts"
              value={summary.unacknowledged}
              sub={`${summary.total_alerts} total`}
              icon={AlertTriangle}
              color={summary.unacknowledged > 0 ? '#ef4444' : '#10b981'} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* Daily call volume */}
            <div className="lg:col-span-2 bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 size={14} className="text-brand-blue" />
                <span className="text-sm font-semibold text-text-primary">Predictions per Day</span>
                <span className="text-[10px] text-text-muted ml-auto">last 14 days</span>
              </div>
              {summary.daily_counts.length > 0 ? (
                <Plot
                  data={[{
                    type: 'bar',
                    x:    summary.daily_counts.map(d => d.date),
                    y:    summary.daily_counts.map(d => d.count),
                    marker: { color: '#3b82f6', opacity: 0.85 },
                    text: summary.daily_counts.map(d => String(d.count)),
                    textposition: 'outside',
                  }]}
                  layout={{ ...PLOT_BASE, height: 200,
                    yaxis: { ...PLOT_BASE.yaxis, title: { text: 'Calls' } } }}
                  config={{ displayModeBar: false, responsive: true }}
                  style={{ width: '100%' }}
                />
              ) : (
                <div className="flex items-center justify-center h-40 text-xs text-text-muted">
                  No prediction data yet. Make a prediction to start tracking.
                </div>
              )}
            </div>

            {/* Chemistry distribution */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div className="text-sm font-semibold text-text-primary mb-3">Chemistry Mix</div>
              {Object.keys(summary.chemistry_dist).length > 0 ? (
                <Plot
                  data={[{
                    type:   'pie',
                    labels: Object.keys(summary.chemistry_dist),
                    values: Object.values(summary.chemistry_dist),
                    marker: { colors: Object.keys(summary.chemistry_dist).map(c => CHEM_COLORS[c] ?? '#6b7280') },
                    hole:   0.5,
                    textinfo: 'label+percent',
                    textfont: { size: 10, color: '#94a3b8' },
                  }]}
                  layout={{ ...PLOT_BASE, height: 200, showlegend: false,
                    margin: { t: 10, b: 10, l: 10, r: 10 } }}
                  config={{ displayModeBar: false, responsive: true }}
                  style={{ width: '100%' }}
                />
              ) : (
                <div className="flex items-center justify-center h-40 text-xs text-text-muted">No data yet</div>
              )}
            </div>
          </div>

          {/* Phase distribution + recent calls */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* Phase dist bar */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div className="text-sm font-semibold text-text-primary mb-3">Phase Distribution</div>
              <div className="space-y-2">
                {Object.entries(summary.phase_dist)
                  .sort((a, b) => b[1] - a[1])
                  .map(([phase, count]) => {
                    const total = Object.values(summary.phase_dist).reduce((a, b) => a + b, 0)
                    const pct   = total > 0 ? (count / total) * 100 : 0
                    return (
                      <div key={phase} className="space-y-1">
                        <div className="flex justify-between text-[10px]">
                          <span style={{ color: PHASE_COLORS[phase] ?? '#6b7280' }}>{phase}</span>
                          <span className="text-text-muted font-mono">{count}</span>
                        </div>
                        <div className="h-1.5 bg-bg-panel rounded-full overflow-hidden">
                          <div className="h-full rounded-full"
                            style={{ width: `${pct}%`, background: PHASE_COLORS[phase] ?? '#6b7280' }} />
                        </div>
                      </div>
                    )
                  })}
                {Object.keys(summary.phase_dist).length === 0 && (
                  <div className="text-xs text-text-muted py-4 text-center">No data yet</div>
                )}
              </div>
            </div>

            {/* Recent calls table */}
            <div className="lg:col-span-2 bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-border-subtle">
                <span className="text-sm font-semibold text-text-primary">Recent Predictions</span>
              </div>
              {calls.length === 0 ? (
                <div className="flex items-center justify-center py-10 text-xs text-text-muted">
                  No predictions logged yet.
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="border-b border-border-subtle text-text-muted">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Time</th>
                      <th className="px-4 py-2 text-left font-medium">Chem</th>
                      <th className="px-4 py-2 text-right font-medium">RUL</th>
                      <th className="px-4 py-2 text-left font-medium">Phase</th>
                      <th className="px-4 py-2 text-left font-medium">Source</th>
                      <th className="px-4 py-2 text-left font-medium">Org</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.slice(0, 20).map((c, i) => (
                      <tr key={i} className="border-b border-border-subtle/40 hover:bg-bg-panel transition-colors">
                        <td className="px-4 py-2 text-text-muted font-mono text-[10px]">
                          {c.ts.slice(11, 19)}
                        </td>
                        <td className="px-4 py-2">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold"
                            style={{
                              background: (CHEM_COLORS[c.chem] ?? '#6b7280') + '20',
                              color: CHEM_COLORS[c.chem] ?? '#6b7280',
                            }}>{c.chem}</span>
                        </td>
                        <td className="px-4 py-2 text-right font-mono text-text-primary">{c.rul}</td>
                        <td className="px-4 py-2">
                          <span style={{ color: PHASE_COLORS[c.phase] ?? '#6b7280' }}>{c.phase}</span>
                        </td>
                        <td className="px-4 py-2 text-text-muted text-[10px]">{c.src}</td>
                        <td className="px-4 py-2 text-text-muted text-[10px]">
                          {c.org || <span className="opacity-40">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </motion.div>
      ) : null}
    </div>
  )
}

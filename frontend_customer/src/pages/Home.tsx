/**
 * Dashboard — product home page.
 * Shows: system health, fleet KPIs, chemistry distribution, alert feed, quick actions.
 * Data: real from /api/fleet/summary
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import {
  Upload, Zap, AlertTriangle, CheckCircle2, Activity,
  Battery, BarChart2, ArrowRight, Info, RefreshCw, TrendingDown,
} from 'lucide-react'

interface FadeEvent {
  cell_id: string; chemistry: string; cycle: number
  severity: string; value: number; expected: number
  deviation_sigma: number; description: string; detected_at: string
}

interface FleetCell {
  cell_id: string
  dataset: string
  chemistry: string
  soh: number
  rul: number
  cycles: number
  max_rul: number
  phase: string
  alert: string
  ir: number
}

const CHEM_COLORS: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4',
}
const ALERT_STYLES: Record<string, { dot: string; badge: string; label: string }> = {
  healthy:  { dot: 'bg-emerald-500', badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', label: 'Healthy' },
  warning:  { dot: 'bg-amber-400',   badge: 'bg-amber-400/10  text-amber-400  border-amber-400/20',   label: 'Warning' },
  critical: { dot: 'bg-red-500',     badge: 'bg-red-500/10    text-red-400    border-red-500/20',    label: 'Critical' },
}
const PHASE_STYLES: Record<string, string> = {
  Fresh: 'text-emerald-400', Aging: 'text-amber-400',
  Knee: 'text-orange-400', 'Near-EOL': 'text-red-400',
}

function KpiCard({ icon: Icon, label, value, sub, color = 'blue' }: {
  icon: React.ElementType; label: string; value: string | number; sub?: string; color?: string
}) {
  const colors: Record<string, string> = {
    blue:    'from-blue-500/10 to-blue-600/5 border-blue-500/20',
    emerald: 'from-emerald-500/10 to-emerald-600/5 border-emerald-500/20',
    amber:   'from-amber-500/10 to-amber-600/5 border-amber-500/20',
    red:     'from-red-500/10 to-red-600/5 border-red-500/20',
  }
  const iconColor: Record<string, string> = {
    blue: 'text-blue-400', emerald: 'text-emerald-400',
    amber: 'text-amber-400', red: 'text-red-400',
  }
  return (
    <div className={`rounded-xl border bg-gradient-to-br p-4 ${colors[color]}`}>
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-text-muted mb-1">{label}</div>
          <div className="text-2xl font-bold text-text-primary">{value}</div>
          {sub && <div className="text-xs text-text-muted mt-0.5">{sub}</div>}
        </div>
        <Icon size={20} className={iconColor[color]} />
      </div>
    </div>
  )
}

const stagger = { show: { transition: { staggerChildren: 0.06 } } }
const fadeUp  = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } }

export default function Dashboard() {
  const navigate = useNavigate()
  const [cells,      setCells]      = useState<FleetCell[]>([])
  const [loading,    setLoading]    = useState(true)
  const [backendOk,  setBackendOk]  = useState<boolean | null>(null)
  const [fadeEvents, setFadeEvents] = useState<FadeEvent[]>([])

  const fetchFleet = () => {
    setLoading(true)
    fetch('/api/fleet/summary?max_cells=40')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: FleetCell[]) => { setCells(data); setBackendOk(true) })
      .catch(() => setBackendOk(false))
      .finally(() => setLoading(false))
  }

  const fetchFadeAlerts = () => {
    fetch('/api/anomaly/events?limit=20')
      .then(r => r.ok ? r.json() : [])
      .then((data: FadeEvent[]) => setFadeEvents(
        data.filter((e: FadeEvent) => (e as any).anomaly_type === 'fade_acceleration')
      ))
      .catch(() => {})
  }

  useEffect(() => { fetchFleet(); fetchFadeAlerts() }, [])

  const total    = cells.length
  const healthy  = cells.filter(c => c.alert === 'healthy').length
  const warnings = cells.filter(c => c.alert === 'warning').length
  const critical = cells.filter(c => c.alert === 'critical').length
  const avgSoh   = total > 0
    ? (cells.reduce((s, c) => s + c.soh, 0) / total).toFixed(1)
    : '—'

  const chemCounts = cells.reduce<Record<string, number>>((acc, c) => {
    acc[c.chemistry] = (acc[c.chemistry] || 0) + 1; return acc
  }, {})

  return (
    <div className="p-3 sm:p-6 max-w-7xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Fleet Dashboard</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Battery health overview · {loading ? '…' : `${total} cells monitored`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {backendOk !== null && (
            <div className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${
              backendOk
                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                : 'bg-red-500/10 text-red-400 border-red-500/20'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${backendOk ? 'bg-emerald-400' : 'bg-red-400'}`} />
              {backendOk ? 'Engine online' : 'Engine offline'}
            </div>
          )}
          <button onClick={fetchFleet} disabled={loading}
            className="flex items-center gap-1.5 px-2.5 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={() => navigate('/upload')}
            className="flex items-center gap-2 px-3 py-1.5 bg-brand-blue rounded-lg text-xs font-medium text-white hover:bg-blue-500 transition-colors"
          >
            <Upload size={13} /> Upload Data
          </button>
        </div>
      </div>

      {/* KPI cards */}
      <motion.div variants={stagger} initial="hidden" animate="show"
        className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <motion.div variants={fadeUp}>
          <KpiCard icon={Battery}      label="Total Cells"    value={loading ? '…' : total}
            sub="monitored" color="blue" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <KpiCard icon={Activity}     label="Avg. SOH"       value={loading ? '…' : `${avgSoh}%`}
            sub="state of health" color="emerald" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <KpiCard icon={AlertTriangle} label="Cells at Risk" value={loading ? '…' : warnings + critical}
            sub={`${warnings} warn · ${critical} critical`} color="amber" />
        </motion.div>
        <motion.div variants={fadeUp}>
          <KpiCard icon={CheckCircle2} label="Healthy"        value={loading ? '…' : healthy}
            sub={total > 0 ? `${((healthy / total) * 100).toFixed(0)}% of fleet` : ''} color="emerald" />
        </motion.div>
      </motion.div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

        {/* Fleet table */}
        <div className="lg:col-span-2">
          <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <span className="text-sm font-semibold text-text-primary">Cell Registry</span>
              <span className="text-xs text-text-muted">{loading ? 'loading…' : `${total} cells`}</span>
            </div>
            <div className="overflow-x-auto">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-text-muted text-xs gap-2">
                  <RefreshCw size={13} className="animate-spin" /> Loading fleet data…
                </div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-subtle text-text-muted">
                      <th className="px-4 py-2.5 text-left font-medium">Cell ID</th>
                      <th className="px-4 py-2.5 text-left font-medium">Chemistry</th>
                      <th className="px-4 py-2.5 text-right font-medium">SOH %</th>
                      <th className="px-4 py-2.5 text-right font-medium">RUL (cycles)</th>
                      <th className="px-4 py-2.5 text-left font-medium">Phase</th>
                      <th className="px-4 py-2.5 text-left font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cells.slice(0, 15).map(cell => {
                      const s = ALERT_STYLES[cell.alert] ?? ALERT_STYLES.healthy
                      return (
                        <tr key={cell.cell_id}
                          onClick={() => navigate('/fleet', { state: { cell_id: cell.cell_id } })}
                          className="border-b border-border-subtle/50 hover:bg-bg-panel transition-colors cursor-pointer">
                          <td className="px-4 py-2.5 font-mono text-text-primary">{cell.cell_id}</td>
                          <td className="px-4 py-2.5">
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                              style={{ background: (CHEM_COLORS[cell.chemistry] ?? '#6b7280') + '20', color: CHEM_COLORS[cell.chemistry] ?? '#6b7280' }}>
                              {cell.chemistry}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono">
                            <span className={cell.soh > 80 ? 'text-emerald-400' : cell.soh > 65 ? 'text-amber-400' : 'text-red-400'}>
                              {cell.soh}%
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-text-primary">{cell.rul.toLocaleString()}</td>
                          <td className={`px-4 py-2.5 font-medium ${PHASE_STYLES[cell.phase] ?? 'text-text-muted'}`}>{cell.phase}</td>
                          <td className="px-4 py-2.5">
                            <span className={`flex items-center gap-1 w-fit px-2 py-0.5 rounded-full border text-[10px] font-medium ${s.badge}`}>
                              <span className={`w-1 h-1 rounded-full ${s.dot}`} />{s.label}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
            {!loading && total > 15 && (
              <div className="px-4 py-2.5 border-t border-border-subtle/50 text-center">
                <button onClick={() => navigate('/fleet')}
                  className="text-xs text-brand-blue hover:underline flex items-center gap-1 mx-auto">
                  View all {total} cells <ArrowRight size={11} />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right column */}
        <div className="space-y-4">

          {/* Chemistry breakdown */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <div className="text-sm font-semibold text-text-primary mb-3">Chemistry Breakdown</div>
            {loading ? (
              <div className="text-xs text-text-muted">Loading…</div>
            ) : (
              <div className="space-y-2">
                {Object.entries(chemCounts).sort((a, b) => b[1] - a[1]).map(([chem, count]) => (
                  <div key={chem} className="flex items-center gap-2">
                    <span className="text-xs font-bold w-10" style={{ color: CHEM_COLORS[chem] ?? '#6b7280' }}>{chem}</span>
                    <div className="flex-1 h-2 bg-bg-panel rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${(count / total) * 100}%`, background: CHEM_COLORS[chem] ?? '#6b7280' }} />
                    </div>
                    <span className="text-xs text-text-muted w-6 text-right">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* SOH histogram */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <div className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-1.5">
              <BarChart2 size={14} className="text-brand-blue" />
              SOH Distribution
            </div>
            <div className="space-y-1.5">
              {[
                { label: '> 90%  (Fresh)',    lo: 90,  hi: 101, color: '#10b981' },
                { label: '75–90% (Aging)',    lo: 75,  hi: 90,  color: '#3b82f6' },
                { label: '60–75% (Knee)',     lo: 60,  hi: 75,  color: '#f59e0b' },
                { label: '< 60%  (Near-EOL)',lo: 0,   hi: 60,  color: '#ef4444' },
              ].map(({ label, lo, hi, color }) => {
                const n = cells.filter(c => c.soh >= lo && c.soh < hi).length
                return (
                  <div key={label} className="flex items-center gap-2">
                    <span className="text-[10px] text-text-muted w-28 leading-tight">{label}</span>
                    <div className="flex-1 h-1.5 bg-bg-panel rounded-full overflow-hidden">
                      <div className="h-full rounded-full"
                        style={{ width: total > 0 ? `${(n / total) * 100}%` : '0%', background: color }} />
                    </div>
                    <span className="text-[10px] text-text-muted w-4 text-right">{n}</span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Quick actions */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <div className="text-sm font-semibold text-text-primary mb-3">Quick Actions</div>
            <div className="space-y-2">
              {[
                { icon: Upload,   label: 'Upload New Data',     sub: 'CSV or JSON',  to: '/upload',  colorDot: '#3b82f6' },
                { icon: Zap,      label: 'Single-Cell Predict', sub: 'Manual input', to: '/predict', colorDot: '#06b6d4' },
                { icon: Activity, label: 'Fleet View',          sub: 'All cells',    to: '/fleet',   colorDot: '#8b5cf6' },
              ].map(({ icon: Icon, label, sub, to, colorDot }) => (
                <button key={to} onClick={() => navigate(to)}
                  className="w-full flex items-center gap-3 p-2.5 rounded-lg border border-border-subtle hover:bg-bg-panel transition-all group text-left">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                    style={{ background: colorDot + '18' }}>
                    <Icon size={13} style={{ color: colorDot }} />
                  </div>
                  <div className="flex-1">
                    <div className="text-xs font-medium text-text-primary">{label}</div>
                    <div className="text-[10px] text-text-muted">{sub}</div>
                  </div>
                  <ArrowRight size={12} className="text-text-muted group-hover:text-text-secondary transition-colors" />
                </button>
              ))}
            </div>
          </div>

          {/* Fade Acceleration Alerts (Layer 2) */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <div className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-1.5">
              <TrendingDown size={14} className="text-red-400" />
              Fade Acceleration
            </div>
            {fadeEvents.length === 0 ? (
              <div className="text-[10px] text-emerald-400 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                No acceleration events
              </div>
            ) : (
              <div className="space-y-1.5">
                {fadeEvents.slice(0, 4).map((e, i) => (
                  <div key={i}
                    className={`flex items-start gap-2 p-2 rounded-lg text-[10px] cursor-pointer ${
                      e.severity === 'critical'
                        ? 'bg-red-500/10 border border-red-500/20'
                        : 'bg-amber-400/10 border border-amber-400/20'
                    }`}
                    onClick={() => navigate('/fleet', { state: { cell_id: e.cell_id } })}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full mt-0.5 flex-shrink-0 ${
                      e.severity === 'critical' ? 'bg-red-400' : 'bg-amber-400'
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="font-mono font-medium text-text-primary truncate">{e.cell_id}</div>
                      <div className="text-text-muted">{e.deviation_sigma.toFixed(1)}× fade · cycle {e.cycle}</div>
                    </div>
                  </div>
                ))}
                {fadeEvents.length > 4 && (
                  <button onClick={() => navigate('/alerts')}
                    className="text-[10px] text-brand-blue hover:underline flex items-center gap-1">
                    +{fadeEvents.length - 4} more <ArrowRight size={9} />
                  </button>
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      {/* Alert feed */}
      {!loading && cells.some(c => c.alert !== 'healthy') && (
        <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
              <AlertTriangle size={14} className="text-amber-400" />
              Recent Alerts
            </div>
            <span className="text-xs text-text-muted">{warnings + critical} active</span>
          </div>
          <div className="divide-y divide-border-subtle/50">
            {cells
              .filter(c => c.alert !== 'healthy')
              .slice(0, 8)
              .map(cell => {
                const s = ALERT_STYLES[cell.alert] ?? ALERT_STYLES.warning
                return (
                  <div key={cell.cell_id}
                    className="flex items-center gap-4 px-4 py-2.5 hover:bg-bg-panel transition-colors">
                    <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                    <span className="text-xs font-mono text-text-primary w-28 truncate">{cell.cell_id}</span>
                    <span className="text-xs text-text-muted flex-1">
                      SOH {cell.soh}% · {cell.rul} cycles remaining · {cell.phase} phase
                    </span>
                    <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium ${s.badge}`}>
                      {s.label}
                    </span>
                    <button
                      onClick={() => navigate('/fleet', { state: { cell_id: cell.cell_id } })}
                      className="text-[10px] text-brand-blue hover:underline flex items-center gap-1">
                      Analyze <ArrowRight size={10} />
                    </button>
                  </div>
                )
              })}
          </div>
        </div>
      )}

      {/* Model info */}
      <div className="flex items-center gap-3 px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-xs text-text-muted">
        <Info size={13} className="text-brand-blue flex-shrink-0" />
        <span>
          Predictions powered by <strong className="text-text-secondary">MambaRUL v10-final</strong> · 5 Li-ion chemistries · 42 electrochemical features · 90% conformal prediction intervals · CALCE-LCO RMSE = 20 cycles
        </span>
        <button onClick={() => navigate('/predict')}
          className="ml-auto flex-shrink-0 flex items-center gap-1 text-brand-blue hover:underline">
          Run prediction <ArrowRight size={11} />
        </button>
      </div>
    </div>
  )
}

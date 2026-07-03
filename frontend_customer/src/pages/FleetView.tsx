/**
 * FleetView — fleet table + per-cell RUL trend drawer.
 * Drawer data: /api/rul/trend/{cell_id}  (Layer 2 fade alerts + Layer 3 CI)
 */
import { useState, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate, useLocation } from 'react-router-dom'
import {
  Battery, ArrowRight, AlertTriangle, RefreshCw, ShieldAlert, X,
  TrendingDown, Info, Activity, FileText,
} from 'lucide-react'

async function downloadExecutiveReport() {
  const res = await fetch('/api/report/executive.pdf')
  if (!res.ok) return
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `batteryos_executive_report_${new Date().toISOString().slice(0, 10)}.pdf`
  a.click()
  URL.revokeObjectURL(url)
}

interface FleetCell {
  cell_id: string; dataset: string; chemistry: string
  soh: number; rul: number; cycles: number; max_rul: number
  phase: string; alert: string; ir: number
  is_anomaly?: boolean; anomaly_reason?: string
  z_soh?: number; z_rul?: number
}

interface TrendPoint { cycle: number; rul: number; rul_lower: number; rul_upper: number; soh_pct: number }
interface FadeAlert  { cycle: number; severity: string; value: number; expected: number; deviation_sigma: number; description: string; detected_at: string }
interface TrendData {
  cell_id: string; n_cycles: number
  history: TrendPoint[]
  trend?: { intercept: number; slope: number; fitted_ruls: number[] }
  layer3_ci: { half_width: number | null; source: string; min_cycles_needed: number }
  fade_alerts: FadeAlert[]
}

const CHEM_COLOR: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4',
}
const ALERT_BADGE: Record<string, string> = {
  healthy:  'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  warning:  'bg-amber-400/10  text-amber-400  border-amber-400/20',
  critical: 'bg-red-500/10    text-red-400    border-red-500/20',
}
const PHASE_COLOR: Record<string, string> = {
  Fresh: 'text-emerald-400', Aging: 'text-amber-400',
  Knee: 'text-orange-400', 'Near-EOL': 'text-red-400',
}

// Global chemistry CIs (mirrored from backend _CONFORMAL_90)
const GLOBAL_CI: Record<string, number> = {
  LCO: 34, LFP: 145.3, NMC: 514.3, NCM: 17, NCA: 20,
}

type SortKey = 'cell_id' | 'soh' | 'rul' | 'cycles' | 'chemistry' | 'alert'

// ── Sparkline SVG ─────────────────────────────────────────────────────────────
function Sparkline({ history, fitted, alertCycles }: {
  history: TrendPoint[]
  fitted?: number[]
  alertCycles: Set<number>
}) {
  if (history.length < 2) return <div className="text-xs text-text-muted py-4 text-center">Not enough data</div>

  const W = 320; const H = 90; const PAD = 10
  const cycles = history.map(p => p.cycle)
  const ruls   = history.map(p => p.rul)
  const minC = Math.min(...cycles); const maxC = Math.max(...cycles)
  const minR = Math.min(...ruls, ...(fitted ?? ruls)) * 0.95
  const maxR = Math.max(...ruls, ...(fitted ?? ruls)) * 1.05

  const cx = (c: number) => PAD + ((c - minC) / (maxC - minC || 1)) * (W - 2 * PAD)
  const cy = (r: number) => H - PAD - ((r - minR) / (maxR - minR || 1)) * (H - 2 * PAD)

  const histPath = history.map((p, i) =>
    `${i === 0 ? 'M' : 'L'} ${cx(p.cycle).toFixed(1)} ${cy(p.rul).toFixed(1)}`
  ).join(' ')

  const fitPath = fitted ? fitted.map((r, i) =>
    `${i === 0 ? 'M' : 'L'} ${cx(history[i].cycle).toFixed(1)} ${cy(r).toFixed(1)}`
  ).join(' ') : null

  return (
    <svg width={W} height={H} className="w-full" viewBox={`0 0 ${W} ${H}`}>
      {/* CI band */}
      {history.length > 1 && (
        <path
          d={[
            ...history.map((p, i) => `${i === 0 ? 'M' : 'L'} ${cx(p.cycle).toFixed(1)} ${cy(p.rul_upper).toFixed(1)}`),
            ...history.map((p, i) => `${i === 0 ? '' : 'L'} ${cx(p.cycle).toFixed(1)} ${cy(p.rul_lower).toFixed(1)}`).reverse(),
            'Z'
          ].join(' ')}
          fill="rgba(59,130,246,0.06)"
        />
      )}
      {/* History line */}
      <path d={histPath} fill="none" stroke="#3b82f6" strokeWidth="1.5" strokeLinejoin="round" />
      {/* Trend line */}
      {fitPath && (
        <path d={fitPath} fill="none" stroke="#f59e0b" strokeWidth="1" strokeDasharray="4 3" opacity="0.7" />
      )}
      {/* Alert markers */}
      {history.map(p => alertCycles.has(p.cycle) && (
        <circle key={p.cycle} cx={cx(p.cycle)} cy={cy(p.rul)} r={4}
          fill="#ef4444" stroke="#1e1e2e" strokeWidth={1.5} />
      ))}
      {/* Last point */}
      <circle cx={cx(history.at(-1)!.cycle)} cy={cy(history.at(-1)!.rul)} r={3}
        fill="#3b82f6" stroke="#1e1e2e" strokeWidth={1.5} />
      {/* Axis labels */}
      <text x={PAD} y={H - 1} fontSize="8" fill="#6b7280">{minC}</text>
      <text x={W - PAD} y={H - 1} fontSize="8" fill="#6b7280" textAnchor="end">{maxC}</text>
      <text x={PAD} y={PAD + 2} fontSize="8" fill="#6b7280">{Math.round(maxR)}</text>
    </svg>
  )
}

// ── Cell Detail Drawer ────────────────────────────────────────────────────────
function CellDrawer({ cell, onClose }: { cell: FleetCell; onClose: () => void }) {
  const [trend, setTrend]   = useState<TrendData | null>(null)
  const [loading, setLoading] = useState(true)
  const chemColor = CHEM_COLOR[cell.chemistry] ?? '#6b7280'
  const globalCi  = GLOBAL_CI[cell.chemistry] ?? 60

  useEffect(() => {
    setLoading(true)
    setTrend(null)
    fetch(`/api/rul/trend/${encodeURIComponent(cell.cell_id)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setTrend(d))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [cell.cell_id])

  const alertCycles = new Set((trend?.fade_alerts ?? []).map(a => a.cycle))
  const ci = trend?.layer3_ci.half_width
  const ciTighter = ci !== null && ci !== undefined && ci < globalCi
  const alertBadge = ALERT_BADGE[cell.alert] ?? ALERT_BADGE.warning

  return (
    <motion.div
      initial={{ x: 400, opacity: 0 }} animate={{ x: 0, opacity: 1 }}
      exit={{ x: 400, opacity: 0 }} transition={{ type: 'spring', damping: 28, stiffness: 260 }}
      className="fixed right-0 top-0 bottom-0 w-full sm:w-96 bg-bg-secondary border-l border-border-subtle z-50 flex flex-col shadow-2xl"
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: chemColor + '20' }}>
          <Activity size={13} style={{ color: chemColor }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-mono font-semibold text-sm text-text-primary truncate">{cell.cell_id}</div>
          <div className="text-[10px] text-text-muted">{cell.dataset}</div>
        </div>
        <span className="px-2 py-0.5 rounded text-[10px] font-bold"
          style={{ background: chemColor + '20', color: chemColor }}>
          {cell.chemistry}
        </span>
        <button onClick={onClose} className="p-1 rounded hover:bg-bg-panel text-text-muted hover:text-text-primary">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* Quick stats */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'SOH', value: `${cell.soh}%`, color: cell.soh > 80 ? '#10b981' : cell.soh > 65 ? '#f59e0b' : '#ef4444' },
            { label: 'RUL', value: `${cell.rul.toLocaleString()} cyc`, color: '#3b82f6' },
            { label: 'Cycles', value: cell.cycles, color: '#6b7280' },
          ].map(({ label, value, color }) => (
            <div key={label} className="bg-bg-panel rounded-lg p-2 text-center">
              <div className="text-[9px] text-text-muted uppercase tracking-wide mb-1">{label}</div>
              <div className="text-xs font-bold font-mono" style={{ color }}>{value}</div>
            </div>
          ))}
        </div>

        {/* Phase + status */}
        <div className="flex items-center gap-2">
          <span className={`text-xs font-medium ${PHASE_COLOR[cell.phase] ?? 'text-text-muted'}`}>
            {cell.phase} phase
          </span>
          <span className={`ml-auto px-2 py-0.5 rounded-full border text-[10px] font-medium ${alertBadge}`}>
            {cell.alert}
          </span>
        </div>

        {/* RUL Trend Chart */}
        <div className="bg-bg-panel rounded-xl p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
              <TrendingDown size={12} className="text-brand-blue" /> RUL History
            </span>
            {trend && (
              <span className="text-[9px] text-text-muted">{trend.n_cycles} cycles</span>
            )}
          </div>
          {loading ? (
            <div className="flex items-center justify-center py-8 text-text-muted text-[10px] gap-1.5">
              <RefreshCw size={11} className="animate-spin" /> Loading history…
            </div>
          ) : !trend || trend.history.length < 2 ? (
            <div className="text-[10px] text-text-muted text-center py-6">
              No persisted cycle history yet.<br />
              History builds via live BMS telemetry.
            </div>
          ) : (
            <>
              <Sparkline
                history={trend.history}
                fitted={trend.trend?.fitted_ruls}
                alertCycles={alertCycles}
              />
              <div className="flex items-center gap-3 mt-1.5 text-[9px] text-text-muted">
                <span className="flex items-center gap-1"><span className="w-4 h-px bg-blue-400 inline-block" /> Actual RUL</span>
                <span className="flex items-center gap-1"><span className="w-4 h-px bg-amber-400 inline-block border-dashed" style={{borderTop:'1px dashed #f59e0b',height:0}} /> Trend</span>
                {alertCycles.size > 0 && (
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500 inline-block" /> Fade alert</span>
                )}
              </div>
              {trend.trend && (
                <div className="mt-2 text-[10px] text-text-muted">
                  Slope: <span className={trend.trend.slope < -0.5 ? 'text-red-400' : 'text-text-secondary'}>
                    {trend.trend.slope.toFixed(2)} cycles/cycle
                  </span>
                </div>
              )}
            </>
          )}
        </div>

        {/* Layer 3 CI */}
        <div className="bg-bg-panel rounded-xl p-3">
          <div className="text-xs font-semibold text-text-primary mb-2 flex items-center gap-1.5">
            <Info size={12} className="text-brand-blue" /> Prediction Interval (90%)
          </div>
          {loading ? (
            <div className="text-[10px] text-text-muted">Loading…</div>
          ) : (
            <div className="space-y-1.5 text-[11px]">
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Per-cell CI (Layer 3)</span>
                <span className={`font-mono font-semibold ${ci !== null && ci !== undefined ? (ciTighter ? 'text-emerald-400' : 'text-amber-400') : 'text-text-muted'}`}>
                  {ci !== null && ci !== undefined ? `±${ci.toFixed(1)} cycles` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-text-muted">Global {cell.chemistry} CI</span>
                <span className="font-mono text-text-secondary">±{globalCi} cycles</span>
              </div>
              {ci !== null && ci !== undefined && (
                <div className={`text-[9px] mt-1 ${ciTighter ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {ciTighter
                    ? `${((1 - ci / globalCi) * 100).toFixed(0)}% tighter than global CI`
                    : 'Wider than global — cell shows higher variance'}
                </div>
              )}
              {(!trend || trend.layer3_ci.half_width === null) && (
                <div className="text-[9px] text-text-muted mt-1">
                  Needs ≥{trend?.layer3_ci.min_cycles_needed ?? 10} persisted cycles to activate
                </div>
              )}
            </div>
          )}
        </div>

        {/* Fade Acceleration Alerts */}
        <div className="bg-bg-panel rounded-xl p-3">
          <div className="text-xs font-semibold text-text-primary mb-2 flex items-center gap-1.5">
            <AlertTriangle size={12} className="text-red-400" /> Fade Acceleration Alerts
          </div>
          {loading ? (
            <div className="text-[10px] text-text-muted">Loading…</div>
          ) : !trend || trend.fade_alerts.length === 0 ? (
            <div className="text-[10px] text-emerald-400 flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              No acceleration events detected
            </div>
          ) : (
            <div className="space-y-2">
              {trend.fade_alerts.slice(0, 5).map((a, i) => (
                <div key={i} className={`rounded-lg p-2 border text-[10px] ${
                  a.severity === 'critical'
                    ? 'bg-red-500/10 border-red-500/20 text-red-300'
                    : 'bg-amber-400/10 border-amber-400/20 text-amber-300'
                }`}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="font-semibold uppercase tracking-wide text-[9px]">{a.severity}</span>
                    <span className="text-text-muted font-mono">cycle {a.cycle}</span>
                  </div>
                  <div className="text-[9px] text-text-muted leading-relaxed">
                    Rate: <span className="font-mono">{a.value.toFixed(3)}</span> vs expected{' '}
                    <span className="font-mono">{a.expected.toFixed(3)}</span>{' '}
                    (<span className="font-bold">{a.deviation_sigma.toFixed(1)}×</span>)
                  </div>
                </div>
              ))}
              {trend.fade_alerts.length > 5 && (
                <div className="text-[9px] text-text-muted">+{trend.fade_alerts.length - 5} more in alert history</div>
              )}
            </div>
          )}
        </div>

      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-border-subtle text-[9px] text-text-muted">
        Online RUL: Layer 2 (fade acceleration) · Layer 3 (per-cell CI tightening)
      </div>
    </motion.div>
  )
}

// ── Main FleetView ────────────────────────────────────────────────────────────
export default function FleetView() {
  const navigate  = useNavigate()
  const location  = useLocation()
  const [cells,   setCells]   = useState<FleetCell[]>([])
  const [loading, setLoading] = useState(true)
  const [sort,    setSort]    = useState<SortKey>('soh')
  const [asc,     setAsc]     = useState(true)
  const [filter,  setFilter]  = useState('')
  const [selected, setSelected] = useState<FleetCell | null>(null)

  // Pre-select cell if navigated here from another page
  useEffect(() => {
    const s = location.state as { cell_id?: string } | null
    if (s?.cell_id && cells.length > 0) {
      const found = cells.find(c => c.cell_id === s.cell_id)
      if (found) setSelected(found)
    }
  }, [location.state, cells])

  const fetchFleet = useCallback(() => {
    setLoading(true)
    fetch('/api/fleet/anomalies?max_cells=40')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: FleetCell[]) => setCells(data))
      .catch(() => setCells([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { fetchFleet() }, [fetchFleet])

  const sorted = [...cells]
    .filter(c =>
      c.cell_id.toLowerCase().includes(filter.toLowerCase()) ||
      c.chemistry.toLowerCase().includes(filter.toLowerCase()) ||
      c.dataset.toLowerCase().includes(filter.toLowerCase()) ||
      c.alert.toLowerCase().includes(filter.toLowerCase())
    )
    .sort((a, b) => {
      const va = a[sort], vb = b[sort]
      if (typeof va === 'number' && typeof vb === 'number') return asc ? va - vb : vb - va
      return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })

  const toggleSort = (key: SortKey) => {
    if (sort === key) setAsc(v => !v)
    else { setSort(key); setAsc(true) }
  }

  const Th = ({ label, k }: { label: string; k: SortKey }) => (
    <th className="px-4 py-2.5 text-left font-medium cursor-pointer hover:text-text-primary select-none"
      onClick={() => toggleSort(k)}>
      <span className="flex items-center gap-1">
        {label}
        {sort === k && <span className="text-brand-blue">{asc ? '↑' : '↓'}</span>}
      </span>
    </th>
  )

  const critical  = cells.filter(c => c.alert === 'critical').length
  const anomalies = cells.filter(c => c.is_anomaly).length

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto space-y-5">

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Fleet View</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {loading ? 'Loading…' : `${cells.length} cells · ${critical} critical · ${anomalies} anomalies`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={fetchFleet} disabled={loading}
            className="flex items-center gap-1.5 px-2.5 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={downloadExecutiveReport}
            className="flex items-center gap-1.5 px-2.5 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors">
            <FileText size={11} /> <span className="hidden sm:inline">Executive </span>Report
          </button>
          <button onClick={() => navigate('/upload')}
            className="flex items-center gap-2 px-3 py-1.5 bg-brand-blue text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors">
            <Battery size={13} /> <span className="hidden sm:inline">Add Cell </span>Data
          </button>
        </div>
      </div>

      {critical > 0 && (
        <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400">
          <AlertTriangle size={13} />
          <strong>{critical} cell{critical > 1 ? 's' : ''} in critical state</strong> — replacement recommended.
          {anomalies > 0 && (
            <span className="ml-3 flex items-center gap-1 text-amber-400">
              <ShieldAlert size={12} /> {anomalies} statistical anomal{anomalies > 1 ? 'ies' : 'y'} detected
            </span>
          )}
        </motion.div>
      )}

      <input value={filter} onChange={e => setFilter(e.target.value)}
        placeholder="Filter by cell ID, chemistry, dataset, or status…"
        className="w-full px-3 py-2 text-xs bg-bg-secondary border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50"
      />

      <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-x-auto">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-text-muted text-xs gap-2">
            <RefreshCw size={13} className="animate-spin" /> Loading fleet data…
          </div>
        ) : (
          <table className="w-full text-xs min-w-[860px]">
            <thead className="border-b border-border-subtle text-text-muted">
              <tr>
                <Th label="Cell ID"    k="cell_id" />
                <Th label="Dataset"   k="chemistry" />
                <Th label="Chemistry" k="chemistry" />
                <Th label="SOH %"     k="soh" />
                <Th label="RUL (cyc)" k="rul" />
                <th className="px-4 py-2.5 text-left font-medium">RUL bar</th>
                <Th label="Cycles"    k="cycles" />
                <Th label="Phase"     k="alert" />
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">Anomaly</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {sorted.map(cell => (
                <tr key={cell.cell_id}
                  onClick={() => setSelected(cell)}
                  className={`border-b border-border-subtle/40 hover:bg-bg-panel transition-colors cursor-pointer ${selected?.cell_id === cell.cell_id ? 'bg-bg-panel' : ''}`}>
                  <td className="px-4 py-3 font-mono font-medium text-text-primary">{cell.cell_id}</td>
                  <td className="px-4 py-3 text-text-muted text-[10px]">{cell.dataset}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold"
                      style={{ background: (CHEM_COLOR[cell.chemistry] ?? '#6b7280') + '20', color: CHEM_COLOR[cell.chemistry] ?? '#6b7280' }}>
                      {cell.chemistry}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono">
                    <span className={cell.soh > 80 ? 'text-emerald-400' : cell.soh > 65 ? 'text-amber-400' : 'text-red-400'}>
                      {cell.soh}%
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-text-primary">{cell.rul.toLocaleString()}</td>
                  <td className="px-4 py-3 w-28">
                    <div className="h-1.5 bg-bg-panel rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{ width: `${Math.min(100, (cell.rul / cell.max_rul) * 100)}%`, background: cell.soh > 80 ? '#10b981' : cell.soh > 65 ? '#f59e0b' : '#ef4444' }} />
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-text-muted">{cell.cycles}</td>
                  <td className={`px-4 py-3 font-medium text-xs ${PHASE_COLOR[cell.phase] ?? 'text-text-muted'}`}>{cell.phase}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-medium ${ALERT_BADGE[cell.alert] ?? ALERT_BADGE.warning}`}>
                      {cell.alert}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {cell.is_anomaly ? (
                      <span title={cell.anomaly_reason ?? ''}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-400/10 text-amber-400 border border-amber-400/20 cursor-help">
                        <ShieldAlert size={9} /> Anomaly
                      </span>
                    ) : (
                      <span className="text-[9px] text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={e => { e.stopPropagation(); setSelected(cell) }}
                      className="flex items-center gap-1 text-[10px] text-brand-blue hover:underline">
                      Analyze <ArrowRight size={10} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!loading && (
        <p className="text-xs text-text-muted text-center">
          Showing cells sampled at ~60% of each cell's total cycle life from CALCE / MIT / KJTU / TJU / NASA datasets.
        </p>
      )}

      {/* Cell detail drawer — portaled to body to escape motion.div transform context */}
      {createPortal(
        <AnimatePresence>
          {selected && (
            <>
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="fixed inset-0 z-40 bg-black/30"
                onClick={() => setSelected(null)}
              />
              <CellDrawer cell={selected} onClose={() => setSelected(null)} />
            </>
          )}
        </AnimatePresence>,
        document.body
      )}
    </div>
  )
}

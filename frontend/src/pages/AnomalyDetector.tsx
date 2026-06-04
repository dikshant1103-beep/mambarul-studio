/**
 * AnomalyDetector — SPC (Statistical Process Control) anomaly detection.
 * Route: /anomaly
 * Fleet overview + per-cell control charts (SOH Xbar, IR Xbar, CUSUM).
 */
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, CheckCircle2, RefreshCw, Activity, Search, Info } from 'lucide-react'
import Plot from 'react-plotly.js'

interface AnomalyEvent {
  type: string; cycle: number; value: number; expected: number
  deviation_sigma: number; severity: string; description: string
}
interface CellSummary {
  cell_id: string; chemistry: string; dataset: string
  n_cycles: number; n_anomalies: number; n_critical: number; n_warning: number
  severity: string; soh_last: number; events: AnomalyEvent[]
}
interface FleetResult {
  n_cells: number; n_critical: number; n_warning: number; n_normal: number
  cells: CellSummary[]
}
interface ControlChart {
  cycles: number[]; soh: number[]; soh_ucl: number[]; soh_lcl: number[]; soh_mu: number[]
  ir: number[]; ir_ucl: number[]; ir_lcl: number[]; ir_mu: number[]
  cusum_soh_dn: number[]; cusum_ir_up: number[]
}
interface CellDetail extends CellSummary {
  control_chart: ControlChart
}

const SEV_STYLE: Record<string, { dot: string; badge: string; row: string }> = {
  critical: {
    dot:   'bg-red-500',
    badge: 'bg-red-500/10 text-red-400 border-red-500/20',
    row:   'border-l-2 border-red-500/40',
  },
  warning: {
    dot:   'bg-amber-400',
    badge: 'bg-amber-400/10 text-amber-400 border-amber-400/20',
    row:   'border-l-2 border-amber-400/40',
  },
  normal: {
    dot:   'bg-emerald-500',
    badge: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    row:   '',
  },
}

const TYPE_LABEL: Record<string, string> = {
  capacity_drop:      'Capacity Drop',
  ir_spike:           'IR Spike',
  fade_acceleration:  'Fade Accel.',
  thermal_anomaly:    'Thermal',
  cusum_soh:          'CUSUM SOH',
  cusum_ir:           'CUSUM IR',
}

const PLOTLY_BASE = {
  paper_bgcolor: 'transparent',
  plot_bgcolor:  'transparent',
  margin:        { l: 44, r: 12, t: 28, b: 32 },
  font:          { color: '#94a3b8', size: 10 },
  xaxis: { gridcolor: '#1e293b', zerolinecolor: '#1e293b', tickfont: { size: 9 } },
  yaxis: { gridcolor: '#1e293b', zerolinecolor: '#1e293b', tickfont: { size: 9 } },
}

export default function AnomalyDetector() {
  const [fleet,       setFleet]       = useState<FleetResult | null>(null)
  const [loading,     setLoading]     = useState(false)
  const [selCell,     setSelCell]     = useState<CellDetail | null>(null)
  const [cellLoading, setCellLoading] = useState(false)
  const [filter,      setFilter]      = useState('')
  const [error,       setError]       = useState<string | null>(null)

  const fetchFleet = (refresh = false) => {
    setLoading(true); setError(null)
    fetch(`/api/anomaly/fleet${refresh ? '?refresh=true' : ''}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(setFleet)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }

  const fetchCell = (cell_id: string) => {
    setCellLoading(true)
    fetch(`/api/anomaly/cell/${encodeURIComponent(cell_id)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.statusText))
      .then(setSelCell)
      .catch(() => {})
      .finally(() => setCellLoading(false))
  }

  useEffect(() => { fetchFleet() }, [])

  const visible = (fleet?.cells ?? []).filter(c =>
    !filter || c.cell_id.toLowerCase().includes(filter.toLowerCase()) ||
    c.chemistry.toLowerCase().includes(filter.toLowerCase())
  )

  const cc = selCell?.control_chart

  return (
    <div className="p-3 sm:p-6 max-w-7xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <Activity size={20} className="text-amber-400" /> Anomaly Detection
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            SPC control charts · Z-score · CUSUM · fade acceleration
          </p>
        </div>
        <button onClick={() => fetchFleet(true)} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {/* Fleet KPIs */}
      {fleet && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Cells Scanned',  value: fleet.n_cells,    color: 'blue',    icon: Activity },
            { label: 'Critical',       value: fleet.n_critical, color: 'red',     icon: AlertTriangle },
            { label: 'Warning',        value: fleet.n_warning,  color: 'amber',   icon: AlertTriangle },
            { label: 'Normal',         value: fleet.n_normal,   color: 'emerald', icon: CheckCircle2 },
          ].map(({ label, value, color, icon: Icon }) => {
            const cls: Record<string, string> = {
              blue:    'from-blue-500/10 to-blue-600/5 border-blue-500/20 text-blue-400',
              red:     'from-red-500/10 to-red-600/5 border-red-500/20 text-red-400',
              amber:   'from-amber-500/10 to-amber-600/5 border-amber-500/20 text-amber-400',
              emerald: 'from-emerald-500/10 to-emerald-600/5 border-emerald-500/20 text-emerald-400',
            }
            return (
              <div key={label} className={`rounded-xl border bg-gradient-to-br p-4 ${cls[color]}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-xs text-text-muted mb-1">{label}</div>
                    <div className="text-3xl font-bold text-text-primary">{value}</div>
                  </div>
                  <Icon size={18} className={cls[color].split(' ').pop()} />
                </div>
              </div>
            )
          })}
        </motion.div>
      )}

      {error && (
        <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
          {error}
        </div>
      )}

      {loading && !fleet && (
        <div className="flex items-center justify-center py-16 text-text-muted text-sm gap-2">
          <RefreshCw size={14} className="animate-spin" /> Running SPC scan on fleet…
        </div>
      )}

      {fleet && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

          {/* Cell list */}
          <div className="lg:col-span-2 bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
              <Search size={13} className="text-text-muted" />
              <input value={filter} onChange={e => setFilter(e.target.value)}
                placeholder="Filter cells…"
                className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted focus:outline-none" />
              <span className="text-[10px] text-text-muted">{visible.length}</span>
            </div>
            <div className="overflow-y-auto max-h-[520px] divide-y divide-border-subtle/50">
              {visible.map(cell => {
                const s  = SEV_STYLE[cell.severity] ?? SEV_STYLE.normal
                const sel = selCell?.cell_id === cell.cell_id
                return (
                  <button key={cell.cell_id}
                    onClick={() => fetchCell(cell.cell_id)}
                    className={`w-full text-left px-4 py-2.5 hover:bg-bg-panel transition-colors ${s.row} ${sel ? 'bg-bg-panel' : ''}`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                        <span className="text-xs font-mono text-text-primary truncate max-w-[120px]">
                          {cell.cell_id}
                        </span>
                        <span className="text-[10px] text-text-muted">{cell.chemistry}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        {cell.n_anomalies > 0 && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium ${s.badge}`}>
                            {cell.n_anomalies}
                          </span>
                        )}
                        <span className="text-[10px] text-text-muted">{cell.soh_last}%</span>
                      </div>
                    </div>
                    {cell.events?.slice(0, 1).map((ev, i) => (
                      <p key={i} className="text-[10px] text-text-muted mt-0.5 pl-4 truncate">
                        {ev.description}
                      </p>
                    ))}
                  </button>
                )
              })}
            </div>
          </div>

          {/* Detail panel */}
          <div className="lg:col-span-3 space-y-4">
            {!selCell && !cellLoading && (
              <div className="flex flex-col items-center justify-center h-64 text-text-muted text-sm gap-2 bg-bg-secondary border border-border-subtle rounded-xl">
                <Activity size={28} className="opacity-20" />
                Select a cell to view control charts
              </div>
            )}
            {cellLoading && (
              <div className="flex items-center justify-center h-48 text-text-muted text-xs gap-2 bg-bg-secondary border border-border-subtle rounded-xl">
                <RefreshCw size={12} className="animate-spin" /> Loading cell data…
              </div>
            )}

            {selCell && cc && !cellLoading && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">

                {/* Cell header */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold text-text-primary font-mono">{selCell.cell_id}</div>
                    <div className="text-xs text-text-muted mt-0.5">
                      {selCell.chemistry} · {selCell.dataset} · {selCell.n_cycles} cycles · SOH {selCell.soh_last}%
                    </div>
                  </div>
                  <span className={`text-xs px-2.5 py-1 rounded-full border font-medium ${SEV_STYLE[selCell.severity]?.badge}`}>
                    {selCell.severity} · {selCell.n_anomalies} events
                  </span>
                </div>

                {/* SOH Control Chart */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                  <div className="text-xs font-semibold text-text-primary mb-2">SOH Control Chart (Xbar ±3σ)</div>
                  <Plot
                    data={[
                      { x: cc.cycles, y: cc.soh_ucl, type: 'scatter', mode: 'lines',
                        line: { color: '#ef4444', width: 1, dash: 'dot' }, name: 'UCL', showlegend: true },
                      { x: cc.cycles, y: cc.soh_lcl, type: 'scatter', mode: 'lines',
                        line: { color: '#ef4444', width: 1, dash: 'dot' }, name: 'LCL', showlegend: false },
                      { x: cc.cycles, y: cc.soh_mu, type: 'scatter', mode: 'lines',
                        line: { color: '#64748b', width: 1, dash: 'dash' }, name: 'Mean' },
                      { x: cc.cycles, y: cc.soh, type: 'scatter', mode: 'lines+markers',
                        line: { color: '#3b82f6', width: 2 }, marker: { size: 2 }, name: 'SOH' },
                      // Anomaly markers
                      {
                        x: selCell.events.filter(e => e.type === 'capacity_drop' || e.type === 'cusum_soh').map(e => e.cycle),
                        y: selCell.events.filter(e => e.type === 'capacity_drop' || e.type === 'cusum_soh').map(e => e.value),
                        type: 'scatter', mode: 'markers',
                        marker: { color: '#ef4444', size: 8, symbol: 'x' },
                        name: 'Anomaly',
                      },
                    ]}
                    layout={{
                      ...PLOTLY_BASE, height: 180,
                      yaxis: { ...PLOTLY_BASE.yaxis, title: { text: 'SOH' }, tickformat: '.0%' },
                      xaxis: { ...PLOTLY_BASE.xaxis, title: { text: 'Cycle' } },
                      legend: { x: 0, y: 1.1, orientation: 'h', font: { size: 9 } },
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%' }}
                  />
                </div>

                {/* IR Control Chart — only if data present */}
                {cc.ir && cc.ir.length > 0 && cc.ir.some(v => v && v > 0) && (
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="text-xs font-semibold text-text-primary mb-2">IR Control Chart (Xbar ±3σ)</div>
                    <Plot
                      data={[
                        { x: cc.cycles, y: cc.ir_ucl, type: 'scatter', mode: 'lines',
                          line: { color: '#f59e0b', width: 1, dash: 'dot' }, name: 'UCL' },
                        { x: cc.cycles, y: cc.ir_lcl, type: 'scatter', mode: 'lines',
                          line: { color: '#f59e0b', width: 1, dash: 'dot' }, name: 'LCL', showlegend: false },
                        { x: cc.cycles, y: cc.ir_mu, type: 'scatter', mode: 'lines',
                          line: { color: '#64748b', width: 1, dash: 'dash' }, name: 'Mean' },
                        { x: cc.cycles, y: cc.ir, type: 'scatter', mode: 'lines+markers',
                          line: { color: '#f59e0b', width: 2 }, marker: { size: 2 }, name: 'IR (Ω)' },
                        {
                          x: selCell.events.filter(e => e.type === 'ir_spike' || e.type === 'cusum_ir').map(e => e.cycle),
                          y: selCell.events.filter(e => e.type === 'ir_spike' || e.type === 'cusum_ir').map(e => e.value),
                          type: 'scatter', mode: 'markers',
                          marker: { color: '#ef4444', size: 8, symbol: 'x' },
                          name: 'IR Anomaly',
                        },
                      ]}
                      layout={{
                        ...PLOTLY_BASE, height: 160,
                        yaxis: { ...PLOTLY_BASE.yaxis, title: { text: 'IR (Ω)' } },
                        xaxis: { ...PLOTLY_BASE.xaxis, title: { text: 'Cycle' } },
                        legend: { x: 0, y: 1.15, orientation: 'h', font: { size: 9 } },
                      }}
                      config={{ displayModeBar: false, responsive: true }}
                      style={{ width: '100%' }}
                    />
                  </div>
                )}

                {/* CUSUM Chart */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                  <div className="text-xs font-semibold text-text-primary mb-2">
                    CUSUM Chart <span className="font-normal text-text-muted">(sustained shift detector — alarm at 4σ / 8σ)</span>
                  </div>
                  <Plot
                    data={[
                      { x: cc.cycles, y: cc.cusum_soh_dn, type: 'scatter', mode: 'lines',
                        line: { color: '#3b82f6', width: 2 }, name: 'CUSUM↓ SOH' },
                      { x: cc.cycles, y: cc.cusum_ir_up, type: 'scatter', mode: 'lines',
                        line: { color: '#f59e0b', width: 2 }, name: 'CUSUM↑ IR' },
                      { x: [cc.cycles[0], cc.cycles[cc.cycles.length - 1]],
                        y: [4, 4], type: 'scatter', mode: 'lines',
                        line: { color: '#f59e0b', width: 1, dash: 'dash' }, name: 'Warn (4σ)' },
                      { x: [cc.cycles[0], cc.cycles[cc.cycles.length - 1]],
                        y: [8, 8], type: 'scatter', mode: 'lines',
                        line: { color: '#ef4444', width: 1, dash: 'dash' }, name: 'Crit (8σ)' },
                    ]}
                    layout={{
                      ...PLOTLY_BASE, height: 150,
                      yaxis: { ...PLOTLY_BASE.yaxis, title: { text: 'CUSUM (σ)' } },
                      xaxis: { ...PLOTLY_BASE.xaxis, title: { text: 'Cycle' } },
                      legend: { x: 0, y: 1.2, orientation: 'h', font: { size: 9 } },
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%' }}
                  />
                </div>

                {/* Event log */}
                {selCell.events.length > 0 && (
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-border-subtle text-xs font-semibold text-text-primary">
                      Anomaly Events ({selCell.events.length})
                    </div>
                    <div className="divide-y divide-border-subtle/50 max-h-48 overflow-y-auto">
                      {selCell.events.map((ev, i) => {
                        const s = SEV_STYLE[ev.severity] ?? SEV_STYLE.warning
                        return (
                          <div key={i} className="flex items-start gap-3 px-4 py-2">
                            <span className={`mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.dot}`} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] font-medium text-text-secondary">
                                  Cycle {ev.cycle}
                                </span>
                                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-medium ${s.badge}`}>
                                  {TYPE_LABEL[ev.type] ?? ev.type}
                                </span>
                                <span className="text-[10px] text-text-muted">{ev.deviation_sigma}σ</span>
                              </div>
                              <p className="text-[10px] text-text-muted mt-0.5">{ev.description}</p>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {selCell.events.length === 0 && (
                  <div className="flex items-center gap-2 px-4 py-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl text-xs text-emerald-400">
                    <CheckCircle2 size={13} /> No anomalies detected — cell within control limits
                  </div>
                )}
              </motion.div>
            )}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex items-start gap-2 px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-xs text-text-muted">
        <Info size={12} className="text-brand-blue flex-shrink-0 mt-0.5" />
        <span>
          <strong className="text-text-secondary">Z-score</strong>: flags cycles where SOH/IR deviates &gt;2.5σ (warning) or &gt;3.5σ (critical) from 20-cycle rolling mean.{' '}
          <strong className="text-text-secondary">CUSUM</strong>: detects persistent mean shifts — alarm at 4σ (warning) or 8σ (critical).{' '}
          <strong className="text-text-secondary">Fade accel.</strong>: flags when second-half degradation rate exceeds 2× first-half rate.
        </span>
      </div>
    </div>
  )
}

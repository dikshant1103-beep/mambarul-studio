/**
 * CellDeepDive — full degradation history for a single fleet cell.
 * Route: /cell/:cellId  (navigate with state: { dataset, chemistry, soh, rul, phase, alert })
 */
import { useEffect, useState } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import Plot from 'react-plotly.js'
import {
  ArrowLeft, AlertTriangle, CheckCircle2, Activity,
  Battery, Info, Zap, FileDown, TrendingDown, ShieldAlert,
} from 'lucide-react'

interface OnlineTrendPoint { cycle: number; rul: number; rul_lower: number; rul_upper: number }
interface OnlineFadeAlert  { cycle: number; severity: string; value: number; expected: number; deviation_sigma: number; description: string }
interface OnlineTrend {
  cell_id: string; n_cycles: number
  history: OnlineTrendPoint[]
  trend?: { intercept: number; slope: number; slope_note: string; fitted_ruls: number[] }
  layer3_ci: { half_width: number | null; source: string; min_cycles_needed: number }
  fade_alerts: OnlineFadeAlert[]
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface CapCurve {
  cell_id: string
  dataset: string
  chemistry_name: string
  cycles: number[]
  capacity: number[]
  soh: number[]
  cum_energy: number[]
}
interface RulCurve {
  cell_id: string
  cycles: number[]
  rul: number[]
}
interface NavState {
  dataset?: string
  chemistry?: string
  soh?: number
  rul?: number
  phase?: string
  alert?: string
  max_rul?: number
}

// ── Constants ─────────────────────────────────────────────────────────────────
const CHEM_COLOR: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4',
}
const PHASE_META: Record<string, { color: string; action: string }> = {
  Fresh:      { color: '#10b981', action: 'Standard monitoring. No intervention required.' },
  Aging:      { color: '#3b82f6', action: 'Increase monitoring frequency. Schedule next inspection.' },
  Knee:       { color: '#f59e0b', action: 'Reduce charge rate. Begin replacement procurement.' },
  'Near-EOL': { color: '#ef4444', action: 'Immediate replacement recommended. Risk of capacity cliff.' },
}
const PLOT_LAYOUT_BASE = {
  paper_bgcolor: 'transparent',
  plot_bgcolor:  'transparent',
  font: { family: 'Inter, sans-serif', color: '#94a3b8', size: 11 },
  margin: { t: 10, b: 40, l: 50, r: 16 },
  xaxis: { gridcolor: '#1e2d45', linecolor: '#1e2d45', zerolinecolor: '#1e2d45' },
  yaxis: { gridcolor: '#1e2d45', linecolor: '#1e2d45', zerolinecolor: '#1e2d45' },
  legend: { bgcolor: 'transparent', font: { size: 10 } },
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function KpiCard({ label, value, sub, color }: {
  label: string; value: string | number; sub?: string; color: string
}) {
  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
      <div className="text-[10px] text-text-muted uppercase tracking-widest mb-1">{label}</div>
      <div className="text-2xl font-bold font-mono" style={{ color }}>{value}</div>
      {sub && <div className="text-[10px] text-text-muted mt-0.5">{sub}</div>}
    </div>
  )
}

function downloadCellReport(params: {
  cellId: string; chem: string; snapPhase: string; snapSoh?: number; snapRul?: number
  totalCycles: number | null; initCap: number | null; finalCap: number | null
  capFade: number | null; totalEnergy: number | null; maxRul: number
  dataset: string; phaseMeta: { action: string }
}) {
  import('jspdf').then(({ jsPDF }) => {
    const { cellId, chem, snapPhase, snapSoh, snapRul, totalCycles, initCap,
            finalCap, capFade, totalEnergy, maxRul, dataset, phaseMeta } = params
    const now = new Date().toLocaleString()
    const doc = new jsPDF({ unit: 'mm', format: 'a4' })
    const W = 210; const margin = 18; const col2 = W / 2 + 2

    // ── Header ──────────────────────────────────────────────────────
    doc.setFillColor(30, 64, 175)
    doc.rect(0, 0, W, 22, 'F')
    doc.setTextColor(255, 255, 255)
    doc.setFontSize(16); doc.setFont('helvetica', 'bold')
    doc.text('BatteryOS', margin, 13)
    doc.setFontSize(9); doc.setFont('helvetica', 'normal')
    doc.text('Cell Degradation Report', margin, 19)
    doc.text(`Generated: ${now}`, W - margin, 13, { align: 'right' })

    // ── Cell ID + metadata ───────────────────────────────────────────
    doc.setTextColor(30, 41, 59)
    doc.setFontSize(18); doc.setFont('helvetica', 'bold')
    doc.text(cellId, margin, 34)
    doc.setFontSize(9); doc.setFont('helvetica', 'normal')
    doc.setTextColor(100, 116, 139)
    doc.text(`Chemistry: ${chem}  ·  Dataset: ${dataset}  ·  Phase: ${snapPhase}`, margin, 40)

    // ── KPI row ──────────────────────────────────────────────────────
    const kpis = [
      { label: 'SOH',         value: snapSoh != null ? `${snapSoh}%` : '—' },
      { label: 'RUL (cycles)',value: snapRul != null ? String(snapRul) : '—' },
      { label: 'Total Cycles',value: String(totalCycles ?? '—') },
      { label: 'Cap. Fade',   value: capFade != null ? `${capFade}%` : '—' },
    ]
    const kpiW = (W - margin * 2) / kpis.length
    kpis.forEach((k, i) => {
      const x = margin + i * kpiW
      doc.setFillColor(248, 250, 252)
      doc.roundedRect(x, 45, kpiW - 3, 18, 2, 2, 'F')
      doc.setTextColor(148, 163, 184); doc.setFontSize(7); doc.setFont('helvetica', 'normal')
      doc.text(k.label.toUpperCase(), x + 4, 51)
      doc.setTextColor(15, 23, 42); doc.setFontSize(13); doc.setFont('helvetica', 'bold')
      doc.text(k.value, x + 4, 59)
    })

    // ── Section: Cell History ─────────────────────────────────────────
    let y = 72
    doc.setFontSize(11); doc.setFont('helvetica', 'bold')
    doc.setTextColor(30, 64, 175)
    doc.text('Cell History', margin, y)
    doc.setDrawColor(226, 232, 240); doc.line(margin, y + 1.5, W - margin, y + 1.5)
    y += 8

    const hist = [
      ['Initial Capacity',  initCap ? `${initCap.toFixed(3)} Ah` : '—'],
      ['Final Capacity',    finalCap ? `${finalCap.toFixed(3)} Ah` : '—'],
      ['Capacity Fade',     capFade != null ? `${capFade}%` : '—'],
      ['Total Energy Out',  totalEnergy != null ? `${totalEnergy} Wh` : '—'],
      ['Max RUL (chem.)',   `${maxRul} cycles`],
    ]
    hist.forEach(([label, value], i) => {
      const x  = i % 2 === 0 ? margin : col2
      const yy = y + Math.floor(i / 2) * 10
      doc.setFontSize(8); doc.setFont('helvetica', 'normal')
      doc.setTextColor(100, 116, 139); doc.text(label, x, yy)
      doc.setTextColor(15, 23, 42);    doc.setFont('helvetica', 'bold')
      doc.text(value, x, yy + 5)
    })
    y += Math.ceil(hist.length / 2) * 10 + 6

    // ── Section: Recommended Action ───────────────────────────────────
    doc.setFontSize(11); doc.setFont('helvetica', 'bold')
    doc.setTextColor(30, 64, 175)
    doc.text('Recommended Action', margin, y)
    doc.setDrawColor(226, 232, 240); doc.line(margin, y + 1.5, W - margin, y + 1.5)
    y += 8
    doc.setFillColor(255, 251, 235)
    doc.roundedRect(margin, y, W - margin * 2, 20, 2, 2, 'F')
    doc.setTextColor(120, 53, 15); doc.setFontSize(9); doc.setFont('helvetica', 'normal')
    const lines = doc.splitTextToSize(phaseMeta.action, W - margin * 2 - 8)
    doc.text(lines, margin + 4, y + 7)
    y += 28

    // ── Model info ────────────────────────────────────────────────────
    doc.setFontSize(7); doc.setFont('helvetica', 'normal')
    doc.setTextColor(148, 163, 184)
    doc.text(
      'MambaRUL v10-final · R²=0.911 · 90% conformal prediction intervals · For informational use only.',
      margin, y
    )

    // ── Footer line ───────────────────────────────────────────────────
    doc.setDrawColor(226, 232, 240)
    doc.line(margin, 285, W - margin, 285)
    doc.setFontSize(7); doc.text('BatteryOS — RUL Intelligence Platform', margin, 289)
    doc.text(`Page 1`, W - margin, 289, { align: 'right' })

    doc.save(`BatteryOS_${cellId}_report_${Date.now()}.pdf`)
  })
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function CellDeepDive() {
  const { cellId }    = useParams<{ cellId: string }>()
  const location      = useLocation()
  const navigate      = useNavigate()
  const navState      = (location.state ?? {}) as NavState

  const [cap,         setCap]         = useState<CapCurve | null>(null)
  const [rul,         setRul]         = useState<RulCurve | null>(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [onlineTrend, setOnlineTrend] = useState<OnlineTrend | null>(null)

  const dataset = navState.dataset ?? 'any'

  useEffect(() => {
    if (!cellId) return
    setLoading(true); setError(null)
    Promise.all([
      fetch(`/api/datasets/${encodeURIComponent(dataset)}/cells/${encodeURIComponent(cellId)}/capacity`).then(r => r.json()),
      fetch(`/api/datasets/${encodeURIComponent(dataset)}/cells/${encodeURIComponent(cellId)}/rul`).then(r => r.json()),
    ])
      .then(([c, r]) => { setCap(c); setRul(r) })
      .catch(() => setError('Failed to load cell data'))
      .finally(() => setLoading(false))

    // Online RUL (best-effort — 404 if no BMS history yet)
    fetch(`/api/rul/trend/${encodeURIComponent(cellId)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setOnlineTrend(d))
      .catch(() => {})
  }, [cellId, dataset])

  // Derived state from nav (instant) or from loaded curve
  const chem      = navState.chemistry ?? cap?.chemistry_name ?? '—'
  const chemColor = CHEM_COLOR[chem] ?? '#6b7280'

  // Use nav state for the "snapshot" SOH/RUL, or fall back to last cycle in curve
  const snapSoh = navState.soh
  const snapRul = navState.rul
  const snapPhase = navState.phase ?? 'Aging'
  const phaseMeta = PHASE_META[snapPhase] ?? PHASE_META.Aging

  // Compute stats from full curve
  const totalCycles  = cap ? cap.cycles[cap.cycles.length - 1] : null
  const initCap      = cap ? cap.capacity[0] : null
  const finalCap     = cap ? cap.capacity[cap.capacity.length - 1] : null
  const finalSoh     = cap ? +(cap.soh[cap.soh.length - 1] * 100).toFixed(1) : null
  const maxRul       = rul ? Math.max(...rul.rul) : navState.max_rul ?? 309
  const totalEnergy  = cap ? +(cap.cum_energy[cap.cum_energy.length - 1]).toFixed(1) : null
  const capFade      = initCap && finalCap ? +((1 - finalCap / initCap) * 100).toFixed(1) : null

  // SOH array as percentage
  const sohPct = cap ? cap.soh.map(v => +(v * 100).toFixed(2)) : []

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">

      {/* Back + header */}
      <div className="flex items-start gap-4">
        <button onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors mt-0.5">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-xl font-bold text-text-primary font-mono">{cellId}</h1>
            <span className="px-2 py-0.5 rounded text-xs font-bold"
              style={{ background: chemColor + '20', color: chemColor }}>{chem}</span>
            <span className="px-2 py-0.5 rounded-full border text-[10px] font-medium"
              style={{
                background: phaseMeta.color + '15',
                borderColor: phaseMeta.color + '40',
                color: phaseMeta.color,
              }}>{snapPhase}</span>
            {navState.alert === 'critical' && (
              <span className="flex items-center gap-1 text-[10px] text-red-400">
                <AlertTriangle size={11} /> Critical — replacement recommended
              </span>
            )}
          </div>
          <p className="text-xs text-text-muted mt-1">
            Dataset: <span className="text-text-secondary">{cap?.dataset ?? dataset}</span>
            {totalCycles && <span> · {totalCycles} cycles measured</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {cap && rul && (
            <button
              onClick={() => downloadCellReport({
                cellId: cellId ?? '', chem, snapPhase, snapSoh, snapRul,
                totalCycles, initCap, finalCap, capFade, totalEnergy, maxRul,
                dataset: cap.dataset, phaseMeta,
              })}
              className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors">
              <FileDown size={12} /> Download Report
            </button>
          )}
          <button
            onClick={() => navigate('/predict')}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-brand-blue text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors">
            <Zap size={12} /> Predict RUL
          </button>
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-20 text-text-muted text-sm gap-3">
          <Activity size={16} className="animate-pulse" /> Loading cell history…
        </div>
      )}

      {error && (
        <div className="flex items-center gap-2 p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-400">
          <AlertTriangle size={14} /> {error}
        </div>
      )}

      {!loading && !error && cap && rul && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="space-y-5">

          {/* KPI strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Current SOH"
              value={snapSoh != null ? `${snapSoh}%` : `${finalSoh}%`}
              sub="state of health" color={phaseMeta.color} />
            <KpiCard label="Remaining RUL"
              value={snapRul != null ? `${snapRul}` : `${rul.rul[rul.rul.length - 1]}`}
              sub="cycles remaining" color={chemColor} />
            <KpiCard label="Total Cycles"
              value={totalCycles ?? '—'}
              sub="measured so far" color="#94a3b8" />
            <KpiCard label="Cap. Fade"
              value={capFade != null ? `${capFade}%` : '—'}
              sub={`${initCap?.toFixed(3)} → ${finalCap?.toFixed(3)} Ah`}
              color="#f59e0b" />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

            {/* RUL trajectory */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Battery size={14} className="text-brand-blue" />
                <span className="text-sm font-semibold text-text-primary">RUL Trajectory</span>
                <span className="text-[10px] text-text-muted ml-auto">remaining useful life per cycle</span>
              </div>
              <Plot
                data={[
                  {
                    x: rul.cycles,
                    y: rul.rul,
                    type: 'scatter',
                    mode: 'lines',
                    name: 'RUL',
                    line: { color: chemColor, width: 2 },
                    fill: 'tozeroy',
                    fillcolor: chemColor + '18',
                  },
                  // Snapshot marker
                  ...(snapRul != null && snapSoh != null ? [{
                    x: [cap.cycles[Math.round((cap.cycles.length - 1) * (snapSoh / 100))] ?? cap.cycles[cap.cycles.length - 1]],
                    y: [snapRul],
                    type: 'scatter' as const,
                    mode: 'markers' as const,
                    name: 'Current',
                    marker: { color: phaseMeta.color, size: 10, symbol: 'circle' },
                  }] : []),
                ]}
                layout={{
                  ...PLOT_LAYOUT_BASE,
                  height: 220,
                  xaxis: { ...PLOT_LAYOUT_BASE.xaxis, title: { text: 'Cycle' } },
                  yaxis: { ...PLOT_LAYOUT_BASE.yaxis, title: { text: 'RUL (cycles)' } },
                }}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%' }}
              />
            </div>

            {/* SOH fade */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Activity size={14} className="text-emerald-400" />
                <span className="text-sm font-semibold text-text-primary">SOH Fade</span>
                <span className="text-[10px] text-text-muted ml-auto">capacity % vs initial</span>
              </div>
              <Plot
                data={[
                  {
                    x: cap.cycles,
                    y: sohPct,
                    type: 'scatter',
                    mode: 'lines',
                    name: 'SOH %',
                    line: { color: '#10b981', width: 2 },
                    fill: 'tozeroy',
                    fillcolor: '#10b98118',
                  },
                  // 80% EOL line
                  {
                    x: [cap.cycles[0], cap.cycles[cap.cycles.length - 1]],
                    y: [80, 80],
                    type: 'scatter',
                    mode: 'lines',
                    name: '80% EOL threshold',
                    line: { color: '#ef4444', width: 1, dash: 'dash' },
                  },
                ]}
                layout={{
                  ...PLOT_LAYOUT_BASE,
                  height: 220,
                  xaxis: { ...PLOT_LAYOUT_BASE.xaxis, title: { text: 'Cycle' } },
                  yaxis: { ...PLOT_LAYOUT_BASE.yaxis, title: { text: 'SOH (%)' }, range: [60, 105] },
                }}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%' }}
              />
            </div>

            {/* Capacity fade (absolute Ah) */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Battery size={14} className="text-amber-400" />
                <span className="text-sm font-semibold text-text-primary">Capacity Curve</span>
                <span className="text-[10px] text-text-muted ml-auto">absolute Ah per cycle</span>
              </div>
              <Plot
                data={[{
                  x: cap.cycles,
                  y: cap.capacity,
                  type: 'scatter',
                  mode: 'lines',
                  name: 'Capacity (Ah)',
                  line: { color: '#f59e0b', width: 2 },
                }]}
                layout={{
                  ...PLOT_LAYOUT_BASE,
                  height: 220,
                  xaxis: { ...PLOT_LAYOUT_BASE.xaxis, title: { text: 'Cycle' } },
                  yaxis: { ...PLOT_LAYOUT_BASE.yaxis, title: { text: 'Capacity (Ah)' } },
                }}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%' }}
              />
            </div>

            {/* Cumulative energy */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div className="flex items-center gap-2 mb-3">
                <Zap size={14} className="text-purple-400" />
                <span className="text-sm font-semibold text-text-primary">Cumulative Energy</span>
                <span className="text-[10px] text-text-muted ml-auto">total Wh throughput</span>
              </div>
              <Plot
                data={[{
                  x: cap.cycles,
                  y: cap.cum_energy,
                  type: 'scatter',
                  mode: 'lines',
                  name: 'Cum. Energy (Wh)',
                  line: { color: '#8b5cf6', width: 2 },
                  fill: 'tozeroy',
                  fillcolor: '#8b5cf618',
                }]}
                layout={{
                  ...PLOT_LAYOUT_BASE,
                  height: 220,
                  xaxis: { ...PLOT_LAYOUT_BASE.xaxis, title: { text: 'Cycle' } },
                  yaxis: { ...PLOT_LAYOUT_BASE.yaxis, title: { text: 'Energy (Wh)' } },
                }}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%' }}
              />
            </div>
          </div>

          {/* Stats + action row */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

            {/* Key stats */}
            <div className="lg:col-span-2 bg-bg-secondary border border-border-subtle rounded-xl p-4">
              <div className="text-sm font-semibold text-text-primary mb-3">Cell Summary</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {[
                  { label: 'Chemistry',      value: chem },
                  { label: 'Dataset',        value: cap.dataset },
                  { label: 'Phase',          value: snapPhase },
                  { label: 'Initial Cap.',   value: initCap ? `${initCap.toFixed(3)} Ah` : '—' },
                  { label: 'Final Cap.',     value: finalCap ? `${finalCap.toFixed(3)} Ah` : '—' },
                  { label: 'Total Energy',   value: totalEnergy ? `${totalEnergy} Wh` : '—' },
                  { label: 'Max RUL',        value: `${maxRul} cycles` },
                  { label: 'Final SOH',      value: finalSoh ? `${finalSoh}%` : '—' },
                  { label: 'Capacity Fade',  value: capFade ? `${capFade}%` : '—' },
                ].map(({ label, value }) => (
                  <div key={label} className="bg-bg-panel rounded-lg p-2.5">
                    <div className="text-[9px] text-text-muted uppercase tracking-wide">{label}</div>
                    <div className="text-xs font-mono text-text-primary mt-0.5">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Recommended action */}
            <div className="space-y-3">
              <div className="rounded-xl border p-4 space-y-2"
                style={{ background: phaseMeta.color + '08', borderColor: phaseMeta.color + '30' }}>
                <div className="flex items-center gap-2 text-xs font-semibold"
                  style={{ color: phaseMeta.color }}>
                  {snapPhase === 'Fresh' || snapPhase === 'Aging'
                    ? <CheckCircle2 size={13} />
                    : <AlertTriangle size={13} />}
                  Recommended Action
                </div>
                <p className="text-xs text-text-secondary leading-relaxed">{phaseMeta.action}</p>
              </div>

              <div className="flex items-start gap-2 p-3 bg-bg-secondary border border-border-subtle rounded-xl text-[10px] text-text-muted">
                <Info size={11} className="text-brand-blue flex-shrink-0 mt-0.5" />
                MambaRUL v10-final · 90% conformal bands calibrated on held-out cells
              </div>

              <button onClick={() => navigate('/predict')}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-xs font-semibold rounded-xl hover:bg-blue-500 transition-colors">
                <Zap size={13} /> Run Live Prediction for this Chemistry
              </button>
            </div>
          </div>

          {/* ── Online RUL: Layer 2 + Layer 3 ──────────────────────────── */}
          {onlineTrend && onlineTrend.history.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

              {/* Trend chart */}
              <div className="lg:col-span-2 bg-bg-secondary border border-border-subtle rounded-xl p-4">
                <div className="flex items-center gap-2 mb-3">
                  <TrendingDown size={14} className="text-brand-blue" />
                  <span className="text-sm font-semibold text-text-primary">
                    Online RUL Trend
                    <span className="ml-2 text-[10px] font-normal text-text-muted">
                      {onlineTrend.n_cycles} persisted BMS cycles
                    </span>
                  </span>
                </div>
                <Plot
                  data={[
                    // CI band
                    {
                      x: [...onlineTrend.history.map(p => p.cycle), ...onlineTrend.history.map(p => p.cycle).reverse()],
                      y: [...onlineTrend.history.map(p => p.rul_upper), ...onlineTrend.history.map(p => p.rul_lower).reverse()],
                      fill: 'toself',
                      fillcolor: 'rgba(59,130,246,0.08)',
                      line: { color: 'transparent' },
                      showlegend: false,
                      hoverinfo: 'skip',
                      type: 'scatter',
                    },
                    // Actual RUL
                    {
                      x: onlineTrend.history.map(p => p.cycle),
                      y: onlineTrend.history.map(p => p.rul),
                      type: 'scatter',
                      mode: 'lines+markers',
                      name: 'Actual RUL',
                      line: { color: chemColor, width: 2 },
                      marker: { size: 4, color: chemColor },
                    },
                    // Trend line
                    ...(onlineTrend.trend ? [{
                      x: onlineTrend.history.map(p => p.cycle),
                      y: onlineTrend.trend.fitted_ruls,
                      type: 'scatter' as const,
                      mode: 'lines' as const,
                      name: `Trend (slope ${onlineTrend.trend.slope.toFixed(2)})`,
                      line: { color: '#f59e0b', width: 1.5, dash: 'dash' as const },
                    }] : []),
                    // Fade alert markers
                    ...(onlineTrend.fade_alerts.length > 0 ? [{
                      x: onlineTrend.fade_alerts.map(a => a.cycle),
                      y: onlineTrend.fade_alerts.map(a => {
                        const pt = onlineTrend.history.find(p => p.cycle === a.cycle)
                        return pt?.rul ?? 0
                      }),
                      type: 'scatter' as const,
                      mode: 'markers' as const,
                      name: 'Fade Alert',
                      marker: { color: '#ef4444', size: 9, symbol: 'circle', line: { color: '#fff', width: 1.5 } },
                    }] : []),
                  ]}
                  layout={{
                    ...PLOT_LAYOUT_BASE,
                    height: 240,
                    xaxis: { ...PLOT_LAYOUT_BASE.xaxis, title: { text: 'Cycle (BMS)' } },
                    yaxis: { ...PLOT_LAYOUT_BASE.yaxis, title: { text: 'RUL (cycles)' } },
                    legend: { ...PLOT_LAYOUT_BASE.legend, orientation: 'h', y: -0.25 },
                  }}
                  config={{ displayModeBar: false, responsive: true }}
                  style={{ width: '100%' }}
                />
              </div>

              {/* CI + alerts sidebar */}
              <div className="space-y-3">

                {/* Layer 3 CI */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                  <div className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-1.5">
                    <Info size={12} className="text-brand-blue" /> Prediction Interval (90%)
                  </div>
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between">
                      <span className="text-text-muted">Per-cell CI (Layer 3)</span>
                      <span className={`font-mono font-semibold ${
                        onlineTrend.layer3_ci.half_width !== null ? 'text-emerald-400' : 'text-text-muted'
                      }`}>
                        {onlineTrend.layer3_ci.half_width !== null
                          ? `±${onlineTrend.layer3_ci.half_width.toFixed(1)} cyc`
                          : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">Global {chem} CI</span>
                      <span className="font-mono text-text-secondary">
                        ±{({ LCO: 34, LFP: 145.3, NMC: 514.3, NCM: 17, NCA: 20 } as Record<string, number>)[chem] ?? 60} cyc
                      </span>
                    </div>
                    <div className="text-[10px] text-text-muted mt-1">{onlineTrend.layer3_ci.source}</div>
                    {onlineTrend.trend && (
                      <div className={`text-[10px] mt-1 ${onlineTrend.trend.slope < -0.5 ? 'text-amber-400' : 'text-text-muted'}`}>
                        Fade slope: {onlineTrend.trend.slope.toFixed(3)} cycles/cycle
                      </div>
                    )}
                  </div>
                </div>

                {/* Layer 2 fade alerts */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                  <div className="text-xs font-semibold text-text-primary mb-3 flex items-center gap-1.5">
                    <ShieldAlert size={12} className="text-red-400" /> Fade Acceleration (Layer 2)
                  </div>
                  {onlineTrend.fade_alerts.length === 0 ? (
                    <div className="text-[10px] text-emerald-400 flex items-center gap-1.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      No acceleration events
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {onlineTrend.fade_alerts.slice(0, 4).map((a, i) => (
                        <div key={i} className={`rounded-lg p-2 text-[10px] border ${
                          a.severity === 'critical'
                            ? 'bg-red-500/10 border-red-500/20 text-red-300'
                            : 'bg-amber-400/10 border-amber-400/20 text-amber-300'
                        }`}>
                          <div className="flex justify-between mb-0.5">
                            <span className="font-semibold uppercase text-[9px]">{a.severity}</span>
                            <span className="font-mono text-text-muted">cyc {a.cycle}</span>
                          </div>
                          <div className="text-text-muted text-[9px]">
                            {a.deviation_sigma.toFixed(1)}× historical rate
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-xs text-text-muted">
              <TrendingDown size={13} className="text-text-muted" />
              Online RUL history not yet available for this cell — builds automatically via live BMS telemetry (Layer 2 + Layer 3).
            </div>
          )}

        </motion.div>
      )}
    </div>
  )
}

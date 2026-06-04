import { useState, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  Battery, AlertTriangle, TrendingDown, Thermometer,
  RefreshCw, Plus, Trash2, Download, ChevronRight,
  CheckCircle, XCircle, Flame, Activity, Zap, Info,
  BarChart3, Shield, Upload, FileText
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CellInput {
  cell_id: string
  soh: number
  rul: number
  capacity_ah: number
  ir: number
  chemistry: string
  fade_rate: number
  n_cycles: number | null
  dod_pct: number | null
  temperature: number | null
}

interface ExtractedFeatures {
  measured_capacity_ah: number
  soh: number
  n_cycles_detected: number
  ir_proxy: number
  temperature: number
  fade_rate: number
  completeness: number
  data_quality: string
  warnings: string[]
}

interface MLPrediction {
  cell_id: string
  predicted_rul: number
  lower_bound: number
  upper_bound: number
  health_score: number
  phase: string
  model_id: string
  mode: string
  rul_std: number | null
  soh_predicted: number | null
  history_source?: string
  n_observed_cycles?: number
}

interface PerCell {
  cell_id: string
  soh_pct: number
  delta_from_mean: number
  rul: number
  ir: number
  impact: string
  rul_source: string
  rul_lower: number | null
  rul_upper: number | null
  rul_std: number | null
  soh_predicted: number | null
  model_id: string | null
  mode: string | null
}

interface AnalysisResult {
  summary: {
    pack_health_score: number
    pack_health_grade: string
    pack_rul_cycles: number
    n_weak_cells: number
    cascade_risk_level: string
    thermal_risk_level: string
    top_replacement_cell: string | null
    cycles_extended_by_swap: number | null
    eol_no_change_cycle: number | null
    eol_with_swap_cycle: number | null
    rul_source: string
    model_used: string | null
  }
  ml_predictions: MLPrediction[]
  replacement: Array<{
    cell_id: string
    current_soh_pct: number
    pack_soh_before_pct: number
    pack_soh_after_pct: number
    soh_recovery_pct: number
    cycles_gained: number
    value_score: number
    recommended: boolean
  }>
  timeline: Array<{
    cycle: number
    pack_soh_no_change: number
    pack_soh_replace_weakest: number
    bottleneck_cell: string
    eol_no_change: boolean
    eol_replace_weakest: boolean
  }>
  thermal: {
    hot_cells: Array<{ cell_id: string; ir_ohm: number; ir_ratio: number; excess_heat_W: number; risk: string }>
    adjacency_effects: Array<{ cell_id: string; heat_received_W: number; heat_sources: string[]; fade_accel_factor: number; at_risk: boolean }>
    overall_thermal_risk: number
    thermal_risk_level: string
    n_hot_cells: number
  }
  per_cell: PerCell[]
  cascade: { cascade_risk: number; level: string; recommendations: string[] }
  first_failure: { first_failure_cell: string; first_failure_soh_pct: number; cycles_to_eol: number; warning_cells: Array<{ cell_id: string; cycles_to_eol: number; soh_pct: number }>; already_at_eol?: boolean }
  health: { score: number; grade: string; mean_soh_pct: number; min_soh_pct: number; n_weak: number; weak_cell_ids: string[] }
  pack_rul: { pack_rul: number; method: string; min_rul_cell: string; rul_spread: number }
  auto_predict: boolean
  n_cells: number
  feature_extraction?: Record<string, ExtractedFeatures>
  csv_warnings?: string[]
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CHEMISTRIES = ['NMC', 'LFP', 'NCA', 'LCO', 'LMO']

const DEFAULT_CELLS: CellInput[] = [
  { cell_id: 'cell_01', soh: 0.91, rul: 0, capacity_ah: 5.0, ir: 0.032, chemistry: 'NMC', fade_rate: 0.00015, n_cycles: 200, dod_pct: 80, temperature: 25 },
  { cell_id: 'cell_02', soh: 0.88, rul: 0, capacity_ah: 5.0, ir: 0.038, chemistry: 'NMC', fade_rate: 0.00018, n_cycles: 230, dod_pct: 80, temperature: 25 },
  { cell_id: 'cell_03', soh: 0.74, rul: 0, capacity_ah: 5.0, ir: 0.061, chemistry: 'NMC', fade_rate: 0.00042, n_cycles: 380, dod_pct: 85, temperature: 28 },
  { cell_id: 'cell_04', soh: 0.93, rul: 0, capacity_ah: 5.0, ir: 0.029, chemistry: 'NMC', fade_rate: 0.00012, n_cycles: 150, dod_pct: 75, temperature: 24 },
  { cell_id: 'cell_05', soh: 0.85, rul: 0, capacity_ah: 5.0, ir: 0.044, chemistry: 'NMC', fade_rate: 0.00022, n_cycles: 260, dod_pct: 80, temperature: 26 },
]

const GRADE_COLOR: Record<string, string> = { A: 'text-emerald-400', B: 'text-blue-400', C: 'text-amber-400', D: 'text-red-400' }
const RISK_COLOR:  Record<string, string> = { low: 'text-emerald-400', moderate: 'text-amber-400', high: 'text-orange-400', critical: 'text-red-400' }
const RISK_BG:     Record<string, string> = {
  low:      'bg-emerald-500/10 border-emerald-500/20',
  moderate: 'bg-amber-500/10 border-amber-500/20',
  high:     'bg-orange-500/10 border-orange-500/20',
  critical: 'bg-red-500/10 border-red-500/20',
}
const SOH_COLOR = (s: number) => s >= 90 ? '#34d399' : s >= 80 ? '#60a5fa' : s >= 70 ? '#f59e0b' : '#ef4444'

// ── SVG Timeline chart ────────────────────────────────────────────────────────

function TimelineChart({ data, eolSoh }: {
  data: AnalysisResult['timeline']
  eolSoh: number
}) {
  if (!data.length) return null

  const W = 560; const H = 170
  const PAD = { l: 44, r: 14, t: 12, b: 32 }

  const allSOH = data.flatMap(d => [d.pack_soh_no_change, d.pack_soh_replace_weakest]).filter(v => v > 0)
  const minSOH = Math.max(0, Math.floor(Math.min(...allSOH, eolSoh * 100) / 5) * 5 - 5)
  const maxSOH = Math.min(102, Math.ceil(Math.max(...allSOH) / 5) * 5 + 2)
  const maxCycle = data[data.length - 1].cycle

  const cx = (c: number) => PAD.l + (c / maxCycle) * (W - PAD.l - PAD.r)
  const cy = (s: number) => PAD.t + (1 - (s - minSOH) / (maxSOH - minSOH)) * (H - PAD.t - PAD.b)

  const pathNo  = data.filter(d => d.pack_soh_no_change > 0)
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${cx(d.cycle).toFixed(1)},${cy(d.pack_soh_no_change).toFixed(1)}`).join(' ')
  const pathRep = data.filter(d => d.pack_soh_replace_weakest > 0)
    .map((d, i) => `${i === 0 ? 'M' : 'L'}${cx(d.cycle).toFixed(1)},${cy(d.pack_soh_replace_weakest).toFixed(1)}`).join(' ')

  const eolY = cy(eolSoh * 100)
  const yTicks: number[] = []
  for (let y = Math.ceil(minSOH / 5) * 5; y <= maxSOH; y += 5) yTicks.push(y)

  const xStep = Math.ceil(maxCycle / 5 / 25) * 25
  const xTicks: number[] = []
  for (let x = 0; x <= maxCycle; x += xStep) xTicks.push(x)

  const eolNoCh = data.find(d => d.eol_no_change)
  const eolRepl = data.find(d => d.eol_replace_weakest)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-44 select-none">
      {yTicks.map(y => (
        <g key={y}>
          <line x1={PAD.l} x2={W - PAD.r} y1={cy(y)} y2={cy(y)} stroke="#ffffff0a" strokeWidth="1" />
          <text x={PAD.l - 4} y={cy(y)} textAnchor="end" fill="#6b7280" fontSize="9" dominantBaseline="middle">{y}%</text>
        </g>
      ))}
      {xTicks.map(x => (
        <g key={x}>
          <line x1={cx(x)} x2={cx(x)} y1={PAD.t} y2={H - PAD.b} stroke="#ffffff06" strokeWidth="1" />
          <text x={cx(x)} y={H - PAD.b + 10} textAnchor="middle" fill="#6b7280" fontSize="9">{x}</text>
        </g>
      ))}
      <line x1={PAD.l} x2={W - PAD.r} y1={eolY} y2={eolY} stroke="#ef4444" strokeWidth="1" strokeDasharray="5,3" />
      <text x={W - PAD.r - 2} y={eolY - 4} textAnchor="end" fill="#ef4444" fontSize="8">EOL {(eolSoh * 100).toFixed(0)}%</text>
      {eolNoCh && (
        <line x1={cx(eolNoCh.cycle)} x2={cx(eolNoCh.cycle)} y1={PAD.t} y2={H - PAD.b}
          stroke="#f59e0b" strokeWidth="1" strokeDasharray="3,2" opacity="0.6" />
      )}
      {eolRepl && (
        <line x1={cx(eolRepl.cycle)} x2={cx(eolRepl.cycle)} y1={PAD.t} y2={H - PAD.b}
          stroke="#3b82f6" strokeWidth="1" strokeDasharray="3,2" opacity="0.6" />
      )}
      <path d={pathNo}  fill="none" stroke="#f59e0b" strokeWidth="2.5" />
      <path d={pathRep} fill="none" stroke="#3b82f6" strokeWidth="2"   strokeDasharray="7,4" />
      <text x={(PAD.l + W - PAD.r) / 2} y={H - 2} textAnchor="middle" fill="#4b5563" fontSize="8">cycle</text>
    </svg>
  )
}

// ── ML Predictions panel ──────────────────────────────────────────────────────

function MLPredictionsPanel({ preds }: { preds: MLPrediction[] }) {
  const maxRUL = Math.max(...preds.map(p => p.upper_bound))
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold text-text-secondary">
        <Zap size={12} className="text-brand-blue" />
        BiMamba-APF v12 — per-cell RUL predictions
      </div>
      {preds.map(p => {
        const barW = Math.min(100, (p.predicted_rul / maxRUL) * 100)
        const ciLo  = Math.max(0, ((p.lower_bound  / maxRUL) * 100))
        const ciHi  = Math.min(100, ((p.upper_bound / maxRUL) * 100))
        return (
          <div key={p.cell_id} className="flex items-center gap-3">
            <span className="font-mono text-[10px] text-text-muted w-16 flex-shrink-0">{p.cell_id}</span>
            <div className="relative flex-1 h-4 bg-bg-panel rounded-full overflow-hidden">
              <div className="absolute h-full bg-brand-blue/10 rounded-full"
                style={{ left: `${ciLo}%`, width: `${ciHi - ciLo}%` }} />
              <div className="absolute h-full bg-brand-blue/50 rounded-full transition-all"
                style={{ width: `${barW}%` }} />
            </div>
            <span className="w-16 text-right text-xs font-semibold text-brand-blue">{p.predicted_rul.toFixed(0)}</span>
            <span className="text-[9px] text-text-muted w-24 text-right">
              [{p.lower_bound.toFixed(0)}–{p.upper_bound.toFixed(0)}]
            </span>
            <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${p.mode === 'pytorch' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
              {p.mode === 'pytorch' ? '⚡ v12' : 'analytical'}
            </span>
            <span title={p.history_source === 'measured'
                ? `Model saw ${p.n_observed_cycles} real measured cycles`
                : 'Window synthesized from a single snapshot — model cannot see the true degradation trajectory'}
              className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${p.history_source === 'measured' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
              {p.history_source === 'measured' ? `measured ${p.n_observed_cycles}c` : 'synth window'}
            </span>
            <span className={`text-[9px] ${p.phase === 'Near-EOL' ? 'text-red-400' : p.phase === 'Knee' ? 'text-amber-400' : 'text-text-muted'}`}>
              {p.phase}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Cell grid ─────────────────────────────────────────────────────────────────

function CellGrid({ perCell, hotCells, adjEffects }: {
  perCell: PerCell[]
  hotCells: AnalysisResult['thermal']['hot_cells']
  adjEffects: AnalysisResult['thermal']['adjacency_effects']
}) {
  const hotIds  = new Set(hotCells.map(h => h.cell_id))
  const riskIds = new Set(adjEffects.filter(a => a.at_risk).map(a => a.cell_id))

  return (
    <div className="flex flex-wrap gap-2">
      {perCell.map(c => {
        const isHot  = hotIds.has(c.cell_id)
        const isRisk = riskIds.has(c.cell_id)
        const bg = c.impact === 'bottleneck' ? 'bg-red-500/20 border-red-500/40'
                 : c.impact === 'weak'       ? 'bg-amber-500/15 border-amber-500/30'
                 : 'bg-bg-panel border-border-subtle'
        const isML = c.rul_source === 'ml'

        return (
          <div key={c.cell_id} className={`relative rounded-lg border px-3 py-2 w-32 ${bg}`}>
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-[10px] font-mono text-text-muted truncate">{c.cell_id}</span>
              <div className="flex gap-1">
                {isHot  && <Flame       size={9} className="text-orange-400" />}
                {isRisk && <Thermometer size={9} className="text-amber-400" />}
              </div>
            </div>
            <div className="text-lg font-bold" style={{ color: SOH_COLOR(c.soh_pct) }}>{c.soh_pct}%</div>
            <div className="text-[9px] text-text-muted">SOH</div>
            <div className="mt-1.5 space-y-0.5">
              <div className="flex justify-between text-[9px]">
                <span className="text-text-muted">RUL</span>
                <span className="text-brand-blue font-semibold">{c.rul}</span>
              </div>
              {c.rul_lower != null && c.rul_upper != null && (
                <div className="text-[8px] text-text-muted text-right">[{c.rul_lower.toFixed(0)}–{c.rul_upper.toFixed(0)}]</div>
              )}
              <div className="flex justify-between text-[9px]">
                <span className="text-text-muted">IR</span>
                <span className="text-text-secondary">{c.ir.toFixed(3)}Ω</span>
              </div>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              {c.impact !== 'normal' ? (
                <span className={`text-[8px] font-semibold uppercase ${c.impact === 'bottleneck' ? 'text-red-400' : 'text-amber-400'}`}>
                  {c.impact}
                </span>
              ) : <span />}
              <span className={`text-[8px] px-1 py-0.5 rounded ${isML ? 'bg-brand-blue/15 text-brand-blue' : 'bg-bg-secondary text-text-muted'}`}>
                {isML ? '⚡ ML' : 'manual'}
              </span>
            </div>
            {c.rul_upper != null && c.rul_upper > 0 && (
              <div className="mt-1.5 h-1 bg-bg-secondary rounded-full overflow-hidden">
                <div className="h-full bg-brand-blue/40 rounded-full"
                  style={{ width: `${Math.min(100, (c.rul / (c.rul_upper * 1.1)) * 100)}%` }} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function WeakCellAnalysis() {
  const [cells, setCells]         = useState<CellInput[]>(DEFAULT_CELLS)
  const [topology, setTopology]   = useState<'series' | 'parallel'>('series')
  const [nCycles, setNCycles]     = useState(500)
  const [eolSoh, setEolSoh]       = useState(0.80)
  const [autoPredict, setAuto]    = useState(true)
  const [loading, setLoading]     = useState(false)
  const [result, setResult]       = useState<AnalysisResult | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'cells' | 'timeline' | 'thermal' | 'replacement'>('cells')

  // CSV mode state
  const [inputMode, setInputMode]         = useState<'manual' | 'csv'>('manual')
  const [csvFile, setCsvFile]             = useState<File | null>(null)
  const [nomCapAh, setNomCapAh]           = useState(5.0)
  const [csvChemistry, setCsvChemistry]   = useState('NMC')
  const [featureExtraction, setFeatEx]    = useState<Record<string, ExtractedFeatures> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function addCell() {
    const idx = cells.length
    setCells(prev => [...prev, {
      cell_id: `cell_${String(idx + 1).padStart(2, '0')}`,
      soh: 0.90, rul: 0, capacity_ah: 5.0, ir: 0.035, chemistry: 'NMC',
      fade_rate: 0.0002, n_cycles: 200, dod_pct: 80, temperature: 25,
    }])
  }

  function removeCell(i: number) {
    setCells(prev => prev.filter((_, idx) => idx !== i))
  }

  function updateCell(i: number, field: keyof CellInput, raw: string) {
    const numFields = ['soh','rul','capacity_ah','ir','fade_rate','n_cycles','dod_pct','temperature'] as const
    const isNum = numFields.includes(field as typeof numFields[number])
    const value = isNum ? (raw === '' ? null : parseFloat(raw)) : raw
    setCells(prev => prev.map((c, idx) => idx === i ? { ...c, [field]: value } : c))
  }

  async function runAnalysis() {
    if (cells.length < 2) { setError('Need at least 2 cells.'); return }
    setLoading(true); setError(null); setResult(null); setFeatEx(null)
    try {
      const payload = {
        cells: cells.map(c => ({
          ...c,
          n_cycles:    c.n_cycles    ?? undefined,
          dod_pct:     c.dod_pct     ?? undefined,
          temperature: c.temperature ?? undefined,
        })),
        topology,
        n_cycles: nCycles,
        timeline_step: 25,
        eol_soh: eolSoh,
        auto_predict: autoPredict,
        model_id: 'v12-bimamba',
      }
      const res = await fetch('/api/pack/weak-cell/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || 'Analysis failed')
      }
      setResult(await res.json())
      setActiveTab('cells')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  async function runCsvAnalysis() {
    if (!csvFile) { setError('Select a CSV file first.'); return }
    setLoading(true); setError(null); setResult(null); setFeatEx(null)
    try {
      const form = new FormData()
      form.append('file',            csvFile)
      form.append('nom_capacity_ah', String(nomCapAh))
      form.append('chemistry',       csvChemistry)
      form.append('topology',        topology)
      form.append('n_cycles_proj',   String(nCycles))
      form.append('eol_soh',         String(eolSoh))
      form.append('model_id',        'v12-bimamba')
      const res = await fetch('/api/pack/weak-cell/analyze-from-csv', {
        method: 'POST',
        body: form,
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        throw new Error(err.detail || 'CSV analysis failed')
      }
      const data: AnalysisResult = await res.json()
      setResult(data)
      setFeatEx(data.feature_extraction ?? null)
      setActiveTab('cells')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  function exportJSON() {
    if (!result) return
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a'); a.href = url; a.download = 'weak_cell_analysis.json'; a.click()
    URL.revokeObjectURL(url)
  }

  const s = result?.summary

  return (
    <div className="p-3 sm:p-6 space-y-5 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <Battery size={18} className="text-brand-blue" />
            Weak-Cell Propagation Analysis
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            AI-predicted RUL per cell · EOL timeline · Replacement ROI · Thermal stress propagation
          </p>
        </div>
        {result && (
          <button onClick={exportJSON}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-panel border border-border-subtle text-xs text-text-secondary hover:text-text-primary transition-colors">
            <Download size={12} /> Export JSON
          </button>
        )}
      </div>

      {/* Config panel */}
      <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-4">

        {/* Global options row */}
        <div className="flex flex-wrap items-center gap-4">
          {/* Input mode toggle */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Input</span>
            <button onClick={() => setInputMode('manual')}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${inputMode === 'manual' ? 'bg-brand-blue/15 text-brand-blue border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle hover:text-text-primary'}`}>
              Manual Entry
            </button>
            <button onClick={() => setInputMode('csv')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${inputMode === 'csv' ? 'bg-brand-blue/15 text-brand-blue border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle hover:text-text-primary'}`}>
              <Upload size={10} /> Raw CSV
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Topology</span>
            {(['series', 'parallel'] as const).map(t => (
              <button key={t} onClick={() => setTopology(t)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all ${topology === t ? 'bg-brand-blue/15 text-brand-blue border border-brand-blue/25' : 'bg-bg-panel text-text-secondary hover:text-text-primary border border-border-subtle'}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Cycles</span>
            <input type="number" value={nCycles} min={100} max={3000} step={100}
              onChange={e => setNCycles(+e.target.value)}
              className="w-20 px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">EOL SOH</span>
            <input type="number" value={eolSoh} min={0.6} max={0.9} step={0.01}
              onChange={e => setEolSoh(+e.target.value)}
              className="w-20 px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
          </div>

          {/* RUL source toggle — only for manual mode */}
          {inputMode === 'manual' && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-text-muted">RUL source</span>
              <button onClick={() => setAuto(true)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${autoPredict ? 'bg-brand-blue/15 text-brand-blue border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle hover:text-text-primary'}`}>
                <Zap size={10} /> v12 AI
              </button>
              <button onClick={() => setAuto(false)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${!autoPredict ? 'bg-bg-panel text-text-primary border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle hover:text-text-primary'}`}>
                Manual
              </button>
            </div>
          )}
        </div>

        {/* ── Manual Entry mode ─────────────────────────────────── */}
        {inputMode === 'manual' && (
          <>
            {autoPredict && (
              <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-brand-blue/5 border border-brand-blue/15 text-xs text-text-muted">
                <Info size={11} className="text-brand-blue mt-0.5 flex-shrink-0" />
                <span>
                  <span className="text-brand-blue font-medium">AI mode</span> — enter SOH, IR, n_cycles, and chemistry.
                  BiMamba-APF v12 will predict RUL for each cell. The <span className="text-text-secondary">RUL column is ignored</span> when AI mode is on.
                </span>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted border-b border-border-subtle">
                    <th className="text-left pb-1.5 pr-2 w-20">Cell ID</th>
                    <th className="text-left pb-1.5 pr-2">SOH (0–1)</th>
                    <th className="text-left pb-1.5 pr-2">Cycles</th>
                    <th className="text-left pb-1.5 pr-2">IR (Ω)</th>
                    <th className="text-left pb-1.5 pr-2">Chem</th>
                    <th className="text-left pb-1.5 pr-2">Ah</th>
                    <th className="text-left pb-1.5 pr-2">DoD%</th>
                    <th className="text-left pb-1.5 pr-2">°C</th>
                    <th className="text-left pb-1.5 pr-2">Fade/cyc</th>
                    {!autoPredict && <th className="text-left pb-1.5 pr-2">RUL</th>}
                    <th className="pb-1.5 w-6"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle/40">
                  {cells.map((c, i) => (
                    <tr key={i}>
                      <td className="py-1 pr-2">
                        <input value={c.cell_id} onChange={e => updateCell(i, 'cell_id', e.target.value)}
                          className="w-full px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary focus:outline-none focus:border-brand-blue/50 text-[10px]" />
                      </td>
                      {[
                        { f: 'soh',      step: '0.01', min: '0', max: '1', w: 'w-14' },
                        { f: 'n_cycles', step: '10',   min: '0', max: '',  w: 'w-14' },
                        { f: 'ir',       step: '0.001',min: '0', max: '',  w: 'w-14' },
                      ].map(({ f, step, min, max, w }) => (
                        <td key={f} className="py-1 pr-2">
                          <input type="number" value={(c as unknown as Record<string, number>)[f] ?? ''}
                            step={step} min={min} max={max || undefined}
                            onChange={e => updateCell(i, f as keyof CellInput, e.target.value)}
                            className={`${w} px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary focus:outline-none focus:border-brand-blue/50 text-[10px]`} />
                        </td>
                      ))}
                      <td className="py-1 pr-2">
                        <select value={c.chemistry} onChange={e => updateCell(i, 'chemistry', e.target.value)}
                          className="px-1.5 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary text-[10px] focus:outline-none">
                          {CHEMISTRIES.map(ch => <option key={ch}>{ch}</option>)}
                        </select>
                      </td>
                      {[
                        { f: 'capacity_ah', step: '0.1',    w: 'w-12' },
                        { f: 'dod_pct',     step: '5',      w: 'w-12' },
                        { f: 'temperature', step: '1',      w: 'w-12' },
                        { f: 'fade_rate',   step: '0.00001',w: 'w-20' },
                      ].map(({ f, step, w }) => (
                        <td key={f} className="py-1 pr-2">
                          <input type="number" value={(c as unknown as Record<string, number>)[f] ?? ''}
                            step={step} min="0"
                            onChange={e => updateCell(i, f as keyof CellInput, e.target.value)}
                            className={`${w} px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary focus:outline-none focus:border-brand-blue/50 text-[10px]`} />
                        </td>
                      ))}
                      {!autoPredict && (
                        <td className="py-1 pr-2">
                          <input type="number" value={c.rul} step="10" min="0"
                            onChange={e => updateCell(i, 'rul', e.target.value)}
                            className="w-16 px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary focus:outline-none focus:border-brand-blue/50 text-[10px]" />
                        </td>
                      )}
                      <td className="py-1">
                        <button onClick={() => removeCell(i)} className="p-1 text-text-muted hover:text-red-400 transition-colors">
                          <Trash2 size={11} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3">
              <button onClick={addCell}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-panel border border-border-subtle text-xs text-text-secondary hover:text-text-primary transition-colors">
                <Plus size={12} /> Add Cell
              </button>
              <button onClick={runAnalysis} disabled={loading}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-blue-500 transition-colors disabled:opacity-50">
                {loading ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
                {loading ? 'Analyzing…' : autoPredict ? 'Predict RUL + Analyze' : 'Run Pack Analysis'}
              </button>
              {autoPredict && !loading && (
                <span className="text-[10px] text-text-muted flex items-center gap-1">
                  <Zap size={9} className="text-brand-blue" /> Uses BiMamba-APF v12
                </span>
              )}
            </div>
          </>
        )}

        {/* ── Raw CSV mode ──────────────────────────────────────── */}
        {inputMode === 'csv' && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-brand-blue/5 border border-brand-blue/15 text-xs text-text-muted">
              <Info size={11} className="text-brand-blue mt-0.5 flex-shrink-0" />
              <span>
                Upload raw BMS CSV with <span className="text-text-secondary font-medium">time, voltage, current</span> columns
                (temperature optional). Enter the <span className="text-text-secondary font-medium">nominal capacity</span> from
                the battery spec sheet — the system Coulomb-counts each discharge cycle to compute measured capacity, SOH, and IR proxy,
                then runs BiMamba-APF v12. Add a <span className="text-text-secondary font-medium">cell_id</span> column for multi-cell packs.
              </span>
            </div>

            {/* Nominal capacity + chemistry */}
            <div className="flex flex-wrap gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-text-muted">Nominal Capacity (Ah) — from spec sheet</label>
                <input type="number" value={nomCapAh} min={0.1} max={1000} step={0.1}
                  onChange={e => setNomCapAh(+e.target.value)}
                  className="w-28 px-2 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] text-text-muted">Chemistry (all cells)</label>
                <select value={csvChemistry} onChange={e => setCsvChemistry(e.target.value)}
                  className="px-2 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50">
                  {CHEMISTRIES.map(ch => <option key={ch}>{ch}</option>)}
                </select>
              </div>
            </div>

            {/* CSV dropzone */}
            <div
              className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
                csvFile
                  ? 'border-brand-blue/40 bg-brand-blue/5'
                  : 'border-border-subtle hover:border-brand-blue/40 hover:bg-brand-blue/3'
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={e => e.preventDefault()}
              onDrop={e => {
                e.preventDefault()
                const f = e.dataTransfer.files[0]
                if (f) setCsvFile(f)
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.txt"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) setCsvFile(f) }}
              />
              {csvFile ? (
                <div className="flex items-center justify-center gap-2 text-xs text-brand-blue">
                  <FileText size={14} />
                  <span className="font-medium">{csvFile.name}</span>
                  <span className="text-text-muted">({(csvFile.size / 1024).toFixed(1)} KB)</span>
                  <button
                    onClick={e => { e.stopPropagation(); setCsvFile(null) }}
                    className="ml-2 text-text-muted hover:text-red-400 transition-colors">
                    <XCircle size={12} />
                  </button>
                </div>
              ) : (
                <div className="text-xs text-text-muted space-y-1">
                  <Upload size={20} className="mx-auto opacity-30" />
                  <div>Drop CSV or click to browse</div>
                  <div className="text-[10px] opacity-60">Columns: time, voltage, current · optional: temperature, cell_id</div>
                </div>
              )}
            </div>

            <button onClick={runCsvAnalysis} disabled={loading || !csvFile}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-blue-500 transition-colors disabled:opacity-50">
              {loading ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
              {loading ? 'Processing CSV…' : 'Extract Features + Analyze Pack'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <XCircle size={13} /> {error}
        </div>
      )}

      {/* Results */}
      {result && s && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">

          {/* Feature extraction summary (CSV mode only) */}
          {featureExtraction && (
            <div className="bg-bg-secondary border border-brand-blue/15 rounded-xl p-4">
              <div className="flex items-center gap-2 text-xs font-semibold text-text-secondary mb-3">
                <FileText size={12} className="text-brand-blue" />
                Extracted from CSV — Coulomb counting results
                {result.csv_warnings && result.csv_warnings.length > 0 && (
                  <span className="ml-auto flex items-center gap-1 text-amber-400 font-normal text-[10px]">
                    <AlertTriangle size={9} />
                    {result.csv_warnings.length} warning{result.csv_warnings.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-text-muted border-b border-border-subtle">
                      <th className="text-left pb-1.5 pr-3">Cell</th>
                      <th className="text-right pb-1.5 pr-3">SOH</th>
                      <th className="text-right pb-1.5 pr-3">Capacity (Ah)</th>
                      <th className="text-right pb-1.5 pr-3">Cycles detected</th>
                      <th className="text-right pb-1.5 pr-3">IR proxy (Ω)</th>
                      <th className="text-right pb-1.5 pr-3">Temp (°C)</th>
                      <th className="text-right pb-1.5 pr-3">Completeness</th>
                      <th className="text-right pb-1.5">Quality</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle/40">
                    {Object.entries(featureExtraction).map(([cid, f]) => (
                      <tr key={cid}>
                        <td className="py-1.5 pr-3 font-mono text-text-primary">{cid}</td>
                        <td className="py-1.5 pr-3 text-right font-semibold" style={{ color: SOH_COLOR(f.soh * 100) }}>
                          {(f.soh * 100).toFixed(1)}%
                        </td>
                        <td className="py-1.5 pr-3 text-right text-text-secondary">{f.measured_capacity_ah.toFixed(3)}</td>
                        <td className="py-1.5 pr-3 text-right text-text-secondary">{f.n_cycles_detected}</td>
                        <td className="py-1.5 pr-3 text-right text-text-secondary">{f.ir_proxy.toFixed(4)}</td>
                        <td className="py-1.5 pr-3 text-right text-text-secondary">{f.temperature.toFixed(1)}</td>
                        <td className="py-1.5 pr-3 text-right text-text-muted">{(f.completeness * 100).toFixed(0)}%</td>
                        <td className={`py-1.5 text-right font-medium ${
                          f.data_quality === 'high' ? 'text-emerald-400' :
                          f.data_quality === 'medium' ? 'text-amber-400' : 'text-red-400'
                        }`}>{f.data_quality}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {result.csv_warnings && result.csv_warnings.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {result.csv_warnings.map((w, i) => (
                    <div key={i} className="text-[9px] text-amber-400/70 flex items-start gap-1">
                      <AlertTriangle size={8} className="mt-0.5 flex-shrink-0" /> {w}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ML prediction results */}
          {result.auto_predict && result.ml_predictions.length > 0 && (
            <div className="bg-bg-secondary border border-brand-blue/20 rounded-xl p-4">
              <MLPredictionsPanel preds={result.ml_predictions} />
              <div className="mt-2 text-[10px] text-text-muted flex items-center gap-1.5">
                <Info size={9} />
                <span className="text-emerald-400 font-medium">⚡ pytorch</span> = BiMamba-APF v12 real inference &nbsp;·&nbsp;
                <span className="text-amber-400 font-medium">analytical</span> = physics fallback (model not loaded)
              </div>
            </div>
          )}

          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: 'Pack Health',  value: `${s.pack_health_score}`,  sub: `Grade ${s.pack_health_grade}`,                                              color: GRADE_COLOR[s.pack_health_grade] || 'text-text-primary' },
              { label: 'Pack RUL',     value: `${s.pack_rul_cycles}`,    sub: `cycles · ${result.pack_rul.method}`,                                        color: 'text-brand-blue' },
              { label: 'Cascade Risk', value: s.cascade_risk_level,      sub: `${result.cascade.recommendations.length} actions`,                          color: RISK_COLOR[s.cascade_risk_level] || 'text-text-muted' },
              { label: 'Thermal Risk', value: s.thermal_risk_level,      sub: `${result.thermal.n_hot_cells} hot cell${result.thermal.n_hot_cells !== 1 ? 's' : ''}`, color: RISK_COLOR[s.thermal_risk_level] || 'text-text-muted' },
            ].map(kpi => (
              <div key={kpi.label} className="bg-bg-secondary border border-border-subtle rounded-xl p-3">
                <div className="text-[10px] text-text-muted">{kpi.label}</div>
                <div className={`text-xl font-bold mt-0.5 capitalize ${kpi.color}`}>{kpi.value}</div>
                <div className="text-[10px] text-text-muted">{kpi.sub}</div>
              </div>
            ))}
          </div>

          {/* RUL source badge */}
          <div className="flex items-center gap-2 text-[10px] text-text-muted">
            {s.rul_source === 'ml' ? (
              <>
                <Zap size={10} className="text-brand-blue" />
                RUL predicted by <span className="text-brand-blue font-medium ml-0.5">{s.model_used}</span>
                {featureExtraction && <span className="ml-1 text-brand-blue/60">· SOH from Coulomb counting</span>}
              </>
            ) : (
              <><Info size={10} /> RUL values entered manually</>
            )}
          </div>

          {/* EOL extension banner */}
          {s.cycles_extended_by_swap !== null && s.cycles_extended_by_swap > 0 && (
            <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
              <CheckCircle size={15} className="text-emerald-400 flex-shrink-0" />
              <div className="text-xs">
                <span className="font-semibold text-emerald-300">
                  Replacing <span className="font-mono">{s.top_replacement_cell}</span> extends pack life by ~{s.cycles_extended_by_swap} cycles
                </span>
                {s.eol_no_change_cycle !== null && (
                  <span className="text-text-muted ml-1.5">
                    (EOL at cycle {s.eol_no_change_cycle} → {s.eol_with_swap_cycle != null ? s.eol_with_swap_cycle : `>${nCycles}`})
                  </span>
                )}
              </div>
            </div>
          )}

          {/* First failure already at EOL notice */}
          {result.first_failure.already_at_eol && (
            <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-300">
              <AlertTriangle size={13} className="flex-shrink-0" />
              <span>
                <span className="font-mono font-semibold">{result.first_failure.first_failure_cell}</span> is
                already at or below EOL threshold (SOH {result.first_failure.first_failure_soh_pct}% &lt; {(eolSoh * 100).toFixed(0)}%).
                Immediate replacement recommended.
              </span>
            </div>
          )}

          {/* Recommendations */}
          {result.cascade.recommendations.length > 0 && (
            <div className={`rounded-xl border px-4 py-3 space-y-1 ${RISK_BG[result.cascade.level]}`}>
              <div className="flex items-center gap-1.5 text-xs font-semibold text-text-primary mb-1">
                <Shield size={12} /> Pack Recommendations
              </div>
              {result.cascade.recommendations.map((r, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs text-text-secondary">
                  <ChevronRight size={10} className="flex-shrink-0 mt-0.5" /> {r}
                </div>
              ))}
            </div>
          )}

          {/* Tab switcher */}
          <div className="flex gap-1 border-b border-border-subtle">
            {([
              { id: 'cells',       icon: Battery,    label: 'Cell Grid' },
              { id: 'timeline',    icon: BarChart3,   label: 'EOL Timeline' },
              { id: 'thermal',     icon: Thermometer, label: 'Thermal Map' },
              { id: 'replacement', icon: TrendingDown, label: 'Replacement ROI' },
            ] as const).map(tab => (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-all border-b-2 -mb-px ${activeTab === tab.id ? 'border-brand-blue text-brand-blue' : 'border-transparent text-text-muted hover:text-text-primary'}`}>
                <tab.icon size={11} /> {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">

            {/* ─ Cell Grid ─ */}
            {activeTab === 'cells' && (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3 text-[10px] text-text-muted">
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-red-500/40 inline-block" /> bottleneck</span>
                  <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-sm bg-amber-500/30 inline-block" /> weak</span>
                  <span className="flex items-center gap-1"><Flame size={9} className="text-orange-400" /> hot (IR)</span>
                  <span className="flex items-center gap-1"><Thermometer size={9} className="text-amber-400" /> thermal stress</span>
                  <span className="flex items-center gap-1 ml-auto text-brand-blue"><Zap size={9} /> ML = AI-predicted RUL</span>
                </div>
                <CellGrid perCell={result.per_cell} hotCells={result.thermal.hot_cells} adjEffects={result.thermal.adjacency_effects} />
                <div className="grid grid-cols-3 gap-2 mt-2">
                  <div className="bg-bg-panel rounded-lg px-3 py-2 text-xs">
                    <div className="text-text-muted text-[10px]">Mean SOH</div>
                    <div className="font-semibold text-text-primary">{result.health.mean_soh_pct}%</div>
                  </div>
                  <div className="bg-bg-panel rounded-lg px-3 py-2 text-xs">
                    <div className="text-text-muted text-[10px]">RUL spread</div>
                    <div className="font-semibold text-text-primary">{result.pack_rul.rul_spread} cycles</div>
                  </div>
                  <div className="bg-bg-panel rounded-lg px-3 py-2 text-xs">
                    <div className="text-text-muted text-[10px]">Weak cells</div>
                    <div className="font-semibold text-text-primary">{result.health.n_weak} / {result.n_cells}</div>
                  </div>
                </div>
                {!result.first_failure.already_at_eol && (
                  <div className="text-[10px] text-text-muted">
                    First failure: <span className="text-red-400 font-medium font-mono">{result.first_failure.first_failure_cell}</span>
                    {' '}at ~{result.first_failure.cycles_to_eol} cycles (SOH {result.first_failure.first_failure_soh_pct}%)
                    {result.first_failure.warning_cells.length > 0 && (
                      <span> · warning: {result.first_failure.warning_cells.map(w => w.cell_id).join(', ')}</span>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ─ EOL Timeline ─ */}
            {activeTab === 'timeline' && (
              <div className="space-y-2">
                <div className="flex items-center gap-4 text-xs text-text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-5 h-0.5 bg-amber-400 rounded" /> No change
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block w-5 border-t-2 border-dashed border-blue-400" /> Replace weakest
                  </span>
                  <span className="flex items-center gap-1.5 ml-auto text-[10px]">
                    <span className="text-text-secondary">{nCycles}-cycle projection · fade_rate degradation model</span>
                  </span>
                </div>
                <TimelineChart data={result.timeline} eolSoh={eolSoh} />
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  <div className="bg-bg-panel rounded-lg px-3 py-2">
                    <span className="text-text-muted">EOL (no change): </span>
                    <span className={`font-semibold ${s.eol_no_change_cycle != null ? 'text-amber-400' : 'text-emerald-400'}`}>
                      {s.eol_no_change_cycle != null ? `cycle ${s.eol_no_change_cycle}` : `>${nCycles} (not reached)`}
                    </span>
                  </div>
                  <div className="bg-bg-panel rounded-lg px-3 py-2">
                    <span className="text-text-muted">EOL (replace weakest): </span>
                    <span className={`font-semibold ${s.eol_with_swap_cycle != null ? 'text-blue-400' : 'text-emerald-400'}`}>
                      {s.eol_with_swap_cycle != null ? `cycle ${s.eol_with_swap_cycle}` : `>${nCycles} (not reached)`}
                    </span>
                  </div>
                </div>
                <p className="text-[9px] text-text-muted">
                  Note: RUL axis reflects pack-level SOH via fade_rate model. AI-predicted per-cell RUL informs the pack RUL metric above; SOH trajectory uses per-cell fade_rate{featureExtraction ? ' estimated from capacity trend in CSV' : ' entered in the table'}.
                </p>
              </div>
            )}

            {/* ─ Thermal Map ─ */}
            {activeTab === 'thermal' && (
              <div className="space-y-4">
                {result.thermal.hot_cells.length === 0 ? (
                  <div className="flex items-center gap-2 text-xs text-emerald-400">
                    <CheckCircle size={13} /> No hot cells — all IR values within normal bounds (baseline 0.030 Ω).
                  </div>
                ) : (
                  <div>
                    <div className="text-xs font-semibold text-text-secondary mb-2 flex items-center gap-1.5">
                      <Flame size={12} className="text-orange-400" /> Hot Cells (IR &gt; 1.5× fresh baseline of 0.030 Ω)
                    </div>
                    <div className="space-y-1.5">
                      {result.thermal.hot_cells.map(h => (
                        <div key={h.cell_id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border text-xs ${RISK_BG[h.risk]}`}>
                          <Flame size={13} className={h.risk === 'critical' ? 'text-red-400' : 'text-orange-400'} />
                          <span className="font-mono font-semibold text-text-primary w-16">{h.cell_id}</span>
                          <span className="text-text-muted">IR = {h.ir_ohm.toFixed(4)} Ω</span>
                          <span className="text-text-secondary font-medium">{h.ir_ratio}× baseline</span>
                          <span className="text-text-muted">+{h.excess_heat_W.toFixed(3)} W extra heat at 1C</span>
                          <span className={`ml-auto font-bold uppercase text-[10px] px-2 py-0.5 rounded ${RISK_BG[h.risk]} ${RISK_COLOR[h.risk]}`}>{h.risk}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {result.thermal.adjacency_effects.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-text-secondary mb-2 flex items-center gap-1.5">
                      <Thermometer size={12} className="text-amber-400" /> Adjacency Stress (30% heat coupling to neighbours)
                    </div>
                    <div className="space-y-1">
                      {result.thermal.adjacency_effects.map(a => (
                        <div key={a.cell_id}
                          className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs border ${a.at_risk ? 'bg-amber-500/10 border-amber-500/20' : 'bg-bg-panel border-border-subtle opacity-70'}`}>
                          <Thermometer size={11} className={a.at_risk ? 'text-amber-400' : 'text-text-muted'} />
                          <span className="font-mono text-text-primary w-16">{a.cell_id}</span>
                          <span className="text-text-muted">{a.heat_received_W.toFixed(4)} W from {a.heat_sources.join(', ')}</span>
                          <span className={`ml-auto font-medium ${a.at_risk ? 'text-amber-300' : 'text-text-muted'}`}>
                            ×{a.fade_accel_factor.toFixed(4)} fade acceleration
                          </span>
                          {a.at_risk && <span className="text-[9px] text-amber-400 font-semibold">AT RISK</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 text-[10px] text-text-muted">
                  <Activity size={10} />
                  Overall thermal risk: <span className={`font-medium ml-1 capitalize ${RISK_COLOR[result.thermal.thermal_risk_level]}`}>{result.thermal.thermal_risk_level}</span>
                  <span className="ml-1">({(result.thermal.overall_thermal_risk * 100).toFixed(1)}%)</span>
                </div>
              </div>
            )}

            {/* ─ Replacement ROI ─ */}
            {activeTab === 'replacement' && (
              <div className="space-y-3">
                <div className="text-xs font-semibold text-text-secondary">
                  Replacement ROI — ranked by cycles gained (swap with fresh cell at cycle 0)
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-text-muted border-b border-border-subtle">
                        <th className="text-left pb-1.5 pr-3">Cell</th>
                        <th className="text-right pb-1.5 pr-3">Current SOH</th>
                        <th className="text-right pb-1.5 pr-3">Pack SOH before</th>
                        <th className="text-right pb-1.5 pr-3">Pack SOH after</th>
                        <th className="text-right pb-1.5 pr-3">Recovery</th>
                        <th className="text-right pb-1.5 pr-3">Cycles gained</th>
                        <th className="text-center pb-1.5">Rec.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border-subtle/40">
                      {result.replacement.map((r, idx) => (
                        <tr key={r.cell_id} className={r.recommended ? 'bg-emerald-500/5' : idx % 2 === 0 ? 'bg-bg-panel/30' : ''}>
                          <td className="py-2 pr-3 font-mono font-medium text-text-primary">{r.cell_id}</td>
                          <td className="py-2 pr-3 text-right" style={{ color: SOH_COLOR(r.current_soh_pct) }}>{r.current_soh_pct}%</td>
                          <td className="py-2 pr-3 text-right text-text-muted">{r.pack_soh_before_pct}%</td>
                          <td className="py-2 pr-3 text-right text-text-muted">{r.pack_soh_after_pct}%</td>
                          <td className={`py-2 pr-3 text-right font-medium ${r.soh_recovery_pct > 0 ? 'text-emerald-400' : 'text-text-muted'}`}>
                            {r.soh_recovery_pct > 0 ? `+${r.soh_recovery_pct.toFixed(2)}%` : '—'}
                          </td>
                          <td className="py-2 pr-3 text-right">
                            <span className={`font-bold ${r.cycles_gained > 0 ? 'text-brand-blue' : 'text-text-muted'}`}>
                              {r.cycles_gained > 0 ? `+${r.cycles_gained}` : '—'}
                            </span>
                          </td>
                          <td className="py-2 text-center">
                            {r.recommended
                              ? <CheckCircle size={13} className="text-emerald-400 mx-auto" />
                              : <span className="text-text-muted text-[10px]">—</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[9px] text-text-muted">
                  Pack SOH recovery based on replacing cell with fresh (SOH=100%).
                  Cycles gained = SOH recovery ÷ cell fade_rate.
                </p>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  )
}

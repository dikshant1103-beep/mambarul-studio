/**
 * Upload & Analyze — 3-step ingest wizard.
 *   Step 1: Drop CSV/JSON
 *   Step 2: Chemistry confirm + data preview
 *   Step 3: RUL prediction results with confidence band + export
 */
import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Upload, ChevronRight,
  AlertTriangle, Download, RefreshCw, Info, FlaskConical
} from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

// ── Types ─────────────────────────────────────────────────────────────────────
interface CyclePred {
  cycle: number
  soh_pct: number
  predicted_rul: number
  lower_90: number
  upper_90: number
  phase: string
  alert: string
  capacity?: number
  voltage_mean?: number
  temperature?: number
}

interface IngestSummary {
  n_cycles: number
  chemistry: string
  chemistry_conf: number
  soh_initial_pct: number
  soh_final_pct: number
  soh_drop_pct: number
  fade_rate_pct_per_cycle: number
  predicted_rul: number
  lower_90: number
  upper_90: number
  phase: string
  alert: string
  confidence_pct: number
  columns_found: Record<string, string>
}

interface IngestResult {
  summary: IngestSummary
  predictions: CyclePred[]
}

interface FleetBatchItem {
  label: string
  chemistry: string
  soh_pct: number
  nom_capacity: number
  int_resistance: number
  temperature: number
  cap_pct: number
  n_cycles?: number
}

interface FleetRULRow {
  label: string
  chemistry: string
  soh_pct: number
  predicted_rul: number | null
  lower_90: number
  upper_90: number
  phase: string
  alert: string
  error?: string
}

const CHEM_NOM_CAP: Record<string, number> = {
  NMC: 2.5, LFP: 1.1, NCA: 2.0, LCO: 1.05, NCM: 2.5,
}

const CHEM_LABELS: Record<string, string> = {
  LCO: 'Lithium Cobalt Oxide',
  LFP: 'Lithium Iron Phosphate',
  NMC: 'Nickel Manganese Cobalt',
  NCM: 'Nickel Cobalt Manganese',
  NCA: 'Nickel Cobalt Aluminum',
}
const CHEM_COLOR: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4'
}
const ALERT_STYLE: Record<string, { bg: string; text: string; icon: string }> = {
  healthy:  { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-400', icon: '✓' },
  warning:  { bg: 'bg-amber-400/10  border-amber-400/20',   text: 'text-amber-400',   icon: '⚠' },
  critical: { bg: 'bg-red-500/10    border-red-500/20',     text: 'text-red-400',     icon: '✕' },
}

const SAMPLE_CSV = `cycle,capacity,voltage_mean,temperature,chemistry
1,1.080,3.870,24.1,LCO
20,1.072,3.865,24.3,LCO
40,1.064,3.858,24.5,LCO
60,1.055,3.851,24.7,LCO
80,1.045,3.843,24.9,LCO
100,1.032,3.833,25.1,LCO
120,1.018,3.822,25.3,LCO
140,1.001,3.809,25.5,LCO
160,0.981,3.793,25.7,LCO
180,0.957,3.774,26.0,LCO
200,0.929,3.751,26.3,LCO
220,0.896,3.724,26.7,LCO
240,0.857,3.692,27.1,LCO
260,0.812,3.654,27.6,LCO
271,0.780,3.628,27.9,LCO`

// ── Fleet CSV helpers ─────────────────────────────────────────────────────────

const FLEET_PAGE_SIZE = 100

function detectFleetCSV(headerLine: string): boolean {
  const headers = headerLine.toLowerCase().replace(/\r/g, '').split(',').map(h => h.trim())
  const hasCycleCol = headers.includes('cycle')
  if (hasCycleCol) return false
  // Explicit battery/cell ID column → fleet
  if (headers.some(h => h === 'battery_id' || h === 'cell_id')) return true
  // Fleet snapshot indicators without explicit ID
  const fleetSignals = ['capacity_retained_percent', 'charge_cycles', 'depth_of_discharge', 'internal_resistance_mohm']
  return fleetSignals.filter(s => headers.includes(s)).length >= 2
}

function parseFleetCSV(text: string): FleetBatchItem[] {
  // Normalise CRLF and strip blank lines
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())

  const get = (row: string[], col: string): string => {
    const idx = headers.indexOf(col)
    return idx >= 0 ? (row[idx]?.trim() ?? '') : ''
  }

  return lines.slice(1).map(line => {
    const row = line.split(',')
    const rawChem = (get(row, 'chemistry') || 'NMC').toUpperCase()
    const chem = ['LCO', 'LFP', 'NMC', 'NCM', 'NCA'].includes(rawChem) ? rawChem : 'NMC'
    const soh = parseFloat(get(row, 'capacity_retained_percent') || get(row, 'soh_pct') || '85')
    const irMohm = parseFloat(get(row, 'internal_resistance_mohm') || '0')
    const temp = parseFloat(get(row, 'temperature_mean') || get(row, 'ambient_temp') || get(row, 'temperature') || '25')
    const nomCap = CHEM_NOM_CAP[chem] ?? 2.0
    const sohSafe = isNaN(soh) ? 85 : Math.min(Math.max(soh, 0), 100)

    const nCycles = parseInt(get(row, 'charge_cycles') || get(row, 'n_cycles') || get(row, 'cycles') || '0')
    const label = get(row, 'battery_id') || get(row, 'cell_id') || get(row, 'id') || `cell_${String(lines.indexOf(line)).padStart(5, '0')}`

    return {
      label,
      chemistry: chem,
      soh_pct: sohSafe,
      nom_capacity: nomCap,
      int_resistance: irMohm > 0 ? irMohm / 1000 : 0.025,
      temperature: isNaN(temp) ? 25 : temp,
      cap_pct: sohSafe / 100,
      n_cycles: isNaN(nCycles) || nCycles === 0 ? undefined : nCycles,
    }
  }).filter(item => item.label)
}

// ── Step indicator ────────────────────────────────────────────────────────────
function StepIndicator({ current }: { current: number }) {
  const steps = ['Upload', 'Confirm', 'Results']
  return (
    <div className="flex items-center gap-2">
      {steps.map((label, i) => {
        const done  = i + 1 < current
        const active = i + 1 === current
        return (
          <div key={label} className="flex items-center gap-2">
            <div className={`flex items-center gap-1.5 text-xs font-medium ${
              active ? 'text-text-primary' : done ? 'text-emerald-400' : 'text-text-muted'
            }`}>
              <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                active ? 'bg-brand-blue text-white' : done ? 'bg-emerald-500/20 text-emerald-400' : 'bg-bg-panel text-text-muted'
              }`}>
                {done ? '✓' : i + 1}
              </div>
              {label}
            </div>
            {i < steps.length - 1 && <ChevronRight size={12} className="text-text-muted" />}
          </div>
        )
      })}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────
export default function UploadPredict() {
  const [step, setStep]         = useState<1 | 2 | 3>(1)
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState<string | null>(null)
  const [result, setResult]     = useState<IngestResult | null>(null)
  const [chemOverride, setChemOverride] = useState<string | null>(null)
  const [fileName, setFileName] = useState<string>('')
  const [isFleet, setIsFleet]   = useState(false)
  const [fleetRows, setFleetRows] = useState<FleetRULRow[]>([])
  const [fleetPage, setFleetPage] = useState(0)
  // Raw V/I/T mode: when on, we POST to /api/ingest/raw and the backend
  // Coulomb-counts capacity from voltage + current + temperature itself.
  const [rawMode,  setRawMode]    = useState(false)
  const [nomCapAh, setNomCapAh]   = useState(2.0)
  const inputRef = useRef<HTMLInputElement>(null)

  const effectiveChem = chemOverride ?? result?.summary.chemistry ?? 'LCO'

  // ── Upload ────────────────────────────────────────────────────
  const doUpload = useCallback(async (file: File) => {
    setLoading(true); setError(null); setResult(null); setChemOverride(null)
    setIsFleet(false); setFleetRows([])
    setFileName(file.name)

    try {
      const text = await file.text()
      const firstLine = text.split('\n')[0] ?? ''

      if (detectFleetCSV(firstLine)) {
        // ── Fleet snapshot path ──────────────────────────
        const items = parseFleetCSV(text)
        if (items.length === 0) throw new Error('No valid rows found in fleet CSV')

        const CHUNK = 500
        const allResults: FleetRULRow[] = []
        for (let i = 0; i < items.length; i += CHUNK) {
          const chunk = items.slice(i, i + CHUNK)
          const payload = chunk.map(({ label: _l, ...rest }) => rest)
          const res = await fetch('/api/predict/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!res.ok) {
            const detail = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
            throw new Error(detail.detail ?? `Batch predict failed (${res.status})`)
          }
          const batchRes: Array<Record<string, unknown>> = await res.json()
          batchRes.forEach((r, j) => {
            allResults.push({
              label:         chunk[j].label,
              chemistry:     chunk[j].chemistry,
              soh_pct:       chunk[j].soh_pct,
              predicted_rul: r.error ? null : (r.predicted_rul as number),
              lower_90:      (r.lower_90 as number) ?? 0,
              upper_90:      (r.upper_90 as number) ?? 0,
              phase:         (r.phase as string) ?? '—',
              alert:         (r.alert as string) ?? 'healthy',
              error:         r.error as string | undefined,
            })
          })
        }
        setIsFleet(true)
        setFleetRows(allResults)
        setFleetPage(0)
        setStep(3)
      } else {
        // ── Per-cycle time-series path ───────────────────
        // Auto-route to /raw/fleet if rawMode AND the file has a `cell_id`
        // column (multi-cell BMS dump). Detection is the same heuristic
        // raw_telemetry uses on the backend: case-insensitive column-name match.
        const headerCols = firstLine.split(/[,\t;|]/).map(c => c.trim().toLowerCase())
        const hasCellId  = headerCols.some(c => c === 'cell_id' || c === 'cellid' || c === 'cell')
        const useFleet   = rawMode && hasCellId

        const form = new FormData()
        form.append('file', file)
        const endpoint = useFleet ? '/api/ingest/raw/fleet'
                         : rawMode ? '/api/ingest/raw'
                                   : '/api/ingest'
        if (rawMode) {
          form.append('nom_capacity_ah', String(nomCapAh))
          form.append('chemistry', 'auto')
        }
        const res = await fetch(endpoint, { method: 'POST', body: form })
        if (!res.ok) {
          const detail = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
          throw new Error(detail.detail ?? `Upload failed (${res.status})`)
        }

        if (useFleet) {
          // ── Multi-cell raw fleet path ──────────────────
          const fleet = await res.json()
          const rows: FleetRULRow[] = (fleet.cells || []).map((c: any) => ({
            label:         c.cell_id,
            chemistry:     c.summary?.chemistry ?? 'NMC',
            soh_pct:       c.soh_final_pct ?? 100,
            predicted_rul: c.predicted_rul ?? null,
            lower_90:      c.summary?.rul_ci?.lower ?? 0,
            upper_90:      c.summary?.rul_ci?.upper ?? 0,
            phase:         c.summary?.phase ?? '—',
            alert:         c.summary?.alert ?? 'healthy',
            error:         c.error,
          }))
          setIsFleet(true)
          setFleetRows(rows)
          setFleetPage(0)
          setStep(3)
          return
        }

        const data: IngestResult = await res.json()
        setResult(data)
        setStep(2)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    }
    setLoading(false)
  }, [rawMode, nomCapAh])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) doUpload(file)
  }, [doUpload])

  const onFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) doUpload(file)
    e.target.value = ''
  }, [doUpload])

  const loadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: 'text/csv' })
    doUpload(new File([blob], 'sample_lco.csv'))
  }

  const downloadReport = () => {
    if (!result) return
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `batteryOS_report_${Date.now()}.json`; a.click()
  }

  const reset = () => {
    setStep(1); setResult(null); setError(null); setChemOverride(null)
    setIsFleet(false); setFleetRows([]); setFleetPage(0)
  }

  const downloadFleetCSV = () => {
    if (!fleetRows.length) return
    const header = 'battery_id,chemistry,soh_pct,predicted_rul,lower_90,upper_90,phase,alert'
    const rows = fleetRows.map(r =>
      [r.label, r.chemistry, r.soh_pct, r.predicted_rul ?? '', r.lower_90, r.upper_90, r.phase, r.alert].join(',')
    )
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `batteryOS_fleet_rul_${Date.now()}.csv`; a.click()
  }

  // ── Plot data for step 3 ──────────────────────────────────────
  const preds  = result?.predictions ?? []
  const cycles = preds.map(p => p.cycle)
  const soh    = preds.map(p => p.soh_pct)
  const cColor = CHEM_COLOR[effectiveChem] ?? '#3b82f6'

  // 7-cycle rolling mean to suppress RPT / measurement noise while keeping trend
  const smooth = (arr: number[], w = 7): number[] =>
    arr.map((_, i) => {
      const lo = Math.max(0, i - Math.floor(w / 2))
      const hi = Math.min(arr.length, lo + w)
      return arr.slice(lo, hi).reduce((s, v) => s + v, 0) / (hi - lo)
    })

  const rul  = smooth(preds.map(p => p.predicted_rul))
  const lo90 = smooth(preds.map(p => p.lower_90))
  const hi90 = smooth(preds.map(p => p.upper_90))

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Upload & Analyze</h1>
          <p className="text-sm text-text-muted mt-0.5">
            Upload per-cycle battery data → auto-detect chemistry → get RUL prediction with confidence bounds
          </p>
        </div>
        <StepIndicator current={step} />
      </div>

      <AnimatePresence mode="wait">

        {/* ── Step 1: Drop zone ─────────────────────────────── */}
        {step === 1 && (
          <motion.div key="step1"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="space-y-4"
          >
            {/* Raw V/I/T mode toggle */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl px-4 py-3 flex items-center gap-3 flex-wrap text-xs">
              <span className="font-semibold text-text-secondary">My CSV is</span>
              <button onClick={() => setRawMode(false)}
                className={`px-2.5 py-1 rounded-lg font-medium border transition-all ${!rawMode ? 'bg-brand-blue/15 text-brand-blue border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle'}`}>
                Engineered (cycle + capacity)
              </button>
              <button onClick={() => setRawMode(true)}
                className={`px-2.5 py-1 rounded-lg font-medium border transition-all ${rawMode ? 'bg-brand-blue/15 text-brand-blue border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle'}`}>
                Raw V/I/T (voltage, current, temp)
              </button>
              {rawMode && (
                <label className="flex items-center gap-2 ml-2">
                  <span className="text-text-muted">Nominal capacity (Ah)</span>
                  <input type="number" step="0.1" min="0.1" value={nomCapAh}
                    onChange={e => setNomCapAh(+e.target.value)}
                    className="w-20 px-2 py-1 bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
                </label>
              )}
              <span className="ml-auto text-[10px] text-text-muted">
                {rawMode
                  ? 'Capacity is Coulomb-counted from current. No "capacity" column required.'
                  : 'Pre-computed capacity column expected (cycle, capacity, ...).'}
              </span>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-12 flex flex-col items-center justify-center gap-4 cursor-pointer transition-all ${
                dragging
                  ? 'border-brand-blue bg-brand-blue/5'
                  : 'border-border-subtle hover:border-brand-blue/40 hover:bg-bg-panel'
              } ${loading ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <input ref={inputRef} type="file" accept=".csv,.json,.txt" className="hidden" onChange={onFile} />
              {loading ? (
                <RefreshCw size={32} className="text-brand-blue animate-spin" />
              ) : (
                <Upload size={32} className={dragging ? 'text-brand-blue' : 'text-text-muted'} />
              )}
              <div className="text-center">
                <div className="text-sm font-medium text-text-primary">
                  {loading ? 'Analyzing data…' : 'Drop CSV / JSON here'}
                </div>
                <div className="text-xs text-text-muted mt-1">
                  or <span className="text-brand-blue underline">click to browse</span>
                </div>
                <div className="text-[10px] text-text-muted mt-2 opacity-70">
                  Per-cycle time-series · or fleet snapshot (one row per battery)
                </div>
              </div>
            </div>

            {/* Format guide */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                <Info size={14} className="text-brand-blue" />
                Supported formats
              </div>

              <div className="space-y-2">
                <div className="text-xs text-text-secondary font-medium">Format A — Per-cycle time-series (one row per cycle, single battery):</div>
                <pre className="text-[11px] text-text-secondary font-mono bg-bg-panel rounded-lg p-3 overflow-x-auto">
{`cycle, capacity, voltage_mean, temperature, chemistry
1,     1.08,     3.87,         24.1,        LCO
50,    1.05,     3.85,         24.5,        LCO   ...`}
                </pre>
              </div>

              <div className="space-y-2">
                <div className="text-xs text-text-secondary font-medium">Format B — Fleet snapshot (one row per battery, e.g. ev_battery_synth.csv):</div>
                <pre className="text-[11px] text-text-secondary font-mono bg-bg-panel rounded-lg p-3 overflow-x-auto">
{`battery_id, chemistry, capacity_retained_percent, internal_resistance_mohm, temperature_mean
BAT_001,    NMC,       88.5,                      25.3,                     28.1
BAT_002,    LFP,       76.2,                      31.1,                     27.4   ...`}
                </pre>
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs text-text-muted">
                <div><span className="text-text-secondary font-medium">Chemistries: </span>LCO, LFP, NMC, NCM, NCA</div>
                <div><span className="text-text-secondary font-medium">Also accepts: </span>JSON array of cycle objects</div>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                <AlertTriangle size={13} /> {error}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={loadSample}
                disabled={loading}
                className="px-4 py-2 text-xs font-medium border border-border-subtle text-text-secondary hover:text-text-primary hover:bg-bg-panel rounded-lg transition-all disabled:opacity-40"
              >
                Load sample data (LCO, 271 cycles)
              </button>
            </div>
          </motion.div>
        )}

        {/* ── Step 2: Chemistry confirm + data preview ──────── */}
        {step === 2 && result && (
          <motion.div key="step2"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="space-y-4"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

              {/* Chemistry card */}
              <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
                <div className="text-sm font-semibold text-text-primary flex items-center gap-2">
                  <FlaskConical size={14} className="text-brand-cyan" />
                  Auto-detected Chemistry
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center font-bold text-lg"
                    style={{ background: CHEM_COLOR[result.summary.chemistry] + '20', color: CHEM_COLOR[result.summary.chemistry] }}>
                    {result.summary.chemistry}
                  </div>
                  <div>
                    <div className="text-sm font-medium text-text-primary">{CHEM_LABELS[result.summary.chemistry]}</div>
                    <div className="text-xs text-text-muted">
                      Confidence: {(result.summary.chemistry_conf * 100).toFixed(0)}%
                    </div>
                  </div>
                </div>

                {/* Override */}
                <div className="space-y-1.5">
                  <label className="text-xs text-text-muted">Override chemistry</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {['LCO', 'LFP', 'NMC', 'NCM', 'NCA'].map(c => (
                      <button
                        key={c}
                        onClick={() => setChemOverride(chemOverride === c ? null : c)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all ${
                          (chemOverride ?? result.summary.chemistry) === c
                            ? 'ring-2 ring-offset-1 ring-offset-bg-secondary'
                            : 'opacity-50 hover:opacity-100'
                        }`}
                        style={{
                          background: CHEM_COLOR[c] + '20',
                          color: CHEM_COLOR[c],
                        }}
                      >{c}</button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Data summary card */}
              <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-2">
                <div className="text-sm font-semibold text-text-primary">Data Summary</div>
                {[
                  ['File', fileName],
                  ['Cycles', result.summary.n_cycles.toString()],
                  ['Initial SOH', `${result.summary.soh_initial_pct}%`],
                  ['Final SOH', `${result.summary.soh_final_pct}%`],
                  ['SOH Drop', `${result.summary.soh_drop_pct}%`],
                  ['Fade Rate', `${result.summary.fade_rate_pct_per_cycle.toFixed(4)}% per cycle`],
                  ['Columns found', Object.keys(result.summary.columns_found).join(', ')],
                ].map(([k, v]) => (
                  <div key={k} className="flex justify-between text-xs">
                    <span className="text-text-muted">{k}</span>
                    <span className="text-text-secondary font-mono">{v}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Data preview table */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 border-b border-border-subtle text-xs font-medium text-text-primary">
                Data Preview (first & last 5 cycles)
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-subtle text-text-muted">
                      <th className="px-3 py-2 text-right">Cycle</th>
                      {preds[0]?.capacity   !== undefined && <th className="px-3 py-2 text-right">Cap (Ah)</th>}
                      {preds[0]?.voltage_mean !== undefined && <th className="px-3 py-2 text-right">V̄ (V)</th>}
                      <th className="px-3 py-2 text-right">SOH %</th>
                      <th className="px-3 py-2 text-right">Est. RUL</th>
                      <th className="px-3 py-2 text-left">Phase</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...preds.slice(0, 5), ...(preds.length > 10 ? [null] : []), ...preds.slice(-5)].map((p, i) => {
                      if (!p) return (
                        <tr key="ellipsis" className="border-b border-border-subtle/30">
                          <td colSpan={6} className="px-3 py-1 text-center text-text-muted text-[10px]">⋯ {preds.length - 10} cycles omitted ⋯</td>
                        </tr>
                      )
                      return (
                        <tr key={i} className="border-b border-border-subtle/30 hover:bg-bg-panel">
                          <td className="px-3 py-1.5 text-right font-mono">{p.cycle}</td>
                          {p.capacity     !== undefined && <td className="px-3 py-1.5 text-right font-mono">{p.capacity.toFixed(3)}</td>}
                          {p.voltage_mean !== undefined && <td className="px-3 py-1.5 text-right font-mono">{p.voltage_mean.toFixed(3)}</td>}
                          <td className="px-3 py-1.5 text-right font-mono">
                            <span className={p.soh_pct > 80 ? 'text-emerald-400' : p.soh_pct > 65 ? 'text-amber-400' : 'text-red-400'}>
                              {p.soh_pct.toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-right font-mono text-text-primary">{p.predicted_rul}</td>
                          <td className="px-3 py-1.5 text-text-muted">{p.phase}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={reset} className="px-4 py-2 text-xs font-medium border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg transition-all">
                ← Upload different file
              </button>
              <button
                onClick={() => setStep(3)}
                className="px-5 py-2 text-xs font-medium bg-brand-blue text-white rounded-lg hover:bg-blue-500 transition-colors flex items-center gap-2"
              >
                Run Full Analysis <ChevronRight size={13} />
              </button>
            </div>
          </motion.div>
        )}

        {/* ── Step 3: Results ───────────────────────────────── */}
        {step === 3 && (result || isFleet) && (
          <motion.div key="step3"
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 20 }}
            className="space-y-5"
          >

            {/* ── Fleet results view ──────────────────────────── */}
            {isFleet && (
              <>
                {/* Fleet stats */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {(() => {
                    const ok   = fleetRows.filter(r => r.predicted_rul !== null)
                    const crit = ok.filter(r => r.alert === 'critical').length
                    const warn = ok.filter(r => r.alert === 'warning').length
                    const avgRul = ok.length ? Math.round(ok.reduce((s, r) => s + (r.predicted_rul ?? 0), 0) / ok.length) : 0
                    return [
                      { label: 'Batteries analyzed', value: fleetRows.length.toString(), color: 'blue' },
                      { label: 'Avg predicted RUL', value: `${avgRul} cycles`, color: 'cyan' },
                      { label: 'Critical alerts', value: crit.toString(), color: crit > 0 ? 'red' : 'emerald' },
                      { label: 'Warnings', value: warn.toString(), color: warn > 0 ? 'amber' : 'emerald' },
                    ].map(({ label, value, color }) => (
                      <div key={label} className={`rounded-xl border p-3 bg-${color}-500/5 border-${color}-500/15`}>
                        <div className="text-[10px] text-text-muted mb-0.5">{label}</div>
                        <div className={`text-sm font-bold text-${color}-400`}>{value}</div>
                      </div>
                    ))
                  })()}
                </div>

                {/* Fleet table — paginated to avoid rendering 15k rows at once */}
                {(() => {
                  const totalPages = Math.ceil(fleetRows.length / FLEET_PAGE_SIZE)
                  const pageRows = fleetRows.slice(fleetPage * FLEET_PAGE_SIZE, (fleetPage + 1) * FLEET_PAGE_SIZE)
                  return (
                    <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                      <div className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between">
                        <span className="text-xs font-medium text-text-primary">
                          Fleet RUL Results — {fleetRows.length} batteries · {fileName}
                        </span>
                        <div className="flex items-center gap-2">
                          {totalPages > 1 && (
                            <div className="flex items-center gap-1.5 text-[10px] text-text-muted">
                              <button onClick={() => setFleetPage(p => Math.max(0, p - 1))} disabled={fleetPage === 0}
                                className="px-2 py-0.5 border border-border-subtle rounded hover:bg-bg-panel disabled:opacity-30">‹</button>
                              <span>{fleetPage + 1}/{totalPages}</span>
                              <button onClick={() => setFleetPage(p => Math.min(totalPages - 1, p + 1))} disabled={fleetPage >= totalPages - 1}
                                className="px-2 py-0.5 border border-border-subtle rounded hover:bg-bg-panel disabled:opacity-30">›</button>
                            </div>
                          )}
                          <button onClick={downloadFleetCSV}
                            className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg transition-all">
                            <Download size={10} /> Export CSV
                          </button>
                        </div>
                      </div>
                      <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead className="sticky top-0 bg-bg-secondary z-10">
                            <tr className="border-b border-border-subtle text-text-muted">
                              <th className="px-3 py-2 text-left">Battery ID</th>
                              <th className="px-3 py-2 text-left">Chem</th>
                              <th className="px-3 py-2 text-right">SOH %</th>
                              <th className="px-3 py-2 text-right">Pred. RUL</th>
                              <th className="px-3 py-2 text-right">90% CI</th>
                              <th className="px-3 py-2 text-left">Phase</th>
                              <th className="px-3 py-2 text-left">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pageRows.map((r, i) => {
                              const alertS = ALERT_STYLE[r.alert] ?? ALERT_STYLE.healthy
                              return (
                                <tr key={fleetPage * FLEET_PAGE_SIZE + i} className="border-b border-border-subtle/30 hover:bg-bg-panel">
                                  <td className="px-3 py-1.5 font-mono text-text-primary text-[11px]">{r.label}</td>
                                  <td className="px-3 py-1.5">
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                                      style={{ background: (CHEM_COLOR[r.chemistry] ?? '#3b82f6') + '20', color: CHEM_COLOR[r.chemistry] ?? '#3b82f6' }}>
                                      {r.chemistry}
                                    </span>
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-mono">
                                    <span className={r.soh_pct > 80 ? 'text-emerald-400' : r.soh_pct > 65 ? 'text-amber-400' : 'text-red-400'}>
                                      {r.soh_pct.toFixed(1)}%
                                    </span>
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-mono text-text-primary">
                                    {r.predicted_rul !== null ? r.predicted_rul : <span className="text-text-muted">err</span>}
                                  </td>
                                  <td className="px-3 py-1.5 text-right font-mono text-text-muted text-[11px]">
                                    {r.predicted_rul !== null ? `${r.lower_90}–${r.upper_90}` : '—'}
                                  </td>
                                  <td className="px-3 py-1.5 text-text-muted">{r.phase}</td>
                                  <td className="px-3 py-1.5">
                                    <span className={`flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border w-fit ${alertS.bg} ${alertS.text}`}>
                                      {alertS.icon} {r.alert}
                                    </span>
                                  </td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )
                })()}

                <div className="flex gap-3">
                  <button onClick={reset} className="px-4 py-2 text-xs font-medium border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg transition-all">
                    ← Analyze another file
                  </button>
                  <button
                    onClick={downloadFleetCSV}
                    className="flex items-center gap-2 px-4 py-2 text-xs font-medium border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg transition-all"
                  >
                    <Download size={13} /> Export fleet CSV
                  </button>
                </div>
              </>
            )}

            {/* ── Per-cycle time-series view ──────────────────── */}
            {!isFleet && result && (
              <>
                {/* Summary headline */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    { label: 'Final SOH', value: `${result.summary.soh_final_pct}%`, color: result.summary.soh_final_pct > 80 ? 'emerald' : result.summary.soh_final_pct > 65 ? 'amber' : 'red' },
                    { label: 'Predicted RUL', value: `${result.summary.predicted_rul} cycles`, color: 'blue' },
                    { label: '90% Confidence', value: `${result.summary.lower_90}–${result.summary.upper_90}`, color: 'cyan' },
                    { label: 'Phase', value: result.summary.phase, color: 'purple' },
                  ].map(({ label, value, color }) => (
                    <div key={label} className={`rounded-xl border p-3 bg-${color}-500/5 border-${color}-500/15`}>
                      <div className="text-[10px] text-text-muted mb-0.5">{label}</div>
                      <div className={`text-sm font-bold text-${color}-400`}>{value}</div>
                    </div>
                  ))}
                </div>

                {/* Alert banner */}
                {result.summary.alert !== 'healthy' && (() => {
                  const s = ALERT_STYLE[result.summary.alert]
                  return (
                    <div className={`flex items-center gap-3 p-3 rounded-xl border text-xs font-medium ${s.bg} ${s.text}`}>
                      <AlertTriangle size={14} />
                      <span>
                        {result.summary.alert === 'critical'
                          ? `Critical: SOH ${result.summary.soh_final_pct}% — battery approaching end of life. Plan replacement within ${result.summary.predicted_rul} cycles.`
                          : `Warning: SOH ${result.summary.soh_final_pct}% — monitor closely. Estimated ${result.summary.predicted_rul} cycles remaining.`}
                      </span>
                    </div>
                  )
                })()}

                {/* RUL trajectory chart */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border-subtle text-sm font-semibold text-text-primary">
                    RUL Trajectory + 90% Confidence Band
                  </div>
                  <Plot
                    data={[
                      {
                        x: cycles, y: hi90,
                        fill: 'tonexty', fillcolor: cColor + '15', line: { color: 'transparent', width: 0 },
                        type: 'scatter', mode: 'lines', showlegend: false, hoverinfo: 'skip',
                      },
                      {
                        x: cycles, y: lo90,
                        fill: 'tozeroy', fillcolor: cColor + '15', line: { color: cColor + '30', width: 1, dash: 'dot' },
                        type: 'scatter', mode: 'lines', name: '90% CI lower', hovertemplate: 'Cycle %{x}<br>Lower 90%: %{y} cycles<extra></extra>',
                      },
                      {
                        x: cycles, y: rul,
                        type: 'scatter', mode: 'lines', name: 'Predicted RUL',
                        line: { color: cColor, width: 2.5 },
                        hovertemplate: 'Cycle %{x}<br>RUL: %{y} cycles<extra></extra>',
                      },
                    ]}
                    layout={{
                      ...darkLayout,
                      height: 280,
                      margin: { t: 10, b: 40, l: 55, r: 20 },
                      xaxis: { ...darkLayout.xaxis, title: { text: 'Cycle' }, tickfont: { size: 10 } },
                      yaxis: { ...darkLayout.yaxis, title: { text: 'Remaining Useful Life (cycles)' }, tickfont: { size: 10 } },
                      legend: { font: { size: 10, color: '#94a3b8' }, bgcolor: 'transparent' },
                    }}
                    config={plotConfig}
                    style={{ width: '100%' }}
                  />
                </div>

                {/* SOH fade chart */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border-subtle text-sm font-semibold text-text-primary">
                    Capacity Fade (SOH %)
                  </div>
                  <Plot
                    data={[{
                      x: cycles, y: soh,
                      type: 'scatter', mode: 'lines',
                      line: { color: '#10b981', width: 2.5 },
                      hovertemplate: 'Cycle %{x}<br>SOH: %{y}%<extra></extra>',
                      fill: 'tozeroy', fillcolor: '#10b98110',
                    }]}
                    layout={{
                      ...darkLayout,
                      height: 200,
                      margin: { t: 10, b: 40, l: 55, r: 20 },
                      xaxis: { ...darkLayout.xaxis, title: { text: 'Cycle' }, tickfont: { size: 10 } },
                      yaxis: { ...darkLayout.yaxis, title: { text: 'SOH (%)' }, tickfont: { size: 10 }, range: [0, 105] },
                      shapes: [{ type: 'line', x0: cycles[0] ?? 0, x1: cycles[cycles.length - 1] ?? 300,
                        y0: 80, y1: 80, line: { color: '#f59e0b', width: 1, dash: 'dash' } }],
                      annotations: [{ x: (cycles[cycles.length - 1] ?? 300) * 0.9, y: 81, text: '80% EOL threshold',
                        font: { size: 9, color: '#f59e0b' }, showarrow: false }],
                    }}
                    config={plotConfig}
                    style={{ width: '100%' }}
                  />
                </div>

                {/* Model info */}
                <div className="flex items-start gap-3 p-3 bg-bg-secondary border border-border-subtle rounded-xl text-xs text-text-muted">
                  <Info size={13} className="text-brand-blue flex-shrink-0 mt-0.5" />
                  <span>
                    Chemistry: <strong className="text-text-secondary">{effectiveChem}</strong> ({CHEM_LABELS[effectiveChem]}) ·{' '}
                    Confidence: <strong className="text-text-secondary">90% conformal prediction interval</strong> (calibrated on held-out test sets) ·{' '}
                    Model: <strong className="text-text-secondary">MambaRUL v12 BiMamba-APF</strong> · RMSE ≈ {
                      ({ LCO: '20 cyc (LCO)', LFP: '60–97 cyc (LFP)', NMC: '357 cyc (NMC)', NCM: '17 cyc (NCM)', NCA: '21 cyc (NCA)' } as Record<string, string>)[effectiveChem] ?? '—'
                    } ·{' '}
                    History: <strong className="text-amber-400">measured where ≥2 cycles are supplied; single-snapshot rows use a synthesized window</strong> (each prediction is tagged <code>history_source</code>).
                  </span>
                </div>

                <div className="flex gap-3">
                  <button onClick={reset} className="px-4 py-2 text-xs font-medium border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg transition-all">
                    ← Analyze another file
                  </button>
                  <button
                    onClick={downloadReport}
                    className="flex items-center gap-2 px-4 py-2 text-xs font-medium border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg transition-all"
                  >
                    <Download size={13} /> Export JSON report
                  </button>
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

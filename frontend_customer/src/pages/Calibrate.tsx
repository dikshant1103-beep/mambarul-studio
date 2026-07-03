/**
 * Calibrate — few-shot calibration for new cell types.
 * Route: /calibrate
 * Enter 5–30 (cycle, capacity) pairs → physics-based RUL with tighter conformal bounds.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FlaskConical, Plus, Trash2, AlertTriangle,
  CheckCircle2, Download, RefreshCw, Info
} from 'lucide-react'

interface CalibRow { cycle: string; capacity: string }

interface CalibResult {
  cell_label: string
  chemistry: string
  calibration_cycles: number
  current_cycle: number
  current_soh_pct: number
  predicted_rul: number
  lower_90: number
  upper_90: number
  confidence_width: number
  confidence_pct: number
  degradation_rate: number
  estimated_total_life: number
  phase: string
  method: string
  note: string
}

const CHEMISTRIES = ['NMC', 'LFP', 'LCO', 'NCM', 'NCA']
const PHASE_COLOR: Record<string, string> = {
  Fresh: '#10b981', Aging: '#3b82f6', Knee: '#f59e0b', 'Near-EOL': '#ef4444',
}
const PHASE_ACTION: Record<string, string> = {
  Fresh:      'Cell is healthy. Standard monitoring.',
  Aging:      'Normal degradation. Increase check frequency.',
  Knee:       'Approaching knee. Reduce charge rate.',
  'Near-EOL': 'Near end-of-life. Plan replacement.',
}

const EXAMPLE_DATA: CalibRow[] = [
  { cycle: '1',  capacity: '2.02' },
  { cycle: '5',  capacity: '2.01' },
  { cycle: '10', capacity: '1.99' },
  { cycle: '15', capacity: '1.98' },
  { cycle: '20', capacity: '1.96' },
  { cycle: '25', capacity: '1.94' },
]

export default function Calibrate() {
  const [rows,     setRows]     = useState<CalibRow[]>([{ cycle: '', capacity: '' }])
  const [chem,     setChem]     = useState('NMC')
  const [label,    setLabel]    = useState('New Cell')
  const [nomCap,   setNomCap]   = useState('2.0')
  const [temp,     setTemp]     = useState('25')
  const [result,   setResult]   = useState<CalibResult | null>(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)

  const addRow = () => setRows(r => [...r, { cycle: '', capacity: '' }])
  const removeRow = (i: number) => setRows(r => r.filter((_, j) => j !== i))
  const updateRow = (i: number, field: keyof CalibRow, val: string) =>
    setRows(r => r.map((row, j) => j === i ? { ...row, [field]: val } : row))

  const loadExample = () => { setRows(EXAMPLE_DATA); setChem('NMC'); setNomCap('2.0') }

  const valid = rows.filter(r => r.cycle && r.capacity && !isNaN(+r.cycle) && !isNaN(+r.capacity))
  const canRun = valid.length >= 5

  const runCalibration = async () => {
    setLoading(true); setError(null); setResult(null)
    try {
      const cycles   = valid.map(r => Math.round(+r.cycle))
      const capacity = valid.map(r => +r.capacity)
      const res = await fetch('/api/calibrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chemistry:   chem,
          cycles,
          capacity,
          nom_capacity: +nomCap || 1.0,
          temperature:  +temp || 25,
          cell_label:   label || 'New Cell',
        }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.detail ?? `Server ${res.status}`)
      }
      setResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Calibration failed')
    }
    setLoading(false)
  }

  const downloadReport = () => {
    if (!result) return
    const lines = [
      `BatteryOS Few-Shot Calibration Report`,
      `Generated: ${new Date().toISOString()}`,
      ``,
      `Cell: ${result.cell_label}`,
      `Chemistry: ${result.chemistry}`,
      `Calibration points: ${result.calibration_cycles}`,
      `Current cycle: ${result.current_cycle}`,
      `Current SOH: ${result.current_soh_pct}%`,
      ``,
      `--- Prediction ---`,
      `Predicted RUL: ${result.predicted_rul} cycles`,
      `90% CI: [${result.lower_90}, ${result.upper_90}] cycles`,
      `Confidence width: ±${(result.confidence_width / 2).toFixed(1)} cycles`,
      `Phase: ${result.phase}`,
      ``,
      `--- Degradation Model ---`,
      `Degradation rate: ${result.degradation_rate}% SOH/cycle`,
      `Estimated total life: ${result.estimated_total_life} cycles`,
      `Method: ${result.method}`,
      ``,
      `Note: ${result.note}`,
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `calibration_${result.cell_label.replace(/\s+/g, '_')}_${Date.now()}.txt`
    a.click()
  }

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Few-Shot Calibration</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Enter 5–30 measured (cycle, capacity) pairs → get a cell-specific RUL with tighter conformal bounds.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

        {/* Left: inputs */}
        <div className="lg:col-span-2 space-y-4">

          {/* Cell metadata */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-text-primary">Cell Parameters</div>

            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">Cell Label</label>
              <input value={label} onChange={e => setLabel(e.target.value)}
                className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
            </div>

            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">Chemistry</label>
              <select value={chem} onChange={e => setChem(e.target.value)}
                className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50">
                {CHEMISTRIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide">Nominal Cap (Ah)</label>
                <input type="number" value={nomCap} onChange={e => setNomCap(e.target.value)} step="0.1"
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              </div>
              <div>
                <label className="text-[10px] text-text-muted uppercase tracking-wide">Temp (°C)</label>
                <input type="number" value={temp} onChange={e => setTemp(e.target.value)} step="1"
                  className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              </div>
            </div>
          </div>

          {/* Cycle data entry */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-text-primary">Measured Data</div>
              <button onClick={loadExample}
                className="text-[10px] text-brand-blue hover:underline">Load example</button>
            </div>

            <div className="grid grid-cols-2 gap-1 text-[10px] text-text-muted px-1">
              <span>Cycle #</span><span>Capacity (Ah)</span>
            </div>

            <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
              {rows.map((row, i) => (
                <div key={i} className="grid grid-cols-2 gap-1 items-center">
                  <input
                    type="number" value={row.cycle} onChange={e => updateRow(i, 'cycle', e.target.value)}
                    placeholder="1"
                    className="px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
                  <div className="flex gap-1">
                    <input
                      type="number" value={row.capacity} onChange={e => updateRow(i, 'capacity', e.target.value)}
                      placeholder="2.00" step="0.001"
                      className="flex-1 px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50" />
                    <button onClick={() => removeRow(i)} disabled={rows.length === 1}
                      className="text-text-muted hover:text-red-400 disabled:opacity-30 transition-colors">
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={addRow}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 border border-dashed border-border-subtle text-[10px] text-text-muted rounded-lg hover:border-brand-blue/40 hover:text-brand-blue transition-colors">
              <Plus size={11} /> Add row
            </button>

            <div className="text-[10px] text-text-muted">
              {valid.length} valid rows
              {valid.length < 5 && <span className="text-amber-400"> · need at least 5</span>}
            </div>

            <button onClick={runCalibration} disabled={!canRun || loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
              {loading
                ? <><RefreshCw size={12} className="animate-spin" /> Calibrating…</>
                : <><FlaskConical size={12} /> Calibrate Cell</>}
            </button>
          </div>
        </div>

        {/* Right: results */}
        <div className="lg:col-span-3">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 mb-4">
              <AlertTriangle size={13} /> {error}
            </div>
          )}

          <AnimatePresence>
            {result && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                className="space-y-4">

                {/* Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 size={14} className="text-emerald-400" />
                    <span className="text-sm font-semibold text-text-primary">{result.cell_label}</span>
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold"
                      style={{
                        background: (PHASE_COLOR[result.phase] ?? '#6b7280') + '20',
                        color: PHASE_COLOR[result.phase] ?? '#6b7280',
                      }}>{result.phase}</span>
                  </div>
                  <button onClick={downloadReport}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors">
                    <Download size={11} /> Export
                  </button>
                </div>

                {/* Primary KPIs */}
                <div className="grid grid-cols-3 gap-3">
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 col-span-1">
                    <div className="text-[10px] text-text-muted uppercase tracking-widest">Predicted RUL</div>
                    <div className="text-3xl font-bold font-mono mt-1"
                      style={{ color: PHASE_COLOR[result.phase] ?? '#6b7280' }}>
                      {result.predicted_rul.toFixed(0)}
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5">cycles remaining</div>
                  </div>

                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="text-[10px] text-text-muted uppercase tracking-widest">90% CI</div>
                    <div className="text-lg font-bold font-mono text-text-primary mt-1">
                      {result.lower_90.toFixed(0)}–{result.upper_90.toFixed(0)}
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5">
                      ±{(result.confidence_width / 2).toFixed(1)} cycles
                    </div>
                  </div>

                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="text-[10px] text-text-muted uppercase tracking-widest">Current SOH</div>
                    <div className="text-lg font-bold font-mono text-text-primary mt-1">
                      {result.current_soh_pct}%
                    </div>
                    <div className="text-[10px] text-text-muted mt-0.5">@ cycle {result.current_cycle}</div>
                  </div>
                </div>

                {/* RUL bar */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-2">
                  <div className="flex justify-between text-[10px] text-text-muted">
                    <span>RUL progress</span>
                    <span>{result.current_cycle} / {result.estimated_total_life.toFixed(0)} cycles</span>
                  </div>
                  <div className="h-2 bg-bg-panel rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all"
                      style={{
                        width: `${Math.min(100, (result.current_cycle / result.estimated_total_life) * 100)}%`,
                        background: PHASE_COLOR[result.phase] ?? '#6b7280',
                      }} />
                  </div>
                  {/* CI overlay visualization */}
                  <div className="text-[10px] text-text-muted">
                    Estimated total life: {result.estimated_total_life.toFixed(0)} cycles
                    · Degradation: {Math.abs(result.degradation_rate).toFixed(4)}% SOH/cycle
                  </div>
                </div>

                {/* Details grid */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                  <div className="text-xs font-semibold text-text-primary mb-3">Calibration Details</div>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {[
                      { label: 'Chemistry',     value: result.chemistry },
                      { label: 'Calib. Points', value: `${result.calibration_cycles} cycles` },
                      { label: 'Method',        value: result.method },
                      { label: 'Degr. Rate',    value: `${Math.abs(result.degradation_rate).toFixed(4)}% / cyc` },
                      { label: 'Conf. Width',   value: `${result.confidence_width.toFixed(1)} cycles` },
                      { label: 'Est. Life',     value: `${result.estimated_total_life.toFixed(0)} cycles` },
                    ].map(({ label, value }) => (
                      <div key={label} className="bg-bg-panel rounded-lg p-2.5">
                        <div className="text-[9px] text-text-muted uppercase tracking-wide">{label}</div>
                        <div className="text-xs font-mono text-text-primary mt-0.5">{value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Recommended action */}
                <div className="rounded-xl border p-4 space-y-1"
                  style={{
                    background: (PHASE_COLOR[result.phase] ?? '#6b7280') + '08',
                    borderColor: (PHASE_COLOR[result.phase] ?? '#6b7280') + '30',
                  }}>
                  <div className="text-xs font-semibold" style={{ color: PHASE_COLOR[result.phase] ?? '#6b7280' }}>
                    {PHASE_ACTION[result.phase] ?? 'Monitor cell closely.'}
                  </div>
                  <p className="text-[10px] text-text-muted">{result.note}</p>
                </div>

                <div className="flex items-start gap-2 p-3 bg-bg-secondary border border-border-subtle rounded-xl text-[10px] text-text-muted">
                  <Info size={11} className="text-brand-blue flex-shrink-0 mt-0.5" />
                  Physics-based linear degradation model. More calibration points → tighter 90% bounds.
                  Validate against measured cycle data before production use.
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {!result && !error && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-text-muted">
              <FlaskConical size={32} className="opacity-20" />
              <div className="text-xs text-center">
                Enter at least 5 (cycle, capacity) measurements<br />and click Calibrate Cell
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

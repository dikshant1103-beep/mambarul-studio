import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import Plot from 'react-plotly.js'
import {
  Atom, Play, RefreshCw, Clock, CheckCircle,
  XCircle, Loader2, TrendingDown, FlaskConical,
  AlertTriangle, ShieldCheck, Calendar, Download, BarChart2
} from 'lucide-react'
import clsx from 'clsx'

const API = ''

interface FitParams { Q0: number; alpha: number; k_sei: number; k_crack: number }
interface ParamCI { value: number; ci95_lo: number; ci95_hi: number }
interface Forecast {
  cycles: number[]; capacity: number[]; eol_cycle: number | null; eol_soh: number
  ci90_lo?: number[]; ci90_hi?: number[]
}
interface TwinFit {
  cell_id: string; chemistry: string; param_set: string; n_cycles: number
  mean_temp_c: number
  observed: { cycles: number[]; capacity: number[]; soh: number[]; ir: number[]; temp: number[] }
  fit: {
    params: FitParams; param_ci: Record<string, ParamCI>
    r2: number; mape: number; rmse: number; eol_cycle: number | null
    predicted: number[]; degradation_split: { sei_pct: number; crack_pct: number }
  }
  forecast: Forecast
  param_validation: { k_sei_ok: boolean; k_crack_ok: boolean; alpha_ok: boolean; warnings: string[]; k_sei_lit_range: [number, number] }
  calendar_aging: { months: number[]; calendar_capacity: number[]; cycle_capacity: number[]; calendar_fade_pct: number; cycle_fade_pct: number }
  holdout: { n_train?: number; n_test?: number; rmse_ah?: number; rmse_pct_q0?: number; r2_train?: number; skipped?: boolean }
  pybamm_scale: number; pybamm_param_set: string
}
interface Preset { label: string; n_cycles: number; c_rate_dis: number; c_rate_chg: number; temperature: number; soc_max: number; Q0_scale: number; chemistry: string }
interface SimJob { status: string; label: string; elapsed?: number; result?: { ok: boolean; cycles: number[]; capacity: number[]; param_set?: string; error?: string } }

const CHEM_COLORS: Record<string, string> = {
  LFP: '#22c55e', NMC: '#3b82f6', NCA: '#f59e0b', NCM: '#8b5cf6', LCO: '#ef4444'
}
const CHEM_PARAMS: Record<string, string> = {
  LFP: 'Ai2020', NMC: 'Chen2020', NCM: 'OKane2022', NCA: 'NCA_Kim2011', LCO: 'Chen2020'
}

export default function DigitalTwin() {
  const [cells, setCells]         = useState<{ cell_id: string; dataset: string; chemistry: string; n_cycles: number }[]>([])
  const [cellSearch, setCellSearch] = useState('')
  const [selected, setSelected]   = useState<string | null>(null)
  const [twin, setTwin]           = useState<TwinFit | null>(null)
  const [twinLoading, setTwinLoading] = useState(false)
  const [presets, setPresets]     = useState<Preset[]>([])
  const [simJobs, setSimJobs]     = useState<(SimJob & { job_id?: string })[]>([])
  const [activeJobId, setActiveJobId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'forecast'|'calendar'|'validation'>('forecast')

  const [nCycles,     setNCycles]    = useState(100)
  const [cRateDis,    setCRateDis]   = useState(1.0)
  const [cRateChg,    setCRateChg]   = useState(0.5)
  const [temperature, setTemp]       = useState(25.0)
  const [socMax,      setSocMax]     = useState(1.0)
  const [q0Scale,     setQ0Scale]    = useState(1.0)
  const [simChem,     setSimChem]    = useState('NMC')
  const [simLabel,    setSimLabel]   = useState('custom')
  const [simRunning,  setSimRunning] = useState(false)

  useEffect(() => {
    fetch(`${API}/api/twin/cells`, { credentials: 'include' })
      .then(r => r.json()).then(setCells).catch(() => {})
    fetch(`${API}/api/twin/presets`, { credentials: 'include' })
      .then(r => r.json()).then(setPresets).catch(() => {})
  }, [])

  const fitTwin = useCallback(async (cell_id: string) => {
    setTwinLoading(true); setTwin(null)
    try {
      const r = await fetch(`${API}/api/twin/fit/${cell_id}`, { method: 'POST', credentials: 'include' })
      const data = await r.json()
      setTwin(data)
      if (data.pybamm_scale) setQ0Scale(parseFloat(data.pybamm_scale.toFixed(3)))
      if (data.chemistry)    setSimChem(data.chemistry.toUpperCase())
    } catch { /* ignore */ }
    setTwinLoading(false)
  }, [])

  useEffect(() => { if (selected) fitTwin(selected) }, [selected, fitTwin])

  // Poll active job
  useEffect(() => {
    if (!activeJobId) return
    const iv = setInterval(async () => {
      try {
        const r = await fetch(`${API}/api/twin/simulate/${activeJobId}`, { credentials: 'include' })
        const job = await r.json()
        if (job.status !== 'running') {
          setSimJobs(prev => [...prev, { ...job, job_id: activeJobId }])
          setActiveJobId(null); setSimRunning(false)
        }
      } catch { /* ignore */ }
    }, 1500)
    return () => clearInterval(iv)
  }, [activeJobId])

  const applyPreset = (p: Preset) => {
    setNCycles(p.n_cycles); setCRateDis(p.c_rate_dis); setCRateChg(p.c_rate_chg)
    setTemp(p.temperature); setSocMax(p.soc_max); setQ0Scale(p.Q0_scale)
    setSimChem(p.chemistry); setSimLabel(p.label)
  }

  const runSim = async () => {
    setSimRunning(true)
    try {
      const r = await fetch(`${API}/api/twin/simulate`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ n_cycles: nCycles, c_rate_dis: cRateDis, c_rate_chg: cRateChg,
          temperature, soc_max: socMax, Q0_scale: q0Scale, chemistry: simChem, label: simLabel }),
      })
      const { job_id } = await r.json()
      setActiveJobId(job_id)
    } catch { setSimRunning(false) }
  }

  const exportCSV = () => {
    if (!twin) return
    const rows = [['cycle','observed','fitted','forecast','ci90_lo','ci90_hi']]
    const obs = twin.observed
    obs.cycles.forEach((c, i) => {
      rows.push([c, obs.capacity[i], twin.fit.predicted[i] ?? '', '', '', ''].map(String))
    })
    twin.forecast.cycles.forEach((c, i) => {
      rows.push([c, '', '', twin.forecast.capacity[i],
        twin.forecast.ci90_lo?.[i] ?? '', twin.forecast.ci90_hi?.[i] ?? ''].map(String))
    })
    const csv = rows.map(r => r.join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `twin_${twin.cell_id}.csv`; a.click()
  }

  const filteredCells = cells.filter(c =>
    c.cell_id.toLowerCase().includes(cellSearch.toLowerCase()) ||
    c.chemistry.toLowerCase().includes(cellSearch.toLowerCase())
  )

  // ── Chart traces ────────────────────────────────────────────────────────────
  const forecastTraces = (): Plotly.Data[] => {
    if (!twin) return []
    const color = CHEM_COLORS[twin.chemistry] ?? '#6366f1'
    const traces: Plotly.Data[] = []

    // Confidence band
    if (twin.forecast.ci90_lo && twin.forecast.ci90_hi) {
      traces.push({
        x: [...twin.forecast.cycles, ...twin.forecast.cycles.slice().reverse()],
        y: [...twin.forecast.ci90_hi, ...twin.forecast.ci90_lo.slice().reverse()],
        fill: 'toself', fillcolor: 'rgba(139,92,246,0.12)',
        line: { color: 'transparent' }, name: '90% CI', showlegend: true,
        hoverinfo: 'skip',
      } as any)
    }

    // Observed
    traces.push({
      x: twin.observed.cycles, y: twin.observed.capacity,
      mode: 'markers', name: 'Observed',
      marker: { color, size: 4, opacity: 0.6 },
    } as any)

    // Fitted
    traces.push({
      x: twin.observed.cycles, y: twin.fit.predicted,
      mode: 'lines', name: `Fit (R²=${twin.fit.r2.toFixed(3)})`,
      line: { color: '#f59e0b', width: 2, dash: 'dot' },
    } as any)

    // Forecast
    traces.push({
      x: twin.forecast.cycles, y: twin.forecast.capacity,
      mode: 'lines', name: 'Forecast (300 cycles)',
      line: { color: '#8b5cf6', width: 2 },
    } as any)

    // EOL line
    if (twin.forecast.eol_cycle) {
      traces.push({
        x: [twin.forecast.eol_cycle, twin.forecast.eol_cycle],
        y: [0, twin.fit.params.Q0 * 1.05],
        mode: 'lines', name: `EOL @ ${twin.forecast.eol_cycle}`,
        line: { color: '#ef4444', width: 1.5, dash: 'dash' },
      } as any)
    }

    // Sim overlays
    simJobs.forEach((job, i) => {
      if (job.status === 'done' && job.result?.ok) {
        traces.push({
          x: job.result.cycles, y: job.result.capacity,
          mode: 'lines', name: `${job.label || `Sim ${i+1}`} [${job.result.param_set ?? ''}]`,
          line: { width: 1.5 }, opacity: 0.8,
        } as any)
      }
    })
    return traces
  }

  const calendarTraces = (): Plotly.Data[] => {
    if (!twin?.calendar_aging) return []
    const ca = twin.calendar_aging
    return [
      { x: ca.months, y: ca.cycle_capacity, mode: 'lines', name: 'Active cycling',
        line: { color: '#ef4444', width: 2 } } as any,
      { x: ca.months, y: ca.calendar_capacity, mode: 'lines', name: 'Calendar only (rest)',
        line: { color: '#f59e0b', width: 2, dash: 'dash' } } as any,
    ]
  }

  const layoutBase = (yTitle: string): Partial<Plotly.Layout> => ({
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#94a3b8', size: 11 },
    margin: { t: 30, b: 50, l: 55, r: 20 },
    legend: { bgcolor: 'rgba(15,23,42,0.7)', bordercolor: '#1e293b', borderwidth: 1, font: { size: 10 } },
    xaxis: { gridcolor: '#1e293b' },
    yaxis: { gridcolor: '#1e293b', title: { text: yTitle } },
  })

  const pv = twin?.param_validation
  const allValid = pv && pv.k_sei_ok && pv.k_crack_ok && pv.alpha_ok

  return (
    <div className="p-3 sm:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20">
            <Atom className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-text-primary">Physics-Based Digital Twin</h1>
            <p className="text-xs text-text-muted">
              Dual-mechanism analytical model · Chemistry-specific PyBaMM SPM+SEI · 90% forecast CI
            </p>
          </div>
        </div>
        {twin && (
          <button onClick={exportCSV}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-panel border border-bg-border text-xs text-text-secondary hover:text-text-primary transition-all">
            <Download className="w-3.5 h-3.5" />Export CSV
          </button>
        )}
      </div>

      <div className="grid grid-cols-12 gap-4">
        {/* Cell selector */}
        <div className="col-span-3 bg-bg-card border border-bg-border rounded-xl p-3 space-y-2">
          <div className="text-xs font-semibold text-text-muted uppercase tracking-wide">Select Cell</div>
          <input className="w-full bg-bg-panel border border-bg-border rounded-lg px-2.5 py-1.5 text-xs text-text-primary placeholder-text-muted focus:outline-none focus:border-indigo-500"
            placeholder="Search cell / chemistry…" value={cellSearch} onChange={e => setCellSearch(e.target.value)} />
          <div className="space-y-0.5 max-h-[500px] overflow-y-auto pr-1">
            {filteredCells.map(c => (
              <button key={c.cell_id} onClick={() => setSelected(c.cell_id)}
                className={clsx('w-full text-left px-2.5 py-2 rounded-lg transition-all text-xs',
                  selected === c.cell_id
                    ? 'bg-indigo-500/15 border border-indigo-500/30 text-indigo-300'
                    : 'hover:bg-bg-panel text-text-secondary hover:text-text-primary')}>
                <div className="flex items-center justify-between">
                  <span className="font-mono font-medium truncate">{c.cell_id}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full ml-1 flex-shrink-0"
                    style={{ background: (CHEM_COLORS[c.chemistry] ?? '#6366f1') + '22', color: CHEM_COLORS[c.chemistry] ?? '#6366f1' }}>
                    {c.chemistry}
                  </span>
                </div>
                <div className="text-[10px] text-text-muted mt-0.5">{c.n_cycles} cycles · {c.dataset}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Right panel */}
        <div className="col-span-9 space-y-4">

          {twinLoading && (
            <div className="bg-bg-card border border-bg-border rounded-xl p-8 flex items-center justify-center gap-3">
              <Loader2 className="w-5 h-5 text-indigo-400 animate-spin" />
              <span className="text-sm text-text-muted">Fitting analytical twin…</span>
            </div>
          )}

          {!twin && !twinLoading && (
            <div className="bg-bg-card border border-bg-border rounded-xl p-12 flex flex-col items-center gap-3 text-center">
              <Atom className="w-10 h-10 text-indigo-400/30" />
              <div className="text-sm text-text-muted">Select a cell to fit the digital twin</div>
            </div>
          )}

          {twin && !twinLoading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">

              {/* KPI row */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { label: 'Initial Q₀', value: `${twin.fit.params.Q0.toFixed(3)} Ah`, color: 'text-blue-400' },
                  { label: 'R² Fit', value: twin.fit.r2.toFixed(4), color: twin.fit.r2 >= 0.95 ? 'text-emerald-400' : 'text-amber-400' },
                  { label: 'MAPE', value: `${twin.fit.mape.toFixed(2)}%`, color: twin.fit.mape < 2 ? 'text-emerald-400' : 'text-amber-400' },
                  { label: 'EOL Cycle', value: twin.forecast.eol_cycle ? `~${twin.forecast.eol_cycle}` : '>10k', color: 'text-red-400' },
                  { label: 'Param Set', value: twin.pybamm_param_set, color: 'text-indigo-400' },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-bg-card border border-bg-border rounded-xl px-3 py-3">
                    <div className="text-[10px] text-text-muted mb-0.5">{label}</div>
                    <div className={clsx('text-sm font-bold font-mono truncate', color)}>{value}</div>
                  </div>
                ))}
              </div>

              {/* Hold-out validation badge */}
              {!twin.holdout.skipped && (
                <div className="flex items-center gap-3 bg-bg-panel border border-bg-border rounded-lg px-4 py-2 text-xs">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <span className="text-text-muted">Hold-out validation ({twin.holdout.n_train} train / {twin.holdout.n_test} test cycles):</span>
                  <span className="text-emerald-400 font-mono">RMSE = {twin.holdout.rmse_pct_q0?.toFixed(2)}% of Q₀</span>
                  <span className="text-text-muted">({twin.holdout.rmse_ah?.toFixed(4)} Ah)</span>
                  <span className="text-text-muted ml-auto">R²_train = {twin.holdout.r2_train?.toFixed(3)}</span>
                </div>
              )}

              {/* Parameter validation */}
              {pv && pv.warnings.length > 0 && (
                <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-lg px-4 py-2 text-xs">
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    {pv.warnings.map((w, i) => <div key={i} className="text-amber-300">{w}</div>)}
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="flex gap-1 bg-bg-panel rounded-lg p-1 w-fit">
                {([['forecast','Forecast + What-If'],['calendar','Calendar Aging'],['validation','Parameters']] as const).map(([tab, label]) => (
                  <button key={tab} onClick={() => setActiveTab(tab)}
                    className={clsx('px-3 py-1.5 rounded-md text-xs font-medium transition-all',
                      activeTab === tab ? 'bg-bg-card text-text-primary shadow' : 'text-text-muted hover:text-text-primary')}>
                    {label}
                  </button>
                ))}
              </div>

              {/* ── FORECAST TAB ── */}
              {activeTab === 'forecast' && (
                <div className="space-y-4">
                  <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <TrendingDown className="w-4 h-4 text-indigo-400" />
                      <span className="text-sm font-semibold text-text-primary">Capacity Degradation + Forecast</span>
                      <span className="ml-auto text-xs text-text-muted">{twin.chemistry} · {twin.n_cycles} obs. cycles · {twin.pybamm_param_set} params</span>
                      {twin.forecast.ci90_lo && <span className="text-xs text-purple-400">90% CI band shown</span>}
                    </div>
                    <Plot data={forecastTraces() as any}
                      layout={{ ...layoutBase('Capacity (Ah)'), xaxis: { ...layoutBase('').xaxis, title: { text: 'Cycle' } } } as any}
                      config={{ displayModeBar: false, responsive: true }}
                      style={{ width: '100%', height: 320 }} useResizeHandler />
                  </div>

                  {/* Degradation split */}
                  <div className="grid grid-cols-2 gap-3">
                    <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                      <div className="text-xs font-semibold text-text-muted mb-3">Degradation Mechanism Split</div>
                      <div className="space-y-2">
                        {[
                          { label: 'SEI Growth (√n)', pct: twin.fit.degradation_split.sei_pct, color: '#3b82f6' },
                          { label: 'Particle Cracking (n)', pct: twin.fit.degradation_split.crack_pct, color: '#f59e0b' },
                        ].map(({ label, pct, color }) => (
                          <div key={label}>
                            <div className="flex justify-between text-xs mb-1">
                              <span className="text-text-secondary">{label}</span>
                              <span className="font-mono" style={{ color }}>{pct}%</span>
                            </div>
                            <div className="h-2 bg-bg-panel rounded-full overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* What-if launcher */}
                    <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                      <div className="flex items-center gap-2 mb-2">
                        <FlaskConical className="w-4 h-4 text-cyan-400" />
                        <span className="text-xs font-semibold text-text-primary">PyBaMM What-If</span>
                        <span className="ml-auto text-[10px] text-text-muted">{CHEM_PARAMS[simChem] ?? 'Chen2020'} params</span>
                      </div>
                      <div className="flex flex-wrap gap-1 mb-3">
                        {presets.slice(0, 4).map(p => (
                          <button key={p.label} onClick={() => applyPreset(p)}
                            className="px-2 py-0.5 rounded bg-bg-panel border border-bg-border text-[10px] text-text-muted hover:text-text-primary hover:border-cyan-500/30 transition-all truncate max-w-[130px]">
                            {p.label.split('(')[0].trim()}
                          </button>
                        ))}
                      </div>
                      <div className="grid grid-cols-2 gap-x-4 gap-y-2 mb-3">
                        {[
                          { label: 'Cycles', value: nCycles, min: 10, max: 200, step: 10, set: setNCycles, unit: '' },
                          { label: 'Temp', value: temperature, min: -10, max: 60, step: 1, set: setTemp, unit: '°C' },
                          { label: 'C-rate Dis', value: cRateDis, min: 0.1, max: 5.0, step: 0.1, set: setCRateDis, unit: 'C' },
                          { label: 'C-rate Chg', value: cRateChg, min: 0.1, max: 3.0, step: 0.1, set: setCRateChg, unit: 'C' },
                        ].map(({ label, value, min, max, step, set, unit }) => (
                          <div key={label}>
                            <div className="flex justify-between text-[10px] text-text-muted mb-0.5">
                              <span>{label}</span><span className="font-mono text-text-primary">{value}{unit}</span>
                            </div>
                            <input type="range" min={min} max={max} step={step} value={value}
                              onChange={e => set(parseFloat(e.target.value) as any)}
                              className="w-full h-1.5 rounded-full accent-cyan-400" />
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <select value={simChem} onChange={e => setSimChem(e.target.value)}
                          className="flex-none bg-bg-panel border border-bg-border rounded text-xs px-2 py-1 text-text-primary focus:outline-none">
                          {['LFP','NMC','NCM','NCA','LCO'].map(c => <option key={c}>{c}</option>)}
                        </select>
                        <button onClick={runSim} disabled={simRunning}
                          className={clsx('flex-1 flex items-center justify-center gap-1.5 rounded-lg text-xs font-semibold transition-all py-1.5',
                            simRunning ? 'bg-cyan-500/20 text-cyan-400/60 cursor-not-allowed' : 'bg-cyan-500 hover:bg-cyan-400 text-white')}>
                          {simRunning ? <><Loader2 className="w-3 h-3 animate-spin" />Running…</> : <><Play className="w-3 h-3" />Run PyBaMM</>}
                        </button>
                      </div>
                      {activeJobId && (
                        <div className="mt-1.5 flex items-center gap-1 text-[10px] text-cyan-400 animate-pulse">
                          <Clock className="w-3 h-3" />Job {activeJobId} running…
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Sim results */}
                  {simJobs.length > 0 && (
                    <div className="bg-bg-card border border-bg-border rounded-xl p-3">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-xs font-semibold text-text-primary">Simulation Results</span>
                        <button onClick={() => setSimJobs([])} className="text-[10px] text-text-muted hover:text-text-primary flex items-center gap-1">
                          <RefreshCw className="w-3 h-3" />Clear
                        </button>
                      </div>
                      <div className="space-y-1.5 max-h-36 overflow-y-auto">
                        {[...simJobs].reverse().map((job, i) => (
                          <div key={i} className="flex items-center justify-between bg-bg-panel rounded px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              {job.status === 'done' && job.result?.ok ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                                : job.status === 'failed' ? <XCircle className="w-3.5 h-3.5 text-red-400" />
                                : <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />}
                              <span className="text-xs text-text-primary">{job.label}</span>
                            </div>
                            <div className="flex items-center gap-3 text-[10px] text-text-muted">
                              {job.result?.param_set && <span className="text-indigo-400">{job.result.param_set}</span>}
                              {job.elapsed && <span>{job.elapsed}s</span>}
                              {job.result?.ok && <span className="text-emerald-400">{job.result.cycles.length} cycles</span>}
                              {job.result?.error && <span className="text-red-400 max-w-[160px] truncate">{job.result.error}</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* ── CALENDAR AGING TAB ── */}
              {activeTab === 'calendar' && twin.calendar_aging && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {[
                      { label: 'Calendar fade (24 mo)', value: `${twin.calendar_aging.calendar_fade_pct}%`, color: 'text-amber-400' },
                      { label: 'Cycle fade (24 mo)', value: `${twin.calendar_aging.cycle_fade_pct}%`, color: 'text-red-400' },
                      { label: 'Avg temp used', value: `${twin.mean_temp_c}°C`, color: 'text-blue-400' },
                    ].map(({ label, value, color }) => (
                      <div key={label} className="bg-bg-card border border-bg-border rounded-xl px-4 py-3">
                        <div className="text-[10px] text-text-muted mb-0.5">{label}</div>
                        <div className={clsx('text-xl font-bold font-mono', color)}>{value}</div>
                      </div>
                    ))}
                  </div>
                  <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Calendar className="w-4 h-4 text-amber-400" />
                      <span className="text-sm font-semibold text-text-primary">Calendar vs Cycle Aging (24 months)</span>
                      <span className="ml-auto text-xs text-text-muted">Arrhenius-corrected at {twin.mean_temp_c}°C</span>
                    </div>
                    <Plot data={calendarTraces() as any}
                      layout={{ ...layoutBase('Capacity (Ah)'), xaxis: { ...layoutBase('').xaxis, title: { text: 'Months' } } } as any}
                      config={{ displayModeBar: false, responsive: true }}
                      style={{ width: '100%', height: 280 }} useResizeHandler />
                    <div className="mt-2 text-xs text-text-muted">
                      Calendar aging uses only SEI growth (√t kinetics) with Arrhenius temperature correction (Eₐ=30 kJ/mol).
                      Cycling adds particle cracking on top.
                    </div>
                  </div>
                </div>
              )}

              {/* ── VALIDATION TAB ── */}
              {activeTab === 'validation' && (
                <div className="space-y-4">
                  {/* Parameter table with CI */}
                  <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <span className="text-sm font-semibold text-text-primary">Fitted Parameters + 95% Confidence Interval</span>
                      {allValid
                        ? <span className="ml-auto flex items-center gap-1 text-xs text-emerald-400"><CheckCircle className="w-3.5 h-3.5" />All params physical</span>
                        : <span className="ml-auto flex items-center gap-1 text-xs text-amber-400"><AlertTriangle className="w-3.5 h-3.5" />Check warnings</span>}
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-bg-border text-text-muted">
                            <th className="text-left py-1.5 pr-4">Parameter</th>
                            <th className="text-right pr-4">Value</th>
                            <th className="text-right pr-4">95% CI lo</th>
                            <th className="text-right pr-4">95% CI hi</th>
                            <th className="text-right">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(twin.fit.param_ci).map(([name, ci]) => {
                            const ok = name === 'k_sei' ? pv?.k_sei_ok : name === 'k_crack' ? pv?.k_crack_ok : name === 'alpha' ? pv?.alpha_ok : true
                            return (
                              <tr key={name} className="border-b border-bg-border/50">
                                <td className="py-1.5 pr-4 font-mono text-indigo-300">{name}</td>
                                <td className="text-right pr-4 font-mono text-text-primary">{ci.value.toFixed(8)}</td>
                                <td className="text-right pr-4 font-mono text-text-muted">{ci.ci95_lo.toFixed(8)}</td>
                                <td className="text-right pr-4 font-mono text-text-muted">{ci.ci95_hi.toFixed(8)}</td>
                                <td className="text-right">
                                  {ok === undefined ? '—' : ok
                                    ? <CheckCircle className="w-3.5 h-3.5 text-emerald-400 inline" />
                                    : <AlertTriangle className="w-3.5 h-3.5 text-amber-400 inline" />}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {pv && (
                      <div className="mt-3 text-[10px] text-text-muted">
                        Literature k_SEI range for {twin.chemistry}: [{pv.k_sei_lit_range[0]}, {pv.k_sei_lit_range[1]}]
                      </div>
                    )}
                  </div>

                  {/* Model equation */}
                  <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                    <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-2">Degradation Model</div>
                    <div className="font-mono text-xs text-indigo-300 bg-bg-panel rounded-lg px-4 py-2.5">
                      Q(n) = Q₀ × [ α · exp(−k_SEI · √n) + (1−α) · exp(−k_crack · n) ]
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-8 gap-y-1 text-[10px] text-text-muted">
                      <span><span className="text-indigo-300 font-mono">Q₀</span> — initial capacity (Ah)</span>
                      <span><span className="text-indigo-300 font-mono">α</span> — SEI fraction (0–1)</span>
                      <span><span className="text-indigo-300 font-mono">k_SEI</span> — SEI rate (√cycle⁻¹); Arrhenius-T corrected</span>
                      <span><span className="text-indigo-300 font-mono">k_crack</span> — particle cracking rate (cycle⁻¹)</span>
                    </div>
                  </div>

                  {/* PyBaMM param set info */}
                  <div className="bg-bg-card border border-bg-border rounded-xl p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <BarChart2 className="w-4 h-4 text-cyan-400" />
                      <span className="text-sm font-semibold text-text-primary">PyBaMM Parameter Set</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      {[
                        { label: 'Chemistry', value: twin.chemistry },
                        { label: 'Parameter set', value: twin.pybamm_param_set },
                        { label: 'Q₀ scale vs nominal', value: `${twin.pybamm_scale}×` },
                        { label: 'Mean cell temp', value: `${twin.mean_temp_c}°C` },
                      ].map(({ label, value }) => (
                        <div key={label} className="bg-bg-panel rounded-lg px-3 py-2">
                          <div className="text-[10px] text-text-muted">{label}</div>
                          <div className="font-mono text-text-primary mt-0.5">{value}</div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-3 space-y-1 text-[10px] text-text-muted">
                      <div className="flex items-center gap-1.5"><CheckCircle className="w-3 h-3 text-emerald-400" />Temperature effects (Arrhenius) — validated physics</div>
                      <div className="flex items-center gap-1.5"><CheckCircle className="w-3 h-3 text-emerald-400" />C-rate capacity fade (diffusion-limited) — validated physics</div>
                      <div className="flex items-center gap-1.5"><CheckCircle className="w-3 h-3 text-emerald-400" />Relative scenario ranking — reliable</div>
                      <div className="flex items-center gap-1.5 text-amber-400/70"><AlertTriangle className="w-3 h-3" />Absolute degradation rate — calibrated to {twin.pybamm_param_set} cell, not your specific cell</div>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * SecondLife — Battery second-life assessment tool.
 * Route: /second-life
 * Assess individual cells, packs, or the full fleet.
 * Shows grade (A–D), application recommendations, residual value.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Recycle, Zap, RefreshCw, ChevronRight,
  AlertTriangle, CheckCircle2, DollarSign, Battery, Info,
  FlaskConical, Layers
} from 'lucide-react'

const GRADE_STYLE: Record<string, { bg: string; border: string; text: string; label: string }> = {
  A: { bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-400', label: 'Excellent' },
  B: { bg: 'bg-blue-500/10',    border: 'border-blue-500/30',    text: 'text-blue-400',    label: 'Good' },
  C: { bg: 'bg-amber-500/10',   border: 'border-amber-500/30',   text: 'text-amber-400',   label: 'Fair' },
  D: { bg: 'bg-red-500/10',     border: 'border-red-500/30',     text: 'text-red-400',     label: 'Recycle' },
}
const SUITABILITY_COLOR = (s: number) =>
  s >= 0.7 ? 'bg-emerald-500' : s >= 0.4 ? 'bg-amber-400' : 'bg-red-500'

const CHEMISTRY_OPTIONS = ['NMC', 'LFP', 'NCA', 'NCM', 'LCO']
const fadeUp = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0 } }

interface AppResult {
  id: string; name: string; suitability: number; suitable: boolean
  revenue: string; description: string; reasons: string[]
}
interface AssessResult {
  cell_id: string; grade: string; score: number; soh_pct: number
  rul_cycles: number; chemistry: string; recycle: boolean; verdict: string
  applications: AppResult[]
  value: { min_usd: number; max_usd: number; per_kwh_usd: number; kwh_remaining: number; basis?: string }
  risk_flags: string[]; recommended_tests: string[]
  inputs: { ir_ohm: number; ir_mult_vs_fresh: number; cycles: number; capacity_fade_rate: number }
}
interface FleetResult {
  n_cells: number; grade_counts: Record<string, number>
  reuse_count: number; recycle_count: number
  fleet_value: { min_usd: number; max_usd: number }
  cells: AssessResult[]; assessed_at: string
}

export default function SecondLife() {
  const [mode, setMode]       = useState<'single' | 'fleet'>('single')
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<AssessResult | null>(null)
  const [fleet,   setFleet]   = useState<FleetResult | null>(null)
  const [error,   setError]   = useState<string | null>(null)

  // Single-cell form state
  const [form, setForm] = useState({
    cell_id: 'cell-001', soh: '0.74', rul_cycles: '1200',
    chemistry: 'NMC', ir: '', cycles: '', capacity_ah: '',
    capacity_fade_rate: '',
  })

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }))

  const runSingle = async () => {
    setLoading(true); setError(null); setResult(null)
    try {
      const body = {
        cell_id:            form.cell_id,
        soh:                parseFloat(form.soh),
        rul_cycles:         parseFloat(form.rul_cycles),
        chemistry:          form.chemistry,
        ir:                 form.ir           ? parseFloat(form.ir)           : 0,
        cycles:             form.cycles       ? parseInt(form.cycles)         : 0,
        capacity_ah:        form.capacity_ah  ? parseFloat(form.capacity_ah)  : 0,
        capacity_fade_rate: form.capacity_fade_rate ? parseFloat(form.capacity_fade_rate) : 0,
      }
      const r = await fetch('/api/second-life/assess', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(await r.text())
      setResult(await r.json())
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  const runFleet = async () => {
    setLoading(true); setError(null); setFleet(null)
    try {
      const r = await fetch('/api/second-life/assess/fleet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!r.ok) throw new Error(await r.text())
      setFleet(await r.json())
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }

  const g = result ? GRADE_STYLE[result.grade] ?? GRADE_STYLE.D : null

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <Recycle size={20} className="text-emerald-400" /> Second-Life Assessment
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Grade batteries for reuse · match to applications · estimate residual value
          </p>
        </div>
        {/* Mode toggle */}
        <div className="flex gap-1 p-1 bg-bg-secondary border border-border-subtle rounded-lg">
          {(['single', 'fleet'] as const).map(m => (
            <button key={m} onClick={() => { setMode(m); setResult(null); setFleet(null) }}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                mode === m
                  ? 'bg-brand-blue text-white'
                  : 'text-text-secondary hover:text-text-primary'
              }`}>
              {m === 'single' ? 'Single Cell' : 'Fleet Batch'}
            </button>
          ))}
        </div>
      </div>

      <AnimatePresence mode="wait">
        {mode === 'single' ? (
          <motion.div key="single" variants={fadeUp} initial="hidden" animate="show"
            className="grid grid-cols-1 lg:grid-cols-5 gap-5">

            {/* Input form */}
            <div className="lg:col-span-2 bg-bg-secondary border border-border-subtle rounded-xl p-5 space-y-4">
              <div className="text-sm font-semibold text-text-primary flex items-center gap-2">
                <Battery size={14} className="text-brand-blue" /> Cell Parameters
              </div>

              {/* Required */}
              <div className="space-y-3">
                <label className="block">
                  <span className="text-xs text-text-muted">Cell ID</span>
                  <input value={form.cell_id} onChange={e => set('cell_id', e.target.value)}
                    className="mt-1 w-full bg-bg-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-blue" />
                </label>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-xs text-text-muted">SOH (0–1) <span className="text-red-400">*</span></span>
                    <input type="number" step="0.01" min="0" max="1"
                      value={form.soh} onChange={e => set('soh', e.target.value)}
                      className="mt-1 w-full bg-bg-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-blue" />
                  </label>
                  <label className="block">
                    <span className="text-xs text-text-muted">RUL (cycles) <span className="text-red-400">*</span></span>
                    <input type="number" min="0"
                      value={form.rul_cycles} onChange={e => set('rul_cycles', e.target.value)}
                      className="mt-1 w-full bg-bg-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-blue" />
                  </label>
                </div>

                <label className="block">
                  <span className="text-xs text-text-muted">Chemistry</span>
                  <select value={form.chemistry} onChange={e => set('chemistry', e.target.value)}
                    className="mt-1 w-full bg-bg-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-blue">
                    {CHEMISTRY_OPTIONS.map(c => <option key={c}>{c}</option>)}
                  </select>
                </label>
              </div>

              <div className="border-t border-border-subtle pt-3">
                <div className="text-[10px] text-text-muted uppercase tracking-widest mb-2">Optional — improves accuracy</div>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs text-text-muted">Int. Resistance (Ω)</span>
                      <input type="number" step="0.001" min="0" placeholder="e.g. 0.045"
                        value={form.ir} onChange={e => set('ir', e.target.value)}
                        className="mt-1 w-full bg-bg-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-blue" />
                    </label>
                    <label className="block">
                      <span className="text-xs text-text-muted">Cycle Count</span>
                      <input type="number" min="0" placeholder="e.g. 800"
                        value={form.cycles} onChange={e => set('cycles', e.target.value)}
                        className="mt-1 w-full bg-bg-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-blue" />
                    </label>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block">
                      <span className="text-xs text-text-muted">Capacity (Ah)</span>
                      <input type="number" step="0.1" min="0" placeholder="e.g. 50"
                        value={form.capacity_ah} onChange={e => set('capacity_ah', e.target.value)}
                        className="mt-1 w-full bg-bg-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-blue" />
                    </label>
                    <label className="block">
                      <span className="text-xs text-text-muted">Fade (%/100 cyc)</span>
                      <input type="number" step="0.1" min="0" placeholder="e.g. 1.5"
                        value={form.capacity_fade_rate} onChange={e => set('capacity_fade_rate', e.target.value)}
                        className="mt-1 w-full bg-bg-panel border border-border-subtle rounded-lg px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-brand-blue" />
                    </label>
                  </div>
                </div>
              </div>

              <button onClick={runSingle} disabled={loading || !form.soh || !form.rul_cycles}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue rounded-lg text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50">
                {loading ? <RefreshCw size={14} className="animate-spin" /> : <Zap size={14} />}
                {loading ? 'Assessing…' : 'Run Assessment'}
              </button>

              {error && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-2">
                  {error}
                </div>
              )}
            </div>

            {/* Result panel */}
            <div className="lg:col-span-3 space-y-4">
              {!result && !loading && (
                <div className="flex flex-col items-center justify-center h-64 text-text-muted text-sm gap-2 bg-bg-secondary border border-border-subtle rounded-xl">
                  <Recycle size={32} className="opacity-20" />
                  <span>Enter cell parameters and run assessment</span>
                </div>
              )}

              {result && g && (
                <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-4">

                  {/* Grade card */}
                  <div className={`rounded-xl border p-5 ${g.bg} ${g.border}`}>
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="text-xs text-text-muted mb-1">Second-Life Grade</div>
                        <div className={`text-5xl font-black ${g.text}`}>{result.grade}</div>
                        <div className={`text-sm font-semibold mt-1 ${g.text}`}>{g.label}</div>
                        <p className="text-xs text-text-muted mt-2 max-w-xs">{result.verdict}</p>
                      </div>
                      <div className="text-right space-y-1">
                        <div className="text-xs text-text-muted">Score</div>
                        <div className="text-3xl font-bold text-text-primary">{result.score}</div>
                        <div className="text-xs text-text-muted">/ 100</div>
                      </div>
                    </div>
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3 pt-4 border-t border-white/10">
                      <div>
                        <div className="text-[10px] text-text-muted">SOH</div>
                        <div className="text-sm font-bold text-text-primary">{result.soh_pct}%</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">RUL</div>
                        <div className="text-sm font-bold text-text-primary">{result.rul_cycles.toLocaleString()} cyc</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">Chemistry</div>
                        <div className="text-sm font-bold text-text-primary">{result.chemistry}</div>
                      </div>
                    </div>
                  </div>

                  {/* Value estimate */}
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-3">
                      <DollarSign size={14} className="text-emerald-400" /> Residual Value Estimate
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                      <div>
                        <div className="text-[10px] text-text-muted">Range</div>
                        <div className="text-base font-bold text-text-primary">
                          ${result.value.min_usd.toLocaleString()} – ${result.value.max_usd.toLocaleString()}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">Per kWh</div>
                        <div className="text-base font-bold text-text-primary">${result.value.per_kwh_usd}/kWh</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-text-muted">Remaining kWh</div>
                        <div className="text-base font-bold text-text-primary">{result.value.kwh_remaining} kWh</div>
                      </div>
                    </div>
                    <div className="text-[10px] text-text-muted mt-2 flex items-center gap-1">
                      <Info size={9} /> {result.value.basis}
                    </div>
                  </div>

                  {/* Application recommendations */}
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
                      <Layers size={14} className="text-brand-blue" /> Application Suitability
                    </div>
                    <div className="space-y-2">
                      {result.applications.filter(a => a.id !== 'recycle' || result.recycle).slice(0, 6).map(app => (
                        <div key={app.id} className={`rounded-lg border p-3 ${
                          app.suitable
                            ? 'border-border-subtle bg-bg-panel'
                            : 'border-border-subtle/40 bg-bg-panel/30 opacity-60'
                        }`}>
                          <div className="flex items-center justify-between mb-1.5">
                            <div className="flex items-center gap-2">
                              {app.suitable
                                ? <CheckCircle2 size={12} className="text-emerald-400" />
                                : <AlertTriangle size={12} className="text-text-muted" />}
                              <span className="text-xs font-medium text-text-primary">{app.name}</span>
                              <span className="text-[10px] text-text-muted">· {app.revenue}</span>
                            </div>
                            <span className="text-xs font-mono text-text-secondary">
                              {Math.round(app.suitability * 100)}%
                            </span>
                          </div>
                          <div className="h-1.5 bg-bg-secondary rounded-full overflow-hidden mb-2">
                            <div className={`h-full rounded-full transition-all ${SUITABILITY_COLOR(app.suitability)}`}
                              style={{ width: `${app.suitability * 100}%` }} />
                          </div>
                          <p className="text-[10px] text-text-muted">{app.reasons[0]}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Risk flags + tests */}
                  {(result.risk_flags.length > 0 || result.recommended_tests.length > 0) && (
                    <div className="grid grid-cols-2 gap-4">
                      {result.risk_flags.length > 0 && (
                        <div className="bg-bg-secondary border border-amber-500/20 rounded-xl p-4">
                          <div className="text-xs font-semibold text-amber-400 mb-2 flex items-center gap-1.5">
                            <AlertTriangle size={12} /> Risk Flags
                          </div>
                          <ul className="space-y-1">
                            {result.risk_flags.map((f, i) => (
                              <li key={i} className="text-[10px] text-text-muted flex items-start gap-1.5">
                                <span className="mt-0.5 w-1 h-1 rounded-full bg-amber-400 flex-shrink-0" />{f}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {result.recommended_tests.length > 0 && (
                        <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                          <div className="text-xs font-semibold text-text-primary mb-2 flex items-center gap-1.5">
                            <FlaskConical size={12} className="text-brand-blue" /> Recommended Tests
                          </div>
                          <ul className="space-y-1">
                            {result.recommended_tests.map((t, i) => (
                              <li key={i} className="text-[10px] text-text-muted flex items-start gap-1.5">
                                <ChevronRight size={10} className="mt-0.5 flex-shrink-0 text-brand-blue" />{t}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  )}
                </motion.div>
              )}
            </div>
          </motion.div>
        ) : (
          /* Fleet mode */
          <motion.div key="fleet" variants={fadeUp} initial="hidden" animate="show" className="space-y-5">
            <div className="flex items-center gap-4">
              <button onClick={runFleet} disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-brand-blue rounded-lg text-sm font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50">
                {loading ? <RefreshCw size={14} className="animate-spin" /> : <Recycle size={14} />}
                {loading ? 'Assessing fleet…' : 'Run Fleet Assessment'}
              </button>
              {fleet && (
                <span className="text-xs text-text-muted">
                  {fleet.n_cells} cells assessed · {new Date(fleet.assessed_at).toLocaleTimeString()}
                </span>
              )}
            </div>

            {error && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">
                {error}
              </div>
            )}

            {fleet && (
              <motion.div variants={fadeUp} initial="hidden" animate="show" className="space-y-5">

                {/* Fleet KPIs */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  {(['A', 'B', 'C', 'D'] as const).map(g => {
                    const gs = GRADE_STYLE[g]
                    return (
                      <div key={g} className={`rounded-xl border p-4 ${gs.bg} ${gs.border}`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className={`text-2xl font-black ${gs.text}`}>{g}</span>
                          <span className="text-xs text-text-muted">{gs.label}</span>
                        </div>
                        <div className="text-3xl font-bold text-text-primary">
                          {fleet.grade_counts[g] ?? 0}
                        </div>
                        <div className="text-xs text-text-muted">cells</div>
                      </div>
                    )
                  })}
                </div>

                {/* Value summary */}
                <div className="bg-bg-secondary border border-emerald-500/20 rounded-xl p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-text-primary mb-2">
                    <DollarSign size={14} className="text-emerald-400" /> Fleet Residual Value
                  </div>
                  <div className="text-2xl font-bold text-text-primary">
                    ${fleet.fleet_value.min_usd.toLocaleString()} – ${fleet.fleet_value.max_usd.toLocaleString()}
                  </div>
                  <div className="text-xs text-text-muted mt-1">
                    {fleet.reuse_count} cells suitable for reuse · {fleet.recycle_count} recommended for recycling
                  </div>
                </div>

                {/* Cell table */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-border-subtle text-sm font-semibold text-text-primary">
                    All Cells
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-subtle text-text-muted">
                          <th className="px-4 py-2.5 text-left font-medium">Cell ID</th>
                          <th className="px-4 py-2.5 text-left font-medium">Chemistry</th>
                          <th className="px-4 py-2.5 text-right font-medium">SOH %</th>
                          <th className="px-4 py-2.5 text-right font-medium">RUL</th>
                          <th className="px-4 py-2.5 text-center font-medium">Grade</th>
                          <th className="px-4 py-2.5 text-right font-medium">Score</th>
                          <th className="px-4 py-2.5 text-right font-medium">Value ($)</th>
                          <th className="px-4 py-2.5 text-left font-medium">Best Use</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fleet.cells.slice(0, 40).map(cell => {
                          const gs = GRADE_STYLE[cell.grade] ?? GRADE_STYLE.D
                          const best = cell.applications.find(a => a.suitable && a.id !== 'recycle')
                          return (
                            <tr key={cell.cell_id}
                              className="border-b border-border-subtle/50 hover:bg-bg-panel transition-colors">
                              <td className="px-4 py-2 font-mono text-text-primary truncate max-w-[120px]">
                                {cell.cell_id}
                              </td>
                              <td className="px-4 py-2 text-text-secondary">{cell.chemistry}</td>
                              <td className="px-4 py-2 text-right font-mono">
                                <span className={cell.soh_pct >= 80 ? 'text-emerald-400' : cell.soh_pct >= 65 ? 'text-blue-400' : cell.soh_pct >= 50 ? 'text-amber-400' : 'text-red-400'}>
                                  {cell.soh_pct}%
                                </span>
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-text-secondary">
                                {cell.rul_cycles.toLocaleString()}
                              </td>
                              <td className="px-4 py-2 text-center">
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold border ${gs.bg} ${gs.border} ${gs.text}`}>
                                  {cell.grade}
                                </span>
                              </td>
                              <td className="px-4 py-2 text-right font-mono text-text-secondary">{cell.score}</td>
                              <td className="px-4 py-2 text-right font-mono text-text-secondary">
                                {cell.value.min_usd}–{cell.value.max_usd}
                              </td>
                              <td className="px-4 py-2 text-text-muted truncate max-w-[140px]">
                                {best ? best.name : (cell.recycle ? 'Recycle' : '—')}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {fleet.cells.length > 40 && (
                    <div className="px-4 py-2 border-t border-border-subtle/50 text-xs text-text-muted text-center">
                      Showing 40 of {fleet.cells.length} cells
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Info footer */}
      <div className="flex items-start gap-2 px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-xs text-text-muted">
        <Info size={12} className="text-brand-blue flex-shrink-0 mt-0.5" />
        <span>
          Grading aligned with <strong className="text-text-secondary">IEC 62984</strong> and USDOE second-life guidelines.
          Grade A ≥80% SOH · B 65–80% · C 50–65% · D &lt;50% (recycle).
          Value estimates based on 2026 market rates. Recommended tests improve accuracy.
        </span>
      </div>
    </div>
  )
}

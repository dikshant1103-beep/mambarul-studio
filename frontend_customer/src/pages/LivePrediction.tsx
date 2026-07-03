/**
 * Live Predict — single-cell RUL prediction form.
 * Clean product UI: chemistry selector + 4 inputs + quick scenarios + result card.
 */
import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, RefreshCw, AlertTriangle, CheckCircle2, Info, Download } from 'lucide-react'
import ModelSelector from '../components/ui/ModelSelector'

// ── Constants ────────────────────────────────────────────────────────────────
const CHEMISTRIES = ['LCO', 'LFP', 'NMC', 'NCM', 'NCA'] as const
type Chem = typeof CHEMISTRIES[number]

const CHEM_META: Record<Chem, { full: string; color: string; nomV: number }> = {
  LCO: { full: 'Lithium Cobalt Oxide',    color: '#3b82f6', nomV: 3.85 },
  LFP: { full: 'Lithium Iron Phosphate',  color: '#10b981', nomV: 3.20 },
  NMC: { full: 'Nickel Manganese Cobalt', color: '#f59e0b', nomV: 3.70 },
  NCM: { full: 'Nickel Cobalt Manganese', color: '#8b5cf6', nomV: 3.68 },
  NCA: { full: 'Nickel Cobalt Aluminum',  color: '#06b6d4', nomV: 3.72 },
}
const MAX_RUL: Record<Chem, number> = { LCO: 309, LFP: 1934, NMC: 1500, NCM: 1000, NCA: 800 }

// IR scales with cell size: large-format cells (>10 Ah) use mΩ range.
// We store everything in Ω internally; display converts for large cells.
function irScenario(nomCap: number, degradeFrac: number): number {
  // Specific resistance ≈ 0.1–1.5 mΩ·Ah for EV cells; scale by capacity
  const base = 0.15 / nomCap   // Ω at fresh state for given capacity
  return +(base * degradeFrac).toFixed(5)
}

const SCENARIOS = [
  { label: 'Fresh',    soh: 97, irFrac: 1.0, color: '#10b981' },
  { label: 'Mid-Life', soh: 82, irFrac: 1.6, color: '#3b82f6' },
  { label: 'Knee',     soh: 68, irFrac: 2.4, color: '#f59e0b' },
  { label: 'Near-EOL', soh: 50, irFrac: 3.7, color: '#ef4444' },
]

const PHASE_META: Record<string, { color: string; action: string }> = {
  Fresh:      { color: '#10b981', action: 'Standard monitoring. No intervention required.' },
  Aging:      { color: '#3b82f6', action: 'Increase monitoring frequency. Plan replacement.' },
  Knee:       { color: '#f59e0b', action: 'Reduce charge rate. Begin replacement procurement.' },
  'Near-EOL': { color: '#ef4444', action: 'Immediate replacement recommended.' },
}

// ── Animated counter ──────────────────────────────────────────────────────────
function AnimCounter({ target, decimals = 0 }: { target: number; decimals?: number }) {
  const [v, setV] = useState(target)
  const raf = useRef<number>()
  const t0  = useRef<number | null>(null)
  const prev = useRef(target)
  useEffect(() => {
    const from = prev.current
    prev.current = target
    t0.current = null
    const step = (ts: number) => {
      if (!t0.current) t0.current = ts
      const p = Math.min((ts - t0.current) / 700, 1)
      const e = 1 - Math.pow(1 - p, 3)
      setV(+(from + (target - from) * e).toFixed(decimals))
      if (p < 1) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [target, decimals])
  return <>{decimals > 0 ? v.toFixed(decimals) : Math.round(v)}</>
}

// ── SOH arc gauge ─────────────────────────────────────────────────────────────
function SohGauge({ pct, color }: { pct: number; color: string }) {
  const r = 52, circ = 2 * Math.PI * r
  const dash = (Math.min(pct, 100) / 100) * circ
  return (
    <svg width="136" height="136" viewBox="0 0 136 136">
      <circle cx="68" cy="68" r={r} fill="none" stroke="#1e2d45" strokeWidth="10" />
      <circle cx="68" cy="68" r={r} fill="none" stroke={color} strokeWidth="10"
        strokeDasharray={`${dash} ${circ}`} strokeDashoffset={circ / 4}
        strokeLinecap="round" style={{ transition: 'stroke-dasharray 0.7s cubic-bezier(.4,0,.2,1)' }} />
      <text x="68" y="63" textAnchor="middle" fill={color} fontSize="22" fontWeight="700" fontFamily="JetBrains Mono">
        {Math.round(pct)}
      </text>
      <text x="68" y="80" textAnchor="middle" fill="#64748b" fontSize="10">% SOH</text>
    </svg>
  )
}

// ── RUL confidence bar ────────────────────────────────────────────────────────
function ConfidenceBar({ rul, lo, hi, maxRul }: { rul: number; lo: number; hi: number; maxRul: number }) {
  const pLo  = (lo  / maxRul) * 100
  const pHi  = (hi  / maxRul) * 100
  const pRul = (rul / maxRul) * 100
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[10px] text-text-muted">
        <span>{lo} cycles</span>
        <span className="text-text-secondary font-medium">{rul} cycles (predicted)</span>
        <span>{hi} cycles</span>
      </div>
      <div className="relative h-3 bg-bg-panel rounded-full overflow-hidden">
        <div className="absolute h-full rounded-full bg-brand-blue/20"
          style={{ left: `${pLo}%`, width: `${pHi - pLo}%` }} />
        <div className="absolute top-0.5 bottom-0.5 w-1.5 rounded-full bg-brand-blue"
          style={{ left: `${pRul}%`, transform: 'translateX(-50%)' }} />
      </div>
      <div className="text-[10px] text-text-muted text-center">90% confidence interval</div>
    </div>
  )
}

// ── Number input ─────────────────────────────────────────────────────────────
function NumInput({ label, unit, value, min, max, step, onChange }: {
  label: string; unit: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-text-muted font-medium uppercase tracking-wide">
        {label} <span className="normal-case">{unit}</span>
      </label>
      <input
        type="number" value={value} min={min} max={max} step={step}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="w-full px-3 py-2 text-sm font-mono bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50 transition-colors"
      />
      <input type="range" value={value} min={min} max={max} step={step}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1 accent-brand-blue cursor-pointer" />
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function LivePrediction() {
  const [chem, setChem]       = useState<Chem>('NMC')
  const [nomCap, setNomCap]   = useState(25.1)
  const [nomV,   setNomV]     = useState(3.69)
  const [soh,    setSoh]      = useState(97)
  const [cap,    setCap]      = useState(24.4)
  const [ir,     setIr]       = useState(irScenario(25.1, 1.0))
  const [temp,   setTemp]     = useState(25)
  const [modelId, setModelId] = useState('v10-final')
  const [nCycles, setNCycles] = useState<number | null>(null)
  const [dod,    setDod]      = useState<number | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loading, setLoading] = useState(false)
  const [result,  setResult]  = useState<Record<string, number | string> | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [ran,     setRan]     = useState(false)

  // When cell spec changes, reset IR to fresh-cell value only
  useEffect(() => {
    setIr(irScenario(nomCap, 1.0))
  }, [nomCap])

  const applyScenario = (s: typeof SCENARIOS[0]) => {
    setSoh(s.soh)
    // Capacity set to the physically expected value at this SOH for reference,
    // but user can override independently
    setCap(+(nomCap * (s.soh / 100)).toFixed(2))
    setIr(irScenario(nomCap, s.irFrac))
  }

  // Display IR in mΩ for large cells (>10 Ah), Ω for small cells
  const irIsLarge  = nomCap >= 5
  const irDisplay  = irIsLarge ? +(ir * 1000).toFixed(3) : +ir.toFixed(4)
  const irUnit     = irIsLarge ? 'mΩ' : 'Ω'
  const irToOhm    = (display: number) => irIsLarge ? display / 1000 : display

  const predict = async () => {
    setLoading(true); setError(null)
    try {
      const body: Record<string, unknown> = {
        model_id: modelId,
        chemistry: chem,
        cap_pct: soh / 100,
        soh_pct: soh,
        capacity: cap,
        nom_capacity: nomCap,
        int_resistance: ir,
        temperature: temp,
        voltage_mean: nomV * (0.98 - (1 - soh / 100) * 0.08),
      }
      if (nCycles !== null) body.n_cycles = nCycles
      if (dod !== null)     body.dod_pct  = dod
      const res = await fetch('/api/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data = await res.json()
      setResult(data)
      setRan(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Prediction failed')
    }
    setLoading(false)
  }

  // Derived display values
  const rul    = result ? Number(result.predicted_rul) : null
  const lo90   = result ? Number(result.lower_90  ?? result.lower_bound)  : null
  const hi90   = result ? Number(result.upper_90  ?? result.upper_bound)  : null
  const phase  = result ? String(result.phase)    : null
  const phaseMeta = phase ? (PHASE_META[phase] ?? PHASE_META.Aging) : null
  const maxRul = MAX_RUL[chem]

  return (
    <div className="p-3 sm:p-6 max-w-4xl mx-auto space-y-5">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-text-primary">Live Prediction</h1>
        <p className="text-sm text-text-muted mt-0.5">Enter cell parameters → get RUL with 90% confidence interval</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

        {/* ── LEFT: Input form (3 cols) ──────────────────────── */}
        <div className="lg:col-span-3 space-y-5">

          {/* Chemistry selector */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Battery Chemistry</div>
            <div className="flex flex-wrap gap-2">
              {CHEMISTRIES.map(c => (
                <button key={c} onClick={() => setChem(c)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all border ${
                    chem === c ? 'border-transparent text-white' : 'border-border-subtle text-text-secondary hover:border-opacity-50'
                  }`}
                  style={chem === c ? { background: CHEM_META[c].color } : {}}
                >
                  {c}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-text-muted">{CHEM_META[chem].full}</div>
            <ModelSelector chemistry={chem} value={modelId} onChange={setModelId} />
          </div>

          {/* Cell specification — nominal values set by user */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Cell Specification</div>
              <span className="text-[10px] px-2 py-0.5 rounded bg-brand-blue/10 text-brand-blue">enter your cell's nameplate values</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[10px] text-text-muted font-medium uppercase tracking-wide">Nominal Capacity (Ah)</label>
                <input type="number" value={nomCap} min={0.1} max={500} step={0.1}
                  onChange={e => setNomCap(parseFloat(e.target.value) || 1)}
                  className="w-full px-3 py-2 text-sm font-mono bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              </div>
              <div className="space-y-1">
                <label className="text-[10px] text-text-muted font-medium uppercase tracking-wide">Nominal Voltage (V)</label>
                <input type="number" value={nomV} min={2.0} max={4.5} step={0.01}
                  onChange={e => setNomV(parseFloat(e.target.value) || 3.7)}
                  className="w-full px-3 py-2 text-sm font-mono bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              </div>
            </div>
            <div className="text-[10px] text-text-muted">
              Nominal energy: <span className="text-text-secondary font-mono">{(nomCap * nomV).toFixed(1)} Wh</span>
              {nomCap >= 5 && <span className="ml-2 text-amber-400">Large-format cell — IR shown in mΩ</span>}
            </div>
          </div>

          {/* Quick scenarios */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Quick Scenarios</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {SCENARIOS.map(s => (
                <button key={s.label} onClick={() => applyScenario(s)}
                  className="flex flex-col items-center gap-1 p-2.5 rounded-lg border border-border-subtle hover:bg-bg-panel transition-all text-center">
                  <span className="w-2.5 h-2.5 rounded-full" style={{ background: s.color }} />
                  <span className="text-[10px] font-medium text-text-secondary">{s.label}</span>
                  <span className="text-[10px] text-text-muted font-mono">{s.soh}%</span>
                </button>
              ))}
            </div>
          </div>

          {/* Input sliders — SOH and Capacity are independent BMS measurements */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">BMS Measurements</div>
              <span className="text-[10px] text-text-muted px-2 py-0.5 rounded bg-bg-panel border border-border-subtle">
                enter values from your BMS independently
              </span>
            </div>
            <NumInput
              label="State of Health" unit="(%)"
              value={soh} min={10} max={100} step={1}
              onChange={setSoh}
            />
            <NumInput
              label="Measured Capacity" unit="(Ah)"
              value={cap}
              min={+(nomCap * 0.05).toFixed(1)}
              max={+(nomCap * 1.10).toFixed(1)}
              step={+(nomCap * 0.005).toFixed(3)}
              onChange={setCap}
            />
            <NumInput
              label={`Internal Resistance (${irUnit})`} unit=""
              value={irDisplay}
              min={irIsLarge ? 0.1 : 0.001} max={irIsLarge ? 50 : 0.30} step={irIsLarge ? 0.1 : 0.001}
              onChange={v => setIr(irToOhm(v))}
            />
            <NumInput label="Temperature" unit="(°C)" value={temp} min={-10} max={60} step={1} onChange={setTemp} />
          </div>

          {/* Advanced: DoD + cold-start */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
            <button onClick={() => setShowAdvanced(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 text-xs font-semibold text-text-muted uppercase tracking-widest hover:bg-bg-panel transition-colors">
              <span>Operating Conditions <span className="normal-case font-normal text-text-muted/70">(DoD, cold-start)</span></span>
              <span className="text-lg leading-none">{showAdvanced ? '−' : '+'}</span>
            </button>
            {showAdvanced && (
              <div className="px-4 pb-4 space-y-4 border-t border-border-subtle pt-3">
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-text-muted font-medium uppercase tracking-wide">
                      Depth of Discharge (%)
                    </label>
                    <button onClick={() => setDod(null)}
                      className="text-[10px] text-brand-blue hover:underline">{dod === null ? '100% (default)' : 'reset'}</button>
                  </div>
                  <input type="range" min={10} max={100} step={5}
                    value={dod ?? 100}
                    onChange={e => setDod(Number(e.target.value) >= 100 ? null : Number(e.target.value))}
                    className="w-full h-1 accent-brand-blue cursor-pointer" />
                  <div className="flex justify-between text-[10px] text-text-muted">
                    <span>10%</span>
                    <span className="font-mono text-text-secondary">{dod === null ? '100% DoD' : `${dod}% DoD`}</span>
                    <span>100%</span>
                  </div>
                  {dod !== null && dod < 100 && (
                    <div className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-1 rounded">
                      RUL will be scaled up — cell lasts longer at partial DoD. CI widens to reflect model uncertainty.
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] text-text-muted font-medium uppercase tracking-wide">
                      Observed Cycles
                    </label>
                    <button onClick={() => setNCycles(null)}
                      className="text-[10px] text-brand-blue hover:underline">{nCycles === null ? '≥30 (default)' : 'reset'}</button>
                  </div>
                  <input type="range" min={0} max={30} step={1}
                    value={nCycles ?? 30}
                    onChange={e => setNCycles(Number(e.target.value) >= 30 ? null : Number(e.target.value))}
                    className="w-full h-1 accent-amber-400 cursor-pointer" />
                  <div className="flex justify-between text-[10px] text-text-muted">
                    <span>0</span>
                    <span className="font-mono text-text-secondary">{nCycles === null ? '≥30 cycles' : `${nCycles} cycles observed`}</span>
                    <span>30+</span>
                  </div>
                  {nCycles !== null && nCycles < 30 && (
                    <div className="text-[10px] text-amber-400 bg-amber-500/10 px-2 py-1 rounded">
                      Cold-start: {Math.round((1 - Math.min(1, (nCycles / 30) ** 1.5)) * 100)}% prior blend. CI ×{(1 + 1.5 * (1 - Math.min(1, (nCycles / 30) ** 1.5))).toFixed(2)}.
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Predict button */}
          <button onClick={predict} disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-3 bg-brand-blue text-white font-semibold text-sm rounded-xl hover:bg-blue-500 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
            {loading
              ? <><RefreshCw size={16} className="animate-spin" /> Running inference…</>
              : <><Zap size={16} /> Predict RUL</>}
          </button>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
              <AlertTriangle size={13} /> {error}
            </div>
          )}
        </div>

        {/* ── RIGHT: Result card (2 cols) ────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <AnimatePresence mode="wait">
            {!ran ? (
              <motion.div key="empty"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="bg-bg-secondary border border-dashed border-border-subtle rounded-xl p-8 flex flex-col items-center justify-center gap-3 text-center min-h-64">
                <Zap size={28} className="text-text-muted" />
                <div className="text-sm text-text-muted">Set parameters and click Predict RUL</div>
                <div className="text-xs text-text-muted">90% conformal prediction interval included</div>
              </motion.div>
            ) : result && rul !== null && lo90 !== null && hi90 !== null && phase && phaseMeta ? (
              <motion.div key="result"
                initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                className="space-y-4"
              >
                {/* Main result card */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-5 space-y-4">

                  {/* Gauge + RUL number */}
                  <div className="flex items-center gap-4">
                    <SohGauge pct={soh} color={phaseMeta.color} />
                    <div className="flex-1">
                      <div className="text-[10px] text-text-muted mb-1">Predicted RUL</div>
                      <div className="text-4xl font-bold font-mono" style={{ color: phaseMeta.color }}>
                        <AnimCounter target={rul} />
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">cycles remaining</div>
                      <div className="mt-2">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold"
                          style={{ background: phaseMeta.color + '20', color: phaseMeta.color }}>
                          {phase}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Confidence bar */}
                  <ConfidenceBar rul={rul} lo={lo90} hi={hi90} maxRul={maxRul} />

                  {/* Key metrics */}
                  <div className="grid grid-cols-2 gap-2 pt-1">
                    {[
                      { label: 'Chemistry', value: chem },
                      { label: 'Model',     value: modelId },
                      { label: 'Lower 90%', value: `${lo90} cyc` },
                      { label: 'Upper 90%', value: `${hi90} cyc` },
                    ].map(({ label, value }) => (
                      <div key={label} className="bg-bg-panel rounded-lg p-2">
                        <div className="text-[9px] text-text-muted uppercase tracking-wide">{label}</div>
                        <div className="text-xs font-mono text-text-primary mt-0.5">{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* History provenance badge (always shown) */}
                  {result && (
                    <div className="pt-1">
                      <span
                        title={result.history_source === 'measured'
                          ? `Model saw ${result.n_observed_cycles ?? ''} real measured cycles`
                          : 'No cycle history supplied — the 30-cycle window was synthesized from this single snapshot, so the model cannot see the cell’s true degradation trajectory. Upload multiple cycles for a measured prediction.'}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border ${
                          result.history_source === 'measured'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                        {result.history_source === 'measured'
                          ? `✓ measured history (${result.n_observed_cycles}c)`
                          : '⚠ synthesized window (single snapshot)'}
                      </span>
                    </div>
                  )}

                  {/* Adjustment badges */}
                  {result && (result.dod_multiplier || result.cold_start || result.ci_temp_widened) && (
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {result.dod_multiplier && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                          DoD ×{Number(result.dod_multiplier).toFixed(2)}
                          <span className="text-emerald-400/60">(CI ×{Number(result.dod_ci_factor ?? 1).toFixed(2)})</span>
                        </span>
                      )}
                      {result.cold_start && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 text-amber-400 border border-amber-500/20">
                          {String(result.cold_start)}
                        </span>
                      )}
                      {result.ci_temp_widened && (
                        <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          Temp CI ×{Number(result.ci_temp_widened).toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Action card */}
                <div className="rounded-xl border p-4 space-y-1.5"
                  style={{ background: phaseMeta.color + '08', borderColor: phaseMeta.color + '30' }}>
                  <div className="flex items-center gap-2 text-xs font-semibold"
                    style={{ color: phaseMeta.color }}>
                    {phase === 'Fresh' || phase === 'Aging'
                      ? <CheckCircle2 size={13} />
                      : <AlertTriangle size={13} />}
                    Recommended Action
                  </div>
                  <p className="text-xs text-text-secondary">{phaseMeta.action}</p>
                </div>

                {/* Model info */}
                <div className="flex items-start gap-2 p-3 bg-bg-secondary border border-border-subtle rounded-xl text-[10px] text-text-muted">
                  <Info size={11} className="text-brand-blue flex-shrink-0 mt-0.5" />
                  MambaRUL v10-final · CALCE-LCO RMSE=20 cycles · 90% bands calibrated on held-out cells
                </div>

                {/* Export */}
                <button
                  onClick={() => {
                    const blob = new Blob([JSON.stringify({ inputs: { chem, soh, cap, ir, temp }, result }, null, 2)], { type: 'application/json' })
                    const a = document.createElement('a')
                    a.href = URL.createObjectURL(blob)
                    a.download = `rul_prediction_${chem}_${Date.now()}.json`; a.click()
                  }}
                  className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg transition-all"
                >
                  <Download size={12} /> Export prediction JSON
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

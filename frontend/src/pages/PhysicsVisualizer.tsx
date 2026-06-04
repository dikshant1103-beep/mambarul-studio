/**
 * PhysicsVisualizer.tsx
 * SEI growth, ICA peak tracker, Arrhenius temperature acceleration.
 */
import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { FlaskConical, Thermometer, TrendingDown } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

type TabId = 'sei' | 'ica' | 'arrhenius'

// SEI growth model: thickness ∝ √(cycle) (diffusion-limited)
function seiModel(cycles: number[], temp: number) {
  const k0 = 0.001; const Ea = 0.5; const R = 8.314e-3
  const kT = k0 * Math.exp(-Ea / (R * (273 + temp)))
  return cycles.map(c => kT * Math.sqrt(c))
}

// Capacity fade from SEI: Q = Q0 * (1 - SEI_thickness * alpha)
function capFade(cycles: number[], temp: number) {
  const sei = seiModel(cycles, temp)
  const alpha = 0.15
  return sei.map(s => Math.max(0.5, 1 - s * alpha))
}

// Arrhenius: t_life(T) = t_ref * exp(Ea/R * (1/T - 1/T_ref))
function arrheniusLife(temps: number[], t_ref: number, T_ref: number, Ea: number) {
  const R = 8.314e-3  // kJ/mol/K
  return temps.map(T => t_ref * Math.exp((Ea / R) * (1 / (T_ref + 273) - 1 / (T + 273))))
}

export default function PhysicsVisualizer() {
  const [tab, setTab] = useState<TabId>('sei')
  const [seiTemp, setSeiTemp] = useState(25)
  const [icaCycle, setIcaCycle] = useState(0)
  const [icaPlaying, setIcaPlaying] = useState(false)
  const icaRef = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    if (icaPlaying) {
      icaRef.current = setInterval(() => {
        setIcaCycle(c => { if (c >= 300) { setIcaPlaying(false); return 300 } return c + 5 })
      }, 100)
    } else clearInterval(icaRef.current)
    return () => clearInterval(icaRef.current)
  }, [icaPlaying])

  const cycles = Array.from({ length: 60 }, (_, i) => i * 5)
  const V = Array.from({ length: 80 }, (_, i) => 2.5 + i * 0.025)

  // SEI data for multiple temperatures
  const temps = [15, 25, 35, 45, 55]
  const tempColors = ['#60a5fa','#3b82f6','#f59e0b','#f97316','#ef4444']

  // ICA current peak
  const freshPeak = V.map(v => Math.exp(-Math.pow((v - 3.85) / 0.07, 2)) * 2.0)
  const agedPeak  = V.map(v => Math.exp(-Math.pow((v - 3.83) / 0.09, 2)) * (2.0 * Math.exp(-icaCycle * 0.004) + 0.05))

  // Arrhenius
  const arrhTemps = Array.from({ length: 50 }, (_, i) => i + 10)
  const lifetimes_LCO = arrheniusLife(arrhTemps, 300, 25, 12.0)
  const lifetimes_NMC = arrheniusLife(arrhTemps, 550, 25, 14.0)
  const lifetimes_LFP = arrheniusLife(arrhTemps, 1500, 25, 10.0)

  const TABS = [
    { id: 'sei' as TabId, label: 'SEI Growth Model', icon: FlaskConical },
    { id: 'ica' as TabId, label: 'IC Peak Tracker', icon: TrendingDown },
    { id: 'arrhenius' as TabId, label: 'Arrhenius Degradation', icon: Thermometer },
  ]

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <FlaskConical size={22} className="text-brand-emerald" />
          <h1 className="text-2xl font-bold text-text-primary">Physics Visualizer</h1>
        </div>
        <p className="text-text-secondary">SEI growth kinetics · IC peak evolution · Arrhenius temperature acceleration — battery degradation physics</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${tab === t.id ? 'border-brand-emerald text-emerald-400' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>

        {/* ── SEI GROWTH ─────────────────────────────────────────────────── */}
        {tab === 'sei' && (
          <div className="space-y-5">
            <div className="panel p-4 border-emerald-500/20 bg-emerald-500/5">
              <p className="text-sm text-text-secondary">
                <strong className="text-emerald-400">Solid Electrolyte Interface (SEI)</strong> grows on the anode surface each cycle.
                Growth is diffusion-limited → thickness ∝ √(cycles). Temperature accelerates formation via Arrhenius kinetics.
                SEI consumes lithium inventory and increases internal resistance.
              </p>
              <div className="mt-2 font-mono text-xs text-emerald-300 bg-bg-elevated rounded px-3 py-1.5">
                δ_SEI(t) = k₀ · exp(−Ea/RT) · √(t)   →   Q(t) = Q₀ · (1 − α·δ_SEI)
              </div>
            </div>

            <div>
              <div className="flex items-center gap-4 mb-3">
                <div className="metric-label">Temperature:</div>
                <input type="range" min={10} max={55} value={seiTemp} onChange={e => setSeiTemp(+e.target.value)}
                  className="flex-1 max-w-xs accent-emerald-400" />
                <span className="font-mono font-bold text-emerald-400 w-16">{seiTemp}°C</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="panel p-5">
                <h3 className="section-title mb-3">SEI Thickness Growth vs Cycles</h3>
                <Plot
                  data={temps.map((T, i) => ({
                    type: 'scatter' as const, mode: 'lines' as const, name: `${T}°C`,
                    x: cycles, y: seiModel(cycles, T),
                    line: { color: tempColors[i], width: T === seiTemp ? 3 : 1.5, dash: T === seiTemp ? 'solid' : 'dash' },
                  }))}
                  layout={{ ...darkLayout, height: 250,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'SEI Thickness (a.u.)', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>
              <div className="panel p-5">
                <h3 className="section-title mb-3">Capacity Fade from SEI</h3>
                <Plot
                  data={temps.map((T, i) => ({
                    type: 'scatter' as const, mode: 'lines' as const, name: `${T}°C`,
                    x: cycles, y: capFade(cycles, T).map(v => v * 100),
                    line: { color: tempColors[i], width: T === seiTemp ? 3 : 1.5, dash: T === seiTemp ? 'solid' : 'dash' },
                  }))}
                  layout={{ ...darkLayout, height: 250,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'SOH (%)', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>
            </div>

            <div className="panel p-4">
              <div className="text-xs text-text-muted">
                At {seiTemp}°C, predicted SOH after 100 cycles: <strong className="text-emerald-400">{(capFade([100], seiTemp)[0] * 100).toFixed(1)}%</strong>
                {' '}· Cycle life to 80% SOH: <strong className="text-emerald-400">{Math.round(Math.pow((0.2 / (0.15 * 0.001 * Math.exp(-0.5/(8.314e-3*(273+seiTemp))))), 2))} cycles (est.)</strong>
              </div>
            </div>
          </div>
        )}

        {/* ── ICA PEAK TRACKER ──────────────────────────────────────────── */}
        {tab === 'ica' && (
          <div className="space-y-5">
            <div className="panel p-4 border-blue-500/20 bg-blue-500/5">
              <p className="text-sm text-text-secondary">
                <strong className="text-blue-400">Incremental Capacity Analysis (ICA):</strong> dQ/dV reveals electrochemical phase transitions.
                For LCO, peaks at ~3.85V and ~4.05V correspond to graphite staging. As cells degrade, peaks broaden and shrink.
                Peak height and area are MambaRUL IC features used in v10-final.
              </p>
            </div>

            <div className="panel p-5">
              <div className="flex items-center gap-4 mb-4">
                <div>
                  <div className="metric-label mb-1">Cycle Number</div>
                  <div className="text-2xl font-mono font-bold text-brand-blue">{icaCycle}</div>
                </div>
                <input type="range" min={0} max={300} step={5} value={icaCycle}
                  onChange={e => setIcaCycle(+e.target.value)}
                  className="flex-1 accent-brand-blue" />
                <button onClick={() => { setIcaCycle(0); setIcaPlaying(true) }}
                  className="btn-primary text-sm px-4">
                  {icaPlaying ? '⏸ Pause' : '▶ Animate'}
                </button>
              </div>

              <Plot
                data={[
                  { type: 'scatter', mode: 'lines', name: 'Fresh (cycle 0)',
                    x: V, y: freshPeak, line: { color: '#3b82f6', width: 2.5 } },
                  { type: 'scatter', mode: 'lines', name: `Aged (cycle ${icaCycle})`,
                    x: V, y: agedPeak, line: { color: '#ef4444', width: 2 },
                    fill: 'tozeroy', fillcolor: '#ef444411' },
                ]}
                layout={{ ...darkLayout, height: 300,
                  xaxis: { ...darkLayout.xaxis as object, title: { text: 'Voltage (V)', font: { color: '#64748b' } }, range: [2.5, 4.4] },
                  yaxis: { ...darkLayout.yaxis as object, title: { text: '|dQ/dV| (Ah/V)', font: { color: '#64748b' } } },
                  annotations: [
                    { x: 3.85, y: 2.1, text: 'Peak 1\n(Graphite stage 2→1)', font: { color: '#3b82f6', size: 10 }, showarrow: false },
                    { x: 4.05, y: 1.3, text: 'Peak 2', font: { color: '#3b82f6', size: 10 }, showarrow: false },
                  ],
                } as Plotly.Layout}
                config={plotConfig} style={{ width: '100%' }}
              />

              <div className="grid grid-cols-3 gap-3 mt-4">
                <div className="bg-bg-elevated rounded-lg p-3 border border-border-subtle text-center">
                  <div className="metric-label">Peak Height</div>
                  <div className="font-mono text-xl font-bold text-blue-400">
                    {(Math.exp(-icaCycle * 0.004) * 2.0 + 0.05).toFixed(3)}
                  </div>
                  <div className="text-xs text-text-muted">Ah/V</div>
                </div>
                <div className="bg-bg-elevated rounded-lg p-3 border border-border-subtle text-center">
                  <div className="metric-label">Peak Shift</div>
                  <div className="font-mono text-xl font-bold text-amber-400">
                    -{(icaCycle * 0.00067).toFixed(3)}V
                  </div>
                  <div className="text-xs text-text-muted">vs fresh</div>
                </div>
                <div className="bg-bg-elevated rounded-lg p-3 border border-border-subtle text-center">
                  <div className="metric-label">SOH Proxy</div>
                  <div className="font-mono text-xl font-bold text-emerald-400">
                    {Math.max(50, (100 - icaCycle * 0.17)).toFixed(1)}%
                  </div>
                  <div className="text-xs text-text-muted">estimated</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── ARRHENIUS ─────────────────────────────────────────────────── */}
        {tab === 'arrhenius' && (
          <div className="space-y-5">
            <div className="panel p-4 border-red-500/20 bg-red-500/5">
              <p className="text-sm text-text-secondary">
                <strong className="text-red-400">Arrhenius Temperature Acceleration:</strong> degradation rate follows
                k(T) = k₀ · exp(−Ea/RT). Higher temperature exponentially accelerates aging.
                This explains why TJU cells at 45°C degrade much faster than CALCE cells at 25°C.
              </p>
              <div className="mt-2 font-mono text-xs text-red-300 bg-bg-elevated rounded px-3 py-1.5">
                t_life(T) = t_ref · exp(Ea/R · (1/T_ref − 1/T))    [Ea ≈ 10–15 kJ/mol for Li-ion]
              </div>
            </div>

            <div className="panel p-5">
              <h3 className="section-title mb-4">Predicted Cycle Life vs Temperature</h3>
              <Plot
                data={[
                  { type: 'scatter', mode: 'lines', name: 'LCO (CALCE, Ea=12)', x: arrhTemps, y: lifetimes_LCO, line: { color: '#3b82f6', width: 2.5 } },
                  { type: 'scatter', mode: 'lines', name: 'NMC (KJTU, Ea=14)', x: arrhTemps, y: lifetimes_NMC, line: { color: '#f59e0b', width: 2 } },
                  { type: 'scatter', mode: 'lines', name: 'LFP (MIT, Ea=10)', x: arrhTemps, y: lifetimes_LFP, line: { color: '#10b981', width: 2 } },
                ]}
                layout={{ ...darkLayout, height: 320,
                  xaxis: { ...darkLayout.xaxis as object, title: { text: 'Temperature (°C)', font: { color: '#64748b' } } },
                  yaxis: { ...darkLayout.yaxis as object, title: { text: 'Predicted Cycle Life', font: { color: '#64748b' } } },
                  shapes: [
                    { type: 'line', x0: 25, x1: 25, y0: 0, y1: 6000, line: { color: '#64748b', dash: 'dot', width: 1.5 } },
                    { type: 'line', x0: 45, x1: 45, y0: 0, y1: 6000, line: { color: '#ef4444', dash: 'dot', width: 1.5 } },
                  ],
                  annotations: [
                    { x: 25, y: 5800, text: '25°C\n(CALCE standard)', font: { color: '#64748b', size: 9 }, showarrow: false },
                    { x: 45, y: 5800, text: '45°C\n(TJU cells)', font: { color: '#ef4444', size: 9 }, showarrow: false },
                  ],
                } as Plotly.Layout}
                config={plotConfig} style={{ width: '100%' }}
              />
            </div>

            <div className="panel p-5">
              <h3 className="section-title mb-3">Temperature Acceleration Factor vs 25°C</h3>
              <div className="grid grid-cols-4 gap-3">
                {[15, 25, 35, 45, 55].map(T => {
                  const factor = Math.exp((12 / 8.314e-3) * (1 / (25 + 273) - 1 / (T + 273)))
                  return (
                    <div key={T} className="rounded-lg p-3 border text-center"
                      style={{ borderColor: T > 35 ? '#ef444444' : T < 25 ? '#10b98144' : '#3b82f644' }}>
                      <div className="font-mono font-bold text-lg" style={{ color: T > 35 ? '#ef4444' : T < 25 ? '#10b981' : '#3b82f6' }}>{T}°C</div>
                      <div className="text-xs text-text-muted mt-0.5">factor</div>
                      <div className="font-mono font-bold" style={{ color: T > 35 ? '#ef4444' : '#94a3b8' }}>{factor.toFixed(2)}×</div>
                      <div className="text-xs text-text-muted">{factor < 1 ? 'slower' : factor > 1 ? 'faster' : 'ref'}</div>
                    </div>
                  )
                })}
              </div>
              <p className="text-xs text-text-muted mt-3">At 45°C, LCO degrades ~{Math.exp((12/8.314e-3)*(1/298-1/318)).toFixed(1)}× faster than at 25°C. This directly explains the TJU-NCM 45°C cells aging faster.</p>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}

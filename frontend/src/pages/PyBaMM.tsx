import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { FlaskConical } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

interface PyCell { cell_id: string; chemistry: string; lifetime_cycles: number; n_snapshots: number; cycles: number[]; capacity: number[]; soh_pct: number[]; rul: number[] }
interface PyData { n_cells: number; cells: PyCell[]; description: string }

const PALETTE = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#06b6d4','#ef4444','#ec4899','#84cc16','#f97316','#14b8a6','#a78bfa','#fb923c','#34d399','#60a5fa','#fbbf24','#818cf8','#4ade80','#38bdf8','#c084fc','#fb7185']

function EnsembleV4Visual() {
  const sohValues = Array.from({ length: 20 }, (_, i) => (i + 1) * 0.05)
  const weight_v3b = sohValues.map(s => 1 / (1 + Math.exp(-10 * (0.7 - s))))
  const weight_v2  = sohValues.map((_, i) => 1 - weight_v3b[i])

  return (
    <div>
      <div className="text-xs text-text-muted mb-2">w = σ((0.7−SOH)×10) blends v2 and v3b</div>
      <Plot
        data={[
          { type: 'scatter', mode: 'lines', name: 'w(v3b) — IC features', x: sohValues, y: weight_v3b, line: { color: '#10b981', width: 2 }, fill: 'tozeroy', fillcolor: '#10b98122' },
          { type: 'scatter', mode: 'lines', name: 'w(v2) — standard', x: sohValues, y: weight_v2, line: { color: '#3b82f6', width: 2, dash: 'dash' } },
        ]}
        layout={{ ...darkLayout, height: 200,
          margin: { t: 10, b: 50, l: 50, r: 10 },
          xaxis: { ...darkLayout.xaxis as object, title: { text: 'SOH (cap_pct)', font: { color: '#64748b' } }, autorange: 'reversed' },
          yaxis: { ...darkLayout.yaxis as object, title: { text: 'Blend weight', font: { color: '#64748b' } }, range: [0, 1.1] },
          annotations: [
            { x: 0.7, y: 0.5, text: 'Knee (70% SoH)\nswitch point', showarrow: true, arrowhead: 2, arrowcolor: '#f59e0b', font: { color: '#f59e0b', size: 10 }, ax: 40, ay: -30 },
          ],
        } as Plotly.Layout}
        config={{ ...plotConfig, displayModeBar: false }} style={{ width: '100%' }}
      />
    </div>
  )
}

export default function PyBaMM() {
  const [data, setData] = useState<PyData | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Set<string>>(new Set(['PyBaMM_NMC_00','PyBaMM_NMC_04','PyBaMM_NMC_08']))
  const [metric, setMetric] = useState<'soh_pct'|'capacity'|'rul'>('soh_pct')
  const [tab, setTab] = useState<'pybamm'|'ensemble'>('pybamm')

  useEffect(() => {
    fetch('/api/pybamm/cells').then(r => r.ok ? r.json() : null)
      .then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const toggleCell = (cid: string) => setSelected(prev => {
    const next = new Set(prev)
    next.has(cid) ? next.delete(cid) : next.size < 8 ? next.add(cid) : null
    return next
  })

  const cells = data?.cells ?? []
  const selCells = cells.filter(c => selected.has(c.cell_id))

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <FlaskConical size={22} className="text-brand-purple" />
          <h1 className="text-2xl font-bold text-text-primary">PyBaMM Synthetic Cells + Ensemble v4</h1>
        </div>
        <p className="text-text-secondary">20 physics-simulated NMC cells (DFN model) used in MambaRUL v10 training · Region-aware ensemble visualization</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {[{id:'pybamm',label:'PyBaMM Synthetic Explorer'},{id:'ensemble',label:'Region-Aware Ensemble v4'}].map(t => (
          <button key={t.id} onClick={() => setTab(t.id as typeof tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${tab === t.id ? 'border-brand-purple text-purple-400' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>

        {tab === 'pybamm' ? (
          <div className="space-y-5">
            <div className="panel p-4 border-purple-500/20 bg-purple-500/5">
              <p className="text-sm text-text-secondary">{data?.description ?? 'Loading…'}</p>
              <div className="flex gap-4 mt-2 text-xs font-mono text-text-muted">
                <span>DFN model: Doyle-Fuller-Newman electrochemical simulation</span>
                <span>20 cells · variable degradation rates</span>
                <span>NMC cathode · Graphite anode</span>
              </div>
            </div>

            {loading ? <SkeletonChart height={300} /> : (
              <>
                <div className="flex gap-5">
                  {/* Cell selector */}
                  <div className="w-56 flex-shrink-0 panel p-4">
                    <div className="metric-label mb-2">Select Cells (max 8)</div>
                    <div className="flex gap-1 mb-3">
                      {(['soh_pct','capacity','rul'] as const).map(m => (
                        <button key={m} onClick={() => setMetric(m)}
                          className={`flex-1 py-1 rounded text-xs transition-all ${metric === m ? 'bg-purple-500/20 text-purple-400' : 'text-text-muted hover:text-text-primary'}`}>
                          {m === 'soh_pct' ? 'SOH' : m === 'capacity' ? 'Cap' : 'RUL'}
                        </button>
                      ))}
                    </div>
                    <div className="space-y-0.5 max-h-72 overflow-y-auto">
                      {cells.map((c, ci) => (
                        <button key={c.cell_id} onClick={() => toggleCell(c.cell_id)}
                          className={`w-full text-left px-2 py-1.5 rounded text-xs transition-all flex items-center gap-2 ${selected.has(c.cell_id) ? 'bg-purple-500/20 text-purple-300' : 'text-text-muted hover:bg-bg-elevated'}`}>
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: PALETTE[ci % PALETTE.length] }} />
                          <span className="font-mono truncate">{c.cell_id}</span>
                          <span className="ml-auto text-text-muted">{c.lifetime_cycles.toLocaleString()}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Overlay chart */}
                  <div className="flex-1 panel p-5 min-w-0">
                    <h3 className="section-title mb-4">
                      {metric === 'soh_pct' ? 'SOH (%)' : metric === 'capacity' ? 'Capacity (Ah)' : 'RUL (cycles)'} — PyBaMM NMC Cells
                    </h3>
                    <Plot
                      data={selCells.map((c, ii) => ({
                        type: 'scatter' as const, mode: 'lines' as const,
                        name: c.cell_id,
                        x: c.cycles,
                        y: c[metric],
                        line: { color: PALETTE[ii % PALETTE.length], width: 2 },
                      }))}
                      layout={{ ...darkLayout, height: 320,
                        xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle (snapshot)', font: { color: '#64748b' } } },
                        yaxis: { ...darkLayout.yaxis as object, title: { text: metric === 'soh_pct' ? 'SOH (%)' : metric === 'capacity' ? 'Capacity (Ah)' : 'RUL', font: { color: '#64748b' } } },
                      } as Plotly.Layout}
                      config={plotConfig} style={{ width: '100%' }}
                    />
                  </div>
                </div>

                {/* Summary table */}
                <div className="panel p-5">
                  <h3 className="section-title mb-3">All 20 PyBaMM Cells — Summary</h3>
                  <div className="grid grid-cols-4 gap-2">
                    {cells.map((c, idx) => (
                      <div key={c.cell_id} className="bg-bg-elevated rounded-lg p-2.5 border border-border-subtle text-xs">
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: PALETTE[idx % PALETTE.length] }} />
                          <span className="font-mono text-text-secondary">{c.cell_id.replace('PyBaMM_NMC_','NMC#')}</span>
                        </div>
                        <div className="font-mono text-text-accent">{c.lifetime_cycles.toLocaleString()} cycles</div>
                        <div className="text-text-muted">{c.n_snapshots} snapshots</div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-text-muted mt-3">
                    10 pairs of cells with matching lifetimes — PyBaMM generates paired cells with same degradation parameters. Lifetime range: 799–5520 cycles.
                    Added to MambaRUL v10 training: Oxford ZS R² improved from +0.741 → +0.858.
                  </p>
                </div>
              </>
            )}
          </div>

        ) : (
          /* ── ENSEMBLE V4 ──────────────────────────────────────────── */
          <div className="space-y-5">
            <div className="panel p-4 border-emerald-500/20 bg-emerald-500/5">
              <p className="text-sm text-text-secondary">
                <strong className="text-emerald-400">Region-Aware Ensemble (v4):</strong> soft blending of v2 (standard 8 features)
                and v3b (12 features + selective ICA) weighted by degradation region. v3b gets more weight
                as cell approaches knee/EOL region. RMSE dropped from 84→77 cycles.
              </p>
            </div>

            <div className="panel p-5">
              <h3 className="section-title mb-2">Ensemble Blending Weight vs SOH</h3>
              <EnsembleV4Visual />
            </div>

            <div className="panel p-5">
              <h3 className="section-title mb-3">Ensemble Architecture</h3>
              <div className="grid grid-cols-3 gap-4">
                <div className="bg-bg-elevated rounded-xl p-4 border border-blue-500/30">
                  <div className="text-xs font-semibold text-blue-400 mb-2">v2 Model (8 features)</div>
                  <div className="text-xs text-text-secondary space-y-1">
                    <div>Standard Huber + EOL-weighted loss</div>
                    <div>Better for early-life (high SOH)</div>
                    <div>CALCE RMSE: 84.2</div>
                  </div>
                </div>
                <div className="flex flex-col items-center justify-center">
                  <div className="text-xs font-mono text-emerald-400 text-center">w = σ((0.7−SOH)×10)</div>
                  <div className="text-xs text-text-muted mt-1 text-center">Sigmoid gate at 70% SOH</div>
                  <div className="mt-2 text-xl">⟶</div>
                </div>
                <div className="bg-bg-elevated rounded-xl p-4 border border-emerald-500/30">
                  <div className="text-xs font-semibold text-emerald-400 mb-2">v3b Model (12 features)</div>
                  <div className="text-xs text-text-secondary space-y-1">
                    <div>+ Selective ICA/DVA features</div>
                    <div>Better for late-life (knee/EOL)</div>
                    <div>CALCE RMSE: 85.9</div>
                  </div>
                </div>
              </div>
              <div className="mt-4 rounded-lg p-3 bg-bg-elevated border border-border-subtle text-center">
                <div className="font-mono text-sm text-text-accent">ŷ_ensemble = w·ŷ_v3b + (1−w)·ŷ_v2</div>
                <div className="text-xs text-text-muted mt-1">Ensemble RMSE: 77.6 cycles (R²=0.722)</div>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {[
                { model: 'v2 alone', rmse: 84.2, r2: 0.648, color: '#3b82f6' },
                { model: 'v3b alone', rmse: 85.9, r2: 0.661, color: '#10b981' },
                { model: 'v4 ensemble', rmse: 77.6, r2: 0.722, color: '#f59e0b' },
              ].map(m => (
                <div key={m.model} className="panel p-4 text-center" style={{ borderColor: m.color + '44' }}>
                  <div className="text-xs font-semibold mb-2" style={{ color: m.color }}>{m.model}</div>
                  <div className="text-3xl font-mono font-bold text-text-accent">{m.rmse}</div>
                  <div className="text-sm text-text-muted">CALCE RMSE</div>
                  <div className="text-sm font-mono mt-1" style={{ color: m.color }}>R²={m.r2}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}

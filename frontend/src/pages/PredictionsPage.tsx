import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { TrendingUp, RefreshCw } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart, Skeleton } from '../components/ui/Skeleton'
import { ExportCSV } from '../components/ui/ExportButton'

const MODEL_COLORS: Record<string, string> = {
  mambarul: '#3b82f6', transformer: '#8b5cf6',
  lstm: '#10b981', gru: '#f59e0b',
}
const MODEL_LABELS: Record<string, string> = {
  mambarul: 'MambaRUL', transformer: 'Transformer',
  lstm: 'LSTM', gru: 'GRU',
}

interface CalcePred { cell_id: string; cycles: number[]; true_rul: (number|null)[]; models: Record<string, { predicted: (number|null)[]; rmse: number|null }> }
interface OxfordPred { cells: string[]; max_cycles: (number|null)[]; rmse_official: (number|null)[]; r2_official: (number|null)[] }
interface KSweep { k: number; cell7_r2: number; cell8_r2: number; combined_r2: number; method: string }

export default function PredictionsPage() {
  const [activeTab, setActiveTab] = useState<'calce'|'oxford'|'ksweep'>('calce')
  const [calceCell, setCalceCell] = useState<'CS2_37'|'CS2_38'>('CS2_37')
  const [calcePred, setCalcePred] = useState<CalcePred | null>(null)
  const [oxfordPred, setOxfordPred] = useState<OxfordPred | null>(null)
  const [ksweep, setKsweep] = useState<KSweep[]>([])
  const [simK, setSimK] = useState(0)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (activeTab === 'calce') {
      setLoading(true)
      fetch(`/api/predictions/calce?cell_id=${calceCell}`)
        .then(r => r.ok ? r.json() : null).then(setCalcePred).catch(() => {}).finally(() => setLoading(false))
    } else if (activeTab === 'oxford') {
      setLoading(true)
      fetch('/api/predictions/oxford')
        .then(r => r.ok ? r.json() : null).then(setOxfordPred).catch(() => {}).finally(() => setLoading(false))
    } else if (activeTab === 'ksweep' && !ksweep.length) {
      fetch('/api/predictions/oxford-ksweep')
        .then(r => r.ok ? r.json() : []).then(setKsweep).catch(() => {})
    }
  }, [activeTab, calceCell])

  // Simulated K-sweep effect
  const interpolateR2 = (k: number) => {
    const pts = ksweep
    if (!pts.length) return 0.911
    const before = pts.filter(p => p.k <= k).slice(-1)[0] ?? pts[0]
    const after  = pts.filter(p => p.k >= k)[0] ?? pts[pts.length - 1]
    if (before.k === after.k) return before.combined_r2
    const t = (k - before.k) / (after.k - before.k)
    return before.combined_r2 + t * (after.combined_r2 - before.combined_r2)
  }

  const exportCalce = calcePred ? calcePred.cycles.map((c, i) => {
    const row: Record<string, unknown> = { cycle: c, true_rul: calcePred.true_rul[i] }
    for (const [m, d] of Object.entries(calcePred.models)) row[`pred_${m}`] = d.predicted[i]
    return row
  }) : []

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <TrendingUp size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Predicted vs Actual RUL</h1>
        </div>
        <p className="text-text-secondary">All models on CALCE test cells · Oxford zero-shot · Interactive K-sweep deployment</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {(['calce','oxford','ksweep'] as const).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px capitalize ${
              activeTab === t ? 'border-brand-blue text-brand-blue' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}>{t === 'ksweep' ? 'Oxford K-Sweep Simulator' : t.toUpperCase()}</button>
        ))}
      </div>

      <motion.div key={activeTab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>

        {/* ── CALCE TAB ─────────────────────────────────────────────────────── */}
        {activeTab === 'calce' && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              {(['CS2_37','CS2_38'] as const).map(c => (
                <button key={c} onClick={() => setCalceCell(c)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${
                    calceCell === c ? 'bg-brand-blue text-white' : 'bg-bg-panel border border-border-subtle text-text-secondary'
                  }`}>{c}</button>
              ))}
              {loading && <RefreshCw size={15} className="text-brand-blue animate-spin" />}
              {calcePred && <ExportCSV data={exportCalce} filename={`predictions_${calceCell}.csv`} />}
            </div>

            {loading ? <SkeletonChart height={300} /> : calcePred ? (
              <>
                {/* RMSE badges */}
                <div className="flex gap-3 flex-wrap">
                  {Object.entries(calcePred.models).map(([m, d]) => (
                    <div key={m} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border-subtle bg-bg-panel">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: MODEL_COLORS[m] }} />
                      <span className="text-sm font-medium text-text-primary">{MODEL_LABELS[m]}</span>
                      <span className="font-mono text-sm text-text-accent">RMSE={d.rmse?.toFixed(1)}</span>
                    </div>
                  ))}
                </div>

                {/* Main chart */}
                <div className="panel p-5">
                  <h3 className="section-title mb-4">Predicted vs True RUL — {calceCell}</h3>
                  <Plot
                    data={[
                      {
                        type: 'scatter', mode: 'lines', name: 'True RUL',
                        x: calcePred.cycles, y: calcePred.true_rul,
                        line: { color: '#f1f5f9', width: 2.5, dash: 'dot' },
                      },
                      ...Object.entries(calcePred.models).map(([m, d]) => ({
                        type: 'scatter' as const, mode: 'lines' as const,
                        name: MODEL_LABELS[m],
                        x: calcePred.cycles, y: d.predicted,
                        line: { color: MODEL_COLORS[m], width: 1.8 },
                        connectgaps: false,
                      }))
                    ]}
                    layout={{ ...darkLayout, height: 320,
                      xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: 'RUL (cycles)', font: { color: '#64748b' } } },
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                </div>

                {/* Residuals */}
                <div className="panel p-5">
                  <h3 className="section-title mb-4">Prediction Error (Residuals)</h3>
                  <Plot
                    data={Object.entries(calcePred.models).map(([m, d]) => ({
                      type: 'scatter' as const, mode: 'lines' as const,
                      name: MODEL_LABELS[m],
                      x: calcePred.cycles,
                      y: d.predicted.map((p, i) => {
                        const t = calcePred.true_rul[i]
                        return p != null && t != null ? p - t : null
                      }),
                      line: { color: MODEL_COLORS[m], width: 1.5 },
                      connectgaps: false,
                    }))}
                    layout={{ ...darkLayout, height: 220,
                      xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: 'Residual (pred − true)', font: { color: '#64748b' } }, zeroline: true, zerolinecolor: '#ef4444', zerolinewidth: 1.5 },
                      shapes: [{ type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 0, y1: 0, line: { color: '#ef4444', width: 1, dash: 'dash' } }],
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                </div>

                {/* Scatter: pred vs true */}
                <div className="panel p-5">
                  <h3 className="section-title mb-4">Scatter: Predicted vs True (all models)</h3>
                  <Plot
                    data={[
                      { type: 'scatter', mode: 'lines', name: 'Perfect', x: [0, 310], y: [0, 310], line: { color: '#1e3a5f', dash: 'dash', width: 1.5 }, showlegend: true },
                      ...Object.entries(calcePred.models).map(([m, d]) => {
                        const pairs = d.predicted.map((p, i) => [p, calcePred.true_rul[i]]).filter(([p, t]) => p != null && t != null)
                        return {
                          type: 'scatter' as const, mode: 'markers' as const, name: MODEL_LABELS[m],
                          x: pairs.map(([, t]) => t), y: pairs.map(([p]) => p),
                          marker: { color: MODEL_COLORS[m], size: 5, opacity: 0.7 },
                        }
                      })
                    ]}
                    layout={{ ...darkLayout, height: 280,
                      xaxis: { ...darkLayout.xaxis as object, title: { text: 'True RUL', font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: 'Predicted RUL', font: { color: '#64748b' } } },
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                </div>
              </>
            ) : <div className="panel p-12 text-center text-text-muted">Loading predictions…</div>}
          </div>
        )}

        {/* ── OXFORD TAB ────────────────────────────────────────────────────── */}
        {activeTab === 'oxford' && (
          <div className="space-y-5">
            {loading ? <><SkeletonChart /><div className="space-y-2">{[1,2,3].map(i=><Skeleton key={i} className="h-12 w-full"/>)}</div></> :
             oxfordPred ? (
              <>
                <div className="grid grid-cols-3 gap-4">
                  {[
                    { label:'Cells Evaluated', value: oxfordPred.cells.length, color:'cyan' },
                    { label:'Best Cell R²', value: Math.max(...(oxfordPred.r2_official.filter(Boolean) as number[])).toFixed(3), color:'emerald' },
                    { label:'Mean R²', value: (((oxfordPred.r2_official.filter(Boolean) as number[]).reduce((a,b)=>a+b,0))/(oxfordPred.r2_official.filter(Boolean).length||1)).toFixed(3), color:'blue' },
                  ].map(s => (
                    <div key={s.label} className="panel p-4 text-center">
                      <div className="text-2xl font-mono font-bold text-text-accent">{s.value}</div>
                      <div className="text-xs text-text-muted mt-1">{s.label}</div>
                    </div>
                  ))}
                </div>

                <div className="panel p-5">
                  <h3 className="section-title mb-4">Oxford Zero-Shot Results per Cell</h3>
                  <Plot
                    data={[
                      {
                        type: 'bar', name: 'RMSE (cycles)',
                        x: oxfordPred.cells, y: oxfordPred.rmse_official,
                        marker: { color: '#3b82f6', opacity: 0.8 }, yaxis: 'y',
                      },
                      {
                        type: 'scatter', mode: 'lines+markers', name: 'R²',
                        x: oxfordPred.cells, y: oxfordPred.r2_official,
                        line: { color: '#10b981', width: 2 },
                        marker: { color: '#10b981', size: 8 }, yaxis: 'y2',
                      },
                    ]}
                    layout={{ ...darkLayout, height: 300, barmode: 'group',
                      xaxis: { ...darkLayout.xaxis as object, title: { text: 'Oxford Cell', font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: 'RMSE (cycles)', font: { color: '#3b82f6' } } },
                      yaxis2: { title: { text: 'R²', font: { color: '#10b981' } }, overlaying: 'y', side: 'right', gridcolor: 'transparent', zerolinecolor: '#1e3a5f', tickfont: { color: '#64748b', size: 10 } },
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                </div>

                <div className="panel p-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border-subtle">
                        {['Cell','Max Cycles','RMSE (cycles)','R²','Assessment'].map(h=>(
                          <th key={h} className="text-left pb-3 pr-4 text-xs text-text-muted uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {oxfordPred.cells.map((cell, i) => {
                        const r2 = oxfordPred.r2_official[i]
                        return (
                          <tr key={cell} className="border-b border-border-subtle/40">
                            <td className="py-2.5 pr-4 font-mono text-text-accent">{cell}</td>
                            <td className="py-2.5 pr-4 font-mono text-text-secondary">{oxfordPred.max_cycles[i]?.toLocaleString()}</td>
                            <td className="py-2.5 pr-4 font-mono text-text-secondary">{oxfordPred.rmse_official[i]?.toFixed(1)}</td>
                            <td className="py-2.5 pr-4 font-mono" style={{ color: r2 != null && r2 > 0.7 ? '#10b981' : r2 != null && r2 > 0 ? '#f59e0b' : '#ef4444' }}>{r2?.toFixed(3)}</td>
                            <td className="py-2.5">
                              <span className={`badge text-xs ${r2 != null && r2 > 0.7 ? 'badge-green' : r2 != null && r2 > 0 ? 'badge-amber' : 'badge-red'}`}>
                                {r2 != null && r2 > 0.7 ? 'Good' : r2 != null && r2 > 0 ? 'Fair' : 'Poor'}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            ) : <div className="panel p-12 text-center text-text-muted">Loading Oxford results…</div>}
          </div>
        )}

        {/* ── K-SWEEP SIMULATOR ─────────────────────────────────────────────── */}
        {activeTab === 'ksweep' && (
          <div className="space-y-5">
            <div className="panel p-6">
              <h3 className="section-title mb-1">Oxford Deployment K-Sweep Simulator</h3>
              <p className="text-xs text-text-muted mb-5">Drag K to simulate: how many calibration snapshots improve Oxford R²?</p>

              <div className="mb-4">
                <div className="flex justify-between mb-1.5">
                  <label className="text-sm font-medium text-text-primary">K = {simK} calibration snapshots</label>
                  <span className="font-mono text-lg font-bold text-brand-blue">R² = {interpolateR2(simK).toFixed(4)}</span>
                </div>
                <input type="range" min={0} max={30} step={1} value={simK}
                  onChange={e => setSimK(+e.target.value)}
                  className="w-full accent-brand-blue" />
                <div className="flex justify-between text-xs text-text-muted mt-1">
                  <span>0 (zero-shot)</span><span>15</span><span>20 (best)</span><span>25</span><span>30</span>
                </div>
              </div>

              {/* Status badge */}
              <div className="flex items-center gap-3">
                {simK === 0 && <span className="badge badge-blue">Zero-Shot — no calibration</span>}
                {simK === 20 && <span className="badge badge-green">Optimal K=20</span>}
                {simK > 20 && <span className="badge badge-red">Over-calibration — encoder drift</span>}
                {simK > 0 && simK < 20 && <span className="badge badge-amber">Sub-optimal calibration</span>}
                <span className="text-xs text-text-muted font-mono">
                  vs zero-shot: {(interpolateR2(simK) - 0.911 >= 0 ? '+' : '')}{(interpolateR2(simK) - 0.911).toFixed(4)} ΔR²
                </span>
              </div>
            </div>

            {ksweep.length > 0 && (
              <div className="panel p-5">
                <h3 className="section-title mb-4">K-Sweep Curve — v10-final (real data)</h3>
                <Plot
                  data={[
                    {
                      type: 'scatter', mode: 'lines+markers', name: 'Combined R²',
                      x: ksweep.map(k => k.k), y: ksweep.map(k => k.combined_r2),
                      line: { color: '#3b82f6', width: 2.5 }, marker: { size: 8, color: '#3b82f6' },
                    },
                    {
                      type: 'scatter', mode: 'lines+markers', name: 'Cell7 R²',
                      x: ksweep.map(k => k.k), y: ksweep.map(k => k.cell7_r2),
                      line: { color: '#10b981', width: 1.5, dash: 'dash' }, marker: { size: 6 },
                    },
                    {
                      type: 'scatter', mode: 'lines+markers', name: 'Cell8 R²',
                      x: ksweep.map(k => k.k), y: ksweep.map(k => k.cell8_r2),
                      line: { color: '#f59e0b', width: 1.5, dash: 'dash' }, marker: { size: 6 },
                    },
                    simK > 0 ? {
                      type: 'scatter' as const, mode: 'markers' as const, name: 'Current K',
                      x: [simK], y: [interpolateR2(simK)],
                      marker: { color: '#ef4444', size: 16, symbol: 'diamond', line: { color: '#fff', width: 2 } },
                    } : null,
                  ].filter(Boolean) as Plotly.Data[]}
                  layout={{ ...darkLayout, height: 300,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'K (calibration snapshots)', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'R²', font: { color: '#64748b' } }, range: [0.5, 1.0] },
                    annotations: [
                      { x: 0, y: 0.911, text: 'Zero-shot baseline', showarrow: true, arrowhead: 2, arrowcolor: '#06b6d4', font: { color: '#06b6d4', size: 10 }, ax: 50, ay: -20 },
                      { x: 20, y: 0.917, text: 'K=20 optimal', showarrow: true, arrowhead: 2, arrowcolor: '#10b981', font: { color: '#10b981', size: 10 }, ax: -30, ay: -30 },
                    ],
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
                <div className="mt-3 text-xs text-text-muted">
                  B1+D: only MLP head (8,321 params) trainable. Encoder frozen. K&gt;20 causes encoder drift.
                </div>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  )
}

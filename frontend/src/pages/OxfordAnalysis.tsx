import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Target } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonPanel } from '../components/ui/Skeleton'
import { ExportCSV } from '../components/ui/ExportButton'

type TabId = 'loocv' | 'earlypred' | 'anchor' | 'methods'

const TABS = [
  { id: 'loocv'    as TabId, label: 'Leave-One-Out CV' },
  { id: 'earlypred' as TabId, label: 'Early Prediction' },
  { id: 'anchor'   as TabId, label: 'Anchor Strategy' },
  { id: 'methods'  as TabId, label: 'M1–M6 Methods' },
]

interface Method {
  method: string; label: string
  oxford_rmse: number; oxford_r2: number
  calce_rmse: number; calce_r2: number
  cell7_rmse: number; cell7_r2: number
  cell8_rmse: number; cell8_r2: number
}

export default function OxfordAnalysis() {
  const [tab, setTab] = useState<TabId>('methods')
  const [loocv, setLoocv] = useState<Record<string, unknown>[] | null>(null)
  const [earlyPred, setEarlyPred] = useState<Record<string, unknown>[] | null>(null)
  const [anchor, setAnchor] = useState<Record<string, unknown>[] | null>(null)
  const [methods, setMethods] = useState<Method[] | null>(null)
  const [ksweep, setKsweep] = useState<Record<string, unknown>[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const endpoints: Record<TabId, string> = {
      loocv:    '/api/oxford/loocv',
      earlypred:'/api/oxford/early-prediction',
      anchor:   '/api/oxford/anchor-analysis',
      methods:  '/api/oxford/ksweep-final',
    }
    const alreadyLoaded = {
      loocv: !!loocv, earlypred: !!earlyPred, anchor: !!anchor, methods: !!methods
    }
    if (!alreadyLoaded[tab]) {
      setLoading(true)
      fetch(endpoints[tab]).then(r => r.ok ? r.json() : null)
        .then(d => {
          if (!d) return
          if (tab === 'loocv')     setLoocv(d.rows ?? [])
          else if (tab === 'earlypred') setEarlyPred(d.rows ?? [])
          else if (tab === 'anchor')   setAnchor(d.rows ?? [])
          else if (tab === 'methods') { setMethods(d.methods ?? []); setKsweep(d.ksweep ?? []) }
        }).catch(() => {}).finally(() => setLoading(false))
    }
  }, [tab])

  const loocvCells = loocv?.map(r => r.cell as string) ?? []
  const loocvR2    = loocv?.map(r => r.r2 as number) ?? []
  const epK       = earlyPred?.map(r => r.K as number) ?? []
  const epR2Cell7 = earlyPred?.map(r => r.Cell7_r2 as number) ?? []
  const epR2Cell8 = earlyPred?.map(r => r.Cell8_r2 as number) ?? []
  const epCombined= earlyPred?.map(r => r.Combined_r2 as number) ?? []
  const anchorCells= anchor?.map(r => r.cell as string) ?? []
  const anchorZSR2 = anchor?.map(r => r.zs_r2 as number) ?? []
  const anchorFtR2 = anchor?.map(r => r.fta_r2 as number) ?? []

  const METHOD_COLORS = ['#ef4444','#f59e0b','#3b82f6','#8b5cf6','#10b981','#06b6d4']

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Target size={22} className="text-brand-cyan" />
          <h1 className="text-2xl font-bold text-text-primary">Oxford Transfer Analysis</h1>
        </div>
        <p className="text-text-secondary">LOOCV · Early prediction · Anchor strategy · M1–M6 methods — deep dive into Oxford NMC 8000-cycle cells</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${tab === t.id ? 'border-brand-cyan text-brand-cyan' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
        {loading ? <SkeletonPanel /> : (

          // ── METHODS COMPARISON ────────────────────────────────────────────────
          tab === 'methods' ? (
            <div className="space-y-5">
              <div className="panel p-4 border-cyan-500/20 bg-cyan-500/5">
                <p className="text-sm text-text-secondary">
                  <strong className="text-cyan-400">M1–M6 systematic comparison:</strong> Starting from v8 zero-shot baseline through v9 with progressive fine-tuning.
                  M6 (50 snapshots deep fine-tune) achieves R²=0.995 on Oxford — from -1.447 to near-perfect.
                </p>
              </div>

              {methods && (
                <>
                  <div className="panel p-5">
                    <h3 className="section-title mb-4">Oxford R² — All Methods (Cell7 + Cell8 Combined)</h3>
                    <Plot
                      data={[{
                        type: 'bar',
                        x: methods.map(m => m.label),
                        y: methods.map(m => m.oxford_r2),
                        marker: { color: METHOD_COLORS, opacity: 0.85 },
                        text: methods.map(m => m.oxford_r2.toFixed(3)),
                        textposition: 'outside',
                      }]}
                      layout={{ ...darkLayout, height: 280,
                        margin: { t: 20, b: 60, l: 50, r: 30 },
                        shapes: [{ type: 'line', x0: -0.5, x1: 5.5, y0: 0, y1: 0, line: { color: '#475569', dash: 'dash', width: 1 } }],
                        xaxis: { ...darkLayout.xaxis as object, tickangle: -20 },
                        yaxis: { ...darkLayout.yaxis as object, title: { text: 'Oxford R²', font: { color: '#64748b' } } },
                      } as Plotly.Layout}
                      config={plotConfig} style={{ width: '100%' }}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-5">
                    <div className="panel p-5">
                      <h3 className="section-title mb-4">Cell7 vs Cell8 R²</h3>
                      <Plot
                        data={[
                          { type: 'bar', name: 'Cell7', x: methods.map(m => m.label), y: methods.map(m => m.cell7_r2),
                            marker: { color: '#3b82f6', opacity: 0.8 } },
                          { type: 'bar', name: 'Cell8', x: methods.map(m => m.label), y: methods.map(m => m.cell8_r2),
                            marker: { color: '#10b981', opacity: 0.8 } },
                        ]}
                        layout={{ ...darkLayout, height: 250, barmode: 'group', margin: { t: 10, b: 60, l: 50, r: 10 },
                          xaxis: { ...darkLayout.xaxis as object, tickangle: -20 },
                          yaxis: { ...darkLayout.yaxis as object, title: { text: 'R²', font: { color: '#64748b' } } },
                        } as Plotly.Layout}
                        config={{ ...plotConfig, displayModeBar: false }} style={{ width: '100%' }}
                      />
                    </div>

                    <div className="panel p-5">
                      <h3 className="section-title mb-4">Oxford RMSE (cycles)</h3>
                      <Plot
                        data={[{
                          type: 'bar',
                          x: methods.map(m => m.label),
                          y: methods.map(m => m.oxford_rmse),
                          marker: { color: METHOD_COLORS, opacity: 0.85 },
                          text: methods.map(m => m.oxford_rmse.toFixed(0)),
                          textposition: 'outside',
                        }]}
                        layout={{ ...darkLayout, height: 250, margin: { t: 10, b: 60, l: 60, r: 20 },
                          xaxis: { ...darkLayout.xaxis as object, tickangle: -20 },
                          yaxis: { ...darkLayout.yaxis as object, title: { text: 'RMSE (cycles)', font: { color: '#64748b' } }, autorange: 'reversed' },
                        } as Plotly.Layout}
                        config={{ ...plotConfig, displayModeBar: false }} style={{ width: '100%' }}
                      />
                    </div>
                  </div>

                  <div className="panel p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="section-title">Full Methods Table</h3>
                      <ExportCSV data={methods as unknown as Record<string,unknown>[]} filename="oxford_methods_comparison.csv" />
                    </div>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-border-subtle">
                          {['Method','Oxford RMSE','Oxford R²','CALCE RMSE','CALCE R²','Cell7 R²','Cell8 R²'].map(h => (
                            <th key={h} className="text-left pb-2 pr-3 text-text-muted uppercase tracking-wide font-medium">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {methods.map((m, i) => (
                          <tr key={i} className="border-b border-border-subtle/40">
                            <td className="py-1.5 pr-3 font-medium" style={{ color: METHOD_COLORS[i] }}>{m.label}</td>
                            <td className="py-1.5 pr-3 font-mono text-text-secondary">{m.oxford_rmse.toFixed(1)}</td>
                            <td className="py-1.5 pr-3 font-mono" style={{ color: m.oxford_r2 > 0.5 ? '#10b981' : m.oxford_r2 > 0 ? '#f59e0b' : '#ef4444' }}>{m.oxford_r2.toFixed(3)}</td>
                            <td className="py-1.5 pr-3 font-mono text-text-secondary">{m.calce_rmse.toFixed(2)}</td>
                            <td className="py-1.5 pr-3 font-mono text-text-secondary">{m.calce_r2.toFixed(3)}</td>
                            <td className="py-1.5 pr-3 font-mono" style={{ color: m.cell7_r2 > 0 ? '#10b981' : '#ef4444' }}>{m.cell7_r2.toFixed(3)}</td>
                            <td className="py-1.5 font-mono" style={{ color: m.cell8_r2 > 0 ? '#10b981' : '#ef4444' }}>{m.cell8_r2.toFixed(3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {ksweep && ksweep.length > 0 && (
                    <div className="panel p-5">
                      <h3 className="section-title mb-4">K-Sweep: Calibration Size vs R² (v8 + v9)</h3>
                      <Plot
                        data={['v8', 'v9'].map((model, mi) => {
                          const rows = ksweep.filter(r => r.model === model)
                          const cells = [...new Set(rows.map(r => r.cell as string))]
                          return cells.map((cell, ci) => {
                            const pts = rows.filter(r => r.cell === cell)
                            return {
                              type: 'scatter' as const, mode: 'lines+markers' as const,
                              name: `${model} ${cell}`,
                              x: pts.map(r => r.calib_size as number),
                              y: pts.map(r => r.ft_r2 as number),
                              line: { color: mi === 0 ? '#3b82f6' : '#10b981', dash: (ci === 0 ? 'solid' : 'dash') as 'solid'|'dash', width: 2 },
                              marker: { size: 7 },
                            }
                          })
                        }).flat()}
                        layout={{ ...darkLayout, height: 260,
                          xaxis: { ...darkLayout.xaxis as object, title: { text: 'K (calibration snapshots)', font: { color: '#64748b' } } },
                          yaxis: { ...darkLayout.yaxis as object, title: { text: 'Fine-tuned R²', font: { color: '#64748b' } } },
                          shapes: [{ type: 'line', x0: 0, x1: 55, y0: 0, y1: 0, line: { color: '#475569', dash: 'dash', width: 1 } }],
                        } as Plotly.Layout}
                        config={plotConfig} style={{ width: '100%' }}
                      />
                    </div>
                  )}

                  <div className="panel p-4 border-emerald-500/20 bg-emerald-500/5">
                    <h3 className="text-sm font-semibold text-emerald-400 mb-2">Key Finding: Deep Fine-Tuning Dominates</h3>
                    <p className="text-sm text-text-secondary">
                      50 snapshot deep fine-tune (M6) achieves Oxford R²=0.995 — from -1.447 zero-shot baseline.
                      The anchor strategy (M2) surprisingly hurts when v8 RUL scale mismatches Oxford (expected life 3410 vs 309 cycles).
                      v9 with correct RUL normalization (8200 cycles) enables effective adaptation.
                    </p>
                  </div>
                </>
              )}
            </div>

          // ── LOOCV ──────────────────────────────────────────────────────────
          ) : tab === 'loocv' ? (
            <div className="space-y-5">
              <div className="panel p-4 border-cyan-500/20 bg-cyan-500/5">
                <p className="text-sm text-text-secondary">
                  <strong className="text-cyan-400">Leave-One-Out CV:</strong> model retrained 8 times, each time holding out one Oxford cell as test.
                  Shows how well MambaRUL generalizes when one NMC cell is completely unseen.
                </p>
              </div>

              <div className="panel p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="section-title">R² per Held-Out Cell</h3>
                  {loocv && <ExportCSV data={loocv} filename="oxford_loocv.csv" />}
                </div>
                <Plot
                  data={[
                    { type: 'bar', name: 'LOOCV R²', x: loocvCells, y: loocvR2,
                      marker: { color: loocvR2.map(r => r > 0.5 ? '#06b6d4' : r > 0 ? '#f59e0b' : '#ef4444') },
                      text: loocvR2.map(r => r.toFixed(3)), textposition: 'outside' },
                  ]}
                  layout={{ ...darkLayout, height: 280,
                    shapes: [{ type: 'line', x0: -0.5, x1: loocvCells.length - 0.5, y0: 0, y1: 0, line: { color: '#ef4444', dash: 'dash', width: 1 } }],
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Held-out Cell', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'R²', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              {loocv && (
                <div className="panel p-5">
                  <h3 className="section-title mb-3">Full LOOCV Table</h3>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border-subtle">
                        {['Cell','R²','RMSE (cycles)','Val RMSE','Best Epoch'].map(h => (
                          <th key={h} className="text-left pb-3 pr-4 text-xs text-text-muted uppercase tracking-wider">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {loocv.map((row, i) => (
                        <tr key={i} className="border-b border-border-subtle/40">
                          <td className="py-2 pr-4 font-mono text-text-accent">{row.cell as string}</td>
                          <td className="py-2 pr-4 font-mono" style={{ color: (row.r2 as number) > 0.5 ? '#06b6d4' : '#f59e0b' }}>{(row.r2 as number).toFixed(4)}</td>
                          <td className="py-2 pr-4 font-mono text-text-secondary">{(row.rmse as number).toFixed(1)}</td>
                          <td className="py-2 pr-4 font-mono text-text-secondary">{(row.calce_val_rmse as number)?.toFixed(1)}</td>
                          <td className="py-2 font-mono text-text-muted">{row.best_epoch as number}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          // ── EARLY PREDICTION ────────────────────────────────────────────────
          ) : tab === 'earlypred' ? (
            <div className="space-y-5">
              <div className="panel p-4 border-amber-500/20 bg-amber-500/5">
                <p className="text-sm text-text-secondary">
                  <strong className="text-amber-400">Early Prediction:</strong> how many snapshots (K) are needed before reliable RUL prediction?
                  Critical for deployment — determines when a BMS can trust MambaRUL estimates.
                </p>
              </div>

              <div className="panel p-5">
                <h3 className="section-title mb-4">Prediction Quality vs K (calibration snapshots)</h3>
                <Plot
                  data={[
                    { type: 'scatter', mode: 'lines+markers', name: 'Combined R²',
                      x: epK, y: epCombined, line: { color: '#3b82f6', width: 2.5 }, marker: { size: 9 } },
                    { type: 'scatter', mode: 'lines+markers', name: 'Cell7 R²',
                      x: epK, y: epR2Cell7, line: { color: '#10b981', width: 1.5, dash: 'dash' }, marker: { size: 6 } },
                    { type: 'scatter', mode: 'lines+markers', name: 'Cell8 R²',
                      x: epK, y: epR2Cell8, line: { color: '#f59e0b', width: 1.5, dash: 'dash' }, marker: { size: 6 } },
                  ]}
                  layout={{ ...darkLayout, height: 280,
                    shapes: [{ type: 'line', x0: 0, x1: epK[epK.length-1] ?? 50, y0: 0.7, y1: 0.7, line: { color: '#10b981', dash: 'dot', width: 1.5 } }],
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'K (snapshots available)', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'R²', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              {earlyPred && (
                <div className="panel p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="section-title">Early Prediction Table</h3>
                    <ExportCSV data={earlyPred} filename="oxford_earlypred.csv" />
                  </div>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border-subtle">
                        {['K','Cell7 R²','Cell8 R²','Combined R²','Combined RMSE'].map(h => (
                          <th key={h} className="text-left pb-2 pr-4 text-xs text-text-muted uppercase">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {earlyPred.map((row, i) => (
                        <tr key={i} className="border-b border-border-subtle/40">
                          <td className="py-2 pr-4 font-mono text-text-accent">{row.K as number}</td>
                          <td className="py-2 pr-4 font-mono text-text-secondary">{(row.Cell7_r2 as number)?.toFixed(4)}</td>
                          <td className="py-2 pr-4 font-mono text-text-secondary">{(row.Cell8_r2 as number)?.toFixed(4)}</td>
                          <td className="py-2 pr-4 font-mono" style={{ color: (row.Combined_r2 as number) > 0.7 ? '#10b981' : '#f59e0b' }}>{(row.Combined_r2 as number)?.toFixed(4)}</td>
                          <td className="py-2 font-mono text-text-muted">{(row.Combined_rmse as number)?.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

          // ── ANCHOR STRATEGY ─────────────────────────────────────────────────
          ) : (
            <div className="space-y-5">
              <div className="panel p-4 border-purple-500/20 bg-purple-500/5">
                <p className="text-sm text-text-secondary">
                  <strong className="text-purple-400">Anchor Initialization:</strong> three strategies compared — zero-shot (no adaptation), fixed anchor (cap_pct=0.35), analytic anchor (fit exponential to snapshots).
                </p>
              </div>

              <div className="panel p-5">
                <h3 className="section-title mb-4">Zero-Shot vs Analytic Anchor R² per Cell</h3>
                <Plot
                  data={[
                    { type: 'bar', name: 'Zero-Shot R²', x: anchorCells, y: anchorZSR2, marker: { color: '#8b5cf6', opacity: 0.8 } },
                    { type: 'bar', name: 'Analytic Anchor R²', x: anchorCells, y: anchorFtR2, marker: { color: '#10b981', opacity: 0.8 } },
                  ]}
                  layout={{ ...darkLayout, height: 280, barmode: 'group',
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Oxford Cell', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'R²', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              {anchor && (
                <div className="panel p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="section-title">Anchor Strategy Table</h3>
                    <ExportCSV data={anchor} filename="oxford_anchor.csv" />
                  </div>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border-subtle">
                        {['Cell','ZS R²','ZS RMSE','Fixed Anch R²','Analytic Anch R²','Δ(Analytic)'].map(h => (
                          <th key={h} className="text-left pb-2 pr-3 text-text-muted uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {anchor.map((row, i) => (
                        <tr key={i} className="border-b border-border-subtle/40">
                          <td className="py-1.5 pr-3 font-mono text-text-accent">{row.cell as string}</td>
                          <td className="py-1.5 pr-3 font-mono text-text-secondary">{(row.zs_r2 as number)?.toFixed(3)}</td>
                          <td className="py-1.5 pr-3 font-mono text-text-secondary">{(row.zs_rmse as number)?.toFixed(1)}</td>
                          <td className="py-1.5 pr-3 font-mono text-text-secondary">{(row.ft35_r2 as number)?.toFixed(3)}</td>
                          <td className="py-1.5 pr-3 font-mono" style={{ color: (row.fta_r2 as number) > 0 ? '#10b981' : '#ef4444' }}>{(row.fta_r2 as number)?.toFixed(3)}</td>
                          <td className="py-1.5 font-mono" style={{ color: (row.fta_delta_r2 as number) > 0 ? '#10b981' : '#ef4444' }}>
                            {(row.fta_delta_r2 as number) > 0 ? '+' : ''}{(row.fta_delta_r2 as number)?.toFixed(3)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        )}
      </motion.div>
    </div>
  )
}

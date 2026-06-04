/**
 * KeyDiscoveries.tsx
 * 3 major thesis discoveries: MIT-LFP diagnosis, v8 breakthrough, cross-chemistry transfer.
 */
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Lightbulb, Zap, TrendingUp, AlertCircle } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

type TabId = 'lfp' | 'v8' | 'transfer'

export default function KeyDiscoveries() {
  const [tab, setTab] = useState<TabId>('lfp')
  const [lfpData, setLfpData] = useState<Record<string, unknown> | null>(null)
  const [v8Data, setV8Data] = useState<Record<string, unknown> | null>(null)
  const [xferData, setXferData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setLoading(true)
    if (tab === 'lfp' && !lfpData) {
      fetch('/api/mit-lfp-diagnosis').then(r => r.ok ? r.json() : null).then(setLfpData).finally(() => setLoading(false))
    } else if (tab === 'v8' && !v8Data) {
      fetch('/api/v8-breakthrough').then(r => r.ok ? r.json() : null).then(setV8Data).finally(() => setLoading(false))
    } else if (tab === 'transfer' && !xferData) {
      fetch('/api/cross-chemistry-matrix').then(r => r.ok ? r.json() : null).then(setXferData).finally(() => setLoading(false))
    } else {
      setLoading(false)
    }
  }, [tab])

  const TABS = [
    { id: 'lfp' as TabId, label: 'MIT-LFP Diagnosis', icon: AlertCircle, color: '#10b981' },
    { id: 'v8' as TabId, label: 'v8 Breakthrough', icon: Zap, color: '#ef4444' },
    { id: 'transfer' as TabId, label: 'Cross-Chemistry Transfer', icon: TrendingUp, color: '#8b5cf6' },
  ]

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Lightbulb size={22} className="text-brand-amber" />
          <h1 className="text-2xl font-bold text-text-primary">Key Discoveries</h1>
        </div>
        <p className="text-text-secondary">Three major findings from the thesis — what was discovered, why it matters, what it means for deployment</p>
      </div>

      <div className="flex gap-2 mb-6">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl font-medium text-sm transition-all border"
            style={tab === t.id ? { backgroundColor: t.color + '18', borderColor: t.color + '55', color: t.color } : { borderColor: '#1e3a5f', color: '#64748b' }}>
            <t.icon size={15} />
            {t.label}
          </button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>

        {/* ── MIT-LFP ─────────────────────────────────────────────────────── */}
        {tab === 'lfp' && (loading ? <SkeletonChart /> : lfpData && (
          <div className="space-y-5">
            <div className="panel p-5 border-red-500/20 bg-red-500/5">
              <h3 className="font-bold text-red-400 mb-2 text-base">Why MIT-LFP is the Hardest Chemistry</h3>
              <div className="grid grid-cols-2 gap-5">
                <div>
                  <h4 className="text-sm font-semibold text-text-primary mb-2">Root Cause 1: Flat Voltage Plateau</h4>
                  <p className="text-sm text-text-secondary">{(lfpData.lfp_challenge as Record<string, string>).voltage_range}</p>
                  <div className="mt-2 flex gap-3">
                    <div className="rounded-lg p-3 border border-green-500/30 bg-green-500/5 text-center flex-1">
                      <div className="font-mono text-green-400 font-bold">LFP</div>
                      <div className="text-xs text-text-muted">ΔOCV ≈ 50mV</div>
                    </div>
                    <div className="flex items-center text-text-muted">vs</div>
                    <div className="rounded-lg p-3 border border-blue-500/30 bg-blue-500/5 text-center flex-1">
                      <div className="font-mono text-blue-400 font-bold">NMC</div>
                      <div className="text-xs text-text-muted">ΔOCV ≈ 500mV</div>
                    </div>
                  </div>
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-text-primary mb-2">Root Cause 2: 2017 vs 2018 Batch</h4>
                  <p className="text-sm text-text-secondary">{(lfpData.lfp_challenge as Record<string, string>).batch_difference}</p>
                  <div className="mt-2 p-2 rounded bg-bg-elevated border border-border-subtle text-xs font-mono text-text-muted">
                    MIT_2017-05-12_043: R²=-0.400 (worst cell)<br />
                    MIT_2018-02-20_032: R²=+0.860 (best cell)
                  </div>
                </div>
              </div>
            </div>

            {/* Per-cell R² chart */}
            <div className="panel p-5">
              <h3 className="section-title mb-4">MIT-LFP Per-Cell Performance (v10-final)</h3>
              <Plot
                data={[
                  {
                    type: 'bar', name: 'R² (v10-final)',
                    x: (lfpData.comparison as Record<string, unknown>[]).map(r => r.cell as string),
                    y: (lfpData.comparison as Record<string, unknown>[]).map(r => r.r2 as number),
                    marker: { color: (lfpData.comparison as Record<string, unknown>[]).map(r => (r.r2 as number) > 0 ? '#10b981' : '#ef4444') },
                    text: (lfpData.comparison as Record<string, unknown>[]).map(r => `R²=${(r.r2 as number).toFixed(3)}`),
                    textposition: 'outside',
                  },
                ]}
                layout={{ ...darkLayout, height: 280,
                  shapes: [{ type: 'line', x0: -0.5, x1: 4.5, y0: 0, y1: 0, line: { color: '#64748b', dash: 'dash', width: 1 } }],
                  xaxis: { ...darkLayout.xaxis as object, tickangle: -15 },
                  yaxis: { ...darkLayout.yaxis as object, title: { text: 'R²', font: { color: '#64748b' } } },
                } as Plotly.Layout}
                config={plotConfig} style={{ width: '100%' }}
              />
            </div>

            {/* Table */}
            <div className="panel p-5">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border-subtle">{['Cell','Batch','Lifetime','R²','RMSE','RMSE%','Note'].map(h=><th key={h} className="text-left pb-2 pr-3 text-xs text-text-muted uppercase">{h}</th>)}</tr></thead>
                <tbody>
                  {(lfpData.comparison as Record<string, unknown>[]).map((r, i) => (
                    <tr key={i} className="border-b border-border-subtle/40">
                      <td className="py-2 pr-3 font-mono text-xs text-text-accent">{(r.cell as string).replace('MIT_','').substring(0,16)}</td>
                      <td className="py-2 pr-3 text-xs"><span className={`badge ${r.batch === '2017' ? 'badge-amber' : 'badge-blue'}`}>{r.batch as string}</span></td>
                      <td className="py-2 pr-3 font-mono text-xs text-text-secondary">{r.lifetime as number}</td>
                      <td className="py-2 pr-3 font-mono text-xs" style={{ color: (r.r2 as number) > 0 ? '#10b981' : '#ef4444' }}>{(r.r2 as number).toFixed(3)}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-text-secondary">{r.rmse as number}</td>
                      <td className="py-2 pr-3 font-mono text-xs text-text-secondary">{r.rmse_pct as number}%</td>
                      <td className="py-2 text-xs text-text-muted">{r.note as string}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {/* ── V8 BREAKTHROUGH ─────────────────────────────────────────────── */}
        {tab === 'v8' && (loading ? <SkeletonChart /> : v8Data && (
          <div className="space-y-5">
            <div className="panel p-5 border-red-500/30 bg-red-500/5">
              <div className="flex items-center gap-3 mb-3">
                <Zap size={20} className="text-red-400" />
                <h3 className="font-bold text-red-400 text-base">The v8 Breakthrough — RMSE 84 → 24 cycles (71% reduction)</h3>
              </div>
              <div className="grid grid-cols-3 gap-4">
                {(v8Data.three_changes as Record<string, unknown>[]).map((c, i) => (
                  <div key={i} className="bg-bg-elevated rounded-xl p-4 border border-border-subtle">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="w-6 h-6 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center text-xs font-bold">{i + 1}</span>
                      <span className="text-xs font-bold" style={{ color: c.impact === 'CRITICAL' ? '#ef4444' : c.impact === 'HIGH' ? '#f59e0b' : '#3b82f6' }}>{c.impact as string}</span>
                    </div>
                    <div className="font-semibold text-sm text-text-primary mb-2">{c.name as string}</div>
                    <div className="text-xs text-red-400 mb-1">Before: {c.before as string}</div>
                    <div className="text-xs text-emerald-400 mb-2">After: {c.after as string}</div>
                    <div className="text-xs text-text-muted italic">{c.why as string}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* RMSE ladder + window explosion */}
            <div className="grid grid-cols-2 gap-4">
              <div className="panel p-5">
                <h3 className="section-title mb-4">RMSE Ladder — All Versions</h3>
                <Plot
                  data={[{
                    type: 'scatter', mode: 'lines+markers',
                    x: (v8Data.rmse_ladder as Record<string, unknown>[]).map(r => r.version as string),
                    y: (v8Data.rmse_ladder as Record<string, unknown>[]).map(r => r.rmse as number),
                    line: { color: '#3b82f6', width: 2 },
                    marker: {
                      color: (v8Data.rmse_ladder as Record<string, unknown>[]).map(r => (r.version as string) === 'v8' ? '#ef4444' : '#3b82f6'),
                      size: (v8Data.rmse_ladder as Record<string, unknown>[]).map(r => (r.version as string) === 'v8' ? 14 : 7),
                    },
                  }]}
                  layout={{ ...darkLayout, height: 240,
                    xaxis: { ...darkLayout.xaxis as object, tickangle: -30 },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'RMSE (cycles)', font: { color: '#64748b' } } },
                    annotations: [{ x: 'v8', y: 23.95, text: '⚡ Breakthrough', showarrow: true, arrowhead: 2, arrowcolor: '#ef4444', font: { color: '#ef4444', size: 10 }, ax: 40, ay: -25 }],
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              <div className="panel p-5">
                <h3 className="section-title mb-4">Window Count — stride=1 vs stride=10</h3>
                <Plot
                  data={[
                    { type: 'bar', name: 'stride=10', x: (v8Data.window_counts as Record<string, unknown>[]).map(r => r.cell as string), y: (v8Data.window_counts as Record<string, unknown>[]).map(r => r.stride_10 as number), marker: { color: '#f59e0b', opacity: 0.7 } },
                    { type: 'bar', name: 'stride=1 (v8)', x: (v8Data.window_counts as Record<string, unknown>[]).map(r => r.cell as string), y: (v8Data.window_counts as Record<string, unknown>[]).map(r => r.stride_1 as number), marker: { color: '#10b981', opacity: 0.8 } },
                  ]}
                  layout={{ ...darkLayout, height: 240, barmode: 'group',
                    xaxis: { ...darkLayout.xaxis as object, tickangle: -30 },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'Training windows', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-4">
              {[
                { label: 'Before (v2)', rmse: (v8Data.before as Record<string, unknown>).rmse as number, windows: (v8Data.before as Record<string, unknown>).windows_lco as number, color: '#ef4444' },
                { label: 'After (v8)', rmse: (v8Data.after as Record<string, unknown>).rmse as number, windows: (v8Data.after as Record<string, unknown>).windows_lco as number, color: '#10b981' },
                { label: 'Improvement', rmse: (v8Data.improvement as Record<string, unknown>).rmse_reduction as number, windows: 0, color: '#f59e0b' },
              ].map(s => (
                <div key={s.label} className="panel p-4 text-center">
                  <div className="text-xs text-text-muted mb-1">{s.label}</div>
                  <div className="text-3xl font-mono font-bold" style={{ color: s.color }}>{s.rmse}</div>
                  <div className="text-xs text-text-muted">RMSE cycles</div>
                  {s.windows > 0 && <div className="text-sm font-mono mt-1" style={{ color: s.color }}>{s.windows.toLocaleString()} windows</div>}
                  {s.label === 'Improvement' && <div className="text-sm font-mono mt-1 text-amber-400">-71% RMSE</div>}
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* ── CROSS-CHEMISTRY TRANSFER ─────────────────────────────────────── */}
        {tab === 'transfer' && (loading ? <SkeletonChart /> : xferData && (
          <div className="space-y-5">
            <div className="panel p-4 border-purple-500/20 bg-purple-500/5">
              <p className="text-sm text-text-secondary">
                <strong className="text-purple-400">{xferData.key_finding as string}</strong>
              </p>
              <p className="text-xs text-text-muted mt-1">{xferData.note as string}</p>
            </div>

            <div className="panel p-5">
              <h3 className="section-title mb-4">Transfer Matrix — R² (row=train chemistry, col=test chemistry)</h3>
              <Plot
                data={[{
                  type: 'heatmap',
                  z: xferData.matrix as number[][],
                  x: xferData.chemistries as string[],
                  y: [...(xferData.chemistries as string[]).slice(0, 4), 'ALL (v10-final)'],
                  colorscale: [[0,'#450a0a'],[0.3,'#7f1d1d'],[0.5,'#111827'],[0.7,'#1e3a5f'],[1,'#10b981']],
                  zmin: -1, zmax: 1,
                  showscale: true,
                  colorbar: { tickfont: { color: '#64748b', size: 9 }, thickness: 14 },
                }]}
                layout={{ ...darkLayout, height: 340,
                  margin: { t: 20, b: 80, l: 120, r: 60 },
                  xaxis: { ...darkLayout.xaxis as object, title: { text: 'Test Chemistry', font: { color: '#64748b' } }, tickangle: -20 },
                  yaxis: { ...darkLayout.yaxis as object, title: { text: 'Training Chemistry', font: { color: '#64748b' } } },
                } as Plotly.Layout}
                config={plotConfig} style={{ width: '100%' }}
              />
            </div>

            <div className="panel p-5">
              <h3 className="section-title mb-3">Key Transfer Insights</h3>
              <div className="space-y-2">
                {[
                  { color: '#10b981', text: 'Multi-chemistry training (v10-final, last row) achieves the best R² across all test chemistries simultaneously' },
                  { color: '#3b82f6', text: 'LCO-only training transfers well to NMC (similar voltage range) but poorly to LFP (flat plateau)' },
                  { color: '#f59e0b', text: 'LFP-only training generalizes poorly — flat voltage features are uninformative for other chemistries' },
                  { color: '#ef4444', text: 'Negative R² values indicate worse than mean prediction — single-chemistry models cannot generalize' },
                ].map((i, idx) => (
                  <div key={idx} className="flex items-start gap-2 p-3 rounded-lg bg-bg-elevated border border-border-subtle">
                    <span className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: i.color }} />
                    <span className="text-sm text-text-secondary">{i.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </motion.div>
    </div>
  )
}

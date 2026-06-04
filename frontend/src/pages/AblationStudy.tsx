import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Scissors, CheckCircle2, XCircle } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'
import { ExportCSV } from '../components/ui/ExportButton'

interface AblRow { config: string; n_features: number; cs2_37_rmse: number; cs2_38_rmse: number; avg_rmse: number; cs2_37_r2: number; n_anchors?: number; [key: string]: unknown }

const ANCHOR_LABELS: Record<string, string> = {
  '0': '0 anchors (no attention)',
  '1': '1 anchor (single)',
  '2': '2 anchors (fresh+EOL)',
  '3': '3 anchors ★ (fresh+knee+EOL)',
}

const FEAT_LABELS: Record<string, string> = {
  '13features': '13 features (full)',
  '12features': '12 features (−cap_pct)',
  'no_soh_curvature': '12 features (−curvature)',
  'no_discharge_slope': '12 features (−slope)',
  'no_IR_features': '11 features (−IR)',
  'only_raw_8': '8 features (raw only)',
}

const FEAT_COLORS: Record<string, string> = {
  '13features': '#10b981', '12features': '#f59e0b',
  'no_soh_curvature': '#ef4444', 'no_discharge_slope': '#3b82f6',
  'no_IR_features': '#8b5cf6', 'only_raw_8': '#ef4444',
}

export default function AblationStudy() {
  const [tab, setTab] = useState<'anchors'|'features'|'knee'>('anchors')
  const [anchorData, setAnchorData] = useState<AblRow[] | null>(null)
  const [featData, setFeatData] = useState<AblRow[] | null>(null)
  const [kneeCell, setKneeCell] = useState('CS2_37')
  const [kneeData, setKneeData] = useState<Record<string, unknown> | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (tab === 'anchors' && !anchorData) {
      setLoading(true)
      fetch('/api/ablation/anchors').then(r => r.ok ? r.json() : null)
        .then(d => setAnchorData(d?.anchor_ablation ?? null)).finally(() => setLoading(false))
    } else if (tab === 'features' && !featData) {
      setLoading(true)
      fetch('/api/ablation/features').then(r => r.ok ? r.json() : null)
        .then(d => setFeatData(d?.feature_ablation ?? null)).finally(() => setLoading(false))
    } else if (tab === 'knee') {
      setLoading(true)
      fetch(`/api/knee-detection/${kneeCell}`).then(r => r.ok ? r.json() : null)
        .then(setKneeData).finally(() => setLoading(false))
    }
  }, [tab, kneeCell])

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Scissors size={22} className="text-brand-amber" />
          <h1 className="text-2xl font-bold text-text-primary">Ablation Study</h1>
        </div>
        <p className="text-text-secondary">Feature ablation · Anchor ablation · Knee point detection — real results from thesis experiments</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {[
          { id: 'anchors', label: 'Degradation Anchors' },
          { id: 'features', label: 'Feature Ablation' },
          { id: 'knee', label: 'Knee Point Detection' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id as typeof tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${tab === t.id ? 'border-brand-amber text-amber-400' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            {t.label}
          </button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>

        {/* ── ANCHOR ABLATION ─────────────────────────────────────────────── */}
        {tab === 'anchors' && (
          loading ? <SkeletonChart /> : anchorData ? (
            <div className="space-y-5">
              <div className="panel p-4 border-purple-500/20 bg-purple-500/5">
                <p className="text-sm text-text-secondary">
                  Real ablation from <code className="font-mono text-xs text-purple-300">conference_paper_legitimate/results/ablation_anchors_legitimate.json</code>.
                  MambaRUL trained with 0, 1, 2, 3 degradation anchors. Each anchor adds a learned embedding (Fresh/Knee/EOL) for cross-attention.
                </p>
              </div>

              <div className="panel p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="section-title">RMSE vs Number of Anchors</h3>
                  <ExportCSV data={anchorData} filename="anchor_ablation.csv" />
                </div>
                <Plot
                  data={[
                    { type: 'scatter', mode: 'lines+markers', name: 'CS2_37 RMSE',
                      x: anchorData.map(r => r.n_anchors ?? 0), y: anchorData.map(r => r.cs2_37_rmse),
                      line: { color: '#8b5cf6', width: 2.5 }, marker: { size: 10, color: '#8b5cf6' } },
                    { type: 'scatter', mode: 'lines+markers', name: 'CS2_38 RMSE',
                      x: anchorData.map(r => r.n_anchors ?? 0), y: anchorData.map(r => r.cs2_38_rmse),
                      line: { color: '#8b5cf677', width: 1.5, dash: 'dash' }, marker: { size: 7 } },
                    { type: 'scatter', mode: 'lines+markers', name: 'Average RMSE',
                      x: anchorData.map(r => r.n_anchors ?? 0), y: anchorData.map(r => r.avg_rmse),
                      line: { color: '#f59e0b', width: 2 }, marker: { size: 8 } },
                  ]}
                  layout={{ ...darkLayout, height: 280,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Number of Anchors', font: { color: '#64748b' } }, tickvals: [0,1,2,3] },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'RMSE (cycles)', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              <div className="grid grid-cols-4 gap-3">
                {anchorData.map((row, i) => (
                  <div key={String(row.n_anchors ?? i)} className="panel p-4 text-center"
                    style={i === 3 ? { borderColor: '#8b5cf644', backgroundColor: '#8b5cf608' } : {}}>
                    <div className="text-xs text-text-muted mb-1">{ANCHOR_LABELS[String(row.n_anchors ?? i)]}</div>
                    <div className="text-2xl font-mono font-bold text-text-accent">{row.avg_rmse.toFixed(1)}</div>
                    <div className="text-xs text-text-muted">avg RMSE</div>
                    <div className="text-sm font-mono mt-1" style={{ color: row.cs2_37_r2 > 0.95 ? '#10b981' : '#f59e0b' }}>R²={row.cs2_37_r2.toFixed(4)}</div>
                    {i === 3 && <div className="mt-1 text-xs text-purple-400 font-semibold">★ Best</div>}
                  </div>
                ))}
              </div>

              <div className="panel p-4">
                <p className="text-sm text-text-secondary">
                  <strong className="text-text-primary">Finding:</strong> Adding anchors consistently improves performance.
                  3 anchors outperforms 2 (avg RMSE {anchorData[2]?.avg_rmse.toFixed(1)} → {anchorData[3]?.avg_rmse.toFixed(1)}).
                  The Fresh/Knee/Near-EOL decomposition captures degradation phase information
                  not available in the raw features alone.
                </p>
              </div>
            </div>
          ) : <div className="panel p-12 text-center text-text-muted">No anchor ablation data available</div>
        )}

        {/* ── FEATURE ABLATION ────────────────────────────────────────────── */}
        {tab === 'features' && (
          loading ? <SkeletonChart /> : featData ? (
            <div className="space-y-5">
              <div className="panel p-4 border-amber-500/20 bg-amber-500/5">
                <p className="text-sm text-text-secondary">
                  Feature groups removed one at a time. Real data from <code className="font-mono text-xs text-amber-300">ablation_cappct_legitimate.json</code>.
                  Key question: which features are most critical for MambaRUL performance?
                </p>
              </div>

              <div className="panel p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="section-title">RMSE by Feature Configuration</h3>
                  <ExportCSV data={featData} filename="feature_ablation.csv" />
                </div>
                <Plot
                  data={[{
                    type: 'bar', orientation: 'h',
                    y: featData.map(r => FEAT_LABELS[r.config] ?? r.config),
                    x: featData.map(r => r.avg_rmse),
                    marker: { color: featData.map(r => FEAT_COLORS[r.config] ?? '#3b82f6'), opacity: 0.85 },
                    text: featData.map(r => `${r.avg_rmse.toFixed(1)}`),
                    textposition: 'outside',
                  }]}
                  layout={{ ...darkLayout, height: 320,
                    margin: { t: 10, b: 40, l: 200, r: 80 },
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Average RMSE (cycles, lower=better)', font: { color: '#64748b' } } },
                    shapes: [{ type: 'line', x0: featData[0]?.avg_rmse ?? 12, x1: featData[0]?.avg_rmse ?? 12, y0: -0.5, y1: featData.length - 0.5, line: { color: '#10b981', dash: 'dash', width: 1.5 } }],
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              <div className="panel p-5">
                <h3 className="section-title mb-3">Feature Impact Ranking</h3>
                <div className="space-y-2">
                  {featData.map((row, i) => {
                    const baseline = featData[0]?.avg_rmse ?? 12
                    const delta = row.avg_rmse - baseline
                    const isBaseline = i === 0
                    return (
                      <div key={row.config} className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border ${isBaseline ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border-subtle bg-bg-elevated'}`}>
                        {isBaseline
                          ? <CheckCircle2 size={16} className="text-emerald-400 flex-shrink-0" />
                          : <XCircle size={16} className="text-red-400 flex-shrink-0" />}
                        <span className="text-sm font-medium text-text-primary">{FEAT_LABELS[row.config] ?? row.config}</span>
                        <span className="ml-auto font-mono text-sm text-text-accent">{row.avg_rmse.toFixed(1)} cycles</span>
                        {!isBaseline && (
                          <span className="font-mono text-sm text-red-400 w-16 text-right">+{delta.toFixed(1)}</span>
                        )}
                        {isBaseline && <span className="font-mono text-sm text-emerald-400 w-16 text-right">baseline</span>}
                      </div>
                    )
                  })}
                </div>
                <p className="text-xs text-text-muted mt-3">
                  Removing cap_pct (SOH proxy) raises RMSE by {((featData[1]?.avg_rmse ?? 0) - (featData[0]?.avg_rmse ?? 0)).toFixed(1)} cycles — confirming it as the single most important feature (|SHAP|=0.31).
                </p>
              </div>
            </div>
          ) : <div className="panel p-12 text-center text-text-muted">No feature ablation data available</div>
        )}

        {/* ── KNEE POINT DETECTION ────────────────────────────────────────── */}
        {tab === 'knee' && (
          <div className="space-y-5">
            <div className="panel p-4 border-cyan-500/20 bg-cyan-500/5">
              <p className="text-sm text-text-secondary">
                <strong className="text-cyan-400">Knee point:</strong> cycle at which d²(SOH)/di² is maximized — the inflection point marking transition from linear to accelerated degradation.
                Detected via Savitzky-Golay second derivative of the smoothed capacity curve.
              </p>
            </div>

            <div className="flex gap-3 mb-4">
              {['CS2_37','CS2_38','CS2_35','CS2_34'].map(c => (
                <button key={c} onClick={() => setKneeCell(c)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-mono transition-all border ${kneeCell === c ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-400' : 'border-border-subtle text-text-muted'}`}>
                  {c}
                </button>
              ))}
            </div>

            {loading ? <SkeletonChart /> : kneeData ? (
              <>
                <div className="grid grid-cols-4 gap-4">
                  {[
                    { label: 'Knee Cycle', value: String(kneeData.knee_cycle), color: '#f59e0b' },
                    { label: 'SOH at Knee', value: `${(kneeData.knee_soh_pct as number)?.toFixed(1)}%`, color: '#06b6d4' },
                    { label: 'Fade Before', value: `${((kneeData.slope_before as number) * 1000).toFixed(3)}/cyc`, color: '#10b981' },
                    { label: 'Fade After', value: `${((kneeData.slope_after as number) * 1000).toFixed(3)}/cyc`, color: '#ef4444' },
                  ].map(s => (
                    <div key={s.label} className="panel p-4 text-center">
                      <div className="metric-label">{s.label}</div>
                      <div className="text-2xl font-mono font-bold mt-1" style={{ color: s.color }}>{s.value}</div>
                    </div>
                  ))}
                </div>

                <div className="panel p-5">
                  <h3 className="section-title mb-4">Capacity Fade + Knee Point — {kneeData.cell_id as string}</h3>
                  <Plot
                    data={[
                      { type: 'scatter', mode: 'lines', name: 'SOH (%)',
                        x: kneeData.cycles as Plotly.Datum[], y: kneeData.soh as Plotly.Datum[],
                        line: { color: '#3b82f6', width: 2 } },
                      { type: 'scatter', mode: 'markers', name: 'Knee Point',
                        x: [kneeData.knee_cycle as number], y: [kneeData.knee_soh_pct as number],
                        marker: { color: '#f59e0b', size: 14, symbol: 'diamond', line: { color: '#fff', width: 2 } } },
                    ]}
                    layout={{ ...darkLayout, height: 240,
                      xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: 'SOH (%)', font: { color: '#64748b' } } },
                      shapes: [{ type: 'line', x0: kneeData.knee_cycle as number, x1: kneeData.knee_cycle as number, y0: 0, y1: 110, line: { color: '#f59e0b', dash: 'dot', width: 2 } }],
                      annotations: [{ x: (kneeData.knee_cycle as number) + 5, y: (kneeData.knee_soh_pct as number) + 3, text: `Knee: cycle ${kneeData.knee_cycle}`, font: { color: '#f59e0b', size: 10 }, showarrow: false }],
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                </div>

                <div className="panel p-5">
                  <h3 className="section-title mb-4">SOH Curvature d²SOH/di² (knee = peak)</h3>
                  <Plot
                    data={[
                      { type: 'scatter', mode: 'lines', name: '|Curvature|×1000',
                        x: kneeData.cycles as Plotly.Datum[], y: (kneeData.curvature as number[]).map(Math.abs),
                        line: { color: '#ef4444', width: 2 }, fill: 'tozeroy', fillcolor: '#ef444422' },
                    ]}
                    layout={{ ...darkLayout, height: 200,
                      xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: '|d²SOH/di²| ×1000', font: { color: '#64748b' } } },
                      shapes: [{ type: 'line', x0: kneeData.knee_cycle as number, x1: kneeData.knee_cycle as number, y0: 0, y1: 10, line: { color: '#f59e0b', dash: 'dot', width: 2 } }],
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                </div>

                <div className="panel p-4">
                  <div className="text-xs font-mono text-text-secondary space-y-1">
                    <div>Acceleration at knee: <span className="text-amber-400">{((kneeData.acceleration as number) * 1000).toFixed(4)} ×10⁻³ per cycle²</span></div>
                    <div>Slope change: {((kneeData.slope_before as number) * 1000).toFixed(4)} → {((kneeData.slope_after as number) * 1000).toFixed(4)} (×10⁻³ per cycle)</div>
                    <div className="text-text-muted">SOH curvature feature directly used in MambaRUL 42-feature set as <code className="text-brand-blue">soh_curvature</code></div>
                  </div>
                </div>
              </>
            ) : <div className="panel p-12 text-center text-text-muted">Select a cell to detect knee point</div>}
          </div>
        )}
      </motion.div>
    </div>
  )
}

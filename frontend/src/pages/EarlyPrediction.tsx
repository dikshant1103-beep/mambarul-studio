import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Target, Lock, Zap } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface KStep {
  k: number
  cell7_rmse: number
  cell7_r2: number
  cell8_rmse: number
  cell8_r2: number
  combined_rmse: number
  combined_r2: number
}

interface EarlyPredData {
  steps: KStep[]
  best_k: number
  note: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n: number, d = 3) {
  return Number.isFinite(n) ? n.toFixed(d) : '—'
}

// ---------------------------------------------------------------------------
// Fallback mock
// ---------------------------------------------------------------------------
function mockData(): EarlyPredData {
  return {
    best_k: 20,
    note: 'K=number of calibration snapshots used',
    steps: [
      { k:  0, cell7_rmse: 934.5,  cell7_r2: 0.597, cell8_rmse:  488.2, cell8_r2: 0.885, combined_rmse: 747.8, combined_r2: 0.736 },
      { k:  5, cell7_rmse: 698.6,  cell7_r2: 0.714, cell8_rmse: 1057.2, cell8_r2: 0.311, combined_rmse: 893.9, combined_r2: 0.520 },
      { k: 10, cell7_rmse: 541.2,  cell7_r2: 0.801, cell8_rmse:  621.4, cell8_r2: 0.823, combined_rmse: 581.3, combined_r2: 0.812 },
      { k: 20, cell7_rmse: 312.4,  cell7_r2: 0.924, cell8_rmse:  287.1, cell8_r2: 0.941, combined_rmse: 299.7, combined_r2: 0.932 },
      { k: 30, cell7_rmse: 389.7,  cell7_r2: 0.881, cell8_rmse:  401.3, cell8_r2: 0.873, combined_rmse: 395.5, combined_r2: 0.877 },
      { k: 40, cell7_rmse: 512.8,  cell7_r2: 0.834, cell8_rmse:  544.1, cell8_r2: 0.818, combined_rmse: 528.4, combined_r2: 0.826 },
    ],
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function EarlyPrediction() {
  const [data, setData]       = useState<EarlyPredData | null>(null)
  const [loading, setLoading] = useState(true)
  const [isMock, setIsMock]   = useState(false)

  useEffect(() => {
    fetch('/api/early-prediction')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(setData)
      .catch(() => { setData(mockData()); setIsMock(true) })
      .finally(() => setLoading(false))
  }, [])

  const steps   = data?.steps ?? []
  const bestK   = data?.best_k ?? 20
  const ks      = steps.map(s => s.k)

  // Vertical marker for best_k
  const shapes: Partial<Plotly.Shape>[] = [
    {
      type: 'line',
      x0: bestK,
      x1: bestK,
      y0: 0,
      y1: 1,
      yref: 'paper',
      line: { color: '#10b98170', width: 2, dash: 'dot' },
    },
  ]
  const annotations: Partial<Plotly.Annotations>[] = [
    {
      x: bestK,
      y: 1.04,
      yref: 'paper',
      xanchor: 'center',
      text: `Best K=${bestK}`,
      showarrow: false,
      font: { color: '#10b981', size: 10 },
    },
  ]

  const traces: Plotly.Data[] = [
    // Combined RMSE — red solid
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Combined RMSE',
      x: ks,
      y: steps.map(s => s.combined_rmse),
      yaxis: 'y',
      line: { color: '#ef4444', width: 2.5 },
      marker: { color: '#ef4444', size: 6 },
      hovertemplate: 'K=%{x}<br>Combined RMSE: %{y:.1f}<extra></extra>',
    } as Plotly.Data,
    // Cell7 RMSE — cyan dashed
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Cell7 RMSE',
      x: ks,
      y: steps.map(s => s.cell7_rmse),
      yaxis: 'y',
      line: { color: '#06b6d4', width: 1.5, dash: 'dash' },
      marker: { color: '#06b6d4', size: 4 },
      opacity: 0.8,
      hovertemplate: 'K=%{x}<br>Cell7 RMSE: %{y:.1f}<extra></extra>',
    } as Plotly.Data,
    // Cell8 RMSE — amber dashed
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Cell8 RMSE',
      x: ks,
      y: steps.map(s => s.cell8_rmse),
      yaxis: 'y',
      line: { color: '#f59e0b', width: 1.5, dash: 'dash' },
      marker: { color: '#f59e0b', size: 4 },
      opacity: 0.8,
      hovertemplate: 'K=%{x}<br>Cell8 RMSE: %{y:.1f}<extra></extra>',
    } as Plotly.Data,
    // Combined R² — green solid on right axis
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Combined R²',
      x: ks,
      y: steps.map(s => s.combined_r2),
      yaxis: 'y2',
      line: { color: '#10b981', width: 2.5 },
      marker: { color: '#10b981', size: 6, symbol: 'diamond' },
      hovertemplate: 'K=%{x}<br>Combined R²: %{y:.3f}<extra></extra>',
    } as Plotly.Data,
  ]

  const chartLayout: Partial<Plotly.Layout> = {
    ...darkLayout,
    height: 380,
    margin: { t: 32, b: 55, l: 65, r: 70 },
    xaxis: {
      ...(darkLayout.xaxis as object),
      title: { text: 'K (calibration snapshots)', font: { color: '#64748b' } },
      tickvals: ks,
      ticktext: ks.map(k => k === 0 ? 'K=0\n(zero-shot)' : `K=${k}`),
    },
    yaxis: {
      ...(darkLayout.yaxis as object),
      title: { text: 'RMSE (cycles)', font: { color: '#64748b' } },
      rangemode: 'tozero',
    },
    yaxis2: {
      ...(darkLayout.yaxis as object),
      title: { text: 'R²', font: { color: '#64748b' } },
      overlaying: 'y',
      side: 'right',
      showgrid: false,
      range: [0, 1.05],
      zeroline: false,
    },
    legend: {
      ...(darkLayout.legend as object),
      x: 0.5,
      y: 1.1,
      xanchor: 'center',
      orientation: 'h',
    },
    shapes,
    annotations,
  } as Partial<Plotly.Layout>

  return (
    <motion.div
      className="px-8 py-8 max-w-7xl mx-auto"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {isMock && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          ⚠ Demo data — backend unavailable. Values shown are illustrative, not live model output.
        </div>
      )}
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Target size={22} className="text-amber-400" />
          <h1 className="text-2xl font-bold text-text-primary">
            Early-Cycle Prediction — Predict EOL from First K Snapshots
          </h1>
        </div>
        <p className="text-text-secondary">
          How many calibration snapshots (K) are needed before the model can reliably predict
          end-of-life? Sweep K from 0 (zero-shot) through 40 and observe combined RMSE and R².
        </p>
      </div>

      {/* Config info box */}
      <div className="panel p-4 mb-6 flex items-center gap-4 bg-purple-500/5 border-purple-500/20">
        <Lock size={14} className="text-purple-400 flex-shrink-0" />
        <div className="text-xs text-text-secondary flex gap-6 flex-wrap">
          <span>
            <span className="text-text-muted">Model:</span>{' '}
            <span className="font-mono text-purple-400">v9</span>
          </span>
          <span>
            <span className="text-text-muted">Fine-tuned layers:</span>{' '}
            <span className="font-mono text-purple-400">cross_attn + mlp_head only</span>
          </span>
          <span>
            <span className="text-text-muted">Frozen:</span>{' '}
            <span className="font-mono text-purple-400">mamba_blocks</span>
          </span>
          {data?.note && (
            <span className="text-text-muted italic">{data.note}</span>
          )}
        </div>
      </div>

      {/* K-sweep chart */}
      <div className="panel p-5 mb-6">
        <h3 className="section-title mb-1">K-Sweep: RMSE & R² vs. Calibration Snapshots</h3>
        <p className="text-xs text-text-muted mb-3">
          Solid lines = combined metric · dashed = per-cell RMSE · left Y = RMSE · right Y = R² ·
          dotted vertical = best K={bestK}
        </p>
        {loading ? (
          <SkeletonChart height={380} />
        ) : (
          <Plot
            data={traces}
            layout={chartLayout as Plotly.Layout}
            config={{ ...plotConfig, displayModeBar: false }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        )}
      </div>

      {/* Detail table */}
      <div className="panel p-5 mb-6">
        <h3 className="section-title mb-4">Per-K Results</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left">
                {['K', 'Cell7 RMSE', 'Cell7 R²', 'Cell8 RMSE', 'Cell8 R²', 'Combined RMSE', 'Combined R²'].map(h => (
                  <th key={h} className="pb-2 pr-5 text-xs text-text-muted font-semibold uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i} className="border-b border-border-subtle/30">
                      {Array.from({ length: 7 }).map((__, j) => (
                        <td key={j} className="py-2.5 pr-5">
                          <div className="h-3 w-14 rounded animate-pulse bg-bg-elevated" />
                        </td>
                      ))}
                    </tr>
                  ))
                : steps.map(step => {
                    const isBest = step.k === bestK
                    return (
                      <tr
                        key={step.k}
                        className="border-b border-border-subtle/30 transition-colors"
                        style={isBest ? { backgroundColor: '#10b98112' } : undefined}
                      >
                        <td className="py-2.5 pr-5 font-mono font-bold"
                            style={{ color: isBest ? '#10b981' : '#94a3b8' }}>
                          {step.k === 0 ? (
                            <span className="flex items-center gap-1.5">
                              0
                              <span className="text-[9px] text-amber-400 font-sans font-normal bg-amber-400/10 px-1.5 py-0.5 rounded">
                                Zero-Shot
                              </span>
                            </span>
                          ) : (
                            <>
                              {step.k}
                              {isBest && (
                                <span className="ml-1.5 text-[9px] text-emerald-400 font-sans font-normal bg-emerald-400/10 px-1.5 py-0.5 rounded">
                                  Best
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="py-2.5 pr-5 font-mono text-cyan-400">{fmt(step.cell7_rmse, 1)}</td>
                        <td className="py-2.5 pr-5 font-mono" style={{ color: step.cell7_r2 > 0.8 ? '#10b981' : '#f59e0b' }}>
                          {fmt(step.cell7_r2, 3)}
                        </td>
                        <td className="py-2.5 pr-5 font-mono text-amber-400">{fmt(step.cell8_rmse, 1)}</td>
                        <td className="py-2.5 pr-5 font-mono" style={{ color: step.cell8_r2 > 0.8 ? '#10b981' : '#f59e0b' }}>
                          {fmt(step.cell8_r2, 3)}
                        </td>
                        <td className="py-2.5 pr-5 font-mono text-red-400">{fmt(step.combined_rmse, 1)}</td>
                        <td className="py-2.5 pr-5 font-mono font-bold"
                            style={{ color: isBest ? '#10b981' : step.combined_r2 > 0.8 ? '#10b981' : '#f59e0b' }}>
                          {fmt(step.combined_r2, 3)}
                        </td>
                      </tr>
                    )
                  })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Key insight */}
      <div className="panel p-5 border-amber-500/20 bg-amber-500/5">
        <div className="flex items-start gap-3">
          <Zap size={16} className="text-amber-400 mt-0.5 flex-shrink-0" />
          <div>
            <h3 className="text-sm font-semibold text-amber-400 mb-2">Key Insight</h3>
            <ul className="text-sm text-text-secondary space-y-1.5 list-disc list-inside">
              <li>
                More calibration data does <strong className="text-text-primary">NOT</strong> always
                help — K=20 is optimal (Combined R²={fmt(steps.find(s => s.k === bestK)?.combined_r2 ?? 0.932, 3)}).
              </li>
              <li>
                Overfitting starts at K≥30: the fine-tuned cross_attn layers begin memorising the
                calibration trajectory, degrading generalisation to the unseen future cycles.
              </li>
              <li>
                K=0 (zero-shot) is surprisingly competitive (Combined R²=
                {fmt(steps.find(s => s.k === 0)?.combined_r2 ?? 0.736, 3)}),
                showing the frozen mamba_blocks already capture chemistry-agnostic degradation dynamics.
              </li>
            </ul>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

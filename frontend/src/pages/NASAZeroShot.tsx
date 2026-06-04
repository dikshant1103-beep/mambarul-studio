import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Zap, CheckCircle, XCircle, Info } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

interface BatteryResult {
  battery: string
  rmse: number
  mae: number
  r2: number
  naive_rmse: number
  beats_naive: boolean
}

interface NASAResponse {
  cells: BatteryResult[]
  combined: { rmse: number; mae: number; r2: number }
  readme: string
}

const BATTERY_COLORS: Record<string, string> = {
  B0005: '#06b6d4',
  B0006: '#8b5cf6',
  B0007: '#f59e0b',
  B0018: '#3b82f6',
}

export default function NASAZeroShot() {
  const [data, setData] = useState<NASAResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/nasa-zeroshot')
      .then(r => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Grouped bar chart data (MambaRUL RMSE vs Naive RMSE)
  const batteries = data?.cells ?? []
  const batteryNames = batteries.map(c => c.battery)

  const mambaBarColors = batteries.map(c => c.r2 > 0 ? '#10b981' : '#ef4444')

  const barTraces: Plotly.Data[] = [
    {
      x: batteryNames,
      y: batteries.map(c => c.rmse),
      name: 'MambaRUL RMSE',
      type: 'bar',
      marker: { color: mambaBarColors },
      hovertemplate: '<b>%{x}</b><br>MambaRUL RMSE: %{y:.2f}<extra></extra>',
    } as Plotly.Data,
    {
      x: batteryNames,
      y: batteries.map(c => c.naive_rmse),
      name: 'Naive RMSE',
      type: 'bar',
      marker: { color: '#475569' },
      hovertemplate: '<b>%{x}</b><br>Naive RMSE: %{y:.2f}<extra></extra>',
    } as Plotly.Data,
  ]

  const barLayout: Partial<Plotly.Layout> = {
    ...darkLayout,
    barmode: 'group',
    xaxis: { ...darkLayout.xaxis, title: { text: 'Battery', font: { color: '#64748b', size: 11 } } },
    yaxis: { ...darkLayout.yaxis, title: { text: 'RMSE (cycles)', font: { color: '#64748b', size: 11 } } },
    margin: { t: 20, b: 55, l: 65, r: 20 },
  }

  // R² horizontal bar chart
  const r2Colors = batteries.map(c => c.r2 > 0 ? '#10b981' : '#ef4444')
  const r2Traces: Plotly.Data[] = [
    {
      y: batteryNames,
      x: batteries.map(c => c.r2),
      type: 'bar',
      orientation: 'h',
      marker: { color: r2Colors },
      hovertemplate: '<b>%{y}</b><br>R²: %{x:.4f}<extra></extra>',
      showlegend: false,
    } as Plotly.Data,
  ]

  const r2Layout: Partial<Plotly.Layout> = {
    ...darkLayout,
    xaxis: {
      ...darkLayout.xaxis,
      title: { text: 'R²', font: { color: '#64748b', size: 11 } },
      zeroline: true,
      zerolinecolor: '#475569',
      zerolinewidth: 2,
    },
    yaxis: { ...darkLayout.yaxis },
    margin: { t: 20, b: 55, l: 80, r: 20 },
    shapes: [
      {
        type: 'line',
        x0: 0, x1: 0,
        y0: -0.5, y1: batteries.length - 0.5,
        line: { color: '#475569', width: 2, dash: 'dot' },
      },
    ],
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35 }}
        className="mb-6"
      >
        <div className="flex items-center gap-3 mb-2">
          <Zap size={22} className="text-amber-400" />
          <h1 className="text-2xl font-bold text-text-primary">
            NASA Zero-Shot Transfer — v1 MambaRUL (no retraining)
          </h1>
        </div>
        <p className="text-text-secondary text-sm">
          Model trained on CALCE/KJTU chemistry, evaluated on NASA batteries without any fine-tuning.
        </p>
      </motion.div>

      {loading ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[0,1,2,3].map(i => <SkeletonChart key={i} height={110} />)}
          </div>
          <SkeletonChart height={280} />
          <SkeletonChart height={200} />
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="space-y-6"
        >
          {/* Battery cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {batteries.map(cell => {
              const color = BATTERY_COLORS[cell.battery] ?? '#94a3b8'
              return (
                <div
                  key={cell.battery}
                  className="panel p-4"
                  style={{ borderColor: `${color}55` }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-base font-bold" style={{ color }}>{cell.battery}</span>
                    {cell.beats_naive ? (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                        <CheckCircle size={11} />Beats Naive
                      </span>
                    ) : (
                      <span className="flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold bg-red-500/15 text-red-400 border border-red-500/30">
                        <XCircle size={11} />Below Naive
                      </span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">RMSE</span>
                      <span className="font-mono text-text-primary">{cell.rmse.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">MAE</span>
                      <span className="font-mono text-text-primary">{cell.mae.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">R²</span>
                      <span className={`font-mono font-semibold ${cell.r2 > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {cell.r2.toFixed(4)}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-text-muted">Naive RMSE</span>
                      <span className="font-mono text-slate-400">{cell.naive_rmse.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Grouped bar chart */}
          <div className="panel p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-4">
              MambaRUL vs Naive RMSE — per battery
            </h3>
            <p className="text-xs text-text-muted mb-3">
              Green bars = positive R² (model explains variance). Red bars = negative R² (worse than mean baseline).
            </p>
            <Plot
              data={barTraces}
              layout={barLayout}
              config={plotConfig}
              style={{ width: '100%', height: 280 }}
            />
          </div>

          {/* R² horizontal bar chart */}
          <div className="panel p-5">
            <h3 className="text-sm font-semibold text-text-primary mb-4">R² per Battery</h3>
            <Plot
              data={r2Traces}
              layout={r2Layout}
              config={plotConfig}
              style={{ width: '100%', height: 220 }}
            />
          </div>

          {/* Key insight panel */}
          <div className="panel p-5 border-cyan-500/20 bg-cyan-500/5">
            <div className="flex items-start gap-3">
              <Info size={16} className="text-cyan-400 mt-0.5 flex-shrink-0" />
              <div>
                <h3 className="font-semibold text-cyan-400 mb-1 text-sm">Key Insight</h3>
                <p className="text-sm text-text-secondary leading-relaxed">
                  Batteries with knee-point degradation (B0005/B0018) transfer well. Linear degradation
                  (B0006/B0007) fails — genuine domain shift. The model learned degradation patterns
                  that match non-linear capacity fade but struggles with smooth linear profiles.
                </p>
              </div>
            </div>
          </div>

          {/* Combined metrics footer */}
          {data?.combined && (
            <div className="panel p-4">
              <h3 className="text-sm font-semibold text-text-muted uppercase tracking-wider mb-3">
                Combined Metrics — All 4 NASA Batteries
              </h3>
              <div className="grid grid-cols-3 gap-6">
                <div className="text-center">
                  <p className="font-mono text-2xl font-semibold text-text-primary">{data.combined.rmse.toFixed(1)}</p>
                  <p className="text-xs text-text-muted mt-1 uppercase tracking-wider">RMSE</p>
                </div>
                <div className="text-center">
                  <p className="font-mono text-2xl font-semibold text-text-primary">{data.combined.mae.toFixed(2)}</p>
                  <p className="text-xs text-text-muted mt-1 uppercase tracking-wider">MAE</p>
                </div>
                <div className="text-center">
                  <p className={`font-mono text-2xl font-semibold ${data.combined.r2 > 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {data.combined.r2.toFixed(4)}
                  </p>
                  <p className="text-xs text-text-muted mt-1 uppercase tracking-wider">R²</p>
                </div>
              </div>
            </div>
          )}
        </motion.div>
      )}
    </div>
  )
}

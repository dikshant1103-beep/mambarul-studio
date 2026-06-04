import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { BarChart2, Info } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ChemData {
  rmse_values: number[]
  mean: number
  std: number
  color: string
  cells: string[]
}

interface ErrorDistResponse {
  chemistries: Record<string, ChemData>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n: number, dp = 1) {
  return Number.isFinite(n) ? n.toFixed(dp) : '—'
}

function minVal(arr: number[]) {
  return arr.length ? Math.min(...arr) : 0
}

function maxVal(arr: number[]) {
  return arr.length ? Math.max(...arr) : 0
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function ErrorDistribution() {
  const [data, setData] = useState<ErrorDistResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch('/api/error-distribution')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: ErrorDistResponse) => setData(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // Build Plotly traces: box with all points
  const boxTraces: Plotly.Data[] = data
    ? Object.entries(data.chemistries).map(([name, chem]) => ({
        type: 'box' as const,
        name,
        y: chem.rmse_values,
        boxpoints: 'all' as const,
        jitter: 0.4,
        pointpos: 0,
        marker: {
          color: chem.color,
          size: 8,
          line: { color: '#0a0e1a', width: 1.5 },
          opacity: 0.9,
        },
        line: { color: chem.color, width: 2 },
        fillcolor: chem.color + '33',
        whiskerwidth: 0.6,
        hovertemplate: '<b>%{x}</b><br>RMSE: %{y:.1f}<extra></extra>',
      }))
    : []

  const layout: Partial<Plotly.Layout> = {
    ...darkLayout,
    yaxis: {
      ...darkLayout.yaxis,
      title: { text: 'RMSE (cycles)', font: { color: '#94a3b8', size: 11 } },
    },
    xaxis: {
      ...darkLayout.xaxis,
      title: { text: 'Chemistry', font: { color: '#94a3b8', size: 11 } },
    },
    showlegend: false,
    margin: { t: 20, b: 60, l: 70, r: 20 },
  }

  const chemEntries = data ? Object.entries(data.chemistries) : []

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6"
      >
        <div className="flex items-center gap-3 mb-1">
          <BarChart2 className="text-blue-400" size={22} />
          <h1 className="text-2xl font-bold text-slate-100">
            Prediction Error Distribution — Per Chemistry
          </h1>
        </div>
        <p className="text-sm text-slate-400 ml-9">
          Box plots with individual cell RMSE overlaid. Each dot = one test cell.
        </p>
      </motion.div>

      {/* Box + scatter chart */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="rounded-xl border p-5 mb-6"
        style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
      >
        <h2 className="text-sm font-semibold text-slate-300 mb-4 uppercase tracking-wide">
          RMSE Distribution by Chemistry
        </h2>
        {loading ? (
          <SkeletonChart height={360} />
        ) : error ? (
          <div className="flex items-center justify-center h-72 text-red-400 text-sm">
            Failed to load data: {error}
          </div>
        ) : (
          <Plot
            data={boxTraces}
            layout={layout}
            config={plotConfig}
            style={{ width: '100%', height: 360 }}
          />
        )}
      </motion.div>

      {/* Per-chemistry stat cards */}
      {!loading && !error && data && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16 }}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 mb-6"
        >
          {chemEntries.map(([name, chem]) => (
            <div
              key={name}
              className="rounded-xl border p-4"
              style={{ background: '#0a0e1a', borderColor: chem.color + '66' }}
            >
              <div
                className="text-xs font-bold mb-3 truncate"
                style={{ color: chem.color }}
              >
                {name}
              </div>
              <div className="space-y-1.5 text-xs text-slate-400">
                <div className="flex justify-between">
                  <span>Mean RMSE</span>
                  <span className="font-mono text-slate-200">{fmt(chem.mean)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Std</span>
                  <span className="font-mono text-slate-200">{fmt(chem.std)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Min</span>
                  <span className="font-mono text-emerald-400">{fmt(minVal(chem.rmse_values))}</span>
                </div>
                <div className="flex justify-between">
                  <span>Max</span>
                  <span className="font-mono text-red-400">{fmt(maxVal(chem.rmse_values))}</span>
                </div>
                <div className="flex justify-between">
                  <span>Cells</span>
                  <span className="font-mono text-slate-300">{chem.rmse_values.length}</span>
                </div>
              </div>
              {/* mini bar for mean */}
              <div className="mt-3 h-1 rounded-full" style={{ background: '#1e3a5f' }}>
                <div
                  className="h-1 rounded-full"
                  style={{
                    width: `${Math.min(100, (chem.mean / 450) * 100)}%`,
                    background: chem.color,
                  }}
                />
              </div>
            </div>
          ))}
        </motion.div>
      )}

      {/* Cell-level detail table */}
      {!loading && !error && data && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.22 }}
          className="rounded-xl border p-5 mb-6"
          style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
        >
          <h2 className="text-sm font-semibold text-slate-300 mb-4 uppercase tracking-wide">
            Cell-Level RMSE Detail
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-slate-300">
              <thead>
                <tr className="border-b" style={{ borderColor: '#1e3a5f' }}>
                  <th className="text-left py-2 pr-4 text-slate-500 font-semibold">Chemistry</th>
                  <th className="text-left py-2 pr-4 text-slate-500 font-semibold">Cell</th>
                  <th className="text-right py-2 text-slate-500 font-semibold">RMSE</th>
                </tr>
              </thead>
              <tbody>
                {chemEntries.flatMap(([name, chem]) =>
                  chem.cells.map((cell, i) => (
                    <tr
                      key={`${name}-${cell}`}
                      className="border-b hover:bg-white/5 transition-colors"
                      style={{ borderColor: '#1e3a5f22' }}
                    >
                      <td className="py-1.5 pr-4">
                        <span
                          className="px-2 py-0.5 rounded text-xs font-medium"
                          style={{ background: chem.color + '22', color: chem.color }}
                        >
                          {name}
                        </span>
                      </td>
                      <td className="py-1.5 pr-4 font-mono">{cell}</td>
                      <td className="py-1.5 text-right font-mono">
                        {fmt(chem.rmse_values[i] ?? 0)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* Insight box */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.28 }}
        className="rounded-xl border p-5 flex gap-3"
        style={{ background: '#0f172a', borderColor: '#3b82f644' }}
      >
        <Info size={16} className="text-blue-400 mt-0.5 shrink-0" />
        <p className="text-sm text-slate-300 leading-relaxed">
          <span className="text-blue-400 font-semibold">Insight: </span>
          CALCE-LCO achieves the lowest RMSE (21.4 mean) — the model was trained on this chemistry.
          MIT-LFP shows the highest variance (std=88) due to out-of-distribution long-life cells with
          non-standard degradation trajectories. Oxford ZS spread reflects the domain gap when the
          model is applied zero-shot, without any Oxford-specific fine-tuning.
        </p>
      </motion.div>
    </div>
  )
}

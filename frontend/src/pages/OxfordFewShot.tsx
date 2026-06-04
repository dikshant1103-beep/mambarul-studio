import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Beaker, TrendingDown, TrendingUp, AlertTriangle, Info } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CellResult {
  cell: string
  estimated_life?: number
  n_windows?: number
  zs_rmse: number
  zs_r2: number
  ft_rmse: number
  ft_r2: number
  delta_r2: number
}

interface OxfordFewShotResponse {
  cells: CellResult[]
  mean_zs_r2: number
  mean_ft_r2: number
  mean_delta_r2: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n: number, dp = 2) {
  return Number.isFinite(n) ? n.toFixed(dp) : '—'
}

const TEST_CELLS = new Set(['Cell7', 'Cell8'])

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function OxfordFewShot() {
  const [data, setData] = useState<OxfordFewShotResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch('/api/oxford-fewshot')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: OxfordFewShotResponse) => setData(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  // --- Grouped bar chart: ZS RMSE vs FT RMSE ---
  const cells = data?.cells ?? []
  const cellNames = cells.map(c => c.cell)

  const rmseTraces: Plotly.Data[] = [
    {
      type: 'bar' as const,
      name: 'ZS RMSE (zero-shot)',
      x: cellNames,
      y: cells.map(c => c.zs_rmse),
      marker: {
        color: cells.map(c => (TEST_CELLS.has(c.cell) ? '#64748b' : '#475569')),
        line: {
          color: cells.map(c => (TEST_CELLS.has(c.cell) ? '#94a3b8' : '#64748b')),
          width: cells.map(c => (TEST_CELLS.has(c.cell) ? 2 : 1)),
        },
      },
      hovertemplate: '<b>%{x}</b><br>ZS RMSE: %{y:.1f}<extra></extra>',
    },
    {
      type: 'bar' as const,
      name: 'FT RMSE (fine-tuned)',
      x: cellNames,
      y: cells.map(c => c.ft_rmse),
      marker: {
        color: cells.map(c => (TEST_CELLS.has(c.cell) ? '#3b82f6' : '#1d4ed8aa')),
        line: {
          color: cells.map(c => (TEST_CELLS.has(c.cell) ? '#60a5fa' : '#3b82f6')),
          width: cells.map(c => (TEST_CELLS.has(c.cell) ? 2.5 : 1)),
        },
      },
      hovertemplate: '<b>%{x}</b><br>FT RMSE: %{y:.1f}<extra></extra>',
    },
  ]

  const rmseLayout: Partial<Plotly.Layout> = {
    ...darkLayout,
    barmode: 'group' as const,
    yaxis: {
      ...darkLayout.yaxis,
      title: { text: 'RMSE (cycles)', font: { color: '#94a3b8', size: 11 } },
    },
    xaxis: { ...darkLayout.xaxis },
    margin: { t: 20, b: 50, l: 70, r: 20 },
  }

  // --- Delta R² horizontal bar chart ---
  const deltaTraces: Plotly.Data[] = [
    {
      type: 'bar' as const,
      name: 'ΔR²',
      x: cells.map(c => c.delta_r2),
      y: cellNames,
      orientation: 'h' as const,
      marker: {
        color: cells.map(c => (c.delta_r2 >= 0 ? '#10b981' : '#ef4444')),
        line: {
          color: cells.map(c =>
            TEST_CELLS.has(c.cell)
              ? c.delta_r2 >= 0
                ? '#34d399'
                : '#f87171'
              : 'transparent'
          ),
          width: cells.map(c => (TEST_CELLS.has(c.cell) ? 2 : 0)),
        },
      },
      hovertemplate: '<b>%{y}</b><br>ΔR²: %{x:.3f}<extra></extra>',
    },
  ]

  const deltaLayout: Partial<Plotly.Layout> = {
    ...darkLayout,
    xaxis: {
      ...darkLayout.xaxis,
      title: { text: 'ΔR² (FT − ZS)', font: { color: '#94a3b8', size: 11 } },
      zeroline: true,
      zerolinecolor: '#475569',
      zerolinewidth: 1.5,
    },
    yaxis: { ...darkLayout.yaxis },
    margin: { t: 20, b: 50, l: 70, r: 20 },
    shapes: [
      {
        type: 'line' as const,
        x0: 0,
        x1: 0,
        y0: -0.5,
        y1: cellNames.length - 0.5,
        line: { color: '#64748b', width: 1.5, dash: 'dot' as const },
      },
    ],
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-6"
      >
        <div className="flex items-center gap-3 mb-1">
          <Beaker className="text-cyan-400" size={22} />
          <h1 className="text-2xl font-bold text-slate-100">
            Oxford Few-Shot Fine-Tuning — B1+D Method
          </h1>
        </div>
        <p className="text-sm text-slate-400 ml-9">
          Full fine-tuning on few Oxford training cells. Different from B1+D K-calibration (snapshot-based).
        </p>
      </motion.div>

      {/* Summary stat pills */}
      {!loading && !error && data && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.06 }}
          className="grid grid-cols-3 gap-4 mb-6"
        >
          {[
            { label: 'Mean ZS R²', value: fmt(data.mean_zs_r2), color: '#64748b', icon: null },
            { label: 'Mean FT R²', value: fmt(data.mean_ft_r2), color: '#3b82f6', icon: null },
            {
              label: 'Mean ΔR²',
              value: fmt(data.mean_delta_r2),
              color: data.mean_delta_r2 >= 0 ? '#10b981' : '#ef4444',
              icon: data.mean_delta_r2 >= 0 ? TrendingUp : TrendingDown,
            },
          ].map(({ label, value, color, icon: Icon }) => (
            <div
              key={label}
              className="rounded-xl border p-4 flex flex-col gap-1"
              style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
            >
              <span className="text-xs text-slate-500 uppercase tracking-wide">{label}</span>
              <div className="flex items-center gap-2">
                {Icon && <Icon size={16} style={{ color }} />}
                <span className="text-2xl font-bold font-mono" style={{ color }}>
                  {value}
                </span>
              </div>
            </div>
          ))}
        </motion.div>
      )}

      {/* RMSE comparison bar chart */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-xl border p-5 mb-6"
        style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide">
            ZS RMSE vs FT RMSE — Per Cell
          </h2>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-sm inline-block" style={{ background: '#94a3b8' }} />
              Bold border = test cell
            </span>
          </div>
        </div>
        {loading ? (
          <SkeletonChart height={300} />
        ) : error ? (
          <div className="flex items-center justify-center h-60 text-red-400 text-sm">
            Failed to load data: {error}
          </div>
        ) : (
          <Plot
            data={rmseTraces}
            layout={rmseLayout}
            config={plotConfig}
            style={{ width: '100%', height: 300 }}
          />
        )}
      </motion.div>

      {/* Delta R² horizontal bar chart */}
      {!loading && !error && data && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16 }}
          className="rounded-xl border p-5 mb-6"
          style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
        >
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-4">
            ΔR² After Fine-Tuning (positive = improvement)
          </h2>
          <Plot
            data={deltaTraces}
            layout={deltaLayout}
            config={plotConfig}
            style={{ width: '100%', height: 280 }}
          />
        </motion.div>
      )}

      {/* Per-cell detail table */}
      {!loading && !error && data && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-xl border p-5 mb-6"
          style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
        >
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-4">
            Full Results Table
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-slate-500" style={{ borderColor: '#1e3a5f' }}>
                  {['Cell', 'ZS RMSE', 'ZS R²', 'FT RMSE', 'FT R²', 'ΔR²'].map(h => (
                    <th key={h} className="py-2 px-3 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cells.map(c => {
                  const isTest = TEST_CELLS.has(c.cell)
                  return (
                    <tr
                      key={c.cell}
                      className="border-b hover:bg-white/5 transition-colors"
                      style={{
                        borderColor: '#1e3a5f22',
                        background: isTest ? '#3b82f611' : undefined,
                      }}
                    >
                      <td className="py-2 px-3 font-mono font-medium">
                        <span style={{ color: isTest ? '#60a5fa' : '#cbd5e1' }}>
                          {c.cell}
                          {isTest && (
                            <span className="ml-2 text-[10px] text-blue-400 border border-blue-400/40 rounded px-1 py-0.5">
                              TEST
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 px-3 font-mono text-slate-300">{fmt(c.zs_rmse, 1)}</td>
                      <td className="py-2 px-3 font-mono text-slate-300">{fmt(c.zs_r2, 3)}</td>
                      <td className="py-2 px-3 font-mono text-slate-300">{fmt(c.ft_rmse, 1)}</td>
                      <td className="py-2 px-3 font-mono text-slate-300">{fmt(c.ft_r2, 3)}</td>
                      <td
                        className="py-2 px-3 font-mono font-semibold"
                        style={{ color: c.delta_r2 >= 0 ? '#10b981' : '#ef4444' }}
                      >
                        {c.delta_r2 >= 0 ? '+' : ''}
                        {fmt(c.delta_r2, 3)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* Key observation */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.26 }}
        className="rounded-xl border p-5 flex gap-3"
        style={{ background: '#0f172a', borderColor: '#f59e0b44' }}
      >
        <AlertTriangle size={16} className="text-amber-400 mt-0.5 shrink-0" />
        <div className="text-sm text-slate-300 leading-relaxed">
          <span className="text-amber-400 font-semibold">Key Observation: </span>
          Fine-tuning on very few Oxford cells{' '}
          <span className="text-red-400 font-semibold">HURTS</span> most cells (catastrophic
          forgetting). Only Cell7 and Cell8 see meaningful improvement. The full B1+D K-calibration
          method (snapshot-based, no weight updates) is superior — it adapts predictions without
          destroying prior learned representations.
        </div>
      </motion.div>

      {/* Method note */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="rounded-xl border p-4 mt-4 flex gap-3"
        style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
      >
        <Info size={14} className="text-slate-500 mt-0.5 shrink-0" />
        <p className="text-xs text-slate-500 leading-relaxed">
          This experiment fine-tunes all model weights on the few available Oxford training cells,
          then evaluates on the held-out test cells (Cell7, Cell8). The B1+D K-calibration method
          instead uses frozen weights and calibrates only the output scaling via K snapshots.
        </p>
      </motion.div>
    </div>
  )
}

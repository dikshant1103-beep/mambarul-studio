import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Crown, Layers, AlertTriangle, Trophy } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ChemResult {
  v10_r2: number
  v11s_r2: number
  v11e_r2: number
  v10_rmse?: number
  v11s_rmse?: number
  v11e_rmse?: number
  winner: 'v10' | 'v11s' | 'v11e'
}

type V11Response = Record<string, ChemResult | string> & {
  overall_winner?: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MODEL_COLORS: Record<string, string> = {
  v10: '#3b82f6',
  v11s: '#10b981',
  v11e: '#8b5cf6',
}

const MODEL_LABELS: Record<string, string> = {
  v10: 'v10-final',
  v11s: 'v11s (single seed)',
  v11e: 'v11e (ensemble)',
}

const CHEM_ORDER = ['CALCE-LCO', 'MIT-LFP', 'KJTU-NMC', 'TJU-NCM', 'Oxford ZS']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n: number | undefined, dp = 3) {
  if (n === undefined || !Number.isFinite(n)) return '—'
  return n.toFixed(dp)
}

function isChemResult(v: unknown): v is ChemResult {
  return typeof v === 'object' && v !== null && 'winner' in v
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function V11Results() {
  const [raw, setRaw] = useState<V11Response | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    fetch('/api/v11-comparison')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((d: V11Response) => setRaw(d))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const overallWinner = raw?.overall_winner ?? 'v10'

  // Build chem entries in defined order
  const chemEntries: [string, ChemResult][] = raw
    ? CHEM_ORDER.filter(k => k in raw && isChemResult(raw[k])).map(k => [k, raw[k] as ChemResult])
    : []

  const chemLabels = chemEntries.map(([k]) => k)

  // Grouped bar traces for R²
  const barTraces: Plotly.Data[] = (['v10', 'v11s', 'v11e'] as const).map(model => ({
    type: 'bar' as const,
    name: MODEL_LABELS[model],
    x: chemLabels,
    y: chemEntries.map(([, c]) => {
      const val = model === 'v10' ? c.v10_r2 : model === 'v11s' ? c.v11s_r2 : c.v11e_r2
      return val
    }),
    marker: {
      color: MODEL_COLORS[model],
      opacity: 0.85,
    },
    hovertemplate: `<b>%{x}</b><br>${MODEL_LABELS[model]}: %{y:.3f}<extra></extra>`,
  }))

  const barLayout: Partial<Plotly.Layout> = {
    ...darkLayout,
    barmode: 'group' as const,
    yaxis: {
      ...darkLayout.yaxis,
      title: { text: 'R²', font: { color: '#94a3b8', size: 11 } },
      zeroline: true,
      zerolinecolor: '#475569',
      zerolinewidth: 1,
    },
    xaxis: { ...darkLayout.xaxis },
    margin: { t: 20, b: 50, l: 70, r: 20 },
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        className="mb-2"
      >
        <div className="flex items-center gap-3 mb-1">
          <Layers className="text-purple-400" size={22} />
          <h1 className="text-2xl font-bold text-slate-100">
            v11 Large Model — v10-final vs v11s vs v11e
          </h1>
        </div>
        <p className="text-sm text-slate-400 ml-9">
          v11s = v11 single best seed (seed=42) &nbsp;|&nbsp; v11e = v11 ensemble (3 seeds)
        </p>
      </motion.div>

      {/* Overall winner banner */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.06 }}
        className="mt-4 mb-6 rounded-xl border p-4 flex items-center gap-3"
        style={{ background: '#3b82f611', borderColor: '#3b82f655' }}
      >
        <Trophy size={18} className="text-blue-400 shrink-0" />
        <div>
          <span className="text-blue-400 font-bold text-sm">Overall Winner: </span>
          <span className="text-slate-200 font-semibold text-sm">
            {MODEL_LABELS[overallWinner] ?? overallWinner}
          </span>
          <span className="text-slate-400 text-xs ml-2">
            — best cross-chemistry robustness
          </span>
        </div>
      </motion.div>

      {/* Grouped bar chart */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-xl border p-5 mb-6"
        style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
      >
        <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-4">
          R² Comparison — All Chemistries
        </h2>
        {loading ? (
          <SkeletonChart height={320} />
        ) : error ? (
          <div className="flex items-center justify-center h-72 text-red-400 text-sm">
            Failed to load data: {error}
          </div>
        ) : (
          <Plot
            data={barTraces}
            layout={barLayout}
            config={plotConfig}
            style={{ width: '100%', height: 320 }}
          />
        )}
      </motion.div>

      {/* Per-chemistry winner badges + cards */}
      {!loading && !error && chemEntries.length > 0 && (
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
              style={{ background: '#0a0e1a', borderColor: '#1e3a5f' }}
            >
              <div className="text-xs font-bold text-slate-300 mb-3 truncate">{name}</div>
              <div className="space-y-2">
                {(['v10', 'v11s', 'v11e'] as const).map(model => {
                  const r2 =
                    model === 'v10' ? chem.v10_r2 : model === 'v11s' ? chem.v11s_r2 : chem.v11e_r2
                  const isWinner = chem.winner === model
                  return (
                    <div
                      key={model}
                      className="flex items-center justify-between text-xs rounded px-2 py-1"
                      style={{
                        background: isWinner ? MODEL_COLORS[model] + '22' : 'transparent',
                        border: isWinner ? `1px solid ${MODEL_COLORS[model]}55` : '1px solid transparent',
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        {isWinner && (
                          <Crown size={10} style={{ color: MODEL_COLORS[model] }} />
                        )}
                        <span style={{ color: isWinner ? MODEL_COLORS[model] : '#64748b' }}>
                          {MODEL_LABELS[model]}
                        </span>
                      </div>
                      <span
                        className="font-mono font-semibold"
                        style={{ color: isWinner ? MODEL_COLORS[model] : '#475569' }}
                      >
                        {fmt(r2)}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </motion.div>
      )}

      {/* Full summary table */}
      {!loading && !error && chemEntries.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="rounded-xl border p-5 mb-6"
          style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
        >
          <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-4">
            Summary Table — R² &amp; RMSE
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-slate-500" style={{ borderColor: '#1e3a5f' }}>
                  <th className="text-left py-2 pr-4 font-semibold">Chemistry</th>
                  {(['v10', 'v11s', 'v11e'] as const).map(m => (
                    <th
                      key={m}
                      className="py-2 px-3 text-right font-semibold"
                      style={{ color: MODEL_COLORS[m] }}
                    >
                      {MODEL_LABELS[m]}
                    </th>
                  ))}
                  <th className="py-2 pl-4 text-left font-semibold text-slate-500">Winner</th>
                </tr>
              </thead>
              <tbody>
                {chemEntries.map(([name, chem]) => (
                  <tr
                    key={name}
                    className="border-b hover:bg-white/5 transition-colors"
                    style={{ borderColor: '#1e3a5f22' }}
                  >
                    <td className="py-2 pr-4 font-medium text-slate-200">{name}</td>
                    {(
                      [
                        { model: 'v10' as const, r2: chem.v10_r2, rmse: chem.v10_rmse },
                        { model: 'v11s' as const, r2: chem.v11s_r2, rmse: chem.v11s_rmse },
                        { model: 'v11e' as const, r2: chem.v11e_r2, rmse: chem.v11e_rmse },
                      ] as const
                    ).map(({ model, r2, rmse }) => {
                      const isWinner = chem.winner === model
                      return (
                        <td key={model} className="py-2 px-3 text-right">
                          <div
                            className="font-mono font-semibold"
                            style={{ color: isWinner ? MODEL_COLORS[model] : '#64748b' }}
                          >
                            {fmt(r2)}
                          </div>
                          {rmse !== undefined && (
                            <div className="font-mono text-[10px] text-slate-600">
                              {fmt(rmse, 2)} RMSE
                            </div>
                          )}
                        </td>
                      )
                    })}
                    <td className="py-2 pl-4">
                      <div className="flex items-center gap-1">
                        <Crown size={10} style={{ color: MODEL_COLORS[chem.winner] }} />
                        <span
                          className="text-xs font-semibold"
                          style={{ color: MODEL_COLORS[chem.winner] }}
                        >
                          {MODEL_LABELS[chem.winner]}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </motion.div>
      )}

      {/* Key finding */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.26 }}
        className="rounded-xl border p-5 flex gap-3"
        style={{ background: '#0f172a', borderColor: '#ef444444' }}
      >
        <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
        <div className="text-sm text-slate-300 leading-relaxed">
          <span className="text-red-400 font-semibold">Key Finding: </span>
          v11s wins 3/5 chemistries (CALCE-LCO, TJU-NCM, Oxford ZS) but{' '}
          <span className="text-red-400 font-semibold">CATASTROPHICALLY</span> fails on MIT-LFP
          (v11e R²=−10.44). v10-final is more robust overall — a larger model does not guarantee
          better cross-chemistry generalization. The v10-final architecture balances expressiveness
          and regularization more effectively across the full multi-chemistry test suite.
        </div>
      </motion.div>
    </div>
  )
}

/**
 * TTADemo.tsx — Test-Time Adaptation Live Demo
 * Shows the R² jump from 0.108 → 0.668 using real adapt_results.csv data.
 * Interactive: click a cell to see its before/after predictions animated.
 */
import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, TrendingUp, Info } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

const CHEM_COLORS: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#ef4444'
}

interface CellResult {
  cell_id: string; chem: string; lifetime: number; masked: boolean
  adapted: boolean; r2_base: number; r2_adapted: number; gain: number
}

// Animated R² counter
function R2Counter({ value, color }: { value: number; color: string }) {
  const [display, setDisplay] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const from = 0, to = value, duration = 900
    const frame = () => {
      const t = Math.min((Date.now() - start) / duration, 1)
      const eased = 1 - Math.pow(1 - t, 3)
      setDisplay(from + (to - from) * eased)
      if (t < 1) requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }, [value])
  return (
    <motion.span className="font-mono text-3xl font-bold" style={{ color }}
      initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
      {display.toFixed(3)}
    </motion.span>
  )
}

export default function TTADemo() {
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<CellResult | null>(null)
  const [showAfter, setShowAfter] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    fetch('/api/tta-results')
      .then(r => r.ok ? r.json() : null)
      .then(d => { setData(d); if (d?.per_cell?.length) setSelected(d.per_cell[0]) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Auto-reveal "after" 800ms after selecting a cell
  useEffect(() => {
    setShowAfter(false)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setShowAfter(true), 800)
    return () => clearTimeout(timerRef.current)
  }, [selected])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <motion.div className="w-8 h-8 rounded-full border-2 border-brand-blue border-t-transparent"
        animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
    </div>
  )

  const cells: CellResult[] = data?.per_cell ?? []
  const activeCells = cells.filter(c => !c.masked)
  const meanBase    = data?.mean_r2_base    ?? 0.108
  const meanAdapted = data?.mean_r2_adapted ?? 0.668

  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }} className="px-8 py-8 max-w-7xl mx-auto">

      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <Zap size={22} className="text-amber-400" />
          <h1 className="text-2xl font-bold text-text-primary">Test-Time Adaptation — Live Demo</h1>
        </div>
        <p className="text-text-secondary">
          80 calibration cycles + 30 gradient steps on FiLM layers. Mean R² jumps from {meanBase.toFixed(3)} → {meanAdapted.toFixed(3)}.
          Click a cell to watch the adaptation play out.
        </p>
      </div>

      {/* Hero counter */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="panel p-5 text-center col-span-1">
          <div className="text-xs text-text-muted mb-1 uppercase tracking-wider">Before TTA</div>
          <R2Counter value={meanBase} color="#ef4444" />
          <div className="text-xs text-text-muted mt-1">Mean R² (7 active cells)</div>
        </div>
        <div className="panel p-5 flex items-center justify-center">
          <div className="text-center">
            <TrendingUp size={32} className="text-amber-400 mx-auto mb-2" />
            <div className="font-mono text-2xl font-bold text-amber-400">
              +{((meanAdapted - meanBase) * 100).toFixed(1)}pp
            </div>
            <div className="text-xs text-text-muted">R² improvement</div>
          </div>
        </div>
        <div className="panel p-5 text-center col-span-1">
          <div className="text-xs text-text-muted mb-1 uppercase tracking-wider">After TTA</div>
          <R2Counter value={meanAdapted} color="#10b981" />
          <div className="text-xs text-text-muted mt-1">Mean R² (7 active cells)</div>
        </div>
      </div>

      <div className="flex gap-5">
        {/* Cell selector */}
        <div className="w-64 shrink-0 space-y-2">
          <div className="text-xs text-text-muted uppercase tracking-wider mb-2">Select a cell</div>
          {activeCells.map(cell => {
            const gain  = cell.r2_adapted - cell.r2_base
            const color = CHEM_COLORS[cell.chem] ?? '#64748b'
            return (
              <button key={cell.cell_id} onClick={() => setSelected(cell)}
                className={`w-full text-left panel p-3 transition-all ${selected?.cell_id === cell.cell_id ? 'border-opacity-100' : 'opacity-60 hover:opacity-90'}`}
                style={{ borderColor: color + (selected?.cell_id===cell.cell_id?'99':'33') }}>
                <div className="text-xs font-bold truncate mb-0.5" style={{ color }}>
                  {cell.cell_id.split('/').pop()?.split('_').slice(-1)[0] ?? cell.cell_id}
                </div>
                <div className="text-xs text-text-muted">{cell.chem} · {cell.lifetime} cy</div>
                <div className="flex gap-2 mt-1">
                  <span className="font-mono text-xs text-red-400">{cell.r2_base.toFixed(3)}</span>
                  <span className="text-xs text-text-muted">→</span>
                  <span className="font-mono text-xs text-green-400">{cell.r2_adapted.toFixed(3)}</span>
                  <span className={`font-mono text-xs ml-auto ${gain>0.1?'text-amber-400':'text-text-muted'}`}>
                    {gain>0?'+':''}{gain.toFixed(3)}
                  </span>
                </div>
              </button>
            )
          })}
        </div>

        {/* Detail panel */}
        <div className="flex-1 min-w-0 space-y-4">
          {selected && (
            <AnimatePresence mode="wait">
              <motion.div key={selected.cell_id}
                initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>

                {/* Before / After cards */}
                <div className="grid grid-cols-2 gap-4 mb-4">
                  <div className="panel p-5" style={{ borderColor: '#ef444433' }}>
                    <div className="text-xs text-text-muted mb-2 uppercase">Before TTA</div>
                    <div className="font-mono text-4xl font-bold text-red-400 mb-1">
                      {selected.r2_base.toFixed(3)}
                    </div>
                    <div className="text-xs text-text-muted">R² — 5-model ensemble, no adaptation</div>
                    <div className="mt-3 h-2 bg-bg-elevated rounded-full overflow-hidden">
                      <motion.div className="h-full rounded-full bg-red-400"
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.max(0, selected.r2_base * 100)}%` }}
                        transition={{ duration: 0.6 }} />
                    </div>
                  </div>

                  <div className="panel p-5" style={{ borderColor: showAfter ? '#10b98133' : '#1e3a5f' }}>
                    <div className="text-xs text-text-muted mb-2 uppercase">
                      After TTA {selected.adapted ? '✓ adapted' : '— no change needed'}
                    </div>
                    <AnimatePresence>
                      {showAfter ? (
                        <motion.div key="after" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                          <div className="font-mono text-4xl font-bold text-green-400 mb-1">
                            {selected.r2_adapted.toFixed(3)}
                          </div>
                          <div className="text-xs text-text-muted">R² — 80 calib cycles + 30 adapt steps</div>
                          <div className="mt-3 h-2 bg-bg-elevated rounded-full overflow-hidden">
                            <motion.div className="h-full rounded-full bg-green-400"
                              initial={{ width: 0 }}
                              animate={{ width: `${Math.max(0, selected.r2_adapted * 100)}%` }}
                              transition={{ duration: 0.8 }} />
                          </div>
                        </motion.div>
                      ) : (
                        <motion.div key="loading" className="flex items-center gap-2 mt-2"
                          animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 0.6, repeat: Infinity }}>
                          <div className="w-5 h-5 rounded-full border-2 border-green-400 border-t-transparent animate-spin" />
                          <span className="text-sm text-green-400">Adapting…</span>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* All cells bar comparison */}
                <div className="panel p-5">
                  <h3 className="section-title mb-3">Per-Cell R² — Before vs After TTA (all cells)</h3>
                  <Plot
                    data={[
                      {
                        type: 'bar', name: 'Before TTA', x: activeCells.map(c => c.cell_id.split('_').pop() ?? c.cell_id),
                        y: activeCells.map(c => c.r2_base),
                        marker: { color: '#ef444488', opacity: 0.85 },
                        text: activeCells.map(c => c.r2_base.toFixed(3)), textposition: 'outside' as const,
                      },
                      {
                        type: 'bar', name: 'After TTA', x: activeCells.map(c => c.cell_id.split('_').pop() ?? c.cell_id),
                        y: activeCells.map(c => c.r2_adapted),
                        marker: { color: activeCells.map(c => c.adapted ? '#10b981cc' : '#10b98155'), opacity: 0.9 },
                        text: activeCells.map(c => c.r2_adapted.toFixed(3)), textposition: 'outside' as const,
                      },
                    ]}
                    layout={{
                      ...darkLayout, height: 280, barmode: 'group',
                      margin: { t: 10, b: 80, l: 60, r: 20 },
                      xaxis: { ...darkLayout.xaxis as object, tickangle: -30, tickfont: { color: '#94a3b8', size: 9 } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: 'R²', font: { color: '#64748b' } }, range: [-3, 1.3] },
                      shapes: [{ type: 'line', x0: -0.5, x1: activeCells.length - 0.5, y0: 0, y1: 0, line: { color: '#475569', width: 1, dash: 'dot' } }],
                      legend: { ...darkLayout.legend },
                    } as Plotly.Layout}
                    config={{ ...plotConfig, displayModeBar: false }}
                    style={{ width: '100%' }}
                  />
                </div>
              </motion.div>
            </AnimatePresence>
          )}
        </div>
      </div>

      {/* How TTA works */}
      <div className="panel p-5 mt-5 border-amber-500/20 bg-amber-500/5">
        <h3 className="text-sm font-semibold text-amber-400 mb-3 flex items-center gap-2">
          <Info size={14} /> How Test-Time Adaptation works
        </h3>
        <div className="grid grid-cols-3 gap-6 text-sm text-text-secondary">
          <div>
            <div className="font-bold text-amber-300 mb-1">1. Calibration (80 cycles)</div>
            <p>The first 80 cycles of the test cell are used to estimate the cell's degradation characteristics. No labels needed.</p>
          </div>
          <div>
            <div className="font-bold text-amber-300 mb-1">2. FiLM Layer Adaptation (30 steps)</div>
            <p>Feature-wise Linear Modulation (FiLM) layers in the model are fine-tuned for 30 gradient steps using the 80 calibration cycles.</p>
          </div>
          <div>
            <div className="font-bold text-amber-300 mb-1">3. Adapted Prediction</div>
            <p>The adapted model then predicts on the remaining cycles. The R² improvement from 0.108 → 0.668 is the thesis's headline result.</p>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Activity, Star } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

interface SeedData {
  epochs: number[]
  tr_loss: number[]
  calce_val: number[]
  ox_r2: number[]
  is_best: boolean[]
  best_epoch: number
  best_calce_val: number
  best_ox_r2: number
  early_stop_epoch: number
}

interface TrainingLogsResponse {
  seeds: Record<string, SeedData>
}

const SEED_KEYS = ['123', '2024', '7', '999'] as const
const SEED_COLORS: Record<string, string> = {
  '123': '#3b82f6',
  '2024': '#10b981',
  '7': '#f59e0b',
  '999': '#8b5cf6',
}

type MetricTab = 'tr_loss' | 'calce_val' | 'ox_r2'

const TAB_META: { key: MetricTab; label: string; yTitle: string }[] = [
  { key: 'tr_loss',   label: 'Train Loss',        yTitle: 'Loss'       },
  { key: 'calce_val', label: 'CALCE Val RMSE',     yTitle: 'RMSE'       },
  { key: 'ox_r2',     label: 'Oxford R²',          yTitle: 'R²'         },
]

export default function TrainingLogReplay() {
  const [data, setData] = useState<TrainingLogsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedSeeds, setSelectedSeeds] = useState<Set<string>>(new Set(SEED_KEYS))
  const [activeTab, setActiveTab] = useState<MetricTab>('calce_val')

  useEffect(() => {
    fetch('/api/training-logs')
      .then(r => r.ok ? r.json() : null)
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  function toggleSeed(seed: string) {
    setSelectedSeeds(prev => {
      const next = new Set(prev)
      if (next.has(seed)) {
        if (next.size > 1) next.delete(seed)
      } else {
        next.add(seed)
      }
      return next
    })
  }

  const tab = TAB_META.find(t => t.key === activeTab)!

  const traces: Plotly.Data[] = []
  if (data) {
    for (const seedKey of SEED_KEYS) {
      if (!selectedSeeds.has(seedKey)) continue
      const s = data.seeds[seedKey]
      if (!s) continue
      const color = SEED_COLORS[seedKey]
      const yVals = s[activeTab]

      // Main line trace
      traces.push({
        x: s.epochs,
        y: yVals,
        type: 'scatter',
        mode: 'lines',
        name: `Seed ${seedKey}`,
        line: { color, width: 2 },
        showlegend: true,
      } as Plotly.Data)

      // Best epoch star marker
      const bestIdx = s.epochs.indexOf(s.best_epoch)
      if (bestIdx !== -1) {
        traces.push({
          x: [s.epochs[bestIdx]],
          y: [yVals[bestIdx]],
          type: 'scatter',
          mode: 'markers',
          name: `Seed ${seedKey} best`,
          marker: {
            symbol: 'star',
            size: 14,
            color,
            line: { color: '#ffffff', width: 1 },
          },
          showlegend: false,
          hovertemplate: `<b>Seed ${seedKey} — Best</b><br>Epoch: ${s.best_epoch}<br>${tab.label}: %{y:.4f}<extra></extra>`,
        } as Plotly.Data)
      }
    }
  }

  const layout: Partial<Plotly.Layout> = {
    ...darkLayout,
    xaxis: { ...darkLayout.xaxis, title: { text: 'Epoch', font: { color: '#64748b', size: 11 } } },
    yaxis: { ...darkLayout.yaxis, title: { text: tab.yTitle, font: { color: '#64748b', size: 11 } } },
    margin: { t: 20, b: 55, l: 65, r: 20 },
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
          <Activity size={22} className="text-blue-400" />
          <h1 className="text-2xl font-bold text-text-primary">
            Real Training Log Replay — v11-large (4 seeds)
          </h1>
        </div>
        <p className="text-text-secondary text-sm">
          Epoch-by-epoch training curves for all 4 seeds. Star markers indicate each seed's best checkpoint.
        </p>
      </motion.div>

      {loading ? (
        <div className="space-y-4">
          <SkeletonChart height={300} />
          <div className="grid grid-cols-4 gap-4">
            {[0,1,2,3].map(i => <SkeletonChart key={i} height={100} />)}
          </div>
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="space-y-6"
        >
          {/* Seed toggles */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-text-muted uppercase tracking-wider font-medium">Seeds:</span>
            {SEED_KEYS.map(seed => {
              const active = selectedSeeds.has(seed)
              const color = SEED_COLORS[seed]
              return (
                <button
                  key={seed}
                  onClick={() => toggleSeed(seed)}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium border transition-all duration-200"
                  style={{
                    backgroundColor: active ? `${color}22` : 'transparent',
                    borderColor: active ? color : '#1e3a5f',
                    color: active ? color : '#64748b',
                  }}
                >
                  Seed {seed}
                </button>
              )
            })}
          </div>

          {/* Tab bar + Chart */}
          <div className="panel p-5">
            <div className="flex gap-1 mb-5">
              {TAB_META.map(t => (
                <button
                  key={t.key}
                  onClick={() => setActiveTab(t.key)}
                  className="px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-200"
                  style={{
                    backgroundColor: activeTab === t.key ? '#1e3a5f' : 'transparent',
                    color: activeTab === t.key ? '#f1f5f9' : '#64748b',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <Plot
              data={traces}
              layout={layout}
              config={plotConfig}
              style={{ width: '100%', height: 340 }}
            />
          </div>

          {/* Per-seed summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {SEED_KEYS.map(seedKey => {
              const s = data?.seeds[seedKey]
              const color = SEED_COLORS[seedKey]
              const active = selectedSeeds.has(seedKey)
              return (
                <div
                  key={seedKey}
                  className="panel p-4 transition-all duration-200"
                  style={{ opacity: active ? 1 : 0.45, borderColor: active ? `${color}55` : '#1e3a5f' }}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-semibold" style={{ color }}>Seed {seedKey}</span>
                    <Star size={14} style={{ color }} />
                  </div>
                  {s ? (
                    <div className="space-y-2">
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">Best Epoch</span>
                        <span className="font-mono text-text-primary">{s.best_epoch}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">CALCE RMSE</span>
                        <span className="font-mono text-emerald-400">{s.best_calce_val.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">Oxford R²</span>
                        <span className="font-mono text-blue-400">{s.best_ox_r2.toFixed(3)}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">Early Stop</span>
                        <span className="font-mono text-amber-400">ep {s.early_stop_epoch}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-text-muted">No data</p>
                  )}
                </div>
              )
            })}
          </div>
        </motion.div>
      )}
    </div>
  )
}

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap, TrendingDown, AlertTriangle, Award } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
interface VersionEntry {
  id: string
  rmse: number | null
  r2: number | null
  notes: string
  era: 'broken' | 'early' | 'breakthrough' | 'polished' | 'best'
}

const VERSIONS: VersionEntry[] = [
  { id: 'v1',        rmse: 88.8,  r2: null,  notes: '8 features, basic Mamba. First working prototype.', era: 'early' },
  { id: 'v2',        rmse: 85.2,  r2: null,  notes: 'EOL weighting added. Slight improvement.', era: 'early' },
  { id: 'v3',        rmse: 76.4,  r2: null,  notes: '14 features, ICA/DVA added. Better feature engineering.', era: 'early' },
  { id: 'v3b',       rmse: 72.1,  r2: null,  notes: '12 features, selective ICA. Removed noisy ICA features.', era: 'early' },
  { id: 'v4',        rmse: 77.6,  r2: null,  notes: 'Ensemble (worse than single). Ensembling hurt here.', era: 'early' },
  { id: 'v5',        rmse: 81.8,  r2: null,  notes: 'MMD domain adaptation. Adaptation strategy regressed performance.', era: 'early' },
  { id: 'v7b',       rmse: 320.0, r2: 0.0,   notes: 'Multi-dataset, broken R²≈0. Complete failure on combined data. Stride=10 was the culprit.', era: 'broken' },
  { id: 'v8',        rmse: 23.95, r2: 0.842, notes: 'BREAKTHROUGH: stride=1 + Savitzky-Golay smoothing + 13 features. Single largest improvement in project.', era: 'breakthrough' },
  { id: 'v9',        rmse: 22.11, r2: 0.911, notes: '+Oxford training data. Cross-dataset generalization improved.', era: 'polished' },
  { id: 'v10',       rmse: 22.7,  r2: 0.908, notes: '+PyBaMM synthetic data. Synthetic augmentation explored.', era: 'polished' },
  { id: 'v10-full',  rmse: 21.5,  r2: 0.927, notes: 'Clean split, no leakage. Fixed data leakage in evaluation.', era: 'polished' },
  { id: 'v10-final', rmse: 20.6,  r2: 0.911, notes: '+LFP IC curve, best overall robustness across all 5 chemistries.', era: 'best' },
]

// ---------------------------------------------------------------------------
// Styling helpers
// ---------------------------------------------------------------------------
const ERA_COLORS: Record<VersionEntry['era'], string> = {
  broken:      '#ef4444',
  early:       '#f59e0b',
  breakthrough:'#10b981',
  polished:    '#3b82f6',
  best:        '#f59e0b',
}

const ERA_LABELS: Record<VersionEntry['era'], string> = {
  broken:       'Failure',
  early:        'Early Stage',
  breakthrough: 'Breakthrough',
  polished:     'Polished',
  best:         'Best',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function VersionLadderInteractive() {
  const [selected, setSelected] = useState<string>('v10-final')

  const selectedVersion = VERSIONS.find(v => v.id === selected) ?? VERSIONS[VERSIONS.length - 1]

  // Build RMSE trend trace — spike for v7b
  const trendTrace: Plotly.Data = {
    type: 'scatter' as const,
    mode: 'lines+markers' as const,
    name: 'RMSE',
    x: VERSIONS.map(v => v.id),
    y: VERSIONS.map(v => v.rmse),
    line: { color: '#3b82f6', width: 2 },
    marker: {
      size: VERSIONS.map(v =>
        v.id === selected ? 12 : v.id === 'v7b' ? 14 : v.era === 'breakthrough' ? 12 : 8
      ),
      color: VERSIONS.map(v =>
        v.id === selected
          ? '#f59e0b'
          : v.id === 'v7b'
          ? '#ef4444'
          : ERA_COLORS[v.era]
      ),
      symbol: VERSIONS.map(v =>
        v.era === 'breakthrough' ? 'star' : v.id === 'v7b' ? 'x' : 'circle'
      ),
      line: {
        color: VERSIONS.map(v => (v.id === selected ? '#fbbf24' : 'transparent')),
        width: 2,
      },
    },
    hovertemplate: '<b>%{x}</b><br>RMSE: %{y:.1f}<extra></extra>',
  }

  // Reference line at v7b RMSE=320 → annotate
  const trendLayout: Partial<Plotly.Layout> = {
    ...darkLayout,
    yaxis: {
      ...darkLayout.yaxis,
      title: { text: 'RMSE (cycles)', font: { color: '#94a3b8', size: 11 } },
    },
    xaxis: {
      ...darkLayout.xaxis,
      title: { text: 'Model Version', font: { color: '#94a3b8', size: 11 } },
    },
    margin: { t: 20, b: 50, l: 70, r: 20 },
    shapes: [
      // Highlight v8 breakthrough
      {
        type: 'line' as const,
        x0: 'v8',
        x1: 'v8',
        y0: 0,
        y1: 350,
        line: { color: '#10b98155', width: 1.5, dash: 'dot' as const },
      },
    ],
    annotations: [
      {
        x: 'v7b',
        y: 320,
        xanchor: 'left' as const,
        yanchor: 'bottom' as const,
        text: 'Failure spike',
        font: { color: '#ef4444', size: 10 },
        showarrow: false,
      },
      {
        x: 'v8',
        y: 23.95,
        xanchor: 'left' as const,
        yanchor: 'top' as const,
        text: 'BREAKTHROUGH ⚡',
        font: { color: '#10b981', size: 10 },
        showarrow: false,
        xshift: 6,
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
          <TrendingDown className="text-emerald-400" size={22} />
          <h1 className="text-2xl font-bold text-slate-100">
            Version Ladder — Interactive Timeline
          </h1>
        </div>
        <p className="text-sm text-slate-400 ml-9">
          Click any version node to see details. Tracks every model iteration from v1 to v10-final.
        </p>
      </motion.div>

      {/* Main layout: timeline + detail card */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.08 }}
        className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6"
      >
        {/* Left: vertical timeline */}
        <div
          className="rounded-xl border p-5 lg:col-span-1 overflow-y-auto"
          style={{ background: '#1a2233', borderColor: '#1e3a5f', maxHeight: 520 }}
        >
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">
            Model Versions
          </h2>
          <div className="relative">
            {/* Vertical line */}
            <div
              className="absolute left-3 top-0 bottom-0 w-px"
              style={{ background: '#1e3a5f' }}
            />
            <div className="space-y-1">
              {VERSIONS.map((v) => {
                const color = ERA_COLORS[v.era]
                const isSelected = v.id === selected
                return (
                  <button
                    key={v.id}
                    onClick={() => setSelected(v.id)}
                    className="relative w-full text-left pl-9 pr-3 py-2.5 rounded-lg transition-all hover:bg-white/5 group"
                    style={{
                      background: isSelected ? color + '18' : undefined,
                      border: isSelected ? `1px solid ${color}44` : '1px solid transparent',
                    }}
                  >
                    {/* Node dot */}
                    <div
                      className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 rounded-full border-2 transition-all"
                      style={{
                        borderColor: color,
                        background: isSelected ? color : '#0a0e1a',
                        boxShadow: isSelected ? `0 0 8px ${color}88` : undefined,
                        zIndex: 2,
                      }}
                    />
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span
                          className="text-xs font-bold font-mono"
                          style={{ color: isSelected ? color : '#94a3b8' }}
                        >
                          {v.id}
                        </span>
                        {v.era === 'breakthrough' && (
                          <Zap size={11} className="text-emerald-400" />
                        )}
                        {v.era === 'best' && (
                          <Award size={11} className="text-amber-400" />
                        )}
                        {v.id === 'v7b' && (
                          <AlertTriangle size={11} className="text-red-400" />
                        )}
                      </div>
                      <span
                        className="text-xs font-mono"
                        style={{ color: isSelected ? color : '#64748b' }}
                      >
                        {v.rmse !== null ? v.rmse.toFixed(1) : '—'}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        {/* Right: detail card */}
        <div className="lg:col-span-2">
          <AnimatePresence mode="wait">
            <motion.div
              key={selectedVersion.id}
              initial={{ opacity: 0, x: 16 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -16 }}
              transition={{ duration: 0.2 }}
              className="rounded-xl border p-6 h-full flex flex-col gap-5"
              style={{
                background: '#1a2233',
                borderColor: ERA_COLORS[selectedVersion.era] + '55',
                minHeight: 260,
              }}
            >
              {/* Version badge + name */}
              <div className="flex items-center gap-3 flex-wrap">
                <span
                  className="text-3xl font-bold font-mono"
                  style={{ color: ERA_COLORS[selectedVersion.era] }}
                >
                  {selectedVersion.id}
                </span>
                {selectedVersion.era === 'breakthrough' && (
                  <span
                    className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold"
                    style={{ background: '#10b98122', color: '#10b981', border: '1px solid #10b98144' }}
                  >
                    <Zap size={12} />
                    BREAKTHROUGH
                  </span>
                )}
                {selectedVersion.era === 'best' && (
                  <span
                    className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold"
                    style={{ background: '#f59e0b22', color: '#f59e0b', border: '1px solid #f59e0b44' }}
                  >
                    <Award size={12} />
                    BEST OVERALL
                  </span>
                )}
                {selectedVersion.id === 'v7b' && (
                  <span
                    className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold"
                    style={{ background: '#ef444422', color: '#ef4444', border: '1px solid #ef444444' }}
                  >
                    <AlertTriangle size={12} />
                    FAILURE SPIKE
                  </span>
                )}
                <span
                  className="text-xs px-2 py-0.5 rounded"
                  style={{
                    background: ERA_COLORS[selectedVersion.era] + '22',
                    color: ERA_COLORS[selectedVersion.era],
                  }}
                >
                  {ERA_LABELS[selectedVersion.era]}
                </span>
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-2 gap-4">
                <div
                  className="rounded-lg p-4 border"
                  style={{ background: '#0a0e1a', borderColor: '#1e3a5f' }}
                >
                  <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">RMSE</div>
                  <div
                    className="text-3xl font-bold font-mono"
                    style={{ color: ERA_COLORS[selectedVersion.era] }}
                  >
                    {selectedVersion.rmse !== null ? selectedVersion.rmse.toFixed(1) : '—'}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">cycles</div>
                </div>
                <div
                  className="rounded-lg p-4 border"
                  style={{ background: '#0a0e1a', borderColor: '#1e3a5f' }}
                >
                  <div className="text-xs text-slate-500 uppercase tracking-wide mb-1">R²</div>
                  <div
                    className="text-3xl font-bold font-mono"
                    style={{ color: ERA_COLORS[selectedVersion.era] }}
                  >
                    {selectedVersion.r2 !== null ? selectedVersion.r2.toFixed(3) : '—'}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">
                    {selectedVersion.r2 === null ? 'not tracked yet' : ''}
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div
                className="rounded-lg p-4 border flex-1"
                style={{ background: '#0a0e1a', borderColor: '#1e3a5f' }}
              >
                <div className="text-xs text-slate-500 uppercase tracking-wide mb-2">
                  What Changed
                </div>
                <p className="text-sm text-slate-300 leading-relaxed">
                  {selectedVersion.notes}
                </p>
              </div>

              {/* Navigation arrows */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => {
                    const idx = VERSIONS.findIndex(v => v.id === selected)
                    if (idx > 0) setSelected(VERSIONS[idx - 1].id)
                  }}
                  disabled={selected === VERSIONS[0].id}
                  className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors px-3 py-1.5 rounded border border-transparent hover:border-slate-700"
                >
                  ← Previous
                </button>
                <span className="text-xs text-slate-600">
                  {VERSIONS.findIndex(v => v.id === selected) + 1} / {VERSIONS.length}
                </span>
                <button
                  onClick={() => {
                    const idx = VERSIONS.findIndex(v => v.id === selected)
                    if (idx < VERSIONS.length - 1) setSelected(VERSIONS[idx + 1].id)
                  }}
                  disabled={selected === VERSIONS[VERSIONS.length - 1].id}
                  className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-30 transition-colors px-3 py-1.5 rounded border border-transparent hover:border-slate-700"
                >
                  Next →
                </button>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>

      {/* RMSE trend line chart */}
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.18 }}
        className="rounded-xl border p-5"
        style={{ background: '#1a2233', borderColor: '#1e3a5f' }}
      >
        <h2 className="text-sm font-semibold text-slate-300 uppercase tracking-wide mb-4">
          RMSE Progression — Full Ladder
        </h2>
        <Plot
          data={[trendTrace]}
          layout={trendLayout}
          config={plotConfig}
          style={{ width: '100%', height: 280 }}
          onClick={(e: Plotly.PlotMouseEvent) => {
            const pt = e.points[0]
            if (pt && typeof pt.x === 'string') setSelected(pt.x)
          }}
        />
        <p className="text-xs text-slate-600 mt-2 text-center">
          Click any point to select that version
        </p>
      </motion.div>
    </div>
  )
}

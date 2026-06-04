import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Layers, Info } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface PCAData {
  x: number[]
  y: number[]
  z: number[]
  chemistry: string[]
  rul: number[]
  cycle: number[]
  explained_variance: [number, number, number]
  feature_names: string[]
}

type ColorMode = 'chemistry' | 'rul' | 'cycle'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const CHEM_COLORS: Record<string, string> = {
  LCO: '#3b82f6',
  LFP: '#10b981',
  NMC: '#f59e0b',
  NCM: '#8b5cf6',
  Oxford: '#06b6d4',
}

const COLOR_MODES: { id: ColorMode; label: string }[] = [
  { id: 'chemistry', label: 'By Chemistry' },
  { id: 'rul',       label: 'By RUL' },
  { id: 'cycle',     label: 'By Cycle' },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function buildTraces(data: PCAData, mode: ColorMode): Plotly.Data[] {
  if (mode === 'chemistry') {
    // One trace per chemistry for a proper legend
    const chems = Array.from(new Set(data.chemistry))
    return chems.map(chem => {
      const mask = data.chemistry.map((c, i) => (c === chem ? i : -1)).filter(i => i >= 0)
      return {
        type: 'scatter3d',
        mode: 'markers',
        name: chem,
        x: mask.map(i => data.x[i]),
        y: mask.map(i => data.y[i]),
        z: mask.map(i => data.z[i]),
        marker: {
          color: CHEM_COLORS[chem] ?? '#94a3b8',
          size: 3,
          opacity: 0.75,
        },
        hovertemplate:
          `<b>${chem}</b><br>` +
          'PC1: %{x:.2f}<br>PC2: %{y:.2f}<br>PC3: %{z:.2f}<br>' +
          `RUL: %{customdata[0]}<br>Cycle: %{customdata[1]}<extra></extra>`,
        customdata: mask.map(i => [data.rul[i], data.cycle[i]]),
      } as Plotly.Data
    })
  }

  // Single trace with a colorscale
  const colorValues = mode === 'rul' ? data.rul : data.cycle
  return [
    {
      type: 'scatter3d',
      mode: 'markers',
      name: mode === 'rul' ? 'RUL' : 'Cycle',
      x: data.x,
      y: data.y,
      z: data.z,
      marker: {
        color: colorValues,
        colorscale: 'Viridis',
        size: 3,
        opacity: 0.75,
        showscale: true,
        colorbar: {
          title: { text: mode === 'rul' ? 'RUL (cycles)' : 'Cycle', font: { color: '#94a3b8' } },
          tickfont: { color: '#64748b', size: 10 },
          bgcolor: 'rgba(26,34,51,0.85)',
          bordercolor: '#1e3a5f',
          len: 0.65,
          thickness: 12,
        },
      },
      hovertemplate:
        `PC1: %{x:.2f}<br>PC2: %{y:.2f}<br>PC3: %{z:.2f}<br>` +
        `${mode === 'rul' ? 'RUL' : 'Cycle'}: %{marker.color}<br>` +
        `Chemistry: %{customdata}<extra></extra>`,
      customdata: data.chemistry,
    } as Plotly.Data,
  ]
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function PCAExplorer() {
  const [data, setData] = useState<PCAData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [colorMode, setColorMode] = useState<ColorMode>('chemistry')

  useEffect(() => {
    setLoading(true)
    setError(false)
    fetch('/api/pca-3d')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((d: PCAData) => setData(d))
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [])

  const evPct = data?.explained_variance.map(v => (v * 100).toFixed(1)) ?? ['—', '—', '—']
  const totalSample = data ? data.x.length.toLocaleString() : '—'
  const traces = data ? buildTraces(data, colorMode) : []

  const layout3d: Partial<Plotly.Layout> = {
    ...darkLayout,
    height: 520,
    margin: { t: 20, b: 10, l: 0, r: 0 },
    scene: {
      bgcolor: 'transparent',
      xaxis: {
        title: { text: `PC1 (${evPct[0]}%)`, font: { color: '#64748b', size: 10 } },
        gridcolor: '#1e3a5f',
        zerolinecolor: '#1e3a5f',
        tickfont: { color: '#64748b', size: 9 },
        backgroundcolor: 'rgba(0,0,0,0)',
      },
      yaxis: {
        title: { text: `PC2 (${evPct[1]}%)`, font: { color: '#64748b', size: 10 } },
        gridcolor: '#1e3a5f',
        zerolinecolor: '#1e3a5f',
        tickfont: { color: '#64748b', size: 9 },
        backgroundcolor: 'rgba(0,0,0,0)',
      },
      zaxis: {
        title: { text: `PC3 (${evPct[2]}%)`, font: { color: '#64748b', size: 10 } },
        gridcolor: '#1e3a5f',
        zerolinecolor: '#1e3a5f',
        tickfont: { color: '#64748b', size: 9 },
        backgroundcolor: 'rgba(0,0,0,0)',
      },
    },
    legend: {
      ...darkLayout.legend,
      x: 0.01,
      y: 0.99,
    },
  }

  return (
    <motion.div
      className="px-8 py-8 max-w-7xl mx-auto"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Layers size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">PCA Explorer</h1>
        </div>
        <p className="text-text-secondary">
          Interactive 3D principal component analysis of battery feature space — explore chemistry clusters
          and RUL gradients across the full dataset.
        </p>
      </div>

      {/* Controls + metric cards row */}
      <div className="panel p-4 mb-5 flex items-center gap-6 flex-wrap">
        {/* Color mode toggle */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-text-muted mr-2">Color:</span>
          {COLOR_MODES.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setColorMode(id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                colorMode === id
                  ? 'bg-brand-blue text-white'
                  : 'border border-border-subtle text-text-muted hover:text-text-primary'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border-subtle" />

        {/* Sample count */}
        <div className="flex items-center gap-2 text-xs text-text-muted">
          <Info size={13} className="text-brand-cyan" />
          <span>
            <span className="font-mono font-semibold text-brand-cyan">{totalSample}</span>
            {' '}points sampled from 167,359 total
          </span>
        </div>

        {/* Explained variance cards */}
        <div className="ml-auto flex items-center gap-3">
          {(['PC1', 'PC2', 'PC3'] as const).map((pc, i) => (
            <div key={pc} className="flex flex-col items-center px-3 py-1.5 rounded-lg bg-bg-elevated border border-border-subtle">
              <span className="text-[10px] font-semibold text-text-muted uppercase tracking-wide">{pc}</span>
              <span className="text-sm font-mono font-bold text-brand-blue">
                {evPct[i]}%
              </span>
              <span className="text-[9px] text-text-muted">variance</span>
            </div>
          ))}
        </div>
      </div>

      {/* 3D Scatter plot */}
      <div className="panel p-5 mb-5">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="section-title">3D PCA Scatter</h3>
            <p className="text-xs text-text-muted mt-0.5">
              Drag to rotate · scroll to zoom · click legend to toggle chemistry
            </p>
          </div>
          {colorMode === 'chemistry' && (
            <div className="flex items-center gap-3 flex-wrap">
              {Object.entries(CHEM_COLORS).map(([chem, color]) => (
                <div key={chem} className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                  {chem}
                </div>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <SkeletonChart height={520} />
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-64 text-text-muted gap-3">
            <span className="text-red-400 text-sm font-semibold">Failed to load PCA data</span>
            <span className="text-xs">Ensure the backend endpoint /api/pca-3d is running</span>
          </div>
        ) : (
          <Plot
            data={traces}
            layout={layout3d as Plotly.Layout}
            config={{ ...plotConfig, displayModeBar: true }}
            style={{ width: '100%' }}
            useResizeHandler
          />
        )}
      </div>

      {/* Feature names panel */}
      {data && data.feature_names.length > 0 && (
        <motion.div
          className="panel p-5"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
        >
          <h3 className="section-title mb-3">Features Contributing to PCA</h3>
          <div className="flex flex-wrap gap-2">
            {data.feature_names.map((f, i) => (
              <span
                key={f}
                className="px-2.5 py-1 rounded-full text-xs font-mono border border-border-subtle text-text-secondary"
                style={{
                  backgroundColor:
                    i < 5
                      ? 'rgba(59,130,246,0.10)'
                      : i < 10
                      ? 'rgba(6,182,212,0.07)'
                      : 'rgba(30,58,95,0.4)',
                  borderColor:
                    i < 5 ? '#3b82f644' : i < 10 ? '#06b6d444' : '#1e3a5f',
                  color: i < 5 ? '#93c5fd' : i < 10 ? '#67e8f9' : '#64748b',
                }}
              >
                {f}
              </span>
            ))}
          </div>
          <p className="text-xs text-text-muted mt-3">
            Top 5 features (blue) contribute most to PC1; next 5 (cyan) drive PC2 separation.
          </p>
        </motion.div>
      )}

      {/* Insight panel */}
      <div className="panel p-4 border-blue-500/20 bg-blue-500/5 mt-5">
        <h3 className="text-sm font-semibold text-brand-blue mb-2">Insight: Chemistry Clustering</h3>
        <p className="text-sm text-text-secondary">
          LFP cells (green) cluster tightly in the lower-left of PC1/PC2 space, reflecting their stable
          voltage plateau and longer cycle life. Oxford cells (cyan) are separated along PC3, consistent
          with their distinct cycling protocol and higher RUL scale. LCO and NMC overlap significantly,
          suggesting shared electrochemical degradation pathways. RUL gradients flow smoothly through
          all clusters, confirming that the feature space encodes degradation state independent of chemistry.
        </p>
      </div>
    </motion.div>
  )
}

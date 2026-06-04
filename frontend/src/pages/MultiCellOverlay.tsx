import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Layers, RefreshCw, Plus, X } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart, Skeleton } from '../components/ui/Skeleton'
import { ExportCSV } from '../components/ui/ExportButton'

// ─── Types ───────────────────────────────────────────────────────────────────

interface CellPayload {
  cycles: number[]
  rul: number[]
  capacity: number[]
  soh_pct: number[]
  chemistry: string
  n_cycles: number
}

interface ApiResponse {
  cells: Record<string, CellPayload>
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PRESET_CELLS = [
  { id: 'CS2_33', chem: 'LCO' },
  { id: 'CS2_34', chem: 'LCO' },
  { id: 'CS2_35', chem: 'LCO' },
  { id: 'CS2_36', chem: 'LCO' },
  { id: 'CS2_37', chem: 'LCO' },
  { id: 'CS2_38', chem: 'LCO' },
]

const CHEM_COLORS: Record<string, string> = {
  LCO: '#3b82f6',
  LFP: '#10b981',
  NMC: '#f59e0b',
  NCM: '#8b5cf6',
  NCA: '#ef4444',
  Oxford: '#06b6d4',
  MIT: '#f59e0b',
  unknown: '#94a3b8',
}

// Generate distinguishable colors for many cells within the same chemistry
const CELL_PALETTE = [
  '#3b82f6', '#06b6d4', '#10b981', '#f59e0b',
  '#8b5cf6', '#ef4444', '#ec4899', '#14b8a6',
]

type TabKey = 'rul' | 'capacity' | 'soh'

// ─── Component ────────────────────────────────────────────────────────────────

export default function MultiCellOverlay() {
  const [checkedCells, setCheckedCells] = useState<string[]>(['CS2_37', 'CS2_38'])
  const [customInput, setCustomInput] = useState('')
  const [customCells, setCustomCells] = useState<string[]>([])
  const [data, setData] = useState<Record<string, CellPayload>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('rul')

  // All selected cell IDs (preset checkboxes + custom)
  const allSelected = [...new Set([...checkedCells, ...customCells])]

  // Fetch data whenever selected cells change
  const fetchData = useCallback(async () => {
    if (allSelected.length === 0) {
      setData({})
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = allSelected.join(',')
      const res = await fetch(`/api/multi-cell-rul?cells=${encodeURIComponent(params)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: ApiResponse = await res.json()
      setData(json.cells ?? {})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Fetch failed')
    } finally {
      setLoading(false)
    }
  }, [allSelected.join(',')])  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchData() }, [fetchData])

  // ── handlers ──────────────────────────────────────────────────────────────

  const togglePreset = (id: string) => {
    setCheckedCells(prev =>
      prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]
    )
  }

  const addCustomCell = () => {
    const trimmed = customInput.trim()
    if (!trimmed || customCells.includes(trimmed) || checkedCells.includes(trimmed)) return
    setCustomCells(prev => [...prev, trimmed])
    setCustomInput('')
  }

  const removeCustomCell = (id: string) => {
    setCustomCells(prev => prev.filter(c => c !== id))
  }

  // ── build chart traces ─────────────────────────────────────────────────────

  const cellEntries = Object.entries(data)

  const colorFor = (cellId: string, idx: number) => {
    const chem = data[cellId]?.chemistry
    if (cellEntries.length <= 1 && chem && CHEM_COLORS[chem]) return CHEM_COLORS[chem]
    return CELL_PALETTE[idx % CELL_PALETTE.length]
  }

  const rulTraces: Plotly.Data[] = cellEntries.map(([id, cell], i) => ({
    type: 'scatter',
    mode: 'lines',
    name: `${id} (${cell.n_cycles}cy)`,
    x: cell.cycles,
    y: cell.rul,
    line: { color: colorFor(id, i), width: 2 },
  } as Plotly.Data))

  const capacityTraces: Plotly.Data[] = cellEntries.map(([id, cell], i) => ({
    type: 'scatter',
    mode: 'lines',
    name: `${id} (${cell.n_cycles}cy)`,
    x: cell.cycles,
    y: cell.capacity,
    line: { color: colorFor(id, i), width: 2 },
  } as Plotly.Data))

  const sohTraces: Plotly.Data[] = cellEntries.map(([id, cell], i) => ({
    type: 'scatter',
    mode: 'lines',
    name: `${id} (${cell.n_cycles}cy)`,
    x: cell.cycles,
    y: cell.soh_pct,
    line: { color: colorFor(id, i), width: 2 },
  } as Plotly.Data))

  // EOL reference line at 80% for SoH tab
  const eolShape: Partial<Plotly.Shape> = {
    type: 'line',
    x0: 0, x1: 1, xref: 'paper' as const,
    y0: 80, y1: 80,
    line: { color: '#ef4444', dash: 'dot', width: 1.5 },
  }

  // ── CSV export ──────────────────────────────────────────────────────────────

  const exportRows = cellEntries.flatMap(([id, cell]) =>
    cell.cycles.map((cy, i) => ({
      cell_id: id,
      chemistry: cell.chemistry,
      cycle: cy,
      rul: cell.rul[i],
      capacity: cell.capacity[i],
      soh_pct: cell.soh_pct[i],
    }))
  )

  // ── tabs config ─────────────────────────────────────────────────────────────

  const TABS: { key: TabKey; label: string }[] = [
    { key: 'rul', label: 'RUL Trajectories' },
    { key: 'capacity', label: 'Capacity Fade' },
    { key: 'soh', label: 'SoH %' },
  ]

  // ── render ──────────────────────────────────────────────────────────────────

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="px-8 py-8 max-w-7xl mx-auto"
    >
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Layers size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Multi-Cell Overlay</h1>
        </div>
        <p className="text-text-secondary">
          Overlay RUL trajectories, capacity fade, and state-of-health across multiple battery cells simultaneously
        </p>
      </div>

      <div className="flex gap-5">
        {/* ── Left panel: cell selector ─────────────────────────────────── */}
        <div className="w-56 flex-shrink-0 space-y-4">
          {/* Preset cells */}
          <div className="panel p-4">
            <div className="metric-label mb-3">CALCE LCO Cells</div>
            <div className="space-y-2">
              {PRESET_CELLS.map(({ id }) => {
                const isChecked = checkedCells.includes(id)
                const cellColor = CELL_PALETTE[allSelected.indexOf(id) % CELL_PALETTE.length]
                return (
                  <label
                    key={id}
                    className="flex items-center gap-2.5 cursor-pointer group"
                  >
                    <div
                      className="relative w-4 h-4 rounded border-2 flex-shrink-0 transition-all"
                      style={{
                        borderColor: isChecked ? cellColor : '#1e3a5f',
                        backgroundColor: isChecked ? cellColor + '33' : 'transparent',
                      }}
                      onClick={() => togglePreset(id)}
                    >
                      {isChecked && (
                        <div
                          className="absolute inset-0.5 rounded-sm"
                          style={{ backgroundColor: cellColor }}
                        />
                      )}
                    </div>
                    <span
                      className="font-mono text-xs transition-colors"
                      style={{ color: isChecked ? '#f1f5f9' : '#64748b' }}
                      onClick={() => togglePreset(id)}
                    >
                      {id}
                    </span>
                    {data[id] && (
                      <span className="text-xs text-text-muted ml-auto">
                        {data[id].n_cycles}cy
                      </span>
                    )}
                  </label>
                )
              })}
            </div>
          </div>

          {/* Custom cell input */}
          <div className="panel p-4">
            <div className="metric-label mb-3">Custom Cell ID</div>
            <div className="flex gap-1">
              <input
                type="text"
                value={customInput}
                onChange={e => setCustomInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addCustomCell()}
                placeholder="e.g. MIT_cell1"
                className="flex-1 min-w-0 bg-bg-elevated border border-border-subtle rounded-lg px-2 py-1.5
                           text-xs text-text-primary placeholder:text-text-muted
                           focus:outline-none focus:border-brand-blue transition-colors"
              />
              <button
                onClick={addCustomCell}
                className="p-1.5 rounded-lg bg-brand-blue/10 border border-brand-blue/30 text-brand-blue
                           hover:bg-brand-blue/20 transition-colors flex-shrink-0"
              >
                <Plus size={13} />
              </button>
            </div>

            {customCells.length > 0 && (
              <div className="mt-2 space-y-1">
                {customCells.map(id => (
                  <div key={id} className="flex items-center justify-between">
                    <span className="font-mono text-xs text-text-secondary">{id}</span>
                    <button
                      onClick={() => removeCustomCell(id)}
                      className="text-text-muted hover:text-red-400 transition-colors"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Summary stats */}
          {!loading && cellEntries.length > 0 && (
            <div className="panel p-4 space-y-3">
              <div className="metric-label">Summary</div>
              {cellEntries.map(([id, cell], i) => (
                <div key={id} className="space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: colorFor(id, i) }}
                    />
                    <span className="font-mono text-xs text-text-accent truncate">{id}</span>
                  </div>
                  <div className="text-xs text-text-muted pl-3.5">
                    {cell.chemistry} · {cell.n_cycles} cycles
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Refresh */}
          <button
            onClick={fetchData}
            disabled={loading || allSelected.length === 0}
            className="btn-ghost w-full flex items-center justify-center gap-2 text-xs py-2"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>

          {/* Export */}
          {exportRows.length > 0 && (
            <ExportCSV
              data={exportRows}
              filename="multi_cell_overlay.csv"
              label="Export CSV"
            />
          )}
        </div>

        {/* ── Right panel: charts ────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Tabs */}
          <div className="flex gap-1">
            {TABS.map(tab => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                  activeTab === tab.key
                    ? 'border-brand-blue text-brand-blue bg-brand-blue/10'
                    : 'border-border-subtle text-text-muted hover:text-text-primary'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Error banner */}
          {error && (
            <div className="panel p-4 border-red-500/20 bg-red-500/5">
              <p className="text-sm text-red-400">
                Failed to fetch data: {error}. Check the backend or cell IDs.
              </p>
            </div>
          )}

          {/* Empty state */}
          {!loading && allSelected.length === 0 && (
            <div className="panel p-12 text-center">
              <Layers size={32} className="mx-auto mb-3 text-text-muted opacity-40" />
              <p className="text-text-secondary text-sm">
                Select at least one cell to display overlay charts.
              </p>
            </div>
          )}

          {/* Loading skeleton */}
          {loading && (
            <div className="space-y-4">
              <SkeletonChart height={300} />
              <div className="grid grid-cols-3 gap-3">
                {[1, 2, 3].map(i => (
                  <Skeleton key={i} className="h-20 w-full" />
                ))}
              </div>
            </div>
          )}

          {/* RUL Trajectories */}
          {!loading && activeTab === 'rul' && cellEntries.length > 0 && (
            <motion.div
              key="rul-chart"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="panel p-5"
            >
              <h3 className="section-title mb-1">RUL Trajectories</h3>
              <p className="text-xs text-text-muted mb-4">
                Remaining useful life (cycles) as a function of cycle number for each selected cell
              </p>
              <Plot
                data={rulTraces}
                layout={{
                  ...darkLayout,
                  height: 340,
                  margin: { t: 10, b: 55, l: 65, r: 20 },
                  xaxis: {
                    ...(darkLayout.xaxis as object),
                    title: { text: 'Cycle', font: { color: '#64748b' } },
                  },
                  yaxis: {
                    ...(darkLayout.yaxis as object),
                    title: { text: 'RUL (cycles)', font: { color: '#64748b' } },
                  },
                } as Plotly.Layout}
                config={plotConfig}
                style={{ width: '100%' }}
              />
            </motion.div>
          )}

          {/* Capacity Fade */}
          {!loading && activeTab === 'capacity' && cellEntries.length > 0 && (
            <motion.div
              key="capacity-chart"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="panel p-5"
            >
              <h3 className="section-title mb-1">Capacity Fade</h3>
              <p className="text-xs text-text-muted mb-4">
                Discharge capacity (Ah) over cycling — shows degradation rate across chemistries
              </p>
              <Plot
                data={capacityTraces}
                layout={{
                  ...darkLayout,
                  height: 340,
                  margin: { t: 10, b: 55, l: 65, r: 20 },
                  xaxis: {
                    ...(darkLayout.xaxis as object),
                    title: { text: 'Cycle', font: { color: '#64748b' } },
                  },
                  yaxis: {
                    ...(darkLayout.yaxis as object),
                    title: { text: 'Capacity (Ah)', font: { color: '#64748b' } },
                  },
                } as Plotly.Layout}
                config={plotConfig}
                style={{ width: '100%' }}
              />
            </motion.div>
          )}

          {/* SoH % */}
          {!loading && activeTab === 'soh' && cellEntries.length > 0 && (
            <motion.div
              key="soh-chart"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="panel p-5"
            >
              <h3 className="section-title mb-1">State of Health (%)</h3>
              <p className="text-xs text-text-muted mb-4">
                SoH normalized to initial capacity — red dashed line marks the 80% end-of-life threshold
              </p>
              <Plot
                data={sohTraces}
                layout={{
                  ...darkLayout,
                  height: 340,
                  margin: { t: 10, b: 55, l: 65, r: 20 },
                  shapes: [eolShape as Plotly.Shape],
                  annotations: [
                    {
                      x: 1, xref: 'paper' as const,
                      y: 80, yref: 'y' as const,
                      text: 'EOL 80%',
                      showarrow: false,
                      font: { color: '#ef4444', size: 10 },
                      xanchor: 'right' as const,
                      yanchor: 'bottom' as const,
                    },
                  ],
                  xaxis: {
                    ...(darkLayout.xaxis as object),
                    title: { text: 'Cycle', font: { color: '#64748b' } },
                  },
                  yaxis: {
                    ...(darkLayout.yaxis as object),
                    title: { text: 'SoH (%)', font: { color: '#64748b' } },
                    range: [60, 105],
                  },
                } as Plotly.Layout}
                config={plotConfig}
                style={{ width: '100%' }}
              />
            </motion.div>
          )}

          {/* Per-cell metric cards */}
          {!loading && cellEntries.length > 0 && (
            <div className="grid grid-cols-3 gap-3">
              {cellEntries.map(([id, cell], i) => {
                const color = colorFor(id, i)
                const minSoH = cell.soh_pct.length
                  ? Math.min(...cell.soh_pct).toFixed(1)
                  : '—'
                const minCap = cell.capacity.length
                  ? Math.min(...cell.capacity).toFixed(3)
                  : '—'
                return (
                  <motion.div
                    key={id}
                    initial={{ opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: i * 0.05 }}
                    className="panel p-4"
                    style={{ borderColor: color + '44', backgroundColor: color + '08' }}
                  >
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
                      <span className="font-mono text-xs font-semibold" style={{ color }}>
                        {id}
                      </span>
                    </div>
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">Chemistry</span>
                        <span className="font-medium text-text-secondary">{cell.chemistry}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">Cycles</span>
                        <span className="font-mono text-text-accent">{cell.n_cycles}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">Min SoH</span>
                        <span className="font-mono" style={{ color: '#f59e0b' }}>{minSoH}%</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">Min Cap</span>
                        <span className="font-mono" style={{ color: '#ef4444' }}>{minCap} Ah</span>
                      </div>
                    </div>
                  </motion.div>
                )
              })}
            </div>
          )}

          {/* Info banner */}
          <div className="panel p-4 border-blue-500/20 bg-blue-500/5">
            <h3 className="text-sm font-semibold text-blue-400 mb-1">How to use</h3>
            <p className="text-xs text-text-secondary">
              Check cells in the left panel to overlay them. Add custom cell IDs (e.g. MIT_cell1, Oxford_Cell7)
              for cross-dataset comparison. Switch tabs to explore RUL, capacity, or SoH. Export the combined
              dataset as CSV for offline analysis.
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

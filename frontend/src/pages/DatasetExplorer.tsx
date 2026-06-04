import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Database, ChevronDown, ChevronUp, Zap, Activity, Wifi } from 'lucide-react'
import Plot from 'react-plotly.js'

const DATASETS = [
  {
    name: 'CALCE',
    chemistry: 'LCO',
    chemCode: 0,
    formFactor: 'Prismatic',
    temperature: '25°C',
    protocol: 'CC-CV 1C charge / 1C discharge',
    cellCount: 11,
    avgCycles: 250,
    description: 'CALCE CS2 and CX2 series LCO prismatic cells. Primary training dataset. Clean CC-CV cycling at constant temperature. Includes both train/val/test cells.',
    color: '#3b82f6',
    badge: 'badge-blue',
    cells: [
      { id: 'CS2_33', split: 'train', cycles: 500, rul_range: '0–500' },
      { id: 'CS2_34', split: 'val', cycles: 131, rul_range: '0–131' },
      { id: 'CS2_35', split: 'train', cycles: 309, rul_range: '0–309' },
      { id: 'CS2_36', split: 'train', cycles: 360, rul_range: '0–360' },
      { id: 'CS2_37', split: 'test', cycles: 337, rul_range: '0–337' },
      { id: 'CS2_38', split: 'test', cycles: 313, rul_range: '0–313' },
      { id: 'CX2_16', split: 'train', cycles: 580, rul_range: '0–580' },
      { id: 'CX2_33', split: 'train', cycles: 490, rul_range: '0–490' },
      { id: 'CX2_36', split: 'train', cycles: 610, rul_range: '0–610' },
      { id: 'CX2_37', split: 'val', cycles: 520, rul_range: '0–520' },
      { id: 'CX2_38', split: 'train', cycles: 560, rul_range: '0–560' },
    ],
  },
  {
    name: 'MIT',
    chemistry: 'LFP',
    chemCode: 1,
    formFactor: 'Cylindrical 18650',
    temperature: '30°C',
    protocol: 'Fast charge at variable C-rates (C/10 to 6C)',
    cellCount: 5,
    avgCycles: 852,
    description: 'MIT 2017–2018 LFP cylindrical cells from fast-charge study. Multiple batches with different charge protocols. Challenging due to flat voltage plateau.',
    color: '#10b981',
    badge: 'badge-green',
    cells: [
      { id: 'MIT_2018-02-20_019', split: 'test', cycles: 395, rul_range: '0–395' },
      { id: 'MIT_2018-02-20_016', split: 'test', cycles: 474, rul_range: '0–474' },
      { id: 'MIT_2017-05-12_043', split: 'test', cycles: 649, rul_range: '0–649' },
      { id: 'MIT_2018-02-20_032', split: 'test', cycles: 810, rul_range: '0–810' },
      { id: 'MIT_2018-04-12_038', split: 'test', cycles: 1934, rul_range: '0–1934' },
    ],
  },
  {
    name: 'KJTU',
    chemistry: 'NMC',
    chemCode: 2,
    formFactor: 'Cylindrical 18650',
    temperature: '25°C',
    protocol: 'CC-CV 0.5C charge / 0.5C discharge',
    cellCount: 5,
    avgCycles: 480,
    description: 'KJTU NMC cylindrical cells at standard conditions. Good cross-chemistry transfer results with MambaRUL (R²=0.854).',
    color: '#f59e0b',
    badge: 'badge-amber',
    cells: [
      { id: 'KJTU_Cell_1', split: 'test', cycles: 452, rul_range: '0–452' },
      { id: 'KJTU_Cell_2', split: 'test', cycles: 489, rul_range: '0–489' },
      { id: 'KJTU_Cell_3', split: 'test', cycles: 501, rul_range: '0–501' },
      { id: 'KJTU_Cell_4', split: 'test', cycles: 465, rul_range: '0–465' },
      { id: 'KJTU_Cell_5', split: 'test', cycles: 493, rul_range: '0–493' },
    ],
  },
  {
    name: 'TJU',
    chemistry: 'NCM',
    chemCode: 3,
    formFactor: 'Cylindrical 18650',
    temperature: '25–45°C',
    protocol: 'CC-CV 0.5C charge / 1C discharge',
    cellCount: 3,
    avgCycles: 538,
    description: 'TJU NCM cells at variable temperatures (25°C and 45°C). Temperature variation adds challenge for cross-condition generalization.',
    color: '#8b5cf6',
    badge: 'badge-purple',
    cells: [
      { id: 'Dataset_2__CY25-05_1-#5', split: 'test', cycles: 445, rul_range: '0–445' },
      { id: 'Dataset_3__CY25-05_2-#3', split: 'test', cycles: 508, rul_range: '0–508' },
      { id: 'Dataset_2__CY45-05_1-#27', split: 'test', cycles: 662, rul_range: '0–662' },
    ],
  },
  {
    name: 'Oxford',
    chemistry: 'NMC',
    chemCode: 2,
    formFactor: 'Pouch',
    temperature: '40°C',
    protocol: 'EIS + discharge snapshots every ~100 cycles',
    cellCount: 8,
    avgCycles: 8000,
    description: 'Oxford NMC pouch cells with ~8000-cycle lifetime. Measured as snapshots every ~100 cycles. Cell1–6 in training, Cell7–8 for zero-shot evaluation. R²=+0.911 zero-shot.',
    color: '#06b6d4',
    badge: 'badge-blue',
    cells: [
      { id: 'Cell_1', split: 'train', cycles: 8000, rul_range: '0–8000' },
      { id: 'Cell_2', split: 'train', cycles: 7800, rul_range: '0–7800' },
      { id: 'Cell_3', split: 'train', cycles: 8100, rul_range: '0–8100' },
      { id: 'Cell_4', split: 'train', cycles: 7900, rul_range: '0–7900' },
      { id: 'Cell_5', split: 'train', cycles: 8200, rul_range: '0–8200' },
      { id: 'Cell_6', split: 'train', cycles: 8050, rul_range: '0–8050' },
      { id: 'Cell_7', split: 'test', cycles: 8000, rul_range: '0–8000' },
      { id: 'Cell_8', split: 'test', cycles: 8100, rul_range: '0–8100' },
    ],
  },
  {
    name: 'NASA',
    chemistry: 'LCO',
    chemCode: 0,
    formFactor: 'Cylindrical 18650',
    temperature: '24°C',
    protocol: 'CC-CV charge (1.5A to 4.2V), CC discharge (2A to 2.7V)',
    cellCount: 3,
    avgCycles: 167,
    description: 'NASA PCoE B0005/B0006/B0007 LCO cells. Classic benchmark dataset. Short cycle life. Used for zero-shot cross-dataset evaluation.',
    color: '#ef4444',
    badge: 'badge-red',
    cells: [
      { id: 'B0005', split: 'test', cycles: 168, rul_range: '0–168' },
      { id: 'B0006', split: 'test', cycles: 167, rul_range: '0–167' },
      { id: 'B0007', split: 'test', cycles: 168, rul_range: '0–168' },
    ],
  },
]

const CHEM_FILTERS = ['All', 'LCO', 'LFP', 'NMC', 'NCM']

const SPLIT_BADGE: Record<string, string> = {
  train: 'badge-green',
  val: 'badge-amber',
  test: 'badge-blue',
}

const RADAR_DATA = {
  type: 'scatterpolar' as const,
  mode: 'lines+markers' as const,
  fill: 'toself' as const,
}

const RADAR_CATEGORIES = ['Cycle Life', 'Transfer R²', 'Data Volume', 'Chemistry Difficulty⁻¹']

const radarTraces = [
  { name: 'LCO (CALCE)', r: [0.03, 0.91, 0.7, 0.9], color: '#3b82f6' },
  { name: 'LFP (MIT)', r: [0.1, 0.12, 0.6, 0.3], color: '#10b981' },
  { name: 'NMC (KJTU)', r: [0.06, 0.85, 0.55, 0.75], color: '#f59e0b' },
  { name: 'NCM (TJU)', r: [0.07, 0.66, 0.35, 0.65], color: '#8b5cf6' },
  { name: 'NMC (Oxford)', r: [1.0, 0.91, 0.55, 0.72], color: '#06b6d4' },
]

// Shape returned by GET /api/datasets
interface ApiDatasetEntry {
  name?: string
  dataset?: string
  chemistry?: string
  cell_count?: number
  avg_cycles?: number
  n_windows?: number
}

// Live stats shape derived from GET /api/health
interface LiveStats {
  rows: number
  status: string
}

export default function DatasetExplorer() {
  const [activeFilter, setActiveFilter] = useState('All')
  const [expandedDataset, setExpandedDataset] = useState<string | null>(null)

  // API-enriched stats keyed by dataset name (e.g. "CALCE")
  const [apiStats, setApiStats] = useState<Record<string, ApiDatasetEntry>>({})
  // Live rows badge from /api/health
  const [liveStats, setLiveStats] = useState<LiveStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [isMock, setIsMock] = useState(false)

  useEffect(() => {
    // Fetch real dataset metadata from the 167K-row CSV
    fetch('/api/datasets')
      .then(r => r.json())
      .then((data: ApiDatasetEntry[]) => {
        const map: Record<string, ApiDatasetEntry> = {}
        data.forEach(entry => {
          // API returns either `name` or `dataset` as the key field
          const key = (entry.dataset ?? entry.name ?? '').trim()
          if (key) map[key] = entry
        })
        setApiStats(map)
      })
      .catch(() => { setIsMock(true) /* live stats unavailable — published values remain */ })

    // Fetch total rows for the live badge
    fetch('/api/health')
      .then(r => r.json())
      .then((data: LiveStats) => setLiveStats(data))
      .catch(() => { /* silently ignore */ })
      .finally(() => setStatsLoading(false))
  }, [])

  // Merge API data into a dataset entry — API cell_count / avg_cycles override
  // hardcoded values when available; cell IDs and other metadata are always kept.
  function mergedStats(ds: typeof DATASETS[0]) {
    const api = apiStats[ds.name] ?? {}
    return {
      cellCount: api.cell_count ?? ds.cellCount,
      avgCycles: api.avg_cycles ?? ds.avgCycles,
      nWindows:  api.n_windows  ?? null,
    }
  }

  const filtered = activeFilter === 'All'
    ? DATASETS
    : DATASETS.filter(d => d.chemistry === activeFilter)

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      {isMock && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          ⚠ Live dataset stats unavailable — showing published reference values.
        </div>
      )}
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Database size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Dataset Collection</h1>
          {/* Live stats badge — populated from GET /api/health */}
          {!statsLoading && liveStats && (
            <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              <Wifi size={11} />
              {liveStats.rows.toLocaleString()} cycles loaded
            </span>
          )}
          {statsLoading && (
            <span className="flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-bg-panel border border-border-subtle text-text-muted">
              <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" />
              Loading live stats…
            </span>
          )}
        </div>
        <p className="text-text-secondary">
          6 benchmark datasets · 5 chemistries · 17 test cells · Cell-disjoint evaluation splits
        </p>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6">
        {CHEM_FILTERS.map(f => (
          <button
            key={f}
            onClick={() => setActiveFilter(f)}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-150 ${
              activeFilter === f
                ? 'bg-brand-blue text-white'
                : 'bg-bg-panel border border-border-subtle text-text-secondary hover:text-text-primary'
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {/* Dataset cards */}
      <motion.div className="grid grid-cols-2 gap-4 mb-8">
        {filtered.map((ds, i) => (
          <motion.div
            key={ds.name}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06 }}
          >
            <div
              className="panel p-5 cursor-pointer hover:border-border-active transition-all duration-200"
              onClick={() => setExpandedDataset(expandedDataset === ds.name ? null : ds.name)}
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base font-bold text-text-primary">{ds.name}</span>
                    <span
                      className="badge text-xs font-medium px-2 py-0.5 rounded-md border"
                      style={{ color: ds.color, borderColor: ds.color + '33', backgroundColor: ds.color + '11' }}
                    >
                      {ds.chemistry}
                    </span>
                  </div>
                  <p className="text-xs text-text-muted">{ds.formFactor}</p>
                </div>
                <div className="flex items-center gap-1 text-text-muted">
                  {expandedDataset === ds.name ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </div>
              </div>

              <p className="text-xs text-text-secondary leading-relaxed mb-4">{ds.description}</p>

              {(() => {
                const ms = mergedStats(ds)
                return (
                  <div className="grid grid-cols-3 gap-3 mb-4">
                    <div>
                      <div className="metric-label mb-0.5">Cells</div>
                      <div className="font-mono text-sm font-semibold text-text-accent">{ms.cellCount}</div>
                    </div>
                    <div>
                      <div className="metric-label mb-0.5">Avg Cycles</div>
                      <div className="font-mono text-sm font-semibold text-text-accent">{ms.avgCycles.toLocaleString()}</div>
                    </div>
                    <div>
                      <div className="metric-label mb-0.5">
                        {ms.nWindows != null ? 'Windows' : 'Temperature'}
                      </div>
                      <div className="font-mono text-sm font-semibold text-text-accent">
                        {ms.nWindows != null ? ms.nWindows.toLocaleString() : ds.temperature}
                      </div>
                    </div>
                  </div>
                )
              })()}

              <div className="flex items-center gap-2 text-xs text-text-muted">
                <Zap size={12} />
                <span className="truncate">{ds.protocol}</span>
              </div>
            </div>

            {/* Expanded cell table */}
            <AnimatePresence>
              {expandedDataset === ds.name && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="panel-elevated mt-1 p-4 overflow-hidden"
                >
                  <h3 className="text-sm font-semibold text-text-primary mb-3 flex items-center gap-2">
                    <Activity size={14} className="text-brand-blue" />
                    Cells — {ds.name}
                  </h3>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-border-subtle">
                        {['Cell ID', 'Split', 'Cycles', 'RUL Range'].map(h => (
                          <th key={h} className="text-left pb-2 pr-4 text-text-muted uppercase tracking-wider font-medium">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {ds.cells.map(c => (
                        <tr key={c.id} className="border-b border-border-subtle/30">
                          <td className="py-1.5 pr-4 font-mono text-text-accent">{c.id}</td>
                          <td className="py-1.5 pr-4">
                            <span className={`badge text-xs ${SPLIT_BADGE[c.split]}`}>{c.split}</span>
                          </td>
                          <td className="py-1.5 pr-4 font-mono text-text-secondary">{c.cycles.toLocaleString()}</td>
                          <td className="py-1.5 text-text-muted">{c.rul_range}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        ))}
      </motion.div>

      {/* Radar chart */}
      <div className="panel p-6 mb-8">
        <h2 className="section-title mb-1">Chemistry Comparison Radar</h2>
        <p className="text-xs text-text-muted mb-4">Normalized performance profile per chemistry</p>
        <Plot
          data={radarTraces.map(t => ({
            ...RADAR_DATA,
            name: t.name,
            r: [...t.r, t.r[0]],
            theta: [...RADAR_CATEGORIES, RADAR_CATEGORIES[0]],
            line: { color: t.color, width: 2 },
            marker: { color: t.color, size: 5 },
            fillcolor: t.color + '22',
          }))}
          layout={{
            polar: {
              radialaxis: { visible: true, range: [0, 1], color: '#64748b', gridcolor: '#1e3a5f', tickfont: { size: 10, color: '#64748b' } },
              angularaxis: { color: '#64748b', gridcolor: '#1e3a5f', tickfont: { size: 11, color: '#94a3b8' } },
              bgcolor: 'transparent',
            },
            paper_bgcolor: 'transparent',
            plot_bgcolor: 'transparent',
            legend: { font: { color: '#94a3b8', size: 11 }, bgcolor: 'transparent' },
            height: 320,
            margin: { t: 20, b: 20, l: 20, r: 20 },
          }}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: '100%' }}
        />
      </div>

      {/* Split philosophy */}
      <div className="panel p-6">
        <h2 className="section-title mb-3 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-brand-cyan" />
          Data Split Philosophy
        </h2>
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Train', cells: 'CS2_35, CX2_16, CX2_33, CX2_36, CX2_38 + Oxford Cell1–6', color: 'emerald', desc: 'Used for parameter updates' },
            { label: 'Validation', cells: 'CS2_34, CX2_37', color: 'amber', desc: 'Early stopping criterion' },
            { label: 'Test (held-out)', cells: 'CS2_37, CS2_38, all MIT/KJTU/TJU test cells, Oxford Cell7–8', color: 'blue', desc: 'Never seen during training' },
          ].map(s => (
            <div key={s.label} className={`rounded-lg p-4 border ${
              s.color === 'emerald' ? 'bg-emerald-500/5 border-emerald-500/20' :
              s.color === 'amber' ? 'bg-amber-500/5 border-amber-500/20' :
              'bg-blue-500/5 border-blue-500/20'
            }`}>
              <div className={`text-xs font-semibold uppercase tracking-wider mb-2 ${
                s.color === 'emerald' ? 'text-emerald-400' :
                s.color === 'amber' ? 'text-amber-400' : 'text-blue-400'
              }`}>{s.label}</div>
              <div className="text-xs text-text-secondary leading-relaxed font-mono">{s.cells}</div>
              <div className="text-xs text-text-muted mt-2">{s.desc}</div>
            </div>
          ))}
        </div>
        <p className="text-xs text-text-muted mt-3">
          Cell-disjoint splits ensure no temporal leakage. Normalization statistics computed from training cells only.
          Deterministic seed=42 for full reproducibility.
        </p>
      </div>
    </div>
  )
}

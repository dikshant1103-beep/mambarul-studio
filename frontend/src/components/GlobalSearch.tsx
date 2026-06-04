import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Search, FileText, Battery, Layers, X, ArrowRight, Command } from 'lucide-react'

// ─── Static data ────────────────────────────────────────────────────────────

interface NavItem { label: string; path: string; desc: string; key?: string }
interface CellItem { id: string; chemistry: string; r2: number }
interface FeatureItem { name: string; desc: string }

const NAV_ITEMS: NavItem[] = [
  { label: 'Home',               path: '/',                desc: 'Dashboard overview · v10-final stats',                          key: '1' },
  { label: 'Datasets',           path: '/datasets',        desc: '6 datasets · 167K rows · CALCE LFP NMC NCM Oxford',             key: '2' },
  { label: 'Feature Engineering',path: '/features',        desc: '13-feature pipeline · window construction' },
  { label: 'Feature Graphs',     path: '/feature-graphs',  desc: '43 features per cell · ICA/DVA plots',                          key: 'f' },
  { label: 'Leakage Audit',      path: '/leakage',         desc: 'CumEnergy r=-1.000 discovery · data integrity' },
  { label: 'Model Gallery',      path: '/models',          desc: '6 model architectures · SVG diagrams',                          key: '3' },
  { label: 'v1→v10-final',       path: '/model-versions',  desc: '12 versions · RMSE ladder from 88.8→20.6',                     key: 'v' },
  { label: 'Training Animation', path: '/training',        desc: '8-stage pipeline animation',                                    key: 't' },
  { label: 'Benchmark Dashboard',path: '/benchmark',       desc: '5 chemistries · all RMSE/R² results',                          key: '4' },
  { label: 'Pred vs Actual',     path: '/predictions',     desc: 'All test cells · Oxford K-sweep',                               key: 'p' },
  { label: 'Analysis Hub',       path: '/analysis',        desc: 'Multi-cell correlation matrix · SHAP',                          key: 'a' },
  { label: 'Live Prediction',    path: '/predict',         desc: 'Real-time RUL from 13 features · PyTorch inference',            key: '5' },
  { label: 'Explainability',     path: '/explainability',  desc: 'SHAP beeswarm · feature attribution · anchor attention',        key: 'e' },
  { label: 'Thesis Explorer',    path: '/thesis',          desc: '7 chapters · formulas · key findings',                          key: '?' },
  { label: 'Raw Signals',        path: '/raw-signals',     desc: 'Voltage/current/temperature curves from CALCE XLSX',            key: 'r' },
  { label: 'Conformal Prediction',path: '/conformal',      desc: 'Coverage-guaranteed uncertainty bands',                         key: 'c' },
  { label: 'Chemistry Explorer', path: '/chemistry',       desc: 'LCO LFP NMC NCM · real dQ/dV curves',                          key: 'x' },
  { label: 'Oxford Analysis',    path: '/oxford',          desc: 'M1-M6 methods · LOOCV · K-sweep · R²=0.995',                   key: 'o' },
  { label: 'PyBaMM Ensemble',    path: '/pybamm',          desc: 'Physics-informed ensemble · synthetic augmentation',            key: 'y' },
  { label: 'Ablation Study',     path: '/ablation',        desc: 'Feature/architecture ablation results',                         key: 'b' },
  { label: 'BMS Dashboard',      path: '/bms',             desc: 'Battery management system simulation',                          key: 'd' },
  { label: 'Key Discoveries',    path: '/discoveries',     desc: 'CumEnergy leakage · Oxford zero-shot · v8 breakthrough',        key: 'k' },
  { label: 'Physics Viz',        path: '/physics',         desc: 'SEI growth · Arrhenius · Butler-Volmer equations',              key: 'h' },
  { label: 'Architecture Insights',path:'/architecture',   desc: 'Mamba SSM internals · anchor attention',                        key: 'i' },
  { label: 'Upload & Predict',   path: '/upload',          desc: 'Upload CSV/XLSX · get RUL predictions',                         key: 'u' },
  { label: 'Neuron Animation',   path: '/neuron',          desc: 'Real activation hooks · 3D canvas · weight matrices',           key: 'n' },
  { label: 'Experiment Replay',  path: '/experiment-replay',desc: '4 seeds · convergence replay · val RMSE vs epoch',            key: 'j' },
  { label: 'Battery Lab',        path: '/battery-lab',     desc: 'Animated cycler · DAQ · sensor streams',                        key: 'l' },
  { label: 'MAE Visualizer',     path: '/mae',             desc: 'Masked autoencoder · 6-stage pretraining animation',            key: 'm' },
  { label: 'Per-Cell Predictions',path: '/per-cell',       desc: '17 test cells · predicted vs actual RUL · R² overview',        key: 'g' },
  { label: 'Crystal Structure',  path: '/chemistry-3d',    desc: 'Li+ intercalation animation · LCO LFP NMC NCM',                key: 'z' },
  { label: 'Multi-Cell Overlay', path: '/multi-cell',      desc: 'Overlay RUL curves for multiple cells simultaneously' },
  { label: 'Battery Aging Sim',  path: '/aging-sim',       desc: 'Physics-informed SOH trajectory simulator' },
  { label: '3D PCA Explorer',    path: '/pca',             desc: '167K samples in 3D feature space · colored by chemistry' },
  { label: 'Model Race',         path: '/model-race',      desc: 'v8 vs v10-final vs v11 side-by-side RUL race' },
  { label: 'Oxford Fine-Tune',   path: '/oxford-finetune', desc: '50-snapshot fine-tuning animation · R²=-1.4→0.995' },
]

const CELLS: CellItem[] = [
  { id: 'CS2_37',                    chemistry: 'LCO',        r2: 0.842 },
  { id: 'CS2_38',                    chemistry: 'LCO',        r2: 0.978 },
  { id: 'MIT_2017-05-12_043',        chemistry: 'LFP',        r2: -0.40 },
  { id: 'Batch-4_R3_battery-4',      chemistry: 'NMC',        r2: 0.990 },
  { id: 'Dataset_3__CY25-05_2-#3',   chemistry: 'NCM',        r2: 0.976 },
  { id: 'Oxford_Cell7',              chemistry: 'Oxford-NMC', r2: 0.950 },
  { id: 'Oxford_Cell8',              chemistry: 'Oxford-NMC', r2: 0.871 },
]

const FEATURES: FeatureItem[] = [
  { name: 'capacity_Ah',    desc: 'Discharge capacity per cycle (Ah). Primary degradation indicator.' },
  { name: 'soh_pct',        desc: 'State of Health = cap/cap₀ × 100. Most important feature (SHAP rank 1).' },
  { name: 'voltage_mean_V', desc: 'Mean discharge voltage. Shifts with aging.' },
  { name: 'energy_Wh',      desc: 'Discharge energy. Correlated with capacity.' },
  { name: 'ir_proxy_Ohm',   desc: 'Internal resistance proxy. Rises with SEI growth.' },
  { name: 'delta_cap',      desc: 'Cycle-over-cycle capacity change. Tracks fade rate.' },
  { name: 'cum_energy',     desc: 'Cumulative energy (WARNING: r=-1.000 leakage with RUL).' },
  { name: 'temperature_C',  desc: 'Cell temperature during cycling.' },
  { name: 'charge_time_s',  desc: 'CC-CV charge time. Indicator of capacity retention.' },
  { name: 'discharge_slope',desc: 'Linear slope of discharge curve.' },
  { name: 'voltage_end_V',  desc: 'End-of-discharge voltage cutoff.' },
  { name: 'cap_std_5',      desc: '5-cycle rolling std of capacity. Detects instability.' },
  { name: 'soh_slope_5',    desc: '5-cycle SOH trend. Early warning signal.' },
]

// ─── Chemistry color map ─────────────────────────────────────────────────────

const CHEM_COLORS: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', 'Oxford-NMC': '#06b6d4',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function matchScore(query: string, text: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase())
}

// ─── Result types ─────────────────────────────────────────────────────────────


interface PageResult  { kind: 'page';    item: NavItem }
interface CellResult  { kind: 'cell';    item: CellItem }
interface FeatureResult { kind: 'feature'; item: FeatureItem }
type SearchResult = PageResult | CellResult | FeatureResult

// ─── Component ───────────────────────────────────────────────────────────────

export default function GlobalSearch() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Build filtered results
  const results: SearchResult[] = (() => {
    if (!query.trim()) {
      // Show top pages when no query
      return NAV_ITEMS.slice(0, 8).map(item => ({ kind: 'page' as const, item }))
    }
    const q = query.trim()
    const pages: PageResult[] = NAV_ITEMS
      .filter(i => matchScore(q, i.label) || matchScore(q, i.desc) || matchScore(q, i.path))
      .slice(0, 10)
      .map(item => ({ kind: 'page', item }))
    const cells: CellResult[] = CELLS
      .filter(i => matchScore(q, i.id) || matchScore(q, i.chemistry))
      .map(item => ({ kind: 'cell', item }))
    const features: FeatureResult[] = FEATURES
      .filter(i => matchScore(q, i.name) || matchScore(q, i.desc))
      .map(item => ({ kind: 'feature', item }))
    return [...pages, ...cells, ...features]
  })()

  // Reset selection on results change
  useEffect(() => { setSelectedIndex(0) }, [query])

  // Global Ctrl+K / Cmd+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  const activate = useCallback((result: SearchResult) => {
    close()
    if (result.kind === 'page')    navigate(result.item.path)
    if (result.kind === 'cell')    navigate('/per-cell')
    if (result.kind === 'feature') navigate('/features')
  }, [close, navigate])

  // Keyboard navigation inside modal
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(i => Math.min(i + 1, results.length - 1))
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(i => Math.max(i - 1, 0))
      }
      if (e.key === 'Enter') {
        const r = results[selectedIndex]
        if (r) activate(r)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, results, selectedIndex, activate, close])

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // ─── Group results for rendering ──────────────────────────────────────────
  const pages    = results.filter((r): r is PageResult    => r.kind === 'page')
  const cells    = results.filter((r): r is CellResult    => r.kind === 'cell')
  const features = results.filter((r): r is FeatureResult => r.kind === 'feature')

  // Flat index map for highlight
  const pageStart    = 0
  const cellStart    = pages.length
  const featureStart = pages.length + cells.length

  return (
    <>
      {/* Trigger hint rendered in Layout footer — nothing to render here for the button */}
      <AnimatePresence>
        {open && (
          <motion.div
            key="gs-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-[9999] flex items-start justify-center pt-[12vh]"
            style={{ backgroundColor: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
            onMouseDown={(e) => { if (e.target === e.currentTarget) close() }}
          >
            <motion.div
              key="gs-box"
              initial={{ opacity: 0, scale: 0.96, y: -12 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -12 }}
              transition={{ duration: 0.18, ease: 'easeOut' }}
              className="w-full max-w-2xl mx-4 rounded-2xl shadow-2xl overflow-hidden"
              style={{ backgroundColor: '#0f1729', border: '1px solid #1e3a5f' }}
            >
              {/* Search input */}
              <div className="flex items-center gap-3 px-4 py-3 border-b border-[#1e3a5f]">
                <Search size={18} className="text-[#3b82f6] flex-shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  placeholder="Search pages, cells, features…"
                  className="flex-1 bg-transparent text-[#f1f5f9] placeholder-[#475569] text-sm outline-none"
                  autoComplete="off"
                  spellCheck={false}
                />
                {query && (
                  <button onClick={() => setQuery('')} className="text-[#475569] hover:text-[#94a3b8] transition-colors">
                    <X size={15} />
                  </button>
                )}
                <kbd className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono text-[#475569] border border-[#1e3a5f]">
                  Esc
                </kbd>
              </div>

              {/* Results */}
              <div ref={listRef} className="overflow-y-auto" style={{ maxHeight: '60vh' }}>
                {results.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-[#475569]">
                    No results for <span className="text-[#94a3b8]">"{query}"</span>
                  </div>
                ) : (
                  <div className="py-2">

                    {/* Pages group */}
                    {pages.length > 0 && (
                      <div>
                        <GroupHeader icon={<FileText size={11} />} label={query ? 'Pages' : 'Quick Nav'} />
                        {pages.map((r, i) => {
                          const idx = pageStart + i
                          return (
                            <ResultRow
                              key={r.item.path}
                              dataIdx={idx}
                              selected={selectedIndex === idx}
                              onMouseEnter={() => setSelectedIndex(idx)}
                              onClick={() => activate(r)}
                            >
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                                     style={{ backgroundColor: '#1e3a5f' }}>
                                  <ArrowRight size={12} className="text-[#3b82f6]" />
                                </div>
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-[#f1f5f9] truncate">{r.item.label}</div>
                                  <div className="text-xs text-[#475569] truncate">{r.item.desc}</div>
                                </div>
                              </div>
                              {r.item.key && (
                                <kbd className="ml-2 flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-mono text-[#475569] border border-[#1e3a5f]">
                                  {r.item.key}
                                </kbd>
                              )}
                            </ResultRow>
                          )
                        })}
                      </div>
                    )}

                    {/* Cells group */}
                    {cells.length > 0 && (
                      <div>
                        <GroupHeader icon={<Battery size={11} />} label="Test Cells" />
                        {cells.map((r, i) => {
                          const idx = cellStart + i
                          const color = CHEM_COLORS[r.item.chemistry] ?? '#64748b'
                          return (
                            <ResultRow
                              key={r.item.id}
                              dataIdx={idx}
                              selected={selectedIndex === idx}
                              onMouseEnter={() => setSelectedIndex(idx)}
                              onClick={() => activate(r)}
                            >
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                                     style={{ backgroundColor: `${color}22` }}>
                                  <Battery size={12} style={{ color }} />
                                </div>
                                <div className="min-w-0">
                                  <div className="text-sm font-medium text-[#f1f5f9] truncate font-mono">{r.item.id}</div>
                                  <div className="text-xs text-[#475569]">{r.item.chemistry}</div>
                                </div>
                              </div>
                              <div className="flex-shrink-0 text-right">
                                <div className="text-xs font-mono" style={{ color: r.item.r2 >= 0 ? '#10b981' : '#ef4444' }}>
                                  R²={r.item.r2.toFixed(3)}
                                </div>
                              </div>
                            </ResultRow>
                          )
                        })}
                      </div>
                    )}

                    {/* Features group */}
                    {features.length > 0 && (
                      <div>
                        <GroupHeader icon={<Layers size={11} />} label="Features" />
                        {features.map((r, i) => {
                          const idx = featureStart + i
                          const isLeakage = r.item.name === 'cum_energy'
                          return (
                            <ResultRow
                              key={r.item.name}
                              dataIdx={idx}
                              selected={selectedIndex === idx}
                              onMouseEnter={() => setSelectedIndex(idx)}
                              onClick={() => activate(r)}
                            >
                              <div className="flex items-center gap-3 flex-1 min-w-0">
                                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                                     style={{ backgroundColor: isLeakage ? '#ef444422' : '#8b5cf622' }}>
                                  <Layers size={12} style={{ color: isLeakage ? '#ef4444' : '#8b5cf6' }} />
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="text-sm font-medium font-mono text-[#f1f5f9]">{r.item.name}</span>
                                    {isLeakage && (
                                      <span className="text-[10px] px-1 rounded font-medium"
                                            style={{ backgroundColor: '#ef444422', color: '#ef4444' }}>
                                        LEAKAGE
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-xs text-[#475569] truncate">{r.item.desc}</div>
                                </div>
                              </div>
                            </ResultRow>
                          )
                        })}
                      </div>
                    )}

                  </div>
                )}
              </div>

              {/* Footer */}
              <div className="px-4 py-2 border-t border-[#1e3a5f] flex items-center gap-4 text-[10px] text-[#475569]">
                <span className="flex items-center gap-1"><kbd className="font-mono border border-[#1e3a5f] px-1 rounded">↑↓</kbd> navigate</span>
                <span className="flex items-center gap-1"><kbd className="font-mono border border-[#1e3a5f] px-1 rounded">↵</kbd> open</span>
                <span className="flex items-center gap-1"><kbd className="font-mono border border-[#1e3a5f] px-1 rounded">Esc</kbd> close</span>
                <span className="ml-auto flex items-center gap-1">
                  <Command size={10} /> K to toggle
                </span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function GroupHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-1.5 px-4 py-1.5 mt-1">
      <span className="text-[#3b82f6]">{icon}</span>
      <span className="text-[10px] font-semibold uppercase tracking-widest text-[#475569]">{label}</span>
    </div>
  )
}

interface ResultRowProps {
  dataIdx: number
  selected: boolean
  onMouseEnter: () => void
  onClick: () => void
  children: React.ReactNode
}

function ResultRow({ dataIdx, selected, onMouseEnter, onClick, children }: ResultRowProps) {
  return (
    <div
      data-idx={dataIdx}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className="flex items-center gap-2 px-4 py-2.5 cursor-pointer transition-colors duration-75"
      style={{ backgroundColor: selected ? 'rgba(59,130,246,0.12)' : 'transparent' }}
    >
      {children}
    </div>
  )
}

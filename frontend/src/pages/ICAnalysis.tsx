/**
 * ICAnalysis — dQ/dV Incremental Capacity Analysis.
 * Route: /ic-analysis
 * Shows IC curves across cycle life + peak trend charts + degradation modes.
 * MIT LFP: real extracted features. Others: physics-based synthetic.
 */
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Activity, RefreshCw, Info, Search, ChevronRight } from 'lucide-react'
import Plot from 'react-plotly.js'

interface ICCurve {
  cycle: number; voltage: number[]; dqdv: number[]; soh?: number
  features?: { peak1_height: number; peak1_pos: number; peak2_height: number; peak2_pos: number; valley_depth: number }
}
interface PeakTrends {
  cycles: number[]; peak1_pos: number[]; peak1_height: number[]
  peak2_pos: number[]; peak2_height: number[]; valley_depth?: number[]
}
interface DegModes { LLI: number; LAM_NE: number; LAM_PE: number; SEI: number; dominant: string }
interface ICResult {
  cell_id: string; chemistry: string; source: string
  n_cycles_total: number; curves: ICCurve[]
  peak_trends: PeakTrends; degradation_modes: DegModes
}

const CYCLE_COLORS = [
  '#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444',
  '#06b6d4','#84cc16','#f97316','#ec4899','#64748b',
]
const MODE_COLOR: Record<string, string> = {
  LLI: '#3b82f6', LAM_NE: '#10b981', LAM_PE: '#f59e0b', SEI: '#8b5cf6',
}
const PLOTLY_BASE = {
  paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
  margin: { l: 44, r: 12, t: 8, b: 32 },
  font: { color: '#94a3b8', size: 10 },
  xaxis: { gridcolor: '#1e293b', zerolinecolor: '#1e293b', tickfont: { size: 9 } },
  yaxis: { gridcolor: '#1e293b', zerolinecolor: '#1e293b', tickfont: { size: 9 } },
}

const CHEM_OPTIONS = ['LFP','NMC','NCA','NCM','LCO']

export default function ICAnalysis() {
  const [realCells,    setRealCells]   = useState<string[]>([])
  const [selCell,      setSelCell]     = useState('')
  const [chemistry,    setChemistry]   = useState('LFP')
  const [loading,      setLoading]     = useState(false)
  const [result,       setResult]      = useState<ICResult | null>(null)
  const [error,        setError]       = useState<string | null>(null)
  const [filter,       setFilter]      = useState('')
  const [activeTab,    setActiveTab]   = useState<'curves'|'peaks'|'modes'>('curves')

  // Load real MIT cell list on mount
  useEffect(() => {
    fetch('/api/dqdv/cells')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.cells) setRealCells(d.cells) })
      .catch(() => {})
  }, [])

  const load = (cell_id: string, chem = chemistry) => {
    if (!cell_id) return
    setLoading(true); setError(null)
    fetch(`/api/dqdv/cell/${encodeURIComponent(cell_id)}?n_samples=8&chemistry=${chem}`)
      .then(r => r.ok ? r.json() : r.text().then(t => Promise.reject(t)))
      .then(setResult)
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }

  const filteredCells = realCells.filter(c =>
    !filter || c.toLowerCase().includes(filter.toLowerCase())
  )

  const pt = result?.peak_trends
  const dm = result?.degradation_modes

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <Activity size={20} className="text-blue-400" /> ICA / dQ/dV Analysis
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Incremental capacity curves · peak tracking · degradation mode decomposition
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

        {/* Left: cell selector */}
        <div className="lg:col-span-1 space-y-3">

          {/* Chemistry for non-MIT cells */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3">
            <div className="text-[10px] text-text-muted uppercase tracking-widest mb-2">Chemistry</div>
            <div className="flex flex-wrap gap-1">
              {CHEM_OPTIONS.map(c => (
                <button key={c} onClick={() => { setChemistry(c); if (selCell) load(selCell, c) }}
                  className={`px-2 py-1 rounded text-[10px] font-bold transition-colors ${
                    chemistry === c ? 'bg-brand-blue text-white' : 'bg-bg-panel text-text-muted hover:text-text-primary'
                  }`}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          {/* MIT real cells */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
            <div className="px-3 py-2 border-b border-border-subtle">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Search size={11} className="text-text-muted" />
                <input value={filter} onChange={e => setFilter(e.target.value)}
                  placeholder="Search cells…"
                  className="flex-1 bg-transparent text-[10px] text-text-primary placeholder:text-text-muted focus:outline-none" />
              </div>
              <div className="text-[10px] text-text-muted">
                {realCells.length > 0
                  ? <span className="text-emerald-400">● Real MIT LFP data ({realCells.length} cells)</span>
                  : <span className="text-amber-400">● No real data — using synthetic</span>}
              </div>
            </div>
            <div className="overflow-y-auto max-h-72 divide-y divide-border-subtle/50">
              {filteredCells.slice(0, 30).map(c => (
                <button key={c} onClick={() => { setSelCell(c); load(c) }}
                  className={`w-full text-left px-3 py-1.5 text-[10px] font-mono hover:bg-bg-panel transition-colors ${
                    selCell === c ? 'bg-bg-panel text-brand-blue' : 'text-text-secondary'
                  }`}>
                  {c.split('_').slice(-2).join('-')}
                </button>
              ))}
              {filteredCells.length === 0 && realCells.length === 0 && (
                <div className="px-3 py-2 text-[10px] text-text-muted">
                  No real cells — enter a cell ID manually
                </div>
              )}
            </div>
          </div>

          {/* Manual cell ID */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
            <div className="text-[10px] text-text-muted">Any cell from dataset</div>
            <input value={selCell} onChange={e => setSelCell(e.target.value)}
              placeholder="e.g. b1c0"
              className="w-full bg-bg-panel border border-border-subtle rounded px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:border-brand-blue" />
            <button onClick={() => load(selCell)} disabled={!selCell || loading}
              className="w-full py-1.5 bg-brand-blue rounded text-xs font-medium text-white hover:bg-blue-500 transition-colors disabled:opacity-50">
              {loading ? 'Loading…' : 'Analyze'}
            </button>
          </div>
        </div>

        {/* Right: charts */}
        <div className="lg:col-span-4 space-y-4">

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-lg p-3">{error}</div>
          )}

          {!result && !loading && (
            <div className="flex flex-col items-center justify-center h-64 text-text-muted text-sm gap-2 bg-bg-secondary border border-border-subtle rounded-xl">
              <Activity size={28} className="opacity-20" /> Select a cell to view IC curves
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center h-48 text-text-muted text-xs gap-2 bg-bg-secondary border border-border-subtle rounded-xl">
              <RefreshCw size={12} className="animate-spin" /> Loading IC data…
            </div>
          )}

          {result && !loading && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">

              {/* Header */}
              <div className="bg-bg-secondary border border-border-subtle rounded-xl px-4 py-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold text-text-primary font-mono">{result.cell_id}</div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {result.chemistry} · {result.n_cycles_total} cycles ·{' '}
                    <span className={result.source === 'real' ? 'text-emerald-400' : 'text-amber-400'}>
                      {result.source === 'real' ? '● Real features' : '○ Synthetic model'}
                    </span>
                  </div>
                </div>
                {/* Tab bar */}
                <div className="flex gap-1 p-1 bg-bg-panel rounded-lg">
                  {(['curves','peaks','modes'] as const).map(t => (
                    <button key={t} onClick={() => setActiveTab(t)}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                        activeTab === t ? 'bg-brand-blue text-white' : 'text-text-secondary hover:text-text-primary'
                      }`}>
                      {t === 'curves' ? 'IC Curves' : t === 'peaks' ? 'Peak Trends' : 'Degradation Modes'}
                    </button>
                  ))}
                </div>
              </div>

              {/* IC Curves tab */}
              {activeTab === 'curves' && (
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                  <div className="text-xs font-semibold text-text-primary mb-1">
                    dQ/dV Curves — {result.curves.length} sampled cycles
                  </div>
                  <div className="text-[10px] text-text-muted mb-3">
                    Blue = early life → Red = end of life. Peak positions shift left (LLI) and heights drop (LAM) as cell degrades.
                  </div>
                  <Plot
                    data={result.curves.map((c, i) => ({
                      x: c.voltage, y: c.dqdv,
                      type: 'scatter', mode: 'lines',
                      line: { color: CYCLE_COLORS[i % CYCLE_COLORS.length], width: 1.5 },
                      name: `Cycle ${c.cycle}${c.soh ? ` (${c.soh}%)` : ''}`,
                    }))}
                    layout={{
                      ...PLOTLY_BASE, height: 280,
                      xaxis: { ...PLOTLY_BASE.xaxis, title: { text: 'Voltage (V)' } },
                      yaxis: { ...PLOTLY_BASE.yaxis, title: { text: 'dQ/dV (Ah/V)' } },
                      legend: { x: 1.01, y: 1, font: { size: 9 }, bgcolor: 'transparent' },
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%' }}
                  />
                </div>
              )}

              {/* Peak Trends tab */}
              {activeTab === 'peaks' && pt && pt.cycles.length > 0 && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="text-xs font-semibold text-text-primary mb-2">Peak Position vs Cycle</div>
                    <Plot
                      data={[
                        { x: pt.cycles, y: pt.peak1_pos, type: 'scatter', mode: 'lines',
                          line: { color: '#3b82f6', width: 2 }, name: 'Peak 1 pos (V)' },
                        ...(pt.peak2_pos?.length ? [{
                          x: pt.cycles, y: pt.peak2_pos, type: 'scatter' as const, mode: 'lines' as const,
                          line: { color: '#10b981', width: 2 }, name: 'Peak 2 pos (V)' }] : []),
                      ]}
                      layout={{
                        ...PLOTLY_BASE, height: 180,
                        xaxis: { ...PLOTLY_BASE.xaxis, title: { text: 'Cycle' } },
                        yaxis: { ...PLOTLY_BASE.yaxis, title: { text: 'Position (V)' } },
                        legend: { x: 0, y: 1.15, orientation: 'h', font: { size: 9 } },
                      }}
                      config={{ displayModeBar: false, responsive: true }}
                      style={{ width: '100%' }}
                    />
                  </div>
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="text-xs font-semibold text-text-primary mb-2">Peak Height vs Cycle</div>
                    <Plot
                      data={[
                        { x: pt.cycles, y: pt.peak1_height, type: 'scatter', mode: 'lines',
                          line: { color: '#f59e0b', width: 2 }, name: 'Peak 1 height' },
                        ...(pt.peak2_height?.length ? [{
                          x: pt.cycles, y: pt.peak2_height, type: 'scatter' as const, mode: 'lines' as const,
                          line: { color: '#8b5cf6', width: 2 }, name: 'Peak 2 height' }] : []),
                      ]}
                      layout={{
                        ...PLOTLY_BASE, height: 180,
                        xaxis: { ...PLOTLY_BASE.xaxis, title: { text: 'Cycle' } },
                        yaxis: { ...PLOTLY_BASE.yaxis, title: { text: 'Height (Ah/V)' } },
                        legend: { x: 0, y: 1.15, orientation: 'h', font: { size: 9 } },
                      }}
                      config={{ displayModeBar: false, responsive: true }}
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
              )}

              {/* Degradation Modes tab */}
              {activeTab === 'modes' && dm && (
                <div className="grid grid-cols-2 gap-4">
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="text-xs font-semibold text-text-primary mb-4">Degradation Mode Decomposition</div>
                    <div className="space-y-3">
                      {(['LLI','LAM_NE','LAM_PE','SEI'] as const).map(mode => (
                        <div key={mode}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium" style={{ color: MODE_COLOR[mode] }}>{mode}</span>
                            <span className="text-xs text-text-muted">{dm[mode]}%</span>
                          </div>
                          <div className="h-2 bg-bg-panel rounded-full overflow-hidden">
                            <div className="h-full rounded-full transition-all"
                              style={{ width: `${Math.min(100, dm[mode])}%`, background: MODE_COLOR[mode] }} />
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 pt-3 border-t border-border-subtle">
                      <div className="text-[10px] text-text-muted">Dominant mode</div>
                      <div className="text-sm font-bold mt-0.5" style={{ color: MODE_COLOR[dm.dominant] }}>
                        {dm.dominant}
                      </div>
                      <div className="text-[10px] text-text-muted mt-1">
                        {dm.dominant === 'LLI' && 'Loss of Lithium Inventory — SEI film consuming cyclable Li'}
                        {dm.dominant === 'LAM_NE' && 'Loss of Active Material (anode) — graphite particle cracking'}
                        {dm.dominant === 'LAM_PE' && 'Loss of Active Material (cathode) — transition metal dissolution'}
                        {dm.dominant === 'SEI' && 'SEI growth — electrolyte decomposition at anode surface'}
                      </div>
                    </div>
                  </div>
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                    <div className="text-xs font-semibold text-text-primary mb-3">Degradation Mode Guide</div>
                    {[
                      { mode: 'LLI', icon: '⟵', desc: 'IC peak shifts left in voltage', action: 'Reduce high-SOC storage time, avoid overcharge' },
                      { mode: 'LAM_NE', icon: '↓', desc: 'Anode peak height decreases', action: 'Reduce fast charging, avoid deep discharge' },
                      { mode: 'LAM_PE', icon: '↓', desc: 'Cathode peak height decreases', action: 'Reduce temperature, avoid high-voltage cycling' },
                      { mode: 'SEI', icon: '⌇', desc: 'Valley between peaks deepens', action: 'Use temperature-controlled charging, formation protocol' },
                    ].map(({ mode, icon, desc, action }) => (
                      <div key={mode} className="mb-3 flex items-start gap-2">
                        <span className="text-sm font-bold" style={{ color: MODE_COLOR[mode] }}>{icon}</span>
                        <div>
                          <div className="text-[10px] font-medium text-text-secondary">{mode}: {desc}</div>
                          <div className="text-[10px] text-text-muted flex items-center gap-1 mt-0.5">
                            <ChevronRight size={9} /> {action}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </div>
      </div>

      <div className="flex items-start gap-2 px-4 py-3 bg-bg-secondary border border-border-subtle rounded-xl text-xs text-text-muted">
        <Info size={12} className="text-brand-blue flex-shrink-0 mt-0.5" />
        <span>
          MIT LFP cells use <strong className="text-text-secondary">real extracted features</strong> from mit_dqdv_features.npy (107k cycles).
          Other chemistries use a <strong className="text-text-secondary">physics-based Gaussian peak model</strong> parameterised from SOH/IR.
          Degradation modes: <strong className="text-text-secondary">LLI</strong> = peak position shift,
          <strong className="text-text-secondary"> LAM</strong> = peak height drop,
          <strong className="text-text-secondary"> SEI</strong> = valley deepening.
        </span>
      </div>
    </div>
  )
}

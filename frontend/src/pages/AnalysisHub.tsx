import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { BarChart2, RefreshCw, X } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'
import { ExportCSV } from '../components/ui/ExportButton'

const CHEM_COLORS: Record<string, string> = { LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#ef4444' }
const PALETTE = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444','#06b6d4']

interface CellInfo { cell_id: string; dataset: string; chemistry: string; split: string; n_cycles: number }
interface OverlayCell { cell_id: string; chemistry: string; dataset: string; split: string; cycles: number[]; capacity: number[]; soh_pct: number[]; rul: number[] }
interface CorrData { features: string[]; matrix: number[][]; n_samples: number }

const REAL_SHAP_FIGURES = [
  { key: 'shap_beeswarm_calce', title: 'SHAP Beeswarm — CALCE LCO', desc: 'Per-feature SHAP distributions across all test windows' },
  { key: 'shap_beeswarm_oxford', title: 'SHAP Beeswarm — Oxford NMC', desc: 'SHAP distributions for zero-shot Oxford test cells' },
  { key: 'shap_heatmap', title: 'SHAP Heatmap', desc: 'Feature × sample SHAP value matrix' },
  { key: 'shap_overall', title: 'SHAP Overall Importance', desc: 'Global mean |SHAP| bar chart from thesis' },
]

export default function AnalysisHub() {
  const [tab, setTab] = useState<'multi'|'corr'|'shap'>('multi')

  // Multi-cell state
  const [allCells, setAllCells] = useState<CellInfo[]>([])
  const [chemFilter, setChemFilter] = useState('LCO')
  const [selectedCells, setSelectedCells] = useState<string[]>(['CS2_37', 'CS2_38'])
  const [overlayData, setOverlayData] = useState<Record<string, OverlayCell>>({})
  const [loadingOverlay, setLoadingOverlay] = useState(false)
  const [showMetric, setShowMetric] = useState<'capacity'|'soh_pct'|'rul'>('soh_pct')

  // Correlation state
  const [corrData, setCorrData] = useState<CorrData | null>(null)
  const [loadingCorr, setLoadingCorr] = useState(false)

  // SHAP figure state
  const [shapFig, setShapFig] = useState(REAL_SHAP_FIGURES[0].key)

  useEffect(() => {
    fetch('/api/cells').then(r => r.ok ? r.json() : []).then(setAllCells).catch(() => {})
  }, [])

  useEffect(() => {
    if (tab === 'multi' && selectedCells.length) fetchOverlay()
  }, [tab, selectedCells])

  useEffect(() => {
    if (tab === 'corr' && !corrData) fetchCorr()
  }, [tab])

  const fetchOverlay = async () => {
    if (!selectedCells.length) return
    setLoadingOverlay(true)
    try {
      const params = selectedCells.join(',')
      const d = await fetch(`/api/multi-cell-overlay?cells=${encodeURIComponent(params)}`).then(r => r.json())
      setOverlayData(d.cells ?? {})
    } catch {}
    setLoadingOverlay(false)
  }

  const fetchCorr = async () => {
    setLoadingCorr(true)
    try {
      const d = await fetch('/api/feature-correlation').then(r => r.json())
      setCorrData(d)
    } catch {}
    setLoadingCorr(false)
  }

  const toggleCell = (cid: string) => {
    setSelectedCells(prev =>
      prev.includes(cid) ? prev.filter(c => c !== cid) : [...prev.slice(-4), cid]
    )
  }

  const exportOverlay = Object.entries(overlayData).flatMap(([cid, d]) =>
    d.cycles.map((c, i) => ({ cell: cid, chemistry: d.chemistry, cycle: c, capacity: d.capacity[i], soh_pct: d.soh_pct[i], rul: d.rul[i] }))
  )

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <BarChart2 size={22} className="text-brand-purple" />
          <h1 className="text-2xl font-bold text-text-primary">Analysis Hub</h1>
        </div>
        <p className="text-text-secondary">Multi-cell overlay · Feature correlation matrix · Real SHAP figures</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {[
          { id: 'multi', label: 'Multi-Cell Overlay' },
          { id: 'corr', label: 'Feature Correlation Matrix' },
          { id: 'shap', label: 'SHAP Figures (Thesis)' },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id as typeof tab)}
            className={`px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${
              tab === t.id ? 'border-brand-blue text-brand-blue' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}>{t.label}</button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>

        {/* ── MULTI-CELL OVERLAY ─────────────────────────────────────────── */}
        {tab === 'multi' && (
          <div className="flex gap-5">
            <div className="w-60 flex-shrink-0 space-y-4">
              <div className="panel p-4">
                <div className="metric-label mb-2">Chemistry Filter</div>
                <div className="flex flex-wrap gap-1 mb-3">
                  {Object.keys(CHEM_COLORS).map(c => (
                    <button key={c} onClick={() => setChemFilter(c === chemFilter ? '' : c)}
                      className="px-2 py-0.5 rounded text-xs font-medium transition-all border"
                      style={chemFilter === c ? { backgroundColor: CHEM_COLORS[c], color: '#fff', borderColor: CHEM_COLORS[c] } : { borderColor: '#1e3a5f', color: '#64748b' }}>
                      {c}
                    </button>
                  ))}
                </div>
                <div className="metric-label mb-1">Select cells (max 5)</div>
                <div className="max-h-72 overflow-y-auto space-y-0.5">
                  {allCells.filter(c => !chemFilter || c.chemistry === chemFilter).slice(0, 50).map(c => (
                    <button key={c.cell_id} onClick={() => toggleCell(c.cell_id)}
                      className={`w-full text-left px-2 py-1.5 rounded text-xs transition-all flex items-center gap-2 ${selectedCells.includes(c.cell_id) ? 'bg-brand-blue/20 text-brand-blue' : 'text-text-secondary hover:bg-bg-elevated'}`}>
                      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: CHEM_COLORS[c.chemistry] ?? '#3b82f6' }} />
                      <span className="font-mono truncate">{c.cell_id}</span>
                      <span className="ml-auto text-text-muted">{c.n_cycles}cy</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel p-4">
                <div className="metric-label mb-2">Metric</div>
                {(['soh_pct','capacity','rul'] as const).map(m => (
                  <button key={m} onClick={() => setShowMetric(m)}
                    className={`w-full text-left px-3 py-2 rounded text-sm mb-1 transition-all capitalize ${showMetric === m ? 'bg-brand-blue/10 text-brand-blue border border-brand-blue/20' : 'text-text-muted hover:bg-bg-elevated'}`}>
                    {m === 'soh_pct' ? 'State of Health (%)' : m === 'capacity' ? 'Capacity (Ah)' : 'RUL (cycles)'}
                  </button>
                ))}
              </div>

              <button onClick={fetchOverlay} disabled={loadingOverlay}
                className="btn-primary w-full flex items-center justify-center gap-2 text-sm">
                {loadingOverlay ? <RefreshCw size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Refresh
              </button>
              {exportOverlay.length > 0 && <ExportCSV data={exportOverlay} filename="multi_cell_overlay.csv" />}
            </div>

            <div className="flex-1 min-w-0 space-y-4">
              {/* Selected badges */}
              <div className="flex flex-wrap gap-2">
                {selectedCells.map((cid, idx) => {
                  const d = overlayData[cid]
                  return (
                    <div key={cid} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-mono"
                      style={{ borderColor: PALETTE[idx % PALETTE.length] + '55', backgroundColor: PALETTE[idx % PALETTE.length] + '11', color: PALETTE[idx % PALETTE.length] }}>
                      <span className="w-2 h-2 rounded-full" style={{ backgroundColor: PALETTE[idx % PALETTE.length] }} />
                      {cid} {d && `· ${d.chemistry}`}
                      <button onClick={() => toggleCell(cid)} className="ml-1 hover:opacity-70"><X size={11} /></button>
                    </div>
                  )
                })}
              </div>

              {loadingOverlay ? <SkeletonChart height={320} /> : Object.keys(overlayData).length > 0 ? (
                <>
                  <div className="panel p-5">
                    <h3 className="section-title mb-4">
                      {showMetric === 'soh_pct' ? 'State of Health (%)' : showMetric === 'capacity' ? 'Capacity (Ah)' : 'RUL (cycles)'}
                      {' '}— Multi-Cell Overlay
                    </h3>
                    <Plot
                      data={Object.entries(overlayData).map(([cid, d], idx) => ({
                        type: 'scatter' as const, mode: 'lines' as const,
                        name: `${cid} (${d.chemistry})`,
                        x: d.cycles,
                        y: d[showMetric],
                        line: { color: PALETTE[idx % PALETTE.length], width: 2 },
                      }))}
                      layout={{ ...darkLayout, height: 320,
                        xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
                        yaxis: { ...darkLayout.yaxis as object, title: { text: showMetric === 'soh_pct' ? 'SOH (%)' : showMetric === 'capacity' ? 'Capacity (Ah)' : 'RUL', font: { color: '#64748b' } } },
                      } as Plotly.Layout}
                      config={plotConfig} style={{ width: '100%' }}
                    />
                  </div>

                  {/* Chemistry summary */}
                  <div className="panel p-5">
                    <h3 className="section-title mb-3">Cell Summary</h3>
                    <div className="grid grid-cols-3 gap-3">
                      {Object.entries(overlayData).map(([cid, d], idx) => (
                        <div key={cid} className="bg-bg-elevated rounded-lg p-3 border" style={{ borderColor: PALETTE[idx % PALETTE.length] + '44' }}>
                          <div className="font-mono text-xs font-semibold mb-1" style={{ color: PALETTE[idx % PALETTE.length] }}>{cid}</div>
                          <div className="text-xs text-text-muted space-y-0.5">
                            <div>Chemistry: <span className="text-text-secondary">{d.chemistry}</span></div>
                            <div>Cycles: <span className="font-mono text-text-secondary">{d.cycles.length}</span></div>
                            <div>Split: <span className="text-text-secondary">{d.split}</span></div>
                            <div>Max SOH: <span className="font-mono text-emerald-400">{Math.max(...(d.soh_pct.filter(v => v != null) as number[])).toFixed(1)}%</span></div>
                            <div>Min SOH: <span className="font-mono text-red-400">{Math.min(...(d.soh_pct.filter(v => v != null) as number[])).toFixed(1)}%</span></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <div className="panel p-12 text-center text-text-muted">Select cells and click Refresh</div>
              )}
            </div>
          </div>
        )}

        {/* ── CORRELATION MATRIX ────────────────────────────────────────────── */}
        {tab === 'corr' && (
          <div className="space-y-5">
            {loadingCorr ? <SkeletonChart height={500} /> : corrData ? (
              <>
                <div className="panel p-5">
                  <div className="flex items-center justify-between mb-4">
                    <div>
                      <h3 className="section-title">Spearman Correlation Matrix</h3>
                      <p className="text-xs text-text-muted mt-0.5">Features × RUL · Sampled from {corrData.n_samples} cells · Red = positive, Blue = negative</p>
                    </div>
                    <ExportCSV
                      data={corrData.features.map((f, i) => {
                        const row: Record<string, unknown> = { feature: f }
                        corrData.features.forEach((f2, j) => { row[f2] = corrData.matrix[i][j] })
                        return row
                      })}
                      filename="feature_correlation_matrix.csv"
                    />
                  </div>
                  <Plot
                    data={[{
                      type: 'heatmap',
                      z: corrData.matrix,
                      x: corrData.features,
                      y: corrData.features,
                      colorscale: [
                        [0, '#1e3a5f'], [0.25, '#1d4ed8'], [0.5, '#111827'],
                        [0.75, '#7f1d1d'], [1, '#dc2626'],
                      ],
                      zmin: -1, zmax: 1,
                      showscale: true,
                      colorbar: { tickfont: { color: '#64748b', size: 9 }, thickness: 14 },
                      text: corrData.matrix.map(row => row.map(v => v.toFixed(2)).join('|')),
                      textfont: { size: 9, color: '#94a3b8' },
                    }]}
                    layout={{ ...darkLayout, height: 500,
                      margin: { t: 20, b: 100, l: 100, r: 60 },
                      xaxis: { ...darkLayout.xaxis as object, tickangle: -45, tickfont: { color: '#64748b', size: 9 } },
                      yaxis: { ...darkLayout.yaxis as object, tickfont: { color: '#64748b', size: 9 } },
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                </div>

                {/* Top correlations with RUL */}
                {corrData.features.includes('RUL') && (
                  <div className="panel p-5">
                    <h3 className="section-title mb-3">Feature → RUL Spearman |r|</h3>
                    <Plot
                      data={[(() => {
                        const rulIdx = corrData.features.indexOf('RUL')
                        const pairs = corrData.features
                          .map((f, i) => ({ f, r: Math.abs(corrData.matrix[i][rulIdx]) }))
                          .filter(p => p.f !== 'RUL')
                          .sort((a, b) => b.r - a.r)
                        return {
                          type: 'bar' as const, orientation: 'h' as const,
                          x: pairs.map(p => p.r), y: pairs.map(p => p.f),
                          marker: { color: pairs.map(p => p.r > 0.7 ? '#ef4444' : p.r > 0.5 ? '#f59e0b' : '#3b82f6'), opacity: 0.85 },
                          text: pairs.map(p => p.r.toFixed(3)), textposition: 'outside' as const,
                          textfont: { size: 10, color: '#94a3b8' },
                        }
                      })()]}
                      layout={{ ...darkLayout, height: 320,
                        margin: { t: 10, b: 40, l: 100, r: 70 },
                        xaxis: { ...darkLayout.xaxis as object, range: [0, 1.1], title: { text: '|Spearman r| with RUL', font: { color: '#64748b' } } },
                      } as Plotly.Layout}
                      config={plotConfig} style={{ width: '100%' }}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="panel p-12 text-center">
                <button onClick={fetchCorr} className="btn-primary flex items-center gap-2 mx-auto">
                  <RefreshCw size={15} /> Compute Correlation Matrix
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── REAL SHAP FIGURES ──────────────────────────────────────────────── */}
        {tab === 'shap' && (
          <div className="space-y-5">
            <div className="flex gap-2 flex-wrap">
              {REAL_SHAP_FIGURES.map(f => (
                <button key={f.key} onClick={() => setShapFig(f.key)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${shapFig === f.key ? 'border-brand-blue text-brand-blue bg-brand-blue/10' : 'border-border-subtle text-text-muted hover:text-text-primary'}`}>
                  {f.title.replace('SHAP ', '')}
                </button>
              ))}
            </div>

            {REAL_SHAP_FIGURES.filter(f => f.key === shapFig).map(fig => (
              <div key={fig.key} className="panel p-5">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="section-title">{fig.title}</h3>
                    <p className="text-xs text-text-muted mt-0.5">{fig.desc}</p>
                  </div>
                  <a href={`/api/shap-figure/${fig.key}`} download={`${fig.key}.png`}
                    className="btn-ghost text-xs flex items-center gap-1.5 ml-4 flex-shrink-0">
                    ↓ Download PNG
                  </a>
                </div>
                <div className="bg-bg-primary rounded-lg overflow-hidden border border-border-subtle">
                  <img
                    src={`/api/shap-figure/${fig.key}?t=${Date.now()}`}
                    alt={fig.title}
                    className="w-full object-contain max-h-[600px]"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                  />
                </div>
                <p className="text-xs text-text-muted mt-2">
                  Source: <code className="font-mono">thesis_results/figures/{fig.key}.png</code>
                </p>
              </div>
            ))}

            {/* Additional thesis figures */}
            <div className="grid grid-cols-2 gap-4">
              {[
                { key: 'rmse_ladder', title: 'RMSE Ladder (v1→v10)' },
                { key: 'oxford_progression', title: 'Oxford ZS Progression' },
                { key: 'chemistry_radar', title: 'Chemistry Radar' },
                { key: 'training_composition', title: 'Training Data Composition' },
              ].map(fig => (
                <div key={fig.key} className="panel p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-medium text-text-primary">{fig.title}</h4>
                    <a href={`/api/shap-figure/${fig.key}`} download className="text-xs text-text-muted hover:text-text-accent">↓</a>
                  </div>
                  <div className="bg-bg-primary rounded-lg overflow-hidden border border-border-subtle">
                    <img src={`/api/shap-figure/${fig.key}`} alt={fig.title}
                      className="w-full object-contain max-h-60"
                      onError={e => { (e.target as HTMLImageElement).parentElement!.innerHTML = '<div class="p-8 text-center text-xs text-gray-600">Figure not found</div>' }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}

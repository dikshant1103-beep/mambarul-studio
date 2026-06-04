import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { TrendingUp } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart, Skeleton } from '../components/ui/Skeleton'
import { ExportCSV } from '../components/ui/ExportButton'

interface CellData {
  cell_id: string; chemistry: string; dataset: string; n_cycles: number
  cycles: number[]; capacity: number[]; soh_pct: number[]
  rul_true: number[]; rul_predicted: number[]
  published_rmse: number; published_r2: number; rmse_pct: number | null
  chemistry_color: string
}

interface FeatureSensitivityEntry {
  name: string
  rmse_without: number
  delta_rmse: number
  importance_rank: number
}

interface FeatureSensitivity {
  features: FeatureSensitivityEntry[]
  baseline_rmse: number
}

const CHEM_COLORS: Record<string, string> = {
  LCO:'#3b82f6', LFP:'#10b981', NMC:'#f59e0b', NCM:'#8b5cf6', NCA:'#ef4444'
}

export default function PerCellPredictions() {
  const [data, setData] = useState<Record<string, CellData> | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedCell, setSelectedCell] = useState<string | null>(null)
  const [chemFilter, setChemFilter] = useState<string>('All')
  const [viewMode, setViewMode] = useState<'rul'|'capacity'|'scatter'>('rul')
  const [sensitivity, setSensitivity] = useState<FeatureSensitivity | null>(null)

  useEffect(() => {
    const cellFetch = fetch('/api/per-cell-predictions')
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (d?.cells) {
          setData(d.cells)
          const first = Object.keys(d.cells)[0]
          if (first) setSelectedCell(first)
        }
      })
      .catch(() => {})

    const sensitivityFetch = fetch('/api/feature-sensitivity')
      .then(r => r.ok ? r.json() : null)
      .then((d: FeatureSensitivity | null) => {
        if (d?.features) setSensitivity(d)
      })
      .catch(() => {})

    Promise.all([cellFetch, sensitivityFetch]).finally(() => setLoading(false))
  }, [])

  const cells = data ? Object.values(data) : []
  const filtered = chemFilter === 'All' ? cells : cells.filter(c => c.chemistry === chemFilter || c.dataset.includes(chemFilter))
  const chems = ['All', ...new Set(cells.map(c => c.chemistry))]

  const cell = selectedCell && data ? data[selectedCell] : null

  const exportRows = cells.map(c => ({
    cell_id: c.cell_id, chemistry: c.chemistry, n_cycles: c.n_cycles,
    published_rmse: c.published_rmse, published_r2: c.published_r2, rmse_pct: c.rmse_pct,
  }))

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <TrendingUp size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Per-Cell Predictions — All Test Cells</h1>
        </div>
        <p className="text-text-secondary">Predicted vs actual RUL for all 17 test cells across 5 chemistries — LCO, LFP, NMC, NCM, Oxford-NMC</p>
      </div>

      <div className="flex gap-5">
        {/* Cell list */}
        <div className="w-60 flex-shrink-0 space-y-3">
          <div className="panel p-3">
            <div className="metric-label mb-2">Chemistry</div>
            <div className="flex flex-wrap gap-1">
              {chems.map(c => (
                <button key={c} onClick={() => setChemFilter(c)}
                  className="px-2 py-0.5 rounded text-xs font-medium transition-all"
                  style={chemFilter === c
                    ? { backgroundColor: CHEM_COLORS[c] ?? '#3b82f6', color: '#fff' }
                    : { backgroundColor: '#111827', color: '#64748b', border: '1px solid #1e3a5f' }}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="space-y-1">{[1,2,3,4,5].map(i=><Skeleton key={i} className="h-14 w-full"/>)}</div>
          ) : (
            <div className="panel p-3 max-h-[500px] overflow-y-auto">
              <div className="space-y-1">
                {filtered.map(c => {
                  const isSelected = selectedCell === c.cell_id
                  const r2color = c.published_r2 > 0.7 ? '#10b981' : c.published_r2 > 0.3 ? '#f59e0b' : '#ef4444'
                  return (
                    <button key={c.cell_id} onClick={() => setSelectedCell(c.cell_id)}
                      className="w-full text-left p-2.5 rounded-lg border transition-all"
                      style={isSelected ? { borderColor: (CHEM_COLORS[c.chemistry]??'#3b82f6')+'55', backgroundColor: (CHEM_COLORS[c.chemistry]??'#3b82f6')+'11' } : { borderColor: '#1e3a5f' }}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: CHEM_COLORS[c.chemistry] ?? '#94a3b8' }} />
                        <span className="font-mono text-xs text-text-accent truncate">{c.cell_id}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-text-muted">{c.chemistry}</span>
                        <span className="font-mono" style={{ color: r2color }}>R²={c.published_r2.toFixed(3)}</span>
                      </div>
                      <div className="flex justify-between text-xs mt-0.5">
                        <span className="text-text-muted">{c.n_cycles} cycles</span>
                        <span className="font-mono text-text-muted">RMSE={c.published_rmse}</span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {!loading && <ExportCSV data={exportRows} filename="per_cell_results.csv" label="Export All Results" />}
        </div>

        {/* Main chart area */}
        <div className="flex-1 space-y-4 min-w-0">
          {/* Summary metrics */}
          {!loading && cells.length > 0 && (
            <div className="grid grid-cols-4 gap-3">
              {[
                { label:'Total Test Cells', value:cells.length, color:'#3b82f6' },
                { label:'R²>0.7', value:cells.filter(c=>c.published_r2>0.7).length, color:'#10b981' },
                { label:'Best R²', value:Math.max(...cells.map(c=>c.published_r2)).toFixed(3), color:'#10b981' },
                { label:'Worst R²', value:Math.min(...cells.map(c=>c.published_r2)).toFixed(3), color:'#ef4444' },
              ].map(s => (
                <div key={s.label} className="panel p-3 text-center">
                  <div className="text-xl font-mono font-bold" style={{color:s.color}}>{s.value}</div>
                  <div className="text-xs text-text-muted">{s.label}</div>
                </div>
              ))}
            </div>
          )}

          {/* View mode tabs */}
          <div className="flex gap-1">
            {(['rul','capacity','scatter'] as const).map(m => (
              <button key={m} onClick={() => setViewMode(m)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all capitalize ${viewMode===m?'border-brand-blue text-brand-blue bg-brand-blue/10':'border-border-subtle text-text-muted'}`}>
                {m === 'rul' ? 'RUL Trajectory' : m === 'capacity' ? 'Capacity Fade' : 'Scatter Plot'}
              </button>
            ))}
          </div>

          {/* Selected cell detail */}
          {loading ? <SkeletonChart height={320} /> : cell ? (
            <motion.div key={selectedCell} initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} className="space-y-4">
              {/* Cell header */}
              <div className="panel p-4 flex items-center gap-6" style={{borderColor:(CHEM_COLORS[cell.chemistry]??'#94a3b8')+'44'}}>
                <div>
                  <div className="font-mono text-sm font-bold" style={{color:CHEM_COLORS[cell.chemistry]??'#94a3b8'}}>{cell.cell_id}</div>
                  <div className="text-xs text-text-muted">{cell.dataset} · {cell.chemistry}</div>
                </div>
                <div className="flex gap-5">
                  {[
                    {label:'RMSE', value:cell.published_rmse, unit:'cycles', color:'#3b82f6'},
                    {label:'R²',   value:cell.published_r2.toFixed(4), unit:'', color:cell.published_r2>0.7?'#10b981':cell.published_r2>0.3?'#f59e0b':'#ef4444'},
                    {label:'RMSE%',value:cell.rmse_pct ? `${cell.rmse_pct}%` : '—', unit:'', color:'#8b5cf6'},
                    {label:'Cycles',value:cell.n_cycles, unit:'', color:'#94a3b8'},
                  ].map(m=>(
                    <div key={m.label}>
                      <div className="metric-label">{m.label}</div>
                      <div className="font-mono font-bold text-lg" style={{color:m.color}}>{m.value}{m.unit}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* RUL trajectory */}
              {viewMode === 'rul' && (
                <div className="panel p-5">
                  <h3 className="section-title mb-3">Predicted vs True RUL — {cell.cell_id}</h3>
                  <Plot
                    data={[
                      { type:'scatter', mode:'lines', name:'True RUL', x:cell.cycles, y:cell.rul_true, line:{color:'#f1f5f9',width:2.5,dash:'dot'} },
                      { type:'scatter', mode:'lines', name:'Predicted RUL (v10-final)', x:cell.cycles, y:cell.rul_predicted, line:{color:CHEM_COLORS[cell.chemistry]??'#3b82f6',width:2} },
                    ]}
                    layout={{...darkLayout,height:280,
                      xaxis:{...darkLayout.xaxis as object,title:{text:'Cycle',font:{color:'#64748b'}}},
                      yaxis:{...darkLayout.yaxis as object,title:{text:'RUL (cycles)',font:{color:'#64748b'}}},
                      annotations:[{x:cell.cycles[cell.cycles.length-1],y:0,text:`RMSE=${cell.published_rmse}`,font:{color:CHEM_COLORS[cell.chemistry]??'#3b82f6',size:10},showarrow:false}],
                    } as Plotly.Layout}
                    config={plotConfig} style={{width:'100%'}}
                  />
                </div>
              )}

              {/* Capacity fade */}
              {viewMode === 'capacity' && (
                <div className="panel p-5">
                  <h3 className="section-title mb-3">Capacity Fade — {cell.cell_id}</h3>
                  <Plot
                    data={[
                      { type:'scatter', mode:'lines', name:'Capacity (Ah)', x:cell.cycles, y:cell.capacity, line:{color:CHEM_COLORS[cell.chemistry]??'#3b82f6',width:2.5}, yaxis:'y' },
                      { type:'scatter', mode:'lines', name:'SOH (%)', x:cell.cycles, y:cell.soh_pct, line:{color:'#10b981',width:1.5,dash:'dash'}, yaxis:'y2' },
                    ]}
                    layout={{...darkLayout,height:280,
                      xaxis:{...darkLayout.xaxis as object,title:{text:'Cycle',font:{color:'#64748b'}}},
                      yaxis:{...darkLayout.yaxis as object,title:{text:'Capacity (Ah)',font:{color:CHEM_COLORS[cell.chemistry]??'#3b82f6'}}},
                      yaxis2:{title:{text:'SOH (%)',font:{color:'#10b981'}},overlaying:'y',side:'right',gridcolor:'transparent',zerolinecolor:'#1e3a5f',tickfont:{color:'#64748b',size:10}},
                    } as Plotly.Layout}
                    config={plotConfig} style={{width:'100%'}}
                  />
                </div>
              )}

              {/* Scatter */}
              {viewMode === 'scatter' && (
                <div className="panel p-5">
                  <h3 className="section-title mb-3">Scatter: Predicted vs True RUL</h3>
                  <Plot
                    data={[
                      { type:'scatter', mode:'lines', name:'Perfect', x:[0,cell.rul_true[0]||400], y:[0,cell.rul_true[0]||400], line:{color:'#1e3a5f',dash:'dash',width:1.5} },
                      { type:'scatter', mode:'markers', name:cell.cell_id,
                        x:cell.rul_true, y:cell.rul_predicted,
                        marker:{color:CHEM_COLORS[cell.chemistry]??'#3b82f6',size:4,opacity:0.6} },
                    ]}
                    layout={{...darkLayout,height:280,
                      xaxis:{...darkLayout.xaxis as object,title:{text:'True RUL',font:{color:'#64748b'}}},
                      yaxis:{...darkLayout.yaxis as object,title:{text:'Predicted RUL',font:{color:'#64748b'}}},
                    } as Plotly.Layout}
                    config={plotConfig} style={{width:'100%'}}
                  />
                </div>
              )}
            </motion.div>
          ) : null}

          {/* All cells R² heatmap */}
          {!loading && cells.length > 0 && (
            <div className="panel p-5">
              <h3 className="section-title mb-3">All Test Cells — R² Overview</h3>
              <Plot
                data={[{
                  type:'bar', orientation:'h',
                  x:filtered.map(c=>c.published_r2),
                  y:filtered.map(c=>c.cell_id),
                  marker:{color:filtered.map(c=>c.published_r2>0.7?'#10b981':c.published_r2>0.3?'#f59e0b':'#ef4444'),opacity:0.85},
                  text:filtered.map(c=>c.published_r2.toFixed(3)), textposition:'outside',
                }]}
                layout={{...darkLayout,height:Math.max(200, filtered.length*28+60),
                  margin:{t:10,b:40,l:200,r:70},
                  xaxis:{...darkLayout.xaxis as object,range:[-1.2,1.3],zeroline:true,zerolinecolor:'#475569',title:{text:'R²',font:{color:'#64748b'}}},
                  shapes:[{type:'line',x0:0.7,x1:0.7,y0:-0.5,y1:filtered.length-0.5,line:{color:'#10b981',dash:'dot',width:1.5}}],
                } as Plotly.Layout}
                config={plotConfig} style={{width:'100%'}}
              />
            </div>
          )}

          {/* Feature Importance (Ablation) */}
          {!loading && sensitivity && (() => {
            const sorted = [...sensitivity.features].sort((a, b) => b.delta_rmse - a.delta_rmse)
            const barColors = sorted.map((_, i) => i < 3 ? '#10b981' : '#3b82f6')
            const chartHeight = Math.max(240, sorted.length * 32 + 80)
            return (
              <div className="panel p-5">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="section-title mb-0">Feature Importance (Ablation)</h3>
                  <div className="flex items-center gap-2 text-xs text-text-muted">
                    <span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" /> Top 3
                    <span className="w-2 h-2 rounded-full bg-blue-500 inline-block ml-2" /> Rest
                  </div>
                </div>
                <p className="text-xs text-text-muted mb-4">
                  RMSE when each feature is removed from the model. Larger delta = higher importance.
                  Baseline RMSE (all features): <span className="font-mono text-text-secondary">{sensitivity.baseline_rmse.toFixed(1)}</span>
                </p>
                <Plot
                  data={[{
                    type: 'bar',
                    orientation: 'h',
                    x: sorted.map(f => f.rmse_without),
                    y: sorted.map(f => f.name),
                    text: sorted.map(f =>
                      `${f.name} — RMSE if removed: ${f.rmse_without.toFixed(1)} (+${f.delta_rmse.toFixed(1)})`
                    ),
                    textposition: 'outside' as const,
                    textfont: { color: '#94a3b8', size: 10 },
                    hovertemplate: '<b>%{y}</b><br>RMSE without: %{x:.1f}<extra></extra>',
                    marker: { color: barColors, opacity: 0.85 },
                  }]}
                  layout={{
                    ...darkLayout,
                    height: chartHeight,
                    margin: { t: 10, b: 50, l: 120, r: 200 },
                    xaxis: {
                      ...darkLayout.xaxis as object,
                      title: { text: 'RMSE without feature (cycles)', font: { color: '#64748b' } },
                    },
                    yaxis: {
                      ...darkLayout.yaxis as object,
                      autorange: 'reversed' as const,
                    },
                    shapes: [{
                      type: 'line' as const,
                      x0: sensitivity.baseline_rmse, x1: sensitivity.baseline_rmse,
                      y0: -0.5, y1: sorted.length - 0.5,
                      line: { color: '#f59e0b', dash: 'dot', width: 2 },
                    }],
                    annotations: [{
                      x: sensitivity.baseline_rmse,
                      y: -0.5,
                      text: `Baseline ${sensitivity.baseline_rmse.toFixed(1)}`,
                      font: { color: '#f59e0b', size: 10 },
                      showarrow: false,
                      yanchor: 'top' as const,
                      xanchor: 'left' as const,
                    }],
                  } as Plotly.Layout}
                  config={plotConfig}
                  style={{ width: '100%' }}
                />
                {/* Ranked list with labels */}
                <div className="mt-4 space-y-1">
                  {sorted.map((f, i) => {
                    const col = i < 3 ? '#10b981' : '#3b82f6'
                    return (
                      <div key={f.name} className="flex items-center gap-3 py-1.5 px-3 rounded-lg bg-bg-elevated border border-border-subtle">
                        <span className="font-mono text-xs text-text-muted w-5 text-right">#{f.importance_rank}</span>
                        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: col }} />
                        <span className="font-mono text-xs font-semibold flex-1" style={{ color: col }}>{f.name}</span>
                        <span className="text-xs text-text-secondary font-mono">
                          RMSE if removed: <span className="text-text-accent">{f.rmse_without.toFixed(1)}</span>
                          <span className="text-emerald-400 ml-1">(+{f.delta_rmse.toFixed(1)})</span>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </div>
      </div>
    </div>
  )
}

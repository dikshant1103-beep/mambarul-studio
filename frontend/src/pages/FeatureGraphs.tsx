import { useState, useEffect, useCallback } from 'react'
import { motion } from 'framer-motion'
import { TrendingDown, RefreshCw, BarChart2, Info } from 'lucide-react'
import Plot from 'react-plotly.js'

// ── Types ────────────────────────────────────────────────────────────────────
interface CellInfo { cell_id: string; dataset: string; chemistry: string; chemistry_code: number; split: string; n_cycles: number }
interface Cell42 { cell_id: string; chemistry: string; n_cycles: number; cycles: number[]; rul: number[]; features: Record<string, number[]> }

// ── Feature metadata: formula + description ──────────────────────────────────
const FEAT_META: Record<string, { formula: string; desc: string; unit: string; category: string; group: string }> = {
  capacity_Ah:         { formula: 'Q = ∫I·dt', desc: 'Discharge capacity per cycle', unit: 'Ah', category: 'raw', group: 'Capacity' },
  cc_charge_time_s:    { formula: 't = t_CC + t_CV', desc: 'Total charge time (CC + CV phase)', unit: 's', category: 'raw', group: 'Charge' },
  voltage_mean_V:      { formula: 'V̄ = (1/n)·Σ Vᵢ', desc: 'Mean discharge voltage', unit: 'V', category: 'raw', group: 'Voltage' },
  voltage_end_V:       { formula: 'V_end = V(t=T)', desc: 'Terminal discharge voltage at cutoff', unit: 'V', category: 'raw', group: 'Voltage' },
  energy_Wh:           { formula: 'E = ∫V·I·dt', desc: 'Discharge energy per cycle', unit: 'Wh', category: 'raw', group: 'Energy' },
  temperature_C:       { formula: 'T_cell', desc: 'Cell temperature during discharge', unit: '°C', category: 'raw', group: 'Thermal' },
  discharge_slope:     { formula: 'dQ/dt ≈ ΔQ/Δcycle', desc: 'Rolling 5-cycle capacity slope', unit: 'Ah/cyc', category: 'raw', group: 'Slope' },
  ir_proxy_Ohm:        { formula: 'R = ΔV/ΔI', desc: 'Internal resistance from pulse test', unit: 'Ω', category: 'raw', group: 'Resistance' },
  soh_cap_pct:         { formula: 'SOH = Q_i / Q_0', desc: 'State of Health — capacity normalized by initial', unit: '%', category: 'derived', group: 'SOH' },
  delta_cap:           { formula: 'ΔQ = Q_i − Q_{i-1}', desc: 'Cycle-to-cycle capacity change', unit: 'Ah', category: 'derived', group: 'Capacity' },
  cum_energy_norm:     { formula: 'E_cum_norm = Σ Eᵢ / Σ_total', desc: 'Normalized cumulative energy (LEAKY!)', unit: 'norm.', category: 'derived', group: 'Energy', },
  cap_roll_std_5:      { formula: 'σ_5(Q)', desc: 'Rolling 5-cycle std of capacity', unit: 'Ah', category: 'derived', group: 'Rolling' },
  cap_mean_5:          { formula: 'μ_5(Q)', desc: 'Rolling 5-cycle mean capacity', unit: 'Ah', category: 'rolling', group: 'Rolling' },
  cap_min_5:           { formula: 'min_5(Q)', desc: 'Rolling 5-cycle minimum capacity', unit: 'Ah', category: 'rolling', group: 'Rolling' },
  cap_max_5:           { formula: 'max_5(Q)', desc: 'Rolling 5-cycle maximum capacity', unit: 'Ah', category: 'rolling', group: 'Rolling' },
  cap_range_5:         { formula: 'max_5(Q) − min_5(Q)', desc: 'Rolling 5-cycle capacity range', unit: 'Ah', category: 'rolling', group: 'Rolling' },
  vm_std_5:            { formula: 'σ_5(V̄)', desc: 'Rolling 5-cycle std of mean voltage', unit: 'V', category: 'rolling', group: 'Voltage' },
  vm_slope_5:          { formula: 'dV̄/di (5-cyc fit)', desc: 'Rolling 5-cycle slope of mean voltage', unit: 'V/cyc', category: 'rolling', group: 'Voltage' },
  ve_std_5:            { formula: 'σ_5(V_end)', desc: 'Rolling 5-cycle std of end voltage', unit: 'V', category: 'rolling', group: 'Voltage' },
  ve_slope_5:          { formula: 'dV_end/di (5-cyc)', desc: 'Rolling slope of terminal voltage', unit: 'V/cyc', category: 'rolling', group: 'Voltage' },
  energy_mean_5:       { formula: 'μ_5(E)', desc: 'Rolling 5-cycle mean energy', unit: 'Wh', category: 'rolling', group: 'Energy' },
  energy_std_5:        { formula: 'σ_5(E)', desc: 'Rolling 5-cycle std of energy', unit: 'Wh', category: 'rolling', group: 'Energy' },
  energy_slope_5:      { formula: 'dE/di (5-cyc)', desc: 'Rolling slope of discharge energy', unit: 'Wh/cyc', category: 'rolling', group: 'Energy' },
  temp_mean_5:         { formula: 'μ_5(T)', desc: 'Rolling 5-cycle mean temperature', unit: '°C', category: 'rolling', group: 'Thermal' },
  temp_max_5:          { formula: 'max_5(T)', desc: 'Rolling 5-cycle max temperature', unit: '°C', category: 'rolling', group: 'Thermal' },
  temp_std_5:          { formula: 'σ_5(T)', desc: 'Rolling 5-cycle std of temperature', unit: '°C', category: 'rolling', group: 'Thermal' },
  ir_mean_5:           { formula: 'μ_5(R)', desc: 'Rolling 5-cycle mean resistance', unit: 'Ω', category: 'rolling', group: 'Resistance' },
  soh_slope_5:         { formula: 'd(SOH)/di (5-cyc fit)', desc: 'Rolling SOH fade rate', unit: '%/cyc', category: 'physics', group: 'SOH' },
  soh_curvature:       { formula: 'd²(SOH)/di²', desc: 'SOH curvature — detects knee point', unit: '%/cyc²', category: 'physics', group: 'SOH' },
  c_rate_charge:       { formula: 'C = Q_Ah / t_h', desc: 'Effective C-rate during charge', unit: 'C', category: 'physics', group: 'Charge' },
  voltage_range:       { formula: 'ΔV = V̄ − V_end', desc: 'Discharge voltage window width', unit: 'V', category: 'physics', group: 'Voltage' },
  ir_slope_5:          { formula: 'dR/di (5-cyc fit)', desc: 'Internal resistance growth rate', unit: 'Ω/cyc', category: 'physics', group: 'Resistance' },
  charge_time_slope_5: { formula: 'd(t_ch)/di (5-cyc)', desc: 'Rate of charge time increase', unit: 's/cyc', category: 'physics', group: 'Charge' },
  energy_efficiency:   { formula: 'η = E / (Q · V̄)', desc: 'Energy efficiency per cycle', unit: 'norm.', category: 'physics', group: 'Energy' },
  cum_capacity_Ah:     { formula: 'Q_cum = Σᵢ Q_i', desc: 'Cumulative Ah throughput', unit: 'Ah', category: 'physics', group: 'Capacity' },
  cycle_norm:          { formula: 'i_norm = i / (N-1)', desc: 'Normalized cycle index [0,1]', unit: 'norm.', category: 'physics', group: 'Index' },
  dqdv_proxy:          { formula: 'dQ/dV ≈ dQ/di ÷ dV/di', desc: 'ICA proxy (dQ/dV from cycle data)', unit: 'Ah/V', category: 'ica', group: 'ICA/DVA' },
  dvdq_proxy:          { formula: 'dV/dQ ≈ dV/di ÷ dQ/di', desc: 'DVA proxy (dV/dQ from cycle data)', unit: 'V/Ah', category: 'ica', group: 'ICA/DVA' },
  ce_efficiency:       { formula: 'CE = E / μ_5(E)', desc: 'Coulombic efficiency relative to rolling mean', unit: 'ratio', category: 'physics', group: 'Energy' },
  fade_rate_5:         { formula: 'd(SOH)/di (10-cyc)', desc: 'Long-window SOH fade rate', unit: '%/cyc', category: 'physics', group: 'SOH' },
  capacity_retention:  { formula: 'Q_i / Q_0', desc: 'Capacity retention (= SOH)', unit: '%', category: 'derived', group: 'Capacity' },
  cum_energy_raw_Wh:   { formula: 'E_cum = Σᵢ E_i', desc: 'Raw cumulative energy (LEAKY)', unit: 'Wh', category: 'derived', group: 'Energy' },
  cycle_index:         { formula: 'i', desc: 'Absolute cycle number', unit: 'cycles', category: 'raw', group: 'Index' },
}

const CHEM_COLORS: Record<string, string> = { LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#ef4444' }
const CAT_COLORS: Record<string, string> = { raw: '#3b82f6', derived: '#8b5cf6', rolling: '#06b6d4', physics: '#10b981', ica: '#f59e0b' }
const GROUPS = ['Capacity', 'SOH', 'Voltage', 'Energy', 'Charge', 'Resistance', 'Thermal', 'Slope', 'Rolling', 'ICA/DVA', 'Physics', 'Index']

const darkLayout: Partial<Plotly.Layout> = {
  paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
  font: { color: '#94a3b8', size: 11 },
  legend: { font: { color: '#94a3b8', size: 10 }, bgcolor: 'transparent' },
  margin: { t: 20, b: 50, l: 60, r: 20 },
}

export default function FeatureGraphs() {
  const [cells, setCells] = useState<CellInfo[]>([])
  const [selectedCell, setSelectedCell] = useState<string>('CS2_37')
  const [chemFilter, setChemFilter] = useState<string>('LCO')
  const [cellData, setCellData] = useState<Cell42 | null>(null)
  const [loading, setLoading] = useState(false)
  const [selectedFeats, setSelectedFeats] = useState<string[]>(['capacity_Ah', 'soh_cap_pct', 'dqdv_proxy'])
  const [activeGroup, setActiveGroup] = useState('Capacity')
  const [showICA, setShowICA] = useState(false)
  const [icaData, setIcaData] = useState<Record<string, number[]> | null>(null)

  useEffect(() => {
    fetch('/api/cells').then(r => r.ok ? r.json() : []).then(setCells).catch(() => {})
  }, [])

  const loadCell = useCallback(async (cid: string) => {
    setLoading(true)
    try {
      const d = await fetch(`/api/cells/${cid}/features42`).then(r => r.json())
      setCellData(d)
    } catch { /* no-op */ }
    setLoading(false)
  }, [])

  useEffect(() => { loadCell(selectedCell) }, [selectedCell, loadCell])

  const loadICA = async () => {
    const d = await fetch(`/api/cells/${selectedCell}/ica-dva`).then(r => r.json()).catch(() => null)
    if (d) setIcaData(d)
    setShowICA(true)
  }

  const filteredCells = cells.filter(c => !chemFilter || c.chemistry === chemFilter)
  const featKeys = Object.keys(FEAT_META)
  const groupedFeats = GROUPS.reduce<Record<string, string[]>>((acc, g) => {
    acc[g] = featKeys.filter(k => FEAT_META[k]?.group === g)
    return acc
  }, {})

  const toggleFeat = (k: string) => {
    setSelectedFeats(prev =>
      prev.includes(k) ? prev.filter(x => x !== k) : [...prev.slice(-2), k]
    )
  }

  const makeTrace = (feat: string, i: number): Partial<Plotly.PlotData> | null => {
    if (!cellData?.features[feat]) return null
    const meta = FEAT_META[feat]
    const color = CAT_COLORS[meta?.category ?? 'raw'] ?? '#3b82f6'
    const isLeaky = feat.includes('cum_energy') || feat.includes('raw_Wh')
    return {
      type: 'scatter', mode: 'lines',
      name: `${feat}${meta?.unit ? ` (${meta.unit})` : ''}`,
      x: cellData.cycles,
      y: cellData.features[feat],
      line: { color: isLeaky ? '#ef4444' : color, width: 1.8, dash: isLeaky ? 'dot' : 'solid' },
      yaxis: i > 0 ? 'y2' : 'y',
    }
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <BarChart2 size={22} className="text-brand-cyan" />
          <h1 className="text-2xl font-bold text-text-primary">Feature Graphs — All 42 Features</h1>
        </div>
        <p className="text-text-secondary">Real time-series from processed dataset · ICA/DVA curves · dQ/dV · All physics features per cell</p>
      </div>

      <div className="flex gap-5">
        {/* Left: cell + feature selection */}
        <div className="w-64 flex-shrink-0 space-y-4">
          {/* Cell selector */}
          <div className="panel p-4">
            <div className="metric-label mb-2">Chemistry Filter</div>
            <div className="flex flex-wrap gap-1 mb-3">
              {['LCO', 'LFP', 'NMC', 'NCM', 'NCA'].map(c => (
                <button key={c} onClick={() => setChemFilter(c === chemFilter ? '' : c)}
                  className={`px-2 py-1 rounded text-xs font-medium transition-all ${chemFilter === c ? 'text-white' : 'bg-bg-elevated text-text-muted border border-border-subtle'}`}
                  style={chemFilter === c ? { backgroundColor: CHEM_COLORS[c] } : {}}>
                  {c}
                </button>
              ))}
            </div>
            <div className="metric-label mb-1">Cell</div>
            <div className="max-h-48 overflow-y-auto space-y-0.5">
              {filteredCells.slice(0, 40).map(c => (
                <button key={c.cell_id} onClick={() => setSelectedCell(c.cell_id)}
                  className={`w-full text-left px-2 py-1.5 rounded text-xs transition-all ${selectedCell === c.cell_id ? 'bg-brand-blue/20 text-brand-blue' : 'text-text-secondary hover:bg-bg-elevated'}`}>
                  <div className="font-mono truncate">{c.cell_id}</div>
                  <div className="text-text-muted">{c.n_cycles} cycles · {c.split}</div>
                </button>
              ))}
              {filteredCells.length === 0 && <div className="text-xs text-text-muted p-2">Loading cells…</div>}
            </div>
          </div>

          {/* Feature selector by group */}
          <div className="panel p-4">
            <div className="metric-label mb-2">Feature Group</div>
            <div className="flex flex-wrap gap-1 mb-3">
              {GROUPS.filter(g => (groupedFeats[g]?.length ?? 0) > 0).map(g => (
                <button key={g} onClick={() => setActiveGroup(g)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-all border ${activeGroup === g ? 'border-brand-blue text-brand-blue bg-brand-blue/10' : 'border-border-subtle text-text-muted'}`}>
                  {g}
                </button>
              ))}
            </div>
            <div className="metric-label mb-1">Select (max 3)</div>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {(groupedFeats[activeGroup] ?? []).map(k => {
                const m = FEAT_META[k]
                const isLeaky = k.includes('cum_energy') || k.includes('raw_Wh')
                return (
                  <label key={k} className="flex items-start gap-2 cursor-pointer group">
                    <input type="checkbox" checked={selectedFeats.includes(k)}
                      onChange={() => toggleFeat(k)} className="mt-0.5 accent-brand-blue" />
                    <div>
                      <div className={`text-xs font-mono ${isLeaky ? 'text-red-400' : 'text-text-primary'}`}>{k}{isLeaky ? ' ⚠' : ''}</div>
                      <div className="text-xs text-text-muted font-mono">{m?.formula}</div>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>

          {/* ICA button */}
          <button onClick={loadICA} className="btn-ghost w-full text-sm flex items-center justify-center gap-2">
            <TrendingDown size={14} /> View ICA/DVA Curves
          </button>
        </div>

        {/* Right: charts */}
        <div className="flex-1 space-y-4 min-w-0">
          {/* Cell info */}
          {cellData && (
            <div className="panel p-4 flex items-center gap-6">
              <div><div className="metric-label">Cell</div><div className="font-mono text-sm text-text-accent">{cellData.cell_id}</div></div>
              <div><div className="metric-label">Chemistry</div><div className="font-mono text-sm" style={{ color: CHEM_COLORS[cellData.chemistry] ?? '#94a3b8' }}>{cellData.chemistry}</div></div>
              <div><div className="metric-label">Cycles</div><div className="font-mono text-sm text-text-secondary">{cellData.n_cycles}</div></div>
              <div><div className="metric-label">Features</div><div className="font-mono text-sm text-text-secondary">{Object.keys(cellData.features).length}</div></div>
              {loading && <RefreshCw size={16} className="text-brand-blue animate-spin ml-auto" />}
            </div>
          )}

          {/* Feature time-series */}
          {selectedFeats.length > 0 && cellData && (
            <div className="panel p-5">
              <h3 className="section-title mb-1">Feature Time-Series vs Cycle</h3>
              <div className="flex gap-2 flex-wrap mb-3">
                {selectedFeats.map(f => {
                  const m = FEAT_META[f]
                  const color = CAT_COLORS[m?.category ?? 'raw']
                  return (
                    <div key={f} className="text-xs px-2 py-0.5 rounded border font-mono"
                      style={{ borderColor: color + '66', backgroundColor: color + '11', color }}>
                      {f}  <span className="text-text-muted">{m?.formula}</span>
                    </div>
                  )
                })}
              </div>
              <Plot
                data={selectedFeats.map((f, i) => makeTrace(f, i)).filter(Boolean) as Plotly.Data[]}
                layout={{
                  ...darkLayout,
                  height: 280,
                  xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } }, gridcolor: '#1e3a5f', zerolinecolor: '#1e3a5f' },
                  yaxis: { ...darkLayout.yaxis as object, title: { text: selectedFeats[0] ? `${selectedFeats[0]} (${FEAT_META[selectedFeats[0]]?.unit})` : 'Value', font: { color: '#64748b' } }, gridcolor: '#1e3a5f', zerolinecolor: '#1e3a5f' },
                  yaxis2: selectedFeats.length > 1 ? { title: { text: selectedFeats[1] ? `${selectedFeats[1]} (${FEAT_META[selectedFeats[1]]?.unit})` : '', font: { color: '#64748b' } }, overlaying: 'y', side: 'right', gridcolor: 'transparent', zerolinecolor: '#1e3a5f' } : undefined,
                } as Plotly.Layout}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%' }}
              />
            </div>
          )}

          {/* Capacity + SOH + RUL overview */}
          {cellData && (
            <div className="panel p-5">
              <h3 className="section-title mb-1">Capacity Fade + SOH + RUL — Overview</h3>
              <Plot
                data={[
                  { type: 'scatter', mode: 'lines', name: 'Capacity (Ah)', x: cellData.cycles, y: cellData.features.capacity_Ah, line: { color: '#3b82f6', width: 2 } },
                  { type: 'scatter', mode: 'lines', name: 'SOH (%)', x: cellData.cycles, y: cellData.features.soh_cap_pct?.map(v => v * 100), line: { color: '#10b981', width: 1.5, dash: 'dash' }, yaxis: 'y2' },
                  { type: 'scatter', mode: 'lines', name: 'RUL (cycles)', x: cellData.cycles, y: cellData.rul, line: { color: '#f59e0b', width: 1.5, dash: 'dot' }, yaxis: 'y3' },
                ]}
                layout={{
                  ...darkLayout,
                  height: 240,
                  xaxis: { gridcolor: '#1e3a5f', zerolinecolor: '#1e3a5f', title: { text: 'Cycle', font: { color: '#64748b' } } },
                  yaxis: { gridcolor: '#1e3a5f', title: { text: 'Capacity (Ah)', font: { color: '#3b82f6' } } },
                  yaxis2: { title: { text: 'SOH (%)', font: { color: '#10b981' } }, overlaying: 'y', side: 'right', gridcolor: 'transparent', zerolinecolor: '#1e3a5f' },
                  yaxis3: { title: { text: 'RUL', font: { color: '#f59e0b' } }, overlaying: 'y', side: 'right', anchor: 'free', position: 1, gridcolor: 'transparent', zerolinecolor: '#1e3a5f' },
                } as Plotly.Layout}
                config={{ displayModeBar: false, responsive: true }}
                style={{ width: '100%' }}
              />
            </div>
          )}

          {/* ICA / DVA */}
          {showICA && icaData && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="panel p-5">
              <h3 className="section-title mb-1">ICA/DVA Curves — {selectedCell}</h3>
              <p className="text-xs text-text-muted mb-3">dQ/dV (incremental capacity) and dV/dQ (differential voltage) proxy curves from cycle-level capacity data</p>
              <div className="grid grid-cols-2 gap-4">
                <Plot
                  data={[{
                    type: 'scatter', mode: 'lines', name: 'ICA: |dQ/dV|',
                    x: icaData.cycles ?? [], y: icaData.dqdv ?? [],
                    line: { color: '#3b82f6', width: 2 },
                  }]}
                  layout={{ ...darkLayout, height: 200, title: { text: 'ICA (|dQ/dV| proxy)', font: { color: '#94a3b8', size: 11 } }, xaxis: { gridcolor: '#1e3a5f', title: { text: 'Cycle', font: { color: '#64748b' } } }, yaxis: { gridcolor: '#1e3a5f', title: { text: '|dQ/dV| (Ah/V)', font: { color: '#64748b' } } } } as Plotly.Layout}
                  config={{ displayModeBar: false, responsive: true }} style={{ width: '100%' }}
                />
                <Plot
                  data={[{
                    type: 'scatter', mode: 'lines', name: 'DVA: |dV/dQ|',
                    x: icaData.cycles ?? [], y: icaData.dvdq ?? [],
                    line: { color: '#10b981', width: 2 },
                  }]}
                  layout={{ ...darkLayout, height: 200, title: { text: 'DVA (|dV/dQ| proxy)', font: { color: '#94a3b8', size: 11 } }, xaxis: { gridcolor: '#1e3a5f', title: { text: 'Cycle', font: { color: '#64748b' } } }, yaxis: { gridcolor: '#1e3a5f', title: { text: '|dV/dQ| (V/Ah)', font: { color: '#64748b' } } } } as Plotly.Layout}
                  config={{ displayModeBar: false, responsive: true }} style={{ width: '100%' }}
                />
              </div>
              <div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
                <Info size={12} />
                Proxy computed from cycle-aggregated data. For per-cycle ICA, raw voltage-capacity traces are required (CALCE XLSX).
              </div>
            </motion.div>
          )}

          {/* Feature formula reference */}
          {selectedFeats.length > 0 && (
            <div className="panel p-5">
              <h3 className="section-title mb-3">Selected Feature Formulas</h3>
              <div className="space-y-3">
                {selectedFeats.map(f => {
                  const m = FEAT_META[f]
                  if (!m) return null
                  const isLeaky = f.includes('cum_energy') || f.includes('raw_Wh')
                  return (
                    <div key={f} className={`rounded-lg p-3 border ${isLeaky ? 'border-red-500/30 bg-red-500/5' : 'border-border-subtle bg-bg-elevated'}`}>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-xs font-semibold font-mono ${isLeaky ? 'text-red-400' : 'text-text-accent'}`}>{f}</span>
                        <span className="text-xs text-text-muted">({m.unit})</span>
                        <span className={`badge text-xs ${m.category === 'raw' ? 'badge-blue' : m.category === 'derived' ? 'badge-purple' : m.category === 'ica' ? 'badge-amber' : 'badge-green'}`}>{m.category}</span>
                        {isLeaky && <span className="badge badge-red text-xs">LEAKY ⚠</span>}
                      </div>
                      <code className="block text-xs font-mono text-brand-cyan bg-bg-primary px-3 py-1.5 rounded border border-border-subtle mb-1">{m.formula}</code>
                      <p className="text-xs text-text-secondary">{m.desc}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

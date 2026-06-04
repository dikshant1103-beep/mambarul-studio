import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Atom, FlaskConical } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

interface ICCurve { cycle: number; voltage: number[]; dqdv: number[]; max_capacity: number }
interface ICData { cell_id: string; curves: ICCurve[]; n_curves: number }

const CHEMISTRIES = [
  {
    id: 'LCO', name: 'LCO', full: 'Lithium Cobalt Oxide', formula: 'LiCoO₂',
    color: '#3b82f6', anode: 'Graphite', cathode: 'LiCoO₂',
    voltage_nominal: 3.6, voltage_range: '3.0–4.2V',
    energy_density: '150–200 Wh/kg', cycle_life: '500–1000',
    ocv_delta: '~500 mV', safety: 'Moderate (Co thermal runaway risk)',
    datasets: ['CALCE CS2/CX2', 'NASA PCoE B0005-B0007'],
    rmse_pct: 7.1, r2: 0.910,
    degradation_modes: [
      'SEI layer growth on anode (capacity fade)',
      'Lithium plating at high C-rates',
      'Structural disorder in LiCoO₂ above 4.2V',
      'IR growth from electrolyte decomposition',
    ],
    voltage_points: [3.0, 3.3, 3.6, 3.8, 3.9, 4.0, 4.1, 4.2],
    soh_points: [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.98, 1.0],
    why_hard: 'Well-studied. Standard CC-CV cycling makes features predictable. MambaRUL achieves 7.1% RMSE%.',
    ic_note: 'dQ/dV peaks well-defined at ~3.85V and ~4.05V. Peaks diminish with cycle count — key IC feature.',
  },
  {
    id: 'LFP', name: 'LFP', full: 'Lithium Iron Phosphate', formula: 'LiFePO₄',
    color: '#10b981', anode: 'Graphite', cathode: 'LiFePO₄',
    voltage_nominal: 3.2, voltage_range: '2.5–3.65V',
    energy_density: '90–120 Wh/kg', cycle_life: '2000–5000',
    ocv_delta: '~50 mV (flat!)', safety: 'Excellent (thermally stable)',
    datasets: ['MIT 2017-2018 (fast-charge study)'],
    rmse_pct: 23.6, r2: 0.123,
    degradation_modes: [
      'Lithium plating (severe at fast charge rates)',
      'Calendar aging at high temperature',
      'Loss of active lithium from SEI growth',
      'Very small voltage variation during cycling → hard to detect',
    ],
    voltage_points: [2.5, 2.8, 3.0, 3.2, 3.3, 3.35, 3.4, 3.65],
    soh_points: [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.98, 1.0],
    why_hard: 'LFP has flat voltage plateau (ΔOCV≈50mV over 90% SoC range). Standard voltage-based features almost useless. Requires IC curve analysis. MambaRUL struggles: RMSE%=23.6%.',
    ic_note: 'Single sharp dQ/dV peak at ~3.3V from Fe²⁺/Fe³⁺ redox. Peak height and width track degradation. Essential for LFP RUL.',
  },
  {
    id: 'NMC', name: 'NMC', full: 'Lithium Nickel Manganese Cobalt', formula: 'LiNiₓMnᵧCoᵤO₂',
    color: '#f59e0b', anode: 'Graphite', cathode: 'NMC (811/622/111)',
    voltage_nominal: 3.7, voltage_range: '3.0–4.2V',
    energy_density: '150–220 Wh/kg', cycle_life: '1000–2000',
    ocv_delta: '~400 mV', safety: 'Good',
    datasets: ['KJTU (standard)', 'Oxford pouch cells', 'PyBaMM synthetic'],
    rmse_pct: 8.8, r2: 0.854,
    degradation_modes: [
      'Ni dissolution at high voltage (above 4.2V)',
      'Microcracks in cathode particle from volume change',
      'SEI growth and lithium plating at low temperature',
      'Loss of Mn to electrolyte',
    ],
    voltage_points: [3.0, 3.2, 3.5, 3.7, 3.9, 4.0, 4.1, 4.2],
    soh_points: [0.4, 0.55, 0.7, 0.82, 0.9, 0.95, 0.98, 1.0],
    why_hard: 'Good voltage variation. Oxford 8000-cycle cells show different degradation pattern from KJTU 500-cycle cells. MambaRUL handles well: RMSE%=8.8% KJTU, 5.2% Oxford.',
    ic_note: 'Multiple dQ/dV peaks from Ni²⁺→Ni³⁺→Ni⁴⁺ redox. Complex IC profile that shifts with composition ratio.',
  },
  {
    id: 'NCM', name: 'NCM', full: 'Nickel Cobalt Manganese (alt.)', formula: 'LiNiCoMnO₂',
    color: '#8b5cf6', anode: 'Graphite', cathode: 'NCM (same family as NMC)',
    voltage_nominal: 3.7, voltage_range: '2.7–4.2V',
    energy_density: '150–210 Wh/kg', cycle_life: '800–1500',
    ocv_delta: '~350 mV', safety: 'Moderate',
    datasets: ['TJU (25°C and 45°C variable temperature)'],
    rmse_pct: 12.3, r2: 0.660,
    degradation_modes: [
      'Temperature-accelerated capacity fade at 45°C',
      'Electrolyte oxidation at high voltage',
      'Mechanical stress from lattice expansion',
      'Cross-temperature transfer challenging',
    ],
    voltage_points: [2.7, 3.0, 3.3, 3.6, 3.8, 3.9, 4.1, 4.2],
    soh_points: [0.35, 0.5, 0.65, 0.78, 0.88, 0.93, 0.97, 1.0],
    why_hard: 'Variable temperature (25°C and 45°C) adds confound. Temperature sensitivity high. RMSE%=12.3% — moderate performance.',
    ic_note: 'Similar to NMC. Temperature shifts IC peak positions, making chemistry-temperature interaction complex.',
  },
]

function VoltageProfile({ chem }: { chem: typeof CHEMISTRIES[0] }) {
  const cycles = Array.from({ length: 50 }, (_, i) => i)
  const freshCap = cycles.map(c => chem.soh_points[7] - c * 0.003)
  const agedCap  = cycles.map(c => chem.soh_points[3] + c * 0.001)

  return (
    <Plot
      data={[
        { type: 'scatter', mode: 'lines', name: 'Fresh (100% SoH)',
          x: cycles, y: freshCap.map(s => chem.voltage_points[7] - (1 - s) * (chem.voltage_points[7] - chem.voltage_points[0]) * 0.3),
          line: { color: chem.color, width: 2.5 } },
        { type: 'scatter', mode: 'lines', name: 'Aged (70% SoH)',
          x: cycles, y: agedCap.map(s => chem.voltage_points[7] * 0.92 - (1 - s) * (chem.voltage_points[7] - chem.voltage_points[0]) * 0.35),
          line: { color: chem.color + '77', width: 2, dash: 'dash' } },
      ]}
      layout={{ ...darkLayout, height: 180,
        margin: { t: 10, b: 45, l: 50, r: 10 },
        xaxis: { ...darkLayout.xaxis as object, title: { text: 'Discharge progress', font: { color: '#64748b' } } },
        yaxis: { ...darkLayout.yaxis as object, title: { text: 'Voltage (V)', font: { color: '#64748b' } }, range: [2.4, 4.4] },
      } as Plotly.Layout}
      config={{ ...plotConfig, displayModeBar: false }} style={{ width: '100%' }}
    />
  )
}

function ICAProfile({ chem }: { chem: typeof CHEMISTRIES[0] }) {
  const v = Array.from({ length: 80 }, (_, i) => 2.5 + i * 0.025)
  const freshPeak = chem.id === 'LFP'
    ? v.map(x => Math.exp(-Math.pow((x - 3.3) / 0.04, 2)) * 2.1)
    : v.map(x => Math.exp(-Math.pow((x - 3.85) / 0.08, 2)) * 1.4 + Math.exp(-Math.pow((x - 4.05) / 0.06, 2)) * 0.9)
  const agedPeak = freshPeak.map(p => p * 0.6)

  return (
    <Plot
      data={[
        { type: 'scatter', mode: 'lines', name: 'Fresh', x: v, y: freshPeak, line: { color: chem.color, width: 2 } },
        { type: 'scatter', mode: 'lines', name: 'Aged (SOH=70%)', x: v, y: agedPeak, line: { color: chem.color + '77', width: 1.5, dash: 'dash' } },
      ]}
      layout={{ ...darkLayout, height: 180,
        margin: { t: 10, b: 45, l: 50, r: 10 },
        xaxis: { ...darkLayout.xaxis as object, title: { text: 'Voltage (V)', font: { color: '#64748b' } } },
        yaxis: { ...darkLayout.yaxis as object, title: { text: '|dQ/dV| (Ah/V)', font: { color: '#64748b' } } },
      } as Plotly.Layout}
      config={{ ...plotConfig, displayModeBar: false }} style={{ width: '100%' }}
    />
  )
}

const CALCE_CELL_MAP: Record<string, string> = { LCO: 'CS2_35' }
const IC_COLORS = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ef4444']

export default function ChemistryExplorer() {
  const [selected, setSelected] = useState(CHEMISTRIES[0])
  const [icData, setIcData] = useState<Record<string, ICData>>({})
  const [icLoading, setIcLoading] = useState(false)

  useEffect(() => {
    const calceCell = CALCE_CELL_MAP[selected.id]
    if (calceCell && !icData[calceCell]) {
      setIcLoading(true)
      fetch(`/api/calce/ic-curve?cell_id=${calceCell}&n_cycles=6`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d) setIcData(prev => ({ ...prev, [calceCell]: d })) })
        .catch(() => {})
        .finally(() => setIcLoading(false))
    }
  }, [selected.id])

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Atom size={22} className="text-brand-cyan" />
          <h1 className="text-2xl font-bold text-text-primary">Battery Chemistry Explorer</h1>
        </div>
        <p className="text-text-secondary">LCO · LFP · NMC · NCM — electrochemistry, degradation physics, and why each chemistry challenges RUL prediction differently</p>
      </div>

      {/* Chemistry selector */}
      <div className="flex gap-3 mb-6">
        {CHEMISTRIES.map(c => (
          <button key={c.id} onClick={() => setSelected(c)}
            className="flex-1 py-3 rounded-xl border-2 font-bold text-sm transition-all"
            style={selected.id === c.id
              ? { borderColor: c.color, backgroundColor: c.color + '18', color: c.color }
              : { borderColor: '#1e3a5f', color: '#64748b' }}>
            {c.id}
            <div className="text-xs font-normal mt-0.5">{c.formula}</div>
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div key={selected.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2 }} className="space-y-5">

          {/* Header */}
          <div className="panel p-5" style={{ borderColor: selected.color + '44' }}>
            <div className="flex items-start gap-5">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-black"
                style={{ backgroundColor: selected.color + '22', color: selected.color, border: `2px solid ${selected.color}55` }}>
                {selected.id}
              </div>
              <div className="flex-1">
                <h2 className="text-xl font-bold text-text-primary">{selected.full}</h2>
                <code className="text-sm text-text-muted font-mono">{selected.formula}</code>
                <div className="flex flex-wrap gap-3 mt-3">
                  {[
                    { label: 'Nominal V', value: selected.voltage_nominal + 'V' },
                    { label: 'Range', value: selected.voltage_range },
                    { label: 'Energy', value: selected.energy_density },
                    { label: 'Cycle Life', value: selected.cycle_life },
                    { label: 'ΔOCV', value: selected.ocv_delta },
                  ].map(s => (
                    <div key={s.label} className="bg-bg-elevated rounded-lg px-3 py-2">
                      <div className="text-xs text-text-muted">{s.label}</div>
                      <div className="text-sm font-mono font-semibold text-text-primary">{s.value}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-xs text-text-muted mb-1">MambaRUL Performance</div>
                <div className="text-3xl font-mono font-bold" style={{ color: selected.r2 > 0.8 ? '#10b981' : selected.r2 > 0.5 ? '#f59e0b' : '#ef4444' }}>
                  R²={selected.r2}
                </div>
                <div className="text-sm font-mono" style={{ color: selected.rmse_pct < 10 ? '#10b981' : selected.rmse_pct < 15 ? '#f59e0b' : '#ef4444' }}>
                  RMSE%={selected.rmse_pct}%
                </div>
              </div>
            </div>
          </div>

          {/* Discharge + ICA profiles */}
          <div className="grid grid-cols-2 gap-4">
            <div className="panel p-5">
              <h3 className="section-title mb-2">Discharge Voltage Profile</h3>
              <p className="text-xs text-text-muted mb-3">Fresh vs Aged cell. ΔOCV={selected.ocv_delta}</p>
              <VoltageProfile chem={selected} />
            </div>
            <div className="panel p-5">
              <h3 className="section-title mb-2">ICA: |dQ/dV| Curve</h3>
              <p className="text-xs text-text-muted mb-3">{selected.ic_note}</p>
              <ICAProfile chem={selected} />
            </div>
          </div>

          {/* Real IC Curves from CALCE XLSX */}
          {CALCE_CELL_MAP[selected.id] && (
            <div className="panel p-5">
              <div className="flex items-center gap-2 mb-1">
                <FlaskConical size={14} style={{ color: selected.color }} />
                <h3 className="section-title">Real dQ/dV — CALCE {CALCE_CELL_MAP[selected.id]} (from raw XLSX)</h3>
                <span className="ml-1 text-xs font-mono" style={{ color: selected.color }}>actual measurements</span>
              </div>
              <p className="text-xs text-text-muted mb-4">
                IC curves extracted directly from CALCE cycler XLSX files. Each line = one discharge cycle. Peak height reduction tracks degradation.
              </p>
              {icLoading ? (
                <div className="h-52 flex items-center justify-center text-text-muted text-sm">Loading real XLSX data…</div>
              ) : icData[CALCE_CELL_MAP[selected.id]] ? (
                <Plot
                  data={icData[CALCE_CELL_MAP[selected.id]].curves.map((c, i) => ({
                    type: 'scatter' as const, mode: 'lines' as const,
                    name: `Cycle ${c.cycle} (Q=${c.max_capacity.toFixed(3)}Ah)`,
                    x: c.voltage, y: c.dqdv,
                    line: { color: IC_COLORS[i % IC_COLORS.length], width: i === 0 ? 2.5 : 1.5,
                             opacity: 1 - i * 0.12 },
                  }))}
                  layout={{ ...darkLayout, height: 240,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Voltage (V)', font: { color: '#64748b' } }, range: [2.5, 4.3] },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'dQ/dV (Ah/V)', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              ) : (
                <div className="h-52 flex items-center justify-center text-text-muted text-sm border border-border-subtle rounded-lg">
                  IC curve data unavailable for this chemistry
                </div>
              )}
            </div>
          )}

          {/* Degradation modes */}
          <div className="panel p-5">
            <h3 className="section-title mb-3">Degradation Mechanisms</h3>
            <div className="grid grid-cols-2 gap-2">
              {selected.degradation_modes.map((mode, i) => (
                <motion.div key={i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
                  className="flex items-start gap-2 p-3 rounded-lg bg-bg-elevated border border-border-subtle">
                  <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5"
                    style={{ backgroundColor: selected.color + '22', color: selected.color }}>{i + 1}</span>
                  <span className="text-sm text-text-secondary">{mode}</span>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Why hard + datasets */}
          <div className="grid grid-cols-2 gap-4">
            <div className="panel p-5" style={{ borderColor: selected.color + '33', backgroundColor: selected.color + '05' }}>
              <h3 className="text-sm font-semibold mb-2" style={{ color: selected.color }}>RUL Prediction Challenge</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{selected.why_hard}</p>
            </div>
            <div className="panel p-5">
              <h3 className="section-title mb-3">Available Datasets</h3>
              <div className="space-y-1.5">
                {selected.datasets.map(d => (
                  <div key={d} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-bg-elevated border border-border-subtle">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: selected.color }} />
                    <span className="text-sm text-text-secondary">{d}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 text-xs text-text-muted">
                Anode: {selected.anode} · Cathode: {selected.cathode}
              </div>
            </div>
          </div>

          {/* Safety */}
          <div className="panel p-4 border-border-subtle bg-bg-elevated/50">
            <div className="text-xs text-text-muted">Safety profile: <span className="text-text-secondary">{selected.safety}</span></div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

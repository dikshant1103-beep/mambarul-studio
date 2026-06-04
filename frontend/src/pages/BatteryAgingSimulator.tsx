import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { motion } from 'framer-motion'
import { FlaskConical, Info, ToggleLeft, ToggleRight, Play, Pause, RotateCcw, FastForward } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

// ─── Physics constants ────────────────────────────────────────────────────────

const R_GAS = 8.314          // J / (mol·K)
const Ea = 25_000            // J / mol  — activation energy
const A_PRE = 1.0            // pre-exponential factor (normalised)

// ─── Chemistry config ─────────────────────────────────────────────────────────

type ChemKey = 'LCO' | 'LFP' | 'NMC' | 'NCM'

interface ChemConfig {
  label: string
  maxCycles: number
  color: string
  description: string
}

const CHEM: Record<ChemKey, ChemConfig> = {
  LCO: { label: 'LCO',  maxCycles: 350,  color: '#3b82f6', description: 'Lithium Cobalt Oxide — high energy density, limited cycle life' },
  LFP: { label: 'LFP',  maxCycles: 2000, color: '#10b981', description: 'Lithium Iron Phosphate — safest, longest cycle life' },
  NMC: { label: 'NMC',  maxCycles: 600,  color: '#f59e0b', description: 'NMC — balanced energy/power, moderate cycle life' },
  NCM: { label: 'NCM',  maxCycles: 700,  color: '#8b5cf6', description: 'NCM — high energy density, premium EVs' },
}

const CHEM_KEYS = Object.keys(CHEM) as ChemKey[]

// ─── Real-cell selector ───────────────────────────────────────────────────────

const REAL_CELLS = ['CS2_33', 'CS2_35', 'CS2_37', 'CS2_38'] as const
type RealCellKey = typeof REAL_CELLS[number]

// Known EOL cycles per real cell (cycles to EOL at 80% SoH threshold)
const REAL_CELL_EOL: Record<RealCellKey, number> = {
  CS2_33: 337,
  CS2_35: 337,
  CS2_37: 337,
  CS2_38: 337,
}

interface RealCellData {
  cycles: number[]
  soh_pct: number[]
  n_cycles: number
}

// ─── Degradation model ────────────────────────────────────────────────────────

interface SimResult {
  cycles: number[]
  soh: number[]        // 0–100 %
  capacity: number[]   // Ah
  rul: number[]        // remaining cycles to EOL
  eolCycle: number     // cycle at which SoH first drops below 80 %
}

function runSimulation(
  soh0: number,         // %
  q0: number,           // Ah
  tempC: number,        // °C
  cRate: number,
  nCycles: number,
): SimResult {
  const T_K = tempC + 273.15
  const alpha = A_PRE * Math.exp(-Ea / (R_GAS * T_K))
  const k_cal = 0.0003 * Math.pow(cRate, 1.4)

  const cycles: number[] = []
  const soh: number[] = []
  const capacity: number[] = []

  let eolCycle = nCycles  // assume never reached unless proven

  for (let n = 0; n <= nCycles; n++) {
    const sohN = soh0 - alpha * k_cal * Math.sqrt(n)
    const clampedSoH = Math.max(0, sohN)
    cycles.push(n)
    soh.push(clampedSoH)
    capacity.push((clampedSoH / 100) * q0)

    // first time crossing 80 %
    if (clampedSoH < 80 && eolCycle === nCycles) {
      eolCycle = n
    }
  }

  // RUL at each cycle
  const rul = cycles.map(n => Math.max(0, eolCycle - n))

  return { cycles, soh, capacity, rul, eolCycle }
}

// ─── Slider component ─────────────────────────────────────────────────────────

interface SliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit: string
  color: string
  onChange: (v: number) => void
  format?: (v: number) => string
}

function Slider({ label, value, min, max, step, unit, color, onChange, format }: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100
  const display = format ? format(value) : value.toFixed(step < 1 ? 1 : 0)
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-text-muted">{label}</span>
        <span className="font-mono text-xs font-semibold" style={{ color }}>
          {display}{unit}
        </span>
      </div>
      <div className="relative h-1.5 rounded-full bg-bg-elevated">
        <div
          className="absolute left-0 top-0 h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
        <input
          type="range"
          min={min} max={max} step={step} value={value}
          onChange={e => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
          style={{ height: '100%' }}
        />
      </div>
      <div className="flex justify-between text-xs text-text-muted" style={{ fontSize: '10px' }}>
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function BatteryAgingSimulator() {
  // ── Parameters ──────────────────────────────────────────────────────────────
  const [soh0, setSoh0]       = useState(100)       // %
  const [q0, setQ0]           = useState(1.1)       // Ah
  const [tempC, setTempC]     = useState(25)        // °C
  const [cRate, setCRate]     = useState(1.0)       // C
  const [nCycles, setNCycles] = useState(500)       // cycles to simulate
  const [chem, setChem]       = useState<ChemKey>('LCO')

  // ── Real cell overlay state ─────────────────────────────────────────────────
  const [overlayEnabled, setOverlayEnabled]       = useState(false)
  const [selectedRealCell, setSelectedRealCell]   = useState<RealCellKey>('CS2_37')
  const [realCellData, setRealCellData]           = useState<RealCellData | null>(null)
  const [overlayLoading, setOverlayLoading]       = useState(false)
  const [overlayError, setOverlayError]           = useState<string | null>(null)

  // ── Full CALCE curves state (capacity, voltage, IR) ─────────────────────────
  const [calceCell, setCalceCell]   = useState('CS2_37')
  const [calceCurves, setCalceCurves] = useState<any>(null)
  const [calceLoading, setCalceLoading] = useState(false)

  const chemCfg = CHEM[chem]

  // ── Run simulation ──────────────────────────────────────────────────────────
  const sim = useMemo(
    () => runSimulation(soh0, q0, tempC, cRate, Math.min(nCycles, chemCfg.maxCycles)),
    [soh0, q0, tempC, cRate, nCycles, chemCfg.maxCycles]
  )

  const maxCycles = sim.cycles.length - 1

  // ── Playback state ──────────────────────────────────────────────────────────
  const [currentCycle, setCurrentCycle] = useState(0)
  const [playing, setPlaying]           = useState(false)
  const [speed, setSpeed]               = useState(1)
  const tickRef       = useRef<ReturnType<typeof setInterval>>()
  const maxCyclesRef  = useRef(maxCycles)

  useEffect(() => { maxCyclesRef.current = maxCycles }, [maxCycles])

  // Clamp and stop when sim changes (params updated)
  useEffect(() => {
    setPlaying(false)
    setCurrentCycle(c => Math.min(c, maxCycles))
  }, [sim, maxCycles])

  // Play/pause interval
  useEffect(() => {
    clearInterval(tickRef.current)
    if (playing) {
      tickRef.current = setInterval(() => {
        setCurrentCycle(c => {
          if (c >= maxCyclesRef.current) { setPlaying(false); return maxCyclesRef.current }
          return c + 1
        })
      }, Math.round(300 / speed))
    }
    return () => clearInterval(tickRef.current)
  }, [playing, speed])

  // Live values at current cycle
  const rulAtCurrent  = sim.rul[Math.min(currentCycle, sim.rul.length - 1)] ?? 0
  const sohNow        = sim.soh[currentCycle] ?? 0
  const capNow        = sim.capacity[currentCycle] ?? 0
  const daysRemaining = rulAtCurrent

  // ── Fetch real cell data ────────────────────────────────────────────────────
  const fetchRealCell = useCallback(async (cell: RealCellKey) => {
    setOverlayLoading(true)
    setOverlayError(null)
    try {
      const res = await fetch(`/api/multi-cell-rul?cells=${cell}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      const cellPayload = json.cells?.[cell]
      if (!cellPayload) throw new Error('Cell not found in response')
      setRealCellData({
        cycles: cellPayload.cycles ?? [],
        soh_pct: cellPayload.soh_pct ?? [],
        n_cycles: cellPayload.n_cycles ?? 0,
      })
    } catch (err) {
      setOverlayError('Failed to load real cell data')
      setRealCellData(null)
    } finally {
      setOverlayLoading(false)
    }
  }, [])

  // Fetch when overlay turns on or cell changes
  useEffect(() => {
    if (overlayEnabled) {
      fetchRealCell(selectedRealCell)
    } else {
      setRealCellData(null)
      setOverlayError(null)
    }
  }, [overlayEnabled, selectedRealCell, fetchRealCell])

  // ── Handle toggle ───────────────────────────────────────────────────────────
  // Fetch full CALCE curves for detailed comparison
  const fetchCalceCurves = useCallback(async (cell: string) => {
    setCalceLoading(true)
    try {
      const res = await fetch(`/api/capacity-curves?cell=${cell}`)
      if (res.ok) setCalceCurves(await res.json())
    } catch { /* ignore */ } finally { setCalceLoading(false) }
  }, [])

  useEffect(() => { fetchCalceCurves(calceCell) }, [calceCell, fetchCalceCurves])

  const handleOverlayToggle = () => {
    setOverlayEnabled(prev => !prev)
  }

  const handleRealCellChange = (cell: RealCellKey) => {
    setSelectedRealCell(cell)
  }

  // Current-cycle vertical marker
  const playMarkerShape: Partial<Plotly.Shape> = {
    type: 'line',
    x0: currentCycle, x1: currentCycle,
    y0: 0, y1: 1, yref: 'paper' as const,
    line: { color: '#f59e0b', width: 1.5, dash: 'dot' as const },
  }

  const currentDot: Plotly.Data = {
    type: 'scatter',
    mode: 'markers',
    showlegend: false,
    name: '',
    x: [currentCycle],
    y: [sohNow],
    marker: { color: '#f59e0b', size: 10, symbol: 'diamond', line: { color: '#fff', width: 1.5 } },
  }

  const statusColor = sohNow >= 80 ? '#10b981' : sohNow >= 60 ? '#f59e0b' : '#ef4444'
  const statusLabel = sohNow >= 80 ? 'Healthy' : sohNow >= 60 ? 'Degraded' : 'Near-EOL'

  // EOL line for SoH chart
  const eolShape: Partial<Plotly.Shape> = {
    type: 'line',
    x0: 0, x1: 1, xref: 'paper' as const,
    y0: 80, y1: 80,
    line: { color: '#ef4444', dash: 'dot', width: 1.5 },
  }

  // EOL marker
  const eolAnnotation: Partial<Plotly.Annotations> = {
    x: sim.eolCycle < nCycles ? sim.eolCycle : (nCycles * 0.95),
    y: 80,
    yref: 'y' as const,
    text: sim.eolCycle < nCycles ? `EOL @${sim.eolCycle}cy` : 'EOL beyond sim',
    showarrow: sim.eolCycle < nCycles,
    arrowcolor: '#ef4444',
    arrowsize: 0.8,
    font: { color: '#ef4444', size: 10 },
    bgcolor: '#1a2233',
    bordercolor: '#ef4444',
    borderwidth: 1,
    ay: -28,
  }

  // ── SoH trace ───────────────────────────────────────────────────────────────
  const sohTrace: Plotly.Data = {
    type: 'scatter',
    mode: 'lines',
    name: `SoH — ${chem}`,
    x: sim.cycles,
    y: sim.soh,
    line: { color: chemCfg.color, width: 2.5 },
    fill: 'tozeroy',
    fillcolor: chemCfg.color + '18',
  }

  // ── Real cell overlay trace ─────────────────────────────────────────────────
  const realCellTrace: Plotly.Data | null = (overlayEnabled && realCellData && realCellData.cycles.length > 0)
    ? {
        type: 'scatter',
        mode: 'lines',
        name: `Real: ${selectedRealCell}`,
        x: realCellData.cycles,
        y: realCellData.soh_pct,
        line: { color: '#f59e0b', dash: 'dash', width: 2 },
      }
    : null

  const sohChartData: Plotly.Data[] = realCellTrace
    ? [sohTrace, realCellTrace]
    : [sohTrace]

  // ── Capacity trace ──────────────────────────────────────────────────────────
  const capTrace: Plotly.Data = {
    type: 'scatter',
    mode: 'lines',
    name: `Capacity (Ah) — ${chem}`,
    x: sim.cycles,
    y: sim.capacity,
    line: { color: chemCfg.color, width: 2.5 },
    fill: 'tozeroy',
    fillcolor: chemCfg.color + '18',
  }

  // ── RUL bar trace (single bar, current RUL at midpoint) ─────────────────────
  const rulBarTrace: Plotly.Data = {
    type: 'bar',
    x: ['Remaining Useful Life'],
    y: [rulAtCurrent],
    text: [`${rulAtCurrent} cycles`],
    textposition: 'outside' as const,
    marker: {
      color: rulAtCurrent > 100 ? '#10b981' : rulAtCurrent > 30 ? '#f59e0b' : '#ef4444',
      opacity: 0.85,
    },
    name: 'RUL',
  }

  // max life bar for context
  const maxLifeBar: Plotly.Data = {
    type: 'bar',
    x: ['Max Chemistry Life'],
    y: [chemCfg.maxCycles],
    text: [`${chemCfg.maxCycles} cycles`],
    textposition: 'outside' as const,
    marker: { color: '#1e3a5f', opacity: 0.6 },
    name: `${chem} Max`,
  }

  // ── EOL of sim for info box ─────────────────────────────────────────────────
  const simEolDisplay = sim.eolCycle < Math.min(nCycles, chemCfg.maxCycles)
    ? `${sim.eolCycle} cycles`
    : `>${Math.min(nCycles, chemCfg.maxCycles)} cycles`

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
      className="px-8 py-8 max-w-7xl mx-auto"
    >
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center gap-3 mb-2">
          <FlaskConical size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Battery Aging Simulator</h1>
        </div>
        <p className="text-text-secondary">
          Physics-based degradation model (Arrhenius + power law) — tweak parameters to see how temperature,
          C-rate, and chemistry drive capacity fade and RUL
        </p>
      </div>

      {/* ── Playback scrubber ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 mb-4 panel p-3">
        <button
          onClick={() => setPlaying(p => !p)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium shrink-0 ${
            playing ? 'bg-brand-blue/10 text-brand-blue' : 'btn-primary'
          }`}
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
          {playing ? 'Pause' : 'Play'}
        </button>
        <div className="flex-1">
          <input
            type="range" min={0} max={maxCycles} step={1} value={currentCycle}
            onChange={e => { setPlaying(false); setCurrentCycle(+e.target.value) }}
            className="w-full accent-brand-blue"
          />
        </div>
        <span className="font-mono text-sm text-brand-blue w-24 text-center shrink-0">
          Cycle {currentCycle}/{maxCycles}
        </span>
        <div className="flex items-center gap-1 shrink-0">
          <FastForward size={12} className="text-text-muted" />
          {[1, 2, 4].map(s => (
            <button key={s} onClick={() => setSpeed(s)}
              className={`px-1.5 py-0.5 rounded text-xs font-mono ${speed === s ? 'bg-brand-blue text-white' : 'text-text-muted'}`}>
              {s}×
            </button>
          ))}
        </div>
        <button onClick={() => { setPlaying(false); setCurrentCycle(0) }}
          className="btn-ghost text-xs flex items-center gap-1 shrink-0">
          <RotateCcw size={12} /> Reset
        </button>
      </div>

      {/* ── Live stat strip ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: 'SoH now',   value: `${sohNow.toFixed(1)}%`,       color: statusColor },
          { label: 'Capacity',  value: `${capNow.toFixed(3)} Ah`,     color: chemCfg.color },
          { label: 'RUL',       value: `${rulAtCurrent} cycles`,      color: rulAtCurrent > 100 ? '#10b981' : rulAtCurrent > 30 ? '#f59e0b' : '#ef4444' },
          { label: 'Status',    value: statusLabel,                    color: statusColor },
        ].map(({ label, value, color }) => (
          <div key={label} className="panel p-3 text-center">
            <div className="text-xs text-text-muted mb-1">{label}</div>
            <motion.div className="font-mono font-bold text-lg"
              key={value} style={{ color }}
              initial={{ opacity: 0.4, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.15 }}>
              {value}
            </motion.div>
          </div>
        ))}
      </div>

      <div className="flex gap-5">
        {/* ── Left: sliders ─────────────────────────────────────────────── */}
        <div className="w-72 flex-shrink-0 space-y-4">
          {/* Chemistry selector */}
          <div className="panel p-4">
            <div className="metric-label mb-3">Chemistry</div>
            <div className="grid grid-cols-2 gap-1.5">
              {CHEM_KEYS.map(k => (
                <button
                  key={k}
                  onClick={() => setChem(k)}
                  className="px-3 py-2 rounded-lg text-xs font-semibold border transition-all"
                  style={
                    chem === k
                      ? { backgroundColor: CHEM[k].color + '22', borderColor: CHEM[k].color + '66', color: CHEM[k].color }
                      : { backgroundColor: 'transparent', borderColor: '#1e3a5f', color: '#64748b' }
                  }
                >
                  {k}
                </button>
              ))}
            </div>
            <p className="text-xs text-text-muted mt-2 leading-relaxed">{chemCfg.description}</p>
            <div className="mt-2 flex items-center gap-1.5">
              <Info size={11} className="text-text-muted flex-shrink-0" />
              <span className="text-xs text-text-muted">Max rated: {chemCfg.maxCycles} cycles</span>
            </div>
          </div>

          {/* Sliders */}
          <div className="panel p-4 space-y-5">
            <div className="metric-label">Degradation Parameters</div>

            <Slider
              label="Initial SoH"
              value={soh0}
              min={95}
              max={100}
              step={0.5}
              unit="%"
              color="#10b981"
              onChange={setSoh0}
            />

            <Slider
              label="Initial Capacity (Q₀)"
              value={q0}
              min={0.8}
              max={2.0}
              step={0.05}
              unit=" Ah"
              color="#3b82f6"
              onChange={setQ0}
              format={v => v.toFixed(2)}
            />

            <Slider
              label="Operating Temperature"
              value={tempC}
              min={15}
              max={55}
              step={1}
              unit="°C"
              color={tempC > 40 ? '#ef4444' : tempC > 30 ? '#f59e0b' : '#06b6d4'}
              onChange={setTempC}
            />

            <Slider
              label="Charge Rate (C-rate)"
              value={cRate}
              min={0.5}
              max={3.0}
              step={0.1}
              unit=" C"
              color={cRate > 2 ? '#ef4444' : cRate > 1 ? '#f59e0b' : '#10b981'}
              onChange={setCRate}
              format={v => v.toFixed(1)}
            />

            <Slider
              label="Cycles to Simulate"
              value={nCycles}
              min={50}
              max={2000}
              step={50}
              unit=""
              color="#8b5cf6"
              onChange={setNCycles}
            />
          </div>

          {/* Key metrics panel */}
          <div className="panel p-4 space-y-3">
            <div className="metric-label">Key Metrics</div>

            <div className="space-y-2">
              {/* EOL cycle */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Predicted EOL Cycle</span>
                <span
                  className="font-mono text-sm font-bold"
                  style={{ color: sim.eolCycle < nCycles ? '#ef4444' : '#10b981' }}
                >
                  {sim.eolCycle < nCycles ? `#${sim.eolCycle}` : `>${nCycles}`}
                </span>
              </div>

              {/* RUL now */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">RUL @ cycle {currentCycle}</span>
                <motion.span key={rulAtCurrent}
                  className="font-mono text-sm font-bold"
                  style={{ color: rulAtCurrent > 100 ? '#10b981' : rulAtCurrent > 30 ? '#f59e0b' : '#ef4444' }}
                  initial={{ opacity: 0.5 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
                  {rulAtCurrent} cy
                </motion.span>
              </div>

              {/* Days remaining */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Days remaining</span>
                <motion.span key={daysRemaining} className="font-mono text-sm font-bold text-text-accent"
                  initial={{ opacity: 0.5 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
                  {daysRemaining}d
                </motion.span>
              </div>

              {/* SoH now */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">SoH now</span>
                <motion.span key={sohNow.toFixed(1)}
                  className="font-mono text-sm font-bold"
                  style={{ color: statusColor }}
                  initial={{ opacity: 0.5 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
                  {sohNow.toFixed(1)}%
                </motion.span>
              </div>

              {/* Capacity now */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted">Capacity now</span>
                <motion.span key={capNow.toFixed(3)} className="font-mono text-sm font-bold text-blue-400"
                  initial={{ opacity: 0.5 }} animate={{ opacity: 1 }} transition={{ duration: 0.15 }}>
                  {capNow.toFixed(3)} Ah
                </motion.span>
              </div>
            </div>

            {/* Progress bar: fraction of life consumed */}
            <div>
              <div className="flex justify-between text-xs text-text-muted mb-1">
                <span>Life consumed</span>
                <span className="font-mono" style={{ color: chemCfg.color }}>
                  {sim.eolCycle < nCycles
                    ? '100%'
                    : `${((nCycles / chemCfg.maxCycles) * 100).toFixed(0)}%`}
                </span>
              </div>
              <div className="h-2 rounded-full bg-bg-elevated overflow-hidden">
                <motion.div
                  className="h-full rounded-full"
                  style={{
                    backgroundColor: chemCfg.color,
                    width: `${Math.min(100, (nCycles / chemCfg.maxCycles) * 100)}%`,
                  }}
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(100, (nCycles / chemCfg.maxCycles) * 100)}%` }}
                  transition={{ duration: 0.5 }}
                />
              </div>
            </div>
          </div>

          {/* ── Compare with Real Cell panel ─────────────────────────────── */}
          <div className="panel p-4 space-y-3 border-amber-500/20">
            <div className="flex items-center justify-between">
              <div className="metric-label">Compare with Real Cell</div>
              <button
                onClick={handleOverlayToggle}
                className="flex items-center gap-1.5 text-xs font-medium transition-colors"
                style={{ color: overlayEnabled ? '#f59e0b' : '#64748b' }}
                title={overlayEnabled ? 'Disable overlay' : 'Enable overlay'}
              >
                {overlayEnabled
                  ? <ToggleRight size={20} className="text-amber-400" />
                  : <ToggleLeft size={20} />}
                <span>{overlayEnabled ? 'ON' : 'OFF'}</span>
              </button>
            </div>

            <p className="text-xs text-text-muted leading-relaxed">
              Overlay real CALCE cell SoH data on the chart to compare with your simulation.
            </p>

            {/* Cell selector — only visible when toggle is ON */}
            {overlayEnabled && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
                className="space-y-3"
              >
                <div className="grid grid-cols-2 gap-1">
                  {REAL_CELLS.map(cell => (
                    <button
                      key={cell}
                      onClick={() => handleRealCellChange(cell)}
                      className="px-2 py-1.5 rounded text-xs font-medium border transition-all"
                      style={
                        selectedRealCell === cell
                          ? { backgroundColor: '#f59e0b22', borderColor: '#f59e0b66', color: '#f59e0b' }
                          : { backgroundColor: 'transparent', borderColor: '#1e3a5f', color: '#64748b' }
                      }
                    >
                      {cell}
                    </button>
                  ))}
                </div>

                {/* Status / loading */}
                {overlayLoading && (
                  <div className="text-xs text-text-muted animate-pulse">Loading real cell data…</div>
                )}
                {overlayError && (
                  <div className="text-xs text-red-400">{overlayError}</div>
                )}

                {/* Info box */}
                {realCellData && !overlayLoading && (
                  <div
                    className="rounded-lg p-3 space-y-1.5 text-xs"
                    style={{ backgroundColor: '#f59e0b0d', border: '1px solid #f59e0b33' }}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">Real cell EOL</span>
                      <span className="font-mono font-bold text-amber-400">
                        {REAL_CELL_EOL[selectedRealCell]} cycles
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-text-muted">Your simulation EOL</span>
                      <span className="font-mono font-bold" style={{ color: chemCfg.color }}>
                        {simEolDisplay}
                      </span>
                    </div>
                    <div className="pt-1 border-t border-amber-500/10 text-text-muted leading-relaxed">
                      Dashed amber line = {selectedRealCell} measured SoH ({realCellData.n_cycles} cycles recorded)
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </div>
        </div>

        {/* ── Right: charts ──────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 space-y-4">

          {/* SoH trajectory */}
          <motion.div
            key={`soh-${chem}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="panel p-5"
          >
            <h3 className="section-title mb-1">State of Health Trajectory</h3>
            <p className="text-xs text-text-muted mb-4">
              SoH(n) = SoH₀ − α(T) · k_cal · √n — red dashed line marks 80% end-of-life
              {overlayEnabled && realCellData && (
                <span className="ml-2 text-amber-400 font-medium">
                  · Amber dashed = Real {selectedRealCell}
                </span>
              )}
            </p>
            <Plot
              data={[...sohChartData, currentDot]}
              layout={{
                ...darkLayout,
                height: 240,
                margin: { t: 10, b: 55, l: 65, r: 20 },
                shapes: [eolShape as Plotly.Shape, playMarkerShape as Plotly.Shape],
                annotations: [eolAnnotation as Plotly.Annotations, {
                  x: currentCycle, y: sohNow,
                  text: `${sohNow.toFixed(1)}%`,
                  font: { color: '#f59e0b', size: 10 },
                  showarrow: false, yshift: 14,
                } as Plotly.Annotations],
                xaxis: {
                  ...(darkLayout.xaxis as object),
                  title: { text: 'Cycle', font: { color: '#64748b' } },
                },
                yaxis: {
                  ...(darkLayout.yaxis as object),
                  title: { text: 'SoH (%)', font: { color: '#64748b' } },
                  range: [Math.max(0, Math.min(...sim.soh) - 5), 105],
                },
                legend: {
                  font: { color: '#94a3b8', size: 11 },
                  bgcolor: 'transparent',
                  x: 1,
                  xanchor: 'right' as const,
                  y: 1,
                },
              } as Plotly.Layout}
              config={{ ...plotConfig, displayModeBar: false }}
              style={{ width: '100%' }}
            />
          </motion.div>

          {/* Capacity (Ah) vs cycles */}
          <motion.div
            key={`cap-${chem}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 }}
            className="panel p-5"
          >
            <h3 className="section-title mb-1">Capacity (Ah) vs Cycles</h3>
            <p className="text-xs text-text-muted mb-4">
              Absolute discharge capacity derived from SoH · Q₀
            </p>
            <Plot
              data={[capTrace, {
                type: 'scatter', mode: 'markers', showlegend: false, name: '',
                x: [currentCycle], y: [capNow],
                marker: { color: '#f59e0b', size: 9, symbol: 'diamond', line: { color: '#fff', width: 1.5 } },
              } as Plotly.Data]}
              layout={{
                ...darkLayout,
                height: 220,
                margin: { t: 10, b: 55, l: 65, r: 20 },
                shapes: [playMarkerShape as Plotly.Shape],
                xaxis: {
                  ...(darkLayout.xaxis as object),
                  title: { text: 'Cycle', font: { color: '#64748b' } },
                },
                yaxis: {
                  ...(darkLayout.yaxis as object),
                  title: { text: 'Capacity (Ah)', font: { color: '#64748b' } },
                  range: [
                    Math.max(0, Math.min(...sim.capacity) - 0.05),
                    q0 * 1.05,
                  ],
                },
              } as Plotly.Layout}
              config={{ ...plotConfig, displayModeBar: false }}
              style={{ width: '100%' }}
            />
          </motion.div>

          {/* RUL countdown bar */}
          <motion.div
            key={`rul-${chem}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="panel p-5"
          >
            <h3 className="section-title mb-1">RUL Countdown — Cycle {currentCycle}</h3>
            <p className="text-xs text-text-muted mb-4">
              Remaining useful life at current cycle vs chemistry max rated life. Scrub or Play to watch it count down.
            </p>
            <Plot
              data={[maxLifeBar, {
                ...rulBarTrace,
                y: [rulAtCurrent],
                text: [`${rulAtCurrent} cycles`],
                marker: {
                  color: rulAtCurrent > 100 ? '#10b981' : rulAtCurrent > 30 ? '#f59e0b' : '#ef4444',
                  opacity: 0.85,
                },
              } as Plotly.Data]}
              layout={{
                ...darkLayout,
                height: 200,
                barmode: 'group' as const,
                margin: { t: 10, b: 55, l: 30, r: 30 },
                xaxis: { ...(darkLayout.xaxis as object) },
                yaxis: {
                  ...(darkLayout.yaxis as object),
                  title: { text: 'Cycles', font: { color: '#64748b' } },
                  range: [0, Math.max(rulAtCurrent, chemCfg.maxCycles) * 1.2],
                },
                transition: { duration: 120, easing: 'cubic-in-out' },
              } as Plotly.Layout}
              config={{ ...plotConfig, displayModeBar: false }}
              style={{ width: '100%' }}
            />
          </motion.div>

          {/* Physics model info */}
          <div className="panel p-4 border-purple-500/20 bg-purple-500/5">
            <h3 className="text-sm font-semibold text-purple-400 mb-2">Degradation Model</h3>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-text-secondary font-mono">
              <div>α(T) = A · exp(−Eₐ / R·T)</div>
              <div>Eₐ = 25 000 J/mol, R = 8.314 J/mol·K</div>
              <div>k_cal = 0.0003 · C‑rate^1.4</div>
              <div>SoH(n) = SoH₀ − α · k_cal · √n</div>
              <div className="col-span-2 text-text-muted mt-1">
                EOL defined as SoH &lt; 80% · RUL = EOL_cycle − n · 1 cycle/day assumed
              </div>
            </div>
          </div>

          {/* Real CALCE curves comparison */}
          <div className="panel p-5 border-cyan-500/20">
            <div className="flex items-center justify-between mb-3">
              <h3 className="section-title text-cyan-400">Real CALCE Measurement vs Arrhenius Model</h3>
              <div className="flex gap-1">
                {['CS2_33','CS2_35','CS2_36','CS2_37','CS2_38'].map(c => (
                  <button key={c} onClick={() => setCalceCell(c)}
                    className={`px-2 py-0.5 rounded text-xs font-mono transition-all ${calceCell===c?'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40':'text-text-muted border border-border-subtle'}`}>
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-text-muted mb-3">
              Solid cyan = measured CALCE SoH · Dashed = Arrhenius physics model.
              The gap between them shows where the model diverges from real degradation.
            </p>
            {calceLoading ? (
              <div className="h-60 flex items-center justify-center">
                <motion.div className="w-6 h-6 rounded-full border-2 border-cyan-400 border-t-transparent"
                  animate={{rotate:360}} transition={{duration:1,repeat:Infinity,ease:'linear'}}/>
              </div>
            ) : calceCurves && (
              <Plot
                data={[
                  {
                    type: 'scatter', mode: 'lines', name: `${calceCell} (measured)`,
                    x: calceCurves.cycles, y: calceCurves.soh_pct,
                    line: { color: '#06b6d4', width: 2.5 },
                    fill: 'tozeroy', fillcolor: '#06b6d410',
                  },
                  {
                    type: 'scatter', mode: 'lines', name: 'Arrhenius model',
                    x: sim.cycles.slice(0, Math.min(sim.cycles.length, calceCurves.n_cycles + 10)),
                    y: sim.soh.slice(0, Math.min(sim.soh.length, calceCurves.n_cycles + 10)),
                    line: { color: chemCfg.color, width: 1.5, dash: 'dash' },
                  },
                  {
                    type: 'scatter', mode: 'lines', name: 'Divergence (model − real)',
                    x: calceCurves.cycles.slice(0, Math.min(calceCurves.cycles.length, sim.cycles.length)),
                    y: calceCurves.cycles.slice(0, Math.min(calceCurves.cycles.length, sim.cycles.length))
                      .map((c: number, i: number) => {
                        const simIdx = Math.min(c, sim.soh.length - 1)
                        return (sim.soh[simIdx] ?? 0) - (calceCurves.soh_pct[i] ?? 0)
                      }),
                    line: { color: '#f59e0b', width: 1, dash: 'dot' },
                    yaxis: 'y2',
                  },
                ]}
                layout={{
                  ...darkLayout, height: 280,
                  margin: { t: 10, b: 50, l: 65, r: 70 },
                  xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
                  yaxis: { ...darkLayout.yaxis as object, title: { text: 'SoH (%)', font: { color: '#64748b' } }, range: [50, 105] },
                  yaxis2: { overlaying: 'y', side: 'right', title: { text: 'Δ SoH (%)', font: { color: '#f59e0b', size: 10 } }, tickfont: { color: '#f59e0b', size: 9 }, gridcolor: 'transparent', zeroline: true, zerolinecolor: '#f59e0b33' },
                  shapes: [{ type: 'line', x0: 0, x1: 1, xref: 'paper', y0: 80, y1: 80, line: { color: '#ef4444', dash: 'dot', width: 1 } }],
                  legend: { ...darkLayout.legend },
                } as Plotly.Layout}
                config={{ ...plotConfig, displayModeBar: false }}
                style={{ width: '100%' }}
              />
            )}

            {/* Additional real curves: capacity + IR */}
            {calceCurves && (
              <div className="grid grid-cols-2 gap-3 mt-3">
                <Plot
                  data={[{
                    type: 'scatter', mode: 'lines', name: 'Discharge Capacity',
                    x: calceCurves.cycles, y: calceCurves.capacity_ah,
                    line: { color: '#06b6d4', width: 2 },
                  }]}
                  layout={{ ...darkLayout, height: 180, margin:{t:10,b:45,l:65,r:20},
                    xaxis:{...darkLayout.xaxis as object, title:{text:'Cycle',font:{color:'#64748b'}}},
                    yaxis:{...darkLayout.yaxis as object, title:{text:'Capacity (Ah)',font:{color:'#64748b'}}},
                    title:{text:'Real Discharge Capacity',font:{color:'#94a3b8',size:11}},
                  } as Plotly.Layout}
                  config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}}
                />
                <Plot
                  data={[{
                    type: 'scatter', mode: 'lines', name: 'Internal Resistance',
                    x: calceCurves.cycles, y: calceCurves.ir_mean,
                    line: { color: '#f59e0b', width: 2 },
                  }]}
                  layout={{ ...darkLayout, height: 180, margin:{t:10,b:45,l:65,r:20},
                    xaxis:{...darkLayout.xaxis as object, title:{text:'Cycle',font:{color:'#64748b'}}},
                    yaxis:{...darkLayout.yaxis as object, title:{text:'IR (Ω)',font:{color:'#64748b'}}},
                    title:{text:'Real Internal Resistance Growth',font:{color:'#94a3b8',size:11}},
                  } as Plotly.Layout}
                  config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

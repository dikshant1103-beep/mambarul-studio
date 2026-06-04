/**
 * BMSDashboard.tsx
 * Live BMS-style battery health monitor — simulates real-time degradation display.
 * Real cell data (CS2_37, CS2_38) is loaded from GET /api/multi-cell-rul on mount
 * and used to initialise the simulation state for those cells.
 */
import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Activity, AlertTriangle, CheckCircle, XCircle, Zap, Thermometer, Battery, Download } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

type Chemistry = 'LCO' | 'LFP' | 'NMC' | 'NCM'
type Phase = 'Fresh' | 'Aging' | 'Knee' | 'Near-EOL' | 'Critical'

// Shape of one cell entry returned by GET /api/multi-cell-rul
interface RealCellData {
  cycles: number[]
  rul: number[]
  capacity: number[]
  soh_pct: number[]
  chemistry: string
  n_cycles: number
  error?: string
}

interface MultiCellRulResponse {
  cells: Record<string, RealCellData>
}

interface CellState {
  id: string; chemistry: Chemistry; soh: number; rul: number; temp: number
  voltage: number; current: number; ir: number; cycle: number; phase: Phase
}

const MAX_RUL: Record<Chemistry, number> = { LCO: 309, LFP: 1934, NMC: 550, NCM: 662 }
const CHEMISTRY_COLORS: Record<Chemistry, string> = { LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6' }

const PHASE_CONFIG: Record<Phase, { color: string; bg: string; icon: typeof CheckCircle; label: string }> = {
  Fresh:    { color: '#10b981', bg: '#10b98122', icon: CheckCircle, label: 'OPTIMAL' },
  Aging:    { color: '#3b82f6', bg: '#3b82f622', icon: Activity, label: 'NORMAL WEAR' },
  Knee:     { color: '#f59e0b', bg: '#f59e0b22', icon: AlertTriangle, label: 'ACCELERATED' },
  'Near-EOL': { color: '#ef4444', bg: '#ef444422', icon: XCircle, label: 'CRITICAL' },
  Critical: { color: '#dc2626', bg: '#dc262622', icon: XCircle, label: 'REPLACE NOW' },
}

const INITIAL_CELLS: CellState[] = [
  { id: 'Cell A', chemistry: 'LCO', soh: 94.2, rul: 278, temp: 24.1, voltage: 3.87, current: -1.05, ir: 0.038, cycle: 31, phase: 'Fresh' },
  { id: 'Cell B', chemistry: 'NMC', soh: 79.1, rul: 121, temp: 26.8, voltage: 3.74, current: -0.98, ir: 0.052, cycle: 220, phase: 'Aging' },
  { id: 'Cell C', chemistry: 'LFP', soh: 68.3, rul: 640, temp: 31.2, voltage: 3.28, current: -1.02, ir: 0.071, cycle: 890, phase: 'Knee' },
  { id: 'Cell D', chemistry: 'NCM', soh: 51.7, rul: 48, temp: 35.1, voltage: 3.55, current: -0.91, ir: 0.098, cycle: 485, phase: 'Near-EOL' },
]

function BigGauge({ value, max, color, label, unit }: { value: number; max: number; color: string; label: string; unit: string }) {
  const pct = Math.min(100, (value / max) * 100)
  const r = 68; const circ = 2 * Math.PI * r
  const dash = (pct / 100) * circ * 0.75
  const offset = circ * 0.125

  return (
    <div className="flex flex-col items-center">
      <svg width="160" height="160" viewBox="0 0 160 160">
        <circle cx="80" cy="80" r={r} fill="none" stroke="#1e2d45" strokeWidth="12"
          strokeDasharray={`${circ * 0.75} ${circ * 0.25}`} strokeDashoffset={`-${offset}`}
          strokeLinecap="round" />
        <motion.circle cx="80" cy="80" r={r} fill="none" stroke={color} strokeWidth="12"
          strokeDasharray={`${dash} ${circ}`} strokeDashoffset={`-${offset}`}
          strokeLinecap="round"
          animate={{ strokeDasharray: `${dash} ${circ}` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          style={{ filter: `drop-shadow(0 0 6px ${color}88)` }} />
        <text x="80" y="74" textAnchor="middle" fill={color} fontSize="22" fontWeight="800" fontFamily="JetBrains Mono">
          {value.toFixed(1)}
        </text>
        <text x="80" y="92" textAnchor="middle" fill="#64748b" fontSize="11" fontFamily="Inter">{unit}</text>
      </svg>
      <div className="text-xs font-medium text-text-muted uppercase tracking-wider">{label}</div>
    </div>
  )
}

function MiniSignal({ values, color, height = 50 }: { values: number[]; color: string; height?: number }) {
  if (!values.length) return null
  const W = 120
  const min = Math.min(...values), max = Math.max(...values)
  const range = max - min || 1
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W
    const y = height - ((v - min) / range) * (height - 6) - 3
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

// Derive a Phase label from a SoH percentage
function phaseFromSoh(soh: number): Phase {
  if (soh > 90) return 'Fresh'
  if (soh > 75) return 'Aging'
  if (soh > 60) return 'Knee'
  if (soh > 40) return 'Near-EOL'
  return 'Critical'
}

export default function BMSDashboard() {
  const [cells, setCells] = useState<CellState[]>(INITIAL_CELLS)
  const [selected, setSelected] = useState<string>(INITIAL_CELLS[0].id)
  const [running, setRunning] = useState(true)
  const [history, setHistory] = useState<Record<string, number[]>>({})
  const intervalRef = useRef<ReturnType<typeof setInterval>>()
  const tickRef = useRef(0)

  // Real cell data loaded from the backend
  const [realCells, setRealCells] = useState<Record<string, RealCellData>>({})
  const [realDataStatus, setRealDataStatus] = useState<'loading' | 'loaded' | 'error'>('loading')

  // Fetch real CS2_37 / CS2_38 data on mount
  useEffect(() => {
    fetch('/api/multi-cell-rul?cells=CS2_37,CS2_38')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<MultiCellRulResponse>
      })
      .then(data => {
        setRealCells(data.cells ?? {})
        setRealDataStatus('loaded')
      })
      .catch(() => setRealDataStatus('error'))
  }, [])

  // Apply a real CALCE cell's final SoH/RUL as the starting state for a BMS slot.
  // cellId: 'CS2_37' | 'CS2_38'; slotId: the BMS display name ('Cell A' etc.)
  function loadRealCell(cellId: 'CS2_37' | 'CS2_38', slotId: string) {
    const data = realCells[cellId]
    if (!data || data.error) return

    const finalSoh = data.soh_pct.at(-1) ?? 80
    const finalRul = data.rul.at(-1) ?? 100
    const finalCycle = data.cycles.at(-1) ?? 0

    setCells(prev => prev.map(c => {
      if (c.id !== slotId) return c
      const soh = Math.round(finalSoh * 10) / 10
      return {
        ...c,
        id: slotId,
        chemistry: 'LCO' as Chemistry,   // CS2 cells are LCO
        soh,
        rul: Math.round(finalRul),
        cycle: finalCycle,
        phase: phaseFromSoh(soh),
        // Keep simulated temp/voltage/ir values — real data doesn't include these
      }
    }))
    // Reset history for this slot so the trace starts clean
    setHistory(prev => ({ ...prev, [slotId]: [] }))
  }

  // Simulate real-time degradation
  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        tickRef.current++
        setCells(prev => prev.map(cell => {
          const t = tickRef.current
          const noise = (Math.random() - 0.5) * 0.3
          const newSoh = Math.max(20, cell.soh - 0.015 + noise * 0.01)
          const max = MAX_RUL[cell.chemistry]
          const newRul = Math.max(0, max * Math.pow(newSoh / 100, 2.3))
          const tempNoise = (Math.random() - 0.5) * 0.4
          const newTemp = Math.max(18, Math.min(55, cell.temp + tempNoise))
          const irGrowth = cell.ir * (1 + 0.0001)
          const newPhase: Phase = newSoh > 90 ? 'Fresh' : newSoh > 75 ? 'Aging' : newSoh > 60 ? 'Knee' : newSoh > 40 ? 'Near-EOL' : 'Critical'
          const vNoise = (Math.random() - 0.5) * 0.01
          return {
            ...cell,
            soh: Math.round(newSoh * 10) / 10,
            rul: Math.round(newRul),
            temp: Math.round(newTemp * 10) / 10,
            voltage: Math.round((cell.voltage + vNoise) * 1000) / 1000,
            ir: Math.round(irGrowth * 10000) / 10000,
            cycle: cell.cycle + (t % 60 === 0 ? 1 : 0),
            phase: newPhase,
          }
        }))

        setHistory(prev => {
          const next = { ...prev }
          INITIAL_CELLS.forEach(c => {
            if (!next[c.id]) next[c.id] = []
            // Capture current SOH from cells
          })
          return next
        })
      }, 1000)
    } else {
      clearInterval(intervalRef.current)
    }
    return () => clearInterval(intervalRef.current)
  }, [running])

  // Track SOH history
  useEffect(() => {
    setHistory(prev => {
      const next = { ...prev }
      cells.forEach(c => {
        if (!next[c.id]) next[c.id] = []
        next[c.id] = [...(next[c.id] || []).slice(-60), c.soh]
      })
      return next
    })
  }, [cells])

  const cell = cells.find(c => c.id === selected) ?? cells[0]
  const pc = PHASE_CONFIG[cell.phase]

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Battery size={22} className="text-brand-blue" />
            <h1 className="text-2xl font-bold text-text-primary">BMS — Battery Management Dashboard</h1>
            {/* Real data status badge */}
            {realDataStatus === 'loaded' && (
              <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                Real cell data loaded
              </span>
            )}
            {realDataStatus === 'loading' && (
              <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-bg-panel border border-border-subtle text-text-muted">
                <span className="w-1.5 h-1.5 rounded-full bg-text-muted animate-pulse" />
                Loading real data…
              </span>
            )}
            {realDataStatus === 'error' && (
              <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 border border-amber-500/30 text-amber-400">
                Using default parameters
              </span>
            )}
          </div>
          <p className="text-text-secondary text-sm">Live simulation · MambaRUL v10-final inference · Real-time health monitoring</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Load real cell buttons — only shown when real data is available */}
          {realDataStatus === 'loaded' && (
            <>
              <button
                onClick={() => loadRealCell('CS2_37', 'Cell A')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-blue/10 text-brand-blue border border-brand-blue/30 hover:bg-brand-blue/20 transition-all"
                title="Load real CS2_37 final SoH/RUL into Cell A slot"
              >
                <Download size={11} />
                Load CS2_37
              </button>
              <button
                onClick={() => loadRealCell('CS2_38', 'Cell B')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-brand-blue/10 text-brand-blue border border-brand-blue/30 hover:bg-brand-blue/20 transition-all"
                title="Load real CS2_38 final SoH/RUL into Cell B slot"
              >
                <Download size={11} />
                Load CS2_38
              </button>
            </>
          )}
          <button onClick={() => setRunning(r => !r)}
            className={`flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm transition-all ${running ? 'bg-red-500/10 text-red-400 border border-red-500/30' : 'btn-primary'}`}>
            {running ? '⏸ Pause' : '▶ Live'}
            {running && <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse ml-1" />}
          </button>
        </div>
      </div>

      {/* Cell grid */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {cells.map(c => {
          const cfg = PHASE_CONFIG[c.phase]
          const isSelected = c.id === selected
          return (
            <motion.div key={c.id}
              onClick={() => setSelected(c.id)}
              whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }}
              className="rounded-xl border p-4 cursor-pointer transition-all"
              style={{
                borderColor: isSelected ? cfg.color : '#1e3a5f',
                backgroundColor: isSelected ? cfg.bg : '#111827',
                boxShadow: isSelected ? `0 0 20px ${cfg.color}33` : 'none',
              }}>
              <div className="flex items-center justify-between mb-2">
                <span className="font-bold text-text-primary">{c.id}</span>
                <span className="text-xs px-2 py-0.5 rounded-full font-bold"
                  style={{ backgroundColor: cfg.color + '22', color: cfg.color }}>
                  {c.phase}
                </span>
              </div>
              <div className="flex items-baseline gap-1 mb-2">
                <span className="text-3xl font-mono font-black" style={{ color: cfg.color }}>{c.soh.toFixed(1)}</span>
                <span className="text-sm text-text-muted">% SOH</span>
              </div>
              <div className="h-1 bg-bg-elevated rounded-full overflow-hidden mb-2">
                <motion.div className="h-full rounded-full" style={{ backgroundColor: cfg.color }}
                  animate={{ width: `${c.soh}%` }} transition={{ duration: 0.5 }} />
              </div>
              <div className="flex justify-between text-xs font-mono text-text-muted">
                <span style={{ color: CHEMISTRY_COLORS[c.chemistry] }}>{c.chemistry}</span>
                <span>RUL={c.rul}</span>
                <span>{c.temp}°C</span>
              </div>
              <MiniSignal values={history[c.id] ?? [c.soh]} color={cfg.color} height={32} />
            </motion.div>
          )
        })}
      </div>

      {/* Selected cell detail */}
      <AnimatePresence mode="wait">
        <motion.div key={selected} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-3 gap-4">

          {/* Big gauges */}
          <div className="panel p-5 col-span-1">
            <div className="flex items-center justify-between mb-3">
              <h3 className="section-title">{cell.id} — Detail</h3>
              <div className="px-2.5 py-1 rounded-lg text-xs font-bold flex items-center gap-1.5"
                style={{ backgroundColor: pc.bg, color: pc.color }}>
                <pc.icon size={12} />
                {pc.label}
              </div>
            </div>
            <div className="flex justify-around mb-4">
              <BigGauge value={cell.soh} max={100} color={pc.color} label="State of Health" unit="%" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {[
                { label: 'RUL', value: cell.rul.toFixed(0), unit: 'cycles', color: pc.color, icon: Zap },
                { label: 'Temperature', value: cell.temp.toFixed(1), unit: '°C', color: cell.temp > 40 ? '#ef4444' : '#06b6d4', icon: Thermometer },
                { label: 'Voltage', value: cell.voltage.toFixed(3), unit: 'V', color: '#3b82f6', icon: Activity },
                { label: 'Int. Resistance', value: (cell.ir * 1000).toFixed(1), unit: 'mΩ', color: '#f59e0b', icon: Activity },
              ].map(m => (
                <div key={m.label} className="bg-bg-elevated rounded-lg p-3 border border-border-subtle">
                  <div className="text-xs text-text-muted mb-0.5">{m.label}</div>
                  <div className="font-mono font-bold text-lg" style={{ color: m.color }}>{m.value}</div>
                  <div className="text-xs text-text-muted">{m.unit}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Live SOH trace with knee-point detection */}
          <div className="panel p-5 col-span-2">
            <h3 className="section-title mb-3">Live SOH Traces — All Cells</h3>
            {/* Knee-point overlay on real cell */}
            {Object.entries(realCells).map(([cellId, rd]) => {
              const sohs: number[] = rd.soh_pct ?? []
              const cycles: number[] = rd.cycles ?? []
              if (sohs.length < 5) return null
              // Second derivative to find inflection (knee)
              let kneeIdx = -1, maxD2 = 0
              for (let i = 2; i < sohs.length - 2; i++) {
                const d2 = Math.abs(sohs[i+1] - 2*sohs[i] + sohs[i-1])
                if (d2 > maxD2) { maxD2 = d2; kneeIdx = i }
              }
              const kneeCycle = kneeIdx >= 0 ? cycles[kneeIdx] : null
              const kneeSoh   = kneeIdx >= 0 ? sohs[kneeIdx] : null
              if (kneeCycle === null || kneeSoh === null) return null
              return (
                <div key={cellId} className="mb-2 flex items-center gap-3 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <motion.div className="w-2 h-2 rounded-full bg-amber-400"
                    animate={{ scale: [1,1.5,1], opacity:[0.6,1,0.6] }}
                    transition={{ duration: 1.5, repeat: Infinity }} />
                  <span className="text-xs font-semibold text-amber-400">
                    {cellId} knee-point detected @ cycle {kneeCycle} (SoH={kneeSoh.toFixed(1)}%)
                  </span>
                  <span className="text-xs text-text-muted ml-auto">
                    accelerated fade begins here (d²SoH/dc² = {maxD2.toFixed(4)})
                  </span>
                </div>
              )
            })}
            <Plot
              data={[
                ...cells.map(c => ({
                  type: 'scatter' as const, mode: 'lines' as const, name: c.id,
                  y: history[c.id] ?? [c.soh],
                  x: Array.from({ length: (history[c.id] ?? [c.soh]).length }, (_, i) => i),
                  line: { color: PHASE_CONFIG[c.phase].color, width: c.id === selected ? 2.5 : 1.5 },
                })),
                // Knee point markers on real cells
                ...Object.entries(realCells).map(([cellId, rd]) => {
                  const sohs: number[] = rd.soh_pct ?? []
                  const cycles: number[] = rd.cycles ?? []
                  if (sohs.length < 5) return null
                  let kneeIdx = -1, maxD2 = 0
                  for (let i = 2; i < sohs.length - 2; i++) {
                    const d2 = Math.abs(sohs[i+1] - 2*sohs[i] + sohs[i-1])
                    if (d2 > maxD2) { maxD2 = d2; kneeIdx = i }
                  }
                  if (kneeIdx < 0) return null
                  return {
                    type: 'scatter' as const, mode: 'markers+text' as const,
                    name: `${cellId} knee`,
                    x: [cycles[kneeIdx]], y: [sohs[kneeIdx]],
                    text: ['⚡'], textposition: 'top center' as const,
                    marker: { color: '#f59e0b', size: 14, symbol: 'diamond', line: { color: '#fff', width: 1.5 } },
                  }
                }).filter(Boolean) as unknown as Plotly.Data[],
              ]}
              layout={{ ...darkLayout, height: 260,
                xaxis: { ...darkLayout.xaxis as object, title: { text: 'Time (seconds)', font: { color: '#64748b' } } },
                yaxis: { ...darkLayout.yaxis as object, title: { text: 'SOH (%)', font: { color: '#64748b' } }, range: [0, 105] },
                legend: { ...darkLayout.legend },
              } as Plotly.Layout}
              config={{ ...plotConfig, displayModeBar: false }} style={{ width: '100%' }}
            />

            {/* Alarm system */}
            <div className="mt-4 space-y-1.5">
              {cells.filter(c => c.phase !== 'Fresh' && c.phase !== 'Aging').map(c => {
                const cfg = PHASE_CONFIG[c.phase]
                return (
                  <motion.div key={c.id} animate={{ opacity: [1, 0.7, 1] }} transition={{ duration: 1.5, repeat: Infinity }}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
                    style={{ backgroundColor: cfg.bg, border: `1px solid ${cfg.color}44` }}>
                    <cfg.icon size={14} style={{ color: cfg.color }} />
                    <span className="text-xs font-semibold" style={{ color: cfg.color }}>
                      {c.id} ({c.chemistry}): {cfg.label} — SOH={c.soh.toFixed(1)}%, RUL={c.rul} cycles
                    </span>
                    {c.phase === 'Near-EOL' && (
                      <span className="ml-auto text-xs font-bold text-red-400">⚠ REPLACE SOON</span>
                    )}
                    {c.phase === 'Critical' && (
                      <span className="ml-auto text-xs font-bold text-red-600 animate-pulse">🚨 CRITICAL</span>
                    )}
                  </motion.div>
                )
              })}
              {cells.every(c => c.phase === 'Fresh' || c.phase === 'Aging') && (
                <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <CheckCircle size={14} className="text-emerald-400" />
                  <span className="text-xs text-emerald-400 font-medium">All cells operating normally</span>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

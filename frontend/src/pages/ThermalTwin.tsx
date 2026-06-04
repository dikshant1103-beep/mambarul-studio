/**
 * ThermalTwin — live cell & pack thermal digital twin.
 *
 * LIVE mode: reads real telemetry from cell_timeseries (/history), estimates the
 *   unmeasurable core temperature per sample, reconstructs the cross-section field,
 *   and auto-refreshes to follow new data.
 * CELL (demo): synthetic discharge + cooling fault on a cylindrical/pouch cell.
 * PACK: per-cell core-temperature map across a module (3D landscape + 2D heatmap).
 *
 * Cell field reconstructed client-side: T = core·χ_core + surface·(1-χ_core).
 */
import { Component, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Plot from 'react-plotly.js'
import { Box, Play, Pause, RotateCcw, Thermometer, AlertTriangle, Snowflake, Grid3x3, CircleDot, Radio } from 'lucide-react'
import { cylinderCutaway, slabCutaway, terminalNub, packCylinders } from './thermalGeometry'

type Geometry = 'cylindrical' | 'pouch'
type Mode = 'live' | 'cell' | 'pack'

interface Basis {
  x: number[]; y: number[]; i: number[]; j: number[]; k: number[]
  chi_core: number[]
  grid_x: number[]; grid_y: number[]; nx: number; ny: number
  chi_core_grid: (number | null)[]
  clim: [number, number]
}
interface CellFrame { t: number; core: number; surface: number; core_sigma: number; current: number; soc: number; cooling: number; status: string; derate: number; ts?: string }
interface CellSim { fault_step: number | null; n: number; frames: CellFrame[]; clim?: [number, number]; has_data?: boolean }
interface PackFrame { t: number; cells: number[]; max_core: number; hottest: number; status: string; derate: number }
interface PackSim { rows: number; cols: number; n_cells: number; weak_idx: number; fault_step: number | null; clim: [number, number]; n_frames: number; frames: PackFrame[] }
interface CellInfo { cell_id: string; n_points: number; latest_ts: string }

const STATUS_COLOR: Record<string, string> = {
  NOMINAL: 'text-emerald-400 bg-emerald-900/30 border-emerald-700',
  DERATING: 'text-amber-400 bg-amber-900/30 border-amber-700',
  WARNING: 'text-orange-400 bg-orange-900/30 border-orange-700',
  CRITICAL: 'text-red-400 bg-red-900/30 border-red-700',
}
const RELIEF = 0.5

// fetch helper that surfaces HTTP errors instead of returning an error body as data
const J = (r: Response) => {
  if (!r.ok) throw new Error(`API ${r.status} ${r.url.split('/api')[1] ?? r.url}`)
  return r.json()
}

// error boundary so a render error shows a message instead of a blank page
class ThermalErrorBoundary extends Component<{ children: ReactNode }, { err?: Error }> {
  state: { err?: Error } = {}
  static getDerivedStateFromError(err: Error) { return { err } }
  render() {
    if (this.state.err) return (
      <div className="p-6">
        <div className="border border-red-700 bg-red-900/30 rounded p-4 text-sm">
          <div className="font-semibold text-red-400 mb-1">Thermal Twin hit an error</div>
          <pre className="whitespace-pre-wrap text-xs">{String(this.state.err.message)}</pre>
          <button onClick={() => this.setState({ err: undefined })}
            className="mt-2 px-3 py-1 rounded bg-slate-800 border border-slate-600">Retry</button>
        </div>
      </div>
    )
    return this.props.children
  }
}

export default function ThermalTwin() {
  return <ThermalErrorBoundary><ThermalTwinView /></ThermalErrorBoundary>
}

function ThermalTwinView() {
  const [mode, setMode] = useState<Mode>('live')
  const [geometry, setGeometry] = useState<Geometry>('cylindrical')
  const [faultOn, setFaultOn] = useState(true)
  const [basis, setBasis] = useState<Basis | null>(null)
  const [cellSim, setCellSim] = useState<CellSim | null>(null)
  const [packSim, setPackSim] = useState<PackSim | null>(null)
  const [cells, setCells] = useState<CellInfo[]>([])
  const [selectedCell, setSelectedCell] = useState<string>('')
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const isCellField = mode !== 'pack'

  // load the cell list when entering live mode
  useEffect(() => {
    if (mode !== 'live') return
    fetch('/api/thermal-twin/cells').then(J)
      .then(d => { setCells(d.cells || []); if (!selectedCell && d.cells?.length) setSelectedCell(d.cells[0].cell_id) })
      .catch(e => setErr(String(e)))
  }, [mode]) // eslint-disable-line react-hooks/exhaustive-deps

  // fetch the active dataset
  useEffect(() => {
    let cancelled = false
    setErr(null); setIdx(0)
    const loadGeom = () => fetch(`/api/thermal-twin/geometry?geometry=${geometry}&n=36`).then(J)

    if (mode === 'live') {
      setPackSim(null)
      if (!selectedCell) { setCellSim(null); return }
      Promise.all([loadGeom(), fetch(`/api/thermal-twin/cell/${selectedCell}/history?limit=400`).then(J)])
        .then(([b, h]) => { if (cancelled) return
          setBasis(b); setCellSim(h); setPlaying(false)
          setIdx(h.n > 0 ? h.n - 1 : 0) })            // follow latest
        .catch(e => !cancelled && setErr(String(e)))
    } else if (mode === 'cell') {
      setPackSim(null)
      Promise.all([loadGeom(), fetch('/api/thermal-twin/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry, n_steps: 600, cooling_fault: faultOn }) }).then(J)])
        .then(([b, s]) => { if (!cancelled) { setBasis(b); setCellSim(s); setPlaying(false) } })
        .catch(e => !cancelled && setErr(String(e)))
    } else {
      fetch('/api/thermal-twin/pack/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: 6, cols: 8, n_steps: 600, cooling_fault: faultOn }) }).then(J)
        .then(s => { if (!cancelled) { setPackSim(s); setPlaying(false) } })
        .catch(e => !cancelled && setErr(String(e)))
    }
    return () => { cancelled = true }
  }, [mode, geometry, faultOn, selectedCell])

  // LIVE auto-refresh: poll telemetry every 4s and follow the latest sample
  useEffect(() => {
    if (mode !== 'live' || !selectedCell) return
    const id = window.setInterval(() => {
      fetch(`/api/thermal-twin/cell/${selectedCell}/history?limit=400`).then(J)
        .then(h => { setCellSim(h); if (!playing && h.n > 0) setIdx(h.n - 1) }).catch(() => {})
    }, 4000)
    return () => window.clearInterval(id)
  }, [mode, selectedCell, playing])

  const activeN = mode === 'pack' ? (packSim?.n_frames ?? 0) : (cellSim?.n ?? 0)
  const faultStep = mode === 'pack' ? packSim?.fault_step : cellSim?.fault_step

  useEffect(() => {
    if (!playing || activeN === 0) return
    const step = Math.max(1, Math.floor(activeN / 300))
    timer.current = window.setInterval(() => setIdx(p => (p + step) % activeN), 60)
    return () => { if (timer.current) window.clearInterval(timer.current) }
  }, [playing, activeN])

  const cellFrame = cellSim?.frames?.[Math.min(idx, (cellSim?.n ?? 1) - 1)]
  const cellField = useMemo(() => {
    if (!isCellField || !basis || !cellFrame) return null
    const { core, surface } = cellFrame, clim = basis.clim, span = clim[1] - clim[0]
    const Tn = new Array(basis.x.length), z = new Array(basis.x.length)
    for (let n = 0; n < basis.x.length; n++) {
      const c = basis.chi_core[n], t = core * c + surface * (1 - c)
      Tn[n] = t; z[n] = ((t - clim[0]) / span) * RELIEF
    }
    const zg: (number | null)[][] = []
    for (let r = 0; r < basis.ny; r++) {
      const row: (number | null)[] = []
      for (let cc = 0; cc < basis.nx; cc++) {
        const cv = basis.chi_core_grid[r * basis.nx + cc]
        row.push(cv === null ? null : core * cv + surface * (1 - cv))
      }
      zg.push(row)
    }
    return { Tn, z, zg }
  }, [isCellField, basis, cellFrame])

  const packFrame = packSim?.frames?.[Math.min(idx, (packSim?.n_frames ?? 1) - 1)]
  const packGrid = useMemo(() => {
    if (mode !== 'pack' || !packSim || !packFrame) return null
    const g: number[][] = []
    for (let r = 0; r < packSim.rows; r++) g.push(packFrame.cells.slice(r * packSim.cols, (r + 1) * packSim.cols))
    return g
  }, [mode, packSim, packFrame])

  // ── 3D battery geometry (cutaway cell + pack of cells) ─────────────────
  const cellGeo = useMemo(() => geometry === 'cylindrical' ? cylinderCutaway() : slabCutaway(), [geometry])
  const termGeo = useMemo(() => terminalNub(geometry), [geometry])
  const cellIntensity = useMemo(() => {
    if (!isCellField || !cellFrame) return null
    const { core, surface } = cellFrame
    return cellGeo.W.map(w => surface + (core - surface) * w)
  }, [isCellField, cellFrame, cellGeo])
  const packGeo = useMemo(() => (packSim ? packCylinders(packSim.rows, packSim.cols) : null),
    [packSim?.rows, packSim?.cols])
  const packIntensity = useMemo(() => {
    if (mode !== 'pack' || !packGeo || !packFrame) return null
    return packGeo.CELL.map(ci => packFrame.cells[ci] ?? 25)
  }, [mode, packGeo, packFrame])
  const cellScene = geometry === 'cylindrical'
    ? { aspectratio: { x: 1, y: 1, z: 1.6 }, camera: { eye: { x: 1.7, y: -1.5, z: 0.85 } } }
    : { aspectratio: { x: 1.1, y: 0.5, z: 1.5 }, camera: { eye: { x: 0.7, y: 2.0, z: 0.5 } } }

  const clim = (mode === 'pack' ? packSim?.clim : (cellSim?.clim ?? basis?.clim)) ?? [20, 65]
  const status = mode === 'pack' ? packFrame?.status : cellFrame?.status
  const liveNoData = mode === 'live' && cellSim && cellSim.has_data === false

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center gap-3">
        <Box className="text-orange-400" />
        <h1 className="text-2xl font-semibold">Thermal Twin — live core-temperature field</h1>
      </div>
      <p className="text-sm text-text-secondary">
        Virtual-senses unmeasurable core temperature and reconstructs the full thermal field in real time.
        Live mode reads <code className="text-orange-300">cell_timeseries</code> telemetry; demo modes inject a cooling fault to show protective derating.
      </p>

      {/* controls */}
      <div className="bg-slate-800/60 rounded p-3 border border-slate-700 flex flex-wrap items-center gap-3 text-sm">
        {(['live', 'cell', 'pack'] as Mode[]).map(m => (
          <button key={m} onClick={() => { setMode(m); setPlaying(false) }}
            className={`px-3 py-1 rounded border flex items-center gap-1 ${mode === m
              ? 'bg-orange-700 border-orange-500' : 'bg-slate-900 border-slate-700 hover:bg-slate-800'}`}>
            {m === 'live' ? <Radio size={14} /> : m === 'cell' ? <CircleDot size={14} /> : <Grid3x3 size={14} />}
            {m === 'live' ? 'Live telemetry' : m === 'cell' ? 'Cell demo' : 'Pack'}
          </button>
        ))}
        <span className="w-px h-5 bg-slate-700" />
        {mode === 'live' && (
          <select value={selectedCell} onChange={e => setSelectedCell(e.target.value)}
            className="bg-slate-900 border border-slate-700 rounded px-2 py-1">
            {cells.length === 0 && <option value="">(no cells)</option>}
            {cells.map(c => <option key={c.cell_id} value={c.cell_id}>{c.cell_id} ({c.n_points})</option>)}
          </select>
        )}
        {isCellField && (['cylindrical', 'pouch'] as Geometry[]).map(g => (
          <button key={g} onClick={() => setGeometry(g)}
            className={`px-3 py-1 rounded border ${geometry === g ? 'bg-orange-700 border-orange-500' : 'bg-slate-900 border-slate-700 hover:bg-slate-800'}`}>{g}</button>
        ))}
        {mode !== 'live' && (
          <button onClick={() => setFaultOn(f => !f)}
            className={`px-3 py-1 rounded border flex items-center gap-1 ${faultOn ? 'bg-amber-800 border-amber-600' : 'bg-slate-900 border-slate-700 hover:bg-slate-800'}`}>
            <Snowflake size={14} /> cooling fault {faultOn ? 'ON' : 'OFF'}
          </button>
        )}
        <span className="w-px h-5 bg-slate-700" />
        <button onClick={() => setPlaying(p => !p)} className="px-3 py-1 rounded bg-orange-700 hover:bg-orange-600 border border-orange-500 flex items-center gap-1">
          {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : (mode === 'live' ? 'Replay' : 'Play')}
        </button>
        <button onClick={() => setIdx(0)} className="px-3 py-1 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 flex items-center gap-1">
          <RotateCcw size={14} /> Restart
        </button>
        {activeN > 0 && (
          <input type="range" min={0} max={activeN - 1} value={Math.min(idx, activeN - 1)}
            onChange={e => { setPlaying(false); setIdx(Number(e.target.value)) }} className="flex-1 min-w-[160px] accent-orange-500" />
        )}
        {mode === 'live' && <span className="text-[10px] text-emerald-400 flex items-center gap-1"><Radio size={11} /> auto-refresh 4s</span>}
      </div>

      {err && <div className="border border-red-700 bg-red-900/30 rounded p-3 flex items-center gap-2 text-sm"><AlertTriangle size={16} /> {err}</div>}
      {liveNoData && <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2 text-sm"><AlertTriangle size={16} /> No telemetry for this cell yet. Pick another cell or stream data into cell_timeseries.</div>}

      {/* HUD */}
      {isCellField && cellFrame && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Kpi label="core temp" value={`${cellFrame.core.toFixed(1)} °C`} accent />
          <Kpi label="±1σ" value={`${cellFrame.core_sigma.toFixed(1)} °C`} />
          <Kpi label="surface" value={`${cellFrame.surface.toFixed(1)} °C`} />
          <Kpi label="current" value={`${cellFrame.current.toFixed(1)} A`} />
          <Kpi label="torque cmd" value={`${Math.round(cellFrame.derate * 100)} %`} />
          <Kpi label={mode === 'live' ? 'SOC' : 'cooling'} value={mode === 'live' ? `${(cellFrame.soc * 100).toFixed(0)} %` : `${Math.round(cellFrame.cooling * 100)} %`} />
        </div>
      )}
      {mode === 'pack' && packFrame && packSim && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Kpi label="max core" value={`${packFrame.max_core.toFixed(1)} °C`} accent />
          <Kpi label="hottest cell" value={`r${Math.floor(packFrame.hottest / packSim.cols)} c${packFrame.hottest % packSim.cols}`} />
          <Kpi label="weak cell" value={`r${Math.floor(packSim.weak_idx / packSim.cols)} c${packSim.weak_idx % packSim.cols}`} />
          <Kpi label="torque cmd" value={`${Math.round(packFrame.derate * 100)} %`} />
          <Kpi label="cells" value={`${packSim.n_cells}`} />
        </div>
      )}
      {status && (
        <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border text-sm font-semibold ${STATUS_COLOR[status] ?? ''}`}>
          <Thermometer size={15} /> {status}
          {faultStep != null && idx >= faultStep && <span className="font-normal opacity-80">· cooling fault active</span>}
          {mode === 'live' && cellFrame?.ts && <span className="font-normal opacity-70">· {cellFrame.ts}</span>}
        </div>
      )}

      {/* plots */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-slate-800/60 rounded p-2 border border-slate-700">
          <div className="text-xs text-text-muted mb-1 px-2">3D thermal field (height + colour = temperature)</div>
          {isCellField && cellIntensity && (
            <Plot data={[
                { type: 'mesh3d', x: cellGeo.X, y: cellGeo.Y, z: cellGeo.Z, i: cellGeo.I, j: cellGeo.J, k: cellGeo.K,
                  intensity: cellIntensity, intensitymode: 'vertex', colorscale: 'Inferno', cmin: clim[0], cmax: clim[1],
                  showscale: true, colorbar: { title: '°C', len: 0.7 }, flatshading: false,
                  lighting: { ambient: 0.6, diffuse: 0.7, specular: 0.15 } },
                { type: 'mesh3d', x: termGeo.X, y: termGeo.Y, z: termGeo.Z, i: termGeo.I, j: termGeo.J, k: termGeo.K,
                  color: '#9aa3ad', showscale: false, lighting: { ambient: 0.7, diffuse: 0.5 } },
              ] as any}
              layout={{ paper_bgcolor: 'rgba(0,0,0,0)', height: 420, autosize: true, margin: { l: 0, r: 0, t: 0, b: 0 },
                scene: { xaxis: { visible: false }, yaxis: { visible: false }, zaxis: { visible: false },
                  aspectmode: 'manual', aspectratio: cellScene.aspectratio, camera: cellScene.camera } } as any}
              config={{ displayModeBar: false, responsive: true } as any} style={{ width: '100%' }} useResizeHandler />
          )}
          {mode === 'pack' && packIntensity && packGeo && (
            <Plot data={[{ type: 'mesh3d', x: packGeo.X, y: packGeo.Y, z: packGeo.Z, i: packGeo.I, j: packGeo.J, k: packGeo.K,
                intensity: packIntensity, intensitymode: 'vertex', colorscale: 'Inferno', cmin: clim[0], cmax: clim[1],
                showscale: true, colorbar: { title: '°C', len: 0.7 }, flatshading: true,
                lighting: { ambient: 0.65, diffuse: 0.6 } }] as any}
              layout={{ paper_bgcolor: 'rgba(0,0,0,0)', height: 420, autosize: true, margin: { l: 0, r: 0, t: 0, b: 0 },
                scene: { xaxis: { visible: false }, yaxis: { visible: false }, zaxis: { visible: false },
                  aspectmode: 'data', camera: { eye: { x: 1.3, y: -1.7, z: 1.3 } } } } as any}
              config={{ displayModeBar: false, responsive: true } as any} style={{ width: '100%' }} useResizeHandler />
          )}
        </div>
        <div className="bg-slate-800/60 rounded p-2 border border-slate-700">
          <div className="text-xs text-text-muted mb-1 px-2">2D heatmap{mode === 'pack' ? ' (per-cell)' : ' (cross-section)'}</div>
          {isCellField && cellField && basis && (
            <Plot data={[{ type: 'heatmap', x: basis.grid_x, y: basis.grid_y, z: cellField.zg, colorscale: 'Inferno', zmin: clim[0], zmax: clim[1], colorbar: { title: '°C', len: 0.7 } }] as any}
              layout={{ paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', height: 420, autosize: true, margin: { l: 0, r: 0, t: 0, b: 0 },
                xaxis: { visible: false, scaleanchor: 'y', constrain: 'domain' }, yaxis: { visible: false } } as any}
              config={{ displayModeBar: false, responsive: true } as any} style={{ width: '100%' }} useResizeHandler />
          )}
          {mode === 'pack' && packGrid && packSim && packFrame && (
            <Plot data={[
                { type: 'heatmap', z: packGrid, colorscale: 'Inferno', zmin: clim[0], zmax: clim[1], xgap: 2, ygap: 2, colorbar: { title: '°C', len: 0.7 } },
                { type: 'scatter', mode: 'markers', x: [packFrame.hottest % packSim.cols], y: [Math.floor(packFrame.hottest / packSim.cols)],
                  marker: { symbol: 'x', size: 14, color: 'cyan', line: { width: 2 } }, hoverinfo: 'skip' },
              ] as any}
              layout={{ paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', height: 420, autosize: true, margin: { l: 20, r: 0, t: 0, b: 20 },
                xaxis: { title: 'column', dtick: 1 }, yaxis: { title: 'row', dtick: 1, scaleanchor: 'x' }, showlegend: false } as any}
              config={{ displayModeBar: false, responsive: true } as any} style={{ width: '100%' }} useResizeHandler />
          )}
        </div>
      </div>
      <p className="text-xs text-text-muted">
        Live = real cell_timeseries telemetry → physics core-temp virtual sensor (2-state thermal model),
        field = core·χ + surface·(1−χ). Upgrade path: DeepONet/Mamba estimator, PyBaMM-validated labels, liionpack pack data.
      </p>
    </div>
  )
}

function Kpi({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-slate-800/60 rounded p-3 border border-slate-700">
      <div className={`text-xl font-bold ${accent ? 'text-orange-400' : ''}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{label}</div>
    </div>
  )
}

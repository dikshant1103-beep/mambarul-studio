import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Activity, RefreshCw } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { Skeleton, SkeletonChart } from '../components/ui/Skeleton'
import { ExportCSV } from '../components/ui/ExportButton'

const CALCE_CELLS = ['CS2_33','CS2_34','CS2_35','CS2_36','CS2_37','CS2_38']
const CHEM_COLOR = '#3b82f6'

interface FileInfo { filename: string; stem: string }
interface CycleData {
  cell_id: string; filename: string; n_points: number
  time_s: (number|null)[]; current_A: (number|null)[]; voltage_V: (number|null)[]
  temperature_C: (number|null)[]; discharge_mask: boolean[]; charge_mask: boolean[]
}

export default function RawSignalViewer() {
  const [selectedCell, setSelectedCell] = useState('CS2_37')
  const [files, setFiles] = useState<FileInfo[]>([])
  const [selectedFile, setSelectedFile] = useState<string>('')
  const [cycleData, setCycleData] = useState<CycleData | null>(null)
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loadingCycle, setLoadingCycle] = useState(false)
  const [showPhase, setShowPhase] = useState<'all'|'discharge'|'charge'>('all')

  useEffect(() => {
    setLoadingFiles(true)
    fetch(`/api/raw-signals/${selectedCell}/files`)
      .then(r => r.ok ? r.json() : [])
      .then((f: FileInfo[]) => { setFiles(f); if (f.length) setSelectedFile(f[0].filename) })
      .catch(() => setFiles([]))
      .finally(() => setLoadingFiles(false))
  }, [selectedCell])

  useEffect(() => {
    if (!selectedFile) return
    setLoadingCycle(true)
    fetch(`/api/raw-signals/${selectedCell}/cycle?filename=${encodeURIComponent(selectedFile)}`)
      .then(r => r.ok ? r.json() : null)
      .then(setCycleData)
      .catch(() => setCycleData(null))
      .finally(() => setLoadingCycle(false))
  }, [selectedCell, selectedFile])

  const filter = (arr: (number|null)[], mask?: boolean[]) => {
    if (!mask || showPhase === 'all') return arr
    return arr.map((v, i) => (showPhase === 'discharge' ? mask[i] : !mask[i] && (cycleData?.charge_mask[i] ?? false)) ? v : null)
  }

  const exportData = cycleData ? cycleData.time_s.map((t, i) => ({
    time_s: t, voltage_V: cycleData.voltage_V[i],
    current_A: cycleData.current_A[i], temperature_C: cycleData.temperature_C[i]
  })) : []

  const hasTemp = cycleData?.temperature_C?.some(v => v !== null && v !== 0)

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Activity size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Raw Signal Viewer</h1>
        </div>
        <p className="text-text-secondary">Actual per-timestep V/I/T signals from CALCE CS2 XLSX files</p>
      </div>

      <div className="flex gap-5">
        {/* Selector panel */}
        <div className="w-56 flex-shrink-0 space-y-4">
          <div className="panel p-4">
            <div className="metric-label mb-2">Cell</div>
            <div className="space-y-1">
              {CALCE_CELLS.map(c => (
                <button key={c} onClick={() => setSelectedCell(c)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${
                    selectedCell === c ? 'bg-brand-blue/10 text-brand-blue border border-brand-blue/30' : 'text-text-secondary hover:bg-bg-elevated'
                  }`}>
                  <span className="font-mono">{c}</span>
                  {(c === 'CS2_37' || c === 'CS2_38') && (
                    <span className="ml-2 badge badge-blue text-xs">test</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <div className="panel p-4">
            <div className="metric-label mb-2">Measurement File</div>
            {loadingFiles ? (
              <div className="space-y-1">{[1,2,3].map(i => <Skeleton key={i} className="h-8 w-full" />)}</div>
            ) : (
              <div className="max-h-64 overflow-y-auto space-y-0.5">
                {files.map(f => (
                  <button key={f.filename} onClick={() => setSelectedFile(f.filename)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs font-mono transition-all ${
                      selectedFile === f.filename ? 'bg-brand-blue/20 text-brand-blue' : 'text-text-muted hover:bg-bg-elevated'
                    }`}>
                    {f.stem}
                  </button>
                ))}
                {!files.length && <div className="text-xs text-text-muted p-2">No XLSX files found</div>}
              </div>
            )}
          </div>

          <div className="panel p-4">
            <div className="metric-label mb-2">Phase Filter</div>
            {(['all','discharge','charge'] as const).map(p => (
              <button key={p} onClick={() => setShowPhase(p)}
                className={`w-full text-left px-3 py-1.5 rounded text-xs mb-1 capitalize transition-all ${
                  showPhase === p ? 'bg-brand-blue/10 text-brand-blue border border-brand-blue/20' : 'text-text-muted hover:bg-bg-elevated'
                }`}>{p}</button>
            ))}
          </div>

          {cycleData && (
            <ExportCSV data={exportData} filename={`${selectedCell}_${selectedFile}_raw.csv`} label="Export CSV" />
          )}
        </div>

        {/* Charts */}
        <div className="flex-1 space-y-4 min-w-0">
          {cycleData && (
            <div className="panel p-4 flex items-center gap-6">
              <div><div className="metric-label">Cell</div><div className="font-mono text-sm text-text-accent">{cycleData.cell_id}</div></div>
              <div><div className="metric-label">Data Points</div><div className="font-mono text-sm text-text-secondary">{cycleData.n_points.toLocaleString()}</div></div>
              <div><div className="metric-label">File</div><div className="font-mono text-xs text-text-muted truncate max-w-48">{cycleData.filename}</div></div>
              {loadingCycle && <RefreshCw size={15} className="text-brand-blue animate-spin ml-auto" />}
            </div>
          )}

          {loadingCycle ? (
            <>
              <SkeletonChart height={200} />
              <SkeletonChart height={180} />
            </>
          ) : cycleData ? (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-4">
              {/* Voltage */}
              <div className="panel p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="section-title">Voltage (V)</h3>
                  <code className="text-xs text-text-muted font-mono">CALCE CS2 LCO · {CHEM_COLOR}</code>
                </div>
                <Plot
                  data={[{
                    type: 'scatter', mode: 'lines', name: 'Voltage (V)',
                    x: filter(cycleData.time_s, cycleData.discharge_mask),
                    y: filter(cycleData.voltage_V, cycleData.discharge_mask),
                    line: { color: CHEM_COLOR, width: 1.5 },
                    connectgaps: false,
                  }]}
                  layout={{ ...darkLayout, height: 200,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Time (s)', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'Voltage (V)', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              {/* Current */}
              <div className="panel p-5">
                <h3 className="section-title mb-3">Current (A)</h3>
                <Plot
                  data={[{
                    type: 'scatter', mode: 'lines', name: 'Current (A)',
                    x: filter(cycleData.time_s),
                    y: filter(cycleData.current_A),
                    line: { color: '#10b981', width: 1.5 },
                    connectgaps: false,
                  }]}
                  layout={{ ...darkLayout, height: 180,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Time (s)', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'Current (A)', font: { color: '#64748b' } }, zeroline: true },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              {/* Temperature + V on same axis */}
              <div className="panel p-5">
                <h3 className="section-title mb-3">Voltage vs Current (Phase Diagram)</h3>
                <Plot
                  data={[{
                    type: 'scatter', mode: 'markers',
                    name: 'V vs I',
                    x: cycleData.current_A,
                    y: cycleData.voltage_V,
                    marker: {
                      color: cycleData.time_s,
                      colorscale: 'Viridis',
                      size: 3, opacity: 0.7,
                      colorbar: { title: { text: 'Time (s)', font: { color: '#94a3b8' } }, tickfont: { color: '#64748b', size: 9 }, thickness: 12 },
                    },
                  }]}
                  layout={{ ...darkLayout, height: 220,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Current (A)', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'Voltage (V)', font: { color: '#64748b' } } },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              {hasTemp && (
                <div className="panel p-5">
                  <h3 className="section-title mb-3">Temperature (°C)</h3>
                  <Plot
                    data={[{
                      type: 'scatter', mode: 'lines', name: 'Temperature',
                      x: cycleData.time_s, y: cycleData.temperature_C,
                      line: { color: '#f59e0b', width: 1.5 }, connectgaps: false,
                    }]}
                    layout={{ ...darkLayout, height: 160,
                      xaxis: { ...darkLayout.xaxis as object, title: { text: 'Time (s)', font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: 'Temp (°C)', font: { color: '#64748b' } } },
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                </div>
              )}
            </motion.div>
          ) : (
            <div className="panel p-16 text-center text-text-muted text-sm">
              Select a cell and measurement file to view raw signals
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

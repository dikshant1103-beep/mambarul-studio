import { useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeftRight, ExternalLink, Columns2 } from 'lucide-react'

// ---------------------------------------------------------------------------
// Route registry — all app routes with friendly names
// ---------------------------------------------------------------------------
const ROUTES: { path: string; label: string }[] = [
  { path: '/',                 label: 'Home' },
  { path: '/datasets',         label: 'Dataset Explorer' },
  { path: '/features',         label: 'Feature Engineering' },
  { path: '/feature-graphs',   label: 'Feature Graphs' },
  { path: '/leakage',          label: 'Leakage Audit' },
  { path: '/models',           label: 'Model Gallery' },
  { path: '/model-versions',   label: 'Model Versions' },
  { path: '/benchmark',        label: 'Benchmark Dashboard' },
  { path: '/predict',          label: 'Live Prediction' },
  { path: '/explainability',   label: 'Explainability' },
  { path: '/thesis',           label: 'Thesis Explorer' },
  { path: '/raw-signals',      label: 'Raw Signal Viewer' },
  { path: '/predictions',      label: 'Predictions' },
  { path: '/training',         label: 'Training Pipeline' },
  { path: '/training-log',     label: 'Training Animation' },
  { path: '/analysis',         label: 'Analysis Hub' },
  { path: '/conformal',        label: 'Conformal Prediction' },
  { path: '/chemistry',        label: 'Chemistry Explorer' },
  { path: '/oxford',           label: 'Oxford Analysis' },
  { path: '/pybamm',           label: 'PyBaMM Synthetic' },
  { path: '/ablation',         label: 'Ablation Study' },
  { path: '/bms',              label: 'BMS Dashboard' },
  { path: '/discoveries',      label: 'Key Discoveries' },
  { path: '/physics',          label: 'Physics Visualizer' },
  { path: '/architecture',     label: 'Architecture Insights' },
  { path: '/upload',           label: 'Upload & Predict' },
  { path: '/neuron',           label: 'Neuron Animation' },
  { path: '/experiment-replay',label: 'Experiment Replay' },
  { path: '/battery-lab',      label: 'Battery Lab' },
  { path: '/mae',              label: 'MAE Visualizer' },
  { path: '/per-cell',         label: 'Per-Cell Predictions' },
  { path: '/chemistry-3d',     label: 'Chemistry Molecular 3D' },
  { path: '/model-race',       label: 'Model Race' },
  { path: '/multi-cell',       label: 'Multi-Cell Overlay' },
  { path: '/aging-sim',        label: 'Battery Aging Simulator' },
  { path: '/pca',              label: 'PCA Explorer' },
  { path: '/oxford-finetune',  label: 'Oxford Fine-Tune (Animated)' },
  { path: '/training-real',    label: 'Training Log Replay' },
  { path: '/nasa',             label: 'NASA Zero-Shot' },
  { path: '/conformal-real',   label: 'Conformal (Real)' },
  { path: '/shap-real',        label: 'SHAP Interactive' },
  { path: '/oxford-loocv',     label: 'Oxford LOOCV' },
  { path: '/early-pred',       label: 'Early Prediction' },
  { path: '/error-dist',       label: 'Error Distribution' },
  { path: '/oxford-fewshot',   label: 'Oxford Few-Shot' },
  { path: '/v11',              label: 'v11 Results' },
  { path: '/version-ladder',   label: 'Version Ladder' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function SideBySide() {
  const [leftPath, setLeftPath]   = useState('/')
  const [rightPath, setRightPath] = useState('/benchmark')

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  const swap = useCallback(() => {
    setLeftPath(p => {
      setRightPath(p)
      return rightPath
    })
  }, [rightPath])

  const openLeft  = () => window.open(origin + leftPath,  '_blank', 'noopener')
  const openRight = () => window.open(origin + rightPath, '_blank', 'noopener')

  return (
    <div
      className="flex flex-col"
      style={{ height: '100vh', background: '#0a0e1a', overflow: 'hidden' }}
    >
      {/* Top control bar */}
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        className="flex items-center gap-3 px-4 py-2 shrink-0 border-b"
        style={{
          background: '#1a2233',
          borderColor: '#1e3a5f',
          height: 56,
          zIndex: 10,
        }}
      >
        {/* Icon + title */}
        <div className="flex items-center gap-2 shrink-0 mr-2">
          <Columns2 size={16} className="text-blue-400" />
          <span className="text-sm font-semibold text-slate-300 hidden sm:inline">
            Side-by-Side
          </span>
        </div>

        {/* Left selector */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <label className="text-xs text-slate-500 shrink-0">Left</label>
          <select
            value={leftPath}
            onChange={e => setLeftPath(e.target.value)}
            className="flex-1 min-w-0 text-xs rounded px-2 py-1.5 border outline-none focus:border-blue-500 transition-colors truncate"
            style={{
              background: '#0a0e1a',
              borderColor: '#1e3a5f',
              color: '#cbd5e1',
            }}
          >
            {ROUTES.map(r => (
              <option key={r.path} value={r.path}>
                {r.label} ({r.path})
              </option>
            ))}
          </select>
        </div>

        {/* Swap button */}
        <button
          onClick={swap}
          title="Swap panels"
          className="shrink-0 p-1.5 rounded hover:bg-white/10 transition-colors text-slate-400 hover:text-blue-400"
        >
          <ArrowLeftRight size={15} />
        </button>

        {/* Right selector */}
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <label className="text-xs text-slate-500 shrink-0">Right</label>
          <select
            value={rightPath}
            onChange={e => setRightPath(e.target.value)}
            className="flex-1 min-w-0 text-xs rounded px-2 py-1.5 border outline-none focus:border-blue-500 transition-colors truncate"
            style={{
              background: '#0a0e1a',
              borderColor: '#1e3a5f',
              color: '#cbd5e1',
            }}
          >
            {ROUTES.map(r => (
              <option key={r.path} value={r.path}>
                {r.label} ({r.path})
              </option>
            ))}
          </select>
        </div>

        {/* Open buttons */}
        <div className="flex items-center gap-1 shrink-0 ml-1">
          <button
            onClick={openLeft}
            title="Open left panel in new tab"
            className="flex items-center gap-1 text-xs px-2 py-1.5 rounded border transition-colors hover:border-blue-500 hover:text-blue-400"
            style={{ borderColor: '#1e3a5f', color: '#64748b', background: 'transparent' }}
          >
            <ExternalLink size={11} />
            <span className="hidden md:inline">Left</span>
          </button>
          <button
            onClick={openRight}
            title="Open right panel in new tab"
            className="flex items-center gap-1 text-xs px-2 py-1.5 rounded border transition-colors hover:border-blue-500 hover:text-blue-400"
            style={{ borderColor: '#1e3a5f', color: '#64748b', background: 'transparent' }}
          >
            <ExternalLink size={11} />
            <span className="hidden md:inline">Right</span>
          </button>
        </div>
      </motion.div>

      {/* Iframe pair */}
      <div className="flex flex-1 min-h-0">
        {/* Left iframe */}
        <IFramePanel key={`left-${leftPath}`} src={origin + leftPath} side="left" />

        {/* Divider */}
        <div
          className="w-px shrink-0"
          style={{ background: '#1e3a5f' }}
        />

        {/* Right iframe */}
        <IFramePanel key={`right-${rightPath}`} src={origin + rightPath} side="right" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// IFramePanel sub-component
// ---------------------------------------------------------------------------
function IFramePanel({ src, side }: { src: string; side: 'left' | 'right' }) {
  return (
    <div className="flex-1 min-w-0 relative">
      <iframe
        src={src}
        title={`${side} panel`}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
          background: '#0a0e1a',
        }}
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  )
}

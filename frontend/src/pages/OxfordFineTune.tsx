import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Play, Pause, RotateCcw, Zap } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface Step {
  k: number
  rmse: number
  r2: number
  cell7_rmse: number
  cell7_r2: number
  cell8_rmse: number
  cell8_r2: number
}

interface FineTuneData {
  steps: Step[]
  baseline: { rmse: number; r2: number }
  final: { rmse: number; r2: number }
}

type Speed = 1 | 2 | 5

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SPEEDS: Speed[] = [1, 2, 5]
const TOTAL_STEPS = 50

const COLOR_CELL7 = '#06b6d4'   // cyan
const COLOR_CELL8 = '#f59e0b'   // amber
const COLOR_AVG   = '#10b981'   // emerald

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(n: number, decimals = 1) {
  return Number.isFinite(n) ? n.toFixed(decimals) : '—'
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

// Interpolate a value from baseline toward final, at step k/total
function interpolateMetric(baseline: number, final: number, k: number, total: number) {
  if (k <= 0) return baseline
  if (k >= total) return final
  // Non-linear: fast drop at first, plateau near end
  const t = 1 - Math.pow(1 - k / total, 2.2)
  return lerp(baseline, final, t)
}

// Build Plotly traces up to a given step index
function buildTraces(steps: Step[], upTo: number): Plotly.Data[] {
  const slice = steps.slice(0, upTo + 1)
  const ks = slice.map(s => s.k)

  return [
    // --- RMSE traces (left Y axis) ---
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Cell 7 RMSE',
      x: ks,
      y: slice.map(s => s.cell7_rmse),
      yaxis: 'y',
      line: { color: COLOR_CELL7, width: 2 },
      marker: { color: COLOR_CELL7, size: 4 },
      hovertemplate: 'K=%{x}<br>Cell 7 RMSE: %{y:.1f}<extra></extra>',
    } as Plotly.Data,
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Cell 8 RMSE',
      x: ks,
      y: slice.map(s => s.cell8_rmse),
      yaxis: 'y',
      line: { color: COLOR_CELL8, width: 2 },
      marker: { color: COLOR_CELL8, size: 4 },
      hovertemplate: 'K=%{x}<br>Cell 8 RMSE: %{y:.1f}<extra></extra>',
    } as Plotly.Data,
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Avg RMSE',
      x: ks,
      y: slice.map(s => s.rmse),
      yaxis: 'y',
      line: { color: COLOR_AVG, width: 2.5, dash: 'dot' },
      marker: { color: COLOR_AVG, size: 5 },
      hovertemplate: 'K=%{x}<br>Avg RMSE: %{y:.1f}<extra></extra>',
    } as Plotly.Data,
    // --- R² traces (right Y axis) ---
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Cell 7 R²',
      x: ks,
      y: slice.map(s => s.cell7_r2),
      yaxis: 'y2',
      line: { color: COLOR_CELL7, width: 1.5, dash: 'dash' },
      marker: { color: COLOR_CELL7, size: 3, symbol: 'diamond' },
      opacity: 0.7,
      hovertemplate: 'K=%{x}<br>Cell 7 R²: %{y:.3f}<extra></extra>',
    } as Plotly.Data,
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Cell 8 R²',
      x: ks,
      y: slice.map(s => s.cell8_r2),
      yaxis: 'y2',
      line: { color: COLOR_CELL8, width: 1.5, dash: 'dash' },
      marker: { color: COLOR_CELL8, size: 3, symbol: 'diamond' },
      opacity: 0.7,
      hovertemplate: 'K=%{x}<br>Cell 8 R²: %{y:.3f}<extra></extra>',
    } as Plotly.Data,
    {
      type: 'scatter',
      mode: 'lines+markers',
      name: 'Avg R²',
      x: ks,
      y: slice.map(s => s.r2),
      yaxis: 'y2',
      line: { color: COLOR_AVG, width: 2, dash: 'dashdot' },
      marker: { color: COLOR_AVG, size: 4, symbol: 'diamond' },
      opacity: 0.85,
      hovertemplate: 'K=%{x}<br>Avg R²: %{y:.3f}<extra></extra>',
    } as Plotly.Data,
  ]
}

// ---------------------------------------------------------------------------
// Fallback mock data (used when API is unavailable during development)
// ---------------------------------------------------------------------------
function generateMockSteps(): Step[] {
  const steps: Step[] = []
  for (let k = 1; k <= TOTAL_STEPS; k++) {
    const baseRmse = 2276.1
    const finalRmse = 101.6
    const baseR2 = -1.447
    const finalR2 = 0.995
    const t = 1 - Math.pow(1 - k / TOTAL_STEPS, 2.2)
    const rmse   = lerp(baseRmse, finalRmse, t)
    const r2     = lerp(baseR2, finalR2, t)
    const noise  = (Math.random() - 0.5) * rmse * 0.08
    steps.push({
      k,
      rmse,
      r2,
      cell7_rmse: Math.max(10, rmse - 5 + noise),
      cell7_r2: Math.min(1, r2 + Math.random() * 0.02),
      cell8_rmse: Math.max(10, rmse + 10 - noise),
      cell8_r2: Math.min(1, r2 - Math.random() * 0.02),
    })
  }
  return steps
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------
export default function OxfordFineTune() {
  const [rawData, setRawData] = useState<FineTuneData | null>(null)
  const [loading, setLoading] = useState(true)
  const [isMock, setIsMock]   = useState(false)
  const [currentStep, setCurrentStep] = useState(0)   // 0-based index into steps[]
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<Speed>(1)
  const intervalRef = useRef<ReturnType<typeof setInterval>>()

  // Fetch data
  useEffect(() => {
    setLoading(true)
    fetch('/api/oxford/finetune-steps')
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((d: FineTuneData) => setRawData(d))
      .catch(() => {
        // Use mock data so the UI is functional without backend — but flag it.
        setRawData({
          steps: generateMockSteps(),
          baseline: { rmse: 2276.1, r2: -1.447 },
          final: { rmse: 101.6, r2: 0.995 },
        })
        setIsMock(true)
      })
      .finally(() => setLoading(false))
  }, [])

  const maxStepIdx = (rawData?.steps.length ?? TOTAL_STEPS) - 1

  // Playback ticker
  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setCurrentStep(prev => {
          const next = prev + 1
          if (next > maxStepIdx) {
            setPlaying(false)
            return maxStepIdx
          }
          return next
        })
      }, Math.round(300 / speed))
    } else {
      clearInterval(intervalRef.current)
    }
    return () => clearInterval(intervalRef.current)
  }, [playing, speed, maxStepIdx])

  const handleReset = useCallback(() => {
    setPlaying(false)
    setCurrentStep(0)
  }, [])

  const handleSlider = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPlaying(false)
    setCurrentStep(Number(e.target.value))
  }

  const steps = rawData?.steps ?? []
  const baseline = rawData?.baseline ?? { rmse: 2276.1, r2: -1.447 }
  const final = rawData?.final ?? { rmse: 101.6, r2: 0.995 }

  const stepData = steps[currentStep]
  const kDisplay = stepData?.k ?? currentStep + 1
  const pct = maxStepIdx > 0 ? (currentStep / maxStepIdx) * 100 : 0

  // Live metric values
  const liveRmse = stepData?.rmse   ?? interpolateMetric(baseline.rmse, final.rmse, currentStep + 1, TOTAL_STEPS)
  const liveR2   = stepData?.r2     ?? interpolateMetric(baseline.r2,   final.r2,   currentStep + 1, TOTAL_STEPS)

  // Traces
  const traces = steps.length > 0 ? buildTraces(steps, currentStep) : []

  const dualLayout: Partial<Plotly.Layout> = {
    ...darkLayout,
    height: 380,
    margin: { t: 20, b: 55, l: 65, r: 70 },
    xaxis: {
      ...(darkLayout.xaxis as object),
      title: { text: 'K (calibration cycles)', font: { color: '#64748b' } },
      range: [0, TOTAL_STEPS + 1],
    },
    yaxis: {
      ...(darkLayout.yaxis as object),
      title: { text: 'RMSE (cycles)', font: { color: '#64748b' } },
      rangemode: 'tozero',
    },
    yaxis2: {
      ...(darkLayout.yaxis as object),
      title: { text: 'R²', font: { color: '#94a3b8' } },
      overlaying: 'y',
      side: 'right',
      showgrid: false,
      range: [-1.8, 1.1],
      zeroline: true,
      zerolinecolor: '#1e3a5f',
    },
    legend: {
      ...darkLayout.legend,
      x: 0.5,
      y: 1.08,
      xanchor: 'center',
      orientation: 'h',
    },
    transition: { duration: 80, easing: 'linear' },
  } as Partial<Plotly.Layout>

  return (
    <motion.div
      className="px-8 py-8 max-w-7xl mx-auto"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
    >
      {isMock && (
        <div className="mb-4 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300">
          ⚠ Demo data — backend unavailable. Values shown are illustrative, not live model output.
        </div>
      )}
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Zap size={22} className="text-brand-emerald" />
          <h1 className="text-2xl font-bold text-text-primary">Oxford Fine-Tune Simulator</h1>
        </div>
        <p className="text-text-secondary">
          Animate how K calibration cycles transform zero-shot RMSE of 2,276 down to 102 on Oxford Battery cells.
          Use Play to watch the curve learn in real time.
        </p>
      </div>

      {/* Controls bar */}
      <div className="panel p-4 mb-5 flex items-center gap-5 flex-wrap">
        {/* Play / Pause / Reset */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setPlaying(p => !p)}
            disabled={currentStep >= maxStepIdx}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all ${
              playing
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                : 'btn-primary'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {playing ? <Pause size={14} /> : <Play size={14} />}
            {playing ? 'Pause' : currentStep === 0 ? 'Play' : currentStep >= maxStepIdx ? 'Done' : 'Resume'}
          </button>
          <button onClick={handleReset} className="btn-ghost p-2" title="Reset to K=1">
            <RotateCcw size={14} />
          </button>
        </div>

        <div className="h-4 w-px bg-border-subtle" />

        {/* Speed */}
        <div className="flex items-center gap-1">
          <span className="text-xs text-text-muted mr-1">Speed:</span>
          {SPEEDS.map(s => (
            <button
              key={s}
              onClick={() => setSpeed(s)}
              className={`px-2 py-0.5 rounded text-xs font-mono transition-all ${
                speed === s ? 'bg-brand-blue text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              {s}×
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-border-subtle" />

        {/* K slider */}
        <div className="flex-1 min-w-[180px]">
          <div className="flex justify-between text-xs text-text-muted mb-1">
            <span>K (calibration steps)</span>
            <span className="font-mono font-bold text-emerald-400">
              Step {kDisplay} of {TOTAL_STEPS}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={maxStepIdx}
            value={currentStep}
            onChange={handleSlider}
            className="w-full accent-emerald-400 cursor-pointer"
          />
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-5">
        <div className="h-1.5 rounded-full bg-bg-elevated overflow-hidden">
          <motion.div
            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-400"
            style={{ width: `${pct}%` }}
            transition={{ duration: 0.08 }}
          />
        </div>
        <div className="flex justify-between text-[10px] text-text-muted mt-1">
          <span>Baseline (K=0)</span>
          <span className={pct >= 100 ? 'text-emerald-400 font-semibold' : ''}>
            {pct >= 100 ? 'Fully calibrated!' : `${pct.toFixed(0)}% through calibration`}
          </span>
          <span>Final (K=50)</span>
        </div>
      </div>

      {/* Metric cards + chart */}
      <div className="grid grid-cols-4 gap-5 mb-5">
        {/* Live metric cards */}
        <div className="col-span-1 space-y-4">
          <h3 className="section-title">Live Metrics</h3>

          {/* RMSE card */}
          <div className="panel p-4" style={{ borderColor: '#10b98133', backgroundColor: '#10b98108' }}>
            <div className="metric-label mb-1">RMSE (cycles)</div>
            <motion.div
              className="text-2xl font-mono font-bold text-emerald-400"
              key={`rmse-${currentStep}`}
              initial={{ scale: 1.06, opacity: 0.7 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.18 }}
            >
              {fmt(liveRmse, 1)}
            </motion.div>
            <div className="text-[10px] text-text-muted mt-1 font-mono">
              {fmt(baseline.rmse, 1)} → {fmt(final.rmse, 1)}
            </div>
            <div className="mt-2 h-1 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full rounded-full bg-emerald-500 transition-all duration-150"
                style={{
                  width: `${Math.max(2, Math.min(100,
                    (1 - (liveRmse - final.rmse) / (baseline.rmse - final.rmse)) * 100
                  ))}%`,
                }}
              />
            </div>
            <div className="text-[10px] text-text-muted mt-1">
              Improvement: <span className="text-emerald-400 font-semibold font-mono">
                {baseline.rmse > 0
                  ? `−${fmt((1 - liveRmse / baseline.rmse) * 100, 1)}%`
                  : '—'}
              </span>
            </div>
          </div>

          {/* R² card */}
          <div className="panel p-4" style={{ borderColor: '#3b82f633', backgroundColor: '#3b82f608' }}>
            <div className="metric-label mb-1">R² Score</div>
            <motion.div
              className="text-2xl font-mono font-bold"
              style={{ color: liveR2 >= 0.9 ? '#10b981' : liveR2 >= 0 ? '#f59e0b' : '#ef4444' }}
              key={`r2-${currentStep}`}
              initial={{ scale: 1.06, opacity: 0.7 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.18 }}
            >
              {fmt(liveR2, 3)}
            </motion.div>
            <div className="text-[10px] text-text-muted mt-1 font-mono">
              {fmt(baseline.r2, 3)} → {fmt(final.r2, 3)}
            </div>
            <div className="mt-2 h-1 rounded-full bg-bg-elevated overflow-hidden">
              <div
                className="h-full rounded-full bg-brand-blue transition-all duration-150"
                style={{
                  width: `${Math.max(2, Math.min(100,
                    ((liveR2 - baseline.r2) / (final.r2 - baseline.r2)) * 100
                  ))}%`,
                }}
              />
            </div>
          </div>

          {/* Per-cell split */}
          <div className="panel p-4">
            <div className="metric-label mb-2">Per-Cell RMSE</div>
            <div className="space-y-2">
              {[
                { label: 'Cell 7', color: COLOR_CELL7, value: stepData?.cell7_rmse ?? liveRmse - 4 },
                { label: 'Cell 8', color: COLOR_CELL8, value: stepData?.cell8_rmse ?? liveRmse + 10 },
              ].map(({ label, color, value }) => (
                <div key={label}>
                  <div className="flex justify-between text-xs mb-0.5">
                    <span style={{ color }}>{label}</span>
                    <span className="font-mono" style={{ color }}>{fmt(value, 1)}</span>
                  </div>
                  <div className="h-1 rounded-full bg-bg-elevated overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-200"
                      style={{
                        width: `${Math.max(2, Math.min(100,
                          (1 - (value - final.rmse) / (baseline.rmse - final.rmse)) * 100
                        ))}%`,
                        backgroundColor: color,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Dual-axis line chart */}
        <div className="col-span-3 panel p-5">
          <h3 className="section-title mb-1">
            RMSE & R² Trajectories — K = 1 to {kDisplay}
          </h3>
          <p className="text-xs text-text-muted mb-3">
            Solid lines = RMSE (left axis) · dashed = R² (right axis) · dot-dash = combined average
          </p>

          {loading ? (
            <SkeletonChart height={380} />
          ) : (
            <Plot
              data={traces}
              layout={dualLayout as Plotly.Layout}
              config={{ ...plotConfig, displayModeBar: false }}
              style={{ width: '100%' }}
              useResizeHandler
            />
          )}
        </div>
      </div>

      {/* Narrative explanation */}
      <div className="panel p-5 border-cyan-500/20 bg-cyan-500/5">
        <h3 className="text-sm font-semibold text-brand-cyan mb-3">
          How Oxford Fine-Tuning Works
        </h3>
        <div className="grid grid-cols-3 gap-6 text-sm text-text-secondary">
          <div>
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
              The Problem
            </div>
            <p>
              Oxford Battery Degradation Dataset uses a fundamentally different cycling protocol
              (CCCV to 2.7 V, 100 % DOD) than the CALCE NMC/LCO cells the TCN-Mamba model was
              trained on. Zero-shot transfer yields RMSE &gt;2,200 cycles — the model has no
              concept of Oxford's degradation scale.
            </p>
          </div>
          <div>
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
              K Calibration Cycles (B1+D Method)
            </div>
            <p>
              By supplying just K cycles from the target Oxford cell before prediction, we
              compute a bias (B1) and drift (D) correction on the latent embeddings. This
              re-anchors the model's internal representation to the Oxford degradation curve
              without any gradient updates — inference-time adaptation only.
            </p>
          </div>
          <div>
            <div className="text-xs font-semibold text-text-muted uppercase tracking-wide mb-1.5">
              Why It Works So Well
            </div>
            <p>
              The bulk of the RMSE drop happens in the first 5–10 cycles (see the steep early
              descent), because most of the mismatch is a global scale offset. Beyond K=15, gains
              are incremental — the model has already learned the cell's characteristic degradation
              slope. At K=50, Cell 7 reaches RMSE ≈ 101.6 and R² ≈ 0.995, rivalling in-domain
              CALCE performance.
            </p>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

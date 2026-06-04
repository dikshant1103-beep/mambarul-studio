/**
 * OODAnalysis.tsx — MIT_2018 Out-of-Distribution Case Study
 * Shows WHY R²=0.458 on MIT_2018-04-12_038:
 *   - Training LFP distribution histogram
 *   - Test cell at 1934 cycles shown as outlier beyond training boundary
 *   - Animated "distribution boundary" line
 */
import { useState, useEffect, useRef } from 'react'
import { motion } from 'framer-motion'
import { AlertTriangle, Info } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

const BOUNDARY_COLOR = '#ef4444'

export default function OODAnalysis() {
  const [data, setData]   = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef<number>(0)
  const lineX     = useRef(0)

  useEffect(() => {
    fetch('/api/ood-analysis')
      .then(r => r.ok ? r.json() : null)
      .then(setData).catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Animate boundary line sweeping into place
  useEffect(() => {
    if (!data || !canvasRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const PAD_L = 80, PAD_R = 80, PAD_T = 30, PAD_B = 50

    const trainMax: number = data.train_max ?? 1835
    const testLifetime = 1934
    const maxX = 2100
    const xScale = (W - PAD_L - PAD_R) / maxX

    const trainLifetimes: number[] = (data.train_lfp ?? []).map((c: any) => c.max_cycle)

    // Build histogram
    const BIN_W = 100
    const bins: Record<number, number> = {}
    for (const v of trainLifetimes) {
      const b = Math.floor(v / BIN_W) * BIN_W
      bins[b] = (bins[b] ?? 0) + 1
    }
    const maxCount = Math.max(...Object.values(bins), 1)

    const targetLineX = PAD_L + trainMax * xScale

    function draw() {
      lineX.current += (targetLineX - lineX.current) * 0.06
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#080c18'; ctx.fillRect(0, 0, W, H)

      // Axes
      ctx.strokeStyle = '#1e3a5f'; ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(PAD_L, PAD_T); ctx.lineTo(PAD_L, H - PAD_B)
      ctx.moveTo(PAD_L, H - PAD_B); ctx.lineTo(W - PAD_R, H - PAD_B)
      ctx.stroke()

      // Histogram bars (training LFP)
      for (const [b, count] of Object.entries(bins)) {
        const bv = Number(b)
        const bh = (count / maxCount) * (H - PAD_T - PAD_B) * 0.85
        const bx = PAD_L + bv * xScale
        const by = H - PAD_B - bh
        const grad = ctx.createLinearGradient(0, by, 0, H - PAD_B)
        grad.addColorStop(0, '#10b981cc'); grad.addColorStop(1, '#10b98133')
        ctx.fillStyle = grad
        ctx.fillRect(bx, by, BIN_W * xScale - 2, bh)
      }

      // Training distribution label
      ctx.fillStyle = '#10b981'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'
      ctx.fillText('Training LFP distribution', PAD_L + trainMax * xScale * 0.5, PAD_T + 12)

      // Animated boundary line
      ctx.strokeStyle = BOUNDARY_COLOR; ctx.lineWidth = 2; ctx.setLineDash([6, 4])
      ctx.beginPath(); ctx.moveTo(lineX.current, PAD_T); ctx.lineTo(lineX.current, H - PAD_B); ctx.stroke()
      ctx.setLineDash([])

      // Boundary label
      ctx.fillStyle = BOUNDARY_COLOR; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'
      ctx.fillText(`Training max: ${trainMax} cy`, lineX.current, PAD_T - 5)

      // Test cell MIT_2018_038 dot
      const testX = PAD_L + testLifetime * xScale
      const grd = ctx.createRadialGradient(testX, H - PAD_B - 30, 0, testX, H - PAD_B - 30, 25)
      grd.addColorStop(0, '#f59e0b88'); grd.addColorStop(1, '#f59e0b00')
      ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(testX, H - PAD_B - 30, 25, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#f59e0b'; ctx.beginPath(); ctx.arc(testX, H - PAD_B - 30, 8, 0, Math.PI * 2); ctx.fill()
      ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center'
      ctx.fillText('MIT_2018_038', testX, H - PAD_B - 48)
      ctx.fillText(`${testLifetime} cycles  R²=0.458`, testX, H - PAD_B - 36)

      // "OOD zone" shaded region
      if (lineX.current > PAD_L + 100) {
        ctx.fillStyle = '#ef444408'
        ctx.fillRect(lineX.current, PAD_T, W - PAD_R - lineX.current, H - PAD_T - PAD_B)
        ctx.fillStyle = '#ef444444'; ctx.font = '9px monospace'; ctx.textAlign = 'left'
        ctx.fillText('Out-of-distribution zone', lineX.current + 6, PAD_T + 18)
      }

      // X-axis ticks
      ctx.fillStyle = '#475569'; ctx.font = '9px monospace'; ctx.textAlign = 'center'
      for (let x = 0; x <= maxX; x += 300) {
        const px = PAD_L + x * xScale
        ctx.fillText(`${x}`, px, H - PAD_B + 16)
        ctx.strokeStyle = '#1e3a5f22'; ctx.lineWidth = 0.5
        ctx.beginPath(); ctx.moveTo(px, PAD_T); ctx.lineTo(px, H - PAD_B); ctx.stroke()
      }
      ctx.fillStyle = '#64748b'; ctx.font = '10px sans-serif'
      ctx.fillText('Max cycle lifetime', W / 2, H - 8)

      // Y-axis label
      ctx.save(); ctx.translate(16, H / 2); ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'center'; ctx.fillStyle = '#64748b'; ctx.font = '10px sans-serif'
      ctx.fillText('Cell count', 0, 0); ctx.restore()

      rafRef.current = requestAnimationFrame(draw)
    }
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [data])

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <motion.div className="w-8 h-8 rounded-full border-2 border-brand-blue border-t-transparent"
        animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
    </div>
  )

  const trainLifetimes: number[] = (data?.train_lfp ?? []).map((c: any) => c.max_cycle).sort((a:number,b:number)=>a-b)

  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }} className="px-8 py-8 max-w-7xl mx-auto">

      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <AlertTriangle size={22} className="text-red-400" />
          <h1 className="text-2xl font-bold text-text-primary">MIT_2018 OOD Case Study</h1>
        </div>
        <p className="text-text-secondary">
          Why does MIT_2018-04-12_038 achieve only R²=0.458 while other LFP cells reach 0.93?
          The answer is out-of-distribution lifetime — the cell runs for 1934 cycles while the
          training distribution peaks at 450–900 cycles.
        </p>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-4 gap-3 mb-6">
        {[
          { label: 'MIT_2018 lifetime', value: '1934 cycles', sub: 'test cell', color: '#f59e0b' },
          { label: 'Training LFP max', value: `${data?.train_max ?? 1835} cycles`, sub: 'longest training cell', color: '#ef4444' },
          { label: 'Training LFP mean', value: `${data?.train_mean ?? 750} cycles`, sub: 'mean training lifetime', color: '#64748b' },
          { label: 'R² on MIT_2018', value: '0.458', sub: 'vs 0.93+ in-distribution', color: '#ef4444' },
        ].map(({ label, value, sub, color }) => (
          <div key={label} className="panel p-4 text-center">
            <div className="text-xs text-text-muted mb-1">{label}</div>
            <div className="font-mono text-2xl font-bold mb-0.5" style={{ color }}>{value}</div>
            <div className="text-xs text-text-muted">{sub}</div>
          </div>
        ))}
      </div>

      {/* Main distribution canvas */}
      <div className="panel p-4 mb-5">
        <h3 className="section-title mb-3">Training LFP Distribution vs Test Cell Lifetime</h3>
        <p className="text-xs text-text-muted mb-3">
          Green bars = training LFP cells. Red dashed line = training distribution boundary.
          Amber dot = MIT_2018_038 test cell. Shaded region = out-of-distribution zone.
        </p>
        <canvas ref={canvasRef} width={900} height={320}
          style={{ width: '100%', height: 320, display: 'block' }} />
      </div>

      <div className="grid grid-cols-2 gap-4 mb-5">
        {/* Training distribution histogram (Plotly) */}
        <div className="panel p-5">
          <h3 className="section-title mb-3">Training LFP Cell Lifetimes — Histogram</h3>
          <Plot
            data={[{
              type: 'histogram', x: trainLifetimes,
              marker: { color: '#10b981', opacity: 0.7 },
              name: 'Training LFP cells',
            }, {
              type: 'scatter', mode: 'markers',
              x: [1934], y: [0.5],
              marker: { color: '#f59e0b', size: 16, symbol: 'diamond', line: { color: '#fff', width: 2 } },
              name: 'MIT_2018_038 (test)',
              yaxis: 'y2',
            }]}
            layout={{
              ...darkLayout, height: 260,
              margin: { t: 10, b: 50, l: 60, r: 80 },
              xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cell lifetime (cycles)', font: { color: '#64748b' } } },
              yaxis: { ...darkLayout.yaxis as object, title: { text: 'Count', font: { color: '#64748b' } } },
              yaxis2: { overlaying: 'y', side: 'right', showgrid: false, range: [0, 1], showticklabels: false },
              shapes: [{
                type: 'line', x0: data?.train_max ?? 1835, x1: data?.train_max ?? 1835,
                y0: 0, y1: 1, yref: 'paper',
                line: { color: BOUNDARY_COLOR, width: 2, dash: 'dot' },
              }],
              annotations: [{
                x: data?.train_max ?? 1835, y: 0.95, yref: 'paper',
                text: 'Training max', font: { color: BOUNDARY_COLOR, size: 10 },
                showarrow: false, xanchor: 'left',
              }],
              legend: { ...darkLayout.legend },
            } as Plotly.Layout}
            config={{ ...plotConfig, displayModeBar: false }}
            style={{ width: '100%' }}
          />
        </div>

        {/* R² vs lifetime scatter */}
        <div className="panel p-5">
          <h3 className="section-title mb-3">R² vs Cell Lifetime — Test Cells</h3>
          <p className="text-xs text-text-muted mb-3">
            LFP test cells sorted by lifetime. R² drops sharply for cells exceeding the training distribution.
          </p>
          <Plot
            data={[{
              type: 'scatter', mode: 'markers',
              x: [678, 1934],
              y: [0.9349, 0.4584],
              marker: {
                color: ['#10b981', '#f59e0b'], size: [14, 18],
                symbol: ['circle', 'diamond'],
                line: { color: '#fff', width: 1 },
              },
              text: ['MIT_2017 (678cy) R²=0.935', 'MIT_2018 (1934cy) R²=0.458'],
              hoverinfo: 'text',
              name: 'LFP test cells',
            }]}
            layout={{
              ...darkLayout, height: 260,
              margin: { t: 10, b: 50, l: 60, r: 20 },
              xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cell lifetime (cycles)', font: { color: '#64748b' } } },
              yaxis: { ...darkLayout.yaxis as object, title: { text: 'R²', font: { color: '#64748b' } }, range: [0, 1.1] },
              shapes: [{
                type: 'line', x0: data?.train_max ?? 1835, x1: data?.train_max ?? 1835,
                y0: 0, y1: 1, yref: 'paper',
                line: { color: BOUNDARY_COLOR, width: 2, dash: 'dot' },
              }],
            } as Plotly.Layout}
            config={{ ...plotConfig, displayModeBar: false }}
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {/* Fix strategies */}
      <div className="panel p-5 border-amber-500/20 bg-amber-500/5">
        <h3 className="text-sm font-semibold text-amber-400 mb-3 flex items-center gap-2">
          <Info size={14} /> What would fix this? (From thesis Future Work)
        </h3>
        <div className="grid grid-cols-3 gap-4 text-sm text-text-secondary">
          <div>
            <div className="font-bold text-amber-300 mb-1">1. More long-lifetime LFP data</div>
            <p>Add HUST dataset or Stanford batteries (some run 2000+ cycles) to training. This is the root-cause fix.</p>
          </div>
          <div>
            <div className="font-bold text-amber-300 mb-1">2. TTA on MIT_2018</div>
            <p>Test-time adaptation improved this cell from R²=0.342 → 0.976 (MIT_2017). Same technique applied to MIT_2018 would help.</p>
          </div>
          <div>
            <div className="font-bold text-amber-300 mb-1">3. Conformal widening</div>
            <p>The conformal prediction interval automatically widens for OOD inputs — the model "knows" it is uncertain for this cell.</p>
          </div>
        </div>
      </div>
    </motion.div>
  )
}

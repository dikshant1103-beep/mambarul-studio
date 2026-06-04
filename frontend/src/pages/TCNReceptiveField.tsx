/**
 * TCNReceptiveField.tsx
 * Interactive canvas visualizer for the dilated TCN stack in TCNMambaRUL.
 * Shows which input cycles contribute to any given output position.
 * Dilation = [1,2,4,8], kernel_size = 3  →  Receptive Field = 61 cycles
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { motion } from 'framer-motion'
import { Layers, Info } from 'lucide-react'

const KERNEL  = 3
const DILATIONS = [1, 2, 4, 8]
const N_LAYERS  = DILATIONS.length
const SEQ_LEN   = 30

// Colours per TCN layer
const LAYER_COLORS = ['#06b6d4', '#3b82f6', '#4f46e5', '#7c3aed']
const LAYER_LABELS = [
  'TCN L1 (d=1, RF=5)',
  'TCN L2 (d=2, RF=13)',
  'TCN L3 (d=4, RF=29)',
  'TCN L4 (d=8, RF=61)',
]

// Compute which INPUT positions an output position `out` at `layer` depends on
function receptiveField(out: number, maxLayer: number): Set<number> {
  const positions = new Set<number>([out])
  for (let l = maxLayer; l >= 0; l--) {
    const d = DILATIONS[l]
    const newPositions = new Set<number>()
    for (const p of positions) {
      for (let k = 0; k < KERNEL; k++) {
        const src = p - k * d
        if (src >= 0) newPositions.add(src)
      }
    }
    newPositions.forEach(p => positions.add(p))
  }
  return positions
}

export default function TCNReceptiveField() {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const rafRef     = useRef<number>(0)
  const [selected, setSelected] = useState(SEQ_LEN - 1)   // output position
  const [hovLayer, setHovLayer] = useState(N_LAYERS - 1)  // which TCN layer output
  const [playing,  setPlaying]  = useState(false)
  const tickRef = useRef<ReturnType<typeof setInterval>>()

  // Play: sweep selected position forward
  useEffect(() => {
    clearInterval(tickRef.current)
    if (playing) {
      tickRef.current = setInterval(() =>
        setSelected(s => s >= SEQ_LEN - 1 ? 0 : s + 1), 200)
    }
    return () => clearInterval(tickRef.current)
  }, [playing])

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height

    const PAD_L = 60, PAD_T = 40, PAD_B = 50
    const gridW = W - PAD_L - 20
    const rowH  = (H - PAD_T - PAD_B) / (N_LAYERS + 1)   // +1 for input row
    const cellW = gridW / SEQ_LEN

    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#080c18'; ctx.fillRect(0, 0, W, H)

    // Compute RF set from selected output at hovLayer
    const rf = receptiveField(selected, hovLayer)

    // ── Draw rows (input bottom, TCN L1..L4 going up) ──
    const rows = ['Input', 'TCN L1', 'TCN L2', 'TCN L3', 'TCN L4']
    const rowY = (ri: number) => H - PAD_B - ri * rowH - rowH / 2

    for (let ri = 0; ri <= N_LAYERS; ri++) {
      const y = rowY(ri)
      const isInput = ri === 0

      // Row label
      ctx.fillStyle = isInput ? '#94a3b8' : LAYER_COLORS[ri - 1]
      ctx.font = 'bold 10px monospace'; ctx.textAlign = 'right'
      ctx.fillText(rows[ri], PAD_L - 6, y + 4)

      for (let t = 0; t < SEQ_LEN; t++) {
        const x = PAD_L + t * cellW + cellW / 2
        const inRF = rf.has(t)
        const isSelected = !isInput && ri - 1 === hovLayer && t === selected

        if (isSelected) {
          // Glowing selected node
          const grd = ctx.createRadialGradient(x, y, 0, x, y, 18)
          grd.addColorStop(0, LAYER_COLORS[ri-1] + 'cc')
          grd.addColorStop(1, LAYER_COLORS[ri-1] + '00')
          ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.fill()
          ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill()
        } else if (inRF) {
          const col = isInput ? '#f59e0b' : LAYER_COLORS[ri - 1]
          ctx.fillStyle = col + 'cc'
          ctx.beginPath(); ctx.arc(x, y, isInput ? 6 : 5, 0, Math.PI * 2); ctx.fill()
          // Glow
          const g2 = ctx.createRadialGradient(x, y, 0, x, y, 12)
          g2.addColorStop(0, col + '55'); g2.addColorStop(1, col + '00')
          ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.fill()
        } else {
          ctx.fillStyle = isInput ? '#1e3a5f' : (ri > 0 ? LAYER_COLORS[ri-1] + '33' : '#1e3a5f')
          ctx.beginPath(); ctx.arc(x, y, isInput ? 4 : 3.5, 0, Math.PI * 2); ctx.fill()
        }

        // Cycle label on input row
        if (isInput && (t % 5 === 0 || t === SEQ_LEN - 1)) {
          ctx.fillStyle = '#475569'; ctx.font = '9px monospace'; ctx.textAlign = 'center'
          ctx.fillText(`t${t + 1}`, x, H - PAD_B + 18)
        }
      }
    }

    // ── Draw connections (dashed lines showing dilation pattern) ──
    for (let l = 1; l <= hovLayer + 1; l++) {
      const d = DILATIONS[l - 1]
      const yFrom = rowY(l)
      const yTo   = rowY(l - 1)
      // Only draw connections involving selected or RF nodes
      for (const t of rf) {
        for (let k = 0; k < KERNEL; k++) {
          const src = t - k * d
          if (src < 0 || src >= SEQ_LEN) continue
          if (!rf.has(src) && l > 1) continue
          const xFrom = PAD_L + t   * cellW + cellW / 2
          const xSrc  = PAD_L + src * cellW + cellW / 2
          const col = LAYER_COLORS[l - 1]
          ctx.strokeStyle = col + '55'; ctx.lineWidth = 0.8
          ctx.setLineDash([3, 4])
          ctx.beginPath(); ctx.moveTo(xFrom, yFrom); ctx.lineTo(xSrc, yTo); ctx.stroke()
          ctx.setLineDash([])
        }
      }
    }

    // ── RF stats overlay ──
    const rfInput = [...rf].filter(t => t < SEQ_LEN)
    ctx.fillStyle = '#f59e0b'; ctx.font = 'bold 11px monospace'; ctx.textAlign = 'left'
    ctx.fillText(`Output t=${selected + 1} via ${LAYER_LABELS[hovLayer]}`, PAD_L, 24)
    ctx.fillStyle = '#94a3b8'; ctx.font = '10px monospace'
    ctx.fillText(`Receptive field: ${rfInput.length} input cycles  (t${Math.min(...rfInput)+1}–t${Math.max(...rfInput)+1})`, PAD_L, 38)

    rafRef.current = requestAnimationFrame(draw)
  }, [selected, hovLayer])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  // Total RF for each layer
  const rfSizes = DILATIONS.map((_d, li) => {
    const rf = receptiveField(SEQ_LEN - 1, li)
    return [...rf].filter(t => t < SEQ_LEN).length
  })

  return (
    <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }} className="px-8 py-8 max-w-7xl mx-auto">

      {/* Header */}
      <div className="mb-5">
        <div className="flex items-center gap-3 mb-2">
          <Layers size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">TCN Receptive Field Visualizer</h1>
        </div>
        <p className="text-text-secondary">
          Dilated causal convolution stack in TCNMambaRUL — kernel=3, dilations=[1,2,4,8].
          Click any output position to trace which input cycles it depends on.
        </p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-4 gap-3 mb-5">
        {DILATIONS.map((_d2, i) => (
          <button key={i} onClick={() => setHovLayer(i)}
            className={`panel p-4 text-left transition-all ${hovLayer===i?'border-opacity-100':'opacity-60'}`}
            style={{ borderColor: LAYER_COLORS[i] + (hovLayer===i?'99':'33') }}>
            <div className="text-xs font-bold mb-1" style={{ color: LAYER_COLORS[i] }}>
              {LAYER_LABELS[i]}
            </div>
            <div className="text-2xl font-mono font-bold text-text-primary mb-1">
              {rfSizes[i]}
            </div>
            <div className="text-xs text-text-muted">input cycles in RF</div>
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-4 mb-4 panel p-3">
        <button onClick={() => setPlaying(p => !p)}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium ${playing ? 'bg-brand-blue/10 text-brand-blue' : 'btn-primary'}`}>
          {playing ? '⏸ Pause' : '▶ Sweep'}
        </button>
        <div className="flex-1">
          <input type="range" min={0} max={SEQ_LEN - 1} value={selected}
            onChange={e => { setPlaying(false); setSelected(+e.target.value) }}
            className="w-full accent-brand-blue" />
        </div>
        <span className="font-mono text-sm text-brand-blue w-20 text-center">
          Output t={selected + 1}
        </span>
        <div className="flex gap-1">
          {LAYER_LABELS.map((_, i) => (
            <button key={i} onClick={() => setHovLayer(i)}
              className="px-2 py-0.5 rounded text-xs font-medium transition-all"
              style={hovLayer===i
                ? { backgroundColor: LAYER_COLORS[i]+'33', color: LAYER_COLORS[i], border:`1px solid ${LAYER_COLORS[i]}66` }
                : { backgroundColor:'transparent', color:'#64748b', border:'1px solid #1e3a5f' }}>
              L{i+1}
            </button>
          ))}
        </div>
      </div>

      {/* Canvas */}
      <div className="panel p-2">
        <canvas ref={canvasRef} width={960} height={380}
          style={{ width: '100%', height: 380, display: 'block', cursor: 'crosshair' }}
          onClick={e => {
            const rect = e.currentTarget.getBoundingClientRect()
            const mx = (e.clientX - rect.left) * (960 / rect.width)
            const gridW = 960 - 60 - 20
            const t = Math.round((mx - 60) / (gridW / SEQ_LEN) - 0.5)
            if (t >= 0 && t < SEQ_LEN) { setPlaying(false); setSelected(t) }
          }}
        />
      </div>

      {/* Explanation */}
      <div className="grid grid-cols-2 gap-4 mt-5">
        <div className="panel p-5">
          <h3 className="section-title mb-3 flex items-center gap-2">
            <Info size={14} /> How dilated TCN works
          </h3>
          <div className="space-y-2 text-sm text-text-secondary">
            <p>Each TCN layer applies a <span className="text-brand-blue font-mono">kernel_size=3</span> causal convolution with increasing dilation.</p>
            <p>Dilation <span className="font-mono">d</span> means the kernel looks at positions <span className="font-mono">t, t-d, t-2d</span> — so it can "skip" over cycles to see further back without adding parameters.</p>
            <p>After 4 layers with dilations [1,2,4,8], any output can theoretically see <span className="text-amber-400 font-bold">61 input cycles</span> — more than the 30-cycle window, giving full context.</p>
          </div>
        </div>
        <div className="panel p-5">
          <h3 className="section-title mb-3">Architecture in TCNMambaRUL</h3>
          <div className="font-mono text-xs space-y-1.5">
            {[
              { label: 'Input', val: '30 cycles × 13 features', col: '#94a3b8' },
              { label: 'TCN d=1', val: 'RF = 5 cycles', col: LAYER_COLORS[0] },
              { label: 'TCN d=2', val: 'RF = 13 cycles', col: LAYER_COLORS[1] },
              { label: 'TCN d=4', val: 'RF = 29 cycles', col: LAYER_COLORS[2] },
              { label: 'TCN d=8', val: 'RF = 61 cycles  ✓ full coverage', col: LAYER_COLORS[3] },
              { label: 'Mamba ×3', val: 'SSM sequential modelling (dim=128)', col: '#8b5cf6' },
              { label: 'Output', val: 'RUL (cycles)', col: '#f59e0b' },
            ].map(({ label, val, col }) => (
              <div key={label} className="flex items-center gap-2">
                <span className="w-20 shrink-0" style={{ color: col }}>{label}</span>
                <span className="text-text-muted">{val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </motion.div>
  )
}

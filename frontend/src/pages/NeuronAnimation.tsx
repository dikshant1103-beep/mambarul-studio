/**
 * NeuronAnimation.tsx — Fully animated MambaRUL neural architecture
 *
 * Fixed animations:
 * - 3D: rotation increments INSIDE the RAF draw() loop (was outside → static)
 * - 2D: full Canvas-based rendering with RAF, smooth particles, pulsing neurons
 * - Attention: Plotly transition:400ms + animated cycle line
 * - Norms: Plotly transition:300ms + pulsing bars
 * - All views: continuous RAF-driven updates, no static snapshots
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Pause, RotateCcw, FastForward, Eye, Cpu, Layers, BarChart2, Box } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'

// ── Types ────────────────────────────────────────────────────────
interface LayerAct {
  shape: number[]
  norm_per_step?: number[]
  mean_over_time?: number[]
  sample_t15?: number[]
}
interface ForwardResult {
  model_id: string
  rul_predicted: number
  soh_pct: number
  chemistry: string
  input_window: { features: number[][]; n_cycles: number; n_features: number }
  layers: Record<string, LayerAct>
  attention: { weights_L_anchors: number[][]; anchor_importance: number[] }
}
interface WeightMatrix { shape: number[]; data: number[][]; min: number; max: number; norm: number }

const CHEM_COLORS: Record<string, string> = { LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6' }

const LAYER_KEYS = ['embedding','mamba0_out','mamba1_out','mamba2_out','attn_out','mlp_linear','mlp_relu','mlp_out']
const LAYER_LABELS = ['Embed 13→128','Mamba ×1','Mamba ×2','Mamba ×3','Anchor Attn','MLP Linear','ReLU','Output']
const LAYER_COLORS = ['#06b6d4','#3b82f6','#4f46e5','#7c3aed','#8b5cf6','#10b981','#059669','#f59e0b']

const ANCHOR_LABELS = ['Fresh Cell','Knee Point','Near-EOL']
const ANCHOR_COLORS = ['#10b981','#f59e0b','#ef4444']

const FEATURE_NAMES = ['cap_Ah','chg_t','v_mean','v_end','energy','temp','d_slope','ir','soh%','Δcap','cum_E','cap_σ','soh_slope']

// ── Parse norm safely ─────────────────────────────────────────────
function getNorm(result: ForwardResult | null, key: string, t: number): number {
  if (!result) return 0
  const layer = result.layers[key]
  if (!layer?.norm_per_step?.length) return 0
  const ti = Math.min(t, layer.norm_per_step.length - 1)
  const v = layer.norm_per_step[ti] ?? 0
  const mx = Math.max(...layer.norm_per_step, 1e-6)
  return v / mx
}

// ════════════════════════════════════════════════════════════════
// 2D CANVAS — smooth particles + pulsing neurons
// ════════════════════════════════════════════════════════════════

interface Particle { layerIdx: number; t: number; dt: number; row: 'fresh'|'aged'; alpha: number }

const LAYERS_2D = [
  { label:'Input\n13',   color:'#94a3b8', key:'input' },
  { label:'Embed\n128',  color:'#06b6d4', key:'embedding' },
  { label:'Mamba\n×1',   color:'#3b82f6', key:'mamba0_out' },
  { label:'Mamba\n×2',   color:'#4f46e5', key:'mamba1_out' },
  { label:'Mamba\n×3',   color:'#7c3aed', key:'mamba2_out' },
  { label:'Attn\n3anch', color:'#8b5cf6', key:'attn_out' },
  { label:'MLP\n64→1',   color:'#10b981', key:'mlp_linear' },
  { label:'RUL\nout',    color:'#f59e0b', key:'mlp_out' },
]

function Canvas2D({ fresh, aged, cycleT, hoveredLayer, setHoveredLayer }:
  { fresh: ForwardResult|null; aged: ForwardResult|null; cycleT: number
    hoveredLayer: string|null; setHoveredLayer: (l:string|null)=>void }) {

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf       = useRef<number>()
  const tick      = useRef(0)
  const particles = useRef<Particle[]>([])
  const hovRef    = useRef<string|null>(null)
  hovRef.current  = hoveredLayer

  // spawn particles
  useEffect(() => {
    const id = setInterval(() => {
      const maxNorm = Math.max(...LAYERS_2D.map(l => getNorm(fresh, l.key, cycleT)), 0.1)
      const cap = Math.round(30 + maxNorm * 50)
      if (particles.current.length < cap) {
        const li = Math.floor(Math.random() * (LAYERS_2D.length - 1))
        const layerNorm = getNorm(fresh, LAYERS_2D[li].key, cycleT)
        particles.current.push({
          layerIdx: li, t: 0, dt: 0.010 + layerNorm * 0.018 + Math.random() * 0.006,
          row: Math.random() > 0.5 ? 'fresh' : 'aged', alpha: 0.9,
        })
      }
    }, 60)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const NL = LAYERS_2D.length
    const xStep = (W - 60) / (NL - 1)
    const LX = (i: number) => 30 + i * xStep
    const FRESH_Y = H * 0.33, AGED_Y = H * 0.67

    const drawGlow = (x: number, y: number, r: number, color: string, alpha: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 3.5)
      g.addColorStop(0, color + Math.round(alpha * 255).toString(16).padStart(2,'0'))
      g.addColorStop(0.5, color + Math.round(alpha * 80).toString(16).padStart(2,'0'))
      g.addColorStop(1, 'transparent')
      ctx.beginPath(); ctx.arc(x, y, r * 3.5, 0, Math.PI * 2)
      ctx.fillStyle = g; ctx.fill()
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fillStyle = color; ctx.globalAlpha = alpha; ctx.fill()
      ctx.globalAlpha = 1
    }

    const bezierPoint = (t: number, x0: number, x1: number, y: number) => {
      const cx = (x0 + x1) / 2
      return {
        x: (1-t)*(1-t)*x0 + 2*(1-t)*t*cx + t*t*x1,
        y: (1-t)*(1-t)*y  + 2*(1-t)*t*(y - 20) + t*t*y,
      }
    }

    const draw = () => {
      tick.current++
      const T = tick.current

      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, W, H)

      // Row labels
      ctx.font = 'bold 11px Inter'
      ctx.fillStyle = '#10b981'; ctx.textAlign = 'left'; ctx.fillText('FRESH (SOH=95%)', 6, FRESH_Y - 32)
      ctx.fillStyle = '#ef4444'; ctx.fillText('AGED  (SOH=50%)', 6, AGED_Y - 32)

      // Draw connections + neurons for both rows
      for (const [rowLabel, rowY, , result] of [
        ['fresh', FRESH_Y, '#10b981', fresh],
        ['aged',  AGED_Y,  '#ef4444', aged],
      ] as [string, number, string, ForwardResult|null][]) {
        LAYERS_2D.forEach((layer, i) => {
          const x = LX(i)
          const act = getNorm(result, layer.key, cycleT)
          const pulse = 0.55 + 0.45 * Math.sin(T * 0.04 + i * 0.8 + (rowLabel === 'aged' ? Math.PI : 0))
          const glow  = act * pulse

          // Connection line to next layer
          if (i < NL - 1) {
            const nx = LX(i + 1)
            const nextAct = getNorm(result, LAYERS_2D[i+1].key, cycleT)
            const avgAct  = (act + nextAct) / 2

            // Flowing dashes
            const dashOffset = (T * 1.5) % 20
            ctx.beginPath(); ctx.moveTo(x + 14, rowY); ctx.lineTo(nx - 14, rowY)
            ctx.strokeStyle = layer.color + '55'
            ctx.lineWidth = 1 + avgAct * 2
            ctx.setLineDash([8, 6]); ctx.lineDashOffset = -dashOffset
            ctx.stroke(); ctx.setLineDash([])
          }

          // Neuron
          const r = 12 + glow * 10
          const isHov = hovRef.current === layer.key
          drawGlow(x, rowY, r, isHov ? '#ffffff' : layer.color, 0.5 + glow * 0.5)

          // Activation label
          if (act > 0.1) {
            ctx.font = `${Math.round(8 + act * 3)}px JetBrains Mono`
            ctx.fillStyle = layer.color; ctx.textAlign = 'center'; ctx.globalAlpha = 0.9
            ctx.fillText(act.toFixed(2), x, rowY + r + 14)
            ctx.globalAlpha = 1
          }

          // Layer name (bottom)
          const DIM_LABELS: Record<string,string> = {input:'13',embedding:'128',mamba0_out:'128',mamba1_out:'128',mamba2_out:'128',attn_out:'128',mlp_linear:'64',mlp_out:'1'}
          ctx.font = '9px JetBrains Mono'; ctx.fillStyle = isHov ? '#f1f5f9' : '#475569'
          ctx.textAlign = 'center'
          layer.label.split('\n').forEach((line, li2) => {
            ctx.fillText(line, x, H - 26 + li2 * 11)
          })
          ctx.font = '8px JetBrains Mono'; ctx.fillStyle = '#1e3a5f'
          ctx.fillText(`d=${DIM_LABELS[layer.key]??'?'}`, x, H - 4)
        })
      }

      // Particles flowing along connections
      particles.current = particles.current.filter(p => p.alpha > 0.05)
      particles.current.forEach(p => {
        p.t += p.dt; p.alpha *= 0.98
        if (p.t > 1) { p.t = 0; p.layerIdx = (p.layerIdx + 1) % (NL - 1) }
        const x0 = LX(p.layerIdx), x1 = LX(p.layerIdx + 1)
        const rowY = p.row === 'fresh' ? FRESH_Y : AGED_Y
        const col  = p.row === 'fresh' ? '#10b981' : '#ef4444'
        const { x, y } = bezierPoint(p.t, x0, x1, rowY)

        // Particle glow trail
        const trail = 5
        for (let ti = 0; ti < trail; ti++) {
          const pt2 = Math.max(0, p.t - ti * 0.03)
          const { x: tx, y: ty } = bezierPoint(pt2, x0, x1, rowY)
          const ta = p.alpha * (1 - ti / trail)
          ctx.beginPath(); ctx.arc(tx, ty, 4 - ti * 0.5, 0, Math.PI * 2)
          ctx.fillStyle = col; ctx.globalAlpha = ta; ctx.fill()
        }
        ctx.globalAlpha = 1

        // Particle core
        const pg = ctx.createRadialGradient(x, y, 0, x, y, 7)
        pg.addColorStop(0, col); pg.addColorStop(1, 'transparent')
        ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2)
        ctx.fillStyle = pg; ctx.globalAlpha = p.alpha * 0.9; ctx.fill()
        ctx.globalAlpha = 1
      })

      // Diff indicators between fresh and aged
      LAYERS_2D.forEach((layer, i) => {
        const x = LX(i)
        const fA = getNorm(fresh, layer.key, cycleT)
        const aA = getNorm(aged,  layer.key, cycleT)
        const diff = fA - aA
        if (Math.abs(diff) > 0.05) {
          const col = diff > 0 ? '#10b98188' : '#ef444488'
          ctx.font = 'bold 9px JetBrains Mono'
          ctx.fillStyle = col; ctx.textAlign = 'center'
          ctx.fillText(`${diff > 0 ? '+' : ''}${(diff * 100).toFixed(0)}%`, x, (FRESH_Y + AGED_Y) / 2 + 5)
        }
      })

      raf.current = requestAnimationFrame(draw)
    }

    raf.current = requestAnimationFrame(draw)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [fresh, aged, cycleT])

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (e.currentTarget.width / rect.width)
    const NL = LAYERS_2D.length
    const xStep = (e.currentTarget.width - 60) / (NL - 1)
    const li = Math.round((mx - 30) / xStep)
    if (li >= 0 && li < NL) setHoveredLayer(LAYERS_2D[li].key)
    else setHoveredLayer(null)
  }

  return (
    <canvas ref={canvasRef} width={900} height={320}
      className="rounded-xl border border-border-subtle w-full"
      style={{ cursor: 'crosshair', background: '#0a0e1a' }}
      onMouseMove={onMouseMove}
      onMouseLeave={() => setHoveredLayer(null)}
    />
  )
}

// ════════════════════════════════════════════════════════════════
// 3D CANVAS — rotation INSIDE draw loop, pulsing neurons
// ════════════════════════════════════════════════════════════════

interface FlowParticle {
  layer: number; progress: number; row: 'fresh'|'aged'
  fromY: number; toY: number; fromX: number; toX: number
  speed: number; color: string
}

const LAYERS_3D = [
  { neurons:13, color:'#94a3b8', label:'Input',   key:'input' },
  { neurons:32, color:'#06b6d4', label:'Embed',   key:'embedding' },
  { neurons:32, color:'#3b82f6', label:'Mamba1',  key:'mamba0_out' },
  { neurons:32, color:'#4f46e5', label:'Mamba2',  key:'mamba1_out' },
  { neurons:32, color:'#7c3aed', label:'Mamba3',  key:'mamba2_out' },
  { neurons:16, color:'#8b5cf6', label:'Attn',    key:'attn_out' },
  { neurons: 8, color:'#10b981', label:'MLP',     key:'mlp_linear' },
  { neurons: 1, color:'#f59e0b', label:'RUL',     key:'mlp_out' },
]

function Canvas3D({ fresh, aged, cycleT }:
  { fresh: ForwardResult|null; aged: ForwardResult|null; cycleT: number }) {
  const canvasRef    = useRef<HTMLCanvasElement>(null)
  const raf          = useRef<number>()
  const rotY         = useRef(0.3)
  const rotX         = useRef(0.15)
  const dragging     = useRef(false)
  const lastMouse    = useRef({ x: 0, y: 0 })
  const tick         = useRef(0)
  const flowParticles = useRef<FlowParticle[]>([])
  const cycleTRef3d  = useRef(cycleT)

  useEffect(() => { cycleTRef3d.current = cycleT }, [cycleT])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const CX = W / 2, CY = H / 2, FOV = 600

    const project = (x: number, y: number, z: number) => {
      const cosY = Math.cos(rotY.current), sinY = Math.sin(rotY.current)
      const cosX = Math.cos(rotX.current), sinX = Math.sin(rotX.current)
      const rx = x * cosY - z * sinY
      const rz = x * sinY + z * cosY
      const ry2 = y * cosX - rz * sinX
      const rz2 = y * sinX + rz * cosX
      const scale = FOV / (FOV + rz2 + 200)
      return { sx: CX + rx * scale, sy: CY + ry2 * scale, scale, z: rz2 }
    }

    const drawSphere = (px: number, py: number, pz: number, r: number, color: string, glow: number) => {
      const { sx, sy, scale } = project(px, py, pz)
      const sr = r * scale
      if (sr < 0.5) return

      // Glow halo
      const g = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr * 4)
      const hex = Math.round(glow * 160).toString(16).padStart(2,'00')
      g.addColorStop(0, color + hex); g.addColorStop(1, 'transparent')
      ctx.beginPath(); ctx.arc(sx, sy, sr * 4, 0, Math.PI * 2)
      ctx.fillStyle = g; ctx.fill()

      // Core sphere with shading
      const sg = ctx.createRadialGradient(sx - sr * 0.3, sy - sr * 0.3, sr * 0.1, sx, sy, sr)
      sg.addColorStop(0, '#ffffff66'); sg.addColorStop(0.3, color); sg.addColorStop(1, color + '88')
      ctx.beginPath(); ctx.arc(sx, sy, Math.max(1, sr), 0, Math.PI * 2)
      ctx.fillStyle = sg; ctx.globalAlpha = 0.5 + glow * 0.5; ctx.fill()
      ctx.globalAlpha = 1
    }

    const draw = () => {
      tick.current++
      const T = tick.current

      // AUTO-ROTATE — inside the draw loop (this was the bug)
      if (!dragging.current) {
        rotY.current += 0.006
        rotX.current = 0.15 + Math.sin(T * 0.005) * 0.08
      }

      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, W, H)

      // Grid floor
      ctx.strokeStyle = '#1e3a5f33'; ctx.lineWidth = 0.5
      for (let g = -4; g <= 4; g++) {
        const a = project(g * 60, 160, -400)
        const b = project(g * 60, 160,  400)
        const c = project(-400, 160, g * 60)
        const d = project( 400, 160, g * 60)
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(c.sx, c.sy); ctx.lineTo(d.sx, d.sy); ctx.stroke()
      }

      const layerSpacing = 100
      const totalW = (LAYERS_3D.length - 1) * layerSpacing
      const NETWORKS = [
        { yOff: -80, result: fresh, label: 'FRESH 95%', lc: '#10b981' },
        { yOff:  80, result: aged,  label: 'AGED  50%', lc: '#ef4444' },
      ]

      // Collect all spheres for depth-sorted rendering
      const spheres: { px:number; py:number; pz:number; r:number; color:string; glow:number; z:number }[] = []
      const lines:   { x1:number; y1:number; x2:number; y2:number; alpha:number; color:string }[] = []

      for (const net of NETWORKS) {
        LAYERS_3D.forEach((layer, li) => {
          const lx = li * layerSpacing - totalW / 2
          const act = getNorm(net.result, layer.key, cycleTRef3d.current)
          const shown = Math.min(layer.neurons, 8)

          // Connections to next layer
          if (li < LAYERS_3D.length - 1) {
            const nx = (li + 1) * layerSpacing - totalW / 2
            const nextShown = Math.min(LAYERS_3D[li+1].neurons, 8)
            for (let ni = 0; ni < shown; ni++) {
              const ny = (ni - (shown - 1) / 2) * 22 + net.yOff
              for (let nj = 0; nj < Math.min(nextShown, 3); nj++) {
                const ny2 = (nj - (nextShown - 1) / 2) * 22 + net.yOff
                const p1 = project(lx, ny, 0)
                const p2 = project(nx, ny2, 0)
                lines.push({ x1: p1.sx, y1: p1.sy, x2: p2.sx, y2: p2.sy, alpha: act * 0.35, color: layer.color })
              }
            }
          }

          // Neurons
          for (let ni = 0; ni < shown; ni++) {
            const ny = (ni - (shown - 1) / 2) * 22 + net.yOff
            const pulse = 0.4 + 0.6 * Math.abs(Math.sin(T * 0.035 + li * 0.9 + ni * 0.5))
            const glow  = act * pulse
            const zJitter = ((ni * 7 + li * 13) % 30) - 15
            const zDepth = project(lx, ny, zJitter).z
            spheres.push({ px: lx, py: ny, pz: zJitter, r: 6 + act * 6, color: layer.color, glow, z: zDepth })
          }
        })

        // Network label
        const { sx, sy } = project(-totalW / 2 - 70, net.yOff, 0)
        ctx.font = 'bold 11px Inter'; ctx.fillStyle = net.lc; ctx.textAlign = 'right'
        ctx.fillText(net.label, sx, sy)

        // Layer labels
        LAYERS_3D.forEach((layer, li) => {
          const lx = li * layerSpacing - totalW / 2
          const { sx, sy } = project(lx, net.yOff + 70, 0)
          ctx.font = '9px JetBrains Mono'; ctx.fillStyle = '#475569'; ctx.textAlign = 'center'
          ctx.fillText(layer.label, sx, sy)
        })
      }

      // Draw connections
      lines.forEach(l => {
        ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2)
        ctx.strokeStyle = l.color; ctx.lineWidth = 0.8
        ctx.globalAlpha = l.alpha; ctx.stroke(); ctx.globalAlpha = 1
      })

      // Sort spheres back-to-front, draw
      spheres.sort((a, b) => b.z - a.z)
      spheres.forEach(s => drawSphere(s.px, s.py, s.pz, s.r, s.color, s.glow))

      // Spawn particles
      if (T % 30 === 0) {
        for (const net of NETWORKS) {
          if (!net.result) continue
          const li = 0
          const layer = LAYERS_3D[li]
          const act = getNorm(net.result, layer.key, cycleTRef3d.current)
          const lx = li * layerSpacing - totalW / 2
          const nx = (li + 1) * layerSpacing - totalW / 2
          const shown = Math.min(layer.neurons, 8)
          for (let ni = 0; ni < Math.min(shown, 3); ni++) {
            const fromY = (ni - (shown - 1) / 2) * 22 + net.yOff
            const nextShown = Math.min(LAYERS_3D[li + 1].neurons, 8)
            const toY = (Math.floor(Math.random() * nextShown) - (nextShown - 1) / 2) * 22 + net.yOff
            flowParticles.current.push({
              layer: 0, progress: 0, row: net.result === fresh ? 'fresh' : 'aged',
              fromX: lx, toX: nx, fromY, toY,
              speed: 0.018 + act * 0.022,
              color: net.result === fresh ? '#10b981' : '#ef4444'
            })
          }
        }
      }
      // Update and draw flow particles
      flowParticles.current = flowParticles.current.filter(p => !(p.layer >= LAYERS_3D.length - 1 && p.progress >= 1))
      for (const p of flowParticles.current) {
        p.progress += p.speed
        if (p.progress >= 1 && p.layer < LAYERS_3D.length - 2) {
          // Advance to next layer
          const nextLi = p.layer + 1
          const lx2 = nextLi * layerSpacing - totalW / 2
          const nx2 = (nextLi + 1) * layerSpacing - totalW / 2
          const nextLayer = LAYERS_3D[nextLi + 1]
          const nextShown = Math.min(nextLayer.neurons, 8)
          const net = NETWORKS.find(n => n.result && (n.result === fresh ? p.row === 'fresh' : p.row === 'aged'))
          const yOff = net?.yOff ?? p.fromY
          p.layer = nextLi; p.progress = 0
          p.fromX = lx2; p.toX = nx2
          p.fromY = p.toY
          p.toY = (Math.floor(Math.random() * nextShown) - (nextShown - 1) / 2) * 22 + yOff
          p.color = LAYERS_3D[nextLi].color
          const act2 = net ? getNorm(net.result, LAYERS_3D[nextLi].key, cycleTRef3d.current) : 0.5
          p.speed = 0.018 + act2 * 0.022
        }
        const t = Math.min(p.progress, 1)
        const px3d = p.fromX + (p.toX - p.fromX) * t
        const py3d = p.fromY + (p.toY - p.fromY) * t
        const { sx: psx, sy: psy, scale: psc } = project(px3d, py3d, 0)
        ctx.globalAlpha = Math.sin(t * Math.PI) * 0.9
        ctx.fillStyle = p.color
        const gp = ctx.createRadialGradient(psx, psy, 0, psx, psy, 5 * psc)
        gp.addColorStop(0, p.color); gp.addColorStop(1, p.color + '00')
        ctx.fillStyle = gp; ctx.beginPath(); ctx.arc(psx, psy, 5 * psc, 0, Math.PI * 2); ctx.fill()
        ctx.globalAlpha = 1
      }

      raf.current = requestAnimationFrame(draw)
    }

    raf.current = requestAnimationFrame(draw)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [fresh, aged])

  const onDown  = (e: React.MouseEvent) => { dragging.current = true; lastMouse.current = { x: e.clientX, y: e.clientY } }
  const onMove  = (e: React.MouseEvent) => {
    if (!dragging.current) return
    rotY.current += (e.clientX - lastMouse.current.x) * 0.008
    rotX.current += (e.clientY - lastMouse.current.y) * 0.005
    lastMouse.current = { x: e.clientX, y: e.clientY }
  }
  const onUp = () => { dragging.current = false }

  return (
    <canvas ref={canvasRef} width={900} height={500} className="rounded-xl border border-border-subtle w-full"
      style={{ cursor: dragging.current ? 'grabbing' : 'grab', background: '#0a0e1a' }}
      onMouseDown={onDown} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
    />
  )
}

// ════════════════════════════════════════════════════════════════
// SSM TRAJECTORY CANVAS — 3D state-space path, PCA-projected
// ════════════════════════════════════════════════════════════════

function SsmTrajectoryCanvas({ traj, cycleT, blockKey }:
  { traj: any; blockKey: string; cycleT: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf       = useRef<number>(0)
  const rotY      = useRef(0.4)
  const rotX      = useRef(0.2)
  const dragging  = useRef(false)
  const lastMouse = useRef({ x: 0, y: 0 })
  const cycleTRef = useRef(cycleT)
  const scanPos   = useRef(cycleT)
  const tick      = useRef(0)

  useEffect(() => { cycleTRef.current = cycleT }, [cycleT])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const CX = W/2, CY = H/2, FOV = 550

    const project = (x: number, y: number, z: number) => {
      const cy = Math.cos(rotY.current), sy = Math.sin(rotY.current)
      const cx = Math.cos(rotX.current), sx = Math.sin(rotX.current)
      const rx = x*cy - z*sy, rz = x*sy + z*cy
      const ry2 = y*cx - rz*sx, rz2 = y*sx + rz*cx
      const sc = FOV / (FOV + rz2 + 150)
      return { sx: CX + rx*sc, sy: CY + ry2*sc, sc, depth: rz2 }
    }

    const onDown = (e: MouseEvent) => { dragging.current=true; lastMouse.current={x:e.clientX,y:e.clientY} }
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      rotY.current += (e.clientX - lastMouse.current.x) * 0.008
      rotX.current += (e.clientY - lastMouse.current.y) * 0.008
      lastMouse.current = {x:e.clientX,y:e.clientY}
    }
    const onUp = () => { dragging.current=false }
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)

    const blockData = traj?.[blockKey]
    const fresh = blockData?.fresh ?? { x: Array(30).fill(0), y: Array(30).fill(0), z: Array(30).fill(0) }
    const aged  = blockData?.aged  ?? { x: Array(30).fill(0), y: Array(30).fill(0), z: Array(30).fill(0) }
    const ev    = blockData?.explained_variance ?? [0.5, 0.3, 0.2]

    function draw() {
      tick.current++
      scanPos.current += (cycleTRef.current - scanPos.current) * 0.10
      if (!dragging.current) {
        rotY.current += 0.005
        rotX.current = 0.2 + Math.sin(tick.current * 0.004) * 0.1
      }

      ctx.clearRect(0,0,W,H)
      ctx.fillStyle = '#080c18'; ctx.fillRect(0,0,W,H)

      // Grid floor
      ctx.strokeStyle = '#1e3a5f22'; ctx.lineWidth = 0.5
      for (let g=-5;g<=5;g++) {
        const a = project(g*24, 130, -130), b = project(g*24, 130, 130)
        const c = project(-130, 130, g*24), d = project(130, 130, g*24)
        ctx.globalAlpha=0.4; ctx.beginPath(); ctx.moveTo(a.sx,a.sy); ctx.lineTo(b.sx,b.sy); ctx.stroke()
        ctx.beginPath(); ctx.moveTo(c.sx,c.sy); ctx.lineTo(d.sx,d.sy); ctx.stroke()
      }
      ctx.globalAlpha=1

      // Project all points
      const fPts = Array.from({length:30},(_,i)=>project(fresh.x[i]??0, fresh.y[i]??0, fresh.z[i]??0))
      const aPts = Array.from({length:30},(_,i)=>project(aged.x[i]??0, aged.y[i]??0, aged.z[i]??0))

      // Draw tubes (glow pass + main pass)
      // Time-colored tubes: blue (t=1) → red (t=30)
      function drawTimeTube(pts: {sx:number;sy:number}[], lineW: number, alpha: number) {
        for (let i=1;i<pts.length;i++) {
          const t=i/(pts.length-1)
          const r=Math.round(t*220), b=Math.round((1-t)*220)
          ctx.strokeStyle=`rgb(${r},80,${b})`; ctx.lineWidth=lineW; ctx.globalAlpha=alpha
          ctx.shadowColor=`rgb(${r},80,${b})`; ctx.shadowBlur=3
          ctx.beginPath(); ctx.moveTo(pts[i-1].sx,pts[i-1].sy); ctx.lineTo(pts[i].sx,pts[i].sy); ctx.stroke()
        }
        ctx.shadowBlur=0
      }
      // Glow pass
      drawTimeTube(fPts, 7, 0.12)
      drawTimeTube(aPts, 7, 0.12)
      // Main pass
      drawTimeTube(fPts, 2.5, 0.9)
      drawTimeTube(aPts, 2.5, 0.9)

      // Timestep dots
      for (let i=0;i<30;i++) {
        const fp=fPts[i], ap=aPts[i]
        const isCur = Math.abs(i - scanPos.current) < 1.2
        ;[{p:fp,col:'#06b6d4'},{p:ap,col:'#ef4444'}].forEach(({p,col})=>{
          const r = isCur ? 7*p.sc : 3.5*p.sc
          ctx.globalAlpha = isCur ? 1 : 0.5
          ctx.fillStyle = col
          ctx.beginPath(); ctx.arc(p.sx,p.sy,r,0,Math.PI*2); ctx.fill()
          if (isCur) {
            const g=ctx.createRadialGradient(p.sx,p.sy,0,p.sx,p.sy,18*p.sc)
            g.addColorStop(0,col+'88');g.addColorStop(1,col+'00')
            ctx.fillStyle=g;ctx.beginPath();ctx.arc(p.sx,p.sy,18*p.sc,0,Math.PI*2);ctx.fill()
          }
        })
      }
      ctx.globalAlpha=1

      // Cursor connector
      const ci = Math.round(scanPos.current)
      const fp=fPts[ci], ap=aPts[ci]
      ctx.strokeStyle='#f59e0b55'; ctx.lineWidth=1; ctx.setLineDash([3,4])
      ctx.beginPath(); ctx.moveTo(fp.sx,fp.sy); ctx.lineTo(ap.sx,ap.sy); ctx.stroke()
      ctx.setLineDash([])

      // Amber cursor sphere at current t
      const p3d = project(((fresh.x[ci]||0)+(aged.x[ci]||0))/2, ((fresh.y[ci]||0)+(aged.y[ci]||0))/2, ((fresh.z[ci]||0)+(aged.z[ci]||0))/2)
      ctx.fillStyle='#f59e0b'; ctx.globalAlpha=0.9
      ctx.beginPath(); ctx.arc(p3d.sx,p3d.sy,4*p3d.sc,0,Math.PI*2); ctx.fill()
      ctx.globalAlpha=1

      // t labels every 10
      ctx.fillStyle='#475569'; ctx.font='9px monospace'; ctx.textAlign='center'
      for (let i=0;i<30;i+=10) {
        const fp2=fPts[i]
        ctx.fillText(`t${i+1}`,fp2.sx, fp2.sy-10)
      }

      // Legend
      ctx.font='bold 11px sans-serif'; ctx.textAlign='left'
      ctx.fillStyle='#06b6d4'; ctx.fillText('▶ Fresh (SoH=95%)',16,20)
      ctx.fillStyle='#ef4444'; ctx.fillText('▶ Aged  (SoH=50%)',16,36)
      // Centroid separation
      const centDist: number = (traj?.[blockKey]?.centroid_dist) ?? 0
      if (centDist > 0) {
        ctx.fillStyle='#10b981'; ctx.font='bold 10px monospace'
        ctx.fillText(`Centroid separation: ${centDist.toFixed(1)} units`,16,56)
        ctx.fillStyle='#475569'; ctx.font='9px monospace'
        ctx.fillText('(larger = more distinct state spaces)',16,70)
      }
      ctx.fillStyle='#475569'; ctx.font='9px monospace'
      ctx.fillText(`PC1: ${(ev[0]*100).toFixed(0)}%  PC2: ${(ev[1]*100).toFixed(0)}%  PC3: ${(ev[2]*100).toFixed(0)}%  · Blue=t1 Red=t30`,16,H-10)
      ctx.fillStyle='#f59e0b'; ctx.font='9px monospace'
      ctx.fillText(`t=${Math.round(scanPos.current)+1}`,W-50,20)

      raf.current = requestAnimationFrame(draw)
    }
    raf.current = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf.current)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [traj, blockKey])

  return <canvas ref={canvasRef} width={760} height={460} style={{width:'100%',height:460,display:'block',cursor:'grab'}} />
}

// ════════════════════════════════════════════════════════════════
// ATTENTION GLOBE CANVAS — 3D sphere with beam particles
// ════════════════════════════════════════════════════════════════

interface GlobeParticle { anchorIdx: number; progress: number; speed: number; fromIdx: number }

function AttentionGlobeCanvas({ weights, anchorImportance, cycleT }:
  { weights: number[][]; anchorImportance: number[]; cycleT: number }) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const raf         = useRef<number>(0)
  const rotY        = useRef(0)
  const dragging    = useRef(false)
  const lastMouse   = useRef({x:0,y:0})
  const cycleTRef   = useRef(cycleT)
  const scanPos     = useRef(cycleT)
  const particles   = useRef<GlobeParticle[]>([])
  const spawnTick   = useRef(0)
  const tick        = useRef(0)

  useEffect(() => { cycleTRef.current = cycleT }, [cycleT])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const CX = W*0.42, CY = H/2, FOV = 520
    const R = 120  // sphere radius
    const COLS_A = ['#10b981','#f59e0b','#ef4444']
    const ANCHOR_POS = [
      [R*2.2, -R*0.4, 0],
      [R*0.6,  R*2.2, 0],
      [R*0.6, -R*0.9, R*2.0],
    ]

    // Helix: t=1 at south pole (y=-R), t=30 at north pole (y=+R), 2 full helix turns
    // Position encodes time semantically (latitude = cycle progress)
    const cyclePts3D = Array.from({length:30},(_,i)=>{
      const frac = i/29
      const y = R*(frac*2-1)
      const r2 = R*Math.sqrt(Math.max(0, 1-(frac*2-1)**2))*0.85
      const theta = frac * 4 * Math.PI
      return [r2*Math.cos(theta), y, r2*Math.sin(theta)] as [number,number,number]
    })

    const rotX = 0.3

    const project = (x:number,y:number,z:number) => {
      const cy=Math.cos(rotY.current),sy=Math.sin(rotY.current)
      const cx=Math.cos(rotX),sx=Math.sin(rotX)
      const rx=x*cy-z*sy, rz=x*sy+z*cy
      const ry2=y*cx-rz*sx, rz2=y*sx+rz*cx
      const sc=FOV/(FOV+rz2+100)
      return {sx:CX+rx*sc, sy:CY+ry2*sc, sc, depth:rz2}
    }

    const bezierPt = (t:number,x0:number,y0:number,z0:number,x1:number,y1:number,z1:number) => ({
      x:(1-t)*x0+t*x1, y:(1-t)*y0+t*y1, z:(1-t)*z0+t*z1
    })

    const onDown=(e:MouseEvent)=>{dragging.current=true;lastMouse.current={x:e.clientX,y:e.clientY}}
    const onMove=(e:MouseEvent)=>{
      if(!dragging.current)return
      rotY.current+=(e.clientX-lastMouse.current.x)*0.007
      lastMouse.current={x:e.clientX,y:e.clientY}
    }
    const onUp=()=>{dragging.current=false}
    canvas.addEventListener('mousedown',onDown)
    window.addEventListener('mousemove',onMove)
    window.addEventListener('mouseup',onUp)

    function draw() {
      tick.current++
      scanPos.current += (cycleTRef.current - scanPos.current) * 0.09
      if (!dragging.current) rotY.current += 0.005

      ctx.clearRect(0,0,W,H)
      ctx.fillStyle='#080c18'; ctx.fillRect(0,0,W,H)

      // Wireframe sphere (latitude/longitude lines)
      ctx.strokeStyle='#1e3a5f'; ctx.lineWidth=0.5; ctx.globalAlpha=0.35
      for (let lat=-80;lat<=80;lat+=20) {
        const y=R*Math.sin(lat*Math.PI/180)
        const r=R*Math.cos(lat*Math.PI/180)
        ctx.beginPath()
        for (let lon=0;lon<=360;lon+=5) {
          const rad=lon*Math.PI/180
          const {sx,sy}=project(r*Math.cos(rad),y,r*Math.sin(rad))
          lon===0?ctx.moveTo(sx,sy):ctx.lineTo(sx,sy)
        }
        ctx.stroke()
      }
      for (let lon=0;lon<360;lon+=30) {
        const rad=lon*Math.PI/180
        ctx.beginPath()
        for (let lat=-80;lat<=80;lat+=5) {
          const y=R*Math.sin(lat*Math.PI/180)
          const r2=R*Math.cos(lat*Math.PI/180)
          const {sx,sy}=project(r2*Math.cos(rad),y,r2*Math.sin(rad))
          lat===-80?ctx.moveTo(sx,sy):ctx.lineTo(sx,sy)
        }
        ctx.stroke()
      }
      ctx.globalAlpha=1

      // Cycle dots on sphere surface (depth-sorted)
      const curIdx = Math.min(29,Math.max(0,Math.round(scanPos.current)))
      const dotData = cyclePts3D.map((pt,i)=>{
        const p=project(pt[0],pt[1],pt[2])
        const isCur=i===curIdx
        return {...p,i,isCur}
      }).sort((a,b)=>b.depth-a.depth)

      for (const d of dotData) {
        const alpha = d.isCur ? 1 : 0.4
        const r = d.isCur ? 7*d.sc : 3*d.sc
        ctx.globalAlpha=alpha; ctx.fillStyle=d.isCur?'#f59e0b':'#475569'
        ctx.beginPath(); ctx.arc(d.sx,d.sy,r,0,Math.PI*2); ctx.fill()
        if (d.isCur) {
          const g=ctx.createRadialGradient(d.sx,d.sy,0,d.sx,d.sy,20*d.sc)
          g.addColorStop(0,'rgba(245,158,11,0.5)'); g.addColorStop(1,'rgba(245,158,11,0)')
          ctx.fillStyle=g; ctx.beginPath(); ctx.arc(d.sx,d.sy,20*d.sc,0,Math.PI*2); ctx.fill()
        }
        if (d.i%5===0) {
          ctx.fillStyle='#334155'; ctx.font='8px monospace'; ctx.textAlign='center'
          ctx.fillText(`t${d.i+1}`,d.sx,d.sy-r-3)
        }
      }
      ctx.globalAlpha=1

      // Beams from current cycle to anchors
      const cp=cyclePts3D[curIdx]
      const rowW=weights[curIdx]??[0.33,0.33,0.33]
      for (let ai=0;ai<3;ai++) {
        const w=rowW[ai]??0.33
        const ap=ANCHOR_POS[ai]
        const col=COLS_A[ai]
        // Sample 10 points along the curve for 3D beam
        const pts=Array.from({length:12},(_,i)=>{
          const t=i/11
          const bp=bezierPt(t,cp[0],cp[1],cp[2],ap[0],ap[1],ap[2])
          return project(bp.x,bp.y,bp.z)
        })
        // Glow
        ctx.globalAlpha=w*0.1; ctx.strokeStyle=col; ctx.lineWidth=(1+w*9)*2
        ctx.beginPath(); ctx.moveTo(pts[0].sx,pts[0].sy)
        pts.slice(1).forEach(p=>ctx.lineTo(p.sx,p.sy)); ctx.stroke()
        // Main
        ctx.globalAlpha=0.4+w*0.6; ctx.lineWidth=1+w*8
        ctx.strokeStyle=col
        ctx.beginPath(); ctx.moveTo(pts[0].sx,pts[0].sy)
        pts.slice(1).forEach(p=>ctx.lineTo(p.sx,p.sy)); ctx.stroke()
        ctx.globalAlpha=1
        // Weight label
        const mid=pts[6]; ctx.fillStyle=col; ctx.font='bold 10px monospace'; ctx.textAlign='center'
        ctx.fillText(`${(w*100).toFixed(0)}%`,mid.sx,mid.sy-4)
      }
      ctx.globalAlpha=1

      // Anchor nodes
      for (let ai=0;ai<3;ai++) {
        const ap=ANCHOR_POS[ai]
        const p=project(ap[0],ap[1],ap[2])
        const imp=anchorImportance[ai]??0.33
        const col=COLS_A[ai]
        const nr=16+imp*14
        const g=ctx.createRadialGradient(p.sx,p.sy,0,p.sx,p.sy,nr*2.5)
        g.addColorStop(0,col+'66'); g.addColorStop(1,col+'00')
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(p.sx,p.sy,nr*2.5,0,Math.PI*2); ctx.fill()
        ctx.fillStyle=col+'44'; ctx.strokeStyle=col; ctx.lineWidth=2
        ctx.beginPath(); ctx.arc(p.sx,p.sy,nr,0,Math.PI*2); ctx.fill(); ctx.stroke()
        ctx.fillStyle=col; ctx.font='bold 10px sans-serif'; ctx.textAlign='left'
        ctx.fillText(['Fresh','Knee','Near-EOL'][ai],p.sx+nr+6,p.sy-3)
        ctx.font='9px monospace'
        ctx.fillText(`${(imp*100).toFixed(1)}%`,p.sx+nr+6,p.sy+11)
      }

      // Beam particles
      spawnTick.current++
      if (spawnTick.current%2===0) {
        for (let ai=0;ai<3;ai++) {
          if (Math.random()<(rowW[ai]??0.33)*1.3)
            particles.current.push({anchorIdx:ai,progress:Math.random()*0.05,speed:0.012+Math.random()*0.012,fromIdx:curIdx})
        }
      }
      particles.current = particles.current.filter(p=>p.progress<1)
      for (const p of particles.current) {
        p.progress+=p.speed
        const cp2=cyclePts3D[p.fromIdx]
        const ap=ANCHOR_POS[p.anchorIdx]
        const col=COLS_A[p.anchorIdx]
        const bp=bezierPt(p.progress,cp2[0],cp2[1],cp2[2],ap[0],ap[1],ap[2])
        const pp=project(bp.x,bp.y,bp.z)
        ctx.globalAlpha=Math.sin(p.progress*Math.PI)*0.9
        ctx.fillStyle=col; ctx.beginPath(); ctx.arc(pp.sx,pp.sy,3.5,0,Math.PI*2); ctx.fill()
      }
      ctx.globalAlpha=1

      // Labels
      ctx.fillStyle='#94a3b8'; ctx.font='bold 11px sans-serif'; ctx.textAlign='left'
      // Entropy readout
      const curRowW = weights[Math.min(29,Math.max(0,Math.round(scanPos.current)))] ?? [0.33,0.33,0.33]
      const entS = curRowW.reduce((a:number,b:number)=>a+b,0)||1
      const ent = -curRowW.reduce((h:number,w:number)=>{ const p=w/entS; return h+(p>0?p*Math.log2(p):0) },0)
      ctx.fillStyle='#94a3b8'; ctx.font='10px monospace'; ctx.textAlign='left'
      ctx.fillText(`t=${Math.round(scanPos.current)+1}  entropy: ${ent.toFixed(3)} bits  (helix: south=t1, north=t30)`,12,16)
      ctx.fillStyle='#475569'; ctx.font='9px monospace'
      ctx.fillText('Attention Globe — drag to orbit',12,H-14)

      raf.current=requestAnimationFrame(draw)
    }
    raf.current=requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf.current)
      canvas.removeEventListener('mousedown',onDown)
      window.removeEventListener('mousemove',onMove)
      window.removeEventListener('mouseup',onUp)
    }
  }, [weights, anchorImportance])

  return <canvas ref={canvasRef} width={720} height={500} style={{width:'100%',height:500,display:'block',cursor:'grab'}} />
}

// ════════════════════════════════════════════════════════════════
// ATTENTION ANIMATED HEATMAP
// ════════════════════════════════════════════════════════════════

function AttentionView({ fresh, aged, cycleT }:
  { fresh: ForwardResult|null; aged: ForwardResult|null; cycleT: number }) {

  const aw = fresh?.attention.weights_L_anchors ?? Array.from({length:30}, () => [0.33,0.33,0.33])
  const awA = aged?.attention.weights_L_anchors ?? Array.from({length:30}, () => [0.33,0.33,0.33])

  const rowEntropy = (row: number[]) => {
    const s = row.reduce((a,b)=>a+b,0)||1
    return -row.reduce((h,w)=>{ const p=w/s; return h+(p>0?p*Math.log2(p):0) },0)
  }
  const avgEnt = (ws: number[][]) => ws.reduce((s,r)=>s+rowEntropy(r),0)/ws.length
  const freshAvgEnt = avgEnt(aw)
  const agedAvgEnt  = avgEnt(awA)
  void freshAvgEnt; void agedAvgEnt  // used in per-heatmap entropy display

  // Animated current-cycle line
  const cycleLine = {
    type: 'line' as const,
    x0: -0.5, x1: 2.5,
    y0: 29 - cycleT, y1: 29 - cycleT,
    line: { color: '#f59e0b', width: 2.5, dash: 'dot' as const },
  }

  const heatLayout = {
    ...darkLayout,
    height: 320,
    margin: { t: 30, b: 50, l: 60, r: 60 },
    xaxis: { ...darkLayout.xaxis as object, side: 'top', tickfont: { color: '#94a3b8', size: 10 } },
    yaxis: { ...darkLayout.yaxis as object, tickfont: { color: '#94a3b8', size: 9 } },
    transition: { duration: 400, easing: 'cubic-in-out' },
    shapes: [cycleLine],
    annotations: [{ x: 2.5, y: 29 - cycleT, text: `t=${cycleT+1}`, font: { color: '#f59e0b', size: 10 }, showarrow: false, xanchor: 'left' as const }],
  } as Plotly.Layout

  return (
    <div className="grid grid-cols-2 gap-4">
      {[
        { data: aw,  label: 'Fresh (SOH=95%)', r: fresh, c: '#10b981' },
        { data: awA, label: 'Aged  (SOH=50%)', r: aged,  c: '#ef4444' },
      ].map(({ data, label, r, c }) => (
        <div key={label} className="panel p-5" style={{ borderColor: c + '33' }}>
          <h3 className="section-title mb-1" style={{ color: c }}>{label}</h3>
          <p className="text-xs text-text-muted mb-2">30 cycles × 3 anchors. Yellow line = current cycle t={cycleT+1}.</p>
          <Plot
            data={[{ type:'heatmap', z:data, x:ANCHOR_LABELS, y:Array.from({length:30},(_,i)=>`t${i+1}`),
              colorscale:'Blues', zmin:0, zmax:1, showscale:true,
              colorbar:{ tickfont:{color:'#64748b',size:9}, thickness:10 } }]}
            layout={heatLayout}
            config={{ ...plotConfig, displayModeBar: false }}
            style={{ width:'100%' }}
          />
          {r && (
            <div className="grid grid-cols-3 gap-2 mt-2">
              {ANCHOR_LABELS.map((a, ai) => (
                <motion.div key={a} className="rounded p-2 text-center"
                  animate={{ backgroundColor: ANCHOR_COLORS[ai] + (Math.round((r.attention.anchor_importance[ai]??0) * 60 + 10)).toString(16).padStart(2,'0') }}
                  transition={{ duration: 0.3 }}>
                  <div className="text-xs" style={{color:ANCHOR_COLORS[ai]}}>{a}</div>
                  <motion.div className="font-mono text-sm font-bold" style={{color:ANCHOR_COLORS[ai]}}
                    animate={{ opacity:[0.6,1,0.6] }} transition={{duration:1.5,repeat:Infinity,delay:ai*0.4}}>
                    {((r.attention.anchor_importance[ai]??0)*100).toFixed(1)}%
                  </motion.div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* Diff heatmap */}
      {aw.length > 0 && awA.length > 0 && (
        <div className="panel p-5 col-span-2">
          <h3 className="section-title mb-2">Attention Difference: Fresh − Aged (What degrades attention?)</h3>
          <p className="text-xs text-text-muted mb-3">Values &gt;|0.10| mark significant attention shift due to cell aging.</p>
          <Plot
            data={[{ type:'heatmap',
              z: aw.map((row,i) => row.map((v,j) => v - (awA[i]?.[j]??0))),
              x:ANCHOR_LABELS, y:Array.from({length:30},(_,i)=>`t${i+1}`),
              colorscale:[[0,'#7f1d1d'],[0.4,'#1e3a5f'],[0.5,'#111827'],[0.6,'#052e16'],[1,'#065f46']],
              showscale:true,
              colorbar:{tickfont:{color:'#64748b',size:9},thickness:12},
              zmin:-0.4, zmax:0.4 }]}
            layout={{ ...darkLayout, height:220, margin:{t:10,b:50,l:60,r:60},
              xaxis:{...darkLayout.xaxis as object,side:'top'},
              transition:{duration:400} } as Plotly.Layout}
            config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}}
          />
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// ACTIVATION NORMS — animated bars + line traces
// ════════════════════════════════════════════════════════════════

function ActivationView({ fresh, aged, cycleT }:
  { fresh: ForwardResult|null; aged: ForwardResult|null; cycleT: number }) {

  const freshNorms = LAYER_KEYS.map(k => {
    const l = fresh?.layers[k]; if (!l?.norm_per_step) return 0
    const t = Math.min(cycleT, l.norm_per_step.length-1)
    return l.norm_per_step[t] ?? 0
  })
  const agedNorms = LAYER_KEYS.map(k => {
    const l = aged?.layers[k]; if (!l?.norm_per_step) return 0
    const t = Math.min(cycleT, l.norm_per_step.length-1)
    return l.norm_per_step[t] ?? 0
  })
  const pctChange = LAYER_KEYS.map((_,i) =>
    freshNorms[i] > 0 ? ((freshNorms[i] - agedNorms[i]) / freshNorms[i] * 100) : 0
  )
  const cumFresh = freshNorms.reduce((a,b)=>a+b,0)
  const cumAged  = agedNorms.reduce((a,b)=>a+b,0)

  return (
    <div className="space-y-4">
      {/* Animated canvas bar chart */}
      <div className="panel p-5">
        <p className="text-xs text-text-muted mb-2">Bars spring-animate as cycle advances. Bright = Fresh (95% SOH), dim = Aged (50% SOH).</p>
        <NormBarsCanvas freshNorms={freshNorms} agedNorms={agedNorms} cycleT={cycleT} />
      </div>

      {/* Line traces over all 30 cycles */}
      <div className="panel p-5">
        <h3 className="section-title mb-1">Activation Norms Over 30 Cycles — Fresh vs Aged</h3>
        <Plot
          data={[
            ...LAYER_KEYS.slice(1,6).map((k,ki) => ({
              type:'scatter' as const, mode:'lines' as const, name:`${LAYER_LABELS[ki+1]} (fresh)`,
              x: Array.from({length:30},(_,i)=>i+1),
              y: fresh?.layers[k]?.norm_per_step ?? [],
              line:{color:LAYER_COLORS[ki+1], width:2},
            })),
            // Current position marker
            { type:'scatter' as const, mode:'markers' as const, name:'Current t',
              x:[cycleT+1], y:[getNorm(fresh,'mamba0_out',cycleT)],
              marker:{color:'#f59e0b',size:14,symbol:'diamond',line:{color:'#fff',width:2}},
            },
          ]}
          layout={{ ...darkLayout, height:260,
            xaxis:{...darkLayout.xaxis as object, title:{text:'Cycle position in window',font:{color:'#64748b'}}},
            yaxis:{...darkLayout.yaxis as object, title:{text:'L2 norm',font:{color:'#64748b'}}},
            shapes:[{type:'line',x0:cycleT+1,x1:cycleT+1,y0:0,y1:2,line:{color:'#f59e0b',dash:'dot',width:1.5}}],
            transition:{duration:300},
          } as Plotly.Layout}
          config={plotConfig} style={{width:'100%'}}
        />
      </div>

      {/* Per-layer diff */}
      <div className="panel p-5">
        <h3 className="section-title mb-3">Fresh − Aged Activation Difference at t={cycleT+1}</h3>
        <Plot
          data={[{
            type:'bar', orientation:'h',
            x: LAYER_KEYS.map((_,i) => freshNorms[i] - agedNorms[i]),
            y: LAYER_LABELS,
            marker:{ color: LAYER_KEYS.map((_,i) => (freshNorms[i]-agedNorms[i]) > 0 ? '#10b981' : '#ef4444'), opacity:0.85 },
            text: LAYER_KEYS.map((_,i) => {
              const diff = freshNorms[i]-agedNorms[i]
              return `${diff>0?'+':''}${diff.toFixed(3)} (${pctChange[i]>0?'+':''}${pctChange[i].toFixed(1)}%)`
            }),
            textposition:'outside',
          }]}
          layout={{ ...darkLayout, height:240, margin:{t:10,b:40,l:130,r:60},
            xaxis:{...darkLayout.xaxis as object, title:{text:'Difference (Fresh−Aged)',font:{color:'#64748b'}},zeroline:true,zerolinecolor:'#475569',zerolinewidth:2},
            transition:{duration:300,easing:'cubic-in-out'},
          } as Plotly.Layout}
          config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}}
        />
      </div>
      <div className="panel p-3 flex items-center gap-6 flex-wrap">
        <span className="text-xs text-text-muted">Cumulative activation energy (Σ L2 norms over all layers):</span>
        <span className="font-mono text-sm font-bold text-green-400">Fresh: {cumFresh.toFixed(3)}</span>
        <span className="font-mono text-sm font-bold text-red-400">Aged: {cumAged.toFixed(3)}</span>
        <span className="font-mono text-sm font-bold text-amber-400">
          Δ = {cumFresh>0 ? ((cumFresh-cumAged)/cumFresh*100).toFixed(1) : '0'}% reduction
        </span>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// SSM CANVAS — scanline + particle animation
// ════════════════════════════════════════════════════════════════

interface SsmParticle { x:number; y:number; vx:number; vy:number; life:number; col:string }

function SsmCanvas({ blockData, cycleT }: { blockData:number[][], cycleT:number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animRef   = useRef<number>(0)
  const scanPos   = useRef<number>(cycleT)
  const cycleTRef = useRef<number>(cycleT)
  const parts     = useRef<SsmParticle[]>([])
  const lastRow   = useRef<number>(-1)

  useEffect(() => { cycleTRef.current = cycleT }, [cycleT])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const ROWS = 30, COLS = 32
    const cw = (W - 16) / COLS, ch = H / ROWS
    const maxAbs = Math.max(...blockData.flat().map(Math.abs), 0.01)

    function cellColor(val:number, alpha:number):string {
      const n = (val / maxAbs + 1) / 2
      let r,g,b
      if (n < 0.5) { const t=n*2; r=Math.round(t*220);g=Math.round(t*220);b=255 }
      else          { const t=(n-0.5)*2; r=255;g=Math.round((1-t)*220);b=Math.round((1-t)*220) }
      return `rgba(${r},${g},${b},${alpha})`
    }

    function spawnRow(row:number) {
      for (let c=0;c<COLS;c++) {
        const val = blockData[row]?.[c]??0
        if (Math.abs(val) > maxAbs*0.55 && Math.random()<0.25) {
          const n=(val/maxAbs+1)/2
          const col=n>0.5
            ? `rgba(255,${Math.round((1-(n-0.5)*2)*160)},60,0.9)`
            : `rgba(60,${Math.round(n*2*160)},255,0.9)`
          parts.current.push({
            x:c*cw+cw/2, y:row*ch+ch/2,
            vx:(Math.random()-0.5)*2.5, vy:(Math.random()-1.8)*2,
            life:1, col
          })
        }
      }
    }

    function draw() {
      scanPos.current += (cycleTRef.current - scanPos.current) * 0.10
      const cur = Math.round(scanPos.current)
      if (cur !== lastRow.current) { spawnRow(cur); lastRow.current=cur }
      ctx.clearRect(0,0,W,H)
      // cells
      for (let r=0;r<ROWS;r++) {
        const dist = Math.abs(r-scanPos.current)
        const alpha = dist<2 ? 1 : Math.max(0.3, 0.9-dist*0.06)
        for (let c=0;c<COLS;c++) {
          ctx.fillStyle = cellColor(blockData[r]?.[c]??0, alpha)
          ctx.fillRect(c*cw+0.5, r*ch+0.5, cw-1, ch-1)
        }
      }
      // scanline glow
      const sy = scanPos.current*ch + ch/2
      const grd = ctx.createLinearGradient(0,sy-ch*3,0,sy+ch*3)
      grd.addColorStop(0,'rgba(245,158,11,0)'); grd.addColorStop(0.5,'rgba(245,158,11,0.15)'); grd.addColorStop(1,'rgba(245,158,11,0)')
      ctx.fillStyle=grd; ctx.fillRect(0,sy-ch*3,W-16,ch*6)
      // scanline
      ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1.5; ctx.setLineDash([5,4])
      ctx.beginPath(); ctx.moveTo(0,sy); ctx.lineTo(W-16,sy); ctx.stroke(); ctx.setLineDash([])
      // t label
      ctx.fillStyle='#f59e0b'; ctx.font='bold 10px monospace'; ctx.textAlign='right'
      ctx.fillText(`t=${Math.round(scanPos.current)+1}`,W-20,sy-3)
      ctx.textAlign='left'
      // particles
      parts.current = parts.current.filter(p=>p.life>0)
      for (const p of parts.current) {
        p.x+=p.vx; p.y+=p.vy; p.vy+=0.09; p.life-=0.022
        ctx.globalAlpha=p.life; ctx.fillStyle=p.col
        ctx.beginPath(); ctx.arc(p.x,p.y,2.5,0,Math.PI*2); ctx.fill()
      }
      ctx.globalAlpha=1
      // color legend strip
      for (let i=0;i<40;i++) {
        const n=i/39; ctx.fillStyle=cellColor(maxAbs*(n*2-1),1)
        ctx.fillRect(W-14, i*(H/40), 12, H/40)
      }
      ctx.fillStyle='#64748b'; ctx.font='8px monospace'; ctx.textAlign='center'
      ctx.fillText('+',W-8,10); ctx.fillText('0',W-8,H/2); ctx.fillText('−',W-8,H-4)
      animRef.current = requestAnimationFrame(draw)
    }
    animRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animRef.current)
  }, [blockData])

  return <canvas ref={canvasRef} width={784} height={400} style={{width:'100%',height:400,display:'block'}} />
}

// ════════════════════════════════════════════════════════════════
// TOKEN ATTN CANVAS — arc beams + flowing particles
// ════════════════════════════════════════════════════════════════

interface BeamParticle { from:number; to:number; progress:number; speed:number }

function TokenAttnCanvas({ weights, anchorImportance, cycleT }:
  { weights:number[][], anchorImportance:number[], cycleT:number }) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const animRef     = useRef<number>(0)
  const scanPos     = useRef<number>(cycleT)
  const cycleTRef   = useRef<number>(cycleT)
  const beams       = useRef<BeamParticle[]>([])
  const spawnTick   = useRef<number>(0)

  useEffect(() => { cycleTRef.current = cycleT }, [cycleT])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const ROWS = 30
    const LX = 55, RX = W-110
    const rowH = (H-40)/ROWS
    const anchorY = [H*0.22, H*0.5, H*0.78]
    const COLS_A = ['#10b981','#f59e0b','#ef4444']

    function cycleY(r:number):number { return 20 + r*rowH + rowH/2 }

    function draw() {
      scanPos.current += (cycleTRef.current - scanPos.current) * 0.09
      ctx.clearRect(0,0,W,H)

      // cycle dots
      for (let r=0;r<ROWS;r++) {
        const dist = Math.abs(r-scanPos.current)
        const alpha = Math.max(0.12, 0.7-dist*0.12)
        ctx.globalAlpha=alpha; ctx.fillStyle='#475569'
        ctx.beginPath(); ctx.arc(LX,cycleY(r),dist<1.5?5:3,0,Math.PI*2); ctx.fill()
        if (r%5===0||dist<1.5) {
          ctx.fillStyle=dist<1.5?'#f59e0b':'#334155'
          ctx.font=`${dist<1.5?'bold ':''} 9px monospace`; ctx.textAlign='right'
          ctx.fillText(`t${r+1}`,LX-8,cycleY(r)+3)
        }
      }

      // active cycle glow
      ctx.globalAlpha=1
      const cy=cycleY(scanPos.current)
      const glow=ctx.createRadialGradient(LX,cy,0,LX,cy,22)
      glow.addColorStop(0,'rgba(245,158,11,0.45)'); glow.addColorStop(1,'rgba(245,158,11,0)')
      ctx.fillStyle=glow; ctx.beginPath(); ctx.arc(LX,cy,22,0,Math.PI*2); ctx.fill()
      ctx.fillStyle='#f59e0b'; ctx.beginPath(); ctx.arc(LX,cy,6,0,Math.PI*2); ctx.fill()

      // arcs for current cycle
      const curRow = Math.min(29,Math.max(0,Math.round(scanPos.current)))
      const rowW = weights[curRow]??[0.33,0.33,0.33]
      for (let ai=0;ai<3;ai++) {
        const w = rowW[ai]??0.33
        const ay = anchorY[ai], col=COLS_A[ai]
        const cpX=(LX+RX)/2, cpY=(cy+ay)/2-30
        // outer glow
        ctx.globalAlpha=w*0.12; ctx.strokeStyle=col; ctx.lineWidth=(1+w*8)*2.5
        ctx.beginPath(); ctx.moveTo(LX,cy); ctx.quadraticCurveTo(cpX,cpY,RX,ay); ctx.stroke()
        // main arc
        ctx.globalAlpha=0.45+w*0.55; ctx.strokeStyle=col; ctx.lineWidth=1+w*7
        ctx.beginPath(); ctx.moveTo(LX,cy); ctx.quadraticCurveTo(cpX,cpY,RX,ay); ctx.stroke()
        // weight label
        ctx.globalAlpha=1; ctx.fillStyle=col; ctx.font='bold 10px monospace'; ctx.textAlign='center'
        ctx.fillText(`${(w*100).toFixed(0)}%`, cpX, cpY-5)
      }
      ctx.globalAlpha=1

      // anchor nodes
      for (let ai=0;ai<3;ai++) {
        const ay=anchorY[ai], imp=anchorImportance[ai]??0.33, col=COLS_A[ai]
        const r=12+imp*16
        const g=ctx.createRadialGradient(RX,ay,0,RX,ay,r*2.2)
        g.addColorStop(0,col+'55'); g.addColorStop(1,col+'00')
        ctx.fillStyle=g; ctx.beginPath(); ctx.arc(RX,ay,r*2.2,0,Math.PI*2); ctx.fill()
        ctx.fillStyle=col+'33'; ctx.strokeStyle=col; ctx.lineWidth=2
        ctx.beginPath(); ctx.arc(RX,ay,r,0,Math.PI*2); ctx.fill(); ctx.stroke()
        ctx.fillStyle=col; ctx.font='bold 10px sans-serif'; ctx.textAlign='left'
        ctx.fillText(['Fresh','Knee','Near-EOL'][ai],RX+r+7,ay-4)
        ctx.font='9px monospace'
        ctx.fillText(`${(imp*100).toFixed(1)}%`,RX+r+7,ay+10)
      }

      // beam particles
      spawnTick.current++
      if (spawnTick.current%2===0) {
        for (let ai=0;ai<3;ai++) {
          if (Math.random()<(rowW[ai]??0.33)*1.2)
            beams.current.push({from:scanPos.current,to:ai,progress:Math.random()*0.1,speed:0.012+Math.random()*0.014})
        }
      }
      beams.current = beams.current.filter(p=>p.progress<1)
      for (const p of beams.current) {
        p.progress+=p.speed
        const y0=cycleY(p.from), ay=anchorY[p.to], col=COLS_A[p.to]
        const cpX=(LX+RX)/2, cpY=(y0+ay)/2-30
        const t=p.progress
        const px=(1-t)*(1-t)*LX+2*(1-t)*t*cpX+t*t*RX
        const py=(1-t)*(1-t)*y0+2*(1-t)*t*cpY+t*t*ay
        ctx.globalAlpha=Math.sin(t*Math.PI)*0.9
        ctx.fillStyle=col; ctx.beginPath(); ctx.arc(px,py,3,0,Math.PI*2); ctx.fill()
      }
      ctx.globalAlpha=1
      animRef.current = requestAnimationFrame(draw)
    }
    animRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animRef.current)
  }, [weights, anchorImportance])

  return <canvas ref={canvasRef} width={720} height={500} style={{width:'100%',height:500,display:'block'}} />
}

// ════════════════════════════════════════════════════════════════
// NORM BARS CANVAS — spring-animated grouped bars
// ════════════════════════════════════════════════════════════════

function NormBarsCanvas({ freshNorms, agedNorms, cycleT }:
  { freshNorms:number[], agedNorms:number[], cycleT:number }) {
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const animRef     = useRef<number>(0)
  const intFresh    = useRef<number[]>(Array(8).fill(0))
  const intAged     = useRef<number[]>(Array(8).fill(0))
  const freshRef    = useRef<number[]>(freshNorms)
  const agedRef     = useRef<number[]>(agedNorms)
  const cycleTRef   = useRef<number>(cycleT)

  useEffect(() => { freshRef.current=freshNorms; agedRef.current=agedNorms }, [freshNorms, agedNorms])
  useEffect(() => { cycleTRef.current=cycleT }, [cycleT])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W=canvas.width, H=canvas.height
    const pL=110,pR=20,pT=32,pB=50
    const gW=W-pL-pR, gH=H-pT-pB
    const N=8, grpW=gW/N, bW=grpW*0.33
    const shorts=['Emb','Mb1','Mb2','Mb3','Attn','MLP','ReLU','Out']

    function draw() {
      const sp=0.10
      for (let i=0;i<N;i++) {
        intFresh.current[i]+=(freshRef.current[i]-intFresh.current[i])*sp
        intAged.current[i]+=(agedRef.current[i]-intAged.current[i])*sp
      }
      ctx.clearRect(0,0,W,H)
      const maxV = Math.max(...freshRef.current,...agedRef.current,0.01)
      const scale = (gH*0.82)/maxV

      // axis
      ctx.strokeStyle='#1e3a5f'; ctx.lineWidth=1
      ctx.beginPath(); ctx.moveTo(pL,pT); ctx.lineTo(pL,H-pB); ctx.moveTo(pL,H-pB); ctx.lineTo(W-pR,H-pB); ctx.stroke()
      // gridlines
      ctx.setLineDash([3,6]); ctx.strokeStyle='#1e293b'
      for (let g=1;g<=4;g++) {
        const y=H-pB-g*(gH*0.82/4)
        ctx.beginPath(); ctx.moveTo(pL,y); ctx.lineTo(W-pR,y); ctx.stroke()
        ctx.fillStyle='#475569'; ctx.font='9px monospace'; ctx.textAlign='right'
        ctx.fillText((maxV*g/4).toFixed(2),pL-4,y+3)
      }
      ctx.setLineDash([])

      for (let i=0;i<N;i++) {
        const cx=pL+i*grpW+grpW/2
        // fresh bar
        const fH=Math.max(0,intFresh.current[i]*scale)
        const fX=cx-bW-1, fY=H-pB-fH
        const fg=ctx.createLinearGradient(0,fY,0,H-pB)
        fg.addColorStop(0,LAYER_COLORS[i]); fg.addColorStop(1,LAYER_COLORS[i]+'44')
        ctx.fillStyle=fg; ctx.fillRect(fX,fY,bW,fH)
        ctx.fillStyle='#ffffff28'; ctx.fillRect(fX,fY,bW,3)
        if (fH>18) {
          ctx.fillStyle='#f1f5f9'; ctx.font='8px monospace'; ctx.textAlign='center'
          ctx.fillText(freshRef.current[i].toFixed(2),fX+bW/2,fY-3)
        }
        // aged bar
        const aH=Math.max(0,intAged.current[i]*scale)
        const aX=cx+1, aY=H-pB-aH
        const ag=ctx.createLinearGradient(0,aY,0,H-pB)
        ag.addColorStop(0,LAYER_COLORS[i]+'88'); ag.addColorStop(1,LAYER_COLORS[i]+'18')
        ctx.fillStyle=ag; ctx.fillRect(aX,aY,bW,aH)
        // x label
        ctx.fillStyle='#64748b'; ctx.font='9px sans-serif'; ctx.textAlign='center'
        ctx.fillText(shorts[i],cx,H-pB+14)
      }
      // legend
      ctx.fillStyle=LAYER_COLORS[2]; ctx.fillRect(pL,8,12,9)
      ctx.fillStyle='#94a3b8'; ctx.font='10px sans-serif'; ctx.textAlign='left'
      ctx.fillText('Fresh (95%)',pL+16,17)
      ctx.fillStyle=LAYER_COLORS[2]+'77'; ctx.fillRect(pL+105,8,12,9)
      ctx.fillStyle='#64748b'; ctx.fillText('Aged (50%)',pL+121,17)
      ctx.fillStyle='#94a3b8'; ctx.font='bold 11px sans-serif'; ctx.textAlign='center'
      ctx.fillText(`Activation Norms — t=${cycleTRef.current+1}`,W/2,16)
      animRef.current = requestAnimationFrame(draw)
    }
    animRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animRef.current)
  }, [])

  return <canvas ref={canvasRef} width={760} height={280} style={{width:'100%',height:280,display:'block'}} />
}

// ════════════════════════════════════════════════════════════════
// INPUT SCANNER CANVAS — sweeping column highlight over feature grid
// ════════════════════════════════════════════════════════════════

function InputScannerCanvas({ features, cycleT, saliencyOverlay }:
  { features:number[][], cycleT:number, saliencyOverlay?: number[][]|null }) {
  const canvasRef  = useRef<HTMLCanvasElement>(null)
  const animRef    = useRef<number>(0)
  const scanPos    = useRef<number>(cycleT)
  const cycleTRef  = useRef<number>(cycleT)

  useEffect(() => { cycleTRef.current=cycleT }, [cycleT])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W=canvas.width, H=canvas.height
    const ROWS=30, COLS=13
    const lblW=58, lblH=22
    const gridW=W-lblW, gridH=H-lblH
    const cw=gridW/ROWS, ch=gridH/COLS

    const colMin=Array.from({length:COLS},(_,c)=>Math.min(...features.map(r=>r[c]??0)))
    const colMax=Array.from({length:COLS},(_,c)=>Math.max(...features.map(r=>r[c]??0),colMin[c]+0.001))

    function rdYlGn(n:number):string {
      if (n<0.5){const t=n*2;return `rgb(220,${Math.round(t*200)},50)`}
      const t=(n-0.5)*2;return `rgb(${Math.round((1-t)*60)},${Math.round(140+t*100)},50)`
    }

    function draw() {
      scanPos.current += (cycleTRef.current - scanPos.current) * 0.10
      ctx.clearRect(0,0,W,H)
      // cells
      for (let r=0;r<ROWS;r++) {
        const dist=Math.abs(r-scanPos.current)
        const alpha=dist<1.5?1:Math.max(0.35,0.85-dist*0.045)
        for (let c=0;c<COLS;c++) {
          const raw=features[r]?.[c]??0
          const n=(raw-colMin[c])/(colMax[c]-colMin[c])
          ctx.globalAlpha=alpha; ctx.fillStyle=rdYlGn(n)
          ctx.fillRect(lblW+r*cw, c*ch, cw-0.5, ch-0.5)
        }
      }
      ctx.globalAlpha=1
      // saliency overlay
      if (saliencyOverlay && saliencyOverlay.length > 0) {
        const maxS = Math.max(...saliencyOverlay.flat(), 0.001)
        for (let r=0;r<ROWS;r++) {
          for (let c=0;c<COLS;c++) {
            const sv = (saliencyOverlay[r]?.[c]??0) / maxS
            if (sv > 0.1) {
              ctx.globalAlpha = sv * 0.55
              ctx.fillStyle = '#f59e0b'
              ctx.fillRect(lblW+r*cw, c*ch, cw-0.5, ch-0.5)
            }
          }
        }
        ctx.globalAlpha = 1
      }
      // scanner glow
      const sx=lblW+scanPos.current*cw+cw/2
      const sg=ctx.createLinearGradient(sx-cw*3,0,sx+cw*3,0)
      sg.addColorStop(0,'rgba(245,158,11,0)'); sg.addColorStop(0.5,'rgba(245,158,11,0.22)'); sg.addColorStop(1,'rgba(245,158,11,0)')
      ctx.fillStyle=sg; ctx.fillRect(sx-cw*3,0,cw*6,gridH)
      // scanner line
      ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1.5; ctx.setLineDash([4,4])
      ctx.beginPath(); ctx.moveTo(sx,0); ctx.lineTo(sx,gridH); ctx.stroke(); ctx.setLineDash([])
      // t label
      ctx.fillStyle='#f59e0b'; ctx.font='bold 9px monospace'; ctx.textAlign='center'
      ctx.fillText(`t${Math.round(scanPos.current)+1}`,sx,gridH+14)
      // feature names
      ctx.fillStyle='#94a3b8'; ctx.font='9px sans-serif'; ctx.textAlign='right'
      for (let c=0;c<COLS;c++)
        ctx.fillText(FEATURE_NAMES[c],lblW-3,c*ch+ch/2+3)
      // cycle ticks
      ctx.fillStyle='#475569'; ctx.font='9px monospace'; ctx.textAlign='center'
      for (let r=0;r<ROWS;r+=5)
        ctx.fillText(`t${r+1}`,lblW+r*cw+cw/2,gridH+14)
      animRef.current=requestAnimationFrame(draw)
    }
    animRef.current=requestAnimationFrame(draw)
    return () => cancelAnimationFrame(animRef.current)
  }, [features])

  return <canvas ref={canvasRef} width={720} height={360} style={{width:'100%',height:360,display:'block'}} />
}

// ════════════════════════════════════════════════════════════════
// WEIGHT MATRIX VIEW
// ════════════════════════════════════════════════════════════════

function WeightView({ weights, loadWeights }:
  { weights: Record<string,WeightMatrix>|null; loadWeights: ()=>void }) {
  const tick = useRef(0)

  useEffect(() => {
    const id = setInterval(() => { tick.current++ }, 50)
    return () => clearInterval(id)
  }, [])

  if (!weights) return (
    <div className="panel p-12 text-center">
      <button onClick={loadWeights} className="btn-primary flex items-center gap-2 mx-auto">
        <Cpu size={15} /> Load Real Weight Matrices
      </button>
    </div>
  )

  const entries = Object.entries(weights)
    .sort(([,a],[,b]) => b.norm - a.norm)
    .slice(0, 6)

  return (
    <div className="grid grid-cols-2 gap-4">
      {entries.map(([name, mat]) => (
        <div key={name} className="panel p-4">
          <div className="text-xs font-mono text-text-accent mb-1 break-all leading-tight" title={name}>{name}</div>
          <div className="text-xs text-text-muted mb-2">
            shape={mat.shape.join('×')} · norm={mat.norm.toFixed(2)} · range=[{mat.min.toFixed(3)}, {mat.max.toFixed(3)}]
          </div>
          <Plot
            data={[{
              type:'heatmap', z:mat.data,
              colorscale:[
                [0,'#1e3a5f'],[0.2,'#1d4ed8'],[0.4,'#3b82f6'],
                [0.5,'#111827'],
                [0.6,'#dc2626'],[0.8,'#b91c1c'],[1,'#7f1d1d'],
              ],
              showscale:false,
              zmin:mat.min, zmax:mat.max,
            }]}
            layout={{ ...darkLayout, height:120, margin:{t:5,b:5,l:5,r:5},
              xaxis:{visible:false}, yaxis:{visible:false},
            } as Plotly.Layout}
            config={{displayModeBar:false,responsive:true}} style={{width:'100%'}}
          />
          {/* Animated weight norm bar */}
          <div className="mt-2">
            <div className="text-xs text-text-muted mb-0.5">Weight norm = {mat.norm.toFixed(3)}</div>
            <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <motion.div className="h-full rounded-full bg-gradient-to-r from-brand-blue to-brand-purple"
                animate={{ width:`${Math.min(100, mat.norm * 10)}%` }}
                transition={{ duration: 0.8, ease:'easeOut' }} />
            </div>
          </div>
          {(mat as any).top5_sv?.length > 0 && (
            <div className="mt-2">
              <div className="text-xs text-text-muted mb-1">Top-5 singular values (SVD)</div>
              <div className="flex gap-0.5 items-end h-8">
                {((mat as any).top5_sv as number[]).map((sv: number, si: number) => (
                  <div key={si} className="flex-1 rounded-sm bg-brand-purple/50" title={`σ${si+1}=${sv}`}
                    style={{ height:`${Math.round((sv/((mat as any).top5_sv[0]||1))*100)}%`, minHeight:2 }} />
                ))}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// SSM STATES VIEW
// ════════════════════════════════════════════════════════════════

function SsmView({ fullResult, cycleT }: { fullResult: any; cycleT: number }) {
  const blockKeys   = ['mamba0', 'mamba1', 'mamba2']
  const blockLabels = ['Mamba Block 1', 'Mamba Block 2', 'Mamba Block 3']
  const blockColors = ['#3b82f6', '#4f46e5', '#7c3aed']

  if (!fullResult) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm">Run a forward pass first to see SSM hidden states.</p>
    </div>
  )

  const ssm = fullResult?.ssm_states ?? {}

  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted px-1">30 timesteps × 32 SSM channels (sampled every 4th of 128) per Mamba block. Amber scanline = current cycle. Red=positive, blue=negative. Particles burst from high-activation cells.</p>
      <div className="grid grid-cols-3 gap-3">
        {blockKeys.map((bk, bi) => {
          const bd: number[][] = ssm[bk] ?? Array.from({length:30},()=>Array(32).fill(0))
          return (
            <div key={bk} className="panel p-3">
              <h4 className="text-xs font-semibold mb-2" style={{color:blockColors[bi]}}>{blockLabels[bi]}</h4>
              <SsmCanvas blockData={bd} cycleT={cycleT} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// TOKEN ATTENTION VIEW
// ════════════════════════════════════════════════════════════════

function TokenAttentionView({ fresh, aged, cycleT }: { fresh: ForwardResult | null; aged: ForwardResult | null; cycleT: number }) {
  if (!fresh) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm">Run a forward pass first to see token attention weights.</p>
    </div>
  )

  const freshW = fresh.attention.weights_L_anchors ?? Array.from({length:30},()=>[0.33,0.33,0.33])
  const agedW  = aged?.attention.weights_L_anchors  ?? Array.from({length:30},()=>[0.33,0.33,0.33])
  const freshImp = fresh.attention.anchor_importance ?? [0.33,0.33,0.33]
  const agedImp  = aged?.attention.anchor_importance  ?? [0.33,0.33,0.33]

  const rowEnt = (row: number[]) => {
    const s = row.reduce((a,b)=>a+b,0)||1
    return -row.reduce((h,w)=>{ const p=w/s; return h+(p>0?p*Math.log2(p):0) },0)
  }
  const ct = Math.min(cycleT, 29)
  const freshEnt = rowEnt(freshW[ct] ?? [0.33,0.33,0.33])
  const agedEnt  = rowEnt(agedW[ct]  ?? [0.33,0.33,0.33])

  return (
    <div className="space-y-3">
      <div className="flex gap-4 flex-wrap panel p-3">
        <span className="text-xs text-text-muted">Attention entropy at t={cycleT+1}:</span>
        <span className="font-mono text-xs font-bold text-green-400">Fresh: {freshEnt.toFixed(3)} bits</span>
        <span className="font-mono text-xs font-bold text-red-400">Aged: {agedEnt.toFixed(3)} bits</span>
        <span className="text-xs text-text-muted">(max 1.585 = uniform, lower = more focused)</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="panel p-4">
          <h4 className="text-xs font-semibold text-green-400 mb-2">Fresh (SOH=95%) — Token → Anchor Beams</h4>
          <TokenAttnCanvas weights={freshW} anchorImportance={freshImp} cycleT={cycleT} />
        </div>
        <div className="panel p-4">
          <h4 className="text-xs font-semibold text-red-400 mb-2">Aged (SOH=50%) — Token → Anchor Beams</h4>
          <TokenAttnCanvas weights={agedW} anchorImportance={agedImp} cycleT={cycleT} />
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// INPUT HEATMAP VIEW
// ════════════════════════════════════════════════════════════════

function InputHeatmapView({ fresh, cycleT, saliencyResult }: { fresh: ForwardResult | null; cycleT: number; saliencyResult: any }) {
  const [showSaliency, setShowSaliency] = useState(false)

  if (!fresh) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm">Run a forward pass first to see the input feature matrix.</p>
    </div>
  )

  const features = fresh.input_window?.features ?? Array.from({ length: 30 }, () => Array(13).fill(0))
  const hasSaliency = (saliencyResult?.saliency_map?.length ?? 0) > 0

  return (
    <div className="panel p-5">
      <h3 className="section-title mb-1">Input Feature Matrix — 30 cycles × 13 features</h3>
      <p className="text-xs text-text-muted mb-2">
        Amber scanner tracks current cycle. Green = high value, red = low. Compute Saliency first then toggle the overlay to see which cells drive the prediction.
      </p>
      {hasSaliency && (
        <button onClick={() => setShowSaliency(s => !s)}
          className={`mb-3 flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-all ${showSaliency ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40' : 'btn-ghost'}`}>
          {showSaliency ? '▣' : '▢'} Overlay Saliency Map
        </button>
      )}
      <InputScannerCanvas features={features} cycleT={cycleT} saliencyOverlay={showSaliency ? saliencyResult?.saliency_map : null} />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// SALIENCY VIEW
// ════════════════════════════════════════════════════════════════

function SaliencyView({ result, loading, onLoad, sohPct, onChangeSoh }: {
  result: any; loading: boolean; onLoad: () => void
  sohPct: number; onChangeSoh: (v: number) => void
}) {
  if (loading) return (
    <div className="panel p-12 text-center">
      <motion.div className="w-8 h-8 rounded-full border-2 border-brand-blue border-t-transparent mx-auto mb-3"
        animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
      <p className="text-text-muted text-sm">Computing saliency map…</p>
    </div>
  )

  if (!result) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm mb-4">Gradient × input attribution — which features drive the RUL prediction. Choose SOH level then compute.</p>
      <div className="flex gap-2 justify-center mb-4">
        {[50, 70, 85, 95].map(s => (
          <button key={s} onClick={() => onChangeSoh(s)}
            className={`px-3 py-1 rounded text-xs font-mono font-medium border transition-all ${sohPct===s?'bg-brand-blue/20 border-brand-blue text-brand-blue':'border-border-subtle text-text-muted'}`}>
            SOH={s}%
          </button>
        ))}
      </div>
      <button onClick={onLoad} className="btn-primary flex items-center gap-2 mx-auto">
        <BarChart2 size={15} /> Compute Saliency (SOH={sohPct}%)
      </button>
    </div>
  )

  const saliencyMap: number[][] = result.saliency_map ?? Array.from({ length: 30 }, () => Array(13).fill(0))
  const perFeature: number[] = result.saliency_per_feature ?? Array(13).fill(0)

  // Sort features descending for bar chart
  const sortedIdx = [...Array(13).keys()].sort((a, b) => perFeature[b] - perFeature[a])
  const sortedNames = sortedIdx.map(i => FEATURE_NAMES[i])
  const sortedVals = sortedIdx.map(i => perFeature[i])

  return (
    <div className="space-y-4">
      <div className="panel p-5">
        <h3 className="section-title mb-1">Saliency Map — gradient × input attribution</h3>
        <p className="text-xs text-text-muted mb-3">
          SOH={result.soh_pct ?? sohPct}% · model={result.model_id ?? '—'} · Red=increases RUL prediction, Blue=decreases.
        </p>
        <div className="flex gap-2 mb-3 flex-wrap">
          {[50, 70, 85, 95].map(s => (
            <button key={s} onClick={() => onChangeSoh(s)}
              className={`px-2 py-0.5 rounded text-xs font-mono border transition-all ${sohPct===s?'bg-brand-blue/20 border-brand-blue text-brand-blue':'border-border-subtle text-text-muted'}`}>
              SOH={s}%
            </button>
          ))}
          <button onClick={onLoad} className="btn-ghost text-xs flex items-center gap-1 ml-2">
            <RotateCcw size={11}/> Recompute
          </button>
        </div>
        <Plot
          data={[{
            type: 'heatmap',
            z: saliencyMap,
            x: FEATURE_NAMES,
            y: Array.from({ length: 30 }, (_, i) => `t${i + 1}`),
            colorscale: 'RdBu',
            reversescale: true,
            showscale: true,
            colorbar: { tickfont: { color: '#64748b', size: 9 }, thickness: 12 },
          }]}
          layout={{
            ...darkLayout,
            height: 380,
            margin: { t: 10, b: 80, l: 60, r: 80 },
            xaxis: { ...darkLayout.xaxis as object, tickangle: -40, tickfont: { color: '#94a3b8', size: 10 } },
            yaxis: { ...darkLayout.yaxis as object, tickfont: { color: '#64748b', size: 9 } },
          } as Plotly.Layout}
          config={{ ...plotConfig, displayModeBar: false }}
          style={{ width: '100%' }}
        />
      </div>
      <div className="panel p-5">
        <h3 className="section-title mb-3">Feature Importance (aggregated saliency, sorted)</h3>
        <div className="space-y-1.5">
          {sortedNames.map((name, i) => {
            const maxVal = sortedVals[0] || 1
            const pct = (sortedVals[i] / maxVal) * 100
            const hue = Math.round(30 + (i / (sortedNames.length - 1)) * 30)
            const lum = Math.round(65 - (i / (sortedNames.length - 1)) * 25)
            const col = `hsl(${hue},90%,${lum}%)`
            return (
              <div key={name} className="flex items-center gap-2">
                <span className="text-xs text-text-muted w-20 text-right shrink-0">{name}</span>
                <div className="flex-1 h-5 bg-bg-elevated rounded overflow-hidden">
                  <motion.div className="h-full rounded"
                    style={{ backgroundColor: col }}
                    initial={{ width: 0 }}
                    animate={{ width: `${pct}%` }}
                    transition={{ duration: 0.7, delay: i * 0.04, ease: [0.34, 1.56, 0.64, 1] }}
                  />
                </div>
                <span className="font-mono text-xs w-14 shrink-0" style={{ color: col }}>{sortedVals[i].toFixed(4)}</span>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// HISTOGRAM VIEW
// ════════════════════════════════════════════════════════════════

const HIST_LAYER_KEYS = ['embedding', 'mamba0_out', 'mamba1_out', 'mamba2_out', 'attn_out']
const HIST_LAYER_LABELS = ['Embed', 'Mamba1', 'Mamba2', 'Mamba3', 'Attn']
const HIST_LAYER_COLORS = ['#06b6d4', '#3b82f6', '#4f46e5', '#7c3aed', '#8b5cf6']

function HistogramView({ fullResult, cycleT }: { fullResult: any; cycleT: number }) {
  const [selectedLayer, setSelectedLayer] = useState(0)

  if (!fullResult) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm">Run a forward pass first to see activation histograms.</p>
    </div>
  )

  const histData = fullResult?.layer_histograms ?? {}
  const layerKey = HIST_LAYER_KEYS[selectedLayer]
  const hist = histData[layerKey] ?? { bins: [], counts: [], mean: 0, std: 0 }
  const bins: number[] = hist.bins ?? []
  const counts: number[] = hist.counts ?? []
  const mean: number = hist.mean ?? 0
  const std: number = hist.std ?? 0

  return (
    <div className="space-y-4">
      <div className="panel p-5">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="section-title">Activation Distribution — {HIST_LAYER_LABELS[selectedLayer]}</h3>
          <div className="flex gap-1 ml-auto">
            {HIST_LAYER_LABELS.map((label, i) => (
              <button key={i} onClick={() => setSelectedLayer(i)}
                className="px-3 py-1 rounded-lg text-xs font-medium transition-all"
                style={selectedLayer === i
                  ? { backgroundColor: HIST_LAYER_COLORS[i] + '33', color: HIST_LAYER_COLORS[i], border: `1px solid ${HIST_LAYER_COLORS[i]}55` }
                  : { backgroundColor: '#111827', color: '#64748b', border: '1px solid #1e3a5f' }}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-text-muted mb-3">
          Distribution of all channel activations across all 30 timesteps (full window). μ={mean.toFixed(4)}, σ={std.toFixed(4)}.
          {fullResult?.layer_stats_per_step?.[layerKey] && (() => {
            const s = fullResult.layer_stats_per_step[layerKey]
            const mn: number = s.mean_per_step?.[Math.min(cycleT,29)] ?? 0
            const sd: number = s.std_per_step?.[Math.min(cycleT,29)] ?? 0
            return <span className="ml-2 text-amber-400">At t={cycleT+1}: μ={mn.toFixed(4)}, σ={sd.toFixed(4)}</span>
          })()}
        </p>
        {(() => {
          const gaussX = bins.length > 1 ? Array.from({length:50},(_,i)=>{
            const mn2=bins[0], mx2=bins[bins.length-1]; return mn2+i*(mx2-mn2)/49
          }) : []
          const maxC = Math.max(...counts, 1)
          const gaussY = gaussX.map(x => maxC * Math.exp(-0.5*((x-mean)/Math.max(std,0.0001))**2))
          return (
        <Plot
          data={[{
            type: 'bar', x: bins, y: counts,
            marker: { color: HIST_LAYER_COLORS[selectedLayer], opacity: 0.8 },
            name: HIST_LAYER_LABELS[selectedLayer],
          }, {
            type: 'scatter', mode: 'lines', name: 'N(μ,σ²) fit',
            x: gaussX, y: gaussY,
            line: { color: '#f59e0b', width: 1.5, dash: 'dot' as const },
          }]}
          layout={{
            ...darkLayout,
            height: 300,
            margin: { t: 10, b: 50, l: 60, r: 20 },
            xaxis: { ...darkLayout.xaxis as object, title: { text: 'Activation value', font: { color: '#64748b' } } },
            yaxis: { ...darkLayout.yaxis as object, title: { text: 'Count', font: { color: '#64748b' } } },
            annotations: [
              {
                x: mean, y: Math.max(...counts) * 0.9,
                text: `μ=${mean.toFixed(3)}`, font: { color: '#f59e0b', size: 11 },
                showarrow: true, arrowhead: 2, arrowcolor: '#f59e0b', ax: 40, ay: -20,
              },
              {
                x: mean + std, y: Math.max(...counts) * 0.6,
                text: `μ+σ=${(mean + std).toFixed(3)}`, font: { color: '#94a3b8', size: 10 },
                showarrow: true, arrowhead: 2, arrowcolor: '#94a3b8', ax: 50, ay: -15,
              },
            ],
            shapes: [
              { type: 'line', x0: mean, x1: mean, y0: 0, y1: Math.max(...counts), line: { color: '#f59e0b', dash: 'dash', width: 1.5 } },
            ],
          } as Plotly.Layout}
          config={{ ...plotConfig, displayModeBar: false }}
          style={{ width: '100%' }}
        />
          )
        })()}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// DEAD CHANNEL VIEW
// ════════════════════════════════════════════════════════════════

const DEAD_LAYER_KEYS = ['mamba0_out', 'mamba1_out', 'mamba2_out', 'attn_out', 'mlp_relu']
const DEAD_LAYER_LABELS = ['Mamba1 Out', 'Mamba2 Out', 'Mamba3 Out', 'Attn Out', 'MLP ReLU']
const DEAD_LAYER_COLORS = ['#3b82f6', '#4f46e5', '#7c3aed', '#8b5cf6', '#10b981']

function DeadChannelView({ fullResult, freshFullResult }: { fullResult: any; freshFullResult: any }) {
  if (!fullResult) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm">Run a forward pass first to detect dead/weak channels.</p>
    </div>
  )

  const deadData = fullResult?.dead_channels ?? {}
  const freshDeadData = freshFullResult?.dead_channels ?? {}

  return (
    <div className="space-y-4">
      <div className="panel p-5">
        <h3 className="section-title mb-1">Dead Channel Detector — Near-Zero Activations</h3>
        <p className="text-xs text-text-muted mb-4">
          Red = dead (mean_abs &lt; 0.01) · Amber = weak (0.01–0.05) · Green = active (&gt; 0.05).
          Hover over squares to see mean absolute activation.
        </p>
        <div className="space-y-5">
          {DEAD_LAYER_KEYS.map((lk, li) => {
            // Backend returns { n_dead, dead_fraction, mean_abs_per_channel: number[] }
            const layerData = deadData[lk]
            const rawVals: number[] = Array.isArray(layerData)
              ? layerData.map((c: any) => typeof c === 'number' ? c : (c?.mean_abs ?? 0))
              : (layerData?.mean_abs_per_channel ?? Array(64).fill(0))
            const channels = rawVals.map((v: number) => ({ mean_abs: v }))

            const dead = channels.filter(c => c.mean_abs < 0.01).length
            const weak = channels.filter(c => c.mean_abs >= 0.01 && c.mean_abs < 0.05).length
            const active = channels.length - dead - weak
            const pctDead = channels.length > 0 ? (dead / channels.length * 100).toFixed(1) : '0'

            const freshLayerData = freshDeadData[lk]
            const freshVals: number[] = Array.isArray(freshLayerData)
              ? freshLayerData.map((c: any) => typeof c === 'number' ? c : (c?.mean_abs ?? 0))
              : (freshLayerData?.mean_abs_per_channel ?? rawVals)

            return (
              <div key={lk}>
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-sm font-medium" style={{ color: DEAD_LAYER_COLORS[li] }}>{DEAD_LAYER_LABELS[li]}</span>
                  <span className="text-xs text-text-muted">{dead} dead / {weak} weak / {active} active ({pctDead}% dead in aged)</span>
                </div>
                {([
                  { label: 'Fresh (95%)', vals: freshVals, rowColor: '#10b981' },
                  { label: 'Aged (50%)',  vals: rawVals,   rowColor: '#ef4444' },
                ] as {label:string;vals:number[];rowColor:string}[]).map(({ label: rl, vals: rv, rowColor }) => (
                  <div key={rl} className="mb-1 flex items-start gap-2">
                    <span className="text-xs font-mono w-20 shrink-0 mt-0.5" style={{color:rowColor}}>{rl}</span>
                    <div className="flex flex-wrap gap-0.5">
                      {rv.map((v: number, ci: number) => {
                        const freshV = freshVals[ci] ?? v
                        const isNewlyDead = rl.startsWith('Aged') && freshV >= 0.05 && v < 0.01
                        const col = v < 0.01 ? '#ef4444' : v < 0.05 ? '#f59e0b' : '#10b981'
                        return (
                          <div key={ci} title={`ch${ci}: ${v.toFixed(4)}`}
                            className="w-3.5 h-3.5 rounded-sm cursor-pointer transition-transform hover:scale-150"
                            style={{ backgroundColor: col, opacity: v<0.01?0.9:0.3+Math.min(v*4,0.7),
                              outline: isNewlyDead ? '2px solid #f59e0b' : 'none' }}
                          />
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// CHEM COMPARE VIEW
// ════════════════════════════════════════════════════════════════

const CHEM_LIST = ['LCO', 'LFP', 'NMC', 'NCM']

function ChemCompareView({ result, loading, onLoad }: { result: any; loading: boolean; onLoad: () => void }) {
  const [normLayer, setNormLayer] = useState('mamba2_out')
  const normLayerLabels: Record<string,string> = {mamba0_out:'Mamba1',mamba1_out:'Mamba2',mamba2_out:'Mamba3',attn_out:'Attn'}
  if (loading) return (
    <div className="panel p-12 text-center">
      <motion.div className="w-8 h-8 rounded-full border-2 border-brand-blue border-t-transparent mx-auto mb-3"
        animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
      <p className="text-text-muted text-sm">Comparing all chemistries…</p>
    </div>
  )

  if (!result) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm mb-4">Run a side-by-side comparison of all 4 battery chemistries at SOH=85%.</p>
      <button onClick={onLoad} className="btn-primary flex items-center gap-2 mx-auto">
        <Layers size={15} /> Compare All Chemistries
      </button>
    </div>
  )

  const chemResults: Record<string, any> = result.results ?? {}

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3">
        {CHEM_LIST.map(chem => {
          const cr = chemResults[chem] ?? {}
          const rul = cr.rul_predicted ?? 0
          const anchors: number[] = cr.anchor_importance ?? [0.33, 0.33, 0.33]
          return (
            <div key={chem} className="panel p-4" style={{ borderColor: CHEM_COLORS[chem] + '44' }}>
              <div className="text-xs font-bold mb-1" style={{ color: CHEM_COLORS[chem] }}>{chem}</div>
              <div className="text-2xl font-mono font-bold text-text-primary mb-2">{rul.toFixed(0)}</div>
              <div className="text-xs text-text-muted mb-2">cycles RUL</div>
              {ANCHOR_LABELS.map((a, ai) => (
                <div key={a} className="flex items-center gap-1 mb-0.5">
                  <span className="text-xs text-text-muted w-12 truncate">{a.split(' ')[0]}</span>
                  <div className="flex-1 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{ backgroundColor: ANCHOR_COLORS[ai], width: `${(anchors[ai] ?? 0) * 100}%` }} />
                  </div>
                  <span className="font-mono text-xs" style={{ color: ANCHOR_COLORS[ai] }}>{((anchors[ai] ?? 0) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* Activation norm lines */}
      <div className="panel p-5">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="section-title">Activation Norm per Step — all chemistries</h3>
          <div className="flex gap-1 ml-auto">
            {Object.entries(normLayerLabels).map(([k,label])=>(
              <button key={k} onClick={()=>setNormLayer(k)}
                className={`px-2 py-0.5 rounded text-xs font-medium border transition-all ${normLayer===k?'bg-brand-blue/20 text-brand-blue border-brand-blue/40':'text-text-muted border-border-subtle'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <Plot
          data={CHEM_LIST.map(chem => ({
            type: 'scatter' as const,
            mode: 'lines' as const,
            name: chem,
            x: Array.from({ length: 30 }, (_, i) => i + 1),
            y: chemResults[chem]?.layer_norms?.[normLayer] ?? chemResults[chem]?.mamba2_out_norm_per_step ?? [],
            line: { color: CHEM_COLORS[chem], width: 2 },
          }))}
          layout={{
            ...darkLayout,
            height: 260,
            margin: { t: 10, b: 50, l: 60, r: 20 },
            xaxis: { ...darkLayout.xaxis as object, title: { text: 'Cycle', font: { color: '#64748b' } } },
            yaxis: { ...darkLayout.yaxis as object, title: { text: 'Activation norm', font: { color: '#64748b' } } },
            legend: { ...darkLayout.legend },
          } as Plotly.Layout}
          config={{ ...plotConfig, displayModeBar: false }}
          style={{ width: '100%' }}
        />
      </div>

      {/* Anchor importance grouped bars */}
      <div className="panel p-5">
        <h3 className="section-title mb-3">Anchor Importance — all chemistries side-by-side</h3>
        <Plot
          data={CHEM_LIST.map(chem => ({
            type: 'bar' as const,
            name: chem,
            x: ANCHOR_LABELS,
            y: chemResults[chem]?.anchor_importance ?? [0, 0, 0],
            marker: { color: CHEM_COLORS[chem], opacity: 0.82 },
          }))}
          layout={{
            ...darkLayout,
            height: 240,
            barmode: 'group',
            margin: { t: 10, b: 50, l: 60, r: 20 },
            yaxis: { ...darkLayout.yaxis as object, title: { text: 'Importance', font: { color: '#64748b' } }, range: [0, 1] },
            legend: { ...darkLayout.legend },
          } as Plotly.Layout}
          config={{ ...plotConfig, displayModeBar: false }}
          style={{ width: '100%' }}
        />
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// T-SNE VIEW
// ════════════════════════════════════════════════════════════════

function TsneView({ result, loading, onLoad }: { result: any; loading: boolean; onLoad: () => void }) {
  if (loading) return (
    <div className="panel p-12 text-center">
      <motion.div className="w-8 h-8 rounded-full border-2 border-brand-blue border-t-transparent mx-auto mb-3"
        animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} />
      <p className="text-text-muted text-sm">Running t-SNE on 40 forward passes…</p>
    </div>
  )

  if (!result) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm mb-4">
        Project the attn_out activation space of 40 forward passes (varying SOH) into 2D via t-SNE.
      </p>
      <button onClick={onLoad} className="btn-primary flex items-center gap-2 mx-auto">
        <Box size={15} /> Run t-SNE (40 points)
      </button>
    </div>
  )

  const xs: number[] = result.x ?? []
  const ys: number[] = result.y ?? []
  const sohs: number[] = result.soh ?? []
  const ruls: number[] = result.rul ?? []
  const stages: string[] = result.stage_labels ?? result.stage ?? sohs.map(s => s > 80 ? 'Fresh' : s > 60 ? 'Aging' : s > 40 ? 'Knee' : 'Near-EOL')
  const silhouette: number | null = result.silhouette_score ?? null
  const perplexity: number = result.perplexity ?? 15

  // Degradation trajectory (sort by SOH descending)
  const sortedBySOH = [...Array(xs.length).keys()].sort((a,b) => sohs[b]-sohs[a])

  // Compute stage centroids for annotations
  const stageCentroids: Record<string, { x: number[]; y: number[] }> = {}
  stages.forEach((st, i) => {
    if (!stageCentroids[st]) stageCentroids[st] = { x: [], y: [] }
    stageCentroids[st].x.push(xs[i])
    stageCentroids[st].y.push(ys[i])
  })
  const stageAnnotations = Object.entries(stageCentroids).map(([st, pts]) => ({
    x: pts.x.reduce((a, b) => a + b, 0) / pts.x.length,
    y: pts.y.reduce((a, b) => a + b, 0) / pts.y.length,
    text: st,
    font: { color: '#f1f5f9', size: 12 },
    showarrow: false,
    bgcolor: '#1a2233cc',
    bordercolor: '#1e3a5f',
    borderwidth: 1,
    borderpad: 4,
  }))

  return (
    <div className="panel p-5">
      <h3 className="section-title mb-1">Activation t-SNE — attn_out features colored by SOH</h3>
      <div className="flex gap-4 mb-3 flex-wrap">
        {silhouette !== null && (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-text-muted">Silhouette score:</span>
            <span className={`font-mono font-bold ${silhouette > 0.5 ? 'text-green-400' : silhouette > 0.25 ? 'text-amber-400' : 'text-red-400'}`}>
              {silhouette.toFixed(3)}
            </span>
            <span className="text-text-muted">({silhouette > 0.5 ? 'well-separated' : silhouette > 0.25 ? 'moderate' : 'overlapping'})</span>
          </div>
        )}
        <span className="text-xs text-text-muted">perplexity={perplexity} · n_iter=500 · {xs.length} samples · amber dashed = degradation path</span>
      </div>
      <Plot
        data={[{
          type: 'scatter', mode: 'lines', name: 'Degradation path',
          x: sortedBySOH.map(i=>xs[i]), y: sortedBySOH.map(i=>ys[i]),
          line: { color: '#f59e0b', width: 1, dash: 'dot' as const },
          opacity: 0.45, showlegend: true,
        }, {
          type: 'scatter',
          mode: 'markers',
          x: xs,
          y: ys,
          marker: {
            color: sohs,
            colorscale: 'Plasma',
            size: 8,
            showscale: true,
            colorbar: {
              title: { text: 'SOH%', font: { color: '#94a3b8', size: 11 } },
              tickfont: { color: '#64748b', size: 9 },
              thickness: 14,
            },
            line: { color: '#1a2233', width: 0.5 },
          },
          text: sohs.map((s, i) => `SOH: ${s.toFixed(1)}% | RUL: ${(ruls[i] ?? 0).toFixed(0)} | ${stages[i]}`),
          hoverinfo: 'text',
        }] as Plotly.Data[]}
        layout={{
          ...darkLayout,
          height: 480,
          margin: { t: 10, b: 50, l: 60, r: 100 },
          xaxis: { ...darkLayout.xaxis as object, title: { text: 't-SNE dim 1', font: { color: '#64748b' } }, zeroline: false },
          yaxis: { ...darkLayout.yaxis as object, title: { text: 't-SNE dim 2', font: { color: '#64748b' } }, zeroline: false },
          annotations: stageAnnotations,
        } as Plotly.Layout}
        config={plotConfig}
        style={{ width: '100%' }}
      />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// SSM TRAJECTORY VIEW
// ════════════════════════════════════════════════════════════════

function SsmTrajectoryView({ cycleT, modelId, chemistry }:
  { cycleT: number; modelId: string; chemistry: string }) {
  const [traj, setTraj]       = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [block, setBlock]     = useState('mamba2')
  const blockKeys   = ['mamba0','mamba1','mamba2']
  const blockLabels = ['Mamba Block 1','Mamba Block 2','Mamba Block 3']
  const blockColors = ['#3b82f6','#4f46e5','#7c3aed']

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/activations/ssm-trajectory', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ model_id: modelId, soh_pct: 85, chemistry })
      })
      if (res.ok) setTraj(await res.json())
    } finally { setLoading(false) }
  }, [modelId, chemistry])

  if (loading) return (
    <div className="panel p-12 text-center">
      <motion.div className="w-8 h-8 rounded-full border-2 border-brand-blue border-t-transparent mx-auto mb-3"
        animate={{rotate:360}} transition={{duration:1,repeat:Infinity,ease:'linear'}}/>
      <p className="text-text-muted text-sm">PCA-projecting SSM hidden states…</p>
    </div>
  )

  if (!traj) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm mb-4">Project the 32-dim Mamba hidden state h_t into 3D via PCA. Fresh and aged cells trace completely different trajectories — visually proving the SSM encodes degradation state.</p>
      <button onClick={load} className="btn-primary flex items-center gap-2 mx-auto">
        <Box size={15}/> Compute Trajectory
      </button>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="panel p-5">
        <div className="flex items-center gap-3 mb-3">
          <h3 className="section-title">SSM State-Space Trajectory — 3D PCA Projection</h3>
          <div className="flex gap-1 ml-auto">
            {blockLabels.map((label,i)=>(
              <button key={i} onClick={()=>setBlock(blockKeys[i])}
                className="px-3 py-1 rounded-lg text-xs font-medium transition-all"
                style={block===blockKeys[i]
                  ?{backgroundColor:blockColors[i]+'33',color:blockColors[i],border:`1px solid ${blockColors[i]}55`}
                  :{backgroundColor:'#111827',color:'#64748b',border:'1px solid #1e3a5f'}}>
                {label}
              </button>
            ))}
          </div>
          <button onClick={load} className="btn-ghost text-xs flex items-center gap-1 ml-2">
            <RotateCcw size={12}/> Recompute
          </button>
        </div>
        <p className="text-xs text-text-muted mb-3">Drag to orbit. Cyan = Fresh cell trajectory, Red = Aged. The fact they separate in state space proves the model encodes degradation. Play to watch the cursor sweep both paths.</p>
        <SsmTrajectoryCanvas traj={traj} blockKey={block} cycleT={cycleT} />
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// GLOBE VIEW
// ════════════════════════════════════════════════════════════════

function GlobeView({ fresh, cycleT }: { fresh: ForwardResult|null; cycleT: number }) {
  if (!fresh) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm">Run a forward pass first.</p>
    </div>
  )
  const weights = fresh.attention.weights_L_anchors ?? Array.from({length:30},()=>[0.33,0.33,0.33])
  const anchorImportance = fresh.attention.anchor_importance ?? [0.33,0.33,0.33]
  return (
    <div className="panel p-5">
      <h3 className="section-title mb-1">Attention Globe — 3D anchor attention map</h3>
      <p className="text-xs text-text-muted mb-3">30 cycle positions on sphere surface. Beams connect to anchors with thickness = attention weight. Drag to orbit. Particles stream toward dominant anchor.</p>
      <AttentionGlobeCanvas weights={weights} anchorImportance={anchorImportance} cycleT={cycleT} />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// CHEM MINI VIEW — 4-chemistry racing activation canvas
// ════════════════════════════════════════════════════════════════

function ChemMiniView({ result, loading, onLoad, cycleT }:
  { result: any; loading: boolean; onLoad: ()=>void; cycleT: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf       = useRef<number>(0)
  const cycleTRef = useRef(cycleT)
  const scanPos   = useRef(cycleT)

  useEffect(()=>{ cycleTRef.current=cycleT },[cycleT])

  useEffect(()=>{
    if (!result) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W=canvas.width, H=canvas.height
    const CHEMS=['LCO','LFP','NMC','NCM']
    const CHEM_C={'LCO':'#3b82f6','LFP':'#10b981','NMC':'#f59e0b','NCM':'#8b5cf6'} as Record<string,string>
    const pL=60, pR=20, pT=30, pB=30
    const gW=W-pL-pR
    const chemH=(H-pT-pB)/4 - 4

    function draw(){
      scanPos.current+=(cycleTRef.current - scanPos.current)*0.10
      ctx.clearRect(0,0,W,H)
      ctx.fillStyle='#080c18'; ctx.fillRect(0,0,W,H)

      // Shared y-axis max for honest comparison
      const sharedMax = Math.max(...CHEMS.flatMap(chem=>{
        const cr=result?.results?.[chem]??{}
        return cr[`mamba2_out_norm_per_step`]??cr?.layer_norms?.mamba2_out??[]
      }), 0.01)

      CHEMS.forEach((chem,ci)=>{
        const cr = result?.results?.[chem]??{}
        const norms: number[] = cr[`mamba2_out_norm_per_step`] ?? cr?.layer_norms?.mamba2_out ?? Array(30).fill(0)
        const rul: number = cr.rul_predicted ?? 0
        const col = CHEM_C[chem]
        const y0 = pT + ci*(chemH+4)
        const maxV = sharedMax   // shared axis — honest comparison

        // Panel bg
        ctx.fillStyle='#0d1424'; ctx.fillRect(pL, y0, gW, chemH)

        // Activation trace
        ctx.strokeStyle=col; ctx.lineWidth=1.5; ctx.globalAlpha=0.8
        ctx.beginPath()
        norms.forEach((v,i)=>{
          const x=pL+i*gW/29
          const y=y0+chemH-(v/maxV)*(chemH*0.85)
          i===0?ctx.moveTo(x,y):ctx.lineTo(x,y)
        })
        ctx.stroke()
        ctx.globalAlpha=1

        // Fill under trace
        ctx.globalAlpha=0.08; ctx.fillStyle=col
        ctx.beginPath(); ctx.moveTo(pL, y0+chemH)
        norms.forEach((v,i)=>ctx.lineTo(pL+i*gW/29, y0+chemH-(v/maxV)*(chemH*0.85)))
        ctx.lineTo(pL+gW, y0+chemH); ctx.closePath(); ctx.fill()
        ctx.globalAlpha=1

        // EOL marker: first cycle where norm drops below 20% of shared max
        const eolCycle = norms.findIndex(v=>v < sharedMax*0.2)
        if (eolCycle >= 0) {
          const ex = pL+eolCycle*gW/29
          ctx.strokeStyle=col+'88'; ctx.lineWidth=1; ctx.setLineDash([2,3])
          ctx.beginPath(); ctx.moveTo(ex,y0); ctx.lineTo(ex,y0+chemH); ctx.stroke()
          ctx.setLineDash([])
          ctx.fillStyle=col; ctx.font='8px monospace'; ctx.textAlign='center'
          ctx.fillText(`EOL~t${eolCycle+1}`,ex,y0+chemH-3)
        }

        // Scanline
        const sx = pL + scanPos.current*gW/29
        ctx.strokeStyle='#f59e0b55'; ctx.lineWidth=1; ctx.setLineDash([3,3])
        ctx.beginPath(); ctx.moveTo(sx,y0); ctx.lineTo(sx,y0+chemH); ctx.stroke()
        ctx.setLineDash([])

        // Current value dot
        const ci2=Math.min(29,Math.max(0,Math.round(scanPos.current)))
        const vNow=norms[ci2]??0
        const dotX=pL+ci2*gW/29
        const dotY=y0+chemH-(vNow/maxV)*(chemH*0.85)
        ctx.fillStyle='#f59e0b'; ctx.beginPath(); ctx.arc(dotX,dotY,4,0,Math.PI*2); ctx.fill()

        // Labels
        ctx.fillStyle=col; ctx.font='bold 10px sans-serif'; ctx.textAlign='right'
        ctx.fillText(chem, pL-4, y0+chemH/2+4)
        ctx.fillStyle='#94a3b8'; ctx.font='9px monospace'; ctx.textAlign='left'
        ctx.fillText(`RUL:${rul.toFixed(0)}  now:${vNow.toFixed(3)}`, pL+4, y0+12)
      })

      // Axis label
      ctx.fillStyle='#475569'; ctx.font='9px monospace'; ctx.textAlign='center'
      for(let i=0;i<30;i+=5){
        const x=pL+i*gW/29
        ctx.fillText(`t${i+1}`,x,H-4)
      }

      raf.current=requestAnimationFrame(draw)
    }
    raf.current=requestAnimationFrame(draw)
    return ()=>cancelAnimationFrame(raf.current)
  },[result])

  if (loading) return (
    <div className="panel p-12 text-center">
      <motion.div className="w-8 h-8 rounded-full border-2 border-brand-blue border-t-transparent mx-auto mb-3"
        animate={{rotate:360}} transition={{duration:1,repeat:Infinity,ease:'linear'}}/>
      <p className="text-text-muted text-sm">Comparing all 4 chemistries…</p>
    </div>
  )
  if (!result) return (
    <div className="panel p-12 text-center">
      <p className="text-text-muted text-sm mb-4">4-chemistry racing canvas — watch Mamba3 activation norms for LCO/LFP/NMC/NCM simultaneously as the cycle scrubber plays.</p>
      <button onClick={onLoad} className="btn-primary flex items-center gap-2 mx-auto">
        <Layers size={15}/> Load All Chemistries
      </button>
    </div>
  )
  return (
    <div className="panel p-5">
      <h3 className="section-title mb-1">4-Chemistry Racing Canvas</h3>
      <p className="text-xs text-text-muted mb-3">Mamba3 activation norm over 30 cycles for each chemistry at SOH=85%. Amber cursor tracks current cycle. Play to race all four simultaneously.</p>
      <canvas ref={canvasRef} width={760} height={380} style={{width:'100%',height:380,display:'block'}} />
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// MAIN PAGE
// ════════════════════════════════════════════════════════════════

type ViewMode = '2d'|'3d'|'attention'|'weights'|'gradient'|'ssm'|'token-attn'|'input-heat'|'saliency'|'histogram'|'dead'|'chem-compare'|'tsne'|'ssm-3d'|'globe'|'chem-mini'

export default function NeuronAnimation() {
  const [viewMode, setViewMode] = useState<ViewMode>('2d')
  const [modelId, setModelId] = useState('v10-final')
  const [chemistry, setChemistry] = useState('LCO')
  const [cycleT, setCycleT] = useState(14)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [freshResult, setFreshResult] = useState<ForwardResult|null>(null)
  const [agedResult,  setAgedResult]  = useState<ForwardResult|null>(null)
  const [weights, setWeights] = useState<Record<string,WeightMatrix>|null>(null)
  const [loading, setLoading] = useState(false)
  const [hoveredLayer, setHoveredLayer] = useState<string|null>(null)
  const [selectedLayer, setSelectedLayer] = useState('mamba0_out')
  const tickRef = useRef<ReturnType<typeof setInterval>>()

  // New feature states
  const [fullResult, setFullResult] = useState<any>(null)
  const [freshFullResult, setFreshFullResult] = useState<any>(null)
  const [saliencyResult, setSaliencyResult] = useState<any>(null)
  const [saliencyLoading, setSaliencyLoading] = useState(false)
  const [saliencySOH, setSaliencySOH] = useState(85)
  const [tsneResult, setTsneResult] = useState<any>(null)
  const [tsneLoading, setTsneLoading] = useState(false)
  const [chemCompareResult, setChemCompareResult] = useState<any>(null)
  const [chemCompareLoading, setChemCompareLoading] = useState(false)

  const runForward = useCallback(async (soh: number, label: 'fresh'|'aged') => {
    try {
      const body = JSON.stringify({ model_id: modelId, chemistry, soh_pct: soh })
      const res = await fetch('/api/activations/forward', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      })
      if (res.ok) { const d = await res.json(); label === 'fresh' ? setFreshResult(d) : setAgedResult(d) }

      // Also fetch full result (SSM states, histograms, dead channels)
      const resFull = await fetch('/api/activations/forward-full', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      })
      if (resFull.ok) { const d = await resFull.json(); setFullResult(d); if (label==='fresh') setFreshFullResult(d) }
    } catch { /* ignore */ }
  }, [modelId, chemistry])

  const loadWeights = useCallback(async () => {
    const res = await fetch(`/api/activations/weights/${modelId}`)
    if (res.ok) { const d = await res.json(); setWeights(d.matrices) }
  }, [modelId])

  const loadSaliency = useCallback(async () => {
    setSaliencyLoading(true)
    const res = await fetch('/api/activations/saliency', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: modelId, chemistry, soh_pct: saliencySOH }),
    })
    setSaliencyResult(await res.json())
    setSaliencyLoading(false)
  }, [modelId, chemistry, saliencySOH])

  const loadTsne = useCallback(async () => {
    setTsneLoading(true)
    const res = await fetch(`/api/activations/tsne?chemistry=${chemistry}&n_points=40`)
    setTsneResult(await res.json())
    setTsneLoading(false)
  }, [chemistry])

  const loadChemCompare = useCallback(async () => {
    setChemCompareLoading(true)
    const res = await fetch('/api/activations/chemistry-compare', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ soh_pct: 85, model_id: modelId }),
    })
    setChemCompareResult(await res.json())
    setChemCompareLoading(false)
  }, [modelId])

  useEffect(() => {
    setLoading(true)
    Promise.all([runForward(95,'fresh'), runForward(50,'aged')]).finally(() => setLoading(false))
  }, [modelId, chemistry])

  useEffect(() => {
    if (viewMode==='weights' && !weights) loadWeights()
  }, [viewMode, weights, loadWeights])

  useEffect(() => {
    if (viewMode === 'saliency' && !saliencyResult) loadSaliency()
    if (viewMode === 'tsne' && !tsneResult) loadTsne()
    if (viewMode === 'chem-compare' && !chemCompareResult) loadChemCompare()
    // ssm-3d: trajectory loads on demand via button inside SsmTrajectoryView
    if (viewMode === 'globe' && !freshResult) { /* already loaded */ }
    if (viewMode === 'chem-mini' && !chemCompareResult) loadChemCompare()
  }, [viewMode])

  // Auto-play scrubber
  useEffect(() => {
    if (playing) {
      tickRef.current = setInterval(() => setCycleT(t => t>=29?0:t+1), Math.round(300/speed))
    } else clearInterval(tickRef.current)
    return () => clearInterval(tickRef.current)
  }, [playing, speed])

  const VIEW_TABS: {id:ViewMode;label:string;icon:typeof Eye}[] = [
    { id:'2d',          label:'2D Live Canvas',       icon:Layers },
    { id:'3d',          label:'3D Network (drag)',     icon:Box },
    { id:'attention',   label:'Attention Heatmap',     icon:Eye },
    { id:'weights',     label:'Weight Matrices',       icon:Cpu },
    { id:'gradient',    label:'Activation Norms',      icon:BarChart2 },
    { id:'ssm',         label:'SSM States',            icon:Cpu },
    { id:'token-attn',  label:'Token Attn',            icon:Eye },
    { id:'input-heat',  label:'Input Map',             icon:Layers },
    { id:'saliency',    label:'Saliency',              icon:BarChart2 },
    { id:'histogram',   label:'Histograms',            icon:BarChart2 },
    { id:'dead',        label:'Dead Channels',         icon:Cpu },
    { id:'chem-compare',label:'Chem Compare',          icon:Layers },
    { id:'tsne',        label:'Activation t-SNE',      icon:Box },
    { id:'ssm-3d',      label:'SSM Trajectory 3D',     icon:Box },
    { id:'globe',       label:'Attention Globe',        icon:Box },
    { id:'chem-mini',   label:'4-Chem Racing',          icon:Layers },
  ]

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-blue to-brand-purple flex items-center justify-center">
              <motion.div className="w-3 h-3 rounded-full bg-white"
                animate={loading?{scale:[1,1.4,1]}:{scale:1}} transition={{duration:0.5,repeat:Infinity}} />
            </div>
            <h1 className="text-2xl font-bold text-text-primary">Neural Architecture Visualizer</h1>
          </div>
          <p className="text-sm text-text-secondary">Real PyTorch activations · Canvas RAF animations · Side-by-side Fresh vs Aged</p>
        </div>
        <div className="flex items-center gap-3">
          <select value={modelId} onChange={e=>setModelId(e.target.value)}
            className="bg-bg-panel border border-border-subtle rounded-lg px-3 py-1.5 text-sm text-text-primary outline-none focus:border-brand-blue">
            {['v10-final','v10-full','v9','v8'].map(m=><option key={m} value={m}>{m}</option>)}
          </select>
          <div className="flex gap-1">
            {['LCO','LFP','NMC','NCM'].map(c=>(
              <button key={c} onClick={()=>setChemistry(c)}
                className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all"
                style={chemistry===c?{backgroundColor:CHEM_COLORS[c],color:'#fff'}:{backgroundColor:'#111827',color:'#64748b',border:'1px solid #1e3a5f'}}>
                {c}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* View tabs — scrollable */}
      <div className="overflow-x-auto mb-4 border-b border-border-subtle">
        <div className="flex gap-1 min-w-max">
          {VIEW_TABS.map(t=>(
            <button key={t.id} onClick={()=>setViewMode(t.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-all border-b-2 -mb-px whitespace-nowrap ${
                viewMode===t.id?'border-brand-blue text-brand-blue':'border-transparent text-text-muted hover:text-text-primary'}`}>
              <t.icon size={13}/>{t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Cycle scrubber */}
      <div className="flex items-center gap-4 mb-4 panel p-3">
        <button onClick={()=>setPlaying(p=>!p)}
          className={`flex items-center gap-2 px-4 py-1.5 rounded-lg text-sm font-medium ${playing?'bg-brand-blue/10 text-brand-blue':'btn-primary'}`}>
          {playing?<Pause size={13}/>:<Play size={13}/>} {playing?'Pause':'Play'}
        </button>
        <div className="flex-1">
          <input type="range" min={0} max={29} step={1} value={cycleT}
            onChange={e=>{setPlaying(false);setCycleT(+e.target.value)}} className="w-full accent-brand-blue"/>
        </div>
        <span className="font-mono text-brand-blue w-20 text-center text-sm">t={cycleT+1}/30</span>
        <div className="flex items-center gap-1">
          <FastForward size={12} className="text-text-muted"/>
          {[1,2,4].map(s=>(
            <button key={s} onClick={()=>setSpeed(s)}
              className={`px-1.5 py-0.5 rounded text-xs font-mono ${speed===s?'bg-brand-blue text-white':'text-text-muted'}`}>
              {s}×
            </button>
          ))}
        </div>
        <button onClick={()=>{setLoading(true);Promise.all([runForward(95,'fresh'),runForward(50,'aged')]).finally(()=>setLoading(false))}}
          className="btn-ghost text-xs flex items-center gap-1"><RotateCcw size={12}/>Refresh</button>
      </div>

      {/* RUL summary */}
      {(freshResult||agedResult) && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          {[{r:freshResult,label:'Fresh Cell (SOH=95%)',color:'#10b981'},{r:agedResult,label:'Aged Cell (SOH=50%)',color:'#ef4444'}].map(({r,label,color})=>(
            <div key={label} className="panel p-3 flex items-center gap-4" style={{borderColor:color+'33'}}>
              <div>
                <div className="text-xs text-text-muted">{label}</div>
                <motion.div className="text-2xl font-mono font-bold" style={{color}}
                  animate={{opacity:[0.7,1,0.7]}} transition={{duration:2,repeat:Infinity}}>
                  {r?.rul_predicted?.toFixed(0)??'…'}
                </motion.div>
                <div className="text-xs text-text-muted">cycles predicted</div>
              </div>
              <div className="flex-1">
                {ANCHOR_LABELS.map((a,ai)=>(
                  <div key={a} className="flex items-center gap-2 mb-1">
                    <span className="text-xs text-text-muted w-14">{a}</span>
                    <motion.div className="flex-1 h-2 bg-bg-elevated rounded-full overflow-hidden">
                      <motion.div className="h-full rounded-full"
                        style={{backgroundColor:ANCHOR_COLORS[ai]}}
                        animate={{width:`${(r?.attention.anchor_importance[ai]??0)*100}%`}}
                        transition={{duration:0.5,ease:'easeOut'}} />
                    </motion.div>
                    <span className="font-mono text-xs" style={{color:ANCHOR_COLORS[ai]}}>
                      {((r?.attention.anchor_importance[ai]??0)*100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Main views */}
      <AnimatePresence mode="wait">
        <motion.div key={viewMode} initial={{opacity:0,y:6}} animate={{opacity:1,y:0}} exit={{opacity:0}}>

          {viewMode==='2d' && (
            <div className="space-y-4">
              <Canvas2D fresh={freshResult} aged={agedResult} cycleT={cycleT}
                hoveredLayer={hoveredLayer} setHoveredLayer={setHoveredLayer} />

              {/* Layer detail panel */}
              <div className="panel p-4">
                <div className="flex items-center gap-2 mb-3">
                  <h3 className="section-title">Layer Detail</h3>
                  <div className="flex gap-1 ml-auto flex-wrap">
                    {LAYER_KEYS.map((k,i)=>(
                      <button key={k} onClick={()=>setSelectedLayer(k)}
                        className="px-2 py-0.5 rounded text-xs transition-all"
                        style={selectedLayer===k?{backgroundColor:LAYER_COLORS[i]+'33',color:LAYER_COLORS[i]}:{color:'#475569'}}>
                        {LAYER_LABELS[i].split(' ')[0]}
                      </button>
                    ))}
                  </div>
                </div>
                <Plot
                  data={[
                    {type:'scatter',mode:'lines',name:'Fresh',x:Array.from({length:30},(_,i)=>i+1),y:freshResult?.layers[selectedLayer]?.norm_per_step??[],line:{color:'#10b981',width:2.5}},
                    {type:'scatter',mode:'lines',name:'Aged',x:Array.from({length:30},(_,i)=>i+1),y:agedResult?.layers[selectedLayer]?.norm_per_step??[],line:{color:'#ef4444',width:2,dash:'dash'}},
                    {type:'scatter',mode:'markers',name:`t=${cycleT+1}`,x:[cycleT+1],
                      y:[freshResult?.layers[selectedLayer]?.norm_per_step?.[cycleT]??0],
                      marker:{color:'#f59e0b',size:12,symbol:'diamond',line:{color:'#fff',width:2}}},
                  ]}
                  layout={{...darkLayout,height:170,margin:{t:10,b:40,l:50,r:20},
                    xaxis:{...darkLayout.xaxis as object,title:{text:'Cycle',font:{color:'#64748b'}}},
                    yaxis:{...darkLayout.yaxis as object,title:{text:'Norm',font:{color:'#64748b'}}},
                    transition:{duration:300},
                    shapes:[{type:'line',x0:cycleT+1,x1:cycleT+1,y0:0,y1:3,line:{color:'#f59e0b',dash:'dot',width:1.5}}],
                  } as Plotly.Layout}
                  config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}}
                />
              </div>
            </div>
          )}

          {viewMode==='3d' && (
            <div className="space-y-3">
              <div className="text-xs text-text-muted text-right">Drag to rotate · Auto-rotating · t={cycleT+1}/30</div>
              <Canvas3D fresh={freshResult} aged={agedResult} cycleT={cycleT} />
              <div className="panel p-3 text-xs text-text-secondary">
                Green = FRESH (95% SOH) · Red = AGED (50% SOH) · Sphere size+glow = activation magnitude · Connections = data flow
              </div>
            </div>
          )}

          {viewMode==='attention'    && <AttentionView fresh={freshResult} aged={agedResult} cycleT={cycleT} />}
          {viewMode==='weights'      && <WeightView weights={weights} loadWeights={loadWeights} />}
          {viewMode==='gradient'     && <ActivationView fresh={freshResult} aged={agedResult} cycleT={cycleT} />}
          {viewMode==='ssm'          && <SsmView fullResult={fullResult} cycleT={cycleT} />}
          {viewMode==='token-attn'   && <TokenAttentionView fresh={freshResult} aged={agedResult} cycleT={cycleT} />}
          {viewMode==='input-heat'   && <InputHeatmapView fresh={freshResult} cycleT={cycleT} saliencyResult={saliencyResult} />}
          {viewMode==='saliency'     && <SaliencyView result={saliencyResult} loading={saliencyLoading} onLoad={loadSaliency} sohPct={saliencySOH} onChangeSoh={(v)=>{ setSaliencySOH(v); setSaliencyResult(null) }} />}
          {viewMode==='histogram'    && <HistogramView fullResult={fullResult} cycleT={cycleT} />}
          {viewMode==='dead'         && <DeadChannelView fullResult={fullResult} freshFullResult={freshFullResult} />}
          {viewMode==='chem-compare' && <ChemCompareView result={chemCompareResult} loading={chemCompareLoading} onLoad={loadChemCompare} />}
          {viewMode==='tsne'         && <TsneView result={tsneResult} loading={tsneLoading} onLoad={loadTsne} />}
          {viewMode==='ssm-3d'    && <SsmTrajectoryView cycleT={cycleT} modelId={modelId} chemistry={chemistry} />}
          {viewMode==='globe'     && <GlobeView fresh={freshResult} cycleT={cycleT} />}
          {viewMode==='chem-mini' && <ChemMiniView result={chemCompareResult} loading={chemCompareLoading} onLoad={loadChemCompare} cycleT={cycleT} />}

        </motion.div>
      </AnimatePresence>
    </div>
  )
}

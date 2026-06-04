/**
 * TrainingPipeline.tsx
 * Full 8-stage animated training pipeline visualization.
 * Each stage is a self-contained SVG + Framer Motion component.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Play, Pause, SkipForward, SkipBack, RotateCcw, ChevronRight } from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────
interface StageProps { active: boolean; progress: number; epoch: number }

// ── Animation data (pre-computed realistic curves) ───────────────────────────
const CYCLES = [0,5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100,105,110,115,120,125,130,135,140,145,150,155,160,165,170,175,180,185,190,195,200,205,210,215,220,225,230,235,240,245,250,255,260,265,270,275,280,285,290,295,300,305,310,315,320,325,330]
const CAP_NOISY = [1.099,1.076,1.091,1.063,1.073,1.049,1.077,1.041,1.062,1.069,1.028,1.051,1.038,1.009,0.998,1.037,0.983,1.002,0.981,1.006,0.992,0.971,0.953,0.978,0.956,0.931,0.942,0.921,0.929,0.904,0.898,0.921,0.879,0.883,0.879,0.851,0.872,0.849,0.831,0.826,0.826,0.819,0.798,0.804,0.785,0.789,0.769,0.759,0.758,0.745,0.729,0.737,0.726,0.712,0.709,0.701,0.689,0.683,0.673,0.668,0.658,0.651,0.645,0.637,0.631,0.626,0.619]
const CAP_SMOOTH = [1.101,1.089,1.075,1.064,1.055,1.048,1.041,1.033,1.024,1.014,1.005,0.996,0.987,0.977,0.968,0.958,0.948,0.939,0.929,0.919,0.909,0.900,0.890,0.880,0.870,0.860,0.850,0.841,0.831,0.821,0.811,0.801,0.791,0.781,0.771,0.761,0.751,0.741,0.731,0.721,0.711,0.701,0.692,0.682,0.672,0.662,0.652,0.642,0.632,0.622,0.612,0.602,0.592,0.582,0.572,0.562,0.552,0.542,0.532,0.522,0.512,0.502,0.492,0.482,0.472,0.462,0.452]
const RUL_TRUE = [337,312,287,262,237,212,187,162,137,112,87,62,37,12,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0].map((_, i) => Math.max(0, 337 - CYCLES[i]))

function makeRulAtEpoch(noise: number): number[] {
  return RUL_TRUE.map((r, i) => Math.max(0, r + noise * (Math.sin(i * 0.4) * 0.6 + Math.random() * 0.4) * (337 - r * 0.5) / 337 * noise))
}
const RUL_EP = {
  1:  makeRulAtEpoch(160),
  5:  makeRulAtEpoch(90),
  15: makeRulAtEpoch(45),
  30: makeRulAtEpoch(20),
  50: makeRulAtEpoch(8),
  80: makeRulAtEpoch(3),
}

// ── Stage metadata ────────────────────────────────────────────────────────────
const STAGES = [
  { id: 0, label: 'Data Entry',      color: '#3b82f6', short: '01. Dataset',    dur: 6000 },
  { id: 1, label: 'Preprocessing',   color: '#06b6d4', short: '02. Preprocess', dur: 7000 },
  { id: 2, label: 'Train/Val/Test',  color: '#10b981', short: '03. Split',      dur: 5000 },
  { id: 3, label: 'Windowing',       color: '#f59e0b', short: '04. Windows',    dur: 6000 },
  { id: 4, label: 'Forward Pass',    color: '#8b5cf6', short: '05. Forward',    dur: 8000 },
  { id: 5, label: 'Loss Function',   color: '#ef4444', short: '06. Loss',       dur: 5000 },
  { id: 6, label: 'Backpropagation', color: '#ea580c', short: '07. Backprop',   dur: 6000 },
  { id: 7, label: 'Convergence',     color: '#10b981', short: '08. Converge',   dur: 8000 },
]

// ── SVG helpers ───────────────────────────────────────────────────────────────
function toSVGPoints(xs: number[], ys: number[], W: number, H: number, pad = 20): string {
  const xmin = Math.min(...xs), xmax = Math.max(...xs)
  const ymin = Math.min(...ys), ymax = Math.max(...ys)
  return xs.map((x, i) => {
    const sx = pad + ((x - xmin) / (xmax - xmin || 1)) * (W - 2 * pad)
    const sy = H - pad - ((ys[i] - ymin) / (ymax - ymin || 1)) * (H - 2 * pad)
    return `${sx.toFixed(1)},${sy.toFixed(1)}`
  }).join(' ')
}

function SVGAxes({ W, H, pad = 20 }: { W: number; H: number; pad?: number }) {
  return (
    <>
      <line x1={pad} y1={pad} x2={pad} y2={H - pad} stroke="#1e3a5f" strokeWidth="1" />
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="#1e3a5f" strokeWidth="1" />
    </>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 1: DATA ENTRY
// ═══════════════════════════════════════════════════════════════════════════
const CELLS_DATA = [
  { id: 'CS2_35', chem: 'LCO', color: '#3b82f6', cycles: 309, split: 'train' },
  { id: 'CS2_37', chem: 'LCO', color: '#3b82f6', cycles: 337, split: 'test' },
  { id: 'MIT_016', chem: 'LFP', color: '#10b981', cycles: 474, split: 'test' },
  { id: 'KJTU_1', chem: 'NMC', color: '#f59e0b', cycles: 452, split: 'test' },
  { id: 'TJU_1',  chem: 'NCM', color: '#8b5cf6', cycles: 508, split: 'test' },
  { id: 'OxCell7','chem': 'NMC', color: '#06b6d4', cycles: 8000, split: 'test' },
]

function Stage1_DataEntry({ active, progress }: StageProps) {
  return (
    <div className="space-y-5">
      <div className="text-sm text-text-secondary leading-relaxed">
        <span className="font-semibold text-text-primary">6 battery datasets</span>, 5 chemistries, 323 cells total.
        Each cell contains per-cycle measurements: Voltage (V), Current (A), Temperature (°C), Capacity (Ah), Energy (Wh), Internal Resistance (Ω).
      </div>

      <div className="bg-bg-primary rounded-xl border border-border-subtle overflow-hidden" style={{ height: 220 }}>
        <svg width="100%" height="220" viewBox="0 0 800 220">
          {/* Pipeline tube */}
          <rect x="580" y="80" width="190" height="60" rx="8" fill="#0e1829" stroke="#1e3a5f" strokeWidth="1.5" />
          <text x="675" y="108" textAnchor="middle" fill="#475569" fontSize="10" fontFamily="JetBrains Mono">DATA</text>
          <text x="675" y="122" textAnchor="middle" fill="#475569" fontSize="10" fontFamily="JetBrains Mono">PIPELINE</text>
          {/* Arrow into pipeline */}
          <path d="M570 110 L585 110" stroke="#3b82f6" strokeWidth="2" markerEnd="url(#arr)" strokeDasharray="4 2" />

          <defs>
            <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#3b82f6" />
            </marker>
          </defs>

          {CELLS_DATA.map((cell, i) => {
            const col = i % 3
            const row = Math.floor(i / 3)
            const x = 40 + col * 175
            const y = 30 + row * 110
            const delay = i * 0.15
            const arrived = progress > delay + 0.1

            return (
              <motion.g
                key={cell.id}
                initial={{ x: 0, opacity: 0 }}
                animate={active ? {
                  x: arrived ? 0 : 0,
                  opacity: progress > delay ? 1 : 0,
                } : { opacity: 0 }}
                transition={{ delay: delay * 2, duration: 0.5 }}
              >
                {/* Battery body */}
                <motion.rect
                  x={x} y={y} width={140} height={72} rx="8"
                  fill="#0e1829" stroke={cell.color}
                  strokeWidth={arrived ? 2 : 1}
                  animate={active && arrived ? { strokeOpacity: [0.6, 1, 0.6] } : {}}
                  transition={{ duration: 1.5, repeat: Infinity, delay: i * 0.3 }}
                />
                {/* Chemistry badge */}
                <rect x={x + 8} y={y + 8} width={36} height={16} rx="3" fill={cell.color + '33'} />
                <text x={x + 26} y={y + 20} textAnchor="middle" fill={cell.color} fontSize="9" fontWeight="600" fontFamily="JetBrains Mono">{cell.chem}</text>

                {/* Capacity bar */}
                <rect x={x + 8} y={y + 32} width={124} height={8} rx="3" fill="#1e2d45" />
                <motion.rect
                  x={x + 8} y={y + 32}
                  width={0} height={8} rx="3" fill={cell.color + '99'}
                  animate={active && arrived ? { width: Math.min(124, cell.cycles / 100 * 18) } : { width: 0 }}
                  transition={{ duration: 0.8, delay: delay * 2 + 0.3 }}
                />

                <text x={x + 8} y={y + 54} fill="#64748b" fontSize="9" fontFamily="JetBrains Mono">{cell.id}</text>
                <text x={x + 8} y={y + 66} fill="#475569" fontSize="9" fontFamily="JetBrains Mono">{cell.cycles.toLocaleString()} cycles</text>

                {/* Split badge */}
                <rect x={x + 96} y={y + 50} width={36} height={14} rx="3"
                  fill={cell.split === 'train' ? '#10b98122' : cell.split === 'test' ? '#3b82f622' : '#f59e0b22'} />
                <text x={x + 114} y={y + 60} textAnchor="middle" fontSize="8" fontFamily="Inter"
                  fill={cell.split === 'train' ? '#10b981' : cell.split === 'test' ? '#3b82f6' : '#f59e0b'}>
                  {cell.split}
                </text>
              </motion.g>
            )
          })}
        </svg>
      </div>

      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total Cells', value: '323', color: '#3b82f6' },
          { label: 'Chemistries', value: '5', color: '#10b981' },
          { label: 'Total Cycles', value: '167K', color: '#f59e0b' },
          { label: 'Raw Features', value: '9', color: '#8b5cf6' },
        ].map(s => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 8 }} animate={active ? { opacity: 1, y: 0 } : { opacity: 0 }}
            transition={{ delay: 0.8 }}
            className="bg-bg-elevated rounded-lg p-3 border border-border-subtle text-center">
            <div className="text-xl font-mono font-bold" style={{ color: s.color }}>{s.value}</div>
            <div className="text-xs text-text-muted mt-0.5">{s.label}</div>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 2: PREPROCESSING
// ═══════════════════════════════════════════════════════════════════════════
function Stage2_Preprocessing({ active, progress }: StageProps) {
  const W = 380, H = 120, pad = 16
  const noisePts = toSVGPoints(CYCLES.slice(0, 40), CAP_NOISY.slice(0, 40), W, H, pad)
  const smoothPts = toSVGPoints(CYCLES.slice(0, 40), CAP_SMOOTH.slice(0, 40), W, H, pad)
  const revealN = Math.floor(progress * W)

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        <strong className="text-text-primary">Three preprocessing steps</strong> applied in sequence before feature extraction.
      </div>

      {/* Step 1: SG Smoothing */}
      <div className="panel p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="w-5 h-5 rounded-full bg-brand-blue flex items-center justify-center text-xs font-bold text-white">1</span>
          <span className="text-sm font-semibold text-text-primary">Savitzky-Golay Smoothing</span>
          <code className="text-xs font-mono text-brand-cyan ml-auto">window=11, order=3</code>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {['Raw (noisy)', 'SG Smoothed'].map((label, si) => (
            <div key={label}>
              <div className="text-xs text-text-muted mb-1.5 flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: si === 0 ? '#ef444488' : '#10b981' }} />
                {label}
              </div>
              <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ height: H }} className="rounded-lg bg-bg-primary border border-border-subtle">
                <SVGAxes W={W} H={H} pad={pad} />
                <clipPath id={`clip-s2-${si}`}>
                  <rect x={0} y={0} width={active ? revealN : 0} height={H} />
                </clipPath>
                <polyline
                  points={si === 0 ? noisePts : smoothPts}
                  fill="none"
                  stroke={si === 0 ? '#ef444466' : '#10b981'}
                  strokeWidth={si === 0 ? 1 : 2}
                  clipPath={`url(#clip-s2-${si})`}
                  style={{ transition: 'none' }}
                />
                <text x={pad + 2} y={H - pad - 4} fontSize="9" fill="#475569" fontFamily="JetBrains Mono">Capacity (Ah)</text>
              </svg>
            </div>
          ))}
        </div>
      </div>

      {/* Steps 2+3 */}
      {[
        { n: 2, title: 'Kinetic Filter', code: 'threshold = 5%', desc: 'Removes artefactual capacity jumps where Q_i > Q_{i-1} × 1.05 (sensor noise / charge anomalies)', color: '#f59e0b' },
        { n: 3, title: 'Z-Score Normalization', code: 'μ, σ from train only', desc: 'x_norm = (x − μ_train) / σ_train — computed exclusively from training cells to prevent leakage', color: '#8b5cf6' },
      ].map(step => (
        <motion.div key={step.n}
          className="panel p-4"
          initial={{ opacity: 0, x: -10 }}
          animate={active && progress > 0.4 * step.n ? { opacity: 1, x: 0 } : { opacity: 0, x: -10 }}
          transition={{ duration: 0.4 }}>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold text-white" style={{ backgroundColor: step.color }}>{step.n}</span>
            <span className="text-sm font-semibold text-text-primary">{step.title}</span>
            <code className="text-xs font-mono ml-auto" style={{ color: step.color }}>{step.code}</code>
          </div>
          <p className="text-xs text-text-secondary">{step.desc}</p>
          {/* Mini visual indicator */}
          <div className="mt-2 flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <motion.div className="h-full rounded-full" style={{ backgroundColor: step.color }}
                initial={{ width: 0 }}
                animate={active && progress > 0.4 * step.n ? { width: '100%' } : { width: 0 }}
                transition={{ duration: 1, delay: 0.2 }} />
            </div>
            <span className="text-xs text-text-muted font-mono">✓ applied</span>
          </div>
        </motion.div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 3: TRAIN/VAL/TEST SPLIT
// ═══════════════════════════════════════════════════════════════════════════
const SPLIT_CELLS = [
  { id: 'CS2_35', s: 'train' }, { id: 'CX2_16', s: 'train' }, { id: 'CX2_33', s: 'train' },
  { id: 'CX2_36', s: 'train' }, { id: 'CX2_38', s: 'train' }, { id: 'Oxford 1-6', s: 'train' },
  { id: 'CS2_34', s: 'val' },   { id: 'CX2_37', s: 'val' },
  { id: 'CS2_37', s: 'test' },  { id: 'CS2_38', s: 'test' },
  { id: 'MIT ×5', s: 'test' },  { id: 'KJTU ×5', s: 'test' },
  { id: 'TJU ×3', s: 'test' },  { id: 'Oxford 7-8', s: 'test' },
]
const SPLIT_COLORS: Record<string, string> = { train: '#10b981', val: '#f59e0b', test: '#3b82f6' }

function Stage3_Split({ active, progress }: StageProps) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        <strong className="text-text-primary">Cell-disjoint split</strong> — each cell appears in exactly one partition. Test cells are <em>never seen</em> during training or model selection. Normalization stats computed from train only.
      </div>

      <div className="grid grid-cols-3 gap-4">
        {(['train','val','test'] as const).map((split, si) => {
          const cells = SPLIT_CELLS.filter(c => c.s === split)
          const threshold = 0.2 + si * 0.3
          return (
            <motion.div key={split}
              initial={{ opacity: 0, y: 20 }}
              animate={active && progress > threshold ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{ duration: 0.5 }}
              className="rounded-xl border p-4"
              style={{ borderColor: SPLIT_COLORS[split] + '44', backgroundColor: SPLIT_COLORS[split] + '08' }}>
              <div className="text-xs font-bold uppercase tracking-widest mb-3" style={{ color: SPLIT_COLORS[split] }}>
                {split === 'train' ? '🟢 Train' : split === 'val' ? '🟡 Val' : '🔵 Test'}
              </div>
              <div className="space-y-1.5">
                {cells.map((c, ci) => (
                  <motion.div key={c.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={active && progress > threshold + ci * 0.05 ? { opacity: 1, x: 0 } : { opacity: 0, x: -8 }}
                    transition={{ duration: 0.3 }}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-bg-elevated border border-border-subtle">
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: SPLIT_COLORS[split] }} />
                    <span className="text-xs font-mono text-text-secondary">{c.id}</span>
                  </motion.div>
                ))}
              </div>
              <div className="mt-3 text-xs font-mono" style={{ color: SPLIT_COLORS[split] }}>
                {split === 'train' ? '6 cells + Oxford 1-6' : split === 'val' ? '2 cells (early stop)' : '17 test cells'}
              </div>
              {split === 'test' && (
                <div className="mt-2 px-2 py-1 rounded bg-red-500/10 border border-red-500/20">
                  <span className="text-xs text-red-400 font-semibold">🔒 NEVER SEEN IN TRAINING</span>
                </div>
              )}
            </motion.div>
          )
        })}
      </div>

      <motion.div initial={{ opacity: 0 }} animate={active && progress > 0.8 ? { opacity: 1 } : { opacity: 0 }}
        className="panel p-4 border-emerald-500/20 bg-emerald-500/5">
        <p className="text-xs text-emerald-300">
          ✓ Seed = 42 (deterministic) · ✓ No cell appears in multiple splits · ✓ Norm stats from train only · ✓ Zero leakage confirmed
        </p>
      </motion.div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 4: WINDOWING & STRIDE
// ═══════════════════════════════════════════════════════════════════════════
function Stage4_Windowing({ active, progress }: StageProps) {
  const W = 700, H = 120, pad = 16
  const pts = toSVGPoints(CYCLES, CAP_SMOOTH, W, H, pad)
  const winW = 30
  const xScale = (W - 2 * pad) / (CYCLES.length - 1)
  const stride = progress < 0.5 ? 10 : 1
  const windowCount = progress < 0.5
    ? Math.floor((CYCLES.length - winW) / 10) + 1
    : CYCLES.length - winW + 1
  const winPos = Math.floor(progress * (CYCLES.length - winW)) * xScale + pad

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        A <strong className="text-text-primary">sliding window</strong> of L=30 cycles extracts training samples.
        The stride controls data density — the v8 breakthrough came from changing stride 10→1 for LCO cells.
      </div>

      <div className="panel p-4">
        <div className="flex items-center gap-4 mb-3">
          <span className="text-sm font-semibold text-text-primary">Capacity Fade — CS2_35 (training cell)</span>
          <div className="ml-auto flex items-center gap-3">
            <span className="text-xs font-mono text-text-muted">stride = <span style={{ color: stride === 1 ? '#10b981' : '#f59e0b' }} className="font-bold">{stride}</span></span>
            <span className="text-xs font-mono text-text-muted">windows = <span className="text-text-accent font-bold">{windowCount}</span></span>
          </div>
        </div>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ height: H }} className="rounded-lg bg-bg-primary border border-border-subtle">
          <SVGAxes W={W} H={H} pad={pad} />
          {/* Capacity curve */}
          <polyline points={pts} fill="none" stroke="#3b82f666" strokeWidth="2" />

          {/* Sliding window highlight */}
          {active && (
            <motion.g>
              <motion.rect
                x={winPos} y={pad} width={winW * xScale} height={H - 2 * pad}
                fill="#3b82f620" stroke="#3b82f6" strokeWidth="1.5" rx="2"
                animate={{ x: winPos }}
                transition={{ duration: 0.1 }}
              />
              {/* Window label */}
              <text x={winPos + winW * xScale / 2} y={pad - 3} textAnchor="middle" fontSize="9" fill="#60a5fa" fontFamily="JetBrains Mono">
                L=30
              </text>
            </motion.g>
          )}

          {/* Axis labels */}
          <text x={pad} y={H - 2} fontSize="9" fill="#475569" fontFamily="JetBrains Mono">Cycle →</text>
          <text x={pad} y={pad + 8} fontSize="9" fill="#475569" fontFamily="JetBrains Mono">Q (Ah) ↑</text>
        </svg>
      </div>

      {/* Stride comparison */}
      <div className="grid grid-cols-2 gap-4">
        {[
          { stride: 10, wins: 28, label: 'stride=10 (old)', color: '#f59e0b', note: 'Sparse — 28 windows per LCO cell' },
          { stride: 1,  wins: 280, label: 'stride=1 (v8 breakthrough)', color: '#10b981', note: '10× more data → v8 RMSE 84→24!' },
        ].map((s, si) => (
          <motion.div key={s.stride}
            initial={{ opacity: 0, scale: 0.95 }}
            animate={active && progress > 0.3 + si * 0.3 ? { opacity: 1, scale: 1 } : { opacity: 0.3, scale: 0.95 }}
            className="rounded-xl border p-4"
            style={{ borderColor: s.color + '44', backgroundColor: s.color + '08' }}>
            <div className="flex items-center gap-2 mb-2">
              <code className="text-xs font-mono font-bold" style={{ color: s.color }}>{s.label}</code>
            </div>
            {/* Mini window visualization */}
            <svg width="100%" viewBox="0 0 200 30" style={{ height: 30 }} className="mb-2">
              {Array.from({ length: s.stride === 10 ? 5 : 14 }).map((_, i) => (
                <rect key={i} x={i * (s.stride === 10 ? 36 : 13) + 2} y={4} width={10} height={22}
                  fill={s.color + '40'} stroke={s.color} strokeWidth="0.8" rx="1" />
              ))}
            </svg>
            <div className="text-xs font-mono font-bold" style={{ color: s.color }}>≈ {s.wins} windows/cell</div>
            <div className="text-xs text-text-muted mt-0.5">{s.note}</div>
          </motion.div>
        ))}
      </div>

      <motion.div initial={{ opacity: 0 }} animate={active && progress > 0.7 ? { opacity: 1 } : { opacity: 0 }}
        className="panel p-3 text-center">
        <span className="text-xs font-mono text-text-secondary">Input tensor shape: </span>
        <code className="text-sm font-mono text-brand-blue font-bold">(B, 30, 13)</code>
        <span className="text-xs text-text-muted ml-2">— batch × window × features</span>
      </motion.div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 5: FORWARD PASS
// ═══════════════════════════════════════════════════════════════════════════
const LAYERS_FWD = [
  { id: 'inp',  label: 'Input\n(B,30,13)', type: 'input',     color: '#475569', x: 20  },
  { id: 'emb',  label: 'Embed\n13→256',   type: 'linear',    color: '#06b6d4', x: 120 },
  { id: 'pos',  label: 'Pos.Enc\n(30,256)',type: 'pos',       color: '#78716c', x: 220 },
  { id: 'mb1',  label: 'Mamba\n×1',       type: 'mamba',     color: '#3b82f6', x: 320 },
  { id: 'mb2',  label: 'Mamba\n×2',       type: 'mamba',     color: '#3b82f6', x: 420 },
  { id: 'mb3',  label: 'Mamba\n×3',       type: 'mamba',     color: '#3b82f6', x: 500 },
  { id: 'mb4',  label: 'Mamba\n×4',       type: 'mamba',     color: '#3b82f6', x: 580 },
  { id: 'attn', label: 'Anchor\nAttn',    type: 'attention', color: '#8b5cf6', x: 680 },
  { id: 'mlp',  label: 'MLP\n256→1',      type: 'mlp',       color: '#06b6d4', x: 780 },
  { id: 'out',  label: 'RUL\nscalar',     type: 'output',    color: '#10b981', x: 880 },
]

function Stage5_ForwardPass({ active, progress }: StageProps) {
  const activeLayerIdx = Math.floor(progress * LAYERS_FWD.length)
  const mambaActive = Math.max(0, activeLayerIdx - 3)

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        Input window <strong className="text-text-primary">(B, 30, 13)</strong> propagates left-to-right through each layer. Watch each layer activate and pass its output forward. Inside each Mamba block, 16 hidden state dimensions update at each of 30 time steps.
      </div>

      {/* Layer pipeline */}
      <div className="bg-bg-primary rounded-xl border border-border-subtle overflow-x-auto" style={{ height: 120 }}>
        <svg width="980" height="120" viewBox="0 0 980 120">
          <defs>
            <marker id="farr" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L7,3 z" fill="#1e3a5f" />
            </marker>
            <marker id="farrActive" markerWidth="7" markerHeight="7" refX="5" refY="3" orient="auto">
              <path d="M0,0 L0,6 L7,3 z" fill="#3b82f6" />
            </marker>
          </defs>

          {LAYERS_FWD.map((layer, i) => {
            const isActive = i === activeLayerIdx
            const isPassed = i < activeLayerIdx
            const W = 80, H = 52
            const x = layer.x, y = 34

            return (
              <g key={layer.id}>
                {/* Arrow to next */}
                {i < LAYERS_FWD.length - 1 && (
                  <motion.line
                    x1={x + W} y1={y + H / 2} x2={LAYERS_FWD[i + 1].x} y2={y + H / 2}
                    stroke={isPassed ? '#3b82f6' : '#1e3a5f'}
                    strokeWidth={isPassed ? 2 : 1}
                    strokeDasharray={isPassed ? '0' : '4 2'}
                    markerEnd={isPassed ? 'url(#farrActive)' : 'url(#farr)'}
                    animate={active ? { stroke: isPassed ? '#3b82f6' : '#1e3a5f' } : {}}
                    transition={{ duration: 0.3 }}
                  />
                )}

                {/* Node */}
                <motion.rect
                  x={x} y={y} width={W} height={H} rx="6"
                  fill="#0e1829"
                  stroke={isActive ? layer.color : isPassed ? layer.color + '88' : '#1e3a5f'}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  animate={active && isActive ? {
                    filter: [`drop-shadow(0 0 0px ${layer.color}00)`, `drop-shadow(0 0 8px ${layer.color}cc)`, `drop-shadow(0 0 0px ${layer.color}00)`],
                  } : {}}
                  transition={{ duration: 0.6, repeat: isActive ? Infinity : 0 }}
                />

                {/* Label */}
                {layer.label.split('\n').map((line, li) => (
                  <text key={li} x={x + W / 2} y={y + H / 2 + (li - 0.5) * 11}
                    textAnchor="middle" fontSize="8.5" fontFamily="JetBrains Mono"
                    fill={isActive ? layer.color : isPassed ? layer.color + 'cc' : '#475569'}>
                    {line}
                  </text>
                ))}
              </g>
            )
          })}
        </svg>
      </div>

      {/* MambaBlock internals — state update */}
      {activeLayerIdx >= 3 && activeLayerIdx <= 6 && (
        <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="panel p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="badge badge-blue text-xs">MambaBlock {mambaActive} internals</span>
            <code className="text-xs font-mono text-text-muted ml-auto">h_t = A̅·h_{'{'}{'{t-1}'}{'}'} + B̅·x_t</code>
          </div>
          <div className="mb-2">
            <div className="text-xs text-text-muted mb-1">d_state = 16 hidden state dimensions</div>
            <div className="flex gap-1">
              {Array.from({ length: 16 }, (_, i) => {
                const activation = Math.abs(Math.sin(i * 0.7 + progress * 8 + mambaActive * 1.3)) * 0.8 + 0.1
                return (
                  <motion.div key={i} className="flex-1 rounded-t-sm"
                    animate={{ height: `${activation * 40 + 4}px`, opacity: activation * 0.7 + 0.3 }}
                    transition={{ duration: 0.15 }}
                    style={{ backgroundColor: `rgba(59,130,246,${activation.toFixed(2)})`, alignSelf: 'flex-end', minWidth: 0 }}
                  />
                )
              })}
            </div>
            <div className="flex justify-between text-xs text-text-muted mt-1 font-mono">
              <span>s₁</span><span>s₄</span><span>s₈</span><span>s₁₂</span><span>s₁₆</span>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="bg-bg-elevated rounded p-2">
              <div className="text-text-muted">Selective Δ (dt)</div>
              <div className="font-mono text-brand-blue">{(0.1 + progress * 0.2).toFixed(3)}</div>
            </div>
            <div className="bg-bg-elevated rounded p-2">
              <div className="text-text-muted">Gate (SiLU)</div>
              <div className="font-mono text-cyan-400">{(0.4 + Math.sin(progress * 5) * 0.3).toFixed(3)}</div>
            </div>
            <div className="bg-bg-elevated rounded p-2">
              <div className="text-text-muted">D skip</div>
              <div className="font-mono text-purple-400">{(0.95 + Math.sin(progress * 3) * 0.03).toFixed(3)}</div>
            </div>
          </div>
        </motion.div>
      )}

      {/* Anchor attention when active */}
      {activeLayerIdx >= 7 && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="panel p-4">
          <div className="text-xs font-semibold text-purple-400 mb-2">Degradation Anchor Cross-Attention</div>
          <div className="grid grid-cols-3 gap-2">
            {['Fresh Cell\n(anchor 1)', 'Knee Point\n(anchor 2)', 'Near-EOL\n(anchor 3)'].map((a, ai) => {
              const w = [0.72, 0.18, 0.10][ai]
              return (
                <div key={a} className="bg-bg-elevated rounded-lg p-2.5 border border-purple-500/20">
                  <div className="text-xs text-text-muted mb-1.5 whitespace-pre-line">{a}</div>
                  <div className="h-1.5 bg-bg-primary rounded-full overflow-hidden">
                    <motion.div className="h-full rounded-full bg-purple-400"
                      animate={{ width: `${w * 100}%` }} transition={{ duration: 0.5 }} />
                  </div>
                  <div className="text-xs font-mono text-purple-300 mt-0.5">α={w.toFixed(2)}</div>
                </div>
              )
            })}
          </div>
        </motion.div>
      )}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 6: LOSS FUNCTION
// ═══════════════════════════════════════════════════════════════════════════
function Stage6_Loss({ progress }: StageProps) {
  const predicted = 180 - progress * 100 + Math.sin(progress * 20) * 15
  const trueRUL = 130
  const error = Math.abs(predicted - trueRUL)
  const huber = error < 1 ? 0.5 * error * error : error - 0.5
  const eolWeight = predicted < 50 ? 3.0 : 1.0

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        <strong className="text-text-primary">Huber loss</strong> balances MSE (smooth near zero) and MAE (robust to outliers). EOL weighting applies 3× penalty when cap_pct &lt; 0.3 to prioritize end-of-life accuracy.
      </div>

      {/* Live prediction vs true */}
      <div className="panel p-5">
        <div className="flex items-end gap-8 mb-4">
          <div className="text-center">
            <div className="text-xs text-text-muted mb-1">Predicted RUL</div>
            <motion.div className="text-4xl font-mono font-bold text-brand-blue"
              animate={{ opacity: [0.7, 1, 0.7] }} transition={{ duration: 1, repeat: Infinity }}>
              {Math.max(0, predicted).toFixed(1)}
            </motion.div>
          </div>
          <div className="flex-1 relative h-16">
            <svg width="100%" height="64" viewBox="0 0 300 64">
              {/* True RUL line */}
              <line x1="10" y1="48" x2="290" y2="48" stroke="#10b981" strokeWidth="2" strokeDasharray="6 3" />
              <text x="292" y="52" fontSize="9" fill="#10b981" fontFamily="JetBrains Mono">True={trueRUL}</text>
              {/* Predicted marker */}
              <motion.circle
                cx="150"
                animate={{ cy: 48 - (predicted - trueRUL) / 200 * 60 }}
                r="8" fill="#3b82f6"
                transition={{ duration: 0.3 }}
              />
              {/* Error bar */}
              <motion.line x1="150" y1="48"
                animate={{ y2: 48 - (predicted - trueRUL) / 200 * 60 }}
                x2="150" stroke="#ef4444" strokeWidth="2"
                strokeDasharray="3 2"
                transition={{ duration: 0.3 }}
              />
              <text x="156" y="20" fontSize="9" fill="#ef4444" fontFamily="JetBrains Mono">Δ={error.toFixed(1)}</text>
            </svg>
          </div>
          <div className="text-center">
            <div className="text-xs text-text-muted mb-1">True RUL</div>
            <div className="text-4xl font-mono font-bold text-emerald-400">{trueRUL}</div>
          </div>
        </div>

        {/* Loss breakdown */}
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: 'Raw Error |ŷ-y|', value: error.toFixed(2), color: '#ef4444' },
            { label: 'Huber Loss', value: huber.toFixed(4), color: '#f59e0b' },
            { label: 'EOL Weight', value: `${eolWeight.toFixed(1)}×`, color: eolWeight > 1 ? '#ef4444' : '#64748b' },
          ].map(m => (
            <div key={m.label} className="bg-bg-elevated rounded-lg p-3 text-center border border-border-subtle">
              <div className="text-xs text-text-muted">{m.label}</div>
              <div className="font-mono font-bold text-lg mt-1" style={{ color: m.color }}>{m.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Huber formula */}
      <div className="panel p-4">
        <div className="text-xs text-text-muted mb-2">Huber Loss Formula (δ=1.0)</div>
        <div className="font-mono text-sm text-brand-cyan bg-bg-primary rounded-lg px-3 py-2 border border-border-subtle">
          {'L(ŷ,y) = 0.5·(ŷ-y)² if |ŷ-y|≤δ  else  δ·|ŷ-y| - 0.5·δ²'}
        </div>
        <div className="mt-2 text-xs text-text-muted">
          EOL weighted: <code className="font-mono text-amber-400">L_w = L(ŷ,y) × (1 + 2·1[cap_pct &lt; 0.3])</code>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 7: BACKPROPAGATION
// ═══════════════════════════════════════════════════════════════════════════
const LAYERS_BWD = [...LAYERS_FWD].reverse()

function Stage7_Backprop({ active, progress }: StageProps) {
  const activeBack = Math.floor(progress * LAYERS_BWD.length)

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        Gradients flow <strong className="text-red-400">right-to-left</strong> via chain rule: ∂L/∂W = ∂L/∂ŷ · ∂ŷ/∂W.
        Each layer's weights shift proportionally to its gradient magnitude × learning rate.
      </div>

      {/* Reversed pipeline with red gradient arrows */}
      <div className="bg-bg-primary rounded-xl border border-border-subtle overflow-x-auto" style={{ height: 130 }}>
        <svg width="980" height="130" viewBox="0 0 980 130">
          <defs>
            <marker id="garr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L8,3 z" fill="#ef4444" />
            </marker>
          </defs>
          {/* "GRADIENT" label */}
          <text x="490" y="118" textAnchor="middle" fontSize="9" fill="#ef444466" fontFamily="JetBrains Mono">← GRADIENTS FLOWING BACKWARD</text>

          {LAYERS_FWD.map((layer, i) => {
            const ri = LAYERS_FWD.length - 1 - i
            const isActive = ri === activeBack
            const isPassed = ri < activeBack
            const W = 80, H = 52
            const x = layer.x, y = 20

            return (
              <g key={layer.id}>
                {i > 0 && (
                  <motion.line
                    x1={x + W} y1={y + H / 2} x2={LAYERS_FWD[i - 1]?.x ?? 0} y2={y + H / 2}
                    stroke={isPassed ? '#ef4444' : '#1e3a5f'}
                    strokeWidth={isPassed ? 2 : 1}
                    strokeDasharray={isPassed ? '0' : '4 2'}
                    markerEnd={isPassed ? 'url(#garr)' : undefined}
                    animate={active ? { stroke: isPassed ? '#ef4444' : '#1e3a5f' } : {}}
                    transition={{ duration: 0.3 }}
                  />
                )}

                <motion.rect x={x} y={y} width={W} height={H} rx="6"
                  fill="#0e1829"
                  stroke={isActive ? '#ef4444' : isPassed ? '#ef444488' : '#1e3a5f'}
                  strokeWidth={isActive ? 2.5 : 1.5}
                  animate={active && isActive ? { filter: [`drop-shadow(0 0 0px #ef444400)`, `drop-shadow(0 0 10px #ef4444cc)`, `drop-shadow(0 0 0px #ef444400)`] } : {}}
                  transition={{ duration: 0.5, repeat: isActive ? Infinity : 0 }}
                />

                {layer.label.split('\n').map((line, li) => (
                  <text key={li} x={x + W / 2} y={y + H / 2 + (li - 0.5) * 11}
                    textAnchor="middle" fontSize="8.5" fontFamily="JetBrains Mono"
                    fill={isActive ? '#f87171' : isPassed ? '#ef444499' : '#475569'}>
                    {line}
                  </text>
                ))}

                {/* Gradient value badge */}
                {isPassed && (
                  <text x={x + W / 2} y={y + H + 14} textAnchor="middle" fontSize="8" fill="#ef444466" fontFamily="JetBrains Mono">
                    ∂L/∂W
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>

      {/* Weight update visualization */}
      <div className="panel p-4">
        <div className="text-xs font-semibold text-red-400 mb-3">Weight Matrix Update — MLP Head layer</div>
        <div className="text-xs text-text-muted mb-2 font-mono">W ← W − lr × ∂L/∂W    (lr = 1e-4)</div>
        <div className="grid grid-cols-8 gap-1">
          {Array.from({ length: 32 }, (_, i) => {
            const grad = Math.sin(i * 0.8 + progress * 10) * 0.5
            const isUpdated = i < activeBack * 3
            return (
              <motion.div key={i} className="rounded h-6"
                animate={{
                  backgroundColor: isUpdated
                    ? grad > 0 ? `rgba(239,68,68,${Math.abs(grad).toFixed(2)})` : `rgba(59,130,246,${Math.abs(grad).toFixed(2)})`
                    : '#1e2d45'
                }}
                transition={{ duration: 0.2 }}
              />
            )
          })}
        </div>
        <div className="flex justify-between text-xs text-text-muted mt-1">
          <span className="text-red-400">negative grad (↑ weight)</span>
          <span className="text-blue-400">positive grad (↓ weight)</span>
        </div>
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// STAGE 8: CONVERGENCE
// ═══════════════════════════════════════════════════════════════════════════
function Stage8_Convergence({ active, progress }: StageProps) {
  const epochKey = [1,5,15,30,50,80][Math.min(5, Math.floor(progress * 6))] as keyof typeof RUL_EP
  const currentEpochN = Math.round(progress * 80)
  const rmse = Math.max(20, 89 - progress * 70 + Math.sin(progress * 15) * 3)
  const W = 680, H = 160, pad = 20
  const truePts = toSVGPoints(CYCLES.slice(0, 70), RUL_TRUE.slice(0, 70), W, H, pad)
  const predPts = toSVGPoints(CYCLES.slice(0, 70), (RUL_EP[epochKey] ?? RUL_EP[1]).slice(0, 70).map(v => Math.max(0, v)), W, H, pad)

  return (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        Watch the <strong className="text-text-primary">predicted RUL curve</strong> converge toward the true RUL epoch-by-epoch.
        RMSE drops from 88.8 → 20.6 across training. Drag the epoch slider to replay convergence.
      </div>

      {/* Epoch selector */}
      <div className="panel p-4 flex items-center gap-4">
        <div>
          <div className="text-xs text-text-muted">Training epoch</div>
          <div className="text-2xl font-mono font-bold text-brand-blue">{currentEpochN}</div>
        </div>
        <div className="flex-1">
          <div className="h-2 bg-bg-elevated rounded-full overflow-hidden">
            <motion.div className="h-full bg-gradient-to-r from-red-500 via-amber-500 to-emerald-500 rounded-full"
              animate={{ width: `${progress * 100}%` }} transition={{ duration: 0.1 }} />
          </div>
          <div className="flex justify-between text-xs text-text-muted mt-1 font-mono">
            <span>Ep 1 (RMSE=88)</span><span>Ep 8 (breakthrough)</span><span>Ep 80 (RMSE=21)</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-text-muted">RMSE</div>
          <motion.div className="text-2xl font-mono font-bold text-emerald-400"
            animate={{ color: rmse > 50 ? '#ef4444' : rmse > 30 ? '#f59e0b' : '#10b981' }}>
            {rmse.toFixed(1)}
          </motion.div>
        </div>
      </div>

      {/* RUL convergence chart */}
      <div className="panel p-5">
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-text-secondary inline-block" style={{ borderTop: '2px dashed #94a3b8' }} /><span className="text-xs text-text-secondary">True RUL</span></div>
          <div className="flex items-center gap-1.5"><span className="w-3 h-0.5 bg-red-400 inline-block" /><span className="text-xs text-text-secondary">Predicted (epoch {currentEpochN})</span></div>
        </div>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ height: H }} className="rounded-lg bg-bg-primary border border-border-subtle">
          <SVGAxes W={W} H={H} pad={pad} />
          {/* True RUL */}
          <polyline points={truePts} fill="none" stroke="#94a3b8" strokeWidth="2" strokeDasharray="6 3" />
          {/* Predicted RUL — color changes green as epoch increases */}
          <motion.polyline
            key={epochKey}
            points={predPts}
            fill="none"
            initial={{ stroke: '#ef4444', opacity: 0.5 }}
            animate={{
              stroke: progress < 0.3 ? '#ef4444' : progress < 0.6 ? '#f59e0b' : '#10b981',
              opacity: 1,
            }}
            strokeWidth="2"
            transition={{ duration: 0.5 }}
          />
          {/* Shaded error band */}
          <text x={pad + 4} y={pad + 12} fontSize="9" fill="#475569" fontFamily="JetBrains Mono">RUL ↑</text>
          <text x={W - pad - 40} y={H - 4} fontSize="9" fill="#475569" fontFamily="JetBrains Mono">Cycle →</text>
        </svg>
      </div>

      {/* Milestone badges */}
      <div className="grid grid-cols-4 gap-2">
        {[
          { ep: 1,  rmse: 88.8, label: 'v1 baseline',  color: '#ef4444' },
          { ep: 8,  rmse: 24.0, label: 'v8 breakthrough', color: '#f59e0b' },
          { ep: 27, rmse: 21.5, label: 'v10-full best', color: '#3b82f6' },
          { ep: 80, rmse: 20.6, label: 'v10-final',    color: '#10b981' },
        ].map(m => (
          <motion.div key={m.ep}
            initial={{ opacity: 0.3 }}
            animate={active && progress * 80 >= m.ep ? { opacity: 1 } : { opacity: 0.3 }}
            className="rounded-lg p-3 border text-center"
            style={{ borderColor: m.color + '44', backgroundColor: m.color + '08' }}>
            <div className="text-xs text-text-muted">Ep {m.ep}</div>
            <div className="font-mono font-bold text-sm" style={{ color: m.color }}>{m.rmse}</div>
            <div className="text-xs text-text-muted">{m.label}</div>
          </motion.div>
        ))}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════
const STAGE_COMPONENTS = [
  Stage1_DataEntry, Stage2_Preprocessing, Stage3_Split,
  Stage4_Windowing, Stage5_ForwardPass, Stage6_Loss,
  Stage7_Backprop, Stage8_Convergence,
]

export default function TrainingPipeline() {
  const [currentStage, setCurrentStage] = useState(0)
  const [progress, setProgress] = useState(0)
  const [epoch, setEpoch] = useState(0)
  const [playing, setPlaying] = useState(false)
  const rafRef = useRef<number>()
  const startTimeRef = useRef<number | null>(null)
  const stageStartRef = useRef<number>(0)

  const stageDur = STAGES[currentStage]?.dur ?? 6000

  const tick = useCallback((ts: number) => {
    if (!startTimeRef.current) startTimeRef.current = ts
    const elapsed = ts - startTimeRef.current - stageStartRef.current
    const p = Math.min(elapsed / stageDur, 1)
    setProgress(p)
    setEpoch(Math.floor(p * 80))

    if (p >= 1) {
      if (currentStage < STAGES.length - 1) {
        stageStartRef.current = elapsed
        startTimeRef.current = ts
        setCurrentStage(s => s + 1)
        setProgress(0)
      } else {
        setPlaying(false)
        return
      }
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [currentStage, stageDur])

  useEffect(() => {
    if (playing) {
      rafRef.current = requestAnimationFrame(tick)
    } else {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [playing, tick])

  const goTo = (idx: number) => {
    setPlaying(false); setCurrentStage(idx); setProgress(0)
    startTimeRef.current = null; stageStartRef.current = 0
  }
  const reset = () => { goTo(0); setEpoch(0) }
  const prev = () => goTo(Math.max(0, currentStage - 1))
  const next = () => goTo(Math.min(STAGES.length - 1, currentStage + 1))
  const toggle = () => {
    if (!playing) startTimeRef.current = null
    setPlaying(p => !p)
  }

  const StageComponent = STAGE_COMPONENTS[currentStage]
  const stageColor = STAGES[currentStage]?.color ?? '#3b82f6'

  return (
    <div className="px-8 py-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ backgroundColor: stageColor + '22' }}>
            <motion.div className="w-3 h-3 rounded-full" style={{ backgroundColor: stageColor }}
              animate={{ scale: playing ? [1, 1.3, 1] : 1 }} transition={{ duration: 0.8, repeat: Infinity }} />
          </div>
          <h1 className="text-2xl font-bold text-text-primary">Training Pipeline — Full Animation</h1>
        </div>
        <p className="text-text-secondary">8-stage end-to-end walkthrough: dataset → preprocessing → windowing → forward pass → loss → backprop → convergence</p>
      </div>

      {/* Stage progress bar */}
      <div className="flex gap-1 mb-5">
        {STAGES.map((s, i) => (
          <button key={s.id} onClick={() => goTo(i)}
            className="flex-1 group relative"
            title={s.label}>
            <div className="h-1.5 rounded-full overflow-hidden bg-bg-elevated">
              <motion.div className="h-full rounded-full"
                style={{ backgroundColor: s.color }}
                animate={{
                  width: i < currentStage ? '100%' : i === currentStage ? `${progress * 100}%` : '0%'
                }}
                transition={{ duration: 0.1 }}
              />
            </div>
            <div className={`text-xs mt-1 text-center font-medium transition-colors truncate ${i === currentStage ? 'text-text-primary' : 'text-text-muted'}`}
              style={{ fontSize: '9px' }}>
              {s.short}
            </div>
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3 mb-6 panel p-3">
        <button onClick={reset} className="btn-ghost p-2 flex-shrink-0"><RotateCcw size={15} /></button>
        <button onClick={prev} disabled={currentStage === 0} className="btn-ghost p-2 disabled:opacity-30"><SkipBack size={15} /></button>
        <button onClick={toggle}
          className="flex items-center gap-2 px-5 py-2 rounded-lg font-semibold text-sm transition-all"
          style={{ backgroundColor: playing ? stageColor + '22' : stageColor, color: playing ? stageColor : '#fff' }}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
          {playing ? 'Pause' : 'Play All'}
        </button>
        <button onClick={next} disabled={currentStage === STAGES.length - 1} className="btn-ghost p-2 disabled:opacity-30"><SkipForward size={15} /></button>

        {/* Stage name */}
        <div className="ml-2 flex items-center gap-2">
          <span className="text-sm font-mono" style={{ color: stageColor }}>
            Stage {currentStage + 1}/{STAGES.length}
          </span>
          <ChevronRight size={14} className="text-text-muted" />
          <span className="text-sm font-semibold text-text-primary">{STAGES[currentStage]?.label}</span>
        </div>

        {/* Progress within stage */}
        <div className="ml-auto flex items-center gap-2 text-xs text-text-muted font-mono">
          <div className="w-24 h-1 bg-bg-elevated rounded-full overflow-hidden">
            <motion.div className="h-full rounded-full" style={{ backgroundColor: stageColor }}
              animate={{ width: `${progress * 100}%` }} transition={{ duration: 0.1 }} />
          </div>
          {Math.round(progress * 100)}%
        </div>
      </div>

      {/* Stage dots nav */}
      <div className="flex justify-center gap-2 mb-6">
        {STAGES.map((s, i) => (
          <button key={s.id} onClick={() => goTo(i)}
            className="rounded-full transition-all duration-200"
            style={{
              width: i === currentStage ? 24 : 8,
              height: 8,
              backgroundColor: i === currentStage ? s.color : i < currentStage ? s.color + '66' : '#1e3a5f',
            }}
          />
        ))}
      </div>

      {/* Stage content */}
      <AnimatePresence mode="wait">
        <motion.div key={currentStage}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.25 }}
          className="panel p-6"
          style={{ borderColor: stageColor + '33', boxShadow: `0 0 30px ${stageColor}11` }}>
          {/* Stage header */}
          <div className="flex items-center gap-3 mb-5 pb-4 border-b border-border-subtle">
            <span className="font-mono text-xs px-2 py-1 rounded" style={{ backgroundColor: stageColor + '22', color: stageColor }}>
              {String(currentStage + 1).padStart(2, '0')}
            </span>
            <h2 className="text-lg font-bold" style={{ color: stageColor }}>
              {STAGES[currentStage]?.label}
            </h2>
          </div>

          <StageComponent active={true} progress={progress} epoch={epoch} />
        </motion.div>
      </AnimatePresence>

      {/* Stage navigator */}
      <div className="mt-5 grid grid-cols-4 gap-2">
        {STAGES.map((s, i) => (
          <button key={s.id} onClick={() => goTo(i)}
            className={`text-left p-3 rounded-lg border transition-all text-xs ${
              i === currentStage ? 'border-current' : 'border-border-subtle hover:border-border-active'
            }`}
            style={i === currentStage ? { borderColor: s.color + '66', backgroundColor: s.color + '08' } : {}}>
            <div className="font-mono mb-0.5" style={{ color: i === currentStage ? s.color : '#475569' }}>{s.short}</div>
            <div className="text-text-muted" style={{ fontSize: '10px' }}>{s.label}</div>
          </button>
        ))}
      </div>
    </div>
  )
}

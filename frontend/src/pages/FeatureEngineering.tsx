import { useState, useRef, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Layers, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp } from 'lucide-react'

const FEATURES = [
  { idx: 0, name: 'Capacity (Ah)', cat: 'raw', leaky: false, formula: 'Q_d = ∫ I · dt', desc: 'Discharge capacity per cycle — primary degradation indicator. Monotonically decreases as cells age.', imp: { LCO: 0.25, LFP: 0.18, NMC: 0.22, NCM: 0.20 } },
  { idx: 1, name: 'Charge Time (s)', cat: 'raw', leaky: false, formula: 't_total = t_CC + t_CV', desc: 'Total CC-CV charge duration. Increases as internal resistance grows and active material degrades.', imp: { LCO: 0.12, LFP: 0.09, NMC: 0.11, NCM: 0.10 } },
  { idx: 2, name: 'Voltage Mean (V)', cat: 'raw', leaky: false, formula: 'μ_V = (1/n) · Σᵢ Vᵢ', desc: 'Mean discharge voltage. Sensitive to IR drop. Less useful for LFP due to flat plateau (ΔOCV≈50mV).', imp: { LCO: 0.08, LFP: 0.04, NMC: 0.07, NCM: 0.06 } },
  { idx: 3, name: 'Voltage End (V)', cat: 'raw', leaky: false, formula: 'V_end = V(t = T)', desc: 'Terminal discharge voltage at cutoff (2.7V for LCO). Reflects internal resistance buildup.', imp: { LCO: 0.06, LFP: 0.03, NMC: 0.05, NCM: 0.05 } },
  { idx: 4, name: 'Energy (Wh)', cat: 'raw', leaky: false, formula: 'E = ∫ V(t) · I(t) dt', desc: 'Discharge energy per cycle. Combines voltage and capacity — rich degradation signal.', imp: { LCO: 0.15, LFP: 0.14, NMC: 0.13, NCM: 0.14 } },
  { idx: 5, name: 'Temperature (°C)', cat: 'raw', leaky: false, formula: 'T_cell (measured)', desc: 'Cell temperature during discharge. Elevated temperature accelerates degradation via SEI growth.', imp: { LCO: 0.05, LFP: 0.08, NMC: 0.06, NCM: 0.09 } },
  { idx: 6, name: 'Cap. Slope', cat: 'raw', leaky: false, formula: 'dQ/di ≈ (Q_i − Q_{i-5}) / 5', desc: 'Rolling 5-cycle capacity fade rate. Captures local degradation trend, filters noise.', imp: { LCO: 0.10, LFP: 0.12, NMC: 0.11, NCM: 0.11 } },
  { idx: 7, name: 'Int. Resistance (Ω)', cat: 'raw', leaky: false, formula: 'R = ΔV / ΔI (pulse test)', desc: 'Internal resistance. Increases with SEI layer growth and lithium plating.', imp: { LCO: 0.07, LFP: 0.10, NMC: 0.08, NCM: 0.09 } },
  { idx: 8, name: 'Chemistry Code', cat: 'raw', leaky: false, formula: 'c ∈ {0=LCO, 1=LFP, 2=NMC, 3=NCM}', desc: 'Integer chemistry label passed directly as a feature, enabling the model to learn chemistry-specific degradation patterns.', imp: { LCO: 0.02, LFP: 0.02, NMC: 0.02, NCM: 0.02 } },
  { idx: 9, name: 'cap_pct (SOH)', cat: 'derived', leaky: false, formula: 'SOH_i = Q_i / Q_0', desc: 'State-of-health proxy — capacity normalized by initial capacity. Single most informative feature. Direct degradation level indicator.', imp: { LCO: 0.32, LFP: 0.28, NMC: 0.30, NCM: 0.29 } },
  { idx: 10, name: 'Delta Cap', cat: 'derived', leaky: false, formula: 'ΔQ_i = Q_i − Q_{i−1}', desc: 'Cycle-to-cycle capacity change. Negative during degradation. Captures acceleration near knee point.', imp: { LCO: 0.08, LFP: 0.09, NMC: 0.08, NCM: 0.08 } },
  { idx: 11, name: 'Cum. Energy', cat: 'derived', leaky: true, formula: 'E_cum = Σ_{j=0}^{i} E_j', desc: 'LEAKY: Perfect negative correlation with RUL (r = −1.000). Excluded from all clean experiments. See Leakage Audit page.', imp: { LCO: 0.95, LFP: 0.93, NMC: 0.94, NCM: 0.94 } },
  { idx: 12, name: 'Delta IR', cat: 'derived', leaky: false, formula: 'ΔR_i = R_i − R_{i−1}', desc: 'Cycle-to-cycle resistance change. Positive and accelerating near end-of-life.', imp: { LCO: 0.05, LFP: 0.06, NMC: 0.05, NCM: 0.06 } },
]

const PIPELINE = [
  { label: 'Raw Signals', desc: 'V, I, T, Q per cycle', color: '#64748b' },
  { label: 'SG Smooth', desc: 'window=11 order=3', color: '#3b82f6' },
  { label: 'Kinetic Filter', desc: '5% jump threshold', color: '#06b6d4' },
  { label: 'Feature Extract', desc: '9 raw + 4 derived', color: '#10b981' },
  { label: 'Z-Score Norm', desc: 'train stats only', color: '#f59e0b' },
  { label: 'Windowing', desc: 'L=30, stride=1', color: '#8b5cf6' },
  { label: 'Model Input', desc: '(B, 30, 13)', color: '#ef4444' },
]

const CHEMS = ['LCO', 'LFP', 'NMC', 'NCM'] as const
const CHEM_COLORS: Record<string, string> = { LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6' }

function CapacityCurveAnimation() {
  const svgRef = useRef<SVGSVGElement>(null)
  const [offset, setOffset] = useState(0)
  const W = 560, H = 100, WIN = 80

  useEffect(() => {
    let frame: number
    let t = 0
    const animate = () => {
      t += 0.4
      setOffset((t % (W - WIN)))
      frame = requestAnimationFrame(animate)
    }
    frame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(frame)
  }, [])

  const pts = Array.from({ length: 80 }, (_, i) => {
    const x = (i / 79) * W
    const y = H - (H * 0.8 * (1 - Math.pow(i / 79, 1.4))) - H * 0.05
    return `${x},${y}`
  }).join(' ')

  return (
    <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H + 24}`} style={{ overflow: 'visible' }}>
      <polyline points={pts} fill="none" stroke="#3b82f6" strokeWidth="2" opacity="0.6" />
      <rect x={offset} y={0} width={WIN} height={H} fill="#3b82f6" opacity="0.08" rx="3" />
      <rect x={offset} y={0} width={2} height={H} fill="#3b82f6" opacity="0.6" />
      <rect x={offset + WIN} y={0} width={2} height={H} fill="#3b82f6" opacity="0.6" />
      <text x={offset + WIN / 2} y={H + 16} textAnchor="middle" fontSize="10" fill="#60a5fa">30 cycles</text>
      <text x="4" y="12" fontSize="10" fill="#64748b">Q (Ah)</text>
      <text x={W - 30} y={H + 16} fontSize="10" fill="#64748b">Cycle →</text>
    </svg>
  )
}

export default function FeatureEngineering() {
  const [expanded, setExpanded] = useState<number | null>(null)

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Layers size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Feature Engineering Engine</h1>
        </div>
        <p className="text-text-secondary">13-feature leakage-aware pipeline · Signal processing · Derived features · Per-cell normalization</p>
      </div>

      {/* Pipeline flow */}
      <div className="panel p-6 mb-6">
        <h2 className="section-title mb-5">Processing Pipeline</h2>
        <div className="flex items-center gap-1 flex-wrap">
          {PIPELINE.map((stage, i) => (
            <div key={stage.label} className="flex items-center gap-1">
              <div className="flex flex-col items-center gap-1 px-3">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-mono font-bold text-white"
                  style={{ backgroundColor: stage.color + '33', border: `1px solid ${stage.color}55`, color: stage.color }}
                >
                  {i + 1}
                </div>
                <div className="text-xs font-semibold text-text-primary whitespace-nowrap">{stage.label}</div>
                <div className="text-xs text-text-muted whitespace-nowrap">{stage.desc}</div>
              </div>
              {i < PIPELINE.length - 1 && (
                <svg width="20" height="20" viewBox="0 0 20 20"><path d="M5 10 L15 10 M11 6 L15 10 L11 14" stroke="#1e3a5f" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Sliding window */}
      <div className="panel p-6 mb-6">
        <h2 className="section-title mb-2">Sliding Window Extraction</h2>
        <p className="text-xs text-text-muted mb-4">Animated 30-cycle window moving over capacity degradation curve. Stride=1 for LCO (26× more windows vs stride=10).</p>
        <CapacityCurveAnimation />
        <div className="flex gap-4 mt-3">
          <div className="text-xs text-text-secondary"><span className="font-mono text-brand-blue">Window size</span>: 30 cycles</div>
          <div className="text-xs text-text-secondary"><span className="font-mono text-brand-blue">Stride</span>: 1 (LCO breakthrough: 36 → 916 windows)</div>
          <div className="text-xs text-text-secondary"><span className="font-mono text-brand-blue">Input shape</span>: (B, 30, 13)</div>
        </div>
      </div>

      {/* Feature catalog */}
      <div className="mb-6">
        <h2 className="section-title mb-5">Feature Catalog</h2>
        <div className="grid grid-cols-2 gap-3">
          {FEATURES.map(f => (
            <motion.div
              key={f.idx}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: f.idx * 0.03 }}
              className={`panel p-4 cursor-pointer transition-all duration-200 ${
                f.leaky ? 'border-red-500/40 bg-red-500/5' : 'hover:border-border-active'
              }`}
              onClick={() => setExpanded(expanded === f.idx ? null : f.idx)}
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs text-text-muted">#{f.idx}</span>
                  <span className="font-semibold text-sm text-text-primary">{f.name}</span>
                  <span className={`badge text-xs ${f.cat === 'raw' ? 'badge-blue' : 'badge-purple'}`}>{f.cat}</span>
                  {f.leaky && (
                    <span className="badge badge-red flex items-center gap-1">
                      <AlertTriangle size={10} /> LEAKY
                    </span>
                  )}
                  {!f.leaky && <CheckCircle2 size={12} className="text-emerald-400" />}
                </div>
                {expanded === f.idx ? <ChevronUp size={14} className="text-text-muted flex-shrink-0" /> : <ChevronDown size={14} className="text-text-muted flex-shrink-0" />}
              </div>

              {/* Formula */}
              <code className="text-xs text-text-accent font-mono bg-bg-elevated px-2 py-1 rounded block mb-2 truncate">{f.formula}</code>

              {/* Importance bars */}
              <div className="grid grid-cols-4 gap-1.5">
                {CHEMS.map(c => (
                  <div key={c}>
                    <div className="text-xs text-text-muted mb-0.5">{c}</div>
                    <div className="h-1.5 bg-bg-elevated rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${f.imp[c] * 100}%`, backgroundColor: CHEM_COLORS[c] }}
                      />
                    </div>
                    <div className="text-xs font-mono text-text-muted">{(f.imp[c] * 100).toFixed(0)}%</div>
                  </div>
                ))}
              </div>

              {/* Expanded description */}
              {expanded === f.idx && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  className="mt-3 pt-3 border-t border-border-subtle"
                >
                  <p className="text-xs text-text-secondary leading-relaxed">{f.desc}</p>
                </motion.div>
              )}
            </motion.div>
          ))}
        </div>
      </div>

      {/* Normalization */}
      <div className="panel p-6">
        <h2 className="section-title mb-3">Per-Cell Normalization</h2>
        <p className="text-xs text-text-secondary mb-4">
          Z-score normalization statistics computed exclusively from training cells to prevent leakage.
          Each feature: <code className="font-mono text-brand-blue">x_norm = (x − μ_train) / σ_train</code>
        </p>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-bg-elevated rounded-lg p-4 border border-border-subtle">
            <div className="text-xs text-text-muted mb-2 uppercase tracking-wider">Before Norm</div>
            <div className="font-mono text-xs space-y-1 text-text-secondary">
              <div>Capacity: 0.82–1.12 Ah</div>
              <div>Energy: 2.1–3.0 Wh</div>
              <div>IR: 0.02–0.08 Ω</div>
            </div>
          </div>
          <div className="flex items-center justify-center">
            <svg width="40" height="20"><path d="M5 10 L35 10 M26 5 L35 10 L26 15" stroke="#3b82f6" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>
          </div>
          <div className="bg-bg-elevated rounded-lg p-4 border border-border-subtle">
            <div className="text-xs text-text-muted mb-2 uppercase tracking-wider">After Norm</div>
            <div className="font-mono text-xs space-y-1 text-text-secondary">
              <div>Capacity: −2.1 to +1.8</div>
              <div>Energy: −1.9 to +2.1</div>
              <div>IR: −1.5 to +3.2</div>
            </div>
          </div>
        </div>
        <div className="mt-3 text-xs text-text-muted flex items-center gap-2">
          <CheckCircle2 size={12} className="text-emerald-400 flex-shrink-0" />
          <span>σ clamped to minimum 1e-8 to prevent division by zero for constant features</span>
        </div>
      </div>
    </div>
  )
}

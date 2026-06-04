import { useState } from 'react'
import { motion } from 'framer-motion'
import { Cpu, ChevronRight } from 'lucide-react'

type LayerType = 'input'|'output'|'mamba'|'attention'|'conv'|'lstm'|'gru'|'linear'|'mlp'|'positional'|'pooling'|'film'|'embedding'|'projection'

interface Layer { id: string; type: LayerType; label: string; x: number; y: number }
interface Model { id: string; name: string; family: string; params: number; best_rmse: number; best_r2: number; description: string; layers: Layer[]; connections: [string,string][] }

const LAYER_COLORS: Record<LayerType, { fill: string; stroke: string; text: string }> = {
  input:      { fill: '#1e293b', stroke: '#475569', text: '#94a3b8' },
  output:     { fill: '#1e293b', stroke: '#475569', text: '#94a3b8' },
  mamba:      { fill: '#1e3a5f', stroke: '#3b82f6', text: '#60a5fa' },
  attention:  { fill: '#2d1b69', stroke: '#8b5cf6', text: '#a78bfa' },
  conv:       { fill: '#451a03', stroke: '#f59e0b', text: '#fbbf24' },
  lstm:       { fill: '#052e16', stroke: '#10b981', text: '#34d399' },
  gru:        { fill: '#052e16', stroke: '#10b981', text: '#34d399' },
  linear:     { fill: '#0e2a3f', stroke: '#06b6d4', text: '#22d3ee' },
  mlp:        { fill: '#0e2a3f', stroke: '#06b6d4', text: '#22d3ee' },
  positional: { fill: '#1c1917', stroke: '#78716c', text: '#a8a29e' },
  pooling:    { fill: '#2e1065', stroke: '#6366f1', text: '#818cf8' },
  film:       { fill: '#431407', stroke: '#ea580c', text: '#fb923c' },
  embedding:  { fill: '#0f172a', stroke: '#0d9488', text: '#2dd4bf' },
  projection: { fill: '#1e0a2e', stroke: '#c026d3', text: '#e879f9' },
}

const LW = 90; const LH = 52; const XGAP = 108; const YGAP = 80

function ArchDiagram({ layers, connections }: { layers: Layer[]; connections: [string,string][] }) {
  const layerMap = new Map(layers.map(l => [l.id, l]))
  const maxX = Math.max(...layers.map(l => l.x))
  const maxY = Math.max(...layers.map(l => l.y))
  const svgW = (maxX + 1) * XGAP + 20
  const svgH = (maxY + 1) * YGAP + LH + 20

  const nodeX = (l: Layer) => l.x * XGAP + 10
  const nodeY = (l: Layer) => l.y * YGAP + 10

  const pathD = (from: Layer, to: Layer) => {
    const x1 = nodeX(from) + LW; const y1 = nodeY(from) + LH / 2
    const x2 = nodeX(to); const y2 = nodeY(to) + LH / 2
    const cx = (x1 + x2) / 2
    return `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`
  }

  return (
    <div className="overflow-x-auto rounded-lg bg-bg-primary border border-border-subtle p-3">
      <svg width={svgW} height={svgH} style={{ minWidth: svgW }}>
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#1e3a5f" />
          </marker>
        </defs>

        {/* Connections */}
        {connections.map(([fid, tid]) => {
          const from = layerMap.get(fid); const to = layerMap.get(tid)
          if (!from || !to) return null
          return (
            <path
              key={`${fid}-${tid}`}
              d={pathD(from, to)}
              fill="none" stroke="#1e3a5f" strokeWidth="1.5"
              strokeDasharray="5 3" markerEnd="url(#arrowhead)"
              style={{ animation: 'dataFlow 2s linear infinite' }}
            />
          )
        })}

        {/* Nodes */}
        {layers.map(l => {
          const c = LAYER_COLORS[l.type] ?? LAYER_COLORS.linear
          const x = nodeX(l); const y = nodeY(l)
          const lines = l.label.split('\n')
          return (
            <g key={l.id}>
              <rect x={x} y={y} width={LW} height={LH} rx="6"
                fill={c.fill} stroke={c.stroke} strokeWidth="1.5" />
              {lines.map((line, i) => (
                <text key={i} x={x + LW / 2} y={y + LH / 2 + (i - (lines.length - 1) / 2) * 11}
                  textAnchor="middle" fill={c.text} fontSize="8.5" fontFamily="JetBrains Mono, monospace">
                  {line}
                </text>
              ))}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

const MODELS: Model[] = [
  {
    id: 'mambarul', name: 'MambaRUL v10-final', family: 'Mamba SSM', params: 2.8, best_rmse: 20.6, best_r2: 0.910,
    description: 'Primary model. 4× Mamba SSM blocks with selective state space + 3-anchor degradation cross-attention. Chemistry input projection for LFP IC features.',
    layers: [
      { id: 'in', type: 'input', label: 'Input\n(B,30,13)', x: 0, y: 0 },
      { id: 'cp', type: 'projection', label: 'Chem Proj\n18→13 (LFP)', x: 1, y: 0 },
      { id: 'em', type: 'linear', label: 'Embedding\n13→256', x: 2, y: 0 },
      { id: 'pe', type: 'positional', label: 'Pos.Enc\n(30,256)', x: 3, y: 0 },
      { id: 'm1', type: 'mamba', label: 'Mamba×1\nd=256 s=16', x: 4, y: 0 },
      { id: 'm2', type: 'mamba', label: 'Mamba×2\nd=256 s=16', x: 5, y: 0 },
      { id: 'm3', type: 'mamba', label: 'Mamba×3\nd=256 s=16', x: 6, y: 0 },
      { id: 'm4', type: 'mamba', label: 'Mamba×4\nd=256 s=16', x: 7, y: 0 },
      { id: 'aa', type: 'attention', label: 'Anchor Attn\n3anch 4heads', x: 8, y: 0 },
      { id: 'mh', type: 'mlp', label: 'MLP Head\n256→64→1', x: 9, y: 0 },
      { id: 'out', type: 'output', label: 'RUL\n(scalar)', x: 10, y: 0 },
    ],
    connections: [['in','cp'],['cp','em'],['em','pe'],['pe','m1'],['m1','m2'],['m2','m3'],['m3','m4'],['m4','aa'],['aa','mh'],['mh','out']],
  },
  {
    id: 'tcn_mamba', name: 'TCN-Mamba', family: 'Hybrid CNN-SSM', params: 0.5, best_rmse: 106, best_r2: 0.35,
    description: 'Multi-scale TCN encoder with FiLM chemistry conditioning + 3× Mamba SSM + chemistry-specific regression heads.',
    layers: [
      { id: 'in', type: 'input', label: 'Input\n(B,30,30)', x: 0, y: 0 },
      { id: 'fp', type: 'projection', label: 'Feat.Proj\n60→64', x: 1, y: 0 },
      { id: 't1', type: 'conv', label: 'TCN-1\n64→64 d=1', x: 2, y: 0 },
      { id: 't2', type: 'conv', label: 'TCN-2\n64→128 d=2', x: 3, y: 0 },
      { id: 't3', type: 'conv', label: 'TCN-3\n128→128 d=4', x: 4, y: 0 },
      { id: 'ce', type: 'embedding', label: 'Chem Emb\n4→32→128', x: 2, y: 1 },
      { id: 'fi', type: 'film', label: 'FiLM\nγ·x + β', x: 5, y: 0 },
      { id: 'sm1', type: 'mamba', label: 'Mamba×1\nd=128', x: 6, y: 0 },
      { id: 'sm2', type: 'mamba', label: 'Mamba×2\nd=128', x: 7, y: 0 },
      { id: 'sm3', type: 'mamba', label: 'Mamba×3\nd=128', x: 8, y: 0 },
      { id: 'tap', type: 'pooling', label: 'Temp.Attn\nPooling', x: 9, y: 0 },
      { id: 'ch', type: 'mlp', label: 'Chem Head\n128→64→1', x: 10, y: 0 },
      { id: 'out', type: 'output', label: 'RUL\n(cycles)', x: 11, y: 0 },
    ],
    connections: [['in','fp'],['fp','t1'],['t1','t2'],['t2','t3'],['t3','fi'],['in','ce'],['ce','fi'],['fi','sm1'],['sm1','sm2'],['sm2','sm3'],['sm3','tap'],['tap','ch'],['ch','out']],
  },
  {
    id: 'transformer', name: 'Transformer', family: 'Attention', params: 0.4, best_rmse: 31.4, best_r2: 0.841,
    description: '2-layer transformer encoder with 4-head self-attention, FFN, mean pooling, and MLP prediction head.',
    layers: [
      { id: 'in', type: 'input', label: 'Input\n(B,30,13)', x: 0, y: 0 },
      { id: 'em', type: 'linear', label: 'Embedding\n13→128', x: 1, y: 0 },
      { id: 'pe', type: 'positional', label: 'Pos.Enc', x: 2, y: 0 },
      { id: 'a1', type: 'attention', label: 'Self-Attn\n4h d=128', x: 3, y: 0 },
      { id: 'f1', type: 'mlp', label: 'FFN\n128→256', x: 4, y: 0 },
      { id: 'a2', type: 'attention', label: 'Self-Attn\n4h d=128', x: 5, y: 0 },
      { id: 'f2', type: 'mlp', label: 'FFN\n128→256', x: 6, y: 0 },
      { id: 'po', type: 'pooling', label: 'Mean\nPool', x: 7, y: 0 },
      { id: 'mh', type: 'mlp', label: 'MLP Head\n128→64→1', x: 8, y: 0 },
      { id: 'out', type: 'output', label: 'RUL', x: 9, y: 0 },
    ],
    connections: [['in','em'],['em','pe'],['pe','a1'],['a1','f1'],['f1','a2'],['a2','f2'],['f2','po'],['po','mh'],['mh','out']],
  },
  {
    id: 'lstm', name: 'LSTM', family: 'RNN', params: 0.3, best_rmse: 38.7, best_r2: 0.793,
    description: '2-layer LSTM with forget/input/output gates. Processes sequence recurrently, uses final hidden state for prediction.',
    layers: [
      { id: 'in', type: 'input', label: 'Input\n(B,30,13)', x: 0, y: 0 },
      { id: 'l1', type: 'lstm', label: 'LSTM L1\nd=128', x: 1, y: 0 },
      { id: 'l2', type: 'lstm', label: 'LSTM L2\nd=128', x: 2, y: 0 },
      { id: 'lh', type: 'pooling', label: 'h_T\n(last)', x: 3, y: 0 },
      { id: 'mh', type: 'mlp', label: 'MLP Head\n128→64→1', x: 4, y: 0 },
      { id: 'out', type: 'output', label: 'RUL', x: 5, y: 0 },
    ],
    connections: [['in','l1'],['l1','l2'],['l2','lh'],['lh','mh'],['mh','out']],
  },
  {
    id: 'gru', name: 'GRU', family: 'RNN', params: 0.22, best_rmse: 35.2, best_r2: 0.817,
    description: '2-layer GRU with reset/update gates. Lighter than LSTM with comparable performance.',
    layers: [
      { id: 'in', type: 'input', label: 'Input\n(B,30,13)', x: 0, y: 0 },
      { id: 'g1', type: 'gru', label: 'GRU L1\nd=128', x: 1, y: 0 },
      { id: 'g2', type: 'gru', label: 'GRU L2\nd=128', x: 2, y: 0 },
      { id: 'lh', type: 'pooling', label: 'h_T', x: 3, y: 0 },
      { id: 'mh', type: 'mlp', label: 'MLP Head\n128→64→1', x: 4, y: 0 },
      { id: 'out', type: 'output', label: 'RUL', x: 5, y: 0 },
    ],
    connections: [['in','g1'],['g1','g2'],['g2','lh'],['lh','mh'],['mh','out']],
  },
  {
    id: 'bilstm', name: 'BiLSTM', family: 'RNN', params: 0.48, best_rmse: 33.9, best_r2: 0.826,
    description: 'Bidirectional LSTM — processes sequence forward and backward, concatenates hidden states.',
    layers: [
      { id: 'in', type: 'input', label: 'Input\n(B,30,13)', x: 0, y: 0 },
      { id: 'f1', type: 'lstm', label: 'LSTM→\n(fwd)', x: 1, y: 0 },
      { id: 'b1', type: 'lstm', label: '←LSTM\n(bwd)', x: 1, y: 1 },
      { id: 'cat', type: 'pooling', label: 'Concat\n256d', x: 2, y: 0 },
      { id: 'mh', type: 'mlp', label: 'MLP Head\n256→64→1', x: 3, y: 0 },
      { id: 'out', type: 'output', label: 'RUL', x: 4, y: 0 },
    ],
    connections: [['in','f1'],['in','b1'],['f1','cat'],['b1','cat'],['cat','mh'],['mh','out']],
  },
]

const FAMILY_COLORS: Record<string, string> = {
  'Mamba SSM': '#3b82f6', 'Hybrid CNN-SSM': '#f59e0b',
  'Attention': '#8b5cf6', 'RNN': '#10b981',
}

export default function ModelGallery() {
  const [selected, setSelected] = useState(MODELS[0])
  const [showSSM, setShowSSM] = useState(false)

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Cpu size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Model Gallery</h1>
        </div>
        <p className="text-text-secondary">Interactive architecture visualization — MambaRUL and all baseline models</p>
      </div>

      <div className="flex gap-6">
        {/* Model list */}
        <div className="w-56 flex-shrink-0 space-y-2">
          {MODELS.map(m => (
            <button
              key={m.id}
              onClick={() => setSelected(m)}
              className={`w-full text-left p-3 rounded-lg border transition-all duration-150 ${
                selected.id === m.id
                  ? 'border-border-active bg-brand-blue/10'
                  : 'border-border-subtle bg-bg-panel hover:border-border-active'
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="text-xs font-semibold text-text-primary leading-tight"
                  style={{ color: selected.id === m.id ? '#60a5fa' : undefined }}
                >
                  {m.name}
                </span>
                {m.id === 'mambarul' && (
                  <span className="badge badge-blue text-xs py-0">★</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className="text-xs px-1.5 py-0.5 rounded font-medium"
                  style={{ backgroundColor: FAMILY_COLORS[m.family] + '22', color: FAMILY_COLORS[m.family] }}
                >
                  {m.family}
                </span>
              </div>
              <div className="flex gap-3 mt-1.5">
                <span className="text-xs font-mono text-text-muted">R²={m.best_r2.toFixed(3)}</span>
                <span className="text-xs font-mono text-text-muted">{m.params}M</span>
              </div>
            </button>
          ))}
        </div>

        {/* Detail panel */}
        <motion.div
          key={selected.id}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          className="flex-1 space-y-4 min-w-0"
        >
          {/* Header */}
          <div className="panel p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h2 className="text-xl font-bold text-text-primary mb-1">{selected.name}</h2>
                <p className="text-sm text-text-secondary">{selected.description}</p>
              </div>
              <div className="flex gap-2 flex-shrink-0 ml-4">
                <div className="text-right">
                  <div className="text-xs text-text-muted">Best RMSE</div>
                  <div className="font-mono font-bold text-text-accent">{selected.best_rmse}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-text-muted">R²</div>
                  <div className="font-mono font-bold text-emerald-400">{selected.best_r2.toFixed(3)}</div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-text-muted">Params</div>
                  <div className="font-mono font-bold text-text-accent">{selected.params}M</div>
                </div>
              </div>
            </div>
          </div>

          {/* Architecture diagram */}
          <div className="panel p-5">
            <h3 className="section-title mb-4">Architecture Diagram</h3>
            <ArchDiagram layers={selected.layers} connections={selected.connections} />
            <p className="text-xs text-text-muted mt-3 flex items-center gap-1">
              <span className="w-4 h-px bg-border-subtle inline-block" style={{ borderTop: '1px dashed #1e3a5f' }} />
              Dashed lines = animated data flow
            </p>
          </div>

          {/* MambaBlock internals */}
          {selected.id === 'mambarul' && (
            <div className="panel p-5">
              <button
                onClick={() => setShowSSM(!showSSM)}
                className="flex items-center gap-2 w-full text-left"
              >
                <h3 className="section-title">MambaBlock SSM Equations</h3>
                <ChevronRight size={16} className={`text-text-muted ml-auto transition-transform ${showSSM ? 'rotate-90' : ''}`} />
              </button>
              {showSSM && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
                  <pre className="text-xs font-mono text-text-secondary bg-bg-primary rounded-lg p-4 border border-border-subtle leading-relaxed overflow-x-auto">
{`# Input gating
x_in, z = split(Linear_2x(x))       # (B, L, d_inner×2)

# Local causal convolution
x_conv = causal_conv1d(x_in, k=4)   # (B, L, d_inner)
x_conv = SiLU(x_conv)

# Selective SSM parameters (input-dependent)
B_mat, C_mat, Δ_raw = Linear(x_conv)
Δ = Softplus(Linear_Δ(Δ_raw))       # dt > 0

# Discretize continuous A (log-parameterized)
A = -exp(A_log)                      # (d_inner, d_state)
A_bar = exp(Δ ⊗ A)                  # discretized A
B_bar = Δ ⊗ B_mat                   # discretized B

# Sequential selective scan
for t in range(L):
    h_t = A_bar_t ⊙ h_{t-1} + B_bar_t ⊙ x_t
    y_t = (h_t ⊙ C_mat_t).sum(-1)  # (B, d_inner)

# Skip connection + gating
y = y + x_in * D                    # D is learned scalar
out = out_proj(y * SiLU(z))         # (B, L, d_model)`}
                  </pre>
                  <div className="mt-3 grid grid-cols-3 gap-3">
                    {[
                      { label: 'Anchor 1: Fresh', desc: 'Captures initial capacity and early cycle features. High weight in first 10 time steps.' },
                      { label: 'Anchor 2: Knee', desc: 'Detects inflection point in degradation curve (≈70% SoH). Phase transition features.' },
                      { label: 'Anchor 3: Near-EOL', desc: 'Rapid degradation regime. High weight when cap_pct < 0.5. Terminal features.' },
                    ].map(a => (
                      <div key={a.label} className="bg-bg-elevated rounded-lg p-3 border border-border-subtle">
                        <div className="text-xs font-semibold text-brand-blue mb-1">{a.label}</div>
                        <div className="text-xs text-text-secondary">{a.desc}</div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

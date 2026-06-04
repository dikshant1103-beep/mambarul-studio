import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Cpu, ChevronDown, ChevronUp, Zap, Info } from 'lucide-react'

// ── Version definitions ──────────────────────────────────────────────────────
const VERSIONS = [
  {
    id: 'v1', label: 'v1 — Baseline',
    features: 8, rmse: 88.8, r2: 0.636, oxford_r2: null,
    breakthrough: false,
    innovation: 'First MambaRUL with 4× Mamba SSM + Degradation Anchor Attention. CALCE-only training.',
    inputs: ['Capacity (Ah)', 'Charge Time', 'Voltage Mean', 'Voltage End', 'Energy (Wh)', 'Temperature', 'Cap. Slope', 'Int. Resistance'],
    input_shape: '(B, 30, 8)',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber (δ=1.0)',
      note: 'Stride=10 (limited windows). No SG smoothing. Basic feature set.'
    },
    layers: [
      { label: 'Input\n(B,30,8)', type: 'input', color: '#475569' },
      { label: 'Linear\n8→128\n+LayerNorm', type: 'linear', color: '#06b6d4' },
      { label: 'Pos.Enc\n(30,128)', type: 'positional', color: '#78716c' },
      { label: 'Mamba×1\nd=128,s=16', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×2\nd=128,s=16', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×3\nd=128,s=16', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×4\nd=128,s=16', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn\n3anch,4head', type: 'attention', color: '#8b5cf6' },
      { label: 'MLP Head\n128→64→1', type: 'mlp', color: '#06b6d4' },
      { label: 'RUL\n(norm.)', type: 'output', color: '#475569' },
    ]
  },
  {
    id: 'v2', label: 'v2 — EOL-Weighted',
    features: 8, rmse: 84.2, r2: 0.648, oxford_r2: -0.004,
    breakthrough: false,
    innovation: 'Added EOL-weighted Huber loss (3× weight when cap_pct < 0.3). Evaluated on NASA.',
    inputs: ['Capacity (Ah)', 'Charge Time', 'Voltage Mean', 'Voltage End', 'Energy (Wh)', 'Temperature', 'Cap. Slope', 'Int. Resistance'],
    input_shape: '(B, 30, 8)',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'EOL-Weighted Huber (3× at cap_pct<0.3)',
      note: 'Same architecture as v1. Loss change improves late-life accuracy.'
    },
    layers: [
      { label: 'Input\n(B,30,8)', type: 'input', color: '#475569' },
      { label: 'Linear\n8→128', type: 'linear', color: '#06b6d4' },
      { label: 'Pos.Enc', type: 'positional', color: '#78716c' },
      { label: 'Mamba×1', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×2', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×3', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×4', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn\n3 anchors', type: 'attention', color: '#8b5cf6' },
      { label: 'EOL-Wt.\nHuber Loss', type: 'loss', color: '#f59e0b' },
      { label: 'MLP→RUL', type: 'mlp', color: '#06b6d4' },
    ]
  },
  {
    id: 'v3', label: 'v3 — ICA/DVA (all)',
    features: 14, rmse: 89.1, r2: 0.619, oxford_r2: -1.118,
    breakthrough: false,
    innovation: 'Added 6 ICA/DVA electrochemical features (dQ/dV peak height, voltage, area, valley; dV/dQ peak, valley). CALCE CS2 only.',
    inputs: ['Capacity','ChgTime','VMean','VEnd','Energy','Temp','CapSlope','IR', 'ICA peak height','ICA peak voltage','ICA peak area','ICA valley depth','DVA peak height','DVA valley depth'],
    input_shape: '(B, 30, 14)',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber',
      note: 'ICA/DVA features hurt Oxford ZS (r²=-1.118). Chemistry-specific features overfit to CALCE LCO.'
    },
    layers: [
      { label: 'Input\n(B,30,14)', type: 'input', color: '#475569' },
      { label: '+6 ICA/DVA\nfeatures', type: 'feature', color: '#10b981' },
      { label: 'Linear\n14→128', type: 'linear', color: '#06b6d4' },
      { label: 'Pos.Enc', type: 'positional', color: '#78716c' },
      { label: 'Mamba ×4\nd=128', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn', type: 'attention', color: '#8b5cf6' },
      { label: 'MLP→RUL', type: 'mlp', color: '#06b6d4' },
    ]
  },
  {
    id: 'v3b', label: 'v3b — Selective ICA',
    features: 12, rmse: 85.9, r2: 0.661, oxford_r2: -1.118,
    breakthrough: false,
    innovation: 'Selective ICA/DVA: kept only 4 most useful IC features (ICA peak height+voltage, DVA peak+valley). Better CALCE but ZS still hurts.',
    inputs: ['Capacity','ChgTime','VMean','VEnd','Energy','Temp','CapSlope','IR','ICA peak ht','ICA peak V','DVA peak ht','DVA valley'],
    input_shape: '(B, 30, 12)',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber',
      note: 'Selective ablation of ICA features. Best CALCE with IC features, still fails ZS.'
    },
    layers: [
      { label: 'Input\n(B,30,12)', type: 'input', color: '#475569' },
      { label: '+4 selective\nICA/DVA', type: 'feature', color: '#10b981' },
      { label: 'Linear\n12→128', type: 'linear', color: '#06b6d4' },
      { label: 'Mamba ×4', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn', type: 'attention', color: '#8b5cf6' },
      { label: 'MLP→RUL', type: 'mlp', color: '#06b6d4' },
    ]
  },
  {
    id: 'v4', label: 'v4 — Region Ensemble',
    features: 'ens', rmse: 77.6, r2: 0.722, oxford_r2: null,
    breakthrough: false,
    innovation: 'Soft ensemble of v2 (8-feat) + v3b (12-feat) with region-aware weighting: v3b gets higher weight in knee/EOL region.',
    inputs: ['v2 model (8 feat)', 'v3b model (12 feat)', 'cap_pct (region gate)'],
    input_shape: 'Ensemble',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Ensemble blending',
      note: 'w = sigmoid((0.7 - cap_pct) * 10). w*v3b + (1-w)*v2.'
    },
    layers: [
      { label: 'v2 pred\n(8 feat)', type: 'input', color: '#3b82f6' },
      { label: 'v3b pred\n(12 feat)', type: 'input', color: '#10b981' },
      { label: 'cap_pct\ngate', type: 'feature', color: '#f59e0b' },
      { label: 'Region\nBlend\nw=σ((0.7-soh)×10)', type: 'film', color: '#ea580c' },
      { label: 'Ensemble\nRUL', type: 'output', color: '#475569' },
    ]
  },
  {
    id: 'v5', label: 'v5 — MMD Alignment',
    features: 12, rmse: 81.8, r2: 0.693, oxford_r2: -0.917,
    breakthrough: false,
    innovation: 'Added Maximum Mean Discrepancy (MMD) domain alignment loss to match CALCE and NASA feature distributions.',
    inputs: ['All 12 from v3b', '+MMD loss during training'],
    input_shape: '(B, 30, 12)',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber + MMD(CALCE, NASA)',
      note: 'MMD kernel: RBF σ=1. Reduces domain shift. NASA ZS improved by 0.201 R².'
    },
    layers: [
      { label: 'CALCE\nInput', type: 'input', color: '#3b82f6' },
      { label: 'NASA\nInput', type: 'input', color: '#f59e0b' },
      { label: 'Shared Encoder\nMamba ×4', type: 'mamba', color: '#3b82f6' },
      { label: 'MMD\nAlignment\nLoss', type: 'loss', color: '#ef4444' },
      { label: 'RUL\nHuber Loss', type: 'loss', color: '#f59e0b' },
      { label: 'MLP→RUL', type: 'mlp', color: '#06b6d4' },
    ]
  },
  {
    id: 'v7b', label: 'v7b — Multi-Dataset',
    features: 9, rmse: 84.18, r2: -0.029, oxford_r2: null,
    breakthrough: false,
    innovation: 'Trained on 139K windows from CALCE + NASA + MIT + KJTU. Collapsed to constant prediction (R²≈0).',
    inputs: ['9 features across 4 datasets'],
    input_shape: '(B, 30, 9)',
    architecture: {
      d_model: 96, n_mamba: 3, n_anchors: 3, n_heads: 4,
      loss: 'Huber',
      note: 'FAILURE MODE: different RUL scales across datasets + missing features per chemistry → model predicts mean RUL. R²≈0.'
    },
    layers: [
      { label: 'Multi-Dataset\nInput\n(139K cyc)', type: 'input', color: '#475569' },
      { label: 'Linear\n9→96', type: 'linear', color: '#06b6d4' },
      { label: 'Mamba ×3\nd=96', type: 'mamba', color: '#ef4444' },
      { label: 'Anchor Attn', type: 'attention', color: '#8b5cf6' },
      { label: 'MLP → mean\nRUL (collapse)', type: 'output', color: '#ef4444' },
    ]
  },
  {
    id: 'v8', label: 'v8 — BREAKTHROUGH',
    features: 13, rmse: 23.95, r2: 0.942, oxford_r2: -1.447,
    breakthrough: true,
    innovation: 'THREE KEY CHANGES: (1) stride=1 for LCO → 36→916 windows, (2) Savitzky-Golay smoothing before features, (3) chemistry-balanced sampling. RMSE: 84→24!',
    inputs: ['Capacity','ChgTime','VMean','VEnd','Energy','Temp','CapSlope','IR','Chem.Code','cap_pct','ΔCap','CumE','ΔIR'],
    input_shape: '(B, 30, 13)',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber',
      note: 'Stride=1 (26× more data). SG(w=11,ord=3) smoothing. Kinetic filter. 13 features inc. cap_pct + 3 derived.'
    },
    layers: [
      { label: 'SG Smooth\n+Kinetic\nFilter', type: 'feature', color: '#10b981' },
      { label: 'Input\n(B,30,13)\nstride=1', type: 'input', color: '#475569' },
      { label: 'Linear\n13→128', type: 'linear', color: '#06b6d4' },
      { label: 'Pos.Enc\n(30,128)', type: 'positional', color: '#78716c' },
      { label: 'Mamba×1\nd=128', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×2', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×3', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×4', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn\n3 anchors\n4 heads', type: 'attention', color: '#8b5cf6' },
      { label: 'MLP→RUL\nRMSE=24', type: 'output', color: '#475569' },
    ]
  },
  {
    id: 'v9', label: 'v9 — +Oxford Training',
    features: 13, rmse: 22.11, r2: 0.952, oxford_r2: 0.741,
    breakthrough: false,
    innovation: 'Added Oxford Cell1–6 (NMC pouch, 8000 cycles) to training set. Oxford ZS jumped from -1.4 → +0.74.',
    inputs: ['Same 13 features', '+Oxford Cell1-6 in training'],
    input_shape: '(B, 30, 13)',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber',
      note: 'Training: CALCE + Oxford Cell1-6. Oxford cells have ~80 windows each (100-cycle snapshots).'
    },
    layers: [
      { label: 'CALCE\n+Oxford\nTraining', type: 'feature', color: '#f59e0b' },
      { label: 'Input\n(B,30,13)', type: 'input', color: '#475569' },
      { label: 'Embed\n13→128', type: 'linear', color: '#06b6d4' },
      { label: 'Mamba ×4\nd=128', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn\n3 anchors', type: 'attention', color: '#8b5cf6' },
      { label: 'MLP→RUL\nOxf ZS=0.74', type: 'output', color: '#475569' },
    ]
  },
  {
    id: 'v10', label: 'v10 — +PyBaMM Synth.',
    features: 13, rmse: 22.68, r2: 0.946, oxford_r2: 0.858,
    breakthrough: false,
    innovation: 'Added 20 PyBaMM-simulated synthetic NMC cells to training. Physics-based data augmentation.',
    inputs: ['Same 13 features', '+20 synthetic NMC cells from PyBaMM'],
    input_shape: '(B, 30, 13)',
    architecture: {
      d_model: 128, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber',
      note: 'PyBaMM DFN model simulates capacity fade. Oxford ZS → +0.858.'
    },
    layers: [
      { label: 'Real +\nSynthetic\nPyBaMM', type: 'feature', color: '#8b5cf6' },
      { label: 'Input\n(B,30,13)', type: 'input', color: '#475569' },
      { label: 'Embed\n13→128', type: 'linear', color: '#06b6d4' },
      { label: 'Mamba ×4', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn', type: 'attention', color: '#8b5cf6' },
      { label: 'MLP→RUL\nOxf=0.858', type: 'output', color: '#475569' },
    ]
  },
  {
    id: 'v10full', label: 'v10-full — Primary',
    features: 13, rmse: 21.49, r2: 0.959, oxford_r2: 0.887,
    breakthrough: false,
    innovation: 'Clean held-out test split (CS2_37, CS2_38 never seen during training or model selection). Primary reference model.',
    inputs: ['Capacity','ChgTime','VMean','VEnd','Energy','Temp','CapSlope','IR','ChemCode','cap_pct','ΔCap','CumE*','ΔIR'],
    input_shape: '(B, 30, 13)',
    architecture: {
      d_model: 256, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber',
      note: 'd_model upgraded to 256 for primary model. Rigorous data integrity: test cells never seen in any training step.'
    },
    layers: [
      { label: 'Input\n(B,30,13)\nclean split', type: 'input', color: '#475569' },
      { label: 'Linear\n13→256\n+LayerNorm', type: 'linear', color: '#06b6d4' },
      { label: 'Pos.Enc\n(30,256)', type: 'positional', color: '#78716c' },
      { label: 'Mamba×1\nd=256,s=16', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×2\nd=256,s=16', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×3\nd=256,s=16', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×4\nd=256,s=16', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn\n3 anchors\nn_heads=4', type: 'attention', color: '#8b5cf6' },
      { label: 'LayerNorm', type: 'norm', color: '#475569' },
      { label: 'MLP Head\n256→64→1', type: 'mlp', color: '#06b6d4' },
      { label: 'RUL\n(×309 cyc)', type: 'output', color: '#475569' },
    ]
  },
  {
    id: 'v10final', label: 'v10-final — Best ZS',
    features: 18, rmse: 20.6, r2: 0.910, oxford_r2: 0.911,
    breakthrough: false,
    innovation: 'Added Chemistry Input Projection for LFP: Linear(18→13) maps 5 IC curve features (dQ/dV peaks) for LFP cells. Oxford ZS → 0.911.',
    inputs: ['Base 13 features', '+LFP IC: ICA pk1 ht/V/area, ICA pk2, DVA valley (→ 18 for LFP only)'],
    input_shape: '(B, 30, 13) LCO/NMC/NCM  |  (B, 30, 18) LFP',
    architecture: {
      d_model: 256, n_mamba: 4, n_anchors: 3, n_heads: 4,
      loss: 'Huber',
      note: 'ChemInputProjection: if chem=LFP → Linear(18→13), else identity. Diagonal weight ≈ 0.998.'
    },
    layers: [
      { label: 'LFP Input\n(B,30,18)\n+IC feats', type: 'input', color: '#10b981' },
      { label: 'Other Input\n(B,30,13)', type: 'input', color: '#475569' },
      { label: 'Chem. Input\nProjection\nLFP: 18→13', type: 'projection', color: '#c026d3' },
      { label: 'Linear\n13→256', type: 'linear', color: '#06b6d4' },
      { label: 'Pos.Enc\n(30,256)', type: 'positional', color: '#78716c' },
      { label: 'Mamba×1\nd=256', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×2\nd=256', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×3\nd=256', type: 'mamba', color: '#3b82f6' },
      { label: 'Mamba×4\nd=256', type: 'mamba', color: '#3b82f6' },
      { label: 'Anchor Attn\n3 anch,4h', type: 'attention', color: '#8b5cf6' },
      { label: 'MLP Head\n256→64→1', type: 'mlp', color: '#06b6d4' },
      { label: 'RUL\nZS R²=0.911', type: 'output', color: '#10b981' },
    ]
  },
]

// ── Layer type colors & labels ───────────────────────────────────────────────
const LAYER_META: Record<string, { bg: string; border: string; text: string }> = {
  input:      { bg: '#0f172a', border: '#475569', text: '#94a3b8' },
  output:     { bg: '#0f172a', border: '#475569', text: '#94a3b8' },
  linear:     { bg: '#0e2a3f', border: '#06b6d4', text: '#22d3ee' },
  positional: { bg: '#1c1917', border: '#78716c', text: '#a8a29e' },
  mamba:      { bg: '#1e3a5f', border: '#3b82f6', text: '#60a5fa' },
  attention:  { bg: '#2d1b69', border: '#8b5cf6', text: '#a78bfa' },
  mlp:        { bg: '#0e2a3f', border: '#06b6d4', text: '#22d3ee' },
  feature:    { bg: '#052e16', border: '#10b981', text: '#34d399' },
  film:       { bg: '#431407', border: '#ea580c', text: '#fb923c' },
  loss:       { bg: '#450a0a', border: '#ef4444', text: '#f87171' },
  norm:       { bg: '#1c1917', border: '#78716c', text: '#a8a29e' },
  projection: { bg: '#1e0a2e', border: '#c026d3', text: '#e879f9' },
}

// ── Animated Architecture ─────────────────────────────────────────────────────
function AnimArch({ layers }: { layers: { label: string; type: string; color: string }[] }) {
  const W = 100; const H = 60; const GAP = 24; const SVGW = layers.length * (W + GAP) + 20
  const SVGH = 110
  const [active, setActive] = useState(-1)

  useEffect(() => {
    const t = setInterval(() => setActive(p => (p + 1) % layers.length), 500)
    return () => clearInterval(t)
  }, [layers.length])

  return (
    <div className="overflow-x-auto rounded-lg bg-bg-primary border border-border-subtle p-3">
      <svg width={SVGW} height={SVGH} style={{ minWidth: SVGW }}>
        <defs>
          <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#1e3a5f" />
          </marker>
        </defs>
        {layers.map((l, i) => {
          const m = LAYER_META[l.type] ?? LAYER_META.linear
          const x = i * (W + GAP) + 10
          const y = 10
          const isActive = i === active
          return (
            <g key={i}>
              {i < layers.length - 1 && (
                <line x1={x + W} y1={y + H / 2} x2={x + W + GAP} y2={y + H / 2}
                  stroke={isActive ? l.color : '#1e3a5f'}
                  strokeWidth={isActive ? 2 : 1.2}
                  strokeDasharray="4 2" markerEnd="url(#arr)"
                  style={{ transition: 'stroke 0.3s' }}
                />
              )}
              <rect x={x} y={y} width={W} height={H} rx="6"
                fill={m.bg}
                stroke={isActive ? l.color : m.border}
                strokeWidth={isActive ? 2.5 : 1.5}
                style={{ transition: 'stroke 0.3s', filter: isActive ? `drop-shadow(0 0 6px ${l.color}88)` : 'none' }}
              />
              {l.label.split('\n').map((line, li) => (
                <text key={li} x={x + W / 2} y={y + H / 2 + (li - (l.label.split('\n').length - 1) / 2) * 11}
                  textAnchor="middle" fontSize="8.5" fill={isActive ? l.color : m.text}
                  fontFamily="JetBrains Mono, monospace"
                  style={{ transition: 'fill 0.3s' }}>
                  {line}
                </text>
              ))}
            </g>
          )
        })}
        {/* Data flow label */}
        <text x="10" y={SVGH - 6} fontSize="9" fill="#475569" fontFamily="Inter">
          Data flow →  (animated)
        </text>
      </svg>
    </div>
  )
}

// ── API version-ladder shape ──────────────────────────────────────────────────
interface ApiVersionItem {
  version: string
  rmse: number
  r2: number
}

// Map API version strings to VERSIONS id field
// API uses: v1, v2, v3, v3b, v4, v5, v8, v9, v10-full, v10-final
// VERSIONS uses: v1, v2, v3, v3b, v4, v5, v7b, v8, v9, v10, v10full, v10final
function apiVersionToId(apiVersion: string): string {
  if (apiVersion === 'v10-full') return 'v10full'
  if (apiVersion === 'v10-final') return 'v10final'
  return apiVersion
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function ModelVersions() {
  const [versions, setVersions] = useState(VERSIONS)
  const [selected, setSelected] = useState(VERSIONS[0])
  const [showLayers, setShowLayers] = useState(true)

  useEffect(() => {
    fetch('/api/results/version-ladder')
      .then(r => r.json())
      .then((apiItems: ApiVersionItem[]) => {
        const apiMap = new Map(apiItems.map(item => [apiVersionToId(item.version), item]))
        setVersions(prev => {
          const enriched = prev.map(v => {
            const api = apiMap.get(v.id)
            if (!api) return v
            return { ...v, rmse: api.rmse, r2: api.r2 }
          })
          // Keep selected detail panel in sync with enriched values
          setSelected(cur => {
            const updated = enriched.find(v => v.id === cur.id)
            return updated ?? cur
          })
          return enriched
        })
      })
      .catch(err => console.error('ModelVersions version-ladder fetch error:', err))
  }, [])

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Cpu size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Model Versions — v1 to v10-final</h1>
        </div>
        <p className="text-text-secondary">Each version's architecture, features, innovations, and animated data flow</p>
      </div>

      <div className="flex gap-5">
        {/* Version list */}
        <div className="w-52 flex-shrink-0 space-y-1">
          {versions.map(v => (
            <button
              key={v.id}
              onClick={() => {
                const latest = versions.find(x => x.id === v.id) ?? v
                setSelected(latest)
              }}
              className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all duration-150 ${
                selected.id === v.id
                  ? 'border-border-active bg-brand-blue/10'
                  : v.breakthrough
                    ? 'border-red-500/40 bg-red-500/5 hover:border-red-500/60'
                    : 'border-transparent hover:bg-bg-panel'
              }`}
            >
              <div className="flex items-center gap-2">
                {v.breakthrough && <Zap size={12} className="text-red-400 flex-shrink-0" />}
                <span className={`text-xs font-semibold ${
                  selected.id === v.id ? 'text-brand-blue' :
                  v.breakthrough ? 'text-red-400' : 'text-text-secondary'
                }`}>{v.label}</span>
              </div>
              <div className="flex gap-2 mt-0.5">
                <span className="text-xs font-mono text-text-muted">{v.rmse} RMSE</span>
                <span className={`text-xs font-mono ${v.r2 > 0 ? 'text-emerald-400' : 'text-red-400'}`}>R²={v.r2}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Detail */}
        <motion.div
          key={selected.id}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2 }}
          className="flex-1 space-y-4"
        >
          {/* Header */}
          <div className={`panel p-5 ${selected.breakthrough ? 'border-red-500/40 bg-red-500/5' : ''}`}>
            <div className="flex items-start justify-between mb-2">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h2 className="text-xl font-bold text-text-primary">{selected.label}</h2>
                  {selected.breakthrough && (
                    <span className="badge badge-red flex items-center gap-1"><Zap size={11} /> BREAKTHROUGH</span>
                  )}
                  <span className="badge badge-blue">{typeof selected.features === 'number' ? `${selected.features} features` : selected.features}</span>
                </div>
                <p className="text-sm text-text-secondary max-w-2xl">{selected.innovation}</p>
              </div>
              <div className="flex gap-4 flex-shrink-0 ml-4 text-right">
                <div><div className="metric-label">RMSE</div><div className="font-mono font-bold text-text-accent">{selected.rmse}</div></div>
                <div><div className="metric-label">CALCE R²</div><div className={`font-mono font-bold ${selected.r2 > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{selected.r2}</div></div>
                <div><div className="metric-label">Oxford ZS R²</div><div className={`font-mono font-bold ${!selected.oxford_r2 ? 'text-text-muted' : selected.oxford_r2 > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{selected.oxford_r2 ?? '—'}</div></div>
              </div>
            </div>
            <div className="flex gap-4 mt-3 text-xs text-text-muted font-mono">
              <span>d_model={selected.architecture.d_model}</span>
              <span>n_mamba={selected.architecture.n_mamba}</span>
              <span>n_anchors={selected.architecture.n_anchors}</span>
              <span>input={selected.input_shape}</span>
              <span>loss: {selected.architecture.loss}</span>
            </div>
          </div>

          {/* Architecture diagram */}
          <div className="panel p-5">
            <div className="flex items-center justify-between mb-4">
              <h3 className="section-title">Architecture Diagram — Animated Data Flow</h3>
              <button onClick={() => setShowLayers(!showLayers)} className="btn-ghost text-xs flex items-center gap-1">
                {showLayers ? <ChevronUp size={14} /> : <ChevronDown size={14} />} Layer Table
              </button>
            </div>
            <AnimArch layers={selected.layers} />

            {showLayers && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border-subtle">
                      {['#', 'Layer', 'Type', 'Role'].map(h => (
                        <th key={h} className="text-left pb-2 pr-4 text-text-muted uppercase tracking-wider">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {selected.layers.map((l, i) => {
                      const m = LAYER_META[l.type] ?? LAYER_META.linear
                      const roles: Record<string, string> = {
                        input: 'Accepts raw feature window', output: 'Emits RUL prediction',
                        linear: 'Projects input dim to model dim', positional: 'Adds cycle-position information',
                        mamba: 'Selective SSM: state h_t = A·h_{t-1} + B·x_t, y_t = C·h_t',
                        attention: 'Cross-attention: Q=encoder, K/V=learned anchors',
                        mlp: 'Non-linear regression head → scalar RUL',
                        feature: 'Pre-processing / data augmentation step',
                        film: 'FiLM conditioning: γ·x + β',
                        loss: 'Training loss computation (not present at inference)',
                        norm: 'LayerNorm stabilizes training',
                        projection: 'Chemistry-conditional linear map',
                      }
                      return (
                        <tr key={i} className="border-b border-border-subtle/30">
                          <td className="py-1.5 pr-4 font-mono text-text-muted">{i + 1}</td>
                          <td className="py-1.5 pr-4">
                            <span className="px-1.5 py-0.5 rounded text-xs font-mono" style={{ color: m.text, backgroundColor: m.bg, border: `1px solid ${m.border}55` }}>
                              {l.label.replace(/\n/g, ' ')}
                            </span>
                          </td>
                          <td className="py-1.5 pr-4 text-text-muted capitalize">{l.type}</td>
                          <td className="py-1.5 text-text-secondary">{roles[l.type] ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Input features */}
          <div className="panel p-5">
            <h3 className="section-title mb-3">Input Features — {selected.input_shape}</h3>
            <div className="flex flex-wrap gap-2">
              {selected.inputs.map((feat, i) => (
                <span key={i} className="text-xs px-2.5 py-1 rounded-lg border font-mono" style={{
                  borderColor: feat.includes('IC') || feat.includes('ICA') || feat.includes('DVA') ? '#10b98166' : '#1e3a5f',
                  backgroundColor: feat.includes('IC') || feat.includes('ICA') || feat.includes('DVA') ? '#10b98111' : '#111827',
                  color: feat.includes('IC') || feat.includes('ICA') || feat.includes('DVA') ? '#34d399' : '#94a3b8',
                }}>
                  #{i} {feat}
                </span>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div className="panel p-5 border-border-subtle/60 bg-bg-elevated/50">
            <div className="flex items-start gap-2">
              <Info size={14} className="text-brand-blue mt-0.5 flex-shrink-0" />
              <p className="text-xs text-text-secondary leading-relaxed">{selected.architecture.note}</p>
            </div>
          </div>
        </motion.div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { motion } from 'framer-motion'
import { BookOpen, ChevronRight, ExternalLink } from 'lucide-react'

const CHAPTERS = [
  {
    id: 'ch1', num: 1, title: 'Introduction',
    desc: 'Motivation, research objectives, and thesis overview for multi-chemistry battery RUL prediction.',
    formulas: [],
    findings: [
      'Lithium-ion batteries degrade through SEI growth, lithium plating, and active material loss',
      'Accurate RUL prediction enables predictive maintenance and optimal replacement scheduling',
      'Existing benchmarks use single chemistry, single dataset, and often contain data leakage',
      'MambaRUL addresses these gaps with multi-chemistry evaluation, leakage audit, and zero-shot transfer',
    ],
    relatedPages: [{ label: 'Dataset Collection', path: '/datasets' }],
  },
  {
    id: 'ch2', num: 2, title: 'Literature Review',
    desc: 'Survey of data-driven RUL prediction methods from LSTM to Transformer to State Space Models.',
    formulas: [],
    findings: [
      'Traditional methods: Kalman filter, particle filter — require explicit degradation models',
      'Data-driven: LSTM, GRU, Transformer — learn from cycling data without physics assumptions',
      'Mamba SSM (Gu & Dao 2023): linear-time sequence modeling via selective state spaces',
      'Key gap: existing work rarely evaluates cross-chemistry or zero-shot transfer performance',
      'Leakage in prior work: cumulative energy features correlated r=-1 with RUL — artificially inflated metrics',
    ],
    relatedPages: [{ label: 'Leakage Audit', path: '/leakage' }],
  },
  {
    id: 'ch3', num: 3, title: 'Dataset & Feature Engineering',
    desc: '6 benchmark datasets, 13-feature pipeline, leakage discovery, and preprocessing methodology.',
    formulas: [
      { name: 'SOH Proxy (cap_pct)', eq: 'SOH_i = Q_i / Q_0' },
      { name: 'Savitzky-Golay Smoothing', eq: 'Q_smooth = SG(Q_raw, window=11, order=3)' },
      { name: 'Kinetic Filter', eq: 'mask_i = 1 if Q_i ≤ Q_{i-1} × 1.05 else 0' },
      { name: 'Rolling Slope', eq: 'dQ/di ≈ (Q_i − Q_{i-5}) / 5' },
      { name: 'CumEnergy Leakage', eq: 'r(E_cum, RUL) = −1.000  [EXCLUDED]' },
      { name: 'Z-Score Normalization', eq: 'x_norm = (x − μ_train) / σ_train' },
    ],
    findings: [
      '13-feature pipeline: 9 raw + 4 derived features, all leakage-free',
      'cap_pct (SOH) is single most informative feature: mean |SHAP| = 0.31',
      'CumEnergy excluded: r=-1.000 with RUL — perfect leakage via cycle counter identity',
      'Per-cell normalization computed from training cells only: prevents cross-cell contamination',
      'Stride=1 for LCO: 36 → 916 windows per cell — single biggest data engineering win',
      'SG smoothing + kinetic filter removes artefactual capacity jumps from sensor noise',
    ],
    relatedPages: [
      { label: 'Feature Engineering', path: '/features' },
      { label: 'Leakage Audit', path: '/leakage' },
      { label: 'Datasets', path: '/datasets' },
    ],
  },
  {
    id: 'ch4', num: 4, title: 'Model Architecture',
    desc: 'MambaRUL architecture: Mamba SSM blocks, degradation anchor attention, and chemistry input projection.',
    formulas: [
      { name: 'Selective SSM State Update', eq: 'h_t = A_bar_t · h_{t-1} + B_bar_t · x_t' },
      { name: 'SSM Output', eq: 'y_t = C_t · h_t  (+  D · x_t  skip)' },
      { name: 'Discretized A', eq: 'A_bar = exp(Δ ⊗ A)   [Δ = Softplus(Linear(x))]' },
      { name: 'Anchor Cross-Attention', eq: 'CrossAttn(Q, K, V)  Q=Mamba_out, K,V=anchors' },
      { name: 'Attention Weights', eq: 'α = Softmax(Q·Kᵀ / √d_k)' },
      { name: 'Chemistry Projection', eq: 'x_LFP = Linear_18→13(x_18)   [LFP only]' },
      { name: 'Architecture', eq: '(B,30,13) → Embed(256) → 4×Mamba → AnchorAttn → MLP → RUL' },
    ],
    findings: [
      '4× MambaBlocks: d_model=256, d_state=16, d_conv=4, expand=2, total ~2.8M params',
      '3 degradation anchors learned jointly: Fresh / Knee / Near-EOL regime embeddings',
      'Cross-attention Q=Mamba output, K=V=anchors: allows regime-conditioned predictions',
      'Chemistry projection: LFP-only Linear(18→13) for IC curve features; diagonal ≈ identity',
      'Learnable positional encoding (30 positions) captures within-window temporal structure',
      'MLP head: Linear(256→64)→ReLU→Linear(64→1). Output: normalized RUL ∈ [0,1]',
    ],
    relatedPages: [{ label: 'Model Gallery', path: '/models' }],
  },
  {
    id: 'ch5', num: 5, title: 'Training & Experiments',
    desc: 'Training methodology, ablation studies, baseline comparisons, and version ladder.',
    formulas: [
      { name: 'Huber Loss', eq: 'L(ŷ,y) = 0.5(ŷ-y)² if |ŷ-y|≤δ else δ|ŷ-y|−0.5δ²' },
      { name: 'EOL-Weighted Loss', eq: 'L_w = L(ŷ,y) × (1 + 2 × 1[cap_pct < 0.3])' },
      { name: 'RMSE%', eq: 'RMSE% = (RMSE / T_mean) × 100  [T_mean = mean lifetime]' },
    ],
    findings: [
      'Training: Adam(lr=1e-4), CosineAnnealingLR, batch=32, max_epochs=150, patience=30',
      'v8 breakthrough: stride=1 + SG smoothing + balanced sampling → RMSE 84→24 (65% improvement)',
      'v9: added Oxford Cell1–6 to training → Oxford ZS R² −1.4 → +0.74 (huge transfer gain)',
      'v10-full: clean held-out test split → primary model (CALCE RMSE=21.49, R²=0.959)',
      'v10-final: +LFP IC features → Oxford R²=+0.911, NMC R²=+0.854',
      'MambaRUL outperforms Transformer (RMSE 20.6 vs 31.4), LSTM (38.7), GRU (35.2)',
      'Ablation: removing cap_pct raises RMSE by 12%; removing anchors raises RMSE by 8%',
    ],
    relatedPages: [
      { label: 'Benchmark Dashboard', path: '/benchmark' },
      { label: 'Model Gallery', path: '/models' },
    ],
  },
  {
    id: 'ch6', num: 6, title: 'Oxford Transfer',
    desc: 'Zero-shot and calibration-based transfer to Oxford NMC pouch cells with ~8000-cycle lifetime.',
    formulas: [
      { name: 'K-Sweep B1+D Fine-Tune', eq: 'θ_B1+D = θ_encoder (frozen) + θ_mlp_head (trainable)' },
      { name: 'Double-Exponential Fit', eq: 'Q(k) = A·exp(−α·k) + B·exp(−β·k) + C' },
      { name: 'Oxford Snapshot', eq: '~100-cycle intervals · 8000 total · ~80 windows per cell' },
    ],
    findings: [
      'Zero-shot (K=0): Cell7 R²=0.950, Cell8 R²=0.869, Combined R²=0.911 — excellent',
      'B1+D at K=20 achieves R²=0.917 — marginally beats zero-shot by +0.006',
      'K>20 hurts: encoder drift, double-exponential extrapolation unreliable for 8000-cycle cells',
      'Trainable params: 8,321 (MLP head only) vs 2.8M total — efficient fine-tuning',
      'Key insight: Oxford snapshot spacing (~100 cycles) well-matched to 30-window input',
      'Why ZS works: Cell1–6 and Cell7–8 share identical chemistry, protocol, and temperature',
    ],
    relatedPages: [{ label: 'Benchmark — Oxford Tab', path: '/benchmark' }],
  },
  {
    id: 'ch7', num: 7, title: 'Conclusion',
    desc: 'Summary of contributions, limitations, and future work directions.',
    formulas: [],
    findings: [
      'CONTRIBUTION 1: First comprehensive multi-chemistry RUL benchmark (5 chemistries, 17 test cells)',
      'CONTRIBUTION 2: Leakage audit — CumEnergy r=-1.000 flaw discovered and corrected',
      'CONTRIBUTION 3: Degradation anchor attention — regime-conditioned predictions',
      'CONTRIBUTION 4: Zero-shot Oxford transfer R²=+0.911 without any fine-tuning',
      'LIMITATION: MIT-LFP challenging (RMSE%=23.6%) due to flat voltage plateau',
      'FUTURE: Conformal prediction for calibrated uncertainty bounds',
      'FUTURE: Physics-informed pretraining with PyBaMM synthetic data',
      'FUTURE: Edge deployment on battery management systems (BMS)',
    ],
    relatedPages: [{ label: 'Live Prediction', path: '/predict' }],
  },
]

export default function ThesisExplorer() {
  const [activeChapter, setActiveChapter] = useState(CHAPTERS[0])

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <BookOpen size={22} className="text-text-accent" />
          <h1 className="text-2xl font-bold text-text-primary">Thesis Explorer</h1>
        </div>
        <p className="text-text-secondary">Navigate thesis chapters · Key formulas · Scientific findings · Links to platform modules</p>
      </div>

      <div className="flex gap-6">
        {/* Chapter nav */}
        <div className="w-56 flex-shrink-0 space-y-1">
          {CHAPTERS.map(ch => (
            <button
              key={ch.id}
              onClick={() => setActiveChapter(ch)}
              className={`w-full text-left px-3 py-3 rounded-lg border transition-all duration-150 ${
                activeChapter.id === ch.id
                  ? 'border-border-active bg-brand-blue/10 text-brand-blue'
                  : 'border-transparent text-text-secondary hover:text-text-primary hover:bg-bg-panel'
              }`}
            >
              <div className="text-xs text-text-muted mb-0.5 font-medium">Chapter {ch.num}</div>
              <div className="text-sm font-semibold leading-tight">{ch.title}</div>
            </button>
          ))}
        </div>

        {/* Chapter content */}
        <motion.div
          key={activeChapter.id}
          initial={{ opacity: 0, x: 8 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.2 }}
          className="flex-1 space-y-4"
        >
          {/* Header */}
          <div className="panel p-6">
            <div className="flex items-center gap-2 mb-1">
              <span className="badge badge-blue text-xs">Ch. {activeChapter.num}</span>
            </div>
            <h2 className="text-xl font-bold text-text-primary mb-2">{activeChapter.title}</h2>
            <p className="text-text-secondary text-sm">{activeChapter.desc}</p>

            {activeChapter.relatedPages.length > 0 && (
              <div className="flex gap-2 mt-4 flex-wrap">
                <span className="text-xs text-text-muted">Related modules:</span>
                {activeChapter.relatedPages.map(p => (
                  <a
                    key={p.path}
                    href={p.path}
                    className="flex items-center gap-1 text-xs text-brand-blue hover:text-blue-300 transition-colors"
                  >
                    <ExternalLink size={11} />
                    {p.label}
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Formulas */}
          {activeChapter.formulas.length > 0 && (
            <div className="panel p-6">
              <h3 className="section-title mb-4">Key Formulas</h3>
              <div className="space-y-3">
                {activeChapter.formulas.map(f => (
                  <div key={f.name} className="flex items-start gap-3">
                    <ChevronRight size={14} className="text-brand-blue mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-text-secondary mb-1">{f.name}</div>
                      <code className="block text-sm font-mono text-brand-cyan bg-bg-primary px-3 py-2 rounded-lg border border-border-subtle break-all">
                        {f.eq}
                      </code>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Findings */}
          <div className="panel p-6">
            <h3 className="section-title mb-4">Key Findings</h3>
            <div className="space-y-2.5">
              {activeChapter.findings.map((f, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className={`flex items-start gap-3 px-4 py-3 rounded-lg border ${
                    f.startsWith('CONTRIBUTION') ? 'border-emerald-500/30 bg-emerald-500/5' :
                    f.startsWith('LIMITATION') ? 'border-amber-500/30 bg-amber-500/5' :
                    f.startsWith('FUTURE') ? 'border-blue-500/20 bg-blue-500/5' :
                    'border-border-subtle bg-bg-elevated/50'
                  }`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${
                    f.startsWith('CONTRIBUTION') ? 'bg-emerald-400' :
                    f.startsWith('LIMITATION') ? 'bg-amber-400' :
                    f.startsWith('FUTURE') ? 'bg-blue-400' : 'bg-text-muted'
                  }`} />
                  <span className={`text-sm leading-relaxed ${
                    f.startsWith('CONTRIBUTION') ? 'text-emerald-300' :
                    f.startsWith('LIMITATION') ? 'text-amber-300' :
                    f.startsWith('FUTURE') ? 'text-blue-300' : 'text-text-secondary'
                  }`}>{f}</span>
                </motion.div>
              ))}
            </div>
          </div>

          {/* Version ladder for Ch5 */}
          {activeChapter.id === 'ch5' && (
            <div className="panel p-6">
              <h3 className="section-title mb-4">Complete Version Ladder</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border-subtle">
                    {['Version', 'RMSE', 'R²', 'Oxford ZS R²', 'Key Change'].map(h => (
                      <th key={h} className="text-left pb-2 pr-4 text-text-muted uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { v:'v1', rmse:88.8, r2:0.636, oxr2:'—', note:'Baseline Huber' },
                    { v:'v2', rmse:84.2, r2:0.648, oxr2:'-0.004', note:'EOL-weighted loss' },
                    { v:'v3', rmse:89.1, r2:0.619, oxr2:'-1.118', note:'+ICA/DVA all' },
                    { v:'v3b', rmse:85.9, r2:0.661, oxr2:'-1.118', note:'+Selective ICA' },
                    { v:'v4', rmse:77.6, r2:0.722, oxr2:'—', note:'Ensemble (v2+v3b)' },
                    { v:'v5', rmse:81.8, r2:0.693, oxr2:'-0.917', note:'+MMD NASA align' },
                    { v:'v8 ⚡', rmse:23.95, r2:0.942, oxr2:'-1.447', note:'stride=1+SG+sampler' },
                    { v:'v9', rmse:22.11, r2:0.952, oxr2:'+0.741', note:'+Oxford in train' },
                    { v:'v10-full', rmse:21.49, r2:0.959, oxr2:'+0.887', note:'Clean held-out split' },
                    { v:'v10-final', rmse:20.6, r2:0.910, oxr2:'+0.911', note:'+LFP IC features' },
                  ].map(r => (
                    <tr key={r.v} className={`border-b border-border-subtle/40 ${r.v.includes('⚡') ? 'bg-red-500/5' : ''}`}>
                      <td className="py-2 pr-4 font-mono text-text-accent">{r.v}</td>
                      <td className={`py-2 pr-4 font-mono ${r.v.includes('⚡') ? 'text-red-400 font-bold' : 'text-text-secondary'}`}>{r.rmse}</td>
                      <td className="py-2 pr-4 font-mono text-text-secondary">{r.r2}</td>
                      <td className={`py-2 pr-4 font-mono ${r.oxr2.startsWith('+') ? 'text-emerald-400' : r.oxr2.startsWith('-') ? 'text-red-400' : 'text-text-muted'}`}>{r.oxr2}</td>
                      <td className="py-2 text-text-muted">{r.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  )
}

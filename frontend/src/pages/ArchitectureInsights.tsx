/**
 * ArchitectureInsights.tsx
 * Mamba O(n) vs Transformer O(n²) · PCA embedding space · Per-epoch weight evolution.
 */
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { Cpu, Network, LineChart } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

type TabId = 'complexity' | 'embedding' | 'weights' | 'v5v6'

const CHEM_COLORS: Record<string, string> = { LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#ef4444' }

interface PCAData { x: number[]; y: number[]; chemistry: string[]; rul: number[]; cell_id: string[]; explained_variance: number[] }
interface TrainHistory { [model: string]: { train_loss: number[]; best_epoch: number; best_val_rmse: number; n_params: number } }

export default function ArchitectureInsights() {
  const [tab, setTab] = useState<TabId>('complexity')
  const [pcaData, setPcaData] = useState<PCAData | null>(null)
  const [trainData, setTrainData] = useState<TrainHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [colorBy, setColorBy] = useState<'chemistry'|'rul'>('chemistry')

  useEffect(() => {
    if (tab === 'embedding' && !pcaData) {
      setLoading(true)
      fetch('/api/embedding-pca').then(r => r.ok ? r.json() : null).then(setPcaData).finally(() => setLoading(false))
    } else if (tab === 'weights' && !trainData) {
      setLoading(true)
      fetch('/api/model-training-history').then(r => r.ok ? r.json() : null).then(setTrainData).finally(() => setLoading(false))
    }
  }, [tab])

  // Complexity data
  const seqLens = Array.from({ length: 30 }, (_, i) => (i + 1) * 10)
  const mambaOps = seqLens.map(n => n * 256)         // O(n)
  const transOps = seqLens.map(n => n * n * 256 / 64) // O(n²/heads)

  const MODEL_COLORS: Record<string, string> = { LSTM: '#10b981', GRU: '#06b6d4', Transformer: '#8b5cf6', MambaRUL: '#3b82f6' }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Cpu size={22} className="text-brand-indigo" />
          <h1 className="text-2xl font-bold text-text-primary">Architecture Insights</h1>
        </div>
        <p className="text-text-secondary">Mamba O(n) efficiency · Feature embedding space · Model training dynamics</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {[
          { id: 'complexity' as TabId, label: 'Mamba vs Transformer Complexity', icon: Network },
          { id: 'embedding' as TabId, label: 'Feature Embedding Space (PCA)', icon: LineChart },
          { id: 'weights' as TabId, label: 'Training Dynamics', icon: Cpu },
          { id: 'v5v6' as TabId, label: 'v5 vs v6 Architecture Diff', icon: Cpu },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all border-b-2 -mb-px ${tab === t.id ? 'border-indigo-400 text-indigo-400' : 'border-transparent text-text-secondary hover:text-text-primary'}`}>
            <t.icon size={14} />
            {t.label}
          </button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>

        {/* ── COMPLEXITY ─────────────────────────────────────────────────── */}
        {tab === 'complexity' && (
          <div className="space-y-5">
            <div className="panel p-4 border-indigo-500/20 bg-indigo-500/5">
              <p className="text-sm text-text-secondary">
                <strong className="text-indigo-400">Mamba SSM is O(n) in sequence length</strong>, making it fundamentally more efficient than
                the O(n²) self-attention in Transformers. For battery RUL with 30-cycle windows, the difference is modest —
                but Mamba's <em>selective scan</em> also provides better long-range memory than LSTM recurrence.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-5">
              <div className="panel p-5">
                <h3 className="section-title mb-4">Computational Ops vs Sequence Length</h3>
                <Plot
                  data={[
                    { type: 'scatter', mode: 'lines', name: 'Mamba SSM O(n)', x: seqLens, y: mambaOps, line: { color: '#3b82f6', width: 2.5 } },
                    { type: 'scatter', mode: 'lines', name: 'Transformer O(n²)', x: seqLens, y: transOps, line: { color: '#8b5cf6', width: 2.5 } },
                  ]}
                  layout={{ ...darkLayout, height: 250,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Sequence Length (cycles)', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'Operations (×10³)', font: { color: '#64748b' } } },
                    shapes: [{ type: 'line', x0: 30, x1: 30, y0: 0, y1: Math.max(...transOps), line: { color: '#f59e0b', dash: 'dot', width: 2 } }],
                    annotations: [{ x: 30, y: Math.max(...transOps) * 0.9, text: 'L=30\n(MambaRUL)', font: { color: '#f59e0b', size: 10 }, showarrow: false }],
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              <div className="panel p-5">
                <h3 className="section-title mb-4">Why Mamba Beats LSTM for Battery RUL</h3>
                <div className="space-y-3">
                  {[
                    { title: 'Long-range memory', mamba: 'Selective state: only relevant cycles kept', lstm: 'Vanishing gradients over 30+ steps', color: '#3b82f6' },
                    { title: 'Data efficiency', mamba: 'Parallel training over full sequence', lstm: 'Sequential — slower to train', color: '#10b981' },
                    { title: 'Input gating', mamba: 'B,C,Δ = f(x) — dynamic per-cycle weighting', lstm: 'Fixed forget/input/output gates', color: '#f59e0b' },
                    { title: 'Anchor attention', mamba: 'Cross-attention with degradation regime anchors', lstm: 'No explicit regime conditioning', color: '#8b5cf6' },
                  ].map(r => (
                    <div key={r.title} className="rounded-lg border border-border-subtle overflow-hidden">
                      <div className="px-3 py-1.5 text-xs font-semibold" style={{ backgroundColor: r.color + '22', color: r.color }}>{r.title}</div>
                      <div className="grid grid-cols-2 text-xs">
                        <div className="px-3 py-2 border-r border-border-subtle">
                          <div className="text-blue-400 font-medium mb-0.5">Mamba SSM</div>
                          <div className="text-text-secondary">{r.mamba}</div>
                        </div>
                        <div className="px-3 py-2">
                          <div className="text-text-muted font-medium mb-0.5">LSTM</div>
                          <div className="text-text-muted">{r.lstm}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Complexity table */}
            <div className="panel p-5">
              <h3 className="section-title mb-3">Complexity Comparison</h3>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border-subtle">{['Model','Time Complexity','Space Complexity','Parallelizable','MambaRUL RMSE'].map(h=><th key={h} className="text-left pb-2 pr-4 text-xs text-text-muted uppercase tracking-wider">{h}</th>)}</tr></thead>
                <tbody>
                  {[
                    { model: 'MambaRUL', time: 'O(n·d)', space: 'O(d²)', parallel: '✓ (parallel scan)', rmse: '20.6', color: '#3b82f6' },
                    { model: 'Transformer', time: 'O(n²·d)', space: 'O(n²)', parallel: '✓', rmse: '31.4', color: '#8b5cf6' },
                    { model: 'LSTM', time: 'O(n·d²)', space: 'O(d)', parallel: '✗ (sequential)', rmse: '38.7', color: '#10b981' },
                    { model: 'GRU', time: 'O(n·d²)', space: 'O(d)', parallel: '✗ (sequential)', rmse: '35.2', color: '#06b6d4' },
                  ].map(r => (
                    <tr key={r.model} className="border-b border-border-subtle/40">
                      <td className="py-2.5 pr-4 font-semibold" style={{ color: r.color }}>{r.model}</td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-text-secondary">{r.time}</td>
                      <td className="py-2.5 pr-4 font-mono text-xs text-text-secondary">{r.space}</td>
                      <td className="py-2.5 pr-4 text-xs" style={{ color: r.parallel.startsWith('✓') ? '#10b981' : '#ef4444' }}>{r.parallel}</td>
                      <td className="py-2.5 font-mono text-text-accent">{r.rmse}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── EMBEDDING SPACE ─────────────────────────────────────────────── */}
        {tab === 'embedding' && (
          loading ? <SkeletonChart height={450} /> : pcaData ? (
            <div className="space-y-5">
              <div className="panel p-4 border-cyan-500/20 bg-cyan-500/5">
                <p className="text-sm text-text-secondary">
                  <strong className="text-cyan-400">PCA of 9 raw input features</strong> projected to 2D
                  (explains {((pcaData.explained_variance[0] + pcaData.explained_variance[1]) * 100).toFixed(1)}% of variance).
                  Colors show how MambaRUL's input space clusters by chemistry and SOH before any model processing.
                  PC1 ({(pcaData.explained_variance[0]*100).toFixed(1)}%) separates chemistry families; PC2 ({(pcaData.explained_variance[1]*100).toFixed(1)}%) tracks degradation level.
                </p>
              </div>

              <div className="flex gap-2 mb-3">
                {(['chemistry','rul'] as const).map(c => (
                  <button key={c} onClick={() => setColorBy(c)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all capitalize ${colorBy === c ? 'border-cyan-500/40 text-cyan-400 bg-cyan-500/10' : 'border-border-subtle text-text-muted'}`}>
                    Color by: {c === 'rul' ? 'RUL (cycles)' : 'Chemistry'}
                  </button>
                ))}
              </div>

              <div className="panel p-5">
                <h3 className="section-title mb-4">Feature Space — PCA Projection (3000 samples)</h3>
                {colorBy === 'chemistry' ? (
                  <Plot
                    data={['LCO','LFP','NMC','NCM','NCA'].map(chem => {
                      const idx = pcaData.chemistry.map((c, i) => c === chem ? i : -1).filter(i => i >= 0)
                      return {
                        type: 'scatter' as const, mode: 'markers' as const, name: chem,
                        x: idx.map(i => pcaData.x[i]), y: idx.map(i => pcaData.y[i]),
                        marker: { color: CHEM_COLORS[chem], size: 4, opacity: 0.6 },
                      }
                    })}
                    layout={{ ...darkLayout, height: 420,
                      xaxis: { ...darkLayout.xaxis as object, title: { text: `PC1 (${(pcaData.explained_variance[0]*100).toFixed(1)}% var)`, font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: `PC2 (${(pcaData.explained_variance[1]*100).toFixed(1)}% var)`, font: { color: '#64748b' } } },
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                ) : (
                  <Plot
                    data={[{
                      type: 'scatter', mode: 'markers',
                      x: pcaData.x, y: pcaData.y,
                      marker: {
                        color: pcaData.rul, colorscale: 'Viridis', size: 4, opacity: 0.7,
                        colorbar: { title: { text: 'RUL (cycles)', font: { color: '#94a3b8' } }, tickfont: { color: '#64748b', size: 9 }, thickness: 14 },
                      },
                    }]}
                    layout={{ ...darkLayout, height: 420,
                      xaxis: { ...darkLayout.xaxis as object, title: { text: `PC1`, font: { color: '#64748b' } } },
                      yaxis: { ...darkLayout.yaxis as object, title: { text: `PC2`, font: { color: '#64748b' } } },
                    } as Plotly.Layout}
                    config={plotConfig} style={{ width: '100%' }}
                  />
                )}
              </div>

              <div className="panel p-4">
                <p className="text-xs text-text-secondary">
                  PC1 primarily captures <strong className="text-cyan-400">chemistry type</strong> (LFP clusters far left — flat voltage).
                  PC2 captures <strong className="text-cyan-400">degradation level</strong> (fresh cells cluster top, aged cells bottom).
                  MambaRUL's encoder learns a richer non-linear version of this in 256 dimensions.
                </p>
              </div>
            </div>
          ) : <div className="panel p-12 text-center text-text-muted">Failed to load PCA data</div>
        )}

        {/* ── TRAINING DYNAMICS ───────────────────────────────────────────── */}
        {tab === 'weights' && (
          loading ? <SkeletonChart /> : trainData ? (
            <div className="space-y-5">
              <div className="panel p-4 border-purple-500/20 bg-purple-500/5">
                <p className="text-sm text-text-secondary">
                  Per-epoch training loss from real experiment logs. MambaRUL converges in ~32 epochs with exponential decay.
                  LSTM and GRU converge faster but to worse minima. Transformer converges slower.
                </p>
              </div>

              <div className="panel p-5">
                <h3 className="section-title mb-4">Training Loss Convergence — All Models</h3>
                <Plot
                  data={Object.entries(trainData).map(([name, d]) => ({
                    type: 'scatter' as const, mode: 'lines' as const, name,
                    x: Array.from({ length: d.train_loss.length }, (_, i) => i + 1),
                    y: d.train_loss,
                    line: { color: MODEL_COLORS[name] ?? '#94a3b8', width: name === 'MambaRUL' ? 2.5 : 1.5 },
                  }))}
                  layout={{ ...darkLayout, height: 300,
                    xaxis: { ...darkLayout.xaxis as object, title: { text: 'Epoch', font: { color: '#64748b' } } },
                    yaxis: { ...darkLayout.yaxis as object, title: { text: 'Train Loss (Huber)', font: { color: '#64748b' } }, type: 'log' },
                  } as Plotly.Layout}
                  config={plotConfig} style={{ width: '100%' }}
                />
              </div>

              <div className="grid grid-cols-4 gap-3">
                {Object.entries(trainData).map(([name, d]) => (
                  <div key={name} className="panel p-4 text-center" style={{ borderColor: (MODEL_COLORS[name] ?? '#94a3b8') + '33' }}>
                    <div className="text-sm font-bold mb-2" style={{ color: MODEL_COLORS[name] ?? '#94a3b8' }}>{name}</div>
                    <div className="text-xs text-text-muted">Best Epoch</div>
                    <div className="font-mono font-bold text-lg text-text-accent">{d.best_epoch}</div>
                    <div className="text-xs text-text-muted mt-1">Best Val RMSE</div>
                    <div className="font-mono font-bold text-sm text-text-accent">{d.best_val_rmse.toFixed(1)}</div>
                    <div className="text-xs text-text-muted mt-1">Params</div>
                    <div className="font-mono text-xs text-text-secondary">{(d.n_params / 1000).toFixed(0)}K</div>
                    <div className="text-xs text-text-muted mt-1">Final Loss</div>
                    <div className="font-mono text-xs text-emerald-400">{(d.train_loss[d.train_loss.length - 1] ?? 0).toFixed(6)}</div>
                  </div>
                ))}
              </div>

              <div className="panel p-5">
                <h3 className="section-title mb-3">MLP Head Weight Evolution (simulated)</h3>
                <p className="text-xs text-text-muted mb-3">
                  Weight matrix of the final Linear(64→1) layer colored by magnitude. Initialized near zero, grows as training progresses.
                </p>
                <div className="grid grid-cols-8 gap-1">
                  {Array.from({ length: 64 }, (_, i) => {
                    const bestEp = trainData['MambaRUL']?.best_epoch ?? 32
                    const w = Math.sin(i * 0.4) * 0.15 + Math.cos(i * 0.7) * 0.1
                    const mag = Math.abs(w) * (1 - Math.exp(-bestEp / 15))
                    const positive = w > 0
                    return (
                      <div key={i} className="rounded-sm h-5"
                        style={{ backgroundColor: positive ? `rgba(59,130,246,${Math.min(1, mag * 4)})` : `rgba(239,68,68,${Math.min(1, mag * 4)})` }}
                        title={`W[${i}] = ${w.toFixed(3)}`} />
                    )
                  })}
                </div>
                <div className="flex justify-between text-xs text-text-muted mt-1">
                  <span className="text-blue-400">■ positive weights</span>
                  <span className="text-red-400">■ negative weights</span>
                </div>
              </div>
            </div>
          ) : <div className="panel p-12 text-center text-text-muted">Loading training history…</div>
        )}

        {/* ── v5 vs v6 ARCHITECTURE DIFF ─────────────────────────────────────── */}
        {tab === 'v5v6' && (
          <div className="space-y-5">
            <div className="panel p-4 border-purple-500/20 bg-purple-500/5">
              <p className="text-sm text-text-secondary">
                v5 = best evaluated model (500K params, R²=0.668 with TTA). v6 = larger model designed for better generalisation
                (14.7M params, gradient checkpointing + 8-bit AdamW). Training was paused before completion due to compute constraints.
              </p>
            </div>

            {/* Side-by-side comparison */}
            <div className="grid grid-cols-2 gap-4">
              {[
                {
                  label: 'v5 — TCNMambaRUL (evaluated)', color: '#3b82f6',
                  params: '500K', mambaDim: 128, nMamba: 3, tcnChannels: 64, status: '✓ Fully trained & evaluated',
                  r2: 0.668, note: 'Best result with TTA (80 calib + 30 steps)',
                },
                {
                  label: 'v6 — TCNMambaRULv6 (future)', color: '#8b5cf6',
                  params: '14.7M', mambaDim: 512, nMamba: 6, tcnChannels: 256, status: '⏸ Training paused (compute limit)',
                  r2: null, note: 'Gradient checkpointing + 8-bit AdamW + AMP FP16',
                },
              ].map(v => (
                <div key={v.label} className="panel p-5" style={{ borderColor: v.color + '44' }}>
                  <h3 className="text-sm font-bold mb-3" style={{ color: v.color }}>{v.label}</h3>
                  <div className="space-y-2">
                    {[
                      ['Parameters', v.params],
                      ['Mamba dim', `${v.mambaDim}`],
                      ['Mamba blocks', `${v.nMamba}`],
                      ['TCN channels', `${v.tcnChannels}`],
                      ['TCN dilations', '[1, 2, 4, 8]'],
                      ['Input features', '13 per cycle'],
                      ['Window size', '30 cycles'],
                      ['Status', v.status],
                    ].map(([k, val]) => (
                      <div key={k} className="flex items-center justify-between text-xs">
                        <span className="text-text-muted">{k}</span>
                        <span className="font-mono font-bold text-text-primary">{val}</span>
                      </div>
                    ))}
                  </div>
                  {v.r2 !== null && (
                    <div className="mt-4 pt-3 border-t border-border-subtle">
                      <div className="text-xs text-text-muted mb-1">Best R² (with TTA)</div>
                      <div className="font-mono text-2xl font-bold" style={{ color: v.color }}>{v.r2}</div>
                    </div>
                  )}
                  <div className="mt-3 text-xs text-text-muted italic">{v.note}</div>
                </div>
              ))}
            </div>

            {/* Architecture layers comparison */}
            <div className="panel p-5">
              <h3 className="section-title mb-4">Layer-by-Layer Expansion: v5 → v6</h3>
              <div className="space-y-3">
                {[
                  { layer: 'Input', v5: '30×13', v6: '30×13', changed: false },
                  { layer: 'TCN Layer 1 (d=1)', v5: 'channels=64', v6: 'channels=256', changed: true },
                  { layer: 'TCN Layer 2 (d=2)', v5: 'channels=64', v6: 'channels=256', changed: true },
                  { layer: 'TCN Layer 3 (d=4)', v5: 'channels=64', v6: 'channels=256', changed: true },
                  { layer: 'TCN Layer 4 (d=8)', v5: 'channels=64', v6: 'channels=256', changed: true },
                  { layer: 'Mamba Block ×3', v5: 'd_model=128, n=3', v6: 'd_model=512, n=6', changed: true },
                  { layer: 'Chemistry Embed', v5: '4-class one-hot', v6: '4-class one-hot', changed: false },
                  { layer: 'Linear Head', v5: '128→64→1', v6: '512→128→1', changed: true },
                  { layer: 'Total Params', v5: '~500K', v6: '~14.7M', changed: true },
                ].map(row => (
                  <div key={row.layer} className={`flex items-center gap-3 px-3 py-2 rounded-lg text-xs ${row.changed ? 'bg-purple-500/8 border border-purple-500/20' : 'bg-bg-elevated'}`}>
                    <span className="text-text-muted w-40 shrink-0">{row.layer}</span>
                    <span className="font-mono text-blue-400 flex-1">{row.v5}</span>
                    <span className="text-text-muted mx-2">→</span>
                    <span className={`font-mono flex-1 ${row.changed ? 'text-purple-400 font-bold' : 'text-text-muted'}`}>{row.v6}</span>
                    {row.changed && <span className="text-purple-400 text-xs">↑ expanded</span>}
                  </div>
                ))}
              </div>
            </div>

            {/* Param count visual */}
            <div className="panel p-5">
              <h3 className="section-title mb-3">Parameter Count (log scale)</h3>
              <div className="space-y-3">
                {[
                  { label: 'GRU baseline', params: 145000, color: '#06b6d4' },
                  { label: 'LSTM baseline', params: 180000, color: '#10b981' },
                  { label: 'Transformer baseline', params: 320000, color: '#f59e0b' },
                  { label: 'v5 TCNMambaRUL', params: 500000, color: '#3b82f6' },
                  { label: 'v6 TCNMambaRULv6', params: 14700000, color: '#8b5cf6' },
                ].map(({ label, params, color }) => {
                  const maxLog = Math.log10(14700000)
                  const pct = (Math.log10(params) / maxLog) * 100
                  return (
                    <div key={label} className="flex items-center gap-3">
                      <span className="text-xs text-text-muted w-40 shrink-0">{label}</span>
                      <div className="flex-1 h-5 bg-bg-elevated rounded overflow-hidden">
                        <motion.div className="h-full rounded" style={{ backgroundColor: color }}
                          initial={{ width: 0 }} animate={{ width: `${pct}%` }}
                          transition={{ duration: 0.8, delay: 0.1 }} />
                      </div>
                      <span className="font-mono text-xs w-16 text-right" style={{ color }}>
                        {params >= 1000000 ? `${(params/1000000).toFixed(1)}M` : `${(params/1000).toFixed(0)}K`}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </motion.div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { BarChart3, TrendingUp } from 'lucide-react'
import Plot from 'react-plotly.js'
import { SkeletonChart } from '../components/ui/Skeleton'

const darkLayout = {
  paper_bgcolor: 'transparent',
  plot_bgcolor: 'transparent',
  font: { color: '#94a3b8', size: 11 },
  xaxis: { gridcolor: '#1e3a5f', zerolinecolor: '#1e3a5f' },
  yaxis: { gridcolor: '#1e3a5f', zerolinecolor: '#1e3a5f' },
  legend: { font: { color: '#94a3b8', size: 11 }, bgcolor: 'transparent' },
}
const cfg = { displayModeBar: false as const, responsive: true }

// Colour palette assigned by index (API doesn't return colours)
const MODEL_COLORS = ['#3b82f6', '#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444']
const CHEM_COLORS  = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4']

// ── API shape types ───────────────────────────────────────────────────────────
interface ApiBenchmark {
  model: string; family: string
  rmse: number; mae: number; r2: number; params: number
  chemistry: string; notes: string
}
interface ApiChemistry {
  chemistry: string; dataset: string
  rmse: number; mae: number | null; r2: number; rmse_pct: number; notes: string
}
interface ApiVersionLadder {
  version: string; label: string; description: string
  rmse: number; r2: number; mae: number | null; notes: string
}
interface ApiKsweep {
  k: number; label: string
  cell7_r2: number; cell8_r2: number; combined_r2: number; notes: string
}
interface ApiOxford {
  combined_r2: number; combined_rmse: number; rmse_pct: number
  cell7: { r2: number; rmse: number; notes: string }
  cell8: { r2: number; rmse: number | null; notes: string }
  ksweep: ApiKsweep[]
  key_finding: string
}

const TABS = ['Model Comparison', 'Version Ladder', 'Chemistry Analysis', 'Oxford Transfer', 'K-Sweep']

export default function BenchmarkDashboard() {
  const [tab, setTab] = useState(0)
  const [loading, setLoading] = useState(true)

  // State for each dataset
  const [models, setModels]             = useState<ApiBenchmark[]>([])
  const [chemResults, setChemResults]   = useState<ApiChemistry[]>([])
  const [versionLadder, setVersionLadder] = useState<ApiVersionLadder[]>([])
  const [oxford, setOxford]             = useState<ApiOxford | null>(null)
  const [ksweep, setKsweep]             = useState<ApiKsweep[]>([])

  useEffect(() => {
    const base = '/api'
    Promise.all([
      fetch(`${base}/results/benchmark`).then(r => r.json()),
      fetch(`${base}/results/chemistry`).then(r => r.json()),
      fetch(`${base}/results/version-ladder`).then(r => r.json()),
      fetch(`${base}/results/oxford`).then(r => r.json()),
      fetch(`${base}/results/ksweep`).then(r => r.json()),
    ])
      .then(([bench, chem, ladder, oxf, ks]) => {
        setModels(bench)
        setChemResults(chem)
        setVersionLadder(ladder)
        setOxford(oxf)
        setKsweep(ks)
        setLoading(false)
      })
      .catch(err => {
        console.error('BenchmarkDashboard fetch error:', err)
        setLoading(false)
      })
  }, [])

  // ── Derived display helpers ──────────────────────────────────────────────────

  // Decide if a version is a breakthrough (v8 has RMSE drop from ~85 to ~24)
  const isBreakthrough = (v: ApiVersionLadder) => v.version === 'v8'

  // Model family label (API returns it directly as `family`)
  const familyLabel = (m: ApiBenchmark, i: number) =>
    m.family ?? (i === 0 ? 'Mamba SSM' : i === 1 ? 'Attention' : 'RNN')

  // Chemistry display name: combine chemistry + dataset abbreviation
  const chemLabel = (c: ApiChemistry) => {
    const dsMap: Record<string, string> = {
      CALCE: 'CALCE-LCO', MIT: 'MIT-LFP', KJTU: 'KJTU-NMC', TJU: 'TJU-NCM', Oxford: 'Oxford-NMC',
    }
    return dsMap[c.dataset] ?? `${c.dataset}-${c.chemistry}`
  }

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <BarChart3 size={22} className="text-brand-blue" />
          <h1 className="text-2xl font-bold text-text-primary">Benchmark Comparison Dashboard</h1>
        </div>
        <p className="text-text-secondary">Complete performance analysis across models, chemistries, and deployment scenarios</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border-subtle">
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => setTab(i)}
            className={`px-4 py-2.5 text-sm font-medium transition-all duration-150 border-b-2 -mb-px ${
              tab === i ? 'border-brand-blue text-brand-blue' : 'border-transparent text-text-secondary hover:text-text-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }}>

        {/* Tab 0: Model comparison */}
        {tab === 0 && (
          loading ? (
            <div className="space-y-6">
              <SkeletonChart height={280} />
              <SkeletonChart height={200} />
            </div>
          ) : (
          <div className="space-y-6">
            <div className="panel p-6">
              <h2 className="section-title mb-4">RMSE Comparison — CALCE Test (CS2_37, CS2_38)</h2>
              <Plot
                data={[{
                  type: 'bar',
                  x: models.map(m => m.model),
                  y: models.map(m => m.rmse),
                  marker: { color: models.map((_, i) => MODEL_COLORS[i % MODEL_COLORS.length]) },
                  text: models.map(m => `${m.rmse}`),
                  textposition: 'outside',
                  name: 'RMSE (cycles)',
                }]}
                layout={{
                  ...darkLayout,
                  height: 280,
                  margin: { t: 10, b: 80, l: 60, r: 20 },
                  yaxis: { ...darkLayout.yaxis, title: { text: 'RMSE (cycles, lower=better)', font: { color: '#64748b' } } },
                  xaxis: { ...darkLayout.xaxis, tickangle: -15 },
                }}
                config={cfg}
                style={{ width: '100%' }}
              />
            </div>

            <div className="panel p-6">
              <h2 className="section-title mb-4">Full Results Table</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-subtle">
                    {['Model', 'Family', 'RMSE', 'MAE', 'R²', 'Params', 'Rank'].map(h => (
                      <th key={h} className="text-left pb-3 pr-6 text-xs text-text-muted uppercase tracking-wider font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {models.map((m, i) => {
                    const color = MODEL_COLORS[i % MODEL_COLORS.length]
                    const paramsMB = m.params >= 1_000_000
                      ? `${(m.params / 1_000_000).toFixed(2)}M`
                      : `${(m.params / 1_000).toFixed(0)}K`
                    return (
                      <tr key={m.model} className="border-b border-border-subtle/40 hover:bg-bg-elevated/40">
                        <td className="py-3 pr-6">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                            <span className={`font-medium ${i === 0 ? 'text-text-accent' : 'text-text-primary'}`}>{m.model}</span>
                            {i === 0 && <span className="badge badge-blue text-xs">PRIMARY</span>}
                          </div>
                        </td>
                        <td className="py-3 pr-6 text-text-secondary text-xs">{familyLabel(m, i)}</td>
                        <td className="py-3 pr-6 font-mono text-text-accent">{m.rmse}</td>
                        <td className="py-3 pr-6 font-mono text-text-secondary">{m.mae ?? '—'}</td>
                        <td className="py-3 pr-6 font-mono">{m.r2.toFixed(3)}</td>
                        <td className="py-3 pr-6 font-mono text-text-secondary">{paramsMB}</td>
                        <td className="py-3">
                          <span className={`badge ${i === 0 ? 'badge-green' : i < 2 ? 'badge-blue' : 'badge-purple'}`}>#{i + 1}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          )
        )}

        {/* Tab 1: Version ladder */}
        {tab === 1 && (
          loading ? (
            <div className="space-y-6">
              <SkeletonChart height={300} />
              <SkeletonChart height={220} />
            </div>
          ) : (
          <div className="space-y-6">
            <div className="panel p-6">
              <h2 className="section-title mb-1">Model Version Progression</h2>
              <p className="text-xs text-text-muted mb-4">CALCE test RMSE across versions. v8 breakthrough: stride=1 + SG smoothing + balanced sampling → 26× more training windows.</p>
              <Plot
                data={[
                  {
                    type: 'scatter', mode: 'lines+markers',
                    x: versionLadder.map(v => v.version),
                    y: versionLadder.map(v => v.rmse),
                    name: 'RMSE', line: { color: '#3b82f6', width: 2 },
                    marker: {
                      color: versionLadder.map(v => isBreakthrough(v) ? '#ef4444' : '#3b82f6'),
                      size: versionLadder.map(v => isBreakthrough(v) ? 12 : 7),
                    },
                  },
                  {
                    type: 'scatter', mode: 'lines+markers',
                    x: versionLadder.map(v => v.version),
                    y: versionLadder.map(v => v.r2 * 100),
                    name: 'R² × 100', yaxis: 'y2',
                    line: { color: '#10b981', width: 2, dash: 'dash' },
                    marker: { color: '#10b981', size: 7 },
                  },
                ]}
                layout={{
                  ...darkLayout,
                  height: 300,
                  margin: { t: 30, b: 60, l: 60, r: 60 },
                  yaxis: { ...darkLayout.yaxis, title: { text: 'RMSE (cycles)', font: { color: '#3b82f6' } } },
                  yaxis2: { title: { text: 'R² × 100', font: { color: '#10b981' } }, overlaying: 'y', side: 'right', gridcolor: 'transparent', zerolinecolor: '#1e3a5f' },
                  annotations: [
                    { x: 'v8', y: 23.95, text: '⚡ Breakthrough', showarrow: true, arrowhead: 2, arrowcolor: '#ef4444', font: { color: '#ef4444', size: 11 }, ax: 30, ay: -30 },
                    { x: 'v9', y: 22.11, text: '+Oxford train', showarrow: true, arrowhead: 2, arrowcolor: '#f59e0b', font: { color: '#f59e0b', size: 10 }, ax: -40, ay: -25 },
                  ],
                }}
                config={cfg}
                style={{ width: '100%' }}
              />
            </div>
            <div className="panel p-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-subtle">
                    {['Version', 'RMSE', 'R²', 'Method / Change'].map(h => (
                      <th key={h} className="text-left pb-3 pr-6 text-xs text-text-muted uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {versionLadder.map(v => {
                    const bt = isBreakthrough(v)
                    return (
                      <tr key={v.version} className={`border-b border-border-subtle/40 ${bt ? 'bg-red-500/5' : ''}`}>
                        <td className="py-2.5 pr-6 font-mono text-text-accent">{v.version}</td>
                        <td className={`py-2.5 pr-6 font-mono ${bt ? 'text-red-400 font-bold' : 'text-text-secondary'}`}>{v.rmse}</td>
                        <td className="py-2.5 pr-6 font-mono text-text-secondary">{v.r2.toFixed(3)}</td>
                        <td className="py-2.5 text-xs text-text-secondary">
                          {bt && <span className="badge badge-red mr-2">BREAKTHROUGH</span>}
                          {v.notes}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
          )
        )}

        {/* Tab 2: Chemistry */}
        {tab === 2 && (
          loading ? (
            <div className="space-y-6">
              <SkeletonChart height={260} />
              <SkeletonChart height={220} />
            </div>
          ) : (
          <div className="space-y-6">
            <div className="panel p-6">
              <h2 className="section-title mb-4">Per-Chemistry Results — MambaRUL v10-final</h2>
              <Plot
                data={[
                  {
                    type: 'bar', name: 'RMSE%',
                    x: chemResults.map(c => chemLabel(c)),
                    y: chemResults.map(c => c.rmse_pct),
                    marker: { color: chemResults.map((_, i) => CHEM_COLORS[i % CHEM_COLORS.length]) },
                    text: chemResults.map(c => `${c.rmse_pct}%`),
                    textposition: 'outside',
                  },
                ]}
                layout={{
                  ...darkLayout,
                  height: 260,
                  margin: { t: 10, b: 60, l: 60, r: 20 },
                  yaxis: { ...darkLayout.yaxis, title: { text: 'RMSE% (normalized)', font: { color: '#64748b' } } },
                  shapes: [{ type: 'line', x0: -0.5, x1: 4.5, y0: 10, y1: 10, line: { color: '#ef4444', width: 1, dash: 'dot' } }],
                  annotations: [{ x: 4.5, y: 10, xanchor: 'right', text: '10% threshold', font: { color: '#ef4444', size: 10 }, showarrow: false }],
                }}
                config={cfg}
                style={{ width: '100%' }}
              />
            </div>
            <div className="panel p-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-subtle">
                    {['Chemistry', 'Dataset', 'RMSE (cycles)', 'R²', 'RMSE%', 'Assessment'].map(h => (
                      <th key={h} className="text-left pb-3 pr-4 text-xs text-text-muted uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {chemResults.map((c, i) => {
                    const color = CHEM_COLORS[i % CHEM_COLORS.length]
                    return (
                      <tr key={`${c.chemistry}-${c.dataset}`} className="border-b border-border-subtle/40">
                        <td className="py-3 pr-4">
                          <div className="flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                            <span className="font-medium text-text-primary">{c.chemistry}</span>
                          </div>
                        </td>
                        <td className="py-3 pr-4 text-text-secondary text-xs">{c.dataset}</td>
                        <td className="py-3 pr-4 font-mono text-text-accent">{c.rmse}</td>
                        <td className="py-3 pr-4 font-mono" style={{ color: c.r2 > 0.8 ? '#10b981' : c.r2 > 0.5 ? '#f59e0b' : '#ef4444' }}>{c.r2.toFixed(3)}</td>
                        <td className="py-3 pr-4 font-mono text-text-secondary">{c.rmse_pct}%</td>
                        <td className="py-3">
                          <span className={`badge text-xs ${c.rmse_pct < 10 ? 'badge-green' : c.rmse_pct < 15 ? 'badge-amber' : 'badge-red'}`}>
                            {c.rmse_pct < 10 ? 'Excellent' : c.rmse_pct < 15 ? 'Good' : 'Challenging'}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              <p className="text-xs text-text-muted mt-3">MIT-LFP challenge: LFP flat voltage plateau (ΔOCV≈50mV vs 500mV for NMC/LCO) makes voltage-based features less discriminative.</p>
            </div>
          </div>
          )
        )}

        {/* Tab 3: Oxford */}
        {tab === 3 && (
          loading || !oxford ? (
            <div className="space-y-6">
              <SkeletonChart height={120} />
              <SkeletonChart height={200} />
            </div>
          ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: 'Zero-Shot R²', value: oxford.combined_r2.toFixed(3), sub: 'K=0, no adaptation', color: 'cyan' },
                { label: 'Best K-Sweep R²', value: Math.max(...oxford.ksweep.map(k => k.combined_r2)).toFixed(3), sub: 'K=20, B1+D fine-tune', color: 'blue' },
                { label: 'Cell7 R²', value: oxford.cell7.r2.toFixed(3), sub: 'Best individual cell', color: 'emerald' },
              ].map(s => (
                <div key={s.label} className={`panel p-5 text-center border-${s.color}-500/20 bg-${s.color}-500/5`}>
                  <div className="text-3xl font-mono font-bold text-text-accent mb-1">{s.value}</div>
                  <div className="text-sm font-semibold text-text-primary">{s.label}</div>
                  <div className="text-xs text-text-muted">{s.sub}</div>
                </div>
              ))}
            </div>
            <div className="panel p-6">
              <h2 className="section-title mb-4">Oxford Cell7 & Cell8 — Zero-Shot RUL Prediction</h2>
              <p className="text-xs text-text-muted mb-4">8000-cycle Oxford NMC cells. Model trained on Cell1–6, evaluated on Cell7–8 without any fine-tuning.</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-subtle">
                    {['Cell', 'RMSE (cycles)', 'R²', 'RMSE%'].map(h => (
                      <th key={h} className="text-left pb-3 pr-6 text-xs text-text-muted uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[
                    { cell: 'Cell_7', rmse: oxford.cell7.rmse, r2: oxford.cell7.r2, pct: null },
                    { cell: 'Cell_8', rmse: oxford.cell8.rmse, r2: oxford.cell8.r2, pct: null },
                    { cell: 'Combined', rmse: oxford.combined_rmse, r2: oxford.combined_r2, pct: oxford.rmse_pct },
                  ].map(r => (
                    <tr key={r.cell} className={`border-b border-border-subtle/40 ${r.cell === 'Combined' ? 'bg-bg-elevated/50 font-medium' : ''}`}>
                      <td className="py-3 pr-6 font-mono text-text-accent">{r.cell}</td>
                      <td className="py-3 pr-6 font-mono text-text-secondary">{r.rmse ?? '—'}</td>
                      <td className="py-3 pr-6 font-mono text-emerald-400 font-semibold">{r.r2.toFixed(3)}</td>
                      <td className="py-3 font-mono text-text-secondary">{r.pct != null ? `${r.pct}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )
        )}

        {/* Tab 4: K-sweep */}
        {tab === 4 && (
          loading ? (
            <div className="space-y-6">
              <SkeletonChart height={280} />
              <SkeletonChart height={220} />
            </div>
          ) : (
          <div className="space-y-6">
            <div className="panel p-6">
              <h2 className="section-title mb-1">K-Sweep Deployment Curve</h2>
              <p className="text-xs text-text-muted mb-4">B1+D fine-tuning: freeze encoder, retrain only MLP head (8,321 params) on first K snapshots.</p>
              <Plot
                data={[
                  { type: 'scatter', mode: 'lines+markers', name: 'Combined R²', x: ksweep.map(k => k.k), y: ksweep.map(k => k.combined_r2), line: { color: '#3b82f6', width: 2.5 }, marker: { color: '#3b82f6', size: 9 } },
                  { type: 'scatter', mode: 'lines+markers', name: 'Cell7 R²', x: ksweep.map(k => k.k), y: ksweep.map(k => k.cell7_r2), line: { color: '#10b981', width: 1.5, dash: 'dash' }, marker: { color: '#10b981', size: 6 } },
                  { type: 'scatter', mode: 'lines+markers', name: 'Cell8 R²', x: ksweep.map(k => k.k), y: ksweep.map(k => k.cell8_r2), line: { color: '#f59e0b', width: 1.5, dash: 'dash' }, marker: { color: '#f59e0b', size: 6 } },
                ]}
                layout={{
                  ...darkLayout,
                  height: 280,
                  margin: { t: 20, b: 50, l: 60, r: 20 },
                  xaxis: { ...darkLayout.xaxis, title: { text: 'K (calibration snapshots)', font: { color: '#64748b' } } },
                  yaxis: { ...darkLayout.yaxis, title: { text: 'R²', font: { color: '#64748b' } }, range: [0.5, 1] },
                  annotations: [
                    { x: 0, y: 0.911, text: 'Zero-shot', showarrow: true, arrowhead: 2, arrowcolor: '#06b6d4', font: { color: '#06b6d4', size: 10 }, ax: 40, ay: 20 },
                    { x: 20, y: 0.917, text: 'K=20 Optimal', showarrow: true, arrowhead: 2, arrowcolor: '#3b82f6', font: { color: '#3b82f6', size: 10 }, ax: -30, ay: -30 },
                  ],
                }}
                config={cfg}
                style={{ width: '100%' }}
              />
            </div>
            <div className="panel p-6">
              <h2 className="section-title mb-3 flex items-center gap-2"><TrendingUp size={16} /> B1+D Fine-Tuning</h2>
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="bg-bg-elevated rounded-lg p-4 border border-border-subtle">
                  <div className="text-xs text-text-muted mb-2 uppercase tracking-wider">Frozen Parameters</div>
                  <div className="font-mono text-xs text-text-secondary space-y-1">
                    <div>Mamba SSM blocks ×4</div>
                    <div>Anchor attention</div>
                    <div>Input embedding</div>
                    <div>Positional encoding</div>
                  </div>
                </div>
                <div className="bg-bg-elevated rounded-lg p-4 border border-border-subtle">
                  <div className="text-xs text-text-muted mb-2 uppercase tracking-wider">Trainable (B1+D)</div>
                  <div className="font-mono text-xs text-text-secondary space-y-1">
                    <div>MLP head only</div>
                    <div>8,321 parameters</div>
                    <div>Linear(256→64)→ReLU→Linear(64→1)</div>
                  </div>
                </div>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-subtle">
                    {['K', 'Label', 'Cell7 R²', 'Cell8 R²', 'Combined R²'].map(h => (
                      <th key={h} className="text-left pb-2 pr-4 text-xs text-text-muted uppercase">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ksweep.map(k => (
                    <tr key={k.k} className={`border-b border-border-subtle/40 ${k.combined_r2 === 0.917 ? 'bg-blue-500/5' : ''}`}>
                      <td className="py-2 pr-4 font-mono text-text-accent">{k.k}</td>
                      <td className="py-2 pr-4 text-xs text-text-secondary">{k.label}</td>
                      <td className="py-2 pr-4 font-mono text-text-secondary">{k.cell7_r2.toFixed(3)}</td>
                      <td className="py-2 pr-4 font-mono text-text-secondary">{k.cell8_r2.toFixed(3)}</td>
                      <td className="py-2 font-mono font-semibold" style={{ color: k.k === 20 ? '#3b82f6' : '#94a3b8' }}>
                        {k.combined_r2.toFixed(3)}{k.k === 20 && ' ★'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          )
        )}
      </motion.div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { BarChart3, FlaskRound, RefreshCw, FileText, AlertTriangle, CheckCircle } from 'lucide-react'

interface Imp {
  id: string
  imported_at: string
  filename: string
  format: string
  n_cycles: number
  n_rows: number
  nominal_capacity_ah: number
  soh_initial: number | null
  soh_final: number | null
  fade_rate_pct_per_cycle: number | null
}
interface Summary {
  n_imports: number
  mean_fade: number | null
  median_fade: number | null
  min_fade: number | null
  max_fade: number | null
  stdev_fade: number | null
}

const FMT_LABEL: Record<string, string> = {
  arbin: 'Arbin', maccor: 'Maccor', neware: 'Neware', biologic: 'BioLogic', generic: 'Generic',
}

function FadeHistogram({ values, mean }: { values: number[]; mean: number | null }) {
  if (!values.length) return null
  const W = 560, H = 130, PAD = { l: 36, r: 12, t: 8, b: 28 }
  const lo = Math.min(...values), hi = Math.max(...values)
  const span = hi - lo || 1e-6
  const nb = Math.min(20, Math.max(5, Math.floor(Math.sqrt(values.length) * 2)))
  const bins = new Array(nb).fill(0)
  for (const v of values) {
    const k = Math.min(nb - 1, Math.floor(((v - lo) / span) * nb))
    bins[k]++
  }
  const maxB = Math.max(...bins, 1)
  const bw = (W - PAD.l - PAD.r) / nb
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-32">
      {bins.map((b, i) => {
        const h = (b / maxB) * (H - PAD.t - PAD.b)
        const x = PAD.l + i * bw
        const y = H - PAD.b - h
        return <rect key={i} x={x} y={y} width={bw - 1.5} height={h} fill="#60a5fa" opacity="0.7" />
      })}
      {mean != null && (() => {
        const mx = PAD.l + ((mean - lo) / span) * (W - PAD.l - PAD.r)
        return (
          <g>
            <line x1={mx} x2={mx} y1={PAD.t} y2={H - PAD.b} stroke="#f59e0b" strokeWidth="1.5" strokeDasharray="4,3" />
            <text x={mx + 4} y={PAD.t + 9} fill="#f59e0b" fontSize="9">mean {mean.toFixed(4)}</text>
          </g>
        )
      })()}
      <text x={PAD.l} y={H - 6} fill="#6b7280" fontSize="9">{lo.toFixed(4)}</text>
      <text x={W - PAD.r} y={H - 6} fill="#6b7280" fontSize="9" textAnchor="end">{hi.toFixed(4)}</text>
      <text x={(PAD.l + W - PAD.r) / 2} y={H - 2} fill="#4b5563" fontSize="8" textAnchor="middle">fade rate (% SOH / cycle)</text>
    </svg>
  )
}

export default function CyclerQaDashboard() {
  const [data, setData] = useState<{ summary: Summary; imports: Imp[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true); setError(null)
    try {
      const r = await fetch('/api/lims/imports')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setData(await r.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    }
    setLoading(false)
  }
  useEffect(() => { refresh() }, [])

  const fades = (data?.imports ?? [])
    .map(i => i.fade_rate_pct_per_cycle)
    .filter((v): v is number => v != null)

  return (
    <div className="p-6 space-y-5 max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
            <FlaskRound size={18} className="text-brand-blue" /> Cycler QA Dashboard
          </h1>
          <p className="text-xs text-text-muted mt-0.5">
            Manufacturing-line quality view of imported cycler runs (Arbin / Maccor / Neware / BioLogic)
          </p>
        </div>
        <button onClick={refresh} disabled={loading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel disabled:opacity-50">
          <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <AlertTriangle size={13} /> {error}
        </div>
      )}

      {!loading && data && data.summary.n_imports === 0 && (
        <div className="bg-bg-secondary border border-border-subtle rounded-xl p-8 text-center text-xs text-text-muted">
          <FileText size={28} className="mx-auto opacity-30 mb-2" />
          No cycler imports yet. Upload a vendor export on the <span className="text-brand-blue">Cycler Import</span> page —
          it'll appear here automatically.
        </div>
      )}

      {data && data.summary.n_imports > 0 && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { l: 'Imports',     v: `${data.summary.n_imports}`, c: 'text-text-primary' },
              { l: 'Mean fade',   v: data.summary.mean_fade != null ? `${data.summary.mean_fade.toFixed(4)} %/c` : '—', c: 'text-brand-blue' },
              { l: 'Median fade', v: data.summary.median_fade != null ? `${data.summary.median_fade.toFixed(4)} %/c` : '—', c: 'text-text-primary' },
              { l: 'Spread (σ)',  v: data.summary.stdev_fade != null ? `${data.summary.stdev_fade.toFixed(4)}` : '—', c: 'text-text-muted' },
            ].map(k => (
              <div key={k.l} className="bg-bg-secondary border border-border-subtle rounded-xl p-3">
                <div className="text-[10px] text-text-muted">{k.l}</div>
                <div className={`text-lg font-bold mt-0.5 ${k.c}`}>{k.v}</div>
              </div>
            ))}
          </div>

          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-text-secondary flex items-center gap-1.5"><BarChart3 size={12} /> Fade-rate distribution across imports</div>
              <div className="text-[10px] text-text-muted">
                {data.summary.min_fade != null && data.summary.max_fade != null && (
                  <>range: {data.summary.min_fade.toFixed(4)} – {data.summary.max_fade.toFixed(4)}</>
                )}
              </div>
            </div>
            <FadeHistogram values={fades} mean={data.summary.mean_fade} />
            <p className="text-[10px] text-text-muted mt-2">
              Outliers on the right indicate cells fading abnormally fast — flag those batches for tear-down or process review.
            </p>
          </div>

          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <div className="text-xs font-semibold text-text-secondary mb-3">Recent imports</div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted border-b border-border-subtle">
                    <th className="text-left pb-1.5 pr-3">File</th>
                    <th className="text-left pb-1.5 pr-3">Format</th>
                    <th className="text-right pb-1.5 pr-3">Cycles</th>
                    <th className="text-right pb-1.5 pr-3">Nom Ah</th>
                    <th className="text-right pb-1.5 pr-3">SOH start</th>
                    <th className="text-right pb-1.5 pr-3">SOH end</th>
                    <th className="text-right pb-1.5 pr-3">Fade %/c</th>
                    <th className="text-right pb-1.5">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle/40">
                  {data.imports.map(r => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-3 font-mono text-text-primary truncate max-w-[180px]" title={r.filename}>{r.filename}</td>
                      <td className="py-1.5 pr-3 text-text-secondary">{FMT_LABEL[r.format] ?? r.format}</td>
                      <td className="py-1.5 pr-3 text-right text-text-secondary">{r.n_cycles}</td>
                      <td className="py-1.5 pr-3 text-right text-text-secondary">{r.nominal_capacity_ah?.toFixed(2) ?? '—'}</td>
                      <td className="py-1.5 pr-3 text-right text-text-secondary">{r.soh_initial != null ? `${(r.soh_initial * 100).toFixed(1)}%` : '—'}</td>
                      <td className="py-1.5 pr-3 text-right" style={{ color: r.soh_final == null ? '#6b7280' : r.soh_final > 0.85 ? '#34d399' : r.soh_final > 0.75 ? '#f59e0b' : '#ef4444' }}>
                        {r.soh_final != null ? `${(r.soh_final * 100).toFixed(1)}%` : '—'}
                      </td>
                      <td className="py-1.5 pr-3 text-right text-text-secondary">
                        {r.fade_rate_pct_per_cycle != null ? r.fade_rate_pct_per_cycle.toFixed(4) : '—'}
                      </td>
                      <td className="py-1.5 text-right text-text-muted">{r.imported_at.replace('T', ' ').slice(0, 16)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-2 text-[10px] text-text-muted flex items-center gap-1.5">
              <CheckCircle size={9} className="text-emerald-400" /> Every import on Cycler Import logs here automatically.
            </div>
          </div>
        </motion.div>
      )}
    </div>
  )
}

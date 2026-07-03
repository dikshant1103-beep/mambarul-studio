import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  ShieldCheck, AlertTriangle, DollarSign, Plus, Trash2, Download,
  RefreshCw, Zap, Info, XCircle, CheckCircle,
} from 'lucide-react'

// ── Types ───────────────────────────────────────────────────────────────────

interface WTerms {
  warranty_cycles: number
  warranty_years: number
  cycles_per_year: number
  warranty_soh_threshold: number
  unit_cost: number
}

interface WCell {
  cell_id: string
  soh: number
  chemistry: string
  n_cycles: number
  int_resistance: number
  predicted_rul: number | null
}

interface SingleResult {
  label: string
  soh_pct: number
  predicted_rul: number
  warranty_horizon_cycles: number
  remaining_warranty_cycles: number
  cycles_to_threshold: number
  p_claim: number
  expected_claim_cost: number
  unit_cost: number
  margin_cycles: number
  status: string
  sigma_cycles: number
  rul_source: string
  model_used: string | null
}

interface FleetResult {
  n_cells: number
  by_status: Record<string, number>
  reserve_recommended: number
  total_exposure: number
  reserve_pct: number
  n_at_risk: number
  per_cell: SingleResult[]
  rul_source: string
  model_used: string | null
}

const CHEMS = ['NMC', 'LFP', 'NCA', 'LCO', 'LMO']
const STATUS_LABEL: Record<string, string> = { safe: 'Safe', at_risk: 'At Risk', likely_claim: 'Likely Claim' }
const STATUS_COLOR: Record<string, string> = {
  safe: 'text-emerald-400', at_risk: 'text-amber-400', likely_claim: 'text-red-400',
}
const STATUS_BG: Record<string, string> = {
  safe: 'bg-emerald-500/10 border-emerald-500/20',
  at_risk: 'bg-amber-500/10 border-amber-500/20',
  likely_claim: 'bg-red-500/10 border-red-500/20',
}

const mkCell = (i: number): WCell => ({
  cell_id: `cell_${String(i + 1).padStart(2, '0')}`,
  soh: 0.88, chemistry: 'NMC', n_cycles: 400, int_resistance: 0.04, predicted_rul: null,
})

export default function WarrantyIntelligence() {
  const [mode, setMode]   = useState<'single' | 'fleet'>('single')
  const [auto, setAuto]   = useState(true)
  const [terms, setTerms] = useState<WTerms>({
    warranty_cycles: 1000, warranty_years: 8, cycles_per_year: 250,
    warranty_soh_threshold: 0.80, unit_cost: 120,
  })
  const [single, setSingle] = useState<WCell>(mkCell(0))
  const [cells, setCells]   = useState<WCell[]>([mkCell(0), mkCell(1), mkCell(2)])
  const [loading, setLoading] = useState(false)
  const [error, setError]   = useState<string | null>(null)
  const [sResult, setSResult] = useState<SingleResult | null>(null)
  const [fResult, setFResult] = useState<FleetResult | null>(null)

  function setTerm(k: keyof WTerms, v: number) { setTerms(p => ({ ...p, [k]: v })) }

  async function runSingle() {
    setLoading(true); setError(null); setSResult(null)
    try {
      const res = await fetch('/api/warranty/assess', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cell: single, terms, auto_predict: auto, model_id: 'v12-bimamba' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      setSResult(await res.json())
    } catch (e) { setError(e instanceof Error ? e.message : 'Assessment failed') }
    setLoading(false)
  }

  async function runFleet() {
    if (cells.length < 1) { setError('Add at least one cell.'); return }
    setLoading(true); setError(null); setFResult(null)
    try {
      const res = await fetch('/api/warranty/assess/fleet', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cells, terms, auto_predict: auto, model_id: 'v12-bimamba' }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      setFResult(await res.json())
    } catch (e) { setError(e instanceof Error ? e.message : 'Assessment failed') }
    setLoading(false)
  }

  function exportCsv() {
    if (!fResult) return
    const head = 'cell_id,soh_pct,predicted_rul,p_claim,expected_claim_cost,margin_cycles,status'
    const rows = fResult.per_cell.map(r =>
      `${r.label},${r.soh_pct},${r.predicted_rul},${r.p_claim},${r.expected_claim_cost},${r.margin_cycles},${r.status}`)
    const blob = new Blob([[head, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = 'warranty_fleet.csv'; a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <div className="p-3 sm:p-6 space-y-5 max-w-6xl">
      <div>
        <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
          <ShieldCheck size={18} className="text-brand-blue" /> Warranty Intelligence
        </h1>
        <p className="text-xs text-text-muted mt-0.5">
          Claim probability · expected warranty cost · fleet reserve — from RUL + conformal uncertainty
        </p>
      </div>

      {/* Terms + mode */}
      <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">Mode</span>
            {(['single', 'fleet'] as const).map(m => (
              <button key={m} onClick={() => setMode(m)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${mode === m ? 'bg-brand-blue/15 text-brand-blue border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle hover:text-text-primary'}`}>
                {m === 'single' ? 'Single cell' : 'Fleet'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <span className="text-xs text-text-muted">RUL</span>
            <button onClick={() => setAuto(true)}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${auto ? 'bg-brand-blue/15 text-brand-blue border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle'}`}>
              <Zap size={10} /> v12 AI
            </button>
            <button onClick={() => setAuto(false)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-all ${!auto ? 'bg-bg-panel text-text-primary border-brand-blue/25' : 'bg-bg-panel text-text-secondary border-border-subtle'}`}>
              Manual RUL
            </button>
          </div>
        </div>

        {/* Warranty terms */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          {([
            ['warranty_cycles', 'Warranty cycles', 50],
            ['warranty_years', 'Warranty years', 1],
            ['cycles_per_year', 'Cycles / year', 10],
            ['warranty_soh_threshold', 'EOL SOH', 0.01],
            ['unit_cost', 'Unit cost ($)', 10],
          ] as const).map(([k, label, step]) => (
            <div key={k}>
              <label className="text-[10px] text-text-muted block mb-0.5">{label}</label>
              <input type="number" step={step} value={terms[k]}
                onChange={e => setTerm(k, +e.target.value)}
                className="w-full px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
            </div>
          ))}
        </div>

        {/* Single cell form */}
        {mode === 'single' && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <div>
              <label className="text-[10px] text-text-muted block mb-0.5">Cell ID</label>
              <input value={single.cell_id} onChange={e => setSingle({ ...single, cell_id: e.target.value })}
                className="w-full px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-0.5">SOH (0–1)</label>
              <input type="number" step="0.01" value={single.soh} onChange={e => setSingle({ ...single, soh: +e.target.value })}
                className="w-full px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-0.5">Chemistry</label>
              <select value={single.chemistry} onChange={e => setSingle({ ...single, chemistry: e.target.value })}
                className="w-full px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none">
                {CHEMS.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-[10px] text-text-muted block mb-0.5">Cycles used</label>
              <input type="number" step="10" value={single.n_cycles} onChange={e => setSingle({ ...single, n_cycles: +e.target.value })}
                className="w-full px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
            </div>
            {auto ? (
              <div>
                <label className="text-[10px] text-text-muted block mb-0.5">IR (Ω)</label>
                <input type="number" step="0.001" value={single.int_resistance} onChange={e => setSingle({ ...single, int_resistance: +e.target.value })}
                  className="w-full px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              </div>
            ) : (
              <div>
                <label className="text-[10px] text-text-muted block mb-0.5">RUL (cycles)</label>
                <input type="number" step="10" value={single.predicted_rul ?? 300} onChange={e => setSingle({ ...single, predicted_rul: +e.target.value })}
                  className="w-full px-2 py-1 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              </div>
            )}
          </div>
        )}

        {/* Fleet table */}
        {mode === 'fleet' && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-text-muted border-b border-border-subtle">
                  <th className="text-left pb-1.5 pr-2">Cell ID</th>
                  <th className="text-left pb-1.5 pr-2">SOH</th>
                  <th className="text-left pb-1.5 pr-2">Chem</th>
                  <th className="text-left pb-1.5 pr-2">Cycles</th>
                  <th className="text-left pb-1.5 pr-2">{auto ? 'IR (Ω)' : 'RUL'}</th>
                  <th className="pb-1.5 w-6"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle/40">
                {cells.map((c, i) => (
                  <tr key={i}>
                    <td className="py-1 pr-2"><input value={c.cell_id} onChange={e => setCells(p => p.map((x, j) => j === i ? { ...x, cell_id: e.target.value } : x))}
                      className="w-24 px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary text-[10px] focus:outline-none" /></td>
                    <td className="py-1 pr-2"><input type="number" step="0.01" value={c.soh} onChange={e => setCells(p => p.map((x, j) => j === i ? { ...x, soh: +e.target.value } : x))}
                      className="w-16 px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary text-[10px] focus:outline-none" /></td>
                    <td className="py-1 pr-2"><select value={c.chemistry} onChange={e => setCells(p => p.map((x, j) => j === i ? { ...x, chemistry: e.target.value } : x))}
                      className="px-1.5 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary text-[10px] focus:outline-none">{CHEMS.map(ch => <option key={ch}>{ch}</option>)}</select></td>
                    <td className="py-1 pr-2"><input type="number" step="10" value={c.n_cycles} onChange={e => setCells(p => p.map((x, j) => j === i ? { ...x, n_cycles: +e.target.value } : x))}
                      className="w-16 px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary text-[10px] focus:outline-none" /></td>
                    <td className="py-1 pr-2">{auto
                      ? <input type="number" step="0.001" value={c.int_resistance} onChange={e => setCells(p => p.map((x, j) => j === i ? { ...x, int_resistance: +e.target.value } : x))}
                          className="w-16 px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary text-[10px] focus:outline-none" />
                      : <input type="number" step="10" value={c.predicted_rul ?? 300} onChange={e => setCells(p => p.map((x, j) => j === i ? { ...x, predicted_rul: +e.target.value } : x))}
                          className="w-16 px-2 py-0.5 bg-bg-panel border border-border-subtle rounded text-text-primary text-[10px] focus:outline-none" />}</td>
                    <td className="py-1"><button onClick={() => setCells(p => p.filter((_, j) => j !== i))} className="p-1 text-text-muted hover:text-red-400"><Trash2 size={11} /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex items-center gap-3">
          {mode === 'fleet' && (
            <button onClick={() => setCells(p => [...p, mkCell(p.length)])}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-bg-panel border border-border-subtle text-xs text-text-secondary hover:text-text-primary">
              <Plus size={12} /> Add Cell
            </button>
          )}
          <button onClick={mode === 'single' ? runSingle : runFleet} disabled={loading}
            className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-blue-500 disabled:opacity-50">
            {loading ? <RefreshCw size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
            {loading ? 'Assessing…' : 'Assess Warranty'}
          </button>
          {auto && <span className="text-[10px] text-text-muted flex items-center gap-1"><Zap size={9} className="text-brand-blue" /> RUL from BiMamba-APF v12</span>}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <XCircle size={13} /> {error}
        </div>
      )}

      {/* Single result */}
      {sResult && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
          className={`rounded-xl border p-5 ${STATUS_BG[sResult.status]}`}>
          <div className="flex items-center gap-3 mb-4">
            {sResult.status === 'safe'
              ? <CheckCircle size={20} className="text-emerald-400" />
              : <AlertTriangle size={20} className={STATUS_COLOR[sResult.status]} />}
            <div>
              <div className={`text-lg font-bold ${STATUS_COLOR[sResult.status]}`}>{STATUS_LABEL[sResult.status]}</div>
              <div className="text-xs text-text-muted font-mono">{sResult.label} · SOH {sResult.soh_pct}%</div>
            </div>
            <div className="ml-auto text-right">
              <div className="text-2xl font-bold text-text-primary">{(sResult.p_claim * 100).toFixed(0)}%</div>
              <div className="text-[10px] text-text-muted">claim probability</div>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { l: 'Expected cost', v: `$${sResult.expected_claim_cost}`, c: 'text-brand-blue' },
              { l: 'RUL (cycles)', v: sResult.predicted_rul, c: 'text-text-primary' },
              { l: 'Warranty left', v: `${sResult.remaining_warranty_cycles} cyc`, c: 'text-text-primary' },
              { l: 'Margin', v: `${sResult.margin_cycles > 0 ? '+' : ''}${sResult.margin_cycles} cyc`, c: sResult.margin_cycles > 0 ? 'text-emerald-400' : 'text-red-400' },
            ].map(k => (
              <div key={k.l} className="bg-bg-panel rounded-lg px-3 py-2">
                <div className="text-[10px] text-text-muted">{k.l}</div>
                <div className={`text-sm font-bold ${k.c}`}>{k.v}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 text-[10px] text-text-muted flex items-center gap-1.5">
            <Info size={9} />
            {sResult.rul_source === 'ml'
              ? <>RUL predicted by <span className="text-brand-blue">{sResult.model_used}</span> · σ ±{sResult.sigma_cycles} cycles</>
              : <>RUL entered manually · σ ±{sResult.sigma_cycles} cycles</>}
          </div>
        </motion.div>
      )}

      {/* Fleet result */}
      {fResult && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { l: 'Reserve recommended', v: `$${fResult.reserve_recommended.toLocaleString()}`, s: `${fResult.reserve_pct}% of exposure`, c: 'text-brand-blue' },
              { l: 'Total exposure', v: `$${fResult.total_exposure.toLocaleString()}`, s: `${fResult.n_cells} cells`, c: 'text-text-primary' },
              { l: 'At risk', v: `${fResult.n_at_risk}`, s: `of ${fResult.n_cells}`, c: 'text-amber-400' },
              { l: 'Likely claims', v: `${fResult.by_status.likely_claim ?? 0}`, s: 'high probability', c: 'text-red-400' },
            ].map(k => (
              <div key={k.l} className="bg-bg-secondary border border-border-subtle rounded-xl p-3">
                <div className="text-[10px] text-text-muted">{k.l}</div>
                <div className={`text-xl font-bold mt-0.5 ${k.c}`}>{k.v}</div>
                <div className="text-[10px] text-text-muted">{k.s}</div>
              </div>
            ))}
          </div>

          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold text-text-secondary flex items-center gap-1.5"><DollarSign size={12} /> Per-cell warranty exposure</div>
              <button onClick={exportCsv} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-panel border border-border-subtle text-[10px] text-text-secondary hover:text-text-primary">
                <Download size={11} /> Export CSV
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-text-muted border-b border-border-subtle">
                    <th className="text-left pb-1.5 pr-3">Cell</th>
                    <th className="text-right pb-1.5 pr-3">SOH</th>
                    <th className="text-right pb-1.5 pr-3">RUL</th>
                    <th className="text-right pb-1.5 pr-3">P(claim)</th>
                    <th className="text-right pb-1.5 pr-3">Exp. cost</th>
                    <th className="text-right pb-1.5 pr-3">Margin</th>
                    <th className="text-center pb-1.5">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle/40">
                  {fResult.per_cell.map(r => (
                    <tr key={r.label}>
                      <td className="py-2 pr-3 font-mono text-text-primary">{r.label}</td>
                      <td className="py-2 pr-3 text-right text-text-secondary">{r.soh_pct}%</td>
                      <td className="py-2 pr-3 text-right text-text-secondary">{r.predicted_rul}</td>
                      <td className="py-2 pr-3 text-right font-medium" style={{ color: r.p_claim > 0.4 ? '#ef4444' : r.p_claim > 0.1 ? '#f59e0b' : '#34d399' }}>{(r.p_claim * 100).toFixed(0)}%</td>
                      <td className="py-2 pr-3 text-right text-brand-blue font-semibold">${r.expected_claim_cost}</td>
                      <td className={`py-2 pr-3 text-right ${r.margin_cycles > 0 ? 'text-emerald-400' : 'text-red-400'}`}>{r.margin_cycles > 0 ? '+' : ''}{r.margin_cycles}</td>
                      <td className="py-2 text-center"><span className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_BG[r.status]} ${STATUS_COLOR[r.status]}`}>{STATUS_LABEL[r.status]}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[9px] text-text-muted mt-2">
              Reserve = Σ expected claim cost (P(claim) × unit cost). Claim = SOH breaches {(terms.warranty_soh_threshold * 100).toFixed(0)}% before the warranty horizon (min of cycle and time caps).
            </p>
          </div>
        </motion.div>
      )}
    </div>
  )
}

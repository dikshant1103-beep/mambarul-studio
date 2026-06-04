/**
 * InternalStateValidation — Phase C internal-state prediction + validation.
 *
 * Top section: Live Cell Prediction — enter any cell_id, choose source:
 *   "ML Head"     → GET /api/twin/internal-states/{id}?source=head  (~1ms)
 *   "Digital Twin"→ GET /api/twin/internal-states/{id}?source=twin  (~30s)
 *
 * Bottom section: held-out per-key R² validation report (read-only).
 */
import { useState, useEffect, useCallback } from 'react'
import { Activity, RefreshCw, AlertTriangle, Zap, FlaskConical } from 'lucide-react'

const STATE_LABELS: Record<string, string> = {
  k_sei:               'k_SEI',
  k_crack:             'k_crack',
  alpha:               'α (SEI frac)',
  Q0:                  'Q₀ (Ah)',
  sei_thickness_nm:    'SEI thickness (nm)',
  lli_fraction:        'LLI fraction',
  lam_fraction:        'LAM fraction',
  ir_growth_pct:       'IR growth (%)',
  cycles_to_eol:       'Cycles to EOL',
  temp_stress_index:   'Temp stress',
  lithium_plating_risk:'Plating risk',
  fit_r2:              'Fit R²',
  fit_mape:            'Fit MAPE',
}

// ── Live prediction panel ─────────────────────────────────────────────────────

function LivePrediction() {
  const [cellId, setCellId]   = useState('CS2_34')
  const [source, setSource]   = useState<'head' | 'twin'>('head')
  const [result, setResult]   = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError]     = useState<string | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)

  const predict = async () => {
    if (!cellId.trim()) return
    setLoading(true); setError(null); setResult(null); setElapsed(null)
    const t0 = performance.now()
    try {
      const r = await fetch(`/api/twin/internal-states/${encodeURIComponent(cellId.trim())}?source=${source}`)
      const ms = performance.now() - t0
      setElapsed(Math.round(ms))
      if (!r.ok) { const d = await r.json(); throw new Error(d.detail ?? `HTTP ${r.status}`) }
      setResult(await r.json())
    } catch (e: any) {
      setError(e.message ?? 'request failed')
    } finally {
      setLoading(false)
    }
  }

  const states: Record<string, any> = result?.states ?? {}
  const srcTag = result?.source ?? source

  return (
    <div className="bg-slate-800/60 rounded-xl border border-slate-700 p-4 space-y-4">
      <h3 className="font-semibold flex items-center gap-2">
        <FlaskConical size={15} className="text-cyan-400" /> Live Cell Prediction
      </h3>

      {/* Input row */}
      <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
        <div className="flex-1">
          <label className="block text-[11px] text-text-muted mb-1">Cell ID</label>
          <input
            value={cellId}
            onChange={e => setCellId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && predict()}
            placeholder="e.g. CS2_34"
            className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-cyan-500"
          />
        </div>

        {/* Source toggle */}
        <div>
          <label className="block text-[11px] text-text-muted mb-1">Source</label>
          <div className="flex rounded overflow-hidden border border-slate-600 text-xs">
            <button
              onClick={() => setSource('head')}
              className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${
                source === 'head'
                  ? 'bg-cyan-600 text-white'
                  : 'bg-slate-800 text-text-muted hover:bg-slate-700'
              }`}>
              <Zap size={11} /> ML Head <span className="text-[10px] opacity-70">~1ms</span>
            </button>
            <button
              onClick={() => setSource('twin')}
              className={`px-3 py-1.5 flex items-center gap-1.5 transition-colors ${
                source === 'twin'
                  ? 'bg-emerald-700 text-white'
                  : 'bg-slate-800 text-text-muted hover:bg-slate-700'
              }`}>
              <FlaskConical size={11} /> Digital Twin <span className="text-[10px] opacity-70">~30s</span>
            </button>
          </div>
        </div>

        <button
          onClick={predict}
          disabled={loading || !cellId.trim()}
          className="px-4 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-sm font-medium flex items-center gap-2">
          {loading
            ? <><RefreshCw size={13} className="animate-spin" /> {source === 'twin' ? 'Fitting…' : 'Running…'}</>
            : 'Predict'}
        </button>
      </div>

      {/* Source hint */}
      <p className="text-[11px] text-text-muted">
        {source === 'head'
          ? '⚡ ML Head: Run G BiMamba backbone + trained internal-state head. Instant inference, no PyBaMM needed.'
          : '🔬 Digital Twin: PyBaMM SPM+SEI curve fit for this cell. Slower but exact fit to its degradation history.'}
      </p>

      {error && (
        <div className="border border-red-800 bg-red-900/20 rounded p-2 text-xs flex items-center gap-2">
          <AlertTriangle size={13} className="text-red-400 shrink-0" /> {error}
        </div>
      )}

      {result && (
        <div className="space-y-3">
          {/* Header badge */}
          <div className="flex items-center gap-3 text-xs flex-wrap">
            <span className={`px-2 py-0.5 rounded-full font-medium ${
              srcTag === 'ml_head' ? 'bg-cyan-900 text-cyan-300' : 'bg-emerald-900 text-emerald-300'
            }`}>
              {srcTag === 'ml_head' ? '⚡ ML Head (Run G)' : '🔬 Digital Twin'}
            </span>
            {elapsed != null && (
              <span className="text-text-muted">{elapsed} ms</span>
            )}
            <span className="text-text-muted">cell: {result.cell_id}</span>
            {result.chemistry && <span className="text-text-muted">{result.chemistry}</span>}
          </div>

          {/* State grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 text-xs">
            {Object.entries(STATE_LABELS).map(([key, label]) => {
              const raw = states[key]
              const val = raw == null ? null : Number(raw)
              const display = val == null ? '—'
                : Math.abs(val) >= 1000 ? val.toFixed(0)
                : Math.abs(val) >= 1    ? val.toFixed(2)
                : val.toFixed(5)
              const highlight =
                key === 'k_sei'            ? 'border-cyan-700'
                : key === 'Q0'             ? 'border-emerald-700'
                : key === 'sei_thickness_nm'? 'border-cyan-700'
                : key === 'lli_fraction'   ? 'border-amber-700'
                : 'border-slate-700'
              return (
                <div key={key} className={`bg-slate-900 rounded p-2 border ${highlight}`}>
                  <div className="text-[10px] text-text-muted truncate">{label}</div>
                  <div className="font-mono text-sm text-text-primary">{display}</div>
                </div>
              )
            })}
          </div>

          {/* Interpretation note */}
          {states.k_sei != null && states.k_crack != null && (
            <div className="bg-slate-900 rounded p-3 text-xs text-text-secondary border border-slate-700">
              <strong>Interpretation:</strong>{' '}
              {states.k_sei > states.k_crack
                ? `SEI growth dominates (k_SEI=${Number(states.k_sei).toFixed(5)} > k_crack=${Number(states.k_crack).toFixed(5)}) — stable, chemistry-driven degradation.`
                : `Particle cracking dominates (k_crack=${Number(states.k_crack).toFixed(5)} > k_SEI=${Number(states.k_sei).toFixed(5)}) — mechanical damage, may accelerate.`
              }
              {states.cycles_to_eol != null && ` Est. cycles to EOL: ${Math.round(states.cycles_to_eol)}.`}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Validation report ─────────────────────────────────────────────────────────

export default function InternalStateValidation() {
  const [data, setData] = useState<any>(null)
  const [err, setErr]   = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/phase-c/validation/latest')
      if (!r.ok) throw new Error(`status ${r.status}`)
      setData(await r.json())
    } catch (e: any) {
      setErr(e.message ?? 'fetch failed')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return (
    <div className="p-3 sm:p-6 space-y-5">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Activity className="text-cyan-400" /> Internal-State Estimator
        </h1>
        <p className="text-sm text-text-secondary mt-1">
          Reverse-engineer the internal electrochemical state of any cell from external V/I/T.
          Choose the ML head (instant) or the full PyBaMM digital twin fit.
        </p>
      </header>

      {/* Live prediction panel always visible */}
      <LivePrediction />

      {/* Validation report */}
      <div className="bg-slate-800/60 rounded-xl border border-slate-700 p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-semibold">Held-out Validation Report (Run G)</h3>
          <button onClick={refresh} disabled={busy}
                  className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs flex items-center gap-1">
            <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Reload
          </button>
        </div>

        {err && (
          <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2 text-sm">
            <AlertTriangle size={14} className="text-amber-400" /> {err}
          </div>
        )}

        {data && !data.available && (
          <p className="text-sm text-text-secondary">
            No validation report yet. Will populate after the next training run.
          </p>
        )}

        {data?.available && <ValidationReport data={data} />}
      </div>
    </div>
  )
}

function ValidationReport({ data }: { data: any }) {
  const report  = data.report
  const perKey  = report.per_key ?? {}
  const perChem = report.per_chemistry ?? {}
  const keys    = Object.keys(perKey)

  return (
    <div className="space-y-4">
      <div className="flex gap-4 text-sm text-text-muted flex-wrap">
        <span>n_val = {report.n_val}</span>
        <span>RUL MAE = {report.rul_mae_norm}</span>
        <span>SOH MAE = {report.soh_mae}</span>
      </div>

      <div>
        <div className="text-xs text-text-muted mb-2">Overall per-key R²</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
          {keys.map(k => {
            const r2 = perKey[k]?.r2
            const tone = r2 == null ? 'text-text-muted'
                       : r2 > 0.7   ? 'text-emerald-300'
                       : r2 > 0.0   ? 'text-cyan-300'
                                    : 'text-red-300'
            return (
              <div key={k} className="bg-slate-900 p-2 rounded border border-slate-700">
                <div className="text-[10px] uppercase text-text-muted">{STATE_LABELS[k] ?? k}</div>
                <div className={`font-mono ${tone}`}>R² = {r2 == null ? 'n/a' : Number(r2).toFixed(2)}</div>
                <div className="text-[10px] text-text-muted">MAPE {perKey[k]?.mape_pct ?? '—'}%</div>
              </div>
            )
          })}
        </div>
      </div>

      {Object.keys(perChem).length > 0 && (
        <div>
          <div className="text-xs text-text-muted mb-2">Per-chemistry R²</div>
          <div className="overflow-x-auto">
            <table className="text-xs w-full min-w-[500px]">
              <thead>
                <tr className="text-text-muted">
                  <th className="text-left p-1">chem</th>
                  <th className="text-right p-1">n</th>
                  {keys.map(k => <th key={k} className="text-right p-1">{(STATE_LABELS[k] ?? k).slice(0, 9)}</th>)}
                </tr>
              </thead>
              <tbody>
                {Object.entries(perChem).map(([chem, kv]: any) => (
                  <tr key={chem} className="border-t border-slate-700">
                    <td className="p-1 font-mono font-semibold">{chem}</td>
                    <td className="text-right p-1 font-mono">{kv.n}</td>
                    {keys.map(k => {
                      const r2 = kv.per_key?.[k]?.r2
                      return (
                        <td key={k} className={`text-right p-1 font-mono ${
                          r2 == null ? 'text-text-muted'
                          : r2 > 0.7  ? 'text-emerald-300'
                          : r2 > 0    ? 'text-cyan-300' : 'text-red-300'}`}>
                          {r2 == null ? 'n/a' : Number(r2).toFixed(2)}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

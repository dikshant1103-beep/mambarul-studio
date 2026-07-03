/**
 * ThermalCoupling — LSTM + cross-cell attention pack thermal predictor.
 *
 * READ-ONLY for both apps: paste a (N×T) temperature matrix, get per-cell
 * ΔT_next + coupling_score + the N×N attention matrix as a heatmap.
 *
 * ADMIN only: paste pack traces JSON + click "Train" to fit a new checkpoint.
 */
import { useState, useEffect } from 'react'
import { Thermometer, RefreshCw, Play, Cpu, AlertTriangle } from 'lucide-react'

interface PredOut {
  cell_id: string
  current_t: number
  predicted_t: number
  delta_t: number
  coupling_score: number
}

interface PredResult {
  mode: 'trained' | 'untrained' | 'in_memory'
  n_cells: number
  predictions: PredOut[]
  attention: number[][]
  max_delta_t: number
  hottest_predicted_cell: string
}

const DEFAULT_INPUT = `25.1, 25.4, 25.9, 26.5, 27.0, 27.4
25.0, 25.2, 25.5, 25.9, 26.2, 26.4
24.9, 24.9, 25.0, 25.1, 25.2, 25.2
25.0, 25.1, 25.4, 25.8, 26.3, 26.9`

function parseMatrix(text: string): number[][] {
  return text.trim().split('\n').map(line =>
    line.split(/[,\s]+/).filter(Boolean).map(Number)
  ).filter(r => r.length > 0 && !r.some(Number.isNaN))
}

export default function ThermalCoupling() {
  const isAdmin = false   // customer app: read-only — admin trains the coupling LSTM

  const [tempInput, setTempInput] = useState(DEFAULT_INPUT)
  const [dt, setDt] = useState(1.0)
  const [pred, setPred] = useState<PredResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<any>(null)

  // admin: training panel
  const [trainText, setTrainText] = useState('[]')
  const [trainBusy, setTrainBusy] = useState(false)
  const [trainResult, setTrainResult] = useState<any>(null)

  useEffect(() => {
    fetch('/api/thermal/coupling/status').then(r => r.json()).then(setStatus).catch(() => {})
  }, [])

  const predict = async () => {
    setBusy(true); setErr(null); setPred(null)
    try {
      const mat = parseMatrix(tempInput)
      if (mat.length < 2) throw new Error('need ≥2 cells (rows)')
      const T = mat[0].length
      if (!mat.every(r => r.length === T)) throw new Error('all rows must have the same length')
      const body = { temperatures: mat, dt_seconds: dt }
      const res = await fetch('/api/thermal/coupling/predict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`)
      setPred(await res.json())
    } catch (e: any) {
      setErr(e.message ?? 'predict failed')
    } finally {
      setBusy(false)
    }
  }

  const trainSubmit = async () => {
    setTrainBusy(true); setTrainResult(null)
    try {
      const traces = JSON.parse(trainText)
      if (!Array.isArray(traces) || traces.length === 0) throw new Error('traces must be a non-empty array')
      const res = await fetch('/api/thermal/coupling/train', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ traces, epochs: 30, lr: 1e-3, batch_size: 2 }),
      })
      if (!res.ok) throw new Error(`status ${res.status}: ${await res.text()}`)
      setTrainResult(await res.json())
      fetch('/api/thermal/coupling/status').then(r => r.json()).then(setStatus).catch(() => {})
    } catch (e: any) {
      setTrainResult({ error: e.message ?? 'train failed' })
    } finally {
      setTrainBusy(false)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Thermometer className="text-orange-400" /> Thermal Coupling LSTM
        </h1>
        <p className="text-sm text-text-secondary">
          Per-cell LSTM + cross-cell multi-head attention. Predicts each cell's
          next-step ΔT and exposes the N×N attention matrix as the pack's
          thermal coupling map.
        </p>
      </header>

      <section className="bg-slate-800/60 rounded p-4 border border-slate-700 flex items-center gap-6 text-sm">
        <span>Checkpoint: <code className="ml-1">{status?.model_available ? 'trained' : 'untrained (random init)'}</code></span>
        {status?.defaults && (
          <span className="text-text-muted">
            d_hidden={status.defaults.d_hidden} · heads={status.defaults.n_heads} · lstm={status.defaults.lstm_layers}
          </span>
        )}
      </section>

      <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
        <h2 className="font-semibold mb-2">Pack temperature window</h2>
        <p className="text-xs text-text-muted mb-2">
          One row per cell, comma- or space-separated time-step temperatures (°C).
          Same number of values per row.
        </p>
        <textarea value={tempInput} onChange={e => setTempInput(e.target.value)}
                  rows={8} spellCheck={false}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 font-mono text-xs" />
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm">dt seconds:
            <input type="number" value={dt} step={0.1} min={0.1}
                   onChange={e => setDt(parseFloat(e.target.value) || 1)}
                   className="ml-2 w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1" />
          </label>
          <button onClick={predict} disabled={busy}
                  className="flex items-center gap-2 px-4 py-1.5 rounded bg-orange-700 hover:bg-orange-600 disabled:opacity-50">
            <Play size={14} /> Predict
          </button>
        </div>
      </section>

      {err && (
        <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-400" /> {err}
        </div>
      )}

      {pred && (
        <>
          <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold">Per-cell prediction</h2>
              <span className={`text-xs px-2 py-0.5 rounded ${
                pred.mode === 'untrained' ? 'bg-amber-900 text-amber-200' : 'bg-emerald-900 text-emerald-200'
              }`}>mode: {pred.mode}</span>
            </div>
            {pred.mode === 'untrained' && (
              <div className="mb-3 text-xs text-amber-300 flex items-center gap-2">
                <AlertTriangle size={12} /> Random-init checkpoint — predictions are not yet meaningful.
                {isAdmin && ' Use the training panel below.'}
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="text-xs text-text-muted">
                <tr><th className="text-left">cell</th>
                    <th className="text-right">current T (°C)</th>
                    <th className="text-right">predicted T (°C)</th>
                    <th className="text-right">ΔT</th>
                    <th className="text-right">coupling score</th></tr>
              </thead>
              <tbody>
                {pred.predictions.map(p => (
                  <tr key={p.cell_id} className="border-t border-slate-700">
                    <td className="py-1">{p.cell_id}</td>
                    <td className="text-right font-mono">{p.current_t.toFixed(2)}</td>
                    <td className="text-right font-mono">{p.predicted_t.toFixed(2)}</td>
                    <td className={`text-right font-mono ${p.delta_t > 0 ? 'text-amber-300' : 'text-cyan-300'}`}>
                      {p.delta_t > 0 ? '+' : ''}{p.delta_t.toFixed(3)}
                    </td>
                    <td className="text-right font-mono">{p.coupling_score.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 text-xs text-text-muted">
              max |ΔT| = {pred.max_delta_t.toFixed(3)} · hottest predicted: <strong>{pred.hottest_predicted_cell}</strong>
            </div>
          </section>

          <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
            <h2 className="font-semibold mb-2">Cross-cell attention (coupling map)</h2>
            <p className="text-xs text-text-muted mb-2">
              Row <em>i</em> attends to columns <em>j</em>; brighter cells = stronger coupling.
            </p>
            <AttentionHeatmap matrix={pred.attention} cellIds={pred.predictions.map(p => p.cell_id)} />
          </section>
        </>
      )}

      {isAdmin && (
        <section className="bg-slate-800/60 rounded p-4 border border-violet-700">
          <h2 className="font-semibold flex items-center gap-2 mb-2">
            <Cpu size={16} className="text-violet-400" /> Train new checkpoint (admin)
          </h2>
          <p className="text-xs text-text-muted mb-2">
            Paste a JSON array of pack traces.
            Each trace: <code>{`{"temperatures": [[...]], "currents": [[...]], "voltages": [[...]], "dt_seconds": 1.0}`}</code>.
            Per-cell temperatures must include the next-step value (T+1).
          </p>
          <textarea value={trainText} onChange={e => setTrainText(e.target.value)}
                    rows={6} spellCheck={false}
                    className="w-full bg-slate-900 border border-slate-700 rounded p-2 font-mono text-xs" />
          <button onClick={trainSubmit} disabled={trainBusy}
                  className="mt-2 flex items-center gap-2 px-4 py-1.5 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-50">
            <RefreshCw size={14} className={trainBusy ? 'animate-spin' : ''} /> Train
          </button>
          {trainResult && (
            <pre className="mt-3 text-xs bg-slate-900 p-2 rounded overflow-x-auto">
              {JSON.stringify(trainResult, null, 2)}
            </pre>
          )}
        </section>
      )}
    </div>
  )
}

function AttentionHeatmap({ matrix, cellIds }: { matrix: number[][]; cellIds: string[] }) {
  if (!matrix.length) return null
  const max = Math.max(...matrix.flat())
  return (
    <div className="inline-block">
      <div className="grid" style={{ gridTemplateColumns: `auto repeat(${matrix.length}, 1fr)` }}>
        <div />
        {cellIds.map(c => <div key={c} className="text-[10px] text-text-muted text-center px-1">{c.slice(0, 8)}</div>)}
        {matrix.map((row, i) => (
          <>
            <div key={`r${i}`} className="text-[10px] text-text-muted text-right pr-2">{cellIds[i].slice(0, 8)}</div>
            {row.map((v, j) => {
              const intensity = max > 0 ? v / max : 0
              const bg = `rgba(251, 146, 60, ${0.05 + 0.95 * intensity})`
              return (
                <div key={`${i}-${j}`} className="w-12 h-8 flex items-center justify-center text-[10px] font-mono"
                     style={{ backgroundColor: bg, color: intensity > 0.5 ? '#0f172a' : '#e2e8f0' }}>
                  {v.toFixed(2)}
                </div>
              )
            })}
          </>
        ))}
      </div>
    </div>
  )
}

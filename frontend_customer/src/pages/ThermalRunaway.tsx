/**
 * ThermalRunaway — OpenModelica thermal-runaway propagation simulator.
 *
 * Both apps: form for pack/sim parameters → POST /api/thermal/runaway/simulate
 * → per-cell temperature trajectory chart + max-T & tripped-count summary.
 * Mode badge: "modelica" (real omc) or "analytical_fallback" (Python).
 */
import { useState, useEffect } from 'react'
import { Flame, Play, AlertTriangle, Cpu } from 'lucide-react'

interface RunawayParams {
  N: number
  Cth: number
  Rint: number
  Rcoup: number
  Rext: number
  T_amb: number
  I_load: number
  T_trigger: number
  Q_decomp: number
  tau_decomp: number
  trigger_cell: number
  trigger_at: number
  stopTime: number
  stepSize: number
  prefer: 'auto' | 'omc' | 'fallback'
}

interface CellTrace { name: string; trajectory: number[] }

interface SimResult {
  mode: string
  time: number[]
  cells: CellTrace[]
  n_steps: number
  n_tripped?: number
  omc_error?: string
}

const DEFAULTS: RunawayParams = {
  N: 4, Cth: 80, Rint: 0.04, Rcoup: 1.5, Rext: 8, T_amb: 25,
  I_load: 30, T_trigger: 120, Q_decomp: 1.5e5, tau_decomp: 8,
  trigger_cell: 1, trigger_at: 5, stopTime: 60, stepSize: 0.5, prefer: 'auto',
}

const PALETTE = ['#f97316', '#3b82f6', '#10b981', '#a855f7', '#ec4899', '#facc15', '#06b6d4', '#64748b']

export default function ThermalRunaway() {
  const [params, setParams] = useState<RunawayParams>(DEFAULTS)
  const [res, setRes] = useState<SimResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<any>(null)

  useEffect(() => {
    fetch('/api/thermal/runaway/status').then(r => r.json()).then(setStatus).catch(() => {})
  }, [])

  const simulate = async () => {
    setBusy(true); setErr(null); setRes(null)
    try {
      const response = await fetch('/api/thermal/runaway/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!response.ok) throw new Error(`status ${response.status}: ${await response.text()}`)
      setRes(await response.json())
    } catch (e: any) {
      setErr(e.message ?? 'simulate failed')
    } finally {
      setBusy(false)
    }
  }

  const setP = (key: keyof RunawayParams) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const v = e.target.value
    setParams(p => ({
      ...p,
      [key]: key === 'prefer' ? v as RunawayParams['prefer']
            : key === 'N' || key === 'trigger_cell' ? parseInt(v) || 1
            : parseFloat(v) || 0,
    }))
  }

  return (
    <div className="p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Flame className="text-red-400" /> Thermal Runaway (OpenModelica)
        </h1>
        <p className="text-sm text-text-secondary">
          N-cell pack: lumped thermal mass + Joule heating + neighbour coupling +
          post-trigger Hatchard/Spotnitz decomposition. When <code>omc</code> is
          available on the server the simulation runs through Modelica; otherwise
          a deterministic explicit-Euler Python fallback executes the same equations.
        </p>
      </header>

      <section className="bg-slate-800/60 rounded p-4 border border-slate-700 flex items-center gap-6 text-sm">
        <span className="flex items-center gap-2">
          <Cpu size={14} className={status?.omc_on_path ? 'text-emerald-400' : 'text-amber-400'} />
          omc on PATH: <strong>{status?.omc_on_path ? 'yes' : 'no'}</strong>
        </span>
        <span className="text-text-muted">Modelica file: <code>{status?.modelica_exists ? 'present' : 'MISSING'}</code></span>
      </section>

      <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
        <h2 className="font-semibold mb-3">Simulation parameters</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <NumInput label="N (cells)"     value={params.N}            onChange={setP('N')} step={1} />
          <NumInput label="Cth (J/K)"     value={params.Cth}          onChange={setP('Cth')} />
          <NumInput label="Rint (Ω)"      value={params.Rint}         onChange={setP('Rint')} step={0.01} />
          <NumInput label="Rcoup (K/W)"   value={params.Rcoup}        onChange={setP('Rcoup')} step={0.1} />
          <NumInput label="Rext (K/W)"    value={params.Rext}         onChange={setP('Rext')} step={0.5} />
          <NumInput label="T_amb (°C)"    value={params.T_amb}        onChange={setP('T_amb')} />
          <NumInput label="I_load (A)"    value={params.I_load}       onChange={setP('I_load')} />
          <NumInput label="T_trigger (°C)" value={params.T_trigger}    onChange={setP('T_trigger')} />
          <NumInput label="Q_decomp (J)"  value={params.Q_decomp}     onChange={setP('Q_decomp')} step={1000} />
          <NumInput label="τ_decomp (s)"  value={params.tau_decomp}   onChange={setP('tau_decomp')} step={0.5} />
          <NumInput label="trigger_cell"  value={params.trigger_cell} onChange={setP('trigger_cell')} step={1} />
          <NumInput label="trigger_at (s)" value={params.trigger_at}   onChange={setP('trigger_at')} step={0.5} />
          <NumInput label="stopTime (s)"  value={params.stopTime}     onChange={setP('stopTime')} step={5} />
          <NumInput label="stepSize (s)"  value={params.stepSize}     onChange={setP('stepSize')} step={0.1} />
          <div>
            <div className="text-[10px] uppercase text-text-muted">solver preference</div>
            <select value={params.prefer} onChange={setP('prefer')}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1">
              <option value="auto">auto (omc if available)</option>
              <option value="omc">omc only (errors if missing)</option>
              <option value="fallback">fallback (Python explicit-Euler)</option>
            </select>
          </div>
        </div>
        <button onClick={simulate} disabled={busy}
                className="mt-4 flex items-center gap-2 px-4 py-1.5 rounded bg-red-700 hover:bg-red-600 disabled:opacity-50">
          <Play size={14} /> Simulate
        </button>
      </section>

      {err && (
        <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-400" /> {err}
        </div>
      )}

      {res && (
        <>
          <section className="grid grid-cols-2 md:grid-cols-5 gap-4">
            <KPI label="mode" value={res.mode} accent={res.mode === 'modelica' ? 'emerald' : 'amber'} />
            <KPI label="n cells" value={res.cells.length} />
            <KPI label="n steps" value={res.n_steps} />
            <KPI label="max T (°C)" value={Math.max(...res.cells.flatMap(c => c.trajectory)).toFixed(1)} accent="amber" />
            <KPI label="tripped" value={res.n_tripped ?? '—'} />
          </section>

          {res.omc_error && (
            <div className="border border-amber-700 bg-amber-900/30 rounded p-3 text-xs">
              omc failed: <code>{res.omc_error}</code> — fell back to Python solver.
            </div>
          )}

          <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
            <h2 className="font-semibold mb-2">Temperature trajectories</h2>
            <TempChart time={res.time} cells={res.cells} trigger={params.T_trigger} />
          </section>
        </>
      )}
    </div>
  )
}

function NumInput({ label, value, onChange, step }: any) {
  return (
    <div>
      <div className="text-[10px] uppercase text-text-muted">{label}</div>
      <input type="number" value={value} onChange={onChange} step={step ?? 1}
             className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono text-xs" />
    </div>
  )
}

function KPI({ label, value, accent }: { label: string; value: any; accent?: 'emerald' | 'amber' }) {
  const color = accent === 'emerald' ? 'text-emerald-400'
              : accent === 'amber'   ? 'text-amber-400'   : 'text-cyan-400'
  return (
    <div className="bg-slate-800/60 rounded p-3 border border-slate-700">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  )
}

function TempChart({ time, cells, trigger }:
                   { time: number[]; cells: CellTrace[]; trigger: number }) {
  const W = 800, H = 280, padL = 40, padR = 10, padT = 10, padB = 24
  const tmax = time[time.length - 1] || 1
  const flat = cells.flatMap(c => c.trajectory)
  const tmin = Math.min(...flat, 20)
  const tmaxv = Math.max(...flat, trigger + 10)
  const x = (t: number) => padL + (t / tmax) * (W - padL - padR)
  const y = (v: number) => H - padB - ((v - tmin) / (tmaxv - tmin)) * (H - padT - padB)

  const tickXs = Array.from({ length: 5 }).map((_, i) => (tmax * i) / 4)
  const tickYs = Array.from({ length: 5 }).map((_, i) => tmin + ((tmaxv - tmin) * i) / 4)

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full text-xs">
      <rect x={0} y={0} width={W} height={H} fill="#0f172a" />
      {tickYs.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke="#334155" strokeDasharray="2 4" />
          <text x={padL - 4} y={y(v)} textAnchor="end" fill="#94a3b8" dy="0.3em">{v.toFixed(0)}</text>
        </g>
      ))}
      {tickXs.map((t, i) => (
        <text key={i} x={x(t)} y={H - 6} textAnchor="middle" fill="#94a3b8">{t.toFixed(1)}s</text>
      ))}
      <line x1={padL} x2={W - padR} y1={y(trigger)} y2={y(trigger)} stroke="#f87171" strokeDasharray="4 2" />
      <text x={W - padR} y={y(trigger) - 4} textAnchor="end" fill="#f87171">T_trigger</text>
      {cells.map((c, i) => {
        const pts = c.trajectory.map((v, k) => `${x(time[k] || 0)},${y(v)}`).join(' ')
        return <polyline key={c.name} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} points={pts} />
      })}
      {cells.map((c, i) => (
        <g key={`leg-${c.name}`} transform={`translate(${padL + 8 + i * 90}, ${padT + 8})`}>
          <line x1={0} x2={14} y1={4} y2={4} stroke={PALETTE[i % PALETTE.length]} strokeWidth={2} />
          <text x={18} y={4} dy="0.3em" fill="#cbd5e1">{c.name}</text>
        </g>
      ))}
    </svg>
  )
}

/**
 * PhaseCResearch (admin) — internal-state research dashboard.
 *
 * Three sections:
 *  1. Spectral / wavelet analyzer — paste a (T × F) window → 21-feature
 *     × 2-channel vector + voltage / current band-energy bar charts.
 *  2. PyBaMM cache jobs — launch the DFN+crack synthetic cache and the
 *     real-cell PyBaMM-labels cache in the background; live log tail.
 *  3. Latest validation report — overall MAE + per-chemistry + per-
 *     (chem × T-bin × C-rate-bin) per-key R² matrix.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Microscope, RefreshCw, Play, Database, BarChart3, AlertTriangle,
  CheckCircle2, Layers, Activity,
} from 'lucide-react'

type Tab = 'spectral' | 'cache' | 'validation'

interface SpectralChannel {
  moments: number[]
  spectral_summary: number[]
  top_peaks: number[]
  band_energies: number[]
}
interface SpectralResp {
  n_features_per_channel: number
  concat_vector: number[]
  voltage: SpectralChannel
  current: SpectralChannel
}
interface CacheStatus {
  state: 'idle' | 'running' | 'completed' | 'failed'
  job: string | null
  started_at: string | null
  ended_at: string | null
  exit_code: number | null
  cmd: string | null
  log_path: string | null
  summary: string | null
  log_tail: string[]
}

const DEFAULT_WINDOW = `1.10  7200  3.80  2.75  4.18  25.1  -0.001  0.030  2
1.09  7250  3.79  2.74  4.13  25.5  -0.002  0.031  2
1.08  7280  3.78  2.74  4.08  26.0  -0.002  0.031  2
1.07  7310  3.77  2.73  4.06  26.3  -0.003  0.032  2
1.06  7340  3.77  2.73  4.00  26.5  -0.003  0.032  2
1.05  7390  3.76  2.72  3.97  26.7  -0.004  0.033  2
1.04  7430  3.75  2.72  3.91  26.8  -0.004  0.033  2
1.03  7480  3.75  2.71  3.86  26.9  -0.005  0.034  2
1.02  7520  3.74  2.70  3.81  27.0  -0.005  0.034  2
1.01  7560  3.73  2.70  3.76  27.0  -0.006  0.034  2
1.00  7600  3.72  2.69  3.72  27.1  -0.006  0.034  2
0.99  7640  3.72  2.69  3.69  27.1  -0.007  0.035  2
0.98  7680  3.71  2.68  3.64  27.1  -0.007  0.035  2
0.97  7720  3.70  2.68  3.59  27.1  -0.008  0.035  2
0.96  7760  3.70  2.68  3.55  27.2  -0.008  0.036  2
0.95  7800  3.69  2.67  3.51  27.2  -0.009  0.036  2
0.94  7840  3.68  2.67  3.46  27.2  -0.009  0.037  2
0.93  7880  3.68  2.66  3.42  27.2  -0.010  0.037  2
0.92  7920  3.67  2.66  3.38  27.2  -0.010  0.037  2
0.91  7960  3.67  2.65  3.34  27.2  -0.011  0.038  2
0.90  8000  3.66  2.65  3.30  27.3  -0.011  0.038  2
0.89  8040  3.65  2.65  3.25  27.3  -0.012  0.038  2
0.88  8080  3.65  2.64  3.21  27.3  -0.012  0.039  2
0.87  8120  3.64  2.64  3.17  27.3  -0.013  0.039  2
0.86  8160  3.63  2.63  3.12  27.3  -0.013  0.040  2
0.85  8200  3.63  2.63  3.09  27.3  -0.014  0.040  2
0.84  8240  3.62  2.63  3.05  27.3  -0.014  0.040  2
0.83  8280  3.61  2.62  3.00  27.3  -0.015  0.041  2
0.82  8320  3.61  2.62  2.96  27.3  -0.015  0.041  2
0.81  8360  3.60  2.61  2.92  27.3  -0.016  0.042  2`

function parseMatrix(txt: string): number[][] {
  return txt.trim().split('\n').map(line =>
    line.split(/[,\s]+/).filter(Boolean).map(Number)
  ).filter(r => r.length > 0 && !r.some(Number.isNaN))
}

export default function PhaseCResearch() {
  const [tab, setTab] = useState<Tab>('spectral')

  return (
    <div className="p-6 space-y-4">
      <header className="flex items-center gap-3">
        <Microscope className="text-violet-400" />
        <div>
          <h1 className="text-2xl font-semibold">Phase C Research</h1>
          <p className="text-sm text-text-secondary">
            Internal-state estimator dashboard — spectral features, PyBaMM cache jobs, and the
            multi-condition validation harness. Admin-only.
          </p>
        </div>
      </header>

      <div className="flex gap-2 border-b border-slate-700">
        <TabBtn active={tab === 'spectral'}   onClick={() => setTab('spectral')}   icon={<BarChart3 size={14} />}  label="Spectral & wavelet" />
        <TabBtn active={tab === 'cache'}      onClick={() => setTab('cache')}      icon={<Database size={14} />}   label="PyBaMM cache jobs" />
        <TabBtn active={tab === 'validation'} onClick={() => setTab('validation')} icon={<Activity size={14} />}   label="Validation viewer" />
      </div>

      {tab === 'spectral'   && <SpectralPanel  />}
      {tab === 'cache'      && <CachePanel     />}
      {tab === 'validation' && <ValidationPanel />}
    </div>
  )
}

function TabBtn({ active, onClick, icon, label }:
                { active: boolean; onClick: () => void; icon: any; label: string }) {
  return (
    <button onClick={onClick}
            className={`px-3 py-2 text-sm flex items-center gap-1.5 border-b-2 -mb-px
                        ${active ? 'border-violet-400 text-violet-300'
                                 : 'border-transparent text-text-secondary hover:text-slate-200'}`}>
      {icon} {label}
    </button>
  )
}

/* ─────────────────────────── Spectral panel ─────────────────────────────── */

function SpectralPanel() {
  const [windowText, setWindowText] = useState(DEFAULT_WINDOW)
  const [voltageCol, setVoltageCol] = useState(2)
  const [currentCol, setCurrentCol] = useState(6)
  const [fs, setFs] = useState(1.0)
  const [resp, setResp] = useState<SpectralResp | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [status, setStatus] = useState<any>(null)

  useEffect(() => {
    fetch('/api/phase-c/spectral/status').then(r => r.json()).then(setStatus).catch(() => {})
  }, [])

  const run = async () => {
    setBusy(true); setErr(null); setResp(null)
    try {
      const win = parseMatrix(windowText)
      if (win.length < 4) throw new Error('window needs ≥4 rows')
      const body = { window: win, voltage_col: voltageCol, current_col: currentCol, fs }
      const r = await fetch('/api/phase-c/spectral/features', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(`status ${r.status}: ${await r.text()}`)
      setResp(await r.json())
    } catch (e: any) {
      setErr(e.message ?? 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-4">
      <div className="bg-slate-800/60 rounded p-4 border border-slate-700 text-sm flex items-center gap-6">
        <span>PyWavelets present: <strong className={status?.have_pywt ? 'text-emerald-400' : 'text-amber-400'}>
          {status?.have_pywt ? 'yes' : 'no (FFT fallback)'}</strong></span>
        {status?.wavelet && (<span className="text-text-muted">wavelet={status.wavelet} · level={status.wavelet_level} · n_features={status.n_features_per_channel}/channel</span>)}
      </div>

      <div className="bg-slate-800/60 rounded p-4 border border-slate-700">
        <h3 className="font-semibold mb-2">30×9 input window</h3>
        <p className="text-xs text-text-muted mb-2">
          One row per cycle, comma- or space-separated columns. Standard 9-feature contract:
          <code className="ml-1">[cap, charge_time, v_mean, v_end, energy, T, slope, ir, chem_code]</code>.
        </p>
        <textarea value={windowText} onChange={e => setWindowText(e.target.value)} rows={9}
                  className="w-full bg-slate-900 border border-slate-700 rounded p-2 font-mono text-[11px]" />
        <div className="mt-3 grid grid-cols-4 gap-3 text-sm">
          <NumInput label="voltage col"  value={voltageCol} step={1} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setVoltageCol(+e.target.value || 0)} />
          <NumInput label="current col"  value={currentCol} step={1} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCurrentCol(+e.target.value || 0)} />
          <NumInput label="fs (1/Δt)"    value={fs}         step={0.1} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setFs(+e.target.value || 1)} />
          <button onClick={run} disabled={busy}
                  className="self-end flex items-center justify-center gap-2 px-3 py-1.5 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-50">
            <Play size={14} /> Compute
          </button>
        </div>
      </div>

      {err && (
        <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2 text-sm">
          <AlertTriangle size={16} className="text-amber-400" /> {err}
        </div>
      )}

      {resp && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ChannelCard title="Voltage channel" data={resp.voltage} accent="cyan" />
          <ChannelCard title="Current channel" data={resp.current} accent="amber" />
          <div className="md:col-span-2 bg-slate-800/60 rounded p-4 border border-slate-700">
            <div className="text-xs text-text-muted mb-1">
              Concatenated vector ({resp.concat_vector.length} dims)
            </div>
            <pre className="text-[10px] font-mono bg-slate-900 p-2 rounded overflow-x-auto max-h-32">
              {resp.concat_vector.map(v => v.toFixed(3)).join(' ')}
            </pre>
          </div>
        </div>
      )}
    </section>
  )
}

function ChannelCard({ title, data, accent }: { title: string; data: SpectralChannel; accent: 'cyan' | 'amber' }) {
  const color = accent === 'cyan' ? 'text-cyan-300' : 'text-amber-300'
  const max = Math.max(...data.band_energies, 1e-6)
  return (
    <div className="bg-slate-800/60 rounded p-4 border border-slate-700">
      <h3 className={`font-semibold mb-3 ${color}`}>{title}</h3>
      <div className="grid grid-cols-4 gap-2 text-xs mb-3">
        <Stat name="mean" v={data.moments[0]} />
        <Stat name="std"  v={data.moments[1]} />
        <Stat name="skew" v={data.moments[2]} />
        <Stat name="kurt" v={data.moments[3]} />
        <Stat name="centroid" v={data.spectral_summary[0]} />
        <Stat name="rolloff95" v={data.spectral_summary[1]} />
        <Stat name="total power" v={data.spectral_summary[2]} />
      </div>
      <div className="text-xs uppercase tracking-wide text-text-muted mb-1">
        Top-3 peaks (f, magnitude)
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs mb-3 font-mono">
        {[0, 2, 4].map(k => (
          <div key={k} className="bg-slate-900 rounded p-1.5">
            f={data.top_peaks[k].toFixed(2)} · m={data.top_peaks[k + 1].toFixed(2)}
          </div>
        ))}
      </div>
      <div className="text-xs uppercase tracking-wide text-text-muted mb-1">
        Wavelet packet band energies (low → high)
      </div>
      <div className="flex items-end gap-1 h-24">
        {data.band_energies.map((e, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end">
            <div className={`w-full rounded-t ${accent === 'cyan' ? 'bg-cyan-500' : 'bg-amber-500'}`}
                 style={{ height: `${(e / max) * 100}%`, minHeight: '2px' }} />
            <div className="text-[9px] text-text-muted mt-0.5">{e.toFixed(2)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({ name, v }: { name: string; v: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-text-muted">{name}</div>
      <div className="font-mono">{typeof v === 'number' ? v.toFixed(3) : '—'}</div>
    </div>
  )
}

function NumInput({ label, value, onChange, step }:
                  { label: string; value: number; onChange: any; step?: number }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-text-muted">{label}</div>
      <input type="number" value={value} onChange={onChange} step={step ?? 1}
             className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono text-xs" />
    </div>
  )
}

/* ─────────────────────────── Cache-jobs panel ──────────────────────────── */

function CachePanel() {
  const [status, setStatus] = useState<CacheStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // Synthetic form
  const [synChems, setSynChems] = useState('LFP NMC NCA LCO')
  const [synCrates, setSynCrates] = useState('0.5 1.0 1.5')
  const [synTemps, setSynTemps] = useState('15 25 35')
  const [synNCycles, setSynNCycles] = useState(200)
  const [synMode, setSynMode] = useState<'spm_reaction_limited' | 'dfn_electrolyte_crack'>('dfn_electrolyte_crack')

  // Real-cell form
  const [realMaxCells, setRealMaxCells] = useState(120)
  const [realChem, setRealChem] = useState<string>('')
  const [realNCycles, setRealNCycles] = useState(200)
  const [realMode, setRealMode] = useState<'spm_reaction_limited' | 'dfn_electrolyte_crack'>('dfn_electrolyte_crack')
  const [realSkipExisting, setRealSkipExisting] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/phase-c/cache/status')
      if (r.ok) setStatus(await r.json())
    } catch {}
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 4000)
    return () => clearInterval(id)
  }, [refresh])

  const launchSynthetic = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/phase-c/cache/synthetic', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chemistries: synChems.trim().split(/\s+/),
          c_rates:     synCrates.trim().split(/\s+/).map(Number),
          temps:       synTemps.trim().split(/\s+/).map(Number),
          n_cycles:    synNCycles,
          model_mode:  synMode,
        }),
      })
      if (!r.ok) throw new Error(`status ${r.status}: ${await r.text()}`)
      refresh()
    } catch (e: any) {
      setErr(e.message ?? 'launch failed')
    } finally {
      setBusy(false)
    }
  }

  const launchReal = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/phase-c/cache/real', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          max_cells:     realMaxCells,
          chemistry:     realChem || null,
          n_cycles:      realNCycles,
          model_mode:    realMode,
          skip_existing: realSkipExisting,
        }),
      })
      if (!r.ok) throw new Error(`status ${r.status}: ${await r.text()}`)
      refresh()
    } catch (e: any) {
      setErr(e.message ?? 'launch failed')
    } finally {
      setBusy(false)
    }
  }

  const isRunning = status?.state === 'running'

  return (
    <section className="space-y-4">
      {err && (
        <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2 text-sm">
          <AlertTriangle size={16} className="text-amber-400" /> {err}
        </div>
      )}

      <TwoStageTrainPanel isRunning={isRunning} refresh={refresh} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-slate-800/60 rounded p-4 border border-slate-700">
          <h3 className="font-semibold flex items-center gap-2 mb-3">
            <Database size={16} className="text-violet-400" /> Synthetic PyBaMM cache
          </h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="col-span-2"><TextInput label="chemistries (space-sep)"  value={synChems}    onChange={setSynChems} /></div>
            <TextInput label="c-rates"     value={synCrates}  onChange={setSynCrates} />
            <TextInput label="temps °C"    value={synTemps}   onChange={setSynTemps} />
            <NumInput  label="n_cycles"    value={synNCycles} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSynNCycles(+e.target.value)} />
            <div>
              <div className="text-[10px] uppercase text-text-muted">model mode</div>
              <select value={synMode} onChange={e => setSynMode(e.target.value as any)}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs">
                <option value="dfn_electrolyte_crack">dfn_electrolyte_crack (slow, real LAM/crack)</option>
                <option value="spm_reaction_limited">spm_reaction_limited (fast, k_crack=0)</option>
              </select>
            </div>
          </div>
          <button onClick={launchSynthetic} disabled={busy || isRunning}
                  className="mt-3 flex items-center gap-2 px-3 py-1.5 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-50 w-full justify-center">
            <Play size={14} /> Launch synthetic cache
          </button>
        </div>

        <div className="bg-slate-800/60 rounded p-4 border border-slate-700">
          <h3 className="font-semibold flex items-center gap-2 mb-3">
            <Layers size={16} className="text-emerald-400" /> Real-cell PyBaMM labels
          </h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <NumInput  label="max cells"   value={realMaxCells} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRealMaxCells(+e.target.value)} />
            <TextInput label="chemistry (blank = all)" value={realChem} onChange={setRealChem} />
            <NumInput  label="n_cycles"    value={realNCycles} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setRealNCycles(+e.target.value)} />
            <div>
              <div className="text-[10px] uppercase text-text-muted">model mode</div>
              <select value={realMode} onChange={e => setRealMode(e.target.value as any)}
                      className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs">
                <option value="dfn_electrolyte_crack">dfn_electrolyte_crack</option>
                <option value="spm_reaction_limited">spm_reaction_limited</option>
              </select>
            </div>
            <label className="col-span-2 flex items-center gap-2 text-xs">
              <input type="checkbox" checked={realSkipExisting} onChange={e => setRealSkipExisting(e.target.checked)} />
              skip cells already labeled with this source tag
            </label>
          </div>
          <button onClick={launchReal} disabled={busy || isRunning}
                  className="mt-3 flex items-center gap-2 px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 w-full justify-center">
            <Play size={14} /> Launch real-label cache
          </button>
        </div>
      </div>

      <div className="bg-slate-800/60 rounded p-4 border border-slate-700">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold flex items-center gap-2">
            <Activity size={16} /> Job status
          </h3>
          <button onClick={refresh}
                  className="text-xs flex items-center gap-1 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
        {status ? (
          <>
            <div className="text-sm grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
              <KV label="state" value={status.state} accent={status.state === 'running' ? 'violet'
                                       : status.state === 'completed' ? 'emerald'
                                       : status.state === 'failed' ? 'red' : undefined} />
              <KV label="job"        value={status.job ?? '—'} />
              <KV label="started_at" value={status.started_at ?? '—'} />
              <KV label="ended_at"   value={status.ended_at ?? '—'} />
            </div>
            {status.cmd && (
              <div className="text-xs mb-2">
                <span className="text-text-muted">cmd: </span>
                <code className="text-[11px]">{status.cmd}</code>
              </div>
            )}
            <div className="text-xs uppercase tracking-wide text-text-muted mb-1">log tail</div>
            <pre className="bg-slate-900 p-2 rounded text-[11px] font-mono max-h-72 overflow-y-auto whitespace-pre-wrap">
              {(status.log_tail ?? []).join('\n') || '(empty)'}
            </pre>
            {status.summary && (
              <div className={`mt-2 flex items-center gap-2 text-xs ${
                  status.state === 'completed' ? 'text-emerald-300'
                  : status.state === 'failed' ? 'text-red-300' : 'text-text-secondary'
                }`}>
                {status.state === 'completed' && <CheckCircle2 size={14} />}
                {status.state === 'failed'    && <AlertTriangle size={14} />}
                {status.summary}
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-text-muted">no status yet</div>
        )}
      </div>
    </section>
  )
}

function TextInput({ label, value, onChange }:
                   { label: string; value: string; onChange: (s: string) => void }) {
  return (
    <div>
      <div className="text-[10px] uppercase text-text-muted">{label}</div>
      <input type="text" value={value} onChange={e => onChange(e.target.value)}
             className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 font-mono text-xs" />
    </div>
  )
}

function KV({ label, value, accent }: { label: string; value: any; accent?: string }) {
  const color = accent === 'violet'  ? 'text-violet-300'
              : accent === 'emerald' ? 'text-emerald-300'
              : accent === 'red'     ? 'text-red-300' : 'text-slate-200'
  return (
    <div>
      <div className="text-[10px] uppercase text-text-muted">{label}</div>
      <div className={`text-sm font-mono ${color}`}>{String(value)}</div>
    </div>
  )
}

/* ─────────────────────────── Validation panel ───────────────────────────── */

function ValidationPanel() {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
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

  if (err) return (
    <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2">
      <AlertTriangle size={16} className="text-amber-400" /> {err}
    </div>
  )
  if (!data) return <div className="text-sm text-text-muted">loading…</div>
  if (!data.available) return (
    <div className="bg-slate-800/60 rounded p-4 border border-slate-700">
      <p className="text-sm text-text-secondary">No validation report yet. Train the head:</p>
      <pre className="text-xs mt-2 bg-slate-900 p-2 rounded">{data.hint}</pre>
    </div>
  )
  const report = data.report
  const perKey: Record<string, any> = report.per_key ?? {}
  const perChem: Record<string, any> = report.per_chemistry ?? {}
  const perCond: Record<string, any> = report.per_condition?.bins ?? {}
  const keys = Object.keys(perKey)

  return (
    <section className="space-y-4">
      <div className="bg-slate-800/60 rounded p-4 border border-slate-700 text-sm flex items-center gap-4 flex-wrap">
        <span>source: <code className="text-[11px]">{data.path}</code></span>
        <span className="text-text-muted">n_val={report.n_val} · n_train={report.n_train}</span>
        <span className="text-text-muted">RUL MAE (norm) = {report.rul_mae_norm} · SOH MAE = {report.soh_mae}</span>
        <button onClick={refresh} disabled={busy}
                className="ml-auto px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs flex items-center gap-1">
          <RefreshCw size={12} className={busy ? 'animate-spin' : ''} /> Reload
        </button>
      </div>

      <Block title="Per-key R² (overall)">
        <KeyGrid perKey={perKey} keys={keys} />
      </Block>

      {Object.keys(perChem).length > 0 && (
        <Block title="Per-chemistry stratification">
          <PerChemTable perChem={perChem} keys={keys} />
        </Block>
      )}

      {Object.keys(perCond).length > 0 && (
        <Block title="Per (chemistry × T-bin × C-rate-bin) — the paper headline table">
          <PerCondTable perCond={perCond} keys={keys} />
        </Block>
      )}
    </section>
  )
}

function Block({ title, children }: { title: string; children: any }) {
  return (
    <div className="bg-slate-800/60 rounded p-4 border border-slate-700">
      <h3 className="font-semibold mb-3">{title}</h3>
      {children}
    </div>
  )
}

function KeyGrid({ perKey, keys }: { perKey: Record<string, any>; keys: string[] }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
      {keys.map(k => {
        const r2 = perKey[k]?.r2
        const tone = r2 == null ? 'text-text-muted'
                   : r2 > 0.7   ? 'text-emerald-300'
                   : r2 > 0.0   ? 'text-cyan-300'
                                : 'text-red-300'
        return (
          <div key={k} className="bg-slate-900 p-2 rounded">
            <div className="text-[10px] uppercase text-text-muted">{k}</div>
            <div className={`font-mono ${tone}`}>R² = {r2 == null ? 'n/a' : Number(r2).toFixed(2)}</div>
            <div className="text-[10px] text-text-muted">MAPE {perKey[k]?.mape_pct ?? '—'}%</div>
          </div>
        )
      })}
    </div>
  )
}

function PerChemTable({ perChem, keys }: { perChem: Record<string, any>; keys: string[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr className="text-text-muted">
            <th className="text-left p-1">chem</th>
            <th className="text-right p-1">n</th>
            {keys.map(k => <th key={k} className="text-right p-1">{k.slice(0, 9)}</th>)}
          </tr>
        </thead>
        <tbody>
          {Object.entries(perChem).map(([chem, kv]: any) => (
            <tr key={chem} className="border-t border-slate-700">
              <td className="p-1">{chem}</td>
              <td className="text-right p-1 font-mono">{kv.n}</td>
              {keys.map(k => {
                const r2 = kv.per_key?.[k]?.r2
                return (
                  <td key={k} className={`text-right p-1 font-mono ${
                    r2 == null ? 'text-text-muted'
                    : r2 > 0.7  ? 'text-emerald-300'
                    : r2 > 0    ? 'text-cyan-300' : 'text-red-300'}`}>
                    {r2 == null ? 'n/a' : r2.toFixed(2)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PerCondTable({ perCond, keys }: { perCond: Record<string, any>; keys: string[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="text-xs w-full">
        <thead>
          <tr className="text-text-muted">
            <th className="text-left p-1">bin</th>
            <th className="text-right p-1">n</th>
            <th className="text-right p-1">T̄</th>
            <th className="text-right p-1">c̄_rate</th>
            {keys.map(k => <th key={k} className="text-right p-1">{k.slice(0, 9)}</th>)}
          </tr>
        </thead>
        <tbody>
          {Object.entries(perCond).map(([label, kv]: any) => (
            <tr key={label} className="border-t border-slate-700">
              <td className="p-1 font-mono">{label}</td>
              <td className="text-right p-1 font-mono">{kv.n}</td>
              <td className="text-right p-1 font-mono">{kv.T_mean}</td>
              <td className="text-right p-1 font-mono">{kv.c_rate_mean}</td>
              {keys.map(k => {
                const r2 = kv.per_key?.[k]?.r2
                return (
                  <td key={k} className={`text-right p-1 font-mono ${
                    r2 == null ? 'text-text-muted'
                    : r2 > 0.7  ? 'text-emerald-300'
                    : r2 > 0    ? 'text-cyan-300' : 'text-red-300'}`}>
                    {r2 == null ? 'n/a' : r2.toFixed(2)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ───────────────────── Two-stage training panel ────────────────────────── */

function TwoStageTrainPanel({ isRunning, refresh }:
                            { isRunning: boolean; refresh: () => void }) {
  const [s1, setS1] = useState(100)
  const [s2, setS2] = useState(60)
  const [lr, setLr] = useState(3e-3)
  const [valFrac, setValFrac] = useState(0.25)
  const [noPretrain, setNoPretrain] = useState(false)
  const [preferSource, setPreferSource] = useState('pybamm_sim_real_matched')
  const [subdir, setSubdir] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const launch = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch('/api/phase-c/train/two-stage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          stage1_epochs: s1, stage2_epochs: s2, lr, val_frac: valFrac,
          no_pretrain: noPretrain,
          prefer_source: preferSource || null,
          out_subdir: subdir || null,
        }),
      })
      if (!r.ok) throw new Error(`status ${r.status}: ${await r.text()}`)
      refresh()
    } catch (e: any) {
      setErr(e.message ?? 'launch failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bg-slate-800/60 rounded p-4 border border-cyan-800">
      <h3 className="font-semibold flex items-center gap-2 mb-3">
        <Activity size={16} className="text-cyan-400" /> Two-stage training (Stage-1 synthetic → Stage-2 real)
      </h3>
      <p className="text-xs text-text-muted mb-3">
        Launches <code>scripts/train_two_stage.py</code>. Uses the cached synthetic cells
        for Stage-1 pretrain and the cached real-cell labels for Stage-2 fine-tune.
        After completion, the result appears in the Validation viewer tab.
      </p>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <NumInput label="stage1 epochs" value={s1}      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setS1(+e.target.value)} />
        <NumInput label="stage2 epochs" value={s2}      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setS2(+e.target.value)} />
        <NumInput label="lr"            value={lr}      step={1e-4} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setLr(+e.target.value)} />
        <NumInput label="val_frac"      value={valFrac} step={0.05} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValFrac(+e.target.value)} />
        <TextInput label="prefer source (blank = all)"  value={preferSource} onChange={setPreferSource} />
        <TextInput label="output subdir (blank = auto)" value={subdir}       onChange={setSubdir} />
        <label className="col-span-2 flex items-center gap-2 text-xs self-end">
          <input type="checkbox" checked={noPretrain} onChange={e => setNoPretrain(e.target.checked)} />
          <span>--no-pretrain (Stage-2 only, ablation baseline)</span>
        </label>
      </div>
      {err && (
        <div className="mt-2 text-xs text-amber-300 flex items-center gap-1">
          <AlertTriangle size={12} /> {err}
        </div>
      )}
      <button onClick={launch} disabled={busy || isRunning}
              className="mt-3 flex items-center gap-2 px-4 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-50">
        <Play size={14} /> Launch training
      </button>
    </div>
  )
}

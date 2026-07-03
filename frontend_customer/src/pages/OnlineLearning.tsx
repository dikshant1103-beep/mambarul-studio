/**
 * OnlineLearning — Layer 4 EWC + cross-cell replay-buffer status page.
 *
 * READ-ONLY status block: number of cells tracked, ready, adapted, EWC
 * hyperparams, and replay buffer reservoir state (size, capacity, n_seen
 * total, per-chemistry histogram).
 *
 * ADMIN only: "Persist replay buffer" button (flushes the in-memory
 * reservoir to disk as a .npz).
 */
import { useState, useEffect, useCallback } from 'react'
import { Brain, RefreshCw, Database, Save, AlertTriangle, CheckCircle2 } from 'lucide-react'

interface ReplayStatus {
  size: number
  capacity: number
  n_seen_total: number
  n_unique_cells: number
  chem_histogram: Record<string, number>
  replay_batch: number
  persist_every: number
  on_disk: boolean
}

interface Layer4Status {
  layer: number
  method: string
  min_cycles: number
  adapt_every: number
  ewc_lambda: number
  n_steps: number
  lr: number
  cells_tracked: number
  cells_ready: number
  cells_adapted: number
  adapters_on_disk: number
  cycle_counts: Record<string, number>
  adapted_cells: string[]
  replay_buffer?: ReplayStatus
}

const CHEM_NAME: Record<string, string> = {
  '0': 'LCO', '1': 'LFP', '2': 'NMC', '3': 'NCM', '4': 'NCA',
}

export default function OnlineLearning() {
  const isAdmin = false   // customer app: read-only — admin operates EWC + replay
  const [data, setData] = useState<Layer4Status | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [persistMsg, setPersistMsg] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const res = await fetch('/api/rul/layer4/status')
      if (!res.ok) throw new Error(`status ${res.status}`)
      setData(await res.json())
    } catch (e: any) {
      setErr(e.message ?? 'failed to fetch status')
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 8000)
    return () => clearInterval(id)
  }, [refresh])

  const persistReplay = async () => {
    setPersistMsg(null)
    try {
      const res = await fetch('/api/rul/layer4/replay/persist', { method: 'POST' })
      if (!res.ok) throw new Error(`status ${res.status}`)
      const j = await res.json()
      setPersistMsg(`Persisted → ${j.persisted_to}`)
      refresh()
    } catch (e: any) {
      setPersistMsg(`error: ${e.message ?? 'failed'}`)
    }
  }

  return (
    <div className="p-6 space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Brain className="text-cyan-400" /> Online Learning (EWC + Replay)
          </h1>
          <p className="text-sm text-text-secondary">
            Layer 4: per-cell Elastic Weight Consolidation fine-tuning + cross-cell
            experience replay reservoir. Adapters live in
            <code className="ml-1">processed/online_adapters/</code>.
          </p>
        </div>
        <button onClick={refresh} disabled={busy}
                className="flex items-center gap-2 px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50">
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} />
          Refresh
        </button>
      </header>

      {err && (
        <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2">
          <AlertTriangle size={16} className="text-amber-400" /> {err}
        </div>
      )}

      {data && (
        <>
          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <KPI label="Cells tracked"   value={data.cells_tracked} />
            <KPI label="Ready to adapt"  value={data.cells_ready} />
            <KPI label="Cells adapted"   value={data.cells_adapted} accent="emerald" />
            <KPI label="Adapters on disk" value={data.adapters_on_disk} />
          </section>

          <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
            <h2 className="font-semibold mb-3">EWC hyperparameters</h2>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
              <Param name="method"      v={data.method} />
              <Param name="min_cycles"  v={data.min_cycles} />
              <Param name="adapt_every" v={data.adapt_every} />
              <Param name="ewc_lambda"  v={data.ewc_lambda} />
              <Param name="n_steps"     v={data.n_steps} />
              <Param name="lr"          v={data.lr} />
            </div>
          </section>

          {data.replay_buffer && (
            <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold flex items-center gap-2">
                  <Database size={16} className="text-violet-400" /> Replay buffer (cross-cell reservoir)
                </h2>
                {isAdmin && (
                  <button onClick={persistReplay}
                          className="flex items-center gap-2 px-3 py-1.5 rounded bg-violet-700 hover:bg-violet-600">
                    <Save size={14} /> Persist to disk
                  </button>
                )}
              </div>
              {persistMsg && (
                <div className="mb-3 text-sm flex items-center gap-2">
                  <CheckCircle2 size={14} className="text-emerald-400" /> {persistMsg}
                </div>
              )}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                <Param name="size"           v={`${data.replay_buffer.size} / ${data.replay_buffer.capacity}`} />
                <Param name="n_seen_total"   v={data.replay_buffer.n_seen_total} />
                <Param name="unique cells"   v={data.replay_buffer.n_unique_cells} />
                <Param name="replay batch"   v={data.replay_buffer.replay_batch} />
                <Param name="persist_every"  v={data.replay_buffer.persist_every} />
                <Param name="on disk"        v={data.replay_buffer.on_disk ? 'yes' : 'no'} />
              </div>
              <div className="mt-4">
                <div className="text-xs uppercase tracking-wide text-text-muted mb-2">
                  Per-chemistry distribution
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {['0', '1', '2', '3', '4'].map(code => {
                    const n = data.replay_buffer!.chem_histogram[code] ?? 0
                    const pct = data.replay_buffer!.size > 0
                      ? Math.round(100 * n / data.replay_buffer!.size) : 0
                    return (
                      <div key={code} className="bg-slate-900 rounded p-2 text-center">
                        <div className="text-xs text-text-muted">{CHEM_NAME[code] ?? code}</div>
                        <div className="text-lg font-semibold">{n}</div>
                        <div className="text-xs text-text-secondary">{pct}%</div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </section>
          )}

          {data.adapted_cells.length > 0 && (
            <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
              <h2 className="font-semibold mb-2">Adapted cells ({data.adapted_cells.length})</h2>
              <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
                {data.adapted_cells.map(cid => (
                  <span key={cid} className="text-xs px-2 py-0.5 bg-slate-900 rounded">
                    {cid}
                  </span>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}

function KPI({ label, value, accent }: { label: string; value: number | string; accent?: 'emerald' | 'amber' }) {
  const color = accent === 'emerald' ? 'text-emerald-400'
              : accent === 'amber'   ? 'text-amber-400'   : 'text-cyan-400'
  return (
    <div className="bg-slate-800/60 rounded p-4 border border-slate-700">
      <div className="text-xs uppercase tracking-wide text-text-muted">{label}</div>
      <div className={`text-3xl font-semibold ${color}`}>{value}</div>
    </div>
  )
}

function Param({ name, v }: { name: string; v: any }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-text-muted">{name}</div>
      <div className="text-sm font-mono">{String(v)}</div>
    </div>
  )
}

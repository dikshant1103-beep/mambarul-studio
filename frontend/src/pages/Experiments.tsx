/**
 * Experiments — MLflow experiment tracking browser.
 * Route: /experiments
 * Shows: all fine-tune runs, metrics, params, registered models.
 */
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  FlaskConical, RefreshCw, ChevronRight,
  CheckCircle2, AlertTriangle, Clock, Package,
  TrendingDown, Database, Cpu, BarChart3
} from 'lucide-react'
import Plot from 'react-plotly.js'

interface Run {
  run_id: string; run_name: string; experiment_id: string
  status: string; start_time: number; end_time: number | null
  duration_s: number | null
  params: Record<string, string>
  metrics: Record<string, number>
  tags: Record<string, string>
}
interface MetricPoint { step: number; value: number; timestamp: number }
interface RegisteredModel {
  name: string; latest_version: number
  versions: { version: string; status: string; run_id: string }[]
}

const STATUS_COLOR: Record<string, string> = {
  FINISHED: '#10b981', FAILED: '#ef4444',
  RUNNING:  '#3b82f6', KILLED: '#f59e0b',
}

function fmt(ms: number | null) {
  if (!ms) return '—'
  const d = new Date(ms)
  return d.toLocaleDateString('en-GB', { day:'2-digit', month:'short' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' })
}
function dur(s: number | null) {
  if (!s) return '—'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s/60)}m`
  return `${(s/3600).toFixed(1)}h`
}

export default function Experiments() {
  const [runs,    setRuns]    = useState<Run[]>([])
  const [models,  setModels]  = useState<RegisteredModel[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [selRun,  setSelRun]  = useState<Run | null>(null)
  const [metrics, setMetrics] = useState<MetricPoint[]>([])
  const [loadingMetrics, setLoadingMetrics] = useState(false)
  const [tab, setTab] = useState<'runs' | 'models'>('runs')
  const [filter, setFilter]  = useState('')

  const refresh = () => {
    setLoading(true)
    Promise.all([
      fetch('/api/experiments/runs?limit=200').then(r => r.json()),
      fetch('/api/experiments/models').then(r => r.json()),
    ])
    .then(([r, m]) => {
      setRuns(Array.isArray(r) ? r : [])
      setModels(Array.isArray(m) ? m : [])
    })
    .catch(e => setError(e.message))
    .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const selectRun = (run: Run) => {
    if (selRun?.run_id === run.run_id) { setSelRun(null); setMetrics([]); return }
    setSelRun(run)
    setLoadingMetrics(true)
    fetch(`/api/experiments/runs/${run.run_id}/metrics/train_loss`)
      .then(r => r.json())
      .then(d => setMetrics(Array.isArray(d) ? d : []))
      .catch(() => setMetrics([]))
      .finally(() => setLoadingMetrics(false))
  }

  const filtered = runs.filter(r => {
    if (!filter) return true
    const q = filter.toLowerCase()
    return r.run_name.toLowerCase().includes(q)
      || (r.params.chemistry || '').toLowerCase().includes(q)
      || (r.params.dataset   || '').toLowerCase().includes(q)
      || r.status.toLowerCase().includes(q)
  })

  const finishedRuns = runs.filter(r => r.status === 'FINISHED')
  const bestLoss = finishedRuns.length
    ? Math.min(...finishedRuns.map(r => r.metrics.best_loss ?? r.metrics.train_loss ?? Infinity))
    : null

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <FlaskConical size={20} className="text-brand-blue"/> Experiment Tracking
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            MLflow — all fine-tuning runs, metrics, and registered models
          </p>
        </div>
        <button onClick={refresh} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-bg-secondary border border-border-subtle rounded-lg text-text-muted hover:text-text-primary transition-colors disabled:opacity-50">
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''}/> Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
          <AlertTriangle size={13}/>
          MLflow not available: {error}. Run a fine-tune job first to populate this page.
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'Total Runs',      value: runs.length,          icon: FlaskConical, color: '#3b82f6' },
          { label: 'Completed',       value: finishedRuns.length,  icon: CheckCircle2, color: '#10b981' },
          { label: 'Best Loss',       value: bestLoss != null ? bestLoss.toFixed(4) : '—', icon: TrendingDown, color: '#8b5cf6' },
          { label: 'Reg. Models',     value: models.length,        icon: Package,      color: '#f59e0b' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="bg-bg-secondary border border-border-subtle rounded-xl p-3 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center"
              style={{ background: color + '15' }}>
              <Icon size={14} style={{ color }}/>
            </div>
            <div>
              <div className="text-lg font-bold text-text-primary">{value}</div>
              <div className="text-[10px] text-text-muted">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 p-1 bg-bg-secondary border border-border-subtle rounded-xl w-fit">
        {([['runs','Runs',BarChart3],['models','Registered Models',Package]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => setTab(t)}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
              tab === t ? 'bg-brand-blue text-white shadow' : 'text-text-muted hover:text-text-primary'
            }`}>
            <Icon size={12}/>{label}
          </button>
        ))}
      </div>

      {tab === 'runs' && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          {/* Run list */}
          <div className="lg:col-span-3 space-y-3">
            <input value={filter} onChange={e => setFilter(e.target.value)}
              placeholder="Filter by name, chemistry, dataset…"
              className="w-full px-3 py-2 text-xs bg-bg-secondary border border-border-subtle rounded-lg text-text-primary placeholder:text-text-muted"/>

            {loading && (
              <div className="flex items-center justify-center py-12 text-text-muted text-sm gap-2">
                <RefreshCw size={14} className="animate-spin"/> Loading runs…
              </div>
            )}

            {!loading && filtered.length === 0 && (
              <div className="bg-bg-secondary border border-dashed border-border-subtle rounded-xl p-10 flex flex-col items-center gap-3 text-center">
                <FlaskConical size={28} className="text-text-muted"/>
                <p className="text-sm text-text-muted">No runs yet.</p>
                <p className="text-xs text-text-muted">Start a fine-tune job on the Fine-Tune page to see runs here.</p>
              </div>
            )}

            <div className="space-y-2">
              {filtered.map(run => {
                const col   = STATUS_COLOR[run.status] ?? '#64748b'
                const chem  = run.params.chemistry || '—'
                const ds    = run.params.dataset   || 'csv'
                const loss  = run.metrics.best_loss ?? run.metrics.train_loss
                const isSelected = selRun?.run_id === run.run_id

                return (
                  <motion.div key={run.run_id}
                    initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                    onClick={() => selectRun(run)}
                    className={`bg-bg-secondary border rounded-xl p-3 cursor-pointer transition-all ${
                      isSelected ? 'border-brand-blue/50 bg-brand-blue/5' : 'border-border-subtle hover:border-border-muted'
                    }`}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: col }}/>
                        <span className="text-xs font-medium text-text-primary truncate">{run.run_name || run.run_id.slice(0,8)}</span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded font-medium flex-shrink-0"
                          style={{ background: col+'20', color: col }}>{run.status}</span>
                      </div>
                      <ChevronRight size={12} className={`text-text-muted transition-transform ${isSelected?'rotate-90':''}`}/>
                    </div>

                    <div className="flex items-center gap-4 mt-2">
                      <span className="text-[10px] text-text-muted flex items-center gap-1">
                        <Database size={9}/> {ds}
                      </span>
                      <span className="text-[10px] text-text-muted flex items-center gap-1">
                        <Cpu size={9}/> {chem}
                      </span>
                      <span className="text-[10px] text-text-muted flex items-center gap-1">
                        <Clock size={9}/> {dur(run.duration_s)}
                      </span>
                      {loss != null && (
                        <span className="text-[10px] text-brand-blue font-medium ml-auto">
                          loss {loss.toFixed(4)}
                        </span>
                      )}
                    </div>
                  </motion.div>
                )
              })}
            </div>
          </div>

          {/* Run detail */}
          <div className="lg:col-span-2">
            <AnimatePresence mode="wait">
              {selRun ? (
                <motion.div key={selRun.run_id}
                  initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }} className="space-y-4 sticky top-6">

                  {/* Loss chart */}
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3">
                    <div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-2">
                      Training Loss
                    </div>
                    {loadingMetrics
                      ? <div className="flex items-center justify-center h-32 text-xs text-text-muted gap-2">
                          <RefreshCw size={12} className="animate-spin"/> Loading…
                        </div>
                      : metrics.length > 0
                      ? <Plot
                          data={[{
                            x: metrics.map(m => m.step),
                            y: metrics.map(m => m.value),
                            type: 'scatter', mode: 'lines',
                            line: { color: '#3b82f6', width: 2 },
                            name: 'train_loss',
                          }]}
                          layout={{
                            height: 160, margin: { l: 40, r: 10, t: 5, b: 30 },
                            paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
                            xaxis: { title: { text: 'Epoch' }, color: '#64748b', gridcolor: '#1e293b', tickfont: { size: 9 } },
                            yaxis: { color: '#64748b', gridcolor: '#1e293b', tickfont: { size: 9 } },
                            showlegend: false,
                          }}
                          config={{ displayModeBar: false, responsive: true }}
                          style={{ width: '100%' }}
                        />
                      : <div className="flex items-center justify-center h-20 text-xs text-text-muted">
                          No metric history available
                        </div>
                    }
                  </div>

                  {/* Params */}
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
                    <div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Parameters</div>
                    <div className="space-y-1">
                      {Object.entries(selRun.params).map(([k, v]) => (
                        <div key={k} className="flex justify-between text-[10px]">
                          <span className="text-text-muted">{k}</span>
                          <span className="text-text-primary font-mono">{v}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Metrics */}
                  {Object.keys(selRun.metrics).length > 0 && (
                    <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
                      <div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Final Metrics</div>
                      <div className="space-y-1">
                        {Object.entries(selRun.metrics).map(([k, v]) => (
                          <div key={k} className="flex justify-between text-[10px]">
                            <span className="text-text-muted">{k}</span>
                            <span className="text-brand-blue font-mono font-medium">{v.toFixed(6)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Run meta */}
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-1.5">
                    <div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest mb-1">Run Info</div>
                    <div className="flex justify-between text-[10px]">
                      <span className="text-text-muted">Run ID</span>
                      <span className="font-mono text-text-secondary">{selRun.run_id.slice(0,12)}…</span>
                    </div>
                    <div className="flex justify-between text-[10px]">
                      <span className="text-text-muted">Started</span>
                      <span className="text-text-secondary">{fmt(selRun.start_time)}</span>
                    </div>
                    <div className="flex justify-between text-[10px]">
                      <span className="text-text-muted">Duration</span>
                      <span className="text-text-secondary">{dur(selRun.duration_s)}</span>
                    </div>
                    {Object.entries(selRun.tags).map(([k, v]) => (
                      <div key={k} className="flex justify-between text-[10px]">
                        <span className="text-text-muted">{k}</span>
                        <span className="font-mono text-text-secondary truncate max-w-[120px]">{v}</span>
                      </div>
                    ))}
                  </div>
                </motion.div>
              ) : (
                <motion.div key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="bg-bg-secondary border border-dashed border-border-subtle rounded-xl p-10 flex flex-col items-center gap-3 text-center">
                  <BarChart3 size={28} className="text-text-muted"/>
                  <p className="text-xs text-text-muted">Click a run to see metrics and loss curve</p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      )}

      {tab === 'models' && (
        <div className="space-y-3">
          {models.length === 0 && (
            <div className="bg-bg-secondary border border-dashed border-border-subtle rounded-xl p-10 flex flex-col items-center gap-3 text-center">
              <Package size={28} className="text-text-muted"/>
              <p className="text-sm text-text-muted">No registered models yet.</p>
              <p className="text-xs text-text-muted">Models are registered automatically when a fine-tune job completes.</p>
            </div>
          )}
          {models.map(m => (
            <div key={m.name}
              className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Package size={14} className="text-amber-400"/>
                  <span className="text-sm font-semibold text-text-primary">{m.name}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
                    v{m.latest_version} versions
                  </span>
                </div>
              </div>
              <div className="space-y-1.5">
                {m.versions.map(v => (
                  <div key={v.version}
                    className="flex items-center justify-between text-[10px] bg-bg-panel rounded-lg px-3 py-2">
                    <span className="font-medium text-text-primary">Version {v.version}</span>
                    <span className="text-text-muted font-mono truncate max-w-[180px]">{v.run_id?.slice(0,12)}…</span>
                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                      v.status === 'READY'
                        ? 'bg-emerald-500/10 text-emerald-400'
                        : 'bg-slate-500/10 text-slate-400'
                    }`}>{v.status}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * FineTune — upload cell data CSV or use a built-in dataset to fine-tune MambaRUL.
 * Route: /finetune
 */
import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Upload, RefreshCw, CheckCircle2, AlertTriangle,
  Zap, Brain, Clock, X, ChevronDown, FileText, Database
} from 'lucide-react'

const CHEMISTRIES = ['NMC', 'LFP', 'LCO', 'NCM', 'NCA']

interface Job {
  id: string
  chemistry: string
  model_base: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  progress: number
  log: string
  created_at: string
  finished_at: string | null
  output_path: string
  error: string
}

interface MatrCell {
  cell_id: string
  split: string
  n_cycles: number
  lifetime: number
}

const STATUS_COLOR: Record<string, string> = {
  queued: '#64748b', running: '#3b82f6', completed: '#10b981',
  failed: '#ef4444', cancelled: '#f59e0b',
}

const EXAMPLE_CSV = `cell_id,cap_pct,rul,int_resistance,temperature,capacity
B0005,0.98,1150,0.041,24.8,2.0
B0005,0.95,1082,0.043,25.1,1.95
B0005,0.91,950,0.047,25.3,1.89`

const BUILTIN_DATASETS = [
  {
    id: 'MATR',
    name: 'MATR — MIT/Stanford/Toyota LFP',
    chemistry: 'LFP',
    cells: 129,
    lifetime: '395–1934 cycles',
    split: 'train',
    description: '79 train / 25 val / 25 test. Fast-charge LFP (18650). Severson et al. Nature Energy 2019.',
    color: '#3b82f6',
  },
]

type TabType = 'upload' | 'builtin'

export default function FineTune() {
  const fileRef  = useRef<HTMLInputElement>(null)
  const [tab,    setTab]    = useState<TabType>('upload')
  const [chem,   setChem]   = useState('NMC')
  const [base,   setBase]   = useState('v10-final')
  const [epochs, setEpochs] = useState(50)
  const [file,   setFile]   = useState<File | null>(null)
  const [uploadId, setUploadId] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [starting,  setStarting]  = useState(false)
  const [jobs,    setJobs]    = useState<Job[]>([])
  const [error,   setError]   = useState<string | null>(null)
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  // Built-in dataset state
  const [selectedBuiltin, setSelectedBuiltin] = useState(BUILTIN_DATASETS[0].id)
  const [builtinSplit, setBuiltinSplit]        = useState<'train' | 'train+val'>('train')
  const [matrInfo, setMatrInfo]                = useState<any | null>(null)
  const [matrCells, setMatrCells]              = useState<MatrCell[]>([])
  const [loadingMatr, setLoadingMatr]          = useState(false)

  // Poll jobs every 4 seconds
  useEffect(() => {
    const refresh = () => {
      fetch('/api/finetune/jobs')
        .then(r => r.json())
        .then(d => { if (Array.isArray(d)) setJobs(d) })
        .catch(() => {})
    }
    refresh()
    const t = setInterval(refresh, 4000)
    return () => clearInterval(t)
  }, [])

  // Load MATR info when built-in tab opens
  useEffect(() => {
    if (tab !== 'builtin' || matrInfo) return
    setLoadingMatr(true)
    Promise.all([
      fetch('/api/matr/info').then(r => r.json()),
      fetch('/api/matr/cells').then(r => r.json()),
    ]).then(([info, cells]) => {
      setMatrInfo(info)
      setMatrCells(Array.isArray(cells) ? cells : [])
    }).catch(() => {}).finally(() => setLoadingMatr(false))
  }, [tab, matrInfo])

  const handleFile = async (f: File) => {
    setFile(f); setUploadId(null); setError(null)
    setUploading(true)
    const form = new FormData()
    form.append('file', f)
    form.append('chemistry', chem)
    try {
      const res = await fetch('/api/finetune/upload', { method: 'POST', body: form })
      const d   = await res.json()
      if (!res.ok) throw new Error(d.detail || 'Upload failed')
      setUploadId(d.upload_id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    }
    setUploading(false)
  }

  const startJob = async () => {
    if (!uploadId) return
    setStarting(true); setError(null)
    try {
      const res = await fetch('/api/finetune/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ upload_id: uploadId, chemistry: chem,
                               model_base: base, epochs }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.detail || 'Start failed')
      setUploadId(null); setFile(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start job')
    }
    setStarting(false)
  }

  const startBuiltinJob = async () => {
    setStarting(true); setError(null)
    try {
      const res = await fetch('/api/finetune/start-builtin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataset:    selectedBuiltin,
          split:      builtinSplit,
          model_base: base,
          epochs,
          lr:         1e-4,
          batch_size: 64,
        }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.detail || 'Start failed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start job')
    }
    setStarting(false)
  }

  const cancelJob = async (jobId: string) => {
    await fetch(`/api/finetune/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {})
  }

  const runningJobs = jobs.filter(j => ['queued','running'].includes(j.status))
  const doneJobs    = jobs.filter(j => !['queued','running'].includes(j.status))

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Fine-Tune Model</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Train MambaRUL on your chemistry — upload your own data or use a built-in research dataset.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 p-1 bg-bg-secondary border border-border-subtle rounded-xl w-fit">
        {([['upload','Upload CSV',Upload],['builtin','Built-in Dataset',Database]] as const).map(([t, label, Icon]) => (
          <button key={t} onClick={() => { setTab(t); setError(null) }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-medium transition-all ${
              tab === t
                ? 'bg-brand-blue text-white shadow'
                : 'text-text-muted hover:text-text-primary'
            }`}>
            <Icon size={12}/>{label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">

        {/* ── Left panel ─────────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Shared config */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-4">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">
              Configuration
            </div>
            <div className="grid grid-cols-2 gap-3">
              {tab === 'upload' && (
                <div className="space-y-1.5">
                  <label className="text-[10px] text-text-muted uppercase tracking-wide">Chemistry</label>
                  <select value={chem} onChange={e => setChem(e.target.value)}
                    className="w-full px-2.5 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary">
                    {CHEMISTRIES.map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-[10px] text-text-muted uppercase tracking-wide">Base Model</label>
                <select value={base} onChange={e => setBase(e.target.value)}
                  className={`w-full px-2.5 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary ${tab==='builtin' ? 'col-span-2':''}`}>
                  {['v10-final','v10-full','v9','v8'].map(m => <option key={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-[10px] text-text-muted uppercase tracking-wide">
                Epochs: {epochs}
              </label>
              <input type="range" min={10} max={200} step={10} value={epochs}
                onChange={e => setEpochs(Number(e.target.value))} className="w-full" />
              <div className="flex justify-between text-[9px] text-text-muted">
                <span>10 (fast)</span><span>200 (accurate)</span>
              </div>
            </div>
          </div>

          <AnimatePresence mode="wait">
            {tab === 'upload' ? (
              <motion.div key="upload" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }} className="space-y-4">

                {/* Drop zone */}
                <div
                  onClick={() => fileRef.current?.click()}
                  onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
                  onDragOver={e => e.preventDefault()}
                  className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 cursor-pointer transition-all ${
                    uploadId
                      ? 'border-emerald-500/40 bg-emerald-500/5'
                      : 'border-border-subtle hover:border-brand-blue/40 hover:bg-bg-panel'
                  }`}>
                  <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
                  {uploading
                    ? <><RefreshCw size={22} className="animate-spin text-brand-blue" />
                        <p className="text-xs text-text-muted">Uploading…</p></>
                    : uploadId
                    ? <><CheckCircle2 size={22} className="text-emerald-400" />
                        <p className="text-xs text-emerald-400 font-medium">{file?.name}</p>
                        <p className="text-[10px] text-text-muted">Ready to train</p></>
                    : <><Upload size={22} className="text-text-muted" />
                        <p className="text-xs text-text-secondary font-medium">Drop CSV or click to browse</p>
                        <p className="text-[10px] text-text-muted">Required: cap_pct, rul</p></>}
                </div>

                {/* Example CSV */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                      Example CSV format
                    </span>
                    <button onClick={() => {
                      const a = document.createElement('a')
                      a.href = URL.createObjectURL(new Blob([EXAMPLE_CSV], { type: 'text/csv' }))
                      a.download = 'example_finetune.csv'; a.click()
                    }} className="text-[10px] text-brand-blue flex items-center gap-1">
                      <FileText size={10} /> Download
                    </button>
                  </div>
                  <pre className="text-[9px] font-mono text-text-muted overflow-x-auto whitespace-pre-wrap">
                    {EXAMPLE_CSV}
                  </pre>
                </div>

                {error && (
                  <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                    <AlertTriangle size={13} /> {error}
                  </div>
                )}

                <button onClick={startJob} disabled={!uploadId || starting}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-brand-blue text-white font-semibold text-sm rounded-xl hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {starting
                    ? <><RefreshCw size={16} className="animate-spin"/> Starting…</>
                    : <><Brain size={16}/> Start Fine-Tuning</>}
                </button>
              </motion.div>
            ) : (
              <motion.div key="builtin" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }} className="space-y-4">

                {/* Dataset card */}
                {BUILTIN_DATASETS.map(ds => (
                  <div key={ds.id}
                    onClick={() => setSelectedBuiltin(ds.id)}
                    className={`border rounded-xl p-4 cursor-pointer transition-all space-y-2 ${
                      selectedBuiltin === ds.id
                        ? 'border-blue-500/50 bg-blue-500/5'
                        : 'border-border-subtle bg-bg-secondary hover:border-border-muted'
                    }`}>
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-xs font-semibold text-text-primary">{ds.name}</p>
                        <p className="text-[10px] text-text-muted mt-0.5">{ds.description}</p>
                      </div>
                      <span className="text-[9px] px-2 py-0.5 rounded-full font-medium"
                        style={{ background: ds.color + '20', color: ds.color }}>
                        {ds.chemistry}
                      </span>
                    </div>
                    {matrInfo && selectedBuiltin === ds.id && (
                      <div className="grid grid-cols-3 gap-2 pt-1">
                        {[
                          ['Cells', matrInfo.n_cells],
                          ['Train', matrInfo.splits?.train ?? '—'],
                          ['Median life', `${matrInfo.lifetime_median} cyc`],
                        ].map(([l, v]) => (
                          <div key={l as string} className="text-center bg-bg-panel rounded-lg py-1.5">
                            <div className="text-[9px] text-text-muted">{l}</div>
                            <div className="text-xs font-bold text-text-primary">{v}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {loadingMatr && selectedBuiltin === ds.id && (
                      <div className="flex items-center gap-2 text-[10px] text-text-muted">
                        <RefreshCw size={10} className="animate-spin"/> Loading metadata…
                      </div>
                    )}
                  </div>
                ))}

                {/* Split selector */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
                  <div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                    Training split
                  </div>
                  <div className="flex gap-2">
                    {(['train', 'train+val'] as const).map(s => (
                      <button key={s} onClick={() => setBuiltinSplit(s)}
                        className={`px-3 py-1.5 rounded-lg text-[10px] font-medium transition-all ${
                          builtinSplit === s
                            ? 'bg-brand-blue text-white'
                            : 'bg-bg-panel text-text-muted hover:text-text-primary border border-border-subtle'
                        }`}>
                        {s === 'train' ? 'Train only (79 cells)' : 'Train + Val (104 cells)'}
                      </button>
                    ))}
                  </div>
                  <p className="text-[9px] text-text-muted">
                    train+val uses more data but test cells remain unseen.
                  </p>
                </div>

                {/* Cell preview table */}
                {matrCells.length > 0 && (
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
                    <div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">
                      Top cells by lifetime
                    </div>
                    <div className="space-y-0.5 max-h-36 overflow-y-auto">
                      {matrCells.slice(0, 10).map(c => (
                        <div key={c.cell_id} className="flex items-center justify-between text-[9px] py-0.5">
                          <span className="font-mono text-text-secondary truncate max-w-[140px]">{c.cell_id}</span>
                          <div className="flex items-center gap-3">
                            <span className="text-text-muted">{c.n_cycles} cyc</span>
                            <span className={`px-1.5 py-0.5 rounded text-[8px] font-medium ${
                              c.split === 'train' ? 'bg-blue-500/10 text-blue-400' :
                              c.split === 'val'   ? 'bg-purple-500/10 text-purple-400' :
                                                    'bg-amber-500/10 text-amber-400'
                            }`}>{c.split}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {error && (
                  <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                    <AlertTriangle size={13} /> {error}
                  </div>
                )}

                <button onClick={startBuiltinJob} disabled={starting}
                  className="w-full flex items-center justify-center gap-2 py-3 bg-brand-blue text-white font-semibold text-sm rounded-xl hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                  {starting
                    ? <><RefreshCw size={16} className="animate-spin"/> Starting…</>
                    : <><Brain size={16}/> Fine-Tune on {selectedBuiltin}</>}
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Jobs panel ───────────────────────────────────────────────── */}
        <div className="space-y-4">
          {/* Running */}
          {runningJobs.length > 0 && (
            <div className="space-y-3">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">
                Running
              </div>
              {runningJobs.map(j => (
                <motion.div key={j.id}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  className="bg-bg-secondary border border-brand-blue/20 rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <RefreshCw size={12} className="animate-spin text-brand-blue" />
                      <span className="text-xs font-medium text-text-primary">
                        {j.chemistry} · {j.model_base}
                      </span>
                    </div>
                    <button onClick={() => cancelJob(j.id)}
                      className="text-[10px] text-red-400/70 hover:text-red-400 flex items-center gap-1">
                      <X size={10}/> Cancel
                    </button>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-[10px] text-text-muted">
                      <span>{j.status}</span>
                      <span>{j.progress.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 bg-bg-panel rounded-full overflow-hidden">
                      <div className="h-full bg-brand-blue rounded-full transition-all duration-500"
                        style={{ width: `${j.progress}%` }} />
                    </div>
                  </div>
                  {j.log && (
                    <div className="text-[9px] font-mono text-text-muted bg-bg-panel rounded p-2 max-h-20 overflow-y-auto">
                      {j.log.split('\n').slice(-5).join('\n')}
                    </div>
                  )}
                </motion.div>
              ))}
            </div>
          )}

          {/* Completed / failed */}
          {doneJobs.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">
                History
              </div>
              {doneJobs.slice(0, 8).map(j => {
                const col = STATUS_COLOR[j.status] ?? '#64748b'
                return (
                  <div key={j.id}
                    className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {j.status === 'completed'
                          ? <CheckCircle2 size={12} style={{ color: col }}/>
                          : j.status === 'failed'
                          ? <AlertTriangle size={12} style={{ color: col }}/>
                          : <Clock size={12} style={{ color: col }}/>}
                        <span className="text-xs font-medium text-text-primary">
                          {j.chemistry} · {j.model_base}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded"
                          style={{ background: col + '20', color: col }}>
                          {j.status}
                        </span>
                      </div>
                      <button onClick={() => setExpandedLog(expandedLog === j.id ? null : j.id)}
                        className="text-text-muted hover:text-text-primary">
                        <ChevronDown size={12} className={`transition-transform ${expandedLog === j.id ? 'rotate-180':''}`}/>
                      </button>
                    </div>
                    {j.status === 'completed' && j.output_path && (
                      <div className="text-[10px] text-emerald-400 font-mono truncate">
                        ✓ Model ready — {j.output_path.split('/').pop()}
                      </div>
                    )}
                    {j.status === 'failed' && j.error && (
                      <div className="text-[10px] text-red-400">{j.error}</div>
                    )}
                    <AnimatePresence>
                      {expandedLog === j.id && j.log && (
                        <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }}
                          exit={{ height: 0 }} className="overflow-hidden">
                          <pre className="text-[9px] font-mono text-text-muted bg-bg-panel rounded p-2 max-h-40 overflow-y-auto">
                            {j.log}
                          </pre>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}
            </div>
          )}

          {runningJobs.length === 0 && doneJobs.length === 0 && (
            <div className="bg-bg-secondary border border-dashed border-border-subtle rounded-xl p-8 flex flex-col items-center gap-3 text-center">
              <Zap size={24} className="text-text-muted" />
              <p className="text-sm text-text-muted">No jobs yet. Start a fine-tune to get started.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

import { useState, useRef } from 'react'
import { motion } from 'framer-motion'
import { FlaskConical, Upload, FileText, XCircle, Download, RefreshCw, CheckCircle } from 'lucide-react'

interface CycleRow { cycle: number; discharge_capacity_ah: number; voltage_mean: number | null }
interface SohPoint { cycle: number; soh: number }
interface ImportResult {
  format: string
  n_rows: number
  n_cycles: number
  capacity_unit: string
  nominal_capacity_ah: number
  cycles: CycleRow[]
  soh_trajectory: SohPoint[]
  normalized_csv: string
  warnings: string[]
}

const FORMAT_LABEL: Record<string, string> = {
  arbin: 'Arbin', maccor: 'Maccor', neware: 'Neware', biologic: 'BioLogic EC-Lab', generic: 'Generic',
}

function SohChart({ data }: { data: SohPoint[] }) {
  if (data.length < 2) return null
  const W = 560, H = 150, PAD = { l: 40, r: 12, t: 10, b: 26 }
  const maxCyc = data[data.length - 1].cycle || 1
  const minSoh = Math.min(...data.map(d => d.soh), 0.78)
  const cx = (c: number) => PAD.l + (c / maxCyc) * (W - PAD.l - PAD.r)
  const cy = (s: number) => PAD.t + (1 - (s - minSoh) / (1 - minSoh)) * (H - PAD.t - PAD.b)
  const path = data.map((d, i) => `${i === 0 ? 'M' : 'L'}${cx(d.cycle).toFixed(1)},${cy(d.soh).toFixed(1)}`).join(' ')
  const eolY = cy(0.80)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-40">
      {[0.8, 0.85, 0.9, 0.95, 1.0].map(s => (
        <g key={s}>
          <line x1={PAD.l} x2={W - PAD.r} y1={cy(s)} y2={cy(s)} stroke="#ffffff0a" />
          <text x={PAD.l - 4} y={cy(s)} textAnchor="end" fill="#6b7280" fontSize="9" dominantBaseline="middle">{(s * 100).toFixed(0)}%</text>
        </g>
      ))}
      <line x1={PAD.l} x2={W - PAD.r} y1={eolY} y2={eolY} stroke="#ef4444" strokeWidth="1" strokeDasharray="5,3" />
      <text x={W - PAD.r - 2} y={eolY - 3} textAnchor="end" fill="#ef4444" fontSize="8">EOL 80%</text>
      <path d={path} fill="none" stroke="#60a5fa" strokeWidth="2" />
      <text x={(PAD.l + W - PAD.r) / 2} y={H - 2} textAnchor="middle" fill="#4b5563" fontSize="8">cycle</text>
    </svg>
  )
}

export default function CyclerImport() {
  const [file, setFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  async function runImport() {
    if (!file) { setError('Select a cycler export first.'); return }
    setLoading(true); setError(null); setResult(null)
    try {
      const form = new FormData(); form.append('file', file)
      const res = await fetch('/api/lims/import', { method: 'POST', body: form })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || `HTTP ${res.status}`)
      setResult(await res.json())
    } catch (e) { setError(e instanceof Error ? e.message : 'Import failed') }
    setLoading(false)
  }

  function downloadNormalized() {
    if (!result) return
    const blob = new Blob([result.normalized_csv], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = 'normalized_cycles.csv'; a.click(); URL.revokeObjectURL(a.href)
  }

  return (
    <div className="p-6 space-y-5 max-w-5xl">
      <div>
        <h1 className="text-lg font-bold text-text-primary flex items-center gap-2">
          <FlaskConical size={18} className="text-brand-blue" /> Cycler Import (LIMS / MES)
        </h1>
        <p className="text-xs text-text-muted mt-0.5">
          Import Arbin · Maccor · Neware · BioLogic exports → per-cycle capacity fade + SOH trajectory
        </p>
      </div>

      <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-4">
        <div
          className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${file ? 'border-brand-blue/40 bg-brand-blue/5' : 'border-border-subtle hover:border-brand-blue/40'}`}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f) }}
        >
          <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) setFile(f) }} />
          {file ? (
            <div className="flex items-center justify-center gap-2 text-xs text-brand-blue">
              <FileText size={14} /> <span className="font-medium">{file.name}</span>
              <span className="text-text-muted">({(file.size / 1024).toFixed(1)} KB)</span>
              <button onClick={e => { e.stopPropagation(); setFile(null) }} className="ml-2 text-text-muted hover:text-red-400"><XCircle size={12} /></button>
            </div>
          ) : (
            <div className="text-xs text-text-muted space-y-1">
              <Upload size={20} className="mx-auto opacity-30" />
              <div>Drop cycler export or click to browse</div>
              <div className="text-[10px] opacity-60">auto-detects vendor format · converts mA/mAh → A/Ah</div>
            </div>
          )}
        </div>
        <button onClick={runImport} disabled={loading || !file}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-brand-blue text-white text-xs font-semibold hover:bg-blue-500 disabled:opacity-50">
          {loading ? <RefreshCw size={12} className="animate-spin" /> : <FlaskConical size={12} />}
          {loading ? 'Parsing…' : 'Import & Analyze'}
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
          <XCircle size={13} /> {error}
        </div>
      )}

      {result && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { l: 'Detected format', v: FORMAT_LABEL[result.format] ?? result.format, c: 'text-brand-blue' },
              { l: 'Cycles', v: `${result.n_cycles}`, c: 'text-text-primary' },
              { l: 'Nominal capacity', v: `${result.nominal_capacity_ah} Ah`, c: 'text-text-primary' },
              { l: 'Capacity unit', v: result.capacity_unit, c: 'text-text-muted' },
            ].map(k => (
              <div key={k.l} className="bg-bg-secondary border border-border-subtle rounded-xl p-3">
                <div className="text-[10px] text-text-muted">{k.l}</div>
                <div className={`text-lg font-bold mt-0.5 ${k.c}`}>{k.v}</div>
              </div>
            ))}
          </div>

          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-text-secondary">Capacity-fade / SOH trajectory</div>
              <button onClick={downloadNormalized} className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-bg-panel border border-border-subtle text-[10px] text-text-secondary hover:text-text-primary">
                <Download size={11} /> Normalized CSV
              </button>
            </div>
            <SohChart data={result.soh_trajectory} />
            <div className="mt-2 flex items-center gap-2 text-[10px] text-text-muted">
              <CheckCircle size={11} className="text-emerald-400" />
              Ready for prediction — feed the normalized CSV to Upload &amp; Analyze, or Batch Predict.
            </div>
          </div>

          {result.warnings.length > 0 && (
            <div className="space-y-0.5">
              {result.warnings.map((w, i) => (
                <div key={i} className="text-[10px] text-amber-400/80">⚠ {w}</div>
              ))}
            </div>
          )}
        </motion.div>
      )}
    </div>
  )
}

/**
 * Battery Grading — assign A/B/C/D grade for second-life placement.
 * Single mode: form → /api/grade/predict-and-grade (auto-predict) or /api/grade
 * Batch mode: CSV upload → /api/grade/batch → results table + export
 */
import { useState, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Award, Upload, Download, RefreshCw, ChevronRight,
  AlertTriangle, Info, Zap, CheckCircle2, XCircle
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface AppResult {
  id: string
  name: string
  suitability: number
  suitable: boolean
  revenue: string
  description: string
  reasons: string[]
}

interface GradeResult {
  label: string
  grade: string
  score: number
  soh_pct: number
  rul_cycles: number
  chemistry: string
  recycle: boolean
  verdict: string
  applications: AppResult[]
  value: { min_usd: number; max_usd: number; per_kwh_usd: number; kwh_remaining: number }
  risk_flags: string[]
  recommended_tests: string[]
  rul_source?: string
  prediction?: {
    predicted_rul: number
    lower_90: number
    upper_90: number
    phase: string
    model: string
    confidence_pct?: number
  }
  error?: string
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GRADE_STYLE: Record<string, { bg: string; text: string; border: string; label: string }> = {
  A: { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/30', label: 'Excellent' },
  B: { bg: 'bg-blue-500/10',   text: 'text-blue-400',    border: 'border-blue-500/30',   label: 'Good' },
  C: { bg: 'bg-amber-500/10',  text: 'text-amber-400',   border: 'border-amber-500/30',  label: 'Fair' },
  D: { bg: 'bg-red-500/10',    text: 'text-red-400',     border: 'border-red-500/30',    label: 'Recycle' },
}

const CHEM_OPTIONS = ['NMC', 'LFP', 'NCA', 'NCM', 'LCO']
const CHEM_COLOR: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4',
}

// ── Grade badge ───────────────────────────────────────────────────────────────

function GradeBadge({ grade, score }: { grade: string; score: number }) {
  const s = GRADE_STYLE[grade] ?? GRADE_STYLE.D
  return (
    <div className={`rounded-2xl border ${s.bg} ${s.border} p-6 flex flex-col items-center gap-2`}>
      <div className={`text-6xl font-black ${s.text}`}>{grade}</div>
      <div className={`text-sm font-semibold ${s.text}`}>{s.label}</div>
      <div className="w-full bg-bg-panel rounded-full h-1.5 mt-1">
        <div className={`h-1.5 rounded-full ${grade === 'A' ? 'bg-emerald-500' : grade === 'B' ? 'bg-blue-500' : grade === 'C' ? 'bg-amber-500' : 'bg-red-500'}`}
          style={{ width: `${score}%` }} />
      </div>
      <div className="text-xs text-text-muted">Score: {score.toFixed(0)}/100</div>
    </div>
  )
}

// ── Suitability bar ───────────────────────────────────────────────────────────

function AppCard({ app }: { app: AppResult }) {
  return (
    <div className={`p-3 rounded-lg border text-xs ${app.suitable
      ? 'bg-emerald-500/5 border-emerald-500/20'
      : 'bg-bg-panel border-border-subtle opacity-60'}`}>
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-medium text-text-primary">{app.name}</span>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${app.suitable
          ? 'bg-emerald-500/15 text-emerald-400'
          : 'bg-red-500/10 text-red-400'}`}>
          {app.suitable ? '✓ Suitable' : '✕ Not suitable'}
        </span>
      </div>
      <div className="w-full bg-bg-secondary rounded-full h-1 mb-1.5">
        <div className={`h-1 rounded-full transition-all ${app.suitable ? 'bg-emerald-500' : 'bg-red-500/40'}`}
          style={{ width: `${Math.round(app.suitability * 100)}%` }} />
      </div>
      <div className="text-text-muted leading-relaxed">{app.description}</div>
      {app.reasons.filter(r => !r.startsWith('Meets')).map(r => (
        <div key={r} className="mt-1 text-amber-400 flex items-start gap-1">
          <AlertTriangle size={9} className="flex-shrink-0 mt-0.5" /> {r}
        </div>
      ))}
    </div>
  )
}

// ── CSV batch helpers ─────────────────────────────────────────────────────────

function parseBatchCSV(text: string): Array<Record<string, string>> {
  const lines = text.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
  return lines.slice(1).map(line => {
    const vals = line.split(',')
    return Object.fromEntries(headers.map((h, i) => [h, vals[i]?.trim() ?? '']))
  })
}

const BATCH_SAMPLE = `label,chemistry,soh_pct,predicted_rul,int_resistance,n_cycles
BAT_001,NMC,88.5,420,0.028,312
BAT_002,LFP,76.2,180,0.035,801
BAT_003,NCA,62.1,55,0.048,1204
BAT_004,NMC,51.3,18,0.067,1890`

// ── Main component ────────────────────────────────────────────────────────────

export default function BatteryGrading() {
  // Single mode state
  const [chemistry, setChemistry] = useState('NMC')
  const [sohPct, setSohPct]       = useState<string>('85')
  const [ir, setIr]               = useState<string>('')
  const [nCycles, setNCycles]     = useState<string>('')
  const [capAh, setCapAh]         = useState<string>('')
  const [rul, setRul]             = useState<string>('')
  const [autoPredictRul, setAutoPredictRul] = useState(true)
  const [loading, setLoading]     = useState(false)
  const [gradeResult, setGradeResult] = useState<GradeResult | null>(null)
  const [error, setError]         = useState<string | null>(null)

  // Batch mode state
  const [batchMode, setBatchMode]     = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [batchResults, setBatchResults] = useState<GradeResult[]>([])
  const [batchError, setBatchError]   = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // ── Single grade ────────────────────────────────────────────────────────────
  const doGrade = async () => {
    const soh = parseFloat(sohPct)
    if (isNaN(soh) || soh < 0 || soh > 100) {
      setError('SOH must be between 0 and 100'); return
    }
    setLoading(true); setError(null); setGradeResult(null)

    const body: Record<string, unknown> = {
      label: 'cell',
      chemistry,
      soh_pct: soh,
      voltage_v: 3.6,
    }
    if (ir) body.int_resistance = parseFloat(ir)
    if (nCycles) body.n_cycles = parseInt(nCycles)
    if (capAh) body.capacity_ah = parseFloat(capAh)

    let endpoint: string
    if (autoPredictRul) {
      endpoint = '/api/grade/predict-and-grade'
    } else {
      if (rul) body.predicted_rul = parseFloat(rul)
      endpoint = '/api/grade'
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
        throw new Error(d.detail ?? `Grading failed (${res.status})`)
      }
      setGradeResult(await res.json())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Grading failed')
    }
    setLoading(false)
  }

  // ── Batch grade ─────────────────────────────────────────────────────────────
  const doBatchUpload = useCallback(async (file: File) => {
    setBatchLoading(true); setBatchError(null); setBatchResults([])
    try {
      const text = await file.text()
      const rows = parseBatchCSV(text)
      if (!rows.length) throw new Error('No valid rows found in CSV')

      const payload = rows.map(r => ({
        label:          r.label || r.battery_id || r.id || 'cell',
        chemistry:      (r.chemistry || 'NMC').toUpperCase(),
        soh_pct:        parseFloat(r.soh_pct || r.soh || '80'),
        predicted_rul:  r.predicted_rul ? parseFloat(r.predicted_rul) : undefined,
        int_resistance: r.int_resistance || r.ir ? parseFloat(r.int_resistance || r.ir) : undefined,
        n_cycles:       r.n_cycles || r.cycles ? parseInt(r.n_cycles || r.cycles) : undefined,
        capacity_ah:    r.capacity_ah || r.cap_ah ? parseFloat(r.capacity_ah || r.cap_ah) : undefined,
      }))

      const CHUNK = 500
      const all: GradeResult[] = []
      for (let i = 0; i < payload.length; i += CHUNK) {
        const res = await fetch('/api/grade/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload.slice(i, i + CHUNK)),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
          throw new Error(d.detail ?? `Batch grade failed (${res.status})`)
        }
        all.push(...(await res.json() as GradeResult[]))
      }
      setBatchResults(all)
    } catch (e) {
      setBatchError(e instanceof Error ? e.message : 'Batch failed')
    }
    setBatchLoading(false)
  }, [])

  const loadBatchSample = () => {
    const blob = new Blob([BATCH_SAMPLE], { type: 'text/csv' })
    doBatchUpload(new File([blob], 'sample_fleet.csv'))
  }

  const downloadBatchCSV = () => {
    if (!batchResults.length) return
    const header = 'label,chemistry,grade,score,soh_pct,rul_cycles,value_min_usd,value_max_usd,recycle,verdict'
    const rows = batchResults.map(r =>
      [r.label, r.chemistry, r.grade ?? '', r.score ?? '', r.soh_pct, r.rul_cycles,
       r.value?.min_usd ?? '', r.value?.max_usd ?? '', r.recycle ? 1 : 0, `"${r.verdict ?? ''}"`].join(',')
    )
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `batteryOS_grades_${Date.now()}.csv`; a.click()
  }

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-6">

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <Award size={20} className="text-amber-400" />
            Battery Grading
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            Grade A / B / C / D — second-life placement, value estimate, suitable applications
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setBatchMode(false); setBatchResults([]); setBatchError(null) }}
            className={`px-3 py-1.5 text-xs rounded-lg transition-all ${!batchMode ? 'bg-brand-blue text-white' : 'border border-border-subtle text-text-secondary hover:bg-bg-panel'}`}
          >Single</button>
          <button
            onClick={() => setBatchMode(true)}
            className={`px-3 py-1.5 text-xs rounded-lg transition-all ${batchMode ? 'bg-brand-blue text-white' : 'border border-border-subtle text-text-secondary hover:bg-bg-panel'}`}
          >Batch CSV</button>
        </div>
      </div>

      <AnimatePresence mode="wait">

        {/* ── Single mode ────────────────────────────────────────── */}
        {!batchMode && (
          <motion.div key="single" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-5">

            {/* Input form */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-5 space-y-4">
              <div className="text-sm font-semibold text-text-primary">Battery Parameters</div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">

                {/* Chemistry */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-text-muted uppercase tracking-wide">Chemistry</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {CHEM_OPTIONS.map(c => (
                      <button key={c} onClick={() => setChemistry(c)}
                        className="px-2.5 py-1 rounded-lg text-xs font-bold transition-all"
                        style={{
                          background: chemistry === c ? CHEM_COLOR[c] + '30' : CHEM_COLOR[c] + '10',
                          color: CHEM_COLOR[c],
                          outline: chemistry === c ? `2px solid ${CHEM_COLOR[c]}50` : 'none',
                        }}>
                        {c}
                      </button>
                    ))}
                  </div>
                </div>

                {/* SOH */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-text-muted uppercase tracking-wide">SOH % <span className="text-red-400">*</span></label>
                  <input
                    type="number" min={0} max={100} step={0.1}
                    value={sohPct}
                    onChange={e => setSohPct(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50"
                    placeholder="e.g. 78.5"
                  />
                </div>

                {/* IR */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-text-muted uppercase tracking-wide">Int. Resistance (Ω)</label>
                  <input
                    type="number" min={0} step={0.001}
                    value={ir}
                    onChange={e => setIr(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50"
                    placeholder="e.g. 0.028"
                  />
                </div>

                {/* n_cycles */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-text-muted uppercase tracking-wide">Cycles completed</label>
                  <input
                    type="number" min={0} step={1}
                    value={nCycles}
                    onChange={e => setNCycles(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50"
                    placeholder="e.g. 450"
                  />
                </div>

                {/* Capacity */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-text-muted uppercase tracking-wide">Capacity (Ah)</label>
                  <input
                    type="number" min={0} step={0.1}
                    value={capAh}
                    onChange={e => setCapAh(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50"
                    placeholder="e.g. 50"
                  />
                </div>

                {/* RUL mode toggle */}
                <div className="space-y-1.5">
                  <label className="text-[10px] text-text-muted uppercase tracking-wide">RUL source</label>
                  <div className="flex gap-2 items-center">
                    <button
                      onClick={() => setAutoPredictRul(true)}
                      className={`flex-1 py-2 text-xs rounded-lg transition-all flex items-center justify-center gap-1 ${autoPredictRul ? 'bg-brand-blue/15 text-brand-blue border border-brand-blue/30' : 'border border-border-subtle text-text-muted hover:bg-bg-panel'}`}
                    ><Zap size={10} /> Auto-predict</button>
                    <button
                      onClick={() => setAutoPredictRul(false)}
                      className={`flex-1 py-2 text-xs rounded-lg transition-all ${!autoPredictRul ? 'bg-brand-blue/15 text-brand-blue border border-brand-blue/30' : 'border border-border-subtle text-text-muted hover:bg-bg-panel'}`}
                    >Manual</button>
                  </div>
                </div>

              </div>

              {/* Manual RUL input */}
              {!autoPredictRul && (
                <div className="space-y-1.5 max-w-xs">
                  <label className="text-[10px] text-text-muted uppercase tracking-wide">Known RUL (cycles)</label>
                  <input
                    type="number" min={0} step={1}
                    value={rul}
                    onChange={e => setRul(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50"
                    placeholder="e.g. 320"
                  />
                </div>
              )}

              {error && (
                <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                  <AlertTriangle size={12} /> {error}
                </div>
              )}

              <button
                onClick={doGrade}
                disabled={loading}
                className="flex items-center gap-2 px-5 py-2.5 bg-brand-blue text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50"
              >
                {loading ? <RefreshCw size={13} className="animate-spin" /> : <Award size={13} />}
                {loading ? 'Grading…' : 'Grade Battery'}
                {!loading && <ChevronRight size={13} />}
              </button>
            </div>

            {/* Results */}
            {gradeResult && !gradeResult.error && (
              <motion.div key="result" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  {/* Grade badge */}
                  <GradeBadge grade={gradeResult.grade} score={gradeResult.score} />

                  {/* Key stats */}
                  <div className="md:col-span-2 bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
                    <div className="text-sm font-semibold text-text-primary">{gradeResult.verdict}</div>

                    <div className="grid grid-cols-2 gap-2 text-xs">
                      {[
                        ['Chemistry', gradeResult.chemistry],
                        ['SOH', `${gradeResult.soh_pct}%`],
                        ['RUL', `${gradeResult.rul_cycles} cycles`],
                        ['RUL source', gradeResult.rul_source === 'provided' ? 'Provided' : autoPredictRul ? 'ML predicted' : 'Estimated'],
                        ['Est. value', `$${gradeResult.value.min_usd.toFixed(0)}–$${gradeResult.value.max_usd.toFixed(0)}`],
                        ['Capacity', `${gradeResult.value.kwh_remaining.toFixed(2)} kWh remaining`],
                      ].map(([k, v]) => (
                        <div key={k} className="flex justify-between">
                          <span className="text-text-muted">{k}</span>
                          <span className="text-text-secondary font-mono">{v}</span>
                        </div>
                      ))}
                    </div>

                    {/* Prediction CI if available */}
                    {gradeResult.prediction && (
                      <div className="flex items-center gap-2 text-[10px] text-text-muted pt-1 border-t border-border-subtle/30">
                        <Zap size={9} className="text-brand-blue" />
                        ML prediction: RUL {gradeResult.prediction.predicted_rul} cycles
                        · 90% CI [{gradeResult.prediction.lower_90}–{gradeResult.prediction.upper_90}]
                        · Phase: {gradeResult.prediction.phase}
                        · {gradeResult.prediction.model}
                      </div>
                    )}
                  </div>
                </div>

                {/* Risk flags */}
                {gradeResult.risk_flags.length > 0 && (
                  <div className="bg-amber-500/5 border border-amber-500/20 rounded-xl p-4 space-y-2">
                    <div className="text-xs font-semibold text-amber-400 flex items-center gap-1.5">
                      <AlertTriangle size={12} /> Risk Flags
                    </div>
                    {gradeResult.risk_flags.map(f => (
                      <div key={f} className="text-xs text-amber-300 flex items-start gap-1.5">
                        <AlertTriangle size={9} className="flex-shrink-0 mt-0.5" /> {f}
                      </div>
                    ))}
                  </div>
                )}

                {/* Applications */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
                  <div className="text-sm font-semibold text-text-primary">Second-Life Applications</div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                    {gradeResult.applications.slice(0, 6).map(app => (
                      <AppCard key={app.id} app={app} />
                    ))}
                  </div>
                </div>

                {/* Recommended tests */}
                {gradeResult.recommended_tests.length > 0 && (
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-2">
                    <div className="text-xs font-semibold text-text-primary flex items-center gap-1.5">
                      <Info size={12} className="text-brand-blue" /> Recommended Tests Before Placement
                    </div>
                    {gradeResult.recommended_tests.map((t, i) => (
                      <div key={i} className="text-xs text-text-muted flex items-start gap-1.5">
                        <ChevronRight size={10} className="text-brand-blue flex-shrink-0 mt-0.5" /> {t}
                      </div>
                    ))}
                  </div>
                )}

              </motion.div>
            )}
          </motion.div>
        )}

        {/* ── Batch mode ────────────────────────────────────────── */}
        {batchMode && (
          <motion.div key="batch" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-4">

            {/* Drop zone */}
            <div
              onClick={() => inputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-10 flex flex-col items-center gap-3 cursor-pointer transition-all border-border-subtle hover:border-brand-blue/40 hover:bg-bg-panel ${batchLoading ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <input ref={inputRef} type="file" accept=".csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) doBatchUpload(f); e.target.value = '' }} />
              {batchLoading
                ? <RefreshCw size={28} className="text-brand-blue animate-spin" />
                : <Upload size={28} className="text-text-muted" />}
              <div className="text-center">
                <div className="text-sm font-medium text-text-primary">
                  {batchLoading ? 'Grading batteries…' : 'Drop fleet CSV here'}
                </div>
                <div className="text-xs text-text-muted mt-1">
                  or <span className="text-brand-blue underline">click to browse</span>
                </div>
              </div>
            </div>

            {/* Format hint */}
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
                <Info size={12} className="text-brand-blue" /> CSV format
              </div>
              <pre className="text-[11px] text-text-secondary font-mono bg-bg-panel rounded-lg p-3 overflow-x-auto">
{`label, chemistry, soh_pct, predicted_rul, int_resistance, n_cycles
BAT_001, NMC,     88.5,    420,           0.028,          312
BAT_002, LFP,     76.2,    ,              ,               801`}
              </pre>
              <div className="text-xs text-text-muted">
                <span className="text-text-secondary font-medium">Required: </span>label, chemistry, soh_pct ·{' '}
                <span className="text-text-secondary font-medium">Optional: </span>predicted_rul, int_resistance, n_cycles, capacity_ah
              </div>
            </div>

            {batchError && (
              <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
                <AlertTriangle size={12} /> {batchError}
              </div>
            )}

            <button onClick={loadBatchSample} disabled={batchLoading}
              className="px-4 py-2 text-xs font-medium border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg transition-all disabled:opacity-40">
              Load sample data (4 batteries)
            </button>

            {/* Batch results */}
            {batchResults.length > 0 && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="space-y-3">

                {/* Stats row */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {(['A', 'B', 'C', 'D'] as const).map(g => {
                    const count = batchResults.filter(r => r.grade === g).length
                    const s = GRADE_STYLE[g]
                    return (
                      <div key={g} className={`rounded-xl border p-3 text-center ${s.bg} ${s.border}`}>
                        <div className={`text-2xl font-black ${s.text}`}>{g}</div>
                        <div className="text-xs text-text-muted">{count} batteries</div>
                      </div>
                    )
                  })}
                </div>

                {/* Table */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                  <div className="px-4 py-2.5 border-b border-border-subtle flex items-center justify-between">
                    <span className="text-xs font-medium text-text-primary">{batchResults.length} batteries graded</span>
                    <button onClick={downloadBatchCSV}
                      className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] border border-border-subtle text-text-secondary hover:bg-bg-panel rounded-lg">
                      <Download size={10} /> Export CSV
                    </button>
                  </div>
                  <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-bg-secondary z-10">
                        <tr className="border-b border-border-subtle text-text-muted">
                          <th className="px-3 py-2 text-left">Label</th>
                          <th className="px-3 py-2 text-left">Chem</th>
                          <th className="px-3 py-2 text-right">SOH %</th>
                          <th className="px-3 py-2 text-right">RUL</th>
                          <th className="px-3 py-2 text-center">Grade</th>
                          <th className="px-3 py-2 text-right">Score</th>
                          <th className="px-3 py-2 text-right">Value (USD)</th>
                          <th className="px-3 py-2 text-left">Best Use</th>
                          <th className="px-3 py-2 text-center">Recycle?</th>
                        </tr>
                      </thead>
                      <tbody>
                        {batchResults.map((r, i) => {
                          const gs = GRADE_STYLE[r.grade ?? 'D']
                          const bestApp = r.applications?.find(a => a.suitable)
                          return (
                            <tr key={i} className="border-b border-border-subtle/30 hover:bg-bg-panel">
                              <td className="px-3 py-1.5 font-mono text-text-primary text-[11px]">{r.label}</td>
                              <td className="px-3 py-1.5">
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold"
                                  style={{ background: (CHEM_COLOR[r.chemistry] ?? '#3b82f6') + '20', color: CHEM_COLOR[r.chemistry] ?? '#3b82f6' }}>
                                  {r.chemistry}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">
                                <span className={r.soh_pct > 80 ? 'text-emerald-400' : r.soh_pct > 65 ? 'text-amber-400' : 'text-red-400'}>
                                  {r.soh_pct?.toFixed(1)}%
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-text-muted">{r.rul_cycles}</td>
                              <td className="px-3 py-1.5 text-center">
                                <span className={`text-sm font-black px-2 py-0.5 rounded-lg ${gs.bg} ${gs.text} ${gs.border} border`}>
                                  {r.grade}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono text-text-secondary">{r.score?.toFixed(0)}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-text-muted text-[11px]">
                                {r.value ? `$${r.value.min_usd.toFixed(0)}–$${r.value.max_usd.toFixed(0)}` : '—'}
                              </td>
                              <td className="px-3 py-1.5 text-text-muted text-[11px]">
                                {bestApp?.name ?? (r.recycle ? 'Recycling' : '—')}
                              </td>
                              <td className="px-3 py-1.5 text-center">
                                {r.recycle
                                  ? <XCircle size={13} className="text-red-400 mx-auto" />
                                  : <CheckCircle2 size={13} className="text-emerald-400 mx-auto" />}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Footer info */}
      <div className="flex items-start gap-2 text-[10px] text-text-muted">
        <Info size={11} className="flex-shrink-0 mt-0.5 text-brand-blue" />
        Grade thresholds: A ≥80% SOH · B 65–80% · C 50–65% · D &lt;50%.
        Value estimates based on 2026 second-life market rates (USD/kWh). IEC 62984 aligned.
      </div>
    </div>
  )
}

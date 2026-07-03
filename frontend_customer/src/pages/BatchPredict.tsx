/**
 * BatchPredict — upload a CSV of cells → get RUL for all of them at once.
 * Route: /batch
 */
import { useState, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Upload, Download, RefreshCw, AlertTriangle,
  CheckCircle2, FileText, Zap, X
} from 'lucide-react'

interface RowIn {
  row: number
  chemistry: string
  cap_pct: number
  soh_pct: number
  nom_capacity: number
  int_resistance: number
  temperature: number
  label?: string
}

interface RowOut extends RowIn {
  predicted_rul: number | null
  lower_90: number | null
  upper_90: number | null
  phase: string
  error?: string
}

const EXAMPLE_CSV = `chemistry,soh_pct,nom_capacity,int_resistance,temperature
NMC,97,2.0,0.045,25
LFP,85,1.1,0.060,30
LCO,72,1.05,0.120,25
NCM,91,2.0,0.038,20
NCA,60,2.0,0.180,35`

const PHASE_COLOR: Record<string, string> = {
  Fresh: '#10b981', Aging: '#3b82f6', Knee: '#f59e0b', 'Near-EOL': '#ef4444',
}

function parseCSV(text: string): RowIn[] {
  const lines = text.trim().split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
  return lines.slice(1).map((line, i) => {
    const vals = line.split(',').map(v => v.trim())
    const obj: Record<string, string> = {}
    headers.forEach((h, j) => { obj[h] = vals[j] ?? '' })
    const soh = parseFloat(obj['soh_pct'] || obj['soh'] || '85')
    return {
      row: i,
      label: obj['label'] || obj['cell_id'] || obj['id'] || `Row ${i + 1}`,
      chemistry: (obj['chemistry'] || 'NMC').toUpperCase(),
      soh_pct: soh,
      cap_pct: parseFloat(obj['cap_pct'] || String(soh / 100)),
      nom_capacity: parseFloat(obj['nom_capacity'] || obj['nominal_capacity'] || '1.05'),
      int_resistance: parseFloat(obj['int_resistance'] || obj['ir'] || '0.05'),
      temperature: parseFloat(obj['temperature'] || obj['temp'] || '25'),
    }
  }).filter(r => !isNaN(r.soh_pct))
}

function downloadCSV(rows: RowOut[]) {
  const headers = ['row', 'label', 'chemistry', 'soh_pct', 'nom_capacity', 'predicted_rul', 'lower_90', 'upper_90', 'phase', 'error']
  const lines = [
    headers.join(','),
    ...rows.map(r => headers.map(h => String((r as unknown as Record<string, unknown>)[h] ?? '')).join(','))
  ]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
  a.download = `batteryos_batch_${Date.now()}.csv`; a.click()
}

export default function BatchPredict() {
  const [rows,    setRows]    = useState<RowIn[]>([])
  const [results, setResults] = useState<RowOut[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [done,    setDone]    = useState(false)
  // Raw V/I/T mode: skip the engineered-features schema and POST the file
  // directly to /api/ingest/raw/fleet — backend Coulomb-counts capacity per
  // cell_id segment and runs predict_batch internally.
  const [rawMode,  setRawMode]  = useState(false)
  const [nomCapAh, setNomCapAh] = useState(2.0)
  const [rawFile,  setRawFile]  = useState<File | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const handleFile = (file: File) => {
    if (rawMode) {
      // Raw mode: defer parsing — POST file directly on Run.
      setRawFile(file); setRows([]); setResults([]); setDone(false); setError(null)
      return
    }
    file.text().then(txt => {
      const parsed = parseCSV(txt)
      if (parsed.length === 0) { setError('Could not parse CSV. Check column headers.'); return }
      setRows(parsed); setResults([]); setDone(false); setError(null)
    })
  }

  const runBatch = async () => {
    if (rawMode) {
      if (!rawFile) { setError('Pick a raw V/I/T CSV file first'); return }
      setLoading(true); setError(null)
      try {
        const form = new FormData()
        form.append('file', rawFile)
        form.append('nom_capacity_ah', String(nomCapAh))
        form.append('chemistry', 'auto')
        const res = await fetch('/api/ingest/raw/fleet', { method: 'POST', body: form })
        if (!res.ok) {
          const detail = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }))
          throw new Error(detail.detail ?? `Raw batch failed (${res.status})`)
        }
        const data = await res.json()
        const cells = (data.cells || []) as Array<Record<string, any>>
        const mapped: RowOut[] = cells.map((c, i) => ({
          row:            i + 1,
          label:          c.cell_id ?? 'cell',
          chemistry:      c.summary?.chemistry ?? 'NMC',
          soh_pct:        c.soh_final_pct ?? c.summary?.soh_final_pct ?? 100,
          cap_pct:        (c.soh_final_pct ?? 100) / 100,
          nom_capacity:   nomCapAh,
          int_resistance: 0.025,
          temperature:    25,
          predicted_rul:  c.predicted_rul ?? c.summary?.predicted_rul ?? null,
          lower_90:       c.summary?.lower_90 ?? null,
          upper_90:       c.summary?.upper_90 ?? null,
          phase:          c.summary?.phase ?? 'Aging',
          error:          c.error,
        }))
        setRows(mapped.map(({ predicted_rul: _r, lower_90: _l, upper_90: _u, phase: _p, error: _e, ...rest }) => rest))
        setResults(mapped)
        setDone(true)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Raw batch failed')
      }
      setLoading(false)
      return
    }
    if (rows.length === 0) return
    setLoading(true); setError(null)
    try {
      const payload = rows.map(r => ({
        model_id: 'v10-final',
        chemistry: r.chemistry,
        cap_pct: r.cap_pct,
        soh_pct: r.soh_pct,
        nom_capacity: r.nom_capacity,
        int_resistance: r.int_resistance,
        temperature: r.temperature,
      }))
      const res = await fetch('/api/predict/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`Server ${res.status}`)
      const data: Record<string, unknown>[] = await res.json()
      setResults(rows.map((r, i) => ({
        ...r,
        predicted_rul: data[i]?.predicted_rul != null ? Number(data[i].predicted_rul) : null,
        lower_90:      data[i]?.lower_90 != null ? Number(data[i].lower_90) : null,
        upper_90:      data[i]?.upper_90 != null ? Number(data[i].upper_90) : null,
        phase:         String(data[i]?.phase ?? 'Aging'),
        error:         data[i]?.error as string | undefined,
      })))
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Batch prediction failed')
    }
    setLoading(false)
  }

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Batch Prediction</h1>
        <p className="text-sm text-text-muted mt-0.5">Upload a CSV of cells → get RUL predictions for the whole fleet at once.</p>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-2 text-xs">
        <span className="text-text-muted">CSV type:</span>
        <button onClick={() => { setRawMode(false); setRawFile(null) }}
                className={`px-2.5 py-1 rounded border text-xs ${
                  !rawMode ? 'bg-brand-blue/20 border-brand-blue/40 text-text-primary'
                           : 'border-border-subtle text-text-muted hover:text-text-secondary'}`}>
          Engineered (chemistry / soh / …)
        </button>
        <button onClick={() => { setRawMode(true); setRows([]); setResults([]); setDone(false) }}
                className={`px-2.5 py-1 rounded border text-xs ${
                  rawMode ? 'bg-amber-700/30 border-amber-600/40 text-amber-200'
                          : 'border-border-subtle text-text-muted hover:text-text-secondary'}`}>
          Raw V/I/T (multi-cell)
        </button>
        {rawMode && (
          <label className="ml-2 flex items-center gap-1.5">
            <span className="text-text-muted">nom Ah:</span>
            <input type="number" value={nomCapAh} step={0.1} min={0.1}
                   onChange={e => setNomCapAh(parseFloat(e.target.value) || 2)}
                   className="w-16 bg-bg-panel border border-border-subtle rounded px-1.5 py-0.5 font-mono text-[11px]" />
          </label>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Upload panel */}
        <div className="space-y-4">
          {/* Drop zone */}
          <div
            onClick={() => fileRef.current?.click()}
            onDragOver={e => e.preventDefault()}
            onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleFile(f) }}
            className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer hover:bg-bg-panel transition-all space-y-2 ${
              rawMode ? 'border-amber-600/40 hover:border-amber-500/60' : 'border-border-subtle hover:border-brand-blue/40'}`}
          >
            <Upload size={24} className={`mx-auto ${rawMode ? 'text-amber-400' : 'text-text-muted'}`} />
            <div className="text-xs text-text-secondary font-medium">
              {rawMode ? 'Drop raw V/I/T CSV (with cell_id column) or click to browse'
                       : 'Drop CSV or click to browse'}
            </div>
            <div className="text-[10px] text-text-muted">
              {rawMode ? 'Required columns: cell_id, voltage, current, temperature, time'
                       : 'Required columns: chemistry, soh_pct'}
            </div>
            {rawMode && rawFile && (
              <div className="text-[11px] text-amber-300 mt-1">📎 {rawFile.name}</div>
            )}
            <input ref={fileRef} type="file" accept=".csv,.txt" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f) }} />
          </div>

          {/* Raw mode: simple run panel with no per-row chemistry summary */}
          {rawMode && rawFile && (
            <div className="bg-bg-secondary border border-amber-700/30 rounded-xl p-3 space-y-2">
              <div className="text-xs text-amber-300 font-medium">Raw V/I/T file ready</div>
              <div className="text-[10px] text-text-muted truncate">{rawFile.name}</div>
              <button onClick={runBatch} disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-amber-700 text-white text-xs font-semibold rounded-lg hover:bg-amber-600 transition-colors disabled:opacity-50">
                {loading
                  ? <><RefreshCw size={12} className="animate-spin" /> Running…</>
                  : <><Zap size={12} /> Run Raw Batch (per-cell)</>}
              </button>
            </div>
          )}
          {!rawMode && rows.length > 0 && (
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-secondary font-medium">{rows.length} rows loaded</span>
                <button onClick={() => { setRows([]); setResults([]); setDone(false) }}
                  className="text-text-muted hover:text-red-400 transition-colors">
                  <X size={12} />
                </button>
              </div>
              {/* Chemistry summary */}
              {Object.entries(rows.reduce<Record<string, number>>((a, r) => { a[r.chemistry] = (a[r.chemistry] || 0) + 1; return a }, {}))
                .map(([c, n]) => (
                  <div key={c} className="flex justify-between text-[10px] text-text-muted">
                    <span>{c}</span><span>{n} cells</span>
                  </div>
                ))}
              <button onClick={runBatch} disabled={loading}
                className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
                {loading
                  ? <><RefreshCw size={12} className="animate-spin" /> Running…</>
                  : <><Zap size={12} /> Run Batch ({rows.length} cells)</>}
              </button>
            </div>
          )}

          {/* Example format */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-3 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold text-text-muted uppercase tracking-widest">Example CSV</div>
              <button onClick={() => {
                const blob = new Blob([EXAMPLE_CSV], { type: 'text/csv' })
                const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
                a.download = 'example_batch.csv'; a.click()
              }} className="text-[10px] text-brand-blue hover:underline flex items-center gap-1">
                <Download size={10} /> Download
              </button>
            </div>
            <pre className="text-[9px] font-mono text-text-muted overflow-x-auto">{EXAMPLE_CSV}</pre>
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-2">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 mb-4">
              <AlertTriangle size={13} /> {error}
            </div>
          )}

          <AnimatePresence>
            {done && results.length > 0 && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs text-emerald-400">
                    <CheckCircle2 size={13} /> {results.length} predictions complete
                  </div>
                  <button onClick={() => downloadCSV(results)}
                    className="flex items-center gap-1.5 px-3 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors">
                    <Download size={11} /> Export CSV
                  </button>
                </div>

                <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="border-b border-border-subtle text-text-muted">
                      <tr>
                        <th className="px-3 py-2.5 text-left font-medium">Cell</th>
                        <th className="px-3 py-2.5 text-left font-medium">Chem</th>
                        <th className="px-3 py-2.5 text-right font-medium">SOH %</th>
                        <th className="px-3 py-2.5 text-right font-medium">RUL</th>
                        <th className="px-3 py-2.5 text-right font-medium">90% CI</th>
                        <th className="px-3 py-2.5 text-left font-medium">Phase</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map(r => (
                        <tr key={r.row} className="border-b border-border-subtle/40 hover:bg-bg-panel transition-colors">
                          <td className="px-3 py-2.5 font-mono text-text-primary text-[10px]">{r.label}</td>
                          <td className="px-3 py-2.5 text-text-secondary">{r.chemistry}</td>
                          <td className="px-3 py-2.5 text-right font-mono">
                            <span className={r.soh_pct > 88 ? 'text-emerald-400' : r.soh_pct > 80 ? 'text-amber-400' : 'text-red-400'}>
                              {r.soh_pct}%
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-text-primary">
                            {r.error ? <span className="text-red-400">error</span> : (r.predicted_rul ?? '—')}
                          </td>
                          <td className="px-3 py-2.5 text-right font-mono text-text-muted text-[10px]">
                            {r.lower_90 != null ? `${r.lower_90}–${r.upper_90}` : '—'}
                          </td>
                          <td className="px-3 py-2.5">
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
                              style={{ background: (PHASE_COLOR[r.phase] ?? '#6b7280') + '20', color: PHASE_COLOR[r.phase] ?? '#6b7280' }}>
                              {r.phase}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Summary stats */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Avg RUL', value: Math.round(results.filter(r => r.predicted_rul != null).reduce((s, r) => s + (r.predicted_rul ?? 0), 0) / results.length) + ' cyc' },
                    { label: 'Critical', value: results.filter(r => r.phase === 'Near-EOL' || r.phase === 'Knee').length + ' cells' },
                    { label: 'Healthy', value: results.filter(r => r.phase === 'Fresh').length + ' cells' },
                  ].map(({ label, value }) => (
                    <div key={label} className="bg-bg-secondary border border-border-subtle rounded-lg p-3">
                      <div className="text-[9px] text-text-muted uppercase tracking-wide">{label}</div>
                      <div className="text-sm font-bold text-text-primary mt-0.5">{value}</div>
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-text-muted">
                  Each row is a single snapshot, so the model runs on a <span className="text-amber-400">synthesized 30-cycle window</span> (tagged <code>history_source: synthesized</code>). For measured-history predictions, supply multi-cycle data via Upload &amp; Analyze or Cycler Import.
                </p>
              </motion.div>
            )}
          </AnimatePresence>

          {!done && rows.length === 0 && (
            <div className="flex flex-col items-center justify-center h-48 gap-3 text-text-muted">
              <FileText size={32} className="opacity-20" />
              <div className="text-xs">Upload a CSV to start batch prediction</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

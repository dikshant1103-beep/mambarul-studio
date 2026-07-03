/**
 * Pack Predict — multi-cell pack RUL aggregation.
 * Supports series, parallel, and series-parallel topologies.
 */
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Trash2, Zap, RefreshCw, AlertTriangle, ChevronDown, Network, TrendingDown, TrendingUp } from 'lucide-react'
import ModelSelector from '../components/ui/ModelSelector'

const CHEMISTRIES = ['LCO', 'LFP', 'NMC', 'NCM', 'NCA'] as const
type Chem = typeof CHEMISTRIES[number]

const CHEM_COLOR: Record<Chem, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4',
}

const PHASE_COLOR: Record<string, string> = {
  Fresh: '#10b981', Aging: '#3b82f6', Knee: '#f59e0b', 'Near-EOL': '#ef4444',
}

interface GNNPerCell {
  cell_id: string
  chemistry: string
  base_rul: number
  corrected_rul: number
  delta_pct: number
  stressed: boolean
  history_source?: 'measured' | 'synthesized'
  n_observed_cycles?: number
}

interface GNNInteraction {
  limiting_cell: string
  most_stressed_cell: string
  max_acceleration: number
  pack_imbalance_pct: number
  n_cells_stressed: number
  topology: string
}

interface GNNResult {
  corrected_ruls: number[]
  base_ruls: number[]
  deltas: number[]
  delta_pct: number[]
  pack_rul: number
  pack_lower_90: number
  pack_upper_90: number
  confidence_width: number
  source: string
  interaction_summary: GNNInteraction
  per_cell: GNNPerCell[]
  cell_ids: string[]
}

interface GnnStatus {
  status: string
  params?: number
  checkpoint?: string
  description?: string
  provenance?: {
    source?: string
    n_samples?: number
    n_train?: number
    n_val?: number
    epochs?: number
    best_val_loss?: number
    trained_at?: string
  }
}

interface CellRow {
  id: string
  chemistry: Chem
  cap_pct: number
  capacity: number
  int_resistance: number
  temperature: number
  n_cycles: number | null
  dod_pct: number | null
}

function mkCell(i: number): CellRow {
  return {
    id: `Cell ${i + 1}`, chemistry: 'NMC',
    cap_pct: 0.90, capacity: 25, int_resistance: 0.025, temperature: 25,
    n_cycles: null, dod_pct: null,
  }
}

// ── Health bar ────────────────────────────────────────────────────────────────
function HealthBar({ rul, maxRul, color }: { rul: number; maxRul: number; color: string }) {
  const pct = Math.min(100, (rul / maxRul) * 100)
  return (
    <div className="w-full h-1.5 bg-bg-panel rounded-full overflow-hidden">
      <div className="h-full rounded-full transition-all duration-500"
        style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

// ── Cell editor row ───────────────────────────────────────────────────────────
function CellEditor({ cell, onChange, onRemove, canRemove }: {
  cell: CellRow
  onChange: (c: CellRow) => void
  onRemove: () => void
  canRemove: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const set = (k: keyof CellRow, v: unknown) => onChange({ ...cell, [k]: v })

  return (
    <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
      {/* Summary row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-2 h-2 rounded-full flex-shrink-0"
          style={{ background: CHEM_COLOR[cell.chemistry] }} />
        <input value={cell.id} onChange={e => set('id', e.target.value)}
          className="text-xs font-medium text-text-primary bg-transparent border-none outline-none w-20 min-w-0" />
        <select value={cell.chemistry}
          onChange={e => set('chemistry', e.target.value as Chem)}
          className="text-xs font-mono bg-bg-panel border border-border-subtle rounded px-1.5 py-1 text-text-primary">
          {CHEMISTRIES.map(c => <option key={c}>{c}</option>)}
        </select>
        <div className="flex-1 flex items-center gap-2">
          <span className="text-[10px] text-text-muted">SOH</span>
          <input type="number" value={Math.round(cell.cap_pct * 100)} min={10} max={100}
            onChange={e => set('cap_pct', Number(e.target.value) / 100)}
            className="w-14 px-2 py-1 text-xs font-mono bg-bg-panel border border-border-subtle rounded text-text-primary" />
          <span className="text-[10px] text-text-muted">%</span>
          {cell.dod_pct && (
            <span className="px-1.5 py-0.5 text-[9px] rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              DoD {cell.dod_pct}%
            </span>
          )}
          {cell.n_cycles !== null && (
            <span className="px-1.5 py-0.5 text-[9px] rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
              n={cell.n_cycles}
            </span>
          )}
        </div>
        <button onClick={() => setExpanded(v => !v)}
          className="text-text-muted hover:text-text-primary transition-colors">
          <ChevronDown size={13} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        {canRemove && (
          <button onClick={onRemove} className="text-red-400/60 hover:text-red-400 transition-colors">
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* Expanded fields */}
      {expanded && (
        <div className="px-4 pb-4 grid grid-cols-2 gap-3 border-t border-border-subtle pt-3">
          {([
            ['Capacity (Ah)', 'capacity', 1, 500, 0.1],
            ['Int. Resistance (Ω)', 'int_resistance', 0.001, 0.5, 0.001],
            ['Temperature (°C)', 'temperature', -10, 60, 1],
          ] as const).map(([lbl, key, mn, mx, step]) => (
            <div key={key} className="space-y-1">
              <label className="text-[10px] text-text-muted">{lbl}</label>
              <input type="number" value={cell[key as keyof CellRow] as number}
                min={mn} max={mx} step={step}
                onChange={e => set(key as keyof CellRow, parseFloat(e.target.value))}
                className="w-full px-2 py-1.5 text-xs font-mono bg-bg-panel border border-border-subtle rounded text-text-primary" />
            </div>
          ))}
          <div className="space-y-1">
            <label className="text-[10px] text-text-muted">Observed Cycles (cold-start)</label>
            <div className="flex items-center gap-2">
              <input type="number" min={0} max={30}
                value={cell.n_cycles ?? ''}
                placeholder="≥30"
                onChange={e => set('n_cycles', e.target.value === '' ? null : Number(e.target.value))}
                className="w-full px-2 py-1.5 text-xs font-mono bg-bg-panel border border-border-subtle rounded text-text-primary" />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-text-muted">Depth of Discharge (%)</label>
            <input type="number" min={10} max={100}
              value={cell.dod_pct ?? ''}
              placeholder="100"
              onChange={e => set('dod_pct', e.target.value === '' ? null : Number(e.target.value))}
              className="w-full px-2 py-1.5 text-xs font-mono bg-bg-panel border border-border-subtle rounded text-text-primary" />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function PackPredict() {
  const [cells, setCells]       = useState<CellRow[]>([mkCell(0), mkCell(1), mkCell(2)])
  const [topology, setTopology] = useState<'series' | 'parallel' | 'series_parallel'>('series')
  const [ns, setNs]             = useState(3)
  const [np, setNp]             = useState(1)
  const [modelId, setModelId]   = useState('v10-final')
  const [loading, setLoading]   = useState(false)
  const [result,  setResult]    = useState<Record<string, unknown> | null>(null)
  const [gnnResult, setGnnResult] = useState<GNNResult | null>(null)
  const [gnnLoading, setGnnLoading] = useState(false)
  const [error,   setError]     = useState<string | null>(null)
  const [gnnStatus, setGnnStatus] = useState<GnnStatus | null>(null)
  const [trainStatus, setTrainStatus] = useState<Record<string, unknown> | null>(null)
  const [trainBusy, setTrainBusy] = useState(false)

  function refreshGnnStatus() {
    fetch('/api/predict/pack-gnn/status')
      .then(r => (r.ok ? r.json() : null))
      .then(setGnnStatus)
      .catch(() => {})
  }
  useEffect(() => { refreshGnnStatus() }, [])

  async function startTraining() {
    setTrainBusy(true); setTrainStatus({ state: 'starting' })
    try {
      const res = await fetch('/api/predict/pack-gnn/train', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ epochs: 300, production: true }),
      })
      const d = await res.json()
      if (!res.ok) { setTrainStatus({ state: 'error', message: d.detail || `HTTP ${res.status}` }); setTrainBusy(false); return }
      const poll = setInterval(async () => {
        const s = await fetch('/api/predict/pack-gnn/train/status').then(r => r.json()).catch(() => null)
        if (s) setTrainStatus(s)
        if (s && (s.state === 'done' || s.state === 'error')) { clearInterval(poll); setTrainBusy(false); refreshGnnStatus() }
      }, 1500)
    } catch (e) {
      setTrainStatus({ state: 'error', message: e instanceof Error ? e.message : 'failed' }); setTrainBusy(false)
    }
  }

  // Dominant chemistry = most frequent among cells (drives model auto-select)
  const dominantChem = (() => {
    const freq: Partial<Record<Chem, number>> = {}
    for (const c of cells) freq[c.chemistry] = (freq[c.chemistry] ?? 0) + 1
    return (Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'NMC') as Chem
  })()

  const addCell = () => setCells(c => [...c, mkCell(c.length)])
  const removeCell = (i: number) => setCells(c => c.filter((_, j) => j !== i))
  const updateCell = (i: number, c: CellRow) => setCells(prev => prev.map((x, j) => j === i ? c : x))

  const run = async () => {
    setLoading(true); setError(null); setResult(null); setGnnResult(null)
    try {
      const payload = {
        cells: cells.map(c => ({
          cell_id: c.id,
          chemistry: c.chemistry,
          cap_pct: c.cap_pct,
          capacity: c.capacity,
          int_resistance: c.int_resistance,
          temperature: c.temperature,
          ...(c.n_cycles !== null ? { n_cycles: c.n_cycles } : {}),
          ...(c.dod_pct !== null  ? { dod_pct:  c.dod_pct  } : {}),
        })),
        topology,
        ns, np,
        model_id: modelId,
        pack_name: `Pack (${cells.length} cells, ${topology})`,
      }
      const res = await fetch('/api/predict/pack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`Server ${res.status}`)
      const packData = await res.json()
      setResult(packData)

      // ── GNN Pack Analysis (best-effort, uses predicted RULs as base) ─────────
      setGnnLoading(true)
      try {
        const packCells = (packData.cells ?? []) as Record<string, unknown>[]
        const gnnPayload = {
          cells: cells.map((c, i) => ({
            cell_id: c.id,
            chemistry: c.chemistry,
            soh: c.cap_pct,
            rul: Number(packCells[i]?.predicted_rul ?? 300),
            capacity_ah: c.capacity,
            nom_capacity_ah: c.capacity,
            ir: c.int_resistance,
            fade_rate: 0.0001,
            temperature: c.temperature,
            cycles: c.n_cycles ?? 100,
          })),
          topology,
          ns,
          np,
        }
        const gnnRes = await fetch('/api/predict/pack-gnn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gnnPayload),
        })
        if (gnnRes.ok) setGnnResult(await gnnRes.json())
      } catch { /* GNN is best-effort */ }
      setGnnLoading(false)

    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pack prediction failed')
    }
    setLoading(false)
  }

  const cellResults = result ? (result.cells as Record<string, unknown>[]) : null
  const maxRul = cellResults ? Math.max(...cellResults.map(r => Number(r.predicted_rul))) : 1
  const packRul  = result ? Number(result.pack_rul)     : null
  const packLo   = result ? Number(result.pack_lower_90): null
  const packHi   = result ? Number(result.pack_upper_90): null
  const packPhase = result ? String(result.pack_phase ?? 'Unknown') : null
  const phaseColor = packPhase ? (PHASE_COLOR[packPhase] ?? '#64748b') : '#64748b'

  return (
    <div className="p-3 sm:p-6 max-w-5xl mx-auto space-y-5">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-text-primary">Pack Predict</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Multi-cell pack RUL — series, parallel, or series-parallel topology
        </p>
      </div>

      {/* Pack-GNN model status + manual training (admin) */}
      {gnnStatus && (
        <div className="bg-bg-secondary border border-border-subtle rounded-xl px-4 py-3 space-y-2">
          <div className="flex items-center gap-3 flex-wrap text-xs">
            <span className="font-semibold text-text-secondary">Pack-GNN model</span>
            {gnnStatus.status === 'gnn_loaded' ? (
              <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-medium">⚡ trained GNN active</span>
            ) : (
              <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium">physics-prior (no checkpoint)</span>
            )}
            {gnnStatus.params != null && (
              <span className="text-text-muted">{gnnStatus.params.toLocaleString()} params</span>
            )}
            {gnnStatus.provenance?.source === 'pack_sim' && (
              <span className="text-text-muted">
                pack-sim ×<span className="text-text-secondary">{gnnStatus.provenance.n_samples}</span>
                {gnnStatus.provenance.best_val_loss != null && (
                  <> · val MSE <span className="text-text-secondary">{gnnStatus.provenance.best_val_loss}</span></>
                )}
              </span>
            )}
            <button onClick={startTraining} disabled={trainBusy}
              className="ml-auto px-2.5 py-1 rounded-lg text-xs font-medium bg-brand-blue/15 text-brand-blue border border-brand-blue/25 hover:bg-brand-blue/25 disabled:opacity-50 transition-colors">
              {trainBusy ? 'Training…' : 'Retrain from pack-sim → production'}
            </button>
          </div>
          {trainStatus && (
            <div className={`text-[11px] ${
              trainStatus.state === 'error' ? 'text-red-400'
              : trainStatus.state === 'done' ? 'text-emerald-400' : 'text-text-muted'}`}>
              {String(trainStatus.state)}
              {trainStatus.message ? ` — ${String(trainStatus.message)}` : ''}
              {trainStatus.metrics ? (() => {
                const m = trainStatus.metrics as Record<string, unknown>
                return ` · ${m.n_samples} samples, val MSE ${m.best_val_loss}, ${m.elapsed_s}s`
              })() : ''}
            </div>
          )}
          <p className="text-[10px] text-text-muted">
            Generate data first in the packsim env: <span className="font-mono">python scripts/pack_sim.py --np 2 --ns 2 --samples 50</span>,
            then retrain. Or run <span className="font-mono">python scripts/train_pack_gnn.py --production</span> manually.
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">

        {/* ── LEFT: Configuration ───────────────────────── */}
        <div className="lg:col-span-3 space-y-4">

          {/* Model */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
            <ModelSelector chemistry={dominantChem} value={modelId} onChange={setModelId} />
            <p className="text-[10px] text-text-muted mt-2">
              Auto-selected for dominant chemistry: <span className="font-mono text-text-secondary">{dominantChem}</span>
            </p>
          </div>

          {/* Topology */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Pack Topology</div>
            <div className="flex gap-2">
              {(['series','parallel','series_parallel'] as const).map(t => (
                <button key={t} onClick={() => setTopology(t)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                    topology === t
                      ? 'bg-brand-blue/10 text-brand-blue border-brand-blue/30'
                      : 'border-border-subtle text-text-secondary hover:bg-bg-panel'
                  }`}>
                  {t === 'series_parallel' ? 'Series-Parallel' : t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-text-muted">
              {topology === 'series' && 'Pack RUL = weakest cell (limiting cell determines pack EOL)'}
              {topology === 'parallel' && 'Pack RUL = capacity-weighted mean across all cells'}
              {topology === 'series_parallel' && (
                <div className="flex items-center gap-2">
                  <span>Ns ×</span>
                  <input type="number" value={ns} min={1} max={200}
                    onChange={e => setNs(Number(e.target.value))}
                    className="w-14 px-1.5 py-0.5 font-mono bg-bg-panel border border-border-subtle rounded text-text-primary text-xs" />
                  <span>series groups,</span>
                  <input type="number" value={np} min={1} max={32}
                    onChange={e => setNp(Number(e.target.value))}
                    className="w-14 px-1.5 py-0.5 font-mono bg-bg-panel border border-border-subtle rounded text-text-primary text-xs" />
                  <span>cells per group ({ns}S{np}P)</span>
                </div>
              )}
            </div>
          </div>

          {/* Cells */}
          <div className="space-y-2">
            {cells.map((c, i) => (
              <CellEditor key={i} cell={c}
                onChange={v => updateCell(i, v)}
                onRemove={() => removeCell(i)}
                canRemove={cells.length > 1}
              />
            ))}
            <button onClick={addCell}
              className="w-full flex items-center justify-center gap-2 py-2.5 text-xs font-medium border border-dashed border-border-subtle text-text-muted hover:text-text-secondary hover:bg-bg-panel rounded-xl transition-all">
              <Plus size={13} /> Add Cell
            </button>
          </div>

          {/* Run button */}
          <button onClick={run} disabled={loading}
            className="w-full flex items-center justify-center gap-2 py-3 bg-brand-blue text-white font-semibold text-sm rounded-xl hover:bg-blue-500 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
            {loading
              ? <><RefreshCw size={16} className="animate-spin" /> Running pack inference…</>
              : <><Zap size={16} /> Predict Pack RUL</>}
          </button>

          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-400">
              <AlertTriangle size={13} /> {error}
            </div>
          )}
        </div>

        {/* ── RIGHT: Results ────────────────────────────── */}
        <div className="lg:col-span-2 space-y-4">
          <AnimatePresence mode="wait">
            {!result ? (
              <motion.div key="empty"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="bg-bg-secondary border border-dashed border-border-subtle rounded-xl p-8 flex flex-col items-center justify-center gap-3 text-center min-h-64">
                <Zap size={28} className="text-text-muted" />
                <div className="text-sm text-text-muted">Configure cells and topology, then run</div>
              </motion.div>
            ) : (
              <motion.div key="result"
                initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
                className="space-y-4"
              >
                {/* Pack summary */}
                <div className="bg-bg-secondary border rounded-xl p-5 space-y-4"
                  style={{ borderColor: phaseColor + '40' }}>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="text-[10px] text-text-muted mb-1">Pack RUL</div>
                      <div className="text-4xl font-bold font-mono" style={{ color: phaseColor }}>
                        {packRul?.toFixed(0)}
                      </div>
                      <div className="text-xs text-text-muted mt-0.5">cycles</div>
                    </div>
                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{ background: phaseColor + '20', color: phaseColor }}>
                      {packPhase}
                    </span>
                  </div>

                  <div className="space-y-1 text-[10px] text-text-muted">
                    <div className="flex justify-between">
                      <span>90% CI</span>
                      <span className="font-mono text-text-secondary">{packLo} – {packHi} cycles</span>
                    </div>
                    <div className="relative h-2 bg-bg-panel rounded-full overflow-hidden">
                      {packHi && packLo && packRul && maxRul && (
                        <>
                          <div className="absolute h-full rounded-full"
                            style={{
                              left: `${(packLo / packHi) * 100}%`,
                              width: `${((packHi - packLo) / packHi) * 100}%`,
                              background: phaseColor + '30',
                            }} />
                          <div className="absolute top-0.5 bottom-0.5 w-1.5 rounded-full"
                            style={{ left: `${(packRul / packHi) * 100}%`, background: phaseColor }} />
                        </>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div className="bg-bg-panel rounded-lg p-2">
                      <div className="text-text-muted uppercase tracking-wide">Topology</div>
                      <div className="font-mono text-text-primary mt-0.5">
                        {String(result.topology).toUpperCase()}
                      </div>
                    </div>
                    <div className="bg-bg-panel rounded-lg p-2">
                      <div className="text-text-muted uppercase tracking-wide">Cells</div>
                      <div className="font-mono text-text-primary mt-0.5">{String(result.n_cells)}</div>
                    </div>
                    <div className="bg-bg-panel rounded-lg p-2">
                      <div className="text-text-muted uppercase tracking-wide">RUL Spread</div>
                      <div className="font-mono text-text-primary mt-0.5">{String(result.rul_spread)} cyc</div>
                    </div>
                    <div className="bg-bg-panel rounded-lg p-2">
                      <div className="text-text-muted uppercase tracking-wide">Avg SOH</div>
                      <div className="font-mono text-text-primary mt-0.5">{String(result.pack_soh_avg)}%</div>
                    </div>
                  </div>

                  {!!result.weakest_cell_id && (
                    <div className="flex items-center gap-2 p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-[10px] text-red-400">
                      <AlertTriangle size={11} />
                      Limiting cell: <span className="font-mono font-semibold">{String(result.weakest_cell_id)}</span>
                    </div>
                  )}
                </div>

                {/* Per-cell breakdown */}
                {cellResults && (
                  <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
                    <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Per-Cell Breakdown</div>
                    {cellResults.map((r, i) => {
                      const rul   = Number(r.predicted_rul)
                      const phase = String(r.phase ?? 'Unknown')
                      const col   = PHASE_COLOR[phase] ?? '#64748b'
                      const isWeak = r.cell_id === result.weakest_cell_id
                      return (
                        <div key={i} className={`space-y-1.5 p-2.5 rounded-lg border transition-all ${
                          isWeak ? 'border-red-500/30 bg-red-500/5' : 'border-border-subtle'
                        }`}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-text-primary">{String(r.cell_id)}</span>
                            <div className="flex items-center gap-2">
                              {!!r.dod_multiplier && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">
                                  DoD ×{Number(r.dod_multiplier).toFixed(2)}
                                </span>
                              )}
                              {!!r.cold_start && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400">
                                  cold
                                </span>
                              )}
                              <span className="font-mono font-semibold" style={{ color: col }}>
                                {rul.toFixed(0)} cyc
                              </span>
                              <span className="text-[9px] px-1.5 py-0.5 rounded"
                                style={{ background: col + '20', color: col }}>
                                {phase}
                              </span>
                            </div>
                          </div>
                          <HealthBar rul={rul} maxRul={maxRul} color={col} />
                        </div>
                      )
                    })}
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ── GNN Pack Analysis ─────────────────────────────────────────── */}
      <AnimatePresence>
        {(gnnLoading || gnnResult) && (
          <motion.div key="gnn"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
            className="bg-bg-secondary border border-border-subtle rounded-xl p-5 space-y-4">

            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Network size={15} className="text-brand-blue" />
                <span className="text-xs font-semibold text-text-primary">GNN Pack Analysis</span>
                {gnnResult && (
                  <span className={`px-2 py-0.5 rounded-full text-[9px] font-mono border ${
                    gnnResult.source === 'gnn'
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                  }`}>
                    {gnnResult.source === 'gnn' ? 'GraphSAGE' : 'physics prior'}
                  </span>
                )}
              </div>
              {gnnLoading && <RefreshCw size={13} className="text-text-muted animate-spin" />}
            </div>

            {gnnResult && (
              <>
                {/* Interaction summary */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: 'Pack RUL (GNN)', value: `${gnnResult.pack_rul.toFixed(0)} cyc`, sub: `${gnnResult.pack_lower_90}–${gnnResult.pack_upper_90}` },
                    { label: 'Max Acceleration', value: `-${gnnResult.interaction_summary.max_acceleration}%`, sub: 'RUL reduction', red: true },
                    { label: 'Pack Imbalance', value: `${gnnResult.interaction_summary.pack_imbalance_pct}%`, sub: `${gnnResult.interaction_summary.n_cells_stressed} stressed` },
                    { label: 'Limiting Cell', value: gnnResult.interaction_summary.limiting_cell, sub: `stressed: ${gnnResult.interaction_summary.most_stressed_cell}` },
                  ].map(s => (
                    <div key={s.label} className="bg-bg-panel rounded-lg p-3 space-y-0.5">
                      <div className="text-[10px] text-text-muted uppercase tracking-wide">{s.label}</div>
                      <div className={`text-sm font-mono font-semibold ${s.red ? 'text-red-400' : 'text-text-primary'}`}>{s.value}</div>
                      <div className="text-[9px] text-text-muted font-mono">{s.sub}</div>
                    </div>
                  ))}
                </div>

                {/* Per-cell correction bars */}
                <div className="space-y-2">
                  <div className="text-[10px] text-text-muted uppercase tracking-widest font-semibold">
                    Per-Cell Interaction Correction
                  </div>
                  {gnnResult.per_cell.map(pc => {
                    const pct = pc.delta_pct
                    const isNeg = pct < 0
                    const barPct = Math.min(100, Math.abs(pct) * 4)
                    return (
                      <div key={pc.cell_id} className="space-y-1">
                        <div className="flex items-center justify-between text-[10px]">
                          <div className="flex items-center gap-1.5">
                            {isNeg
                              ? <TrendingDown size={10} className="text-red-400" />
                              : <TrendingUp size={10} className="text-emerald-400" />
                            }
                            <span className="font-medium text-text-primary">{pc.cell_id}</span>
                            <span className="text-text-muted font-mono">{pc.chemistry}</span>
                            {pc.stressed && (
                              <span className="px-1 py-0.5 rounded text-[8px] bg-red-500/10 text-red-400 border border-red-500/20">
                                stressed
                              </span>
                            )}
                            <span
                              title={pc.history_source === 'measured'
                                ? `Model saw ${pc.n_observed_cycles ?? ''} real measured cycles for this cell`
                                : 'No cycle history supplied — the 30-cycle window was synthesized from the single snapshot, so the model cannot see this cell\'s true degradation trajectory. Upload multi-cycle data for a measured prediction.'}
                              className={`px-1 py-0.5 rounded text-[8px] border ${
                                pc.history_source === 'measured'
                                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                  : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                              }`}>
                              {pc.history_source === 'measured'
                                ? `✓ measured${pc.n_observed_cycles ? ` ${pc.n_observed_cycles}c` : ''}`
                                : '⚠ synth'}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 font-mono">
                            <span className="text-text-muted">{pc.base_rul.toFixed(0)} →</span>
                            <span className={isNeg ? 'text-red-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                              {pc.corrected_rul.toFixed(0)} cyc
                            </span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
                              isNeg
                                ? 'bg-red-500/10 text-red-400 border-red-500/20'
                                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                            }`}>
                              {isNeg ? '' : '+'}{pct.toFixed(1)}%
                            </span>
                          </div>
                        </div>
                        <div className="relative h-1.5 bg-bg-panel rounded-full overflow-hidden">
                          <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border-subtle" />
                          <div
                            className={`absolute h-full rounded-full transition-all duration-500 ${isNeg ? 'right-1/2' : 'left-1/2'}`}
                            style={{
                              width: `${barPct / 2}%`,
                              background: isNeg ? '#ef4444' : '#10b981',
                            }}
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

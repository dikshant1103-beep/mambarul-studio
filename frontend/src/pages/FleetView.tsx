/**
 * FleetView — full fleet management page.
 * Data: real from /api/fleet/summary (323 cells, sampled at 60% of each cell's life)
 */
import { useState, useEffect } from 'react'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { Battery, ArrowRight, AlertTriangle, RefreshCw, ShieldAlert, FileText, Sparkles } from 'lucide-react'
import { useAuth } from '../components/AuthGate'

async function downloadExecutiveReport() {
  const res = await fetch('/api/report/executive.pdf')
  if (!res.ok) return
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `batteryos_executive_report_${new Date().toISOString().slice(0, 10)}.pdf`
  a.click()
  URL.revokeObjectURL(url)
}

interface FleetCell {
  cell_id: string
  dataset: string
  chemistry: string
  soh: number
  rul: number
  cycles: number
  max_rul: number
  phase: string
  alert: string
  ir: number
  is_anomaly?: boolean
  anomaly_reason?: string
  z_soh?: number
  z_rul?: number
}

const CHEM_COLOR: Record<string, string> = {
  LCO: '#3b82f6', LFP: '#10b981', NMC: '#f59e0b', NCM: '#8b5cf6', NCA: '#06b6d4',
}
const ALERT_BADGE: Record<string, string> = {
  healthy:  'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
  warning:  'bg-amber-400/10  text-amber-400  border-amber-400/20',
  critical: 'bg-red-500/10    text-red-400    border-red-500/20',
}
const PHASE_COLOR: Record<string, string> = {
  Fresh: 'text-emerald-400', Aging: 'text-amber-400',
  Knee: 'text-orange-400', 'Near-EOL': 'text-red-400',
}

type SortKey = 'cell_id' | 'soh' | 'rul' | 'cycles' | 'chemistry' | 'alert'

export default function FleetView() {
  const navigate = useNavigate()
  const { role } = useAuth()
  const isAdmin = role === 'admin'
  const [cells,   setCells]   = useState<FleetCell[]>([])
  const [loading, setLoading] = useState(true)
  const [sort,    setSort]    = useState<SortKey>('soh')
  const [asc,     setAsc]     = useState(true)
  const [filter,  setFilter]  = useState('')
  const [seeding, setSeeding] = useState(false)
  const [seedMsg, setSeedMsg] = useState<string | null>(null)

  const seedDemoFleet = async () => {
    if (!confirm('Load demo fleet? This adds ~30 demo cells via the backend seed endpoint.')) return
    setSeeding(true); setSeedMsg(null)
    try {
      const r = await fetch('/api/demo/seed', { method: 'POST' })
      if (!r.ok) throw new Error(`status ${r.status}: ${await r.text()}`)
      const data = await r.json()
      setSeedMsg(`Seeded ${data.n_cells ?? '?'} cells`)
      fetchFleet()
    } catch (e: any) {
      setSeedMsg(`error: ${e.message ?? 'failed'}`)
    } finally {
      setSeeding(false)
    }
  }

  const fetchFleet = () => {
    setLoading(true)
    fetch('/api/fleet/anomalies?max_cells=40')
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then((data: FleetCell[]) => setCells(data))
      .catch(() => setCells([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchFleet() }, [])

  const sorted = [...cells]
    .filter(c =>
      c.cell_id.toLowerCase().includes(filter.toLowerCase()) ||
      c.chemistry.toLowerCase().includes(filter.toLowerCase()) ||
      c.dataset.toLowerCase().includes(filter.toLowerCase()) ||
      c.alert.toLowerCase().includes(filter.toLowerCase())
    )
    .sort((a, b) => {
      const va = a[sort], vb = b[sort]
      if (typeof va === 'number' && typeof vb === 'number') return asc ? va - vb : vb - va
      return asc
        ? String(va).localeCompare(String(vb))
        : String(vb).localeCompare(String(va))
    })

  const toggleSort = (key: SortKey) => {
    if (sort === key) setAsc(v => !v)
    else { setSort(key); setAsc(true) }
  }

  const Th = ({ label, k }: { label: string; k: SortKey }) => (
    <th className="px-4 py-2.5 text-left font-medium cursor-pointer hover:text-text-primary select-none"
      onClick={() => toggleSort(k)}>
      <span className="flex items-center gap-1">
        {label}
        {sort === k && <span className="text-brand-blue">{asc ? '↑' : '↓'}</span>}
      </span>
    </th>
  )

  const critical  = cells.filter(c => c.alert === 'critical').length
  const anomalies = cells.filter(c => c.is_anomaly).length

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto space-y-5">

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-text-primary">Fleet View</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {loading ? 'Loading…' : `${cells.length} cells · ${critical} critical · ${anomalies} anomalies`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchFleet} disabled={loading}
            className="flex items-center gap-1.5 px-2.5 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors disabled:opacity-50">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={downloadExecutiveReport}
            className="flex items-center gap-1.5 px-2.5 py-1.5 border border-border-subtle text-xs text-text-secondary rounded-lg hover:bg-bg-panel transition-colors">
            <FileText size={11} /> Executive Report
          </button>
          {isAdmin && (
            <button onClick={seedDemoFleet} disabled={seeding}
              title={seedMsg ?? 'Seed demo fleet via backend /api/demo/seed'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 border border-violet-700 text-xs text-violet-300 rounded-lg hover:bg-violet-900/30 transition-colors disabled:opacity-50">
              <Sparkles size={11} className={seeding ? 'animate-pulse' : ''} />
              {seeding ? 'Seeding…' : 'Demo seed'}
            </button>
          )}
          <button onClick={() => navigate('/upload')}
            className="flex items-center gap-2 px-3 py-1.5 bg-brand-blue text-white text-xs font-medium rounded-lg hover:bg-blue-500 transition-colors">
            <Battery size={13} /> Add Cell Data
          </button>
        </div>
      </div>
      {seedMsg && (
        <div className="text-xs text-violet-300">{seedMsg}</div>
      )}

      {critical > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
          className="flex items-center gap-3 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400">
          <AlertTriangle size={13} />
          <strong>{critical} cell{critical > 1 ? 's' : ''} in critical state</strong> — replacement recommended.
          {anomalies > 0 && (
            <span className="ml-3 flex items-center gap-1 text-amber-400">
              <ShieldAlert size={12} /> {anomalies} statistical anomal{anomalies > 1 ? 'ies' : 'y'} detected
            </span>
          )}
        </motion.div>
      )}

      <input
        value={filter} onChange={e => setFilter(e.target.value)}
        placeholder="Filter by cell ID, chemistry, dataset, or status…"
        className="w-full px-3 py-2 text-xs bg-bg-secondary border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50"
      />

      <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-text-muted text-xs gap-2">
            <RefreshCw size={13} className="animate-spin" /> Loading fleet data from backend…
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="border-b border-border-subtle text-text-muted">
              <tr>
                <Th label="Cell ID"    k="cell_id" />
                <Th label="Dataset"   k="chemistry" />
                <Th label="Chemistry" k="chemistry" />
                <Th label="SOH %"     k="soh" />
                <Th label="RUL (cyc)" k="rul" />
                <th className="px-4 py-2.5 text-left font-medium">RUL bar</th>
                <Th label="Cycles"    k="cycles" />
                <Th label="Phase"     k="alert" />
                <th className="px-4 py-2.5 text-left font-medium">Status</th>
                <th className="px-4 py-2.5 text-left font-medium">Anomaly</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {sorted.map(cell => (
                <tr key={cell.cell_id}
                  className="border-b border-border-subtle/40 hover:bg-bg-panel transition-colors">
                  <td className="px-4 py-3 font-mono font-medium text-text-primary">{cell.cell_id}</td>
                  <td className="px-4 py-3 text-text-muted text-[10px]">{cell.dataset}</td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-0.5 rounded text-[10px] font-bold"
                      style={{
                        background: (CHEM_COLOR[cell.chemistry] ?? '#6b7280') + '20',
                        color: CHEM_COLOR[cell.chemistry] ?? '#6b7280',
                      }}>
                      {cell.chemistry}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono">
                    <span className={cell.soh > 80 ? 'text-emerald-400' : cell.soh > 65 ? 'text-amber-400' : 'text-red-400'}>
                      {cell.soh}%
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-text-primary">{cell.rul.toLocaleString()}</td>
                  <td className="px-4 py-3 w-28">
                    <div className="h-1.5 bg-bg-panel rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(100, (cell.rul / cell.max_rul) * 100)}%`,
                          background: cell.soh > 80 ? '#10b981' : cell.soh > 65 ? '#f59e0b' : '#ef4444',
                        }} />
                    </div>
                  </td>
                  <td className="px-4 py-3 font-mono text-text-muted">{cell.cycles}</td>
                  <td className={`px-4 py-3 font-medium text-xs ${PHASE_COLOR[cell.phase] ?? 'text-text-muted'}`}>
                    {cell.phase}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-0.5 rounded-full border text-[10px] font-medium ${ALERT_BADGE[cell.alert] ?? ALERT_BADGE.warning}`}>
                      {cell.alert}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {cell.is_anomaly ? (
                      <span title={cell.anomaly_reason ?? ''}
                        className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-amber-400/10 text-amber-400 border border-amber-400/20 cursor-help">
                        <ShieldAlert size={9} /> Anomaly
                      </span>
                    ) : (
                      <span className="text-[9px] text-text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => navigate(`/cell/${encodeURIComponent(cell.cell_id)}`, {
                        state: {
                          dataset: cell.dataset,
                          chemistry: cell.chemistry,
                          soh: cell.soh,
                          rul: cell.rul,
                          phase: cell.phase,
                          alert: cell.alert,
                          max_rul: cell.max_rul,
                        }
                      })}
                      className="flex items-center gap-1 text-[10px] text-brand-blue hover:underline">
                      Analyze <ArrowRight size={10} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {!loading && (
        <p className="text-xs text-text-muted text-center">
          Showing cells sampled at ~60% of each cell's total cycle life from CALCE / MIT / KJTU / TJU / NASA datasets.
        </p>
      )}
    </div>
  )
}

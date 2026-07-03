/**
 * BMSLive.tsx — Real-time hardware telemetry dashboard.
 * Polls /api/bms/live + /api/bms/stats every 3 s.
 */
import { useState, useEffect, useCallback } from 'react'
import { Activity, Thermometer, Zap, Battery, AlertTriangle, RefreshCw } from 'lucide-react'

interface LiveCell {
  cell_id: string
  voltage: number | null
  current: number | null
  temperature: number | null
  soc: number | null
  ts: string | null
  pack_id: string
  source: string
}

interface BMSStats {
  cells_online: number
  avg_temp: number | null
  max_temp: number | null
  avg_voltage: number | null
  avg_soc: number | null
  min_soc: number | null
  active_trips: number
}

function StatCard({ label, value, unit, icon: Icon, color = '#3b82f6', warn = false }:
  { label: string; value: string; unit: string; icon: typeof Activity; color?: string; warn?: boolean }) {
  return (
    <div className={`panel p-4 border ${warn ? 'border-red-500/40 bg-red-500/5' : 'border-border-subtle'}`}>
      <div className="flex items-center gap-2 mb-2">
        <Icon size={13} style={{ color }} />
        <span className="text-xs text-text-muted uppercase tracking-wider">{label}</span>
      </div>
      <div className="font-mono font-bold text-2xl" style={{ color: warn ? '#ef4444' : color }}>{value}</div>
      <div className="text-xs text-text-muted mt-0.5">{unit}</div>
    </div>
  )
}

function CellRow({ cell, rul }: { cell: LiveCell; rul?: { rul: number; phase: string } }) {
  const socColor = cell.soc == null ? '#64748b'
    : cell.soc > 60 ? '#10b981' : cell.soc > 30 ? '#f59e0b' : '#ef4444'
  const tempWarn = cell.temperature != null && cell.temperature > 45
  const age = cell.ts ? Math.round((Date.now() - new Date(cell.ts).getTime()) / 1000) : null

  return (
    <tr className="border-b border-border-subtle/50 hover:bg-bg-panel/40 transition-colors">
      <td className="px-3 py-2 font-mono text-xs text-brand-blue">{cell.cell_id}</td>
      <td className="px-3 py-2 font-mono text-xs text-text-primary">{cell.pack_id || '—'}</td>
      <td className="px-3 py-2 font-mono text-xs text-text-primary">
        {cell.voltage != null ? cell.voltage.toFixed(3) + ' V' : '—'}
      </td>
      <td className="px-3 py-2 font-mono text-xs text-text-primary">
        {cell.current != null ? (cell.current >= 0 ? '+' : '') + cell.current.toFixed(2) + ' A' : '—'}
      </td>
      <td className={`px-3 py-2 font-mono text-xs ${tempWarn ? 'text-red-400 font-bold' : 'text-text-primary'}`}>
        {cell.temperature != null ? cell.temperature.toFixed(1) + ' °C' : '—'}
        {tempWarn && ' ⚠'}
      </td>
      <td className="px-3 py-2">
        {cell.soc != null ? (
          <div className="flex items-center gap-2">
            <div className="w-16 h-1.5 bg-bg-elevated rounded-full overflow-hidden">
              <div className="h-full rounded-full" style={{ width: `${cell.soc}%`, backgroundColor: socColor }} />
            </div>
            <span className="font-mono text-xs" style={{ color: socColor }}>{cell.soc.toFixed(1)}%</span>
          </div>
        ) : '—'}
      </td>
      <td className="px-3 py-2 text-xs text-text-muted">{cell.source}</td>
      <td className="px-3 py-2 text-xs text-text-muted">{age != null ? `${age}s ago` : '—'}</td>
      <td className="px-3 py-2 font-mono text-xs">
        {rul
          ? <span className="text-brand-blue font-semibold">{rul.rul.toLocaleString()} <span className="text-text-muted font-normal text-[10px]">{rul.phase}</span></span>
          : <span className="text-text-muted/50">—</span>}
      </td>
    </tr>
  )
}

export default function BMSLive() {
  const [cells, setCells] = useState<LiveCell[]>([])
  const [stats, setStats] = useState<BMSStats | null>(null)
  const [rulMap, setRulMap] = useState<Record<string, { rul: number; phase: string }>>({})
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null)
  const [packFilter, setPackFilter] = useState('')

  const refresh = useCallback(async () => {
    try {
      const [cellsRes, statsRes, rulRes] = await Promise.all([
        fetch('/api/bms/live' + (packFilter ? `?pack_id=${encodeURIComponent(packFilter)}` : '')),
        fetch('/api/bms/stats'),
        fetch('/api/bms/rul'),
      ])
      if (cellsRes.ok) setCells(await cellsRes.json())
      if (statsRes.ok) setStats(await statsRes.json())
      if (rulRes.ok)   setRulMap(await rulRes.json())
      setLastRefresh(new Date())
    } catch { /* backend offline */ }
    finally { setLoading(false) }
  }, [packFilter])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 3000)
    return () => clearInterval(t)
  }, [refresh])

  const packs = [...new Set(cells.map(c => c.pack_id).filter(Boolean))]

  return (
    <div className="px-3 py-4 sm:px-6 sm:py-6 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Activity size={20} className="text-brand-blue" />
            <h1 className="text-xl font-bold text-text-primary">Live BMS Telemetry</h1>
            {stats && stats.active_trips > 0 && (
              <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-bold bg-red-500/15 border border-red-500/40 text-red-400">
                <AlertTriangle size={10} /> {stats.active_trips} TRIP{stats.active_trips > 1 ? 'S' : ''}
              </span>
            )}
          </div>
          <p className="text-text-muted text-xs">
            Auto-refreshes every 3 s — {lastRefresh ? `last at ${lastRefresh.toLocaleTimeString()}` : 'loading…'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {packs.length > 0 && (
            <select value={packFilter} onChange={e => setPackFilter(e.target.value)}
              className="px-2 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50">
              <option value="">All packs</option>
              {packs.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
          <button onClick={refresh}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-secondary hover:text-text-primary hover:border-brand-blue/40 transition-all">
            <RefreshCw size={11} /> Refresh
          </button>
        </div>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
          <StatCard label="Cells Online" value={stats.cells_online.toString()} unit="cells"
            icon={Battery} color="#3b82f6" />
          <StatCard label="Avg Temp" value={stats.avg_temp?.toFixed(1) ?? '—'} unit="°C"
            icon={Thermometer} color="#06b6d4" warn={(stats.max_temp ?? 0) > 45} />
          <StatCard label="Max Temp" value={stats.max_temp?.toFixed(1) ?? '—'} unit="°C"
            icon={Thermometer} color="#f59e0b" warn={(stats.max_temp ?? 0) > 50} />
          <StatCard label="Avg Voltage" value={stats.avg_voltage?.toFixed(3) ?? '—'} unit="V"
            icon={Zap} color="#8b5cf6" />
          <StatCard label="Avg SOC" value={stats.avg_soc?.toFixed(1) ?? '—'} unit="%"
            icon={Activity} color="#10b981" />
          <StatCard label="Active Trips" value={stats.active_trips.toString()} unit="events"
            icon={AlertTriangle} color="#ef4444" warn={stats.active_trips > 0} />
        </div>
      )}

      {/* Cell table */}
      <div className="panel overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <span className="text-sm font-semibold text-text-primary">
            Cell Readings {cells.length > 0 && <span className="text-text-muted font-normal">({cells.length} cells)</span>}
          </span>
        </div>
        {loading ? (
          <div className="px-4 py-12 text-center text-text-muted text-sm">Loading telemetry…</div>
        ) : cells.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <Activity size={32} className="text-text-muted/40 mx-auto mb-3" />
            <div className="text-sm text-text-muted">No live data yet.</div>
            <div className="text-xs text-text-muted mt-1">
              Push telemetry via MQTT, CAN, Modbus, or POST /api/bms/telemetry
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-panel/50">
                  {['Cell ID', 'Pack', 'Voltage', 'Current', 'Temperature', 'SOC', 'Source', 'Updated', 'MambaRUL'].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold text-text-muted uppercase tracking-wider">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cells.map(c => <CellRow key={c.cell_id} cell={c} rul={rulMap[c.cell_id]} />)}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

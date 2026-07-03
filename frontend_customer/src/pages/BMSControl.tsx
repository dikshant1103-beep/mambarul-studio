/**
 * BMSControl.tsx — BMS hardware control commands.
 * Charge/discharge cutoff, cell balancing, thermal, emergency stop.
 */
import { useState, useEffect, useCallback } from 'react'
import { Zap, Thermometer, Sliders, AlertOctagon, History, CheckCircle, XCircle } from 'lucide-react'

interface Command {
  id: string
  command_type: string
  target_id: string
  parameters: Record<string, unknown>
  issued_by: string
  status: string
  ts: string
}

function Section({ title, icon: Icon, children, color = '#3b82f6' }:
  { title: string; icon: typeof Zap; children: React.ReactNode; color?: string }) {
  return (
    <div className="panel p-5">
      <div className="flex items-center gap-2 mb-4">
        <Icon size={14} style={{ color }} />
        <span className="text-sm font-semibold text-text-primary">{title}</span>
      </div>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1">{label}</label>
      {children}
    </div>
  )
}

const inputClass = "w-full px-3 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50"
const btnClass   = (color: string) => `px-4 py-1.5 text-xs font-semibold rounded-lg border transition-all hover:opacity-90 ${color}`

export default function BMSControl() {
  const [commands,    setCommands]    = useState<Command[]>([])
  const [toast,       setToast]       = useState<{ msg: string; ok: boolean } | null>(null)
  // Charge cutoff
  const [ccTarget,    setCcTarget]    = useState('')
  const [ccEnabled,   setCcEnabled]   = useState(true)
  const [ccReason,    setCcReason]    = useState('manual')
  // Balance
  const [balPack,     setBalPack]     = useState('')
  const [balVoltage,  setBalVoltage]  = useState('3.65')
  // Thermal
  const [thTarget,    setThTarget]    = useState('')
  const [thAction,    setThAction]    = useState('cool')
  // Emergency
  const [esTarget,    setEsTarget]    = useState('')
  const [esReason,    setEsReason]    = useState('manual')

  const loadCommands = useCallback(async () => {
    try {
      const r = await fetch('/api/bms/control/commands?limit=50')
      if (r.ok) setCommands(await r.json())
    } catch { /* offline */ }
  }, [])

  useEffect(() => { loadCommands() }, [loadCommands])

  function showToast(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  async function post(url: string, body: object) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json()
      if (r.ok) { showToast(`Command sent (id: ${d.cmd_id})`, true); loadCommands() }
      else showToast(d.detail ?? 'Error', false)
    } catch (e: unknown) { showToast(String(e), false) }
  }

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto">
      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium shadow-lg
          ${toast.ok ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-red-500/15 border-red-500/40 text-red-300'}`}>
          {toast.ok ? <CheckCircle size={14} /> : <XCircle size={14} />}
          {toast.msg}
        </div>
      )}

      <div className="flex items-center gap-3 mb-6">
        <Sliders size={20} className="text-brand-blue" />
        <div>
          <h1 className="text-xl font-bold text-text-primary">BMS Control Panel</h1>
          <p className="text-xs text-text-muted">Issue hardware control commands. All actions are logged.</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 mb-6">
        {/* Charge cutoff */}
        <Section title="Charge / Discharge Cutoff" icon={Zap} color="#3b82f6">
          <div className="space-y-3">
            <Field label="Target (cell ID or pack ID)">
              <input value={ccTarget} onChange={e => setCcTarget(e.target.value)} className={inputClass} placeholder="e.g. CELL-001 or PACK-001" />
            </Field>
            <Field label="Action">
              <div className="flex gap-2">
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="radio" checked={ccEnabled} onChange={() => setCcEnabled(true)} /> Enable cutoff
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input type="radio" checked={!ccEnabled} onChange={() => setCcEnabled(false)} /> Resume
                </label>
              </div>
            </Field>
            <Field label="Reason">
              <input value={ccReason} onChange={e => setCcReason(e.target.value)} className={inputClass} />
            </Field>
            <div className="flex gap-2 pt-1">
              <button disabled={!ccTarget}
                onClick={() => post('/api/bms/control/charge-cutoff', { target_id: ccTarget, enabled: ccEnabled, reason: ccReason })}
                className={btnClass('bg-blue-500/10 border-blue-500/30 text-blue-400 disabled:opacity-40')}>
                Charge Cutoff
              </button>
              <button disabled={!ccTarget}
                onClick={() => post('/api/bms/control/discharge-cutoff', { target_id: ccTarget, enabled: ccEnabled, reason: ccReason })}
                className={btnClass('bg-purple-500/10 border-purple-500/30 text-purple-400 disabled:opacity-40')}>
                Discharge Cutoff
              </button>
            </div>
          </div>
        </Section>

        {/* Cell balancing */}
        <Section title="Cell Balancing" icon={Sliders} color="#10b981">
          <div className="space-y-3">
            <Field label="Pack ID">
              <input value={balPack} onChange={e => setBalPack(e.target.value)} className={inputClass} placeholder="e.g. PACK-001" />
            </Field>
            <Field label="Target voltage (V)">
              <input type="number" step="0.01" value={balVoltage}
                onChange={e => setBalVoltage(e.target.value)} className={inputClass} />
            </Field>
            <button disabled={!balPack}
              onClick={() => post('/api/bms/control/balance', {
                pack_id: balPack, target_voltage: parseFloat(balVoltage), cells: []
              })}
              className={btnClass('bg-emerald-500/10 border-emerald-500/30 text-emerald-400 disabled:opacity-40 mt-2')}>
              Start Balancing
            </button>
          </div>
        </Section>

        {/* Thermal */}
        <Section title="Thermal Management" icon={Thermometer} color="#f59e0b">
          <div className="space-y-3">
            <Field label="Target (cell or pack)">
              <input value={thTarget} onChange={e => setThTarget(e.target.value)} className={inputClass} placeholder="e.g. PACK-001" />
            </Field>
            <Field label="Action">
              <select value={thAction} onChange={e => setThAction(e.target.value)}
                className={inputClass}>
                <option value="cool">Cool</option>
                <option value="heat">Heat</option>
                <option value="emergency_stop">Emergency Stop</option>
              </select>
            </Field>
            <button disabled={!thTarget}
              onClick={() => post('/api/bms/control/thermal', { target_id: thTarget, action: thAction })}
              className={btnClass('bg-amber-500/10 border-amber-500/30 text-amber-400 disabled:opacity-40 mt-2')}>
              Send Thermal Command
            </button>
          </div>
        </Section>

        {/* Emergency stop */}
        <Section title="Emergency Stop" icon={AlertOctagon} color="#ef4444">
          <div className="space-y-3">
            <Field label="Target">
              <input value={esTarget} onChange={e => setEsTarget(e.target.value)} className={inputClass} placeholder="cell ID, pack ID, or 'ALL'" />
            </Field>
            <Field label="Reason">
              <input value={esReason} onChange={e => setEsReason(e.target.value)} className={inputClass} />
            </Field>
            <button disabled={!esTarget}
              onClick={() => {
                if (!window.confirm(`Emergency stop ${esTarget}? This will immediately halt all operations.`)) return
                post('/api/bms/control/emergency-stop', { target_id: esTarget, reason: esReason })
              }}
              className="px-4 py-2 text-xs font-bold rounded-lg border border-red-500/60 bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-all disabled:opacity-40 mt-2">
              🚨 Emergency Stop
            </button>
          </div>
        </Section>
      </div>

      {/* Command history */}
      <div className="panel overflow-hidden">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
          <History size={13} className="text-text-muted" />
          <span className="text-sm font-semibold text-text-primary">Command History</span>
        </div>
        {commands.length === 0 ? (
          <div className="px-4 py-8 text-center text-text-muted text-sm">No commands issued yet</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border-subtle bg-bg-panel/50">
                  {['Type', 'Target', 'Status', 'Issued By', 'Time'].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold text-text-muted uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {commands.map(c => (
                  <tr key={c.id} className="border-b border-border-subtle/50 hover:bg-bg-panel/40">
                    <td className="px-3 py-2 font-mono text-xs text-brand-blue">{c.command_type}</td>
                    <td className="px-3 py-2 text-xs text-text-primary">{c.target_id}</td>
                    <td className="px-3 py-2">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold
                        ${c.status === 'sent' || c.status === 'ack'
                          ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                          : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'}`}>
                        {c.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-muted">{c.issued_by}</td>
                    <td className="px-3 py-2 text-xs text-text-muted">{new Date(c.ts).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

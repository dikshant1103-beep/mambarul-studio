/**
 * BMSAdapters.tsx — Hardware adapter configuration.
 * MQTT broker, CAN bus, Modbus TCP — all three in one page.
 */
import { useState, useEffect, useCallback } from 'react'
import { Wifi, Cpu, Network, CheckCircle, XCircle, Play, Square, RefreshCw, Send } from 'lucide-react'

interface AdapterStatus {
  mqtt:   { host: string; port: number; connected: boolean; user: string }
  can:    { interface: string; channel: string; bitrate: number; connected: boolean }
  modbus: { host: string; port: number; unit_id: number; connected: boolean; poll_active: boolean; cells: number; pack_id: string }
}

const inputClass = "w-full px-3 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50"

function ConnBadge({ connected }: { connected: boolean }) {
  return (
    <span className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border
      ${connected ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border-red-500/30 text-red-400'}`}>
      {connected ? <><CheckCircle size={9}/> Connected</> : <><XCircle size={9}/> Disconnected</>}
    </span>
  )
}

export default function BMSAdapters() {
  const [status, setStatus]     = useState<AdapterStatus | null>(null)
  const [toast,  setToast]      = useState<{ msg: string; ok: boolean } | null>(null)
  // MQTT
  const [mqHost, setMqHost]     = useState('')
  const [mqPort, setMqPort]     = useState('1883')
  const [mqUser, setMqUser]     = useState('')
  const [mqPass, setMqPass]     = useState('')
  // CAN
  const [canIface, setCanIface] = useState('virtual')
  const [canChan,  setCanChan]  = useState('vcan0')
  const [canBps,   setCanBps]   = useState('500000')
  // Modbus
  const [mbHost,   setMbHost]   = useState('')
  const [mbPort,   setMbPort]   = useState('502')
  const [mbUnit,   setMbUnit]   = useState('1')
  const [mbCells,  setMbCells]  = useState('8')
  const [mbPack,   setMbPack]   = useState('PACK-MB-01')
  const [mbInterval, setMbInterval] = useState('5')
  // Simulate
  const [simCell,  setSimCell]  = useState('SIM-CELL-001')
  const [simCount, setSimCount] = useState('10')
  const [simPack,  setSimPack]  = useState('')
  const [simResult, setSimResult] = useState<{ simulated: number; trips: number } | null>(null)

  const loadStatus = useCallback(async () => {
    try {
      const r = await fetch('/api/bms/adapters/status')
      if (r.ok) {
        const d: AdapterStatus = await r.json()
        setStatus(d)
        if (d.mqtt.host)   setMqHost(d.mqtt.host)
        if (d.modbus.host) setMbHost(d.modbus.host)
      }
    } catch { /* offline */ }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  function toast_(msg: string, ok: boolean) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 3500)
  }

  async function post(url: string, body: object) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await r.json()
      if (r.ok) { toast_('Success', true); loadStatus(); return d }
      else { toast_(d.detail ?? 'Error', false); return null }
    } catch (e: unknown) { toast_(String(e), false); return null }
  }

  return (
    <div className="px-6 py-6 max-w-5xl mx-auto">
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium shadow-lg
          ${toast.ok ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300' : 'bg-red-500/15 border-red-500/40 text-red-300'}`}>
          {toast.ok ? <CheckCircle size={14}/> : <XCircle size={14}/>}
          {toast.msg}
        </div>
      )}

      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Network size={20} className="text-brand-blue" />
            <h1 className="text-xl font-bold text-text-primary">Hardware Adapters</h1>
          </div>
          <p className="text-xs text-text-muted">Configure MQTT, CAN bus, and Modbus TCP connections</p>
        </div>
        <button onClick={loadStatus}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-secondary hover:text-text-primary transition-all">
          <RefreshCw size={11}/> Refresh status
        </button>
      </div>

      <div className="space-y-4">
        {/* MQTT */}
        <div className="panel p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Wifi size={14} className="text-brand-blue" />
              <span className="text-sm font-semibold text-text-primary">MQTT Broker</span>
            </div>
            {status && <ConnBadge connected={status.mqtt.connected} />}
          </div>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <div><label className="block text-xs text-text-muted mb-1">Host</label>
              <input value={mqHost} onChange={e => setMqHost(e.target.value)} className={inputClass} placeholder="192.168.1.100" /></div>
            <div><label className="block text-xs text-text-muted mb-1">Port</label>
              <input value={mqPort} onChange={e => setMqPort(e.target.value)} className={inputClass} type="number" /></div>
            <div><label className="block text-xs text-text-muted mb-1">Username</label>
              <input value={mqUser} onChange={e => setMqUser(e.target.value)} className={inputClass} /></div>
            <div><label className="block text-xs text-text-muted mb-1">Password</label>
              <input type="password" value={mqPass} onChange={e => setMqPass(e.target.value)} className={inputClass} /></div>
          </div>
          <div className="text-xs text-text-muted mb-3">Subscribes to <code className="font-mono bg-bg-elevated px-1 rounded">batteryos/#</code> — topic pattern: <code className="font-mono bg-bg-elevated px-1 rounded">batteryos/cell/&#123;cell_id&#125;/telemetry</code></div>
          <button disabled={!mqHost}
            onClick={() => post('/api/bms/adapters/mqtt', { host: mqHost, port: parseInt(mqPort), user: mqUser, password: mqPass })}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg border border-brand-blue/40 bg-brand-blue/10 text-brand-blue hover:bg-brand-blue/20 disabled:opacity-40 transition-all">
            <Play size={10}/> Connect MQTT
          </button>
        </div>

        {/* CAN bus */}
        <div className="panel p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Cpu size={14} className="text-purple-400" />
              <span className="text-sm font-semibold text-text-primary">CAN Bus</span>
            </div>
            {status && <ConnBadge connected={status.can.connected} />}
          </div>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div><label className="block text-xs text-text-muted mb-1">Interface type</label>
              <select value={canIface} onChange={e => setCanIface(e.target.value)} className={inputClass}>
                <option value="socketcan">socketcan (Linux)</option>
                <option value="virtual">virtual (test)</option>
                <option value="kvaser">kvaser</option>
                <option value="peak">peak</option>
              </select>
            </div>
            <div><label className="block text-xs text-text-muted mb-1">Channel</label>
              <input value={canChan} onChange={e => setCanChan(e.target.value)} className={inputClass} placeholder="vcan0 / can0" /></div>
            <div><label className="block text-xs text-text-muted mb-1">Bitrate</label>
              <select value={canBps} onChange={e => setCanBps(e.target.value)} className={inputClass}>
                <option value="125000">125 kbps</option>
                <option value="250000">250 kbps</option>
                <option value="500000">500 kbps</option>
                <option value="1000000">1 Mbps</option>
              </select>
            </div>
          </div>
          <button onClick={() => post('/api/bms/adapters/can', { interface: canIface, channel: canChan, bitrate: parseInt(canBps) })}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg border border-purple-500/40 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 disabled:opacity-40 transition-all">
            <Play size={10}/> Connect CAN
          </button>
        </div>

        {/* Modbus TCP */}
        <div className="panel p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Network size={14} className="text-amber-400" />
              <span className="text-sm font-semibold text-text-primary">Modbus TCP</span>
            </div>
            {status && (
              <div className="flex items-center gap-2">
                {status.modbus.poll_active && (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
                    <span className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" /> Polling
                  </span>
                )}
                <ConnBadge connected={status.modbus.connected} />
              </div>
            )}
          </div>
          <div className="text-xs text-text-muted mb-3">
            Register map: 40001–40100 voltages (×0.001 V) · 40101–40200 temps (×0.1 °C) · 40201 current (signed ×0.01 A)
          </div>
          <div className="grid grid-cols-5 gap-3 mb-3">
            <div className="col-span-2"><label className="block text-xs text-text-muted mb-1">PLC Host</label>
              <input value={mbHost} onChange={e => setMbHost(e.target.value)} className={inputClass} placeholder="192.168.1.50" /></div>
            <div><label className="block text-xs text-text-muted mb-1">Port</label>
              <input value={mbPort} onChange={e => setMbPort(e.target.value)} className={inputClass} type="number" /></div>
            <div><label className="block text-xs text-text-muted mb-1">Unit ID</label>
              <input value={mbUnit} onChange={e => setMbUnit(e.target.value)} className={inputClass} type="number" /></div>
            <div><label className="block text-xs text-text-muted mb-1">Cells</label>
              <input value={mbCells} onChange={e => setMbCells(e.target.value)} className={inputClass} type="number" /></div>
          </div>
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div><label className="block text-xs text-text-muted mb-1">Pack ID</label>
              <input value={mbPack} onChange={e => setMbPack(e.target.value)} className={inputClass} /></div>
            <div><label className="block text-xs text-text-muted mb-1">Poll interval (s)</label>
              <input value={mbInterval} onChange={e => setMbInterval(e.target.value)} className={inputClass} type="number" min="1" max="3600" /></div>
          </div>
          <div className="flex gap-2">
            <button disabled={!mbHost}
              onClick={() => post('/api/bms/modbus/config', { host: mbHost, port: parseInt(mbPort), unit_id: parseInt(mbUnit), cells: parseInt(mbCells), pack_id: mbPack })}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 disabled:opacity-40 transition-all">
              <Play size={10}/> Connect
            </button>
            <button disabled={!status?.modbus.connected}
              onClick={() => post('/api/bms/modbus/start-poll', { interval_seconds: parseInt(mbInterval) })}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 disabled:opacity-40 transition-all">
              <Play size={10}/> Start Poll
            </button>
            <button disabled={!status?.modbus.poll_active}
              onClick={() => post('/api/bms/modbus/stop-poll', {})}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg border border-red-500/40 bg-red-500/10 text-red-400 hover:bg-red-500/20 disabled:opacity-40 transition-all">
              <Square size={10}/> Stop Poll
            </button>
            <button disabled={!status?.modbus.connected}
              onClick={() => post('/api/bms/modbus/poll', {})}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg border border-border-subtle bg-bg-panel text-text-secondary hover:text-text-primary disabled:opacity-40 transition-all">
              <RefreshCw size={10}/> Manual Poll
            </button>
          </div>
        </div>

        {/* Simulator */}
        <div className="panel p-5 border-dashed border-border-subtle">
          <div className="flex items-center gap-2 mb-4">
            <Send size={14} className="text-text-muted" />
            <span className="text-sm font-semibold text-text-primary">Simulator</span>
            <span className="px-1.5 py-0.5 text-[10px] rounded bg-bg-elevated text-text-muted border border-border-subtle">dev/test</span>
          </div>
          <div className="grid grid-cols-4 gap-3 mb-3">
            <div className="col-span-2"><label className="block text-xs text-text-muted mb-1">Cell ID</label>
              <input value={simCell} onChange={e => setSimCell(e.target.value)} className={inputClass} /></div>
            <div><label className="block text-xs text-text-muted mb-1">Pack ID</label>
              <input value={simPack} onChange={e => setSimPack(e.target.value)} className={inputClass} /></div>
            <div><label className="block text-xs text-text-muted mb-1">Frame count</label>
              <input type="number" value={simCount} onChange={e => setSimCount(e.target.value)} className={inputClass} min="1" max="1000" /></div>
          </div>
          <div className="flex items-center gap-3">
            <button disabled={!simCell}
              onClick={async () => {
                const d = await post('/api/bms/simulate', {
                  cell_id: simCell, pack_id: simPack, count: parseInt(simCount),
                  voltage: 3.75, current: -2.0, temperature: 28.0
                })
                if (d) setSimResult(d)
              }}
              className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-semibold rounded-lg border border-border-subtle bg-bg-panel text-text-secondary hover:text-text-primary disabled:opacity-40 transition-all">
              <Send size={10}/> Push Simulated Frames
            </button>
            {simResult && (
              <span className="text-xs text-text-muted">
                Pushed {simResult.simulated} frames · {simResult.trips} trips
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

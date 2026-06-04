import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Zap } from 'lucide-react'

const CHEM_INFO = [
  { id: 'LCO', name: 'Lithium Cobalt Oxide', formula: 'LiCoO₂', color: '#3b82f6', datasets: 'CALCE CS2/CX2', protocol: 'CC-CV 1C/1C', temp: '25°C', cycles: '~300' },
  { id: 'LFP', name: 'Lithium Iron Phosphate', formula: 'LiFePO₄', color: '#10b981', datasets: 'MIT 2017-2018', protocol: 'Fast charge variable C', temp: '30°C', cycles: '~900' },
  { id: 'NMC', name: 'Nickel Manganese Cobalt', formula: 'LiNiₓMnᵧCoᵤO₂', color: '#f59e0b', datasets: 'KJTU / Oxford', protocol: 'CC-CV 0.5C/0.5C', temp: '25-40°C', cycles: '~500-8000' },
  { id: 'NCM', name: 'Nickel Cobalt Manganese', formula: 'LiNiCoMnO₂', color: '#8b5cf6', datasets: 'TJU', protocol: 'CC-CV 0.5C/1C', temp: '25-45°C', cycles: '~540' },
]

function LabCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tick = useRef(0)
  const raf  = useRef<number>()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height

    // Voltage waveform buffer
    const voltageHistory: number[] = Array(120).fill(3.7)
    const currentHistory: number[] = Array(120).fill(0)
    const tempHistory: number[] = Array(120).fill(25)

    const draw = () => {
      tick.current++
      const T = tick.current
      ctx.clearRect(0, 0, W, H)

      // Background
      ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, W, H)

      // Grid
      ctx.strokeStyle = '#1e3a5f22'; ctx.lineWidth = 0.5
      for (let g = 0; g < W; g += 40) { ctx.beginPath(); ctx.moveTo(g, 0); ctx.lineTo(g, H); ctx.stroke() }
      for (let g = 0; g < H; g += 40) { ctx.beginPath(); ctx.moveTo(0, g); ctx.lineTo(W, g); ctx.stroke() }

      const phase = (T % 400) / 400  // 0→1 = one charge/discharge cycle
      const isCharging = phase < 0.6

      // ── BATTERY BANK ──────────────────────────────────────────────
      const battX = 60, battY = 60, battW = 120, battH = 200
      const numCells = 4
      for (let ci = 0; ci < numCells; ci++) {
        const bx = battX + ci * (battW + 16)
        const cphase = (phase + ci * 0.05) % 1
        const soh = 0.95 - ci * 0.08
        const fillH = Math.floor((isCharging ? cphase / 0.6 : 1 - (cphase - 0.6) / 0.4) * battH * soh)

        // Terminal
        ctx.fillStyle = '#475569'
        ctx.fillRect(bx + battW * 0.35, bx > 0 ? bx - 60 : battY - 12, battW * 0.3, 12)

        // Body
        ctx.strokeStyle = isCharging ? '#10b981' : '#3b82f6'
        ctx.lineWidth = 2
        ctx.strokeRect(bx, battY, battW, battH)

        // Fill with gradient
        const grad = ctx.createLinearGradient(bx, battY + battH, bx, battY + battH - fillH)
        grad.addColorStop(0, (isCharging ? '#10b981' : '#3b82f6') + 'cc')
        grad.addColorStop(1, (isCharging ? '#34d399' : '#60a5fa') + 'ff')
        ctx.fillStyle = grad
        ctx.fillRect(bx + 2, battY + battH - fillH + 2, battW - 4, fillH - 2)

        // SOH label
        ctx.font = 'bold 11px JetBrains Mono'
        ctx.fillStyle = '#94a3b8'; ctx.textAlign = 'center'
        ctx.fillText(`SOH${(soh*100).toFixed(0)}%`, bx + battW/2, battY + battH + 16)
        ctx.fillText(`Cell ${ci+1}`, bx + battW/2, battY + battH + 30)

        // Charge indicator
        if (isCharging) {
          const arrowY = battY + battH - fillH - 10
          ctx.fillStyle = '#10b981'
          ctx.beginPath(); ctx.moveTo(bx+battW/2-8, arrowY+12); ctx.lineTo(bx+battW/2, arrowY); ctx.lineTo(bx+battW/2+8, arrowY+12)
          ctx.fill()
        }
      }

      // ── CYCLER (power supply) ──────────────────────────────────────
      const cycX = 580, cycY = 60
      ctx.fillStyle = '#0e1829'; ctx.fillRect(cycX, cycY, 180, 140)
      ctx.strokeStyle = '#1e3a5f'; ctx.lineWidth = 1.5; ctx.strokeRect(cycX, cycY, 180, 140)

      // Screen
      ctx.fillStyle = '#0d1f0d'; ctx.fillRect(cycX+8, cycY+8, 164, 80)
      ctx.font = '10px JetBrains Mono'; ctx.fillStyle = '#4ade80'; ctx.textAlign = 'left'
      ctx.fillText(`MODE: ${isCharging ? 'CC-CHARGE' : 'CC-DISCHARGE'}`, cycX+12, cycY+24)
      const volt = isCharging ? 3.0 + phase/0.6 * 1.2 : 4.2 - (phase-0.6)/0.4 * 1.5
      ctx.fillText(`VOLT: ${volt.toFixed(3)} V`, cycX+12, cycY+38)
      const curr = isCharging ? 1.05 : -1.05
      ctx.fillText(`CURR: ${curr.toFixed(2)} A`, cycX+12, cycY+52)
      ctx.fillText(`TEMP: ${(25 + Math.sin(T*0.02)*2).toFixed(1)} °C`, cycX+12, cycY+66)
      ctx.fillText(`CYCLE: ${Math.floor(T/400)+1}`, cycX+12, cycY+80)

      // Buttons
      ctx.fillStyle = '#10b981'; ctx.fillRect(cycX+10, cycY+100, 40, 20)
      ctx.fillStyle = '#ef4444'; ctx.fillRect(cycX+58, cycY+100, 40, 20)
      ctx.font = '9px Inter'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'
      ctx.fillText('START', cycX+30, cycY+114); ctx.fillText('STOP', cycX+78, cycY+114)

      // Label
      ctx.font = 'bold 11px Inter'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'center'
      ctx.fillText('BATTERY CYCLER', cycX+90, cycY+130)

      // ── THERMAL CHAMBER ───────────────────────────────────────────
      const chamX = 580, chamY = 230
      ctx.fillStyle = '#0e1c1f'; ctx.fillRect(chamX, chamY, 180, 100)
      ctx.strokeStyle = '#0d9488'; ctx.lineWidth = 1.5; ctx.strokeRect(chamX, chamY, 180, 100)

      // Temperature display
      const temp = 25 + Math.sin(T*0.015)*3
      ctx.font = 'bold 20px JetBrains Mono'; ctx.fillStyle = '#2dd4bf'; ctx.textAlign = 'center'
      ctx.fillText(`${temp.toFixed(1)}°C`, chamX+90, chamY+45)
      ctx.font = '9px Inter'; ctx.fillStyle = '#0d9488'; ctx.textAlign = 'center'
      ctx.fillText('THERMAL CHAMBER', chamX+90, chamY+20)
      ctx.fillText('SET: 25.0°C  TOL: ±0.5°C', chamX+90, chamY+62)

      // Heating coil animation
      for (let ci = 0; ci < 5; ci++) {
        const cx = chamX + 30 + ci * 24
        const brightness = 0.3 + 0.7*Math.abs(Math.sin(T*0.06+ci))
        ctx.beginPath(); ctx.arc(cx, chamY+82, 6, 0, Math.PI*2)
        ctx.fillStyle = `rgba(255,100,0,${brightness})`; ctx.fill()
      }

      // ── DAQ SYSTEM ────────────────────────────────────────────────
      const daqX = 400, daqY = 60
      ctx.fillStyle = '#0e1429'; ctx.fillRect(daqX, daqY, 160, 120)
      ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1.5; ctx.strokeRect(daqX, daqY, 160, 120)

      ctx.font = '9px Inter'; ctx.fillStyle = '#2563eb'; ctx.textAlign = 'center'
      ctx.fillText('DATA ACQUISITION', daqX+80, daqY+16)

      // Channel indicators
      const channels = ['V', 'I', 'T', 'IR']
      channels.forEach((ch, ci) => {
        const cx = daqX + 20 + ci*36
        const active = Math.sin(T*0.08+ci*1.2) > 0
        ctx.beginPath(); ctx.arc(cx, daqY+35, 8, 0, Math.PI*2)
        ctx.fillStyle = active ? '#3b82f6' : '#1e3a5f'; ctx.fill()
        ctx.font = 'bold 8px JetBrains Mono'; ctx.fillStyle = '#fff'; ctx.textAlign = 'center'
        ctx.fillText(ch, cx, daqY+38)
        // Value
        ctx.font = '8px JetBrains Mono'; ctx.fillStyle = '#60a5fa'; ctx.textAlign = 'center'
        const vals = [volt.toFixed(2), curr.toFixed(2), temp.toFixed(1), '0.05']
        ctx.fillText(vals[ci], cx, daqY+55)
      })

      ctx.font = '9px JetBrains Mono'; ctx.fillStyle = '#475569'; ctx.textAlign = 'center'
      ctx.fillText('SAMPLE RATE: 1 Hz', daqX+80, daqY+75)
      ctx.fillText(`TIME: ${(T/10).toFixed(1)}s`, daqX+80, daqY+90)

      // Wires from DAQ to batteries
      ctx.strokeStyle = '#3b82f644'; ctx.lineWidth = 2
      ctx.setLineDash([5,3]); ctx.lineDashOffset = -(T * 1.5) % 8
      ctx.beginPath(); ctx.moveTo(battX + 2*(battW+16) + battW, battY+30); ctx.lineTo(daqX, daqY+40)
      ctx.stroke(); ctx.setLineDash([])

      // Wires from cycler to batteries
      ctx.strokeStyle = isCharging ? '#10b98144' : '#3b82f644'; ctx.lineWidth = 2.5
      ctx.setLineDash([8,4]); ctx.lineDashOffset = -(T * 2) % 12
      ctx.beginPath(); ctx.moveTo(battX + (numCells-1)*(battW+16) + battW+2, battY+battH/2)
      ctx.lineTo(cycX, cycY+60)
      ctx.stroke(); ctx.setLineDash([])

      // ── REAL-TIME SIGNAL PLOTS ────────────────────────────────────
      const plotY = 380, plotH = 90, plotW = (W-40)/3-8

      // Update histories
      voltageHistory.shift(); voltageHistory.push(volt)
      currentHistory.shift(); currentHistory.push(curr)
      tempHistory.shift(); tempHistory.push(temp)

      const drawSignal = (ox: number, oy: number, data: number[], color: string, label: string, unit: string) => {
        ctx.fillStyle = '#0e1829'; ctx.fillRect(ox, oy, plotW, plotH)
        ctx.strokeStyle = '#1e3a5f'; ctx.lineWidth = 1; ctx.strokeRect(ox, oy, plotW, plotH)

        const mn = Math.min(...data), mx = Math.max(...data), rng = mx - mn || 0.1
        ctx.beginPath()
        data.forEach((v, i) => {
          const px = ox + (i/data.length)*plotW
          const py = oy + plotH - ((v-mn)/rng)*(plotH-8) - 4
          i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py)
        })
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke()

        // Fill under
        ctx.lineTo(ox+plotW, oy+plotH); ctx.lineTo(ox, oy+plotH)
        ctx.fillStyle = color + '22'; ctx.fill()

        ctx.font = '9px Inter'; ctx.fillStyle = color; ctx.textAlign = 'left'
        ctx.fillText(`${label}: ${data[data.length-1]?.toFixed(3)} ${unit}`, ox+4, oy+12)
      }

      drawSignal(20,        plotY, voltageHistory, '#3b82f6', 'Voltage', 'V')
      drawSignal(20+plotW+8, plotY, currentHistory, '#10b981', 'Current', 'A')
      drawSignal(20+plotW*2+16, plotY, tempHistory, '#f59e0b', 'Temp', '°C')

      // Labels
      ctx.font = 'bold 11px Inter'; ctx.fillStyle = '#475569'; ctx.textAlign = 'center'
      ctx.fillText('Live Sensor Streams', W/2, plotY-8)

      raf.current = requestAnimationFrame(draw)
    }

    raf.current = requestAnimationFrame(draw)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [])

  return (
    <canvas ref={canvasRef} width={800} height={500}
      className="rounded-xl border border-border-subtle w-full"
      style={{ background: '#0a0e1a' }}
    />
  )
}

export default function BatteryLab() {
  const [selectedChem, setSelectedChem] = useState(CHEM_INFO[0])

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Zap size={22} className="text-brand-amber" />
          <h1 className="text-2xl font-bold text-text-primary">Battery Lab — Experimental Setup</h1>
        </div>
        <p className="text-text-secondary">Animated battery cycling laboratory — DAQ system, cycler, thermal chamber, real-time sensor streams</p>
      </div>

      <div className="grid grid-cols-3 gap-5">
        {/* Main lab animation */}
        <div className="col-span-2 space-y-4">
          <LabCanvas />
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: 'Battery Cycler', desc: 'Controls CC-CV charge/discharge protocol. Sets current, voltage cutoffs.', color: '#3b82f6' },
              { label: 'Thermal Chamber', desc: 'Maintains constant temperature ±0.5°C. Critical for reproducibility.', color: '#06b6d4' },
              { label: 'DAQ System', desc: 'Samples V, I, T, IR at 1Hz. Stores per-cycle aggregate features.', color: '#10b981' },
            ].map(c => (
              <div key={c.label} className="panel p-3" style={{ borderColor: c.color + '44' }}>
                <div className="text-xs font-semibold mb-1" style={{ color: c.color }}>{c.label}</div>
                <div className="text-xs text-text-muted">{c.desc}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Chemistry info panel */}
        <div className="space-y-3">
          <div className="panel p-4">
            <div className="metric-label mb-2">Select Chemistry</div>
            <div className="space-y-1">
              {CHEM_INFO.map(c => (
                <button key={c.id} onClick={() => setSelectedChem(c)}
                  className="w-full text-left px-3 py-2 rounded-lg border transition-all text-xs"
                  style={selectedChem.id === c.id
                    ? { borderColor: c.color + '66', backgroundColor: c.color + '11', color: c.color }
                    : { borderColor: '#1e3a5f', color: '#64748b' }}>
                  <span className="font-bold">{c.id}</span> — {c.name.split(' ').slice(-2).join(' ')}
                </button>
              ))}
            </div>
          </div>

          <AnimatePresence mode="wait">
            <motion.div key={selectedChem.id}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
              className="panel p-4" style={{ borderColor: selectedChem.color + '44' }}>
              <div className="text-sm font-bold mb-2" style={{ color: selectedChem.color }}>{selectedChem.id}</div>
              <div className="text-xs text-text-secondary mb-3">{selectedChem.name}</div>
              <code className="text-xs font-mono text-text-accent block mb-3 bg-bg-primary px-2 py-1.5 rounded">{selectedChem.formula}</code>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between"><span className="text-text-muted">Dataset:</span><span className="text-text-secondary font-mono">{selectedChem.datasets}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Protocol:</span><span className="text-text-secondary">{selectedChem.protocol}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Temperature:</span><span className="font-mono text-text-secondary">{selectedChem.temp}</span></div>
                <div className="flex justify-between"><span className="text-text-muted">Avg Cycles:</span><span className="font-mono" style={{color:selectedChem.color}}>{selectedChem.cycles}</span></div>
              </div>
            </motion.div>
          </AnimatePresence>

          <div className="panel p-4">
            <div className="text-xs font-semibold text-text-secondary mb-2">Cycling Protocol Flow</div>
            {['Constant Current (CC)\nCharge to Vmax', 'Constant Voltage (CV)\nAt Vmax until I drops', 'Rest (30 min)', 'CC Discharge\nTo Vcutoff', 'Measure capacity\nRecord features'].map((step, i) => (
              <div key={i} className="flex items-start gap-2 mb-1.5">
                <motion.span className="w-4 h-4 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-0.5"
                  style={{ backgroundColor: selectedChem.color + '33', color: selectedChem.color }}
                  animate={{ opacity: [0.5, 1, 0.5] }} transition={{ duration: 1, delay: i * 0.3, repeat: Infinity }}>
                  {i+1}
                </motion.span>
                <div className="text-xs text-text-muted whitespace-pre-line">{step}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

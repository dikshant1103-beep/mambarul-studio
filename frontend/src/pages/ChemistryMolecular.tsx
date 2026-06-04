import { useState, useEffect, useRef } from 'react'

import { Atom, Play, Pause } from 'lucide-react'

const CHEMISTRIES = [
  {
    id:'LCO', name:'LiCoO₂', full:'Lithium Cobalt Oxide', color:'#3b82f6',
    structure:'layered', cathode_color:'#3b82f6', anode:'Graphite',
    layers:6, ocv_range:[3.0,4.2], ocv_delta:1.2,
    degradation:'SEI growth on graphite anode. Co dissolution above 4.2V. Structural disorder in layered cathode.',
    li_sites:12, capacity_retention:0.85,
  },
  {
    id:'LFP', name:'LiFePO₄', full:'Lithium Iron Phosphate', color:'#10b981',
    structure:'olivine', cathode_color:'#10b981', anode:'Graphite',
    layers:4, ocv_range:[3.0,3.65], ocv_delta:0.05,
    degradation:'Lithium plating at high C-rates. SEI growth. Very stable cathode structure — excellent cycle life.',
    li_sites:8, capacity_retention:0.95,
  },
  {
    id:'NMC', name:'LiNiₓMnᵧCoᵤO₂', full:'Nickel Manganese Cobalt', color:'#f59e0b',
    structure:'layered', cathode_color:'#f59e0b', anode:'Graphite',
    layers:6, ocv_range:[3.0,4.2], ocv_delta:0.8,
    degradation:'Ni dissolution above 4.2V. Microcracks from volume change. SEI growth. Thermally sensitive.',
    li_sites:12, capacity_retention:0.80,
  },
  {
    id:'NCM', name:'LiNiCoMnO₂', full:'Nickel Cobalt Manganese', color:'#8b5cf6',
    structure:'layered', cathode_color:'#8b5cf6', anode:'Graphite',
    layers:6, ocv_range:[2.7,4.2], ocv_delta:0.7,
    degradation:'Similar to NMC. Temperature-accelerated aging at 45°C (TJU dataset). Mn dissolution. Electrolyte oxidation.',
    li_sites:12, capacity_retention:0.78,
  },
]

function CrystalCanvas({ chem, cycleRatio, charging }: {
  chem: typeof CHEMISTRIES[0]; cycleRatio: number; charging: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef<number>()
  const tick = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height
    const CX = W/2, CY = H/2

    const drawAtom = (x: number, y: number, r: number, color: string, label?: string, alpha = 1) => {
      const g = ctx.createRadialGradient(x-r*0.3, y-r*0.3, r*0.1, x, y, r)
      g.addColorStop(0, '#ffffff55'); g.addColorStop(0.4, color); g.addColorStop(1, color+'88')
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI*2)
      ctx.fillStyle = g; ctx.globalAlpha = alpha; ctx.fill(); ctx.globalAlpha = 1
      if (label) {
        ctx.font = `bold ${Math.max(8, r*0.8)}px JetBrains Mono`
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(label, x, y)
      }
    }

    const draw = () => {
      tick.current++; const T = tick.current
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, W, H)

      // Background grid
      ctx.strokeStyle = '#1e3a5f18'; ctx.lineWidth = 0.5
      for (let g = 0; g < W; g += 24) { ctx.beginPath(); ctx.moveTo(g,0); ctx.lineTo(g,H); ctx.stroke() }
      for (let g = 0; g < H; g += 24) { ctx.beginPath(); ctx.moveTo(0,g); ctx.lineTo(W,g); ctx.stroke() }

      const soh = Math.max(0.3, 1 - cycleRatio * 0.3)
      const liOccupancy = charging ? 0.1 + cycleRatio * 0.8 : 0.9 - cycleRatio * 0.8
      const degradedLiSites = Math.floor(chem.li_sites * (1 - soh))

      if (chem.structure === 'layered') {
        // ── LAYERED STRUCTURE (LCO, NMC, NCM) ──────────────────────
        const nLayers = chem.layers
        const layerH = 28, startY = CY - nLayers*layerH/2

        for (let li = 0; li < nLayers; li++) {
          const ly = startY + li * layerH
          const isCathode = li % 2 === 0
          // Layer rectangle
          ctx.fillStyle = isCathode ? chem.cathode_color + '33' : '#94a3b822'
          ctx.fillRect(CX-140, ly, 280, layerH-3)

          // Metal atoms in cathode layer
          if (isCathode) {
            for (let ai = 0; ai < 7; ai++) {
              const ax = CX - 120 + ai * 40
              drawAtom(ax, ly+layerH/2, 9, chem.cathode_color,
                chem.id === 'LCO' ? 'Co' : chem.id === 'LFP' ? 'Fe' : 'M', 0.9)
            }
            // Oxygen atoms between
            for (let ai = 0; ai < 8; ai++) {
              const ax = CX - 140 + ai * 40
              drawAtom(ax, ly, 5, '#ef444488', 'O', 0.7)
              drawAtom(ax, ly+layerH-3, 5, '#ef444488', 'O', 0.7)
            }
          }

          // Li+ ions in van der Waals gap
          if (!isCathode) {
            const nLiSites = 6
            for (let si = 0; si < nLiSites; si++) {
              const sx = CX - 100 + si * 40
              const isDegraded = si < degradedLiSites
              const isOccupied = !isDegraded && Math.random() < liOccupancy + 0.1

              if (isDegraded) {
                ctx.beginPath(); ctx.arc(sx, ly+layerH/2, 6, 0, Math.PI*2)
                ctx.strokeStyle = '#ef444466'; ctx.setLineDash([2,2]); ctx.stroke(); ctx.setLineDash([])
              } else if (isOccupied) {
                // Animated Li+ movement
                const wobble = Math.sin(T*0.08 + si*1.2) * 2
                drawAtom(sx+wobble, ly+layerH/2, 6, '#f59e0b', 'Li⁺', 0.9)

                // If charging, show Li+ moving to anode
                if (charging && Math.random() < 0.003) {
                  // particle traveling right
                }
              } else {
                ctx.beginPath(); ctx.arc(sx, ly+layerH/2, 5, 0, Math.PI*2)
                ctx.strokeStyle = chem.color + '44'; ctx.lineWidth = 1; ctx.stroke()
              }
            }
          }
        }

        // Labels
        ctx.font = '9px Inter'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'left'
        ctx.fillText('Cathode layers (TM oxide)', CX+145, startY+10)
        ctx.fillText('Li⁺ van der Waals gap', CX+145, startY+layerH+10)

      } else {
        // ── OLIVINE STRUCTURE (LFP) ────────────────────────────────
        // Phosphate tetrahedral framework
        const nUnits = 5
        for (let ui = 0; ui < nUnits; ui++) {
          for (let uj = 0; uj < 3; uj++) {
            const ux = CX - 100 + ui*50, uy = CY - 40 + uj*40
            // PO₄ tetrahedron
            ctx.beginPath(); ctx.moveTo(ux, uy-15); ctx.lineTo(ux-12,uy+10); ctx.lineTo(ux+12,uy+10); ctx.closePath()
            ctx.fillStyle = '#f97316' + '55'; ctx.fill()
            ctx.strokeStyle = '#f97316'; ctx.lineWidth = 1; ctx.stroke()
            drawAtom(ux, uy, 5, '#f97316', 'P', 0.7)

            // Fe octahedra
            if (ui < nUnits-1) {
              const fx = ux+25, fy = uy
              drawAtom(fx, fy, 9, '#10b981', 'Fe', 0.8)
              // Li+ sites
              const liOcc = Math.sin(T*0.04 + ui*0.8 + uj*1.3) > 0.2
              if (liOcc) drawAtom(fx, fy-22, 6, '#f59e0b', 'Li', 0.9)
              else { ctx.beginPath(); ctx.arc(fx, fy-22, 5, 0, Math.PI*2); ctx.strokeStyle = '#f59e0b44'; ctx.lineWidth=1; ctx.stroke() }
            }
          }
        }
        ctx.font = '9px Inter'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'center'
        ctx.fillText('Olivine framework: FeO₆ octahedra + PO₄ tetrahedra', CX, H-20)
      }

      // ── TRAVELING Li+ IONS ─────────────────────────────────────
      // Show 3 Li+ ions moving between cathode and anode
      for (let pi = 0; pi < 3; pi++) {
        const t = ((T*0.01 + pi*0.33) % 1)
        const px = charging ? CX + 160 - t*320 : CX - 160 + t*320
        const py = CY - 60 + pi*40 + Math.sin(t*Math.PI)*20
        const glow = ctx.createRadialGradient(px, py, 0, px, py, 12)
        glow.addColorStop(0, '#f59e0bff'); glow.addColorStop(1, '#f59e0b00')
        ctx.beginPath(); ctx.arc(px, py, 12, 0, Math.PI*2)
        ctx.fillStyle = glow; ctx.fill()
        drawAtom(px, py, 6, '#f59e0b', 'Li⁺', 1.0)
      }

      // Separator line
      ctx.strokeStyle = '#94a3b833'; ctx.lineWidth = 2; ctx.setLineDash([5,5])
      ctx.beginPath(); ctx.moveTo(CX, 10); ctx.lineTo(CX, H-10); ctx.stroke(); ctx.setLineDash([])
      ctx.font = '9px Inter'; ctx.fillStyle = '#64748b'; ctx.textAlign = 'center'
      ctx.fillText('◄ CATHODE', CX-70, 16)
      ctx.fillText('ANODE ►', CX+70, 16)
      ctx.fillText('SEPARATOR', CX, H-8)
      ctx.fillText(charging ? '← Li⁺ flow (charging)' : '→ Li⁺ flow (discharging)', CX, 28)

      // SOH indicator
      ctx.font = 'bold 10px JetBrains Mono'; ctx.fillStyle = soh > 0.8 ? '#10b981' : soh > 0.6 ? '#f59e0b' : '#ef4444'
      ctx.textAlign = 'right'
      ctx.fillText(`SOH: ${(soh*100).toFixed(0)}%`, W-10, H-8)
      if (degradedLiSites > 0) {
        ctx.fillStyle = '#ef4444'; ctx.textAlign = 'right'
        ctx.fillText(`${degradedLiSites} Li sites lost`, W-10, H-20)
      }

      raf.current = requestAnimationFrame(draw)
    }
    raf.current = requestAnimationFrame(draw)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [chem, cycleRatio, charging])

  return <canvas ref={canvasRef} width={680} height={360} className="rounded-xl border border-border-subtle w-full" style={{background:'#0a0e1a'}} />
}

export default function ChemistryMolecular() {
  const [chem, setChem] = useState(CHEMISTRIES[0])
  const [cycleRatio, setCycleRatio] = useState(0)
  const [charging, setCharging] = useState(true)
  const [playing, setPlaying] = useState(false)
  const raf = useRef<ReturnType<typeof setInterval>>()

  useEffect(() => {
    if (playing) {
      raf.current = setInterval(() => {
        setCycleRatio(r => {
          const next = r + 0.005
          if (next >= 1) { setCharging(c => !c); return 0 }
          return next
        })
      }, 50)
    } else clearInterval(raf.current)
    return () => clearInterval(raf.current)
  }, [playing])

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Atom size={22} className="text-brand-cyan" />
          <h1 className="text-2xl font-bold text-text-primary">Chemistry Molecular View</h1>
        </div>
        <p className="text-text-secondary">Crystal structure animation — Li⁺ intercalation/de-intercalation during charge/discharge</p>
      </div>

      <div className="flex gap-5">
        {/* Chemistry selector */}
        <div className="w-56 flex-shrink-0 space-y-3">
          <div className="panel p-3">
            {CHEMISTRIES.map(c => (
              <button key={c.id} onClick={() => { setChem(c); setCycleRatio(0) }}
                className="w-full text-left px-3 py-3 rounded-lg border mb-1 transition-all"
                style={chem.id === c.id
                  ? { borderColor: c.color + '55', backgroundColor: c.color + '11' }
                  : { borderColor: '#1e3a5f' }}>
                <div className="font-bold text-sm mb-0.5" style={{ color: chem.id === c.id ? c.color : '#64748b' }}>{c.id}</div>
                <div className="text-xs text-text-muted font-mono">{c.name}</div>
              </button>
            ))}
          </div>

          <div className="panel p-4" style={{ borderColor: chem.color + '33' }}>
            <div className="text-xs font-semibold mb-2" style={{ color: chem.color }}>{chem.full}</div>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between"><span className="text-text-muted">Structure:</span><span className="font-mono capitalize" style={{color:chem.color}}>{chem.structure}</span></div>
              <div className="flex justify-between"><span className="text-text-muted">Anode:</span><span className="text-text-secondary">{chem.anode}</span></div>
              <div className="flex justify-between"><span className="text-text-muted">OCV range:</span><span className="font-mono text-text-secondary">{chem.ocv_range[0]}–{chem.ocv_range[1]}V</span></div>
              <div className="flex justify-between"><span className="text-text-muted">ΔOCV:</span><span className="font-mono" style={{color:chem.ocv_delta<0.2?'#ef4444':'#10b981'}}>~{chem.ocv_delta.toFixed(2)}V</span></div>
            </div>
          </div>
        </div>

        {/* Main animation */}
        <div className="flex-1 space-y-4 min-w-0">
          {/* Controls */}
          <div className="panel p-3 flex items-center gap-4">
            <button onClick={() => setPlaying(p => !p)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium ${playing ? 'bg-brand-cyan/10 text-cyan-400' : 'btn-primary'}`}>
              {playing ? <Pause size={14}/> : <Play size={14}/>} {playing ? 'Pause' : 'Animate'}
            </button>
            <div className="flex-1">
              <input type="range" min={0} max={100} value={Math.round(cycleRatio*100)}
                onChange={e => { setPlaying(false); setCycleRatio(+e.target.value/100) }}
                className="w-full accent-brand-cyan" />
              <div className="flex justify-between text-xs text-text-muted">
                <span>{charging ? '⚡ Charging' : '🔋 Discharging'}</span>
                <span className="font-mono">Li occupancy: {((charging ? 0.1 + cycleRatio * 0.8 : 0.9 - cycleRatio * 0.8)*100).toFixed(0)}%</span>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-text-muted">Voltage</div>
              <div className="font-mono text-sm font-bold" style={{color:chem.color}}>
                ~{Math.max(chem.ocv_range[0], Math.min(chem.ocv_range[1], chem.ocv_range[0] + cycleRatio * chem.ocv_delta)).toFixed(2)} V
              </div>
            </div>
          </div>

          <CrystalCanvas chem={chem} cycleRatio={cycleRatio} charging={charging} />

          <div className="panel p-4">
            <h3 className="text-sm font-semibold mb-2" style={{color:chem.color}}>Degradation Mechanism</h3>
            <p className="text-sm text-text-secondary">{chem.degradation}</p>
            {chem.ocv_delta < 0.2 && (
              <div className="mt-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20">
                <p className="text-xs text-red-400">
                  ⚠ LFP flat voltage plateau (ΔOCV≈{chem.ocv_delta.toFixed(2)}V) is why voltage-based features are
                  nearly uninformative for RUL prediction — this is the root cause of MambaRUL's RMSE%=23.6% on MIT-LFP.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

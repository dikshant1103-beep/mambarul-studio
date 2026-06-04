import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Layers, Play, Pause } from 'lucide-react'
import Plot from 'react-plotly.js'
import { darkLayout, plotConfig } from '../styles/plotly'
import { SkeletonChart } from '../components/ui/Skeleton'

interface MAEData {
  original: number[][]
  masked_input: number[][]
  reconstructed: number[][]
  mask_indices: number[]
  visible_indices: number[]
  n_masked: number
  mask_ratio: number
  feature_names: string[]
  architecture: Record<string, string>
}

type Stage = 'input' | 'masking' | 'encoder' | 'decoder' | 'reconstruction' | 'comparison'

const STAGES: { id: Stage; label: string; desc: string; color: string }[] = [
  { id:'input',          label:'① Raw Input',      color:'#94a3b8', desc:'30-cycle window with 13 features. All features visible.' },
  { id:'masking',        label:'② Apply Mask',      color:'#ef4444', desc:'40% of features masked to zero (random per window). Red = masked.' },
  { id:'encoder',        label:'③ Mamba Encoder',   color:'#3b82f6', desc:'4× Mamba3 blocks encode the masked sequence → 128-dim representation per cycle.' },
  { id:'decoder',        label:'④ MLP Decoder',     color:'#8b5cf6', desc:'2-layer MLP decodes 128-dim → 13 features. Tries to reconstruct all — including masked ones.' },
  { id:'reconstruction', label:'⑤ Reconstruction',  color:'#10b981', desc:'Reconstructed features. Masked features recovered from context. MSE loss computed vs original.' },
  { id:'comparison',     label:'⑥ Side-by-Side',    color:'#f59e0b', desc:'Original vs reconstructed. Visible features near-perfect; masked features approximated from context.' },
]

function EncoderAnimation({ active, progress }: { active: boolean; progress: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const raf = useRef<number>()
  const tick = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const W = canvas.width, H = canvas.height

    const draw = () => {
      tick.current++; const T = tick.current
      ctx.clearRect(0, 0, W, H)
      ctx.fillStyle = '#0a0e1a'; ctx.fillRect(0, 0, W, H)

      // 30 input positions → encoder → 128 dims → decoder → 13 output
      const nIn = 13, nHidden = 12, nOut = 13
      const xIn = 40, xEnc = W/2 - 40, xDec = W/2 + 40, xOut = W - 40

      // Draw nodes
      const drawNodes = (x: number, n: number, color: string, labels?: string[]) => {
        for (let i = 0; i < n; i++) {
          const y = 20 + (i+1) * ((H-40)/(n+1))
          const glow = active ? 0.4 + 0.6 * Math.abs(Math.sin(T*0.06+i*0.4)) : 0.2
          const g = ctx.createRadialGradient(x, y, 0, x, y, 14)
          g.addColorStop(0, color); g.addColorStop(1, color+'00')
          ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI*2)
          ctx.fillStyle = g; ctx.fill()
          ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI*2)
          ctx.fillStyle = color; ctx.globalAlpha = glow; ctx.fill(); ctx.globalAlpha = 1
          if (labels && labels[i]) {
            ctx.font = '8px JetBrains Mono'; ctx.fillStyle = color + 'cc'
            ctx.textAlign = x < W/2 ? 'right' : 'left'
            ctx.fillText(labels[i], x < W/2 ? x-18 : x+18, y+3)
          }
        }
      }

      // Connections input→encoder
      if (active && progress > 0.15) {
        for (let i = 0; i < nIn; i++) {
          for (let j = 0; j < Math.min(nHidden, 4); j++) {
            const y1 = 20 + (i+1)*((H-40)/(nIn+1))
            const y2 = 20 + (j+1)*((H-40)/(nHidden+1))
            const flow = (T * 2 + i * 20 + j * 10) % 100
            const alpha = 0.15 + 0.25 * Math.sin(T*0.04+i*0.3)
            ctx.beginPath(); ctx.moveTo(xIn+6, y1); ctx.lineTo(xEnc-6, y2)
            ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 0.5 + flow/200; ctx.globalAlpha = alpha; ctx.stroke(); ctx.globalAlpha = 1
          }
        }
      }
      // Connections encoder→decoder
      if (active && progress > 0.4) {
        const alpha = Math.min(1, (progress - 0.4) / 0.3)
        ctx.strokeStyle = '#8b5cf6'; ctx.lineWidth = 1; ctx.globalAlpha = alpha * 0.4
        ctx.beginPath(); ctx.moveTo(xEnc+6, H/2); ctx.lineTo(xDec-6, H/2); ctx.stroke()
        ctx.globalAlpha = 1
        ctx.font = '9px JetBrains Mono'; ctx.fillStyle = '#8b5cf644'; ctx.textAlign = 'center'
        ctx.fillText('128-dim', W/2, H/2-8)
      }
      // Connections decoder→output
      if (active && progress > 0.65) {
        for (let i = 0; i < nOut; i++) {
          const y2 = 20 + (i+1)*((H-40)/(nOut+1))
          const alpha = Math.min(1, (progress-0.65)/0.3) * 0.3
          ctx.beginPath(); ctx.moveTo(xDec+6, H/2); ctx.lineTo(xOut-6, y2)
          ctx.strokeStyle = '#10b981'; ctx.lineWidth = 0.5; ctx.globalAlpha = alpha; ctx.stroke(); ctx.globalAlpha = 1
        }
      }

      drawNodes(xIn, nIn, '#3b82f6')
      if (active && progress > 0.15) drawNodes(xEnc, nHidden, '#8b5cf6')
      if (active && progress > 0.65) drawNodes(xOut, nOut, '#10b981')

      // Labels
      ctx.font = '9px Inter'; ctx.textAlign = 'center'; ctx.fillStyle = '#64748b'
      ctx.fillText('Masked Input (30,13)', xIn+30, H-8)
      if (active && progress > 0.1) ctx.fillText('Mamba×4 (30,128)', xEnc, H-8)
      if (active && progress > 0.6) ctx.fillText('Decoded (30,13)', xOut-30, H-8)

      raf.current = requestAnimationFrame(draw)
    }
    raf.current = requestAnimationFrame(draw)
    return () => { if (raf.current) cancelAnimationFrame(raf.current) }
  }, [active, progress])

  return <canvas ref={canvasRef} width={400} height={280} className="rounded-xl border border-border-subtle w-full" style={{background:'#0a0e1a'}} />
}

export default function MAEVisualizer() {
  const [data, setData] = useState<MAEData | null>(null)
  const [loading, setLoading] = useState(true)
  const [stage, setStage] = useState<Stage>('input')
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const stageIdx = STAGES.findIndex(s => s.id === stage)
  const intervalRef = useRef<ReturnType<typeof setInterval>>()
  const progRef = useRef(0)

  useEffect(() => {
    fetch('/api/mae/demonstration')
      .then(r => r.ok ? r.json() : null).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        progRef.current += 0.02
        setProgress(progRef.current)
        if (progRef.current >= 1) {
          progRef.current = 0
          setStage(s => {
            const idx = STAGES.findIndex(x => x.id === s)
            if (idx < STAGES.length - 1) return STAGES[idx + 1].id
            setPlaying(false)
            return s
          })
        }
      }, 80)
    } else clearInterval(intervalRef.current)
    return () => clearInterval(intervalRef.current)
  }, [playing])

  const goToStage = (s: Stage) => { setPlaying(false); setStage(s); setProgress(0); progRef.current = 0 }

  const stageColor = STAGES[stageIdx]?.color ?? '#3b82f6'

  return (
    <div className="px-8 py-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Layers size={22} className="text-brand-purple" />
          <h1 className="text-2xl font-bold text-text-primary">MAE Pretraining Visualizer</h1>
        </div>
        <p className="text-text-secondary">Masked Autoencoder — mask 40% of features → encode → reconstruct missing features from context</p>
      </div>

      {loading ? <SkeletonChart /> : !data ? <div className="panel p-12 text-center text-text-muted">No MAE data</div> : (
        <div className="space-y-5">
          {/* Stage tabs */}
          <div className="flex gap-1 flex-wrap mb-2">
            {STAGES.map(s => (
              <button key={s.id} onClick={() => goToStage(s.id)}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all"
                style={stage === s.id
                  ? { borderColor: s.color + '55', backgroundColor: s.color + '18', color: s.color }
                  : { borderColor: '#1e3a5f', color: '#64748b' }}>
                {s.label}
              </button>
            ))}
            <button onClick={() => { setPlaying(p => !p); if (!playing) { setStage('input'); progRef.current = 0; setProgress(0) } }}
              className={`ml-2 px-4 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 ${playing ? 'bg-brand-purple/10 text-purple-400' : 'btn-primary'}`}>
              {playing ? <Pause size={12}/> : <Play size={12}/>} {playing ? 'Pause' : 'Auto-Play'}
            </button>
          </div>

          {/* Stage description */}
          <AnimatePresence mode="wait">
            <motion.div key={stage} initial={{opacity:0,x:6}} animate={{opacity:1,x:0}} exit={{opacity:0}}
              className="panel p-4 flex items-start gap-3" style={{borderColor:stageColor+'33',backgroundColor:stageColor+'08'}}>
              <div className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{backgroundColor:stageColor}} />
              <div>
                <div className="font-semibold text-sm mb-1" style={{color:stageColor}}>{STAGES[stageIdx]?.label}</div>
                <p className="text-sm text-text-secondary">{STAGES[stageIdx]?.desc}</p>
              </div>
            </motion.div>
          </AnimatePresence>

          {/* Main visualization */}
          <div className="grid grid-cols-2 gap-5">
            {/* Heatmaps */}
            <div className="space-y-4">
              {stage === 'input' && (
                <div className="panel p-5">
                  <h3 className="section-title mb-1">Original Input Window (30 cycles × 13 features)</h3>
                  <Plot
                    data={[{ type:'heatmap', z:data.original,
                      x:data.feature_names, y:Array.from({length:30},(_,i)=>`t${i+1}`),
                      colorscale:'Viridis', showscale:true,
                      colorbar:{tickfont:{color:'#64748b',size:9},thickness:10} }]}
                    layout={{...darkLayout,height:320,margin:{t:10,b:60,l:50,r:50},
                      xaxis:{...darkLayout.xaxis as object,tickangle:-45,tickfont:{size:9}},
                    } as Plotly.Layout}
                    config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}} />
                </div>
              )}

              {(stage === 'masking' || stage === 'encoder') && (
                <div className="panel p-5">
                  <h3 className="section-title mb-1">Masked Input — {data.n_masked} features zeroed ({(data.mask_ratio*100).toFixed(0)}%)</h3>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {data.feature_names.map((f, i) => (
                      <span key={f} className="text-xs px-1.5 py-0.5 rounded font-mono"
                        style={data.mask_indices.includes(i)
                          ? {backgroundColor:'#ef444422',color:'#ef4444',border:'1px solid #ef444466'}
                          : {backgroundColor:'#111827',color:'#64748b',border:'1px solid #1e3a5f'}}>
                        {data.mask_indices.includes(i) ? '✗' : '✓'} {f}
                      </span>
                    ))}
                  </div>
                  <Plot
                    data={[{ type:'heatmap', z:data.masked_input,
                      x:data.feature_names, y:Array.from({length:30},(_,i)=>`t${i+1}`),
                      colorscale:'Viridis', showscale:false }]}
                    layout={{...darkLayout,height:260,margin:{t:10,b:60,l:50,r:20},
                      xaxis:{...darkLayout.xaxis as object,tickangle:-45,tickfont:{size:9}},
                    } as Plotly.Layout}
                    config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}} />
                </div>
              )}

              {(stage === 'decoder' || stage === 'reconstruction') && (
                <div className="panel p-5">
                  <h3 className="section-title mb-1">Reconstructed Output — all features recovered</h3>
                  <Plot
                    data={[{ type:'heatmap', z:data.reconstructed,
                      x:data.feature_names, y:Array.from({length:30},(_,i)=>`t${i+1}`),
                      colorscale:'Viridis', showscale:true,
                      colorbar:{tickfont:{color:'#64748b',size:9},thickness:10} }]}
                    layout={{...darkLayout,height:320,margin:{t:10,b:60,l:50,r:50},
                      xaxis:{...darkLayout.xaxis as object,tickangle:-45,tickfont:{size:9}},
                    } as Plotly.Layout}
                    config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}} />
                </div>
              )}

              {stage === 'comparison' && (
                <div className="panel p-5">
                  <h3 className="section-title mb-3">Original vs Reconstructed — per feature</h3>
                  <Plot
                    data={data.feature_names.map((f, fi) => ({
                      type:'scatter' as const, mode:'lines' as const, name:f,
                      x:Array.from({length:30},(_,i)=>i+1),
                      y:data.original.map(row=>row[fi]),
                      line:{color:data.mask_indices.includes(fi)?'#ef4444':'#3b82f6',
                        width:data.mask_indices.includes(fi)?2:1,
                        dash:data.mask_indices.includes(fi)?'solid':'dot'},
                      showlegend: fi < 5,
                    }))}
                    layout={{...darkLayout,height:300,
                      xaxis:{...darkLayout.xaxis as object,title:{text:'Cycle',font:{color:'#64748b'}}},
                      yaxis:{...darkLayout.yaxis as object,title:{text:'Normalized value',font:{color:'#64748b'}}},
                    } as Plotly.Layout}
                    config={{...plotConfig,displayModeBar:false}} style={{width:'100%'}} />
                </div>
              )}
            </div>

            {/* Right: encoder animation + architecture */}
            <div className="space-y-4">
              <div className="panel p-5">
                <h3 className="section-title mb-3">Encoder-Decoder Architecture</h3>
                <EncoderAnimation active={stage !== 'input'} progress={progress} />
              </div>

              <div className="panel p-4">
                <h3 className="section-title mb-3">Architecture Details</h3>
                <div className="space-y-2">
                  {Object.entries(data.architecture).map(([k, v]) => (
                    <div key={k} className="flex items-start gap-2">
                      <span className="text-xs font-semibold text-text-secondary w-28 flex-shrink-0 capitalize">{k.replace(/_/g,' ')}:</span>
                      <span className="text-xs text-text-muted font-mono">{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel p-4 border-purple-500/20 bg-purple-500/5">
                <h3 className="text-sm font-semibold text-purple-400 mb-2">Why MAE Pretraining?</h3>
                <p className="text-xs text-text-secondary">
                  Different datasets have different missing features (e.g. KJTU has no IR data).
                  MAE teaches the encoder to reconstruct missing features from context — enabling
                  the model to handle any feature subset at inference without architecture changes.
                  Pretrained encoder weights then initialize MambaRUL for supervised RUL training.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

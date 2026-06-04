/**
 * Compare — multi-model RUL comparison for a single cell.
 * Route: /compare-models
 * Sends the same cell to all 5 models simultaneously and charts the spread.
 */
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import Plot from 'react-plotly.js'
import { GitCompare, RefreshCw, AlertTriangle, Zap, Info } from 'lucide-react'

interface ModelResult {
  model_id:        string
  model:           string
  predicted_rul:   number
  lower_90:        number
  upper_90:        number
  phase:           string
  chemistry:       string
  confidence_pct:  number
  row_index:       number
}

const MODELS = ['v10-final', 'v10-full', 'v9', 'v8', 'tcn-mamba']
const MODEL_LABELS: Record<string, string> = {
  'v10-final':   'v10-final (best)',
  'v10-full':    'v10-full',
  'v9':          'v9',
  'v8':          'v8',
  'tcn-mamba':   'TCN-Mamba',
}
const MODEL_COLOR = ['#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4']
const CHEM = ['NMC', 'LFP', 'LCO', 'NCM', 'NCA']
const PHASE_COLOR: Record<string, string> = {
  Fresh: '#10b981', Aging: '#3b82f6', Knee: '#f59e0b', 'Near-EOL': '#ef4444',
}

const PLOT_BASE = {
  paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
  font: { family: 'Inter, sans-serif', color: '#94a3b8', size: 11 },
  margin: { t: 20, b: 60, l: 60, r: 20 },
  xaxis: { gridcolor: '#1e2d45', linecolor: '#1e2d45' },
  yaxis: { gridcolor: '#1e2d45', linecolor: '#1e2d45' },
}

export default function Compare() {
  const [chem,    setChem]    = useState('NMC')
  const [soh,     setSoh]     = useState(85)
  const [nomCap,  setNomCap]  = useState(2.0)
  const [ir,      setIr]      = useState(0.045)
  const [temp,    setTemp]    = useState(25)

  const [results, setResults] = useState<ModelResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [done,    setDone]    = useState(false)

  const runCompare = async () => {
    setLoading(true); setError(null); setDone(false); setResults([])
    try {
      const payload = MODELS.map(mid => ({
        model_id:       mid,
        chemistry:      chem,
        soh_pct:        soh,
        cap_pct:        soh / 100,
        nom_capacity:   nomCap,
        int_resistance: ir,
        temperature:    temp,
      }))
      const res = await fetch('/api/predict/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`Server ${res.status}`)
      const data: ModelResult[] = await res.json()
      setResults(data)
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Comparison failed')
    }
    setLoading(false)
  }

  const rulValues  = results.map(r => r.predicted_rul)
  const spread     = rulValues.length > 0 ? Math.max(...rulValues) - Math.min(...rulValues) : 0
  const consensus  = rulValues.length > 0 ? Math.round(rulValues.reduce((a, b) => a + b, 0) / rulValues.length) : null

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-bold text-text-primary">Model Comparison</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Run all 5 MambaRUL variants on the same cell — see prediction spread and model consensus.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">

        {/* Input panel */}
        <div className="space-y-4">
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-text-primary">Cell Parameters</div>

            <div>
              <label className="text-[10px] text-text-muted uppercase tracking-wide">Chemistry</label>
              <select value={chem} onChange={e => setChem(e.target.value)}
                className="mt-1 w-full px-2.5 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50">
                {CHEM.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>

            {[
              { label: 'SOH %',         val: soh,    set: setSoh,    min: 50,   max: 100, step: 1   },
              { label: 'Nom. Cap (Ah)', val: nomCap, set: setNomCap, min: 0.1,  max: 30,  step: 0.1 },
              { label: 'Int. Res (Ω)',  val: ir,     set: setIr,     min: 0.01, max: 0.5, step: 0.005 },
              { label: 'Temp (°C)',     val: temp,   set: setTemp,   min: -20,  max: 60,  step: 1   },
            ].map(({ label, val, set, min, max, step }) => (
              <div key={label}>
                <label className="text-[10px] text-text-muted uppercase tracking-wide">{label}</label>
                <div className="flex gap-2 mt-1 items-center">
                  <input type="range" min={min} max={max} step={step} value={val}
                    onChange={e => set(+e.target.value)}
                    className="flex-1 accent-brand-blue" />
                  <span className="text-xs font-mono text-text-primary w-14 text-right">{val}</span>
                </div>
              </div>
            ))}

            <button onClick={runCompare} disabled={loading}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
              {loading
                ? <><RefreshCw size={12} className="animate-spin" /> Running all models…</>
                : <><GitCompare size={12} /> Compare All Models</>}
            </button>
          </div>

          {done && consensus != null && (
            <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
              <div className="text-[10px] text-text-muted uppercase tracking-widest">Consensus</div>
              <div className="text-3xl font-bold font-mono text-brand-blue">{consensus}</div>
              <div className="text-[10px] text-text-muted">avg RUL across all models</div>
              <div className="border-t border-border-subtle pt-2 space-y-1">
                <div className="flex justify-between text-[10px]">
                  <span className="text-text-muted">Spread</span>
                  <span className={`font-mono font-semibold ${spread < 50 ? 'text-emerald-400' : spread < 150 ? 'text-amber-400' : 'text-red-400'}`}>
                    {spread.toFixed(0)} cyc
                  </span>
                </div>
                <div className="flex justify-between text-[10px]">
                  <span className="text-text-muted">Agreement</span>
                  <span className="font-mono text-text-primary">
                    {spread < 50 ? 'High' : spread < 150 ? 'Medium' : 'Low'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Results */}
        <div className="lg:col-span-3 space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400">
              <AlertTriangle size={13} /> {error}
            </div>
          )}

          <AnimatePresence>
            {done && results.length > 0 && (
              <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
                className="space-y-4">

                {/* Bar chart with CI */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Zap size={14} className="text-brand-blue" />
                    <span className="text-sm font-semibold text-text-primary">Predicted RUL — All Models</span>
                    <span className="text-[10px] text-text-muted ml-auto">error bars = 90% CI</span>
                  </div>
                  <Plot
                    data={[{
                      type:  'bar',
                      x:     results.map(r => MODEL_LABELS[r.model_id] ?? r.model_id),
                      y:     results.map(r => r.predicted_rul),
                      error_y: {
                        type:       'data',
                        symmetric:  false,
                        array:      results.map(r => r.upper_90 - r.predicted_rul),
                        arrayminus: results.map(r => r.predicted_rul - r.lower_90),
                        visible:    true,
                        color:      '#94a3b8',
                        thickness:  1.5,
                        width:      6,
                      },
                      marker: { color: MODEL_COLOR },
                      text:   results.map(r => String(Math.round(r.predicted_rul))),
                      textposition: 'outside',
                    }]}
                    layout={{
                      ...PLOT_BASE,
                      height: 260,
                      yaxis: { ...PLOT_BASE.yaxis, title: { text: 'RUL (cycles)' } },
                      showlegend: false,
                    }}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%' }}
                  />
                </div>

                {/* Table */}
                <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
                  <table className="w-full text-xs">
                    <thead className="border-b border-border-subtle text-text-muted">
                      <tr>
                        <th className="px-4 py-2.5 text-left font-medium">Model</th>
                        <th className="px-4 py-2.5 text-right font-medium">RUL</th>
                        <th className="px-4 py-2.5 text-right font-medium">90% CI</th>
                        <th className="px-4 py-2.5 text-right font-medium">Width</th>
                        <th className="px-4 py-2.5 text-left font-medium">Phase</th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r, i) => (
                        <tr key={r.model_id}
                          className="border-b border-border-subtle/40 hover:bg-bg-panel transition-colors">
                          <td className="px-4 py-3">
                            <div className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full flex-shrink-0"
                                style={{ background: MODEL_COLOR[i] }} />
                              <span className="font-medium text-text-primary">{MODEL_LABELS[r.model_id] ?? r.model_id}</span>
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-text-primary">
                            {Math.round(r.predicted_rul)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-text-muted text-[10px]">
                            {Math.round(r.lower_90)}–{Math.round(r.upper_90)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-text-muted text-[10px]">
                            {Math.round(r.upper_90 - r.lower_90)}
                          </td>
                          <td className="px-4 py-3">
                            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold"
                              style={{
                                background: (PHASE_COLOR[r.phase] ?? '#6b7280') + '20',
                                color: PHASE_COLOR[r.phase] ?? '#6b7280',
                              }}>
                              {r.phase}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-start gap-2 p-3 bg-bg-secondary border border-border-subtle rounded-xl text-[10px] text-text-muted">
                  <Info size={11} className="text-brand-blue flex-shrink-0 mt-0.5" />
                  High model agreement (low spread) indicates reliable prediction. Low agreement suggests the cell
                  is at a degradation boundary — use Calibrate for tighter bounds.
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {!done && !loading && (
            <div className="flex flex-col items-center justify-center h-64 gap-3 text-text-muted">
              <GitCompare size={32} className="opacity-20" />
              <div className="text-xs">Set cell parameters and click Compare All Models</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

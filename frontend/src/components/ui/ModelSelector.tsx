/**
 * ModelSelector — fetches loaded models from /api/predict/available-models
 * and renders a chemistry-aware selector with auto-suggestion.
 *
 * Usage:
 *   <ModelSelector chemistry="LFP" value={modelId} onChange={setModelId} />
 */
import { useEffect, useState } from 'react'
import { Sparkles, AlertTriangle } from 'lucide-react'

interface ModelMeta {
  id: string
  loaded: boolean
  description: string
  rmse?: number
  r2?: number
  normalization?: string
  chemistry_affinity?: string
  low_confidence?: boolean
  low_confidence_reason?: string
}

// Best fine-tuned model per chemistry — falls back to v10-final
const AFFINITY_ORDER: Record<string, string[]> = {
  LFP: ['hust-lfp', 'v12-bimamba'],
  NMC: ['oxford-nmc', 'nasa-nmc', 'v12-bimamba'],
  NCM: ['v12-bimamba'],
  NCA: ['v12-bimamba'],
  LCO: ['v12-bimamba'],
}

export function bestModelForChem(chem: string, models: ModelMeta[]): string {
  const loaded = new Set(models.filter(m => m.loaded).map(m => m.id))
  for (const id of (AFFINITY_ORDER[chem] ?? [])) {
    if (loaded.has(id)) return id
  }
  return 'v10-final'
}

interface Props {
  chemistry: string
  value: string
  onChange: (id: string) => void
  /** if true, auto-updates value when chemistry changes */
  autoSelect?: boolean
}

export default function ModelSelector({ chemistry, value, onChange, autoSelect = true }: Props) {
  const [models, setModels] = useState<ModelMeta[]>([])

  useEffect(() => {
    fetch('/api/predict/available-models')
      .then(r => r.json())
      .then(setModels)
      .catch(() => {})
  }, [])

  // Auto-select best model when chemistry changes
  useEffect(() => {
    if (!autoSelect || models.length === 0) return
    const best = bestModelForChem(chemistry, models)
    if (best !== value) onChange(best)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chemistry, models])

  const loaded = models.filter(m => m.loaded)
  const current = models.find(m => m.id === value)
  const isFineTuned    = current?.normalization === 'per_cell'
  const isLowConfidence = current?.low_confidence === true

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-[10px] text-text-muted font-medium uppercase tracking-wide">
          Model
        </label>
        <div className="flex items-center gap-1.5">
          {isFineTuned && (
            <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              <Sparkles size={9} /> Fine-tuned
            </span>
          )}
          {isLowConfidence && (
            <span className="flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <AlertTriangle size={9} /> Low confidence
            </span>
          )}
        </div>
      </div>

      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full px-3 py-2 text-xs font-mono bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50 transition-colors"
      >
        {loaded.map(m => {
          const isBest    = bestModelForChem(chemistry, models) === m.id
          const isFT      = m.normalization === 'per_cell'
          const isLC      = m.low_confidence === true
          const isBiMamba = m.id === 'v12-bimamba'
          return (
            <option key={m.id} value={m.id}>
              {isFT ? '★ ' : ''}{isLC ? '⚠ ' : ''}{isBiMamba ? '⚡ ' : ''}{m.id}{isBest ? ' ← recommended' : ''}
            </option>
          )
        })}
      </select>

      {current && (
        <div className="text-[10px] text-text-muted leading-relaxed">
          {current.description}
          {current.rmse && (
            <span className="ml-1 font-mono text-text-secondary">
              · RMSE={current.rmse} · R²={current.r2?.toFixed(3)}
            </span>
          )}
        </div>
      )}
      {isLowConfidence && current?.low_confidence_reason && (
        <div className="flex items-start gap-1.5 p-2 bg-amber-500/10 border border-amber-500/20 rounded-lg text-[10px] text-amber-400 leading-relaxed">
          <AlertTriangle size={10} className="flex-shrink-0 mt-0.5" />
          {current.low_confidence_reason}
        </div>
      )}
    </div>
  )
}

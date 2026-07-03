/**
 * APIKeys — generate and manage REST API keys for BMS integrations.
 * Keys let operators call /api/predict programmatically from their own systems.
 */
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Key, Plus, Trash2, Copy, CheckCircle2, AlertTriangle, Info, RefreshCw } from 'lucide-react'

interface ApiKey {
  key_id:             string
  label:              string
  preview:            string
  org_name:           string
  rate_limit_per_min: number
  created_at:         string
  last_used:          string | null
  call_count:         number
}

interface NewKey {
  key_id: string
  key: string
  label: string
  created_at: string
}

export default function APIKeys() {
  const [keys,    setKeys]    = useState<ApiKey[]>([])
  const [loading, setLoading] = useState(true)
  const [label,    setLabel]   = useState('')
  const [orgName,  setOrgName] = useState('')
  const [rateLimit, setRateLimit] = useState(100)
  const [creating, setCreating] = useState(false)
  const [newKey,  setNewKey]  = useState<NewKey | null>(null)
  const [copied,  setCopied]  = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const fetchKeys = () => {
    setLoading(true)
    fetch('/api/keys')
      .then(r => r.json())
      .then(setKeys)
      .catch(() => setKeys([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchKeys() }, [])

  const createKey = async () => {
    if (!label.trim()) return
    setCreating(true)
    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim(), org_name: orgName.trim(), rate_limit_per_min: rateLimit }),
      })
      const data = await res.json()
      setNewKey(data)
      setLabel('')
      fetchKeys()
    } finally {
      setCreating(false)
    }
  }

  const revokeKey = async (keyId: string) => {
    setDeleting(keyId)
    try {
      await fetch(`/api/keys/${keyId}`, { method: 'DELETE' })
      setKeys(prev => prev.filter(k => k.key_id !== keyId))
      if (newKey?.key_id === keyId) setNewKey(null)
    } finally {
      setDeleting(null)
    }
  }

  const copyKey = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const exampleCurl = newKey
    ? `curl -X POST https://your-domain/api/predict \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${newKey.key}" \\
  -d '{"chemistry":"NMC","cap_pct":0.87,"soh_pct":87,"nom_capacity":2.0,"int_resistance":0.045,"temperature":25}'`
    : `curl -X POST https://your-domain/api/predict \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: bos_<your_key>" \\
  -d '{"chemistry":"NMC","cap_pct":0.87,"soh_pct":87,"nom_capacity":2.0,"int_resistance":0.045,"temperature":25}'`

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-text-primary">API Keys</h1>
        <p className="text-sm text-text-muted mt-0.5">
          Integrate BatteryOS predictions into your BMS, ERP, or data pipeline.
        </p>
      </div>

      {/* New key banner */}
      <AnimatePresence>
        {newKey && (
          <motion.div
            initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
            className="bg-emerald-500/10 border border-emerald-500/30 rounded-xl p-4 space-y-3"
          >
            <div className="flex items-center gap-2 text-sm font-semibold text-emerald-400">
              <CheckCircle2 size={14} /> Key created — copy it now, it won't be shown again
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 px-3 py-2 bg-bg-panel rounded-lg text-xs font-mono text-emerald-300 break-all">
                {newKey.key}
              </code>
              <button
                onClick={() => copyKey(newKey.key)}
                className="flex items-center gap-1.5 px-3 py-2 bg-emerald-500/20 text-emerald-400 text-xs rounded-lg hover:bg-emerald-500/30 transition-colors flex-shrink-0"
              >
                {copied ? <CheckCircle2 size={12} /> : <Copy size={12} />}
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <div className="text-[10px] text-text-muted">Label: {newKey.label} · Created: {newKey.created_at}</div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Left: key list + create */}
        <div className="lg:col-span-2 space-y-4">

          {/* Create form */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Generate New Key</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={label}
                onChange={e => setLabel(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && createKey()}
                placeholder="Label (e.g. Production BMS)"
                className="px-3 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50"
              />
              <input
                value={orgName}
                onChange={e => setOrgName(e.target.value)}
                placeholder="Organisation (e.g. Ola Electric)"
                className="px-3 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50"
              />
            </div>
            <div className="flex gap-2 items-center">
              <label className="text-[10px] text-text-muted whitespace-nowrap">Rate limit (req/min)</label>
              <input type="number" min={1} max={10000} value={rateLimit}
                onChange={e => setRateLimit(+e.target.value)}
                className="w-20 px-2 py-1.5 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary focus:outline-none focus:border-brand-blue/50" />
              <button
                onClick={createKey}
                disabled={creating || !label.trim()}
                className="ml-auto flex items-center gap-1.5 px-4 py-2 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {creating ? <RefreshCw size={12} className="animate-spin" /> : <Plus size={12} />}
                Generate
              </button>
            </div>
          </div>

          {/* Key table */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
              <span className="text-sm font-semibold text-text-primary">Active Keys</span>
              <button onClick={fetchKeys} className="text-[10px] text-text-muted hover:text-text-secondary flex items-center gap-1">
                <RefreshCw size={10} /> Refresh
              </button>
            </div>

            {loading ? (
              <div className="flex items-center justify-center py-10 text-text-muted text-xs gap-2">
                <RefreshCw size={12} className="animate-spin" /> Loading…
              </div>
            ) : keys.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 gap-2 text-text-muted">
                <Key size={24} className="opacity-30" />
                <div className="text-xs">No API keys yet. Generate one above.</div>
              </div>
            ) : (
              <table className="w-full text-xs">
                <thead className="border-b border-border-subtle text-text-muted">
                  <tr>
                    <th className="px-4 py-2.5 text-left font-medium">Label</th>
                    <th className="px-4 py-2.5 text-left font-medium">Org</th>
                    <th className="px-4 py-2.5 text-left font-medium">Key</th>
                    <th className="px-4 py-2.5 text-right font-medium">Calls</th>
                    <th className="px-4 py-2.5 text-right font-medium">Rate</th>
                    <th className="px-4 py-2.5 text-left font-medium">Last Used</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {keys.map(k => (
                    <tr key={k.key_id} className="border-b border-border-subtle/40 hover:bg-bg-panel transition-colors">
                      <td className="px-4 py-3 font-medium text-text-primary">{k.label}</td>
                      <td className="px-4 py-3 text-text-muted text-[10px]">{k.org_name || <span className="opacity-40">—</span>}</td>
                      <td className="px-4 py-3 font-mono text-text-muted">{k.preview}</td>
                      <td className="px-4 py-3 text-right font-mono">
                        <span className={k.call_count > 0 ? 'text-brand-blue font-semibold' : 'text-text-muted/50'}>
                          {k.call_count.toLocaleString()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-[10px] text-text-muted font-mono">
                        {k.rate_limit_per_min}/min
                      </td>
                      <td className="px-4 py-3 text-text-muted">
                        {k.last_used ? k.last_used.slice(0, 10) : <span className="text-text-muted/50">never</span>}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => revokeKey(k.key_id)}
                          disabled={deleting === k.key_id}
                          className="flex items-center gap-1 text-[10px] text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
                        >
                          {deleting === k.key_id
                            ? <RefreshCw size={10} className="animate-spin" />
                            : <Trash2 size={10} />}
                          Revoke
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Right: docs */}
        <div className="space-y-4">

          {/* Usage */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-3">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Integration</div>
            <div className="text-[10px] text-text-muted space-y-2 leading-relaxed">
              <p>Pass your key in the <code className="text-text-secondary">X-API-Key</code> header with every request.</p>
              <p>The prediction endpoint accepts SOH, capacity, internal resistance, temperature, and chemistry.</p>
              <p>Response includes predicted RUL, 90% confidence interval, phase, and recommended action.</p>
            </div>
          </div>

          {/* Example curl */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Example Request</div>
              <button
                onClick={() => copyKey(exampleCurl)}
                className="flex items-center gap-1 text-[10px] text-brand-blue hover:underline"
              >
                <Copy size={10} /> Copy
              </button>
            </div>
            <pre className="text-[10px] text-text-secondary font-mono bg-bg-panel rounded-lg p-3 overflow-x-auto leading-relaxed whitespace-pre-wrap break-all">
              {exampleCurl}
            </pre>
          </div>

          {/* Response shape */}
          <div className="bg-bg-secondary border border-border-subtle rounded-xl p-4 space-y-2">
            <div className="text-xs font-semibold text-text-muted uppercase tracking-widest">Response Shape</div>
            <pre className="text-[10px] text-text-secondary font-mono bg-bg-panel rounded-lg p-3 overflow-x-auto leading-relaxed">
{`{
  "predicted_rul": 287,
  "lower_90": 227,
  "upper_90": 347,
  "phase": "Aging",
  "health_score": 87.0,
  "chemistry": "NMC",
  "confidence_pct": 90,
  "model": "MambaRUL v10-final"
}`}
            </pre>
          </div>

          <div className="flex items-start gap-2 p-3 bg-bg-secondary border border-border-subtle rounded-xl text-[10px] text-text-muted">
            <Info size={11} className="text-brand-blue flex-shrink-0 mt-0.5" />
            Keys are persisted to disk and survive backend restarts. Usage counter increments on each verified call.
          </div>

          <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded-xl text-[10px] text-amber-400">
            <AlertTriangle size={11} className="flex-shrink-0 mt-0.5" />
            Never expose keys in client-side code. Treat them like passwords.
          </div>
        </div>
      </div>
    </div>
  )
}

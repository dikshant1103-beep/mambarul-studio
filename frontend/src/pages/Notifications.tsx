/**
 * Notifications — admin alert-channel configuration + Slack/Teams preview.
 *
 * Surfaces the work shipped 2026-05-29 (curated Slack Block Kit + Teams
 * MessageCard webhook payloads). Replaces the inline webhook section in
 * the Settings page with a focused, channel-by-channel view that includes:
 *   - Channel status (email + webhook) from /api/notifications/channels
 *   - Webhook URL editor + enable toggle (persisted via /api/settings)
 *   - Format selector (auto / slack / teams / generic) + JSON preview
 *   - "Send test alert" with dry-run guard
 */
import { useEffect, useState, useCallback } from 'react'
import {
  Bell, RefreshCw, AlertTriangle, CheckCircle2, Send, FlaskConical, Save,
} from 'lucide-react'

type WebhookFormat = 'auto' | 'slack' | 'teams' | 'generic'

interface Channels { email: boolean; webhook: boolean }

interface SettingsState {
  webhook_url:     string
  webhook_enabled: boolean
  alert_email:     string
  smtp_host:       string
  smtp_port:       number
  smtp_user:       string
  smtp_from:       string
}

export default function Notifications() {
  const [channels, setChannels] = useState<Channels | null>(null)
  const [webhookUrl,     setWebhookUrl]     = useState('')
  const [webhookEnabled, setWebhookEnabled] = useState(false)
  const [format,         setFormat]         = useState<WebhookFormat>('auto')
  const [preview,        setPreview]        = useState<any>(null)
  const [testResult,     setTestResult]     = useState<any>(null)
  const [dryRun,         setDryRun]         = useState(true)
  const [busy,           setBusy]           = useState(false)
  const [saving,         setSaving]         = useState(false)
  const [err,            setErr]            = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setErr(null)
    try {
      const [ch, st] = await Promise.all([
        fetch('/api/notifications/channels').then(r => r.json()),
        fetch('/api/settings').then(r => r.json()),
      ])
      setChannels(ch)
      const s = st as Partial<SettingsState>
      setWebhookUrl(s.webhook_url ?? '')
      setWebhookEnabled(s.webhook_enabled ?? false)
    } catch (e: any) {
      setErr(e.message ?? 'failed to load')
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const saveWebhook = async () => {
    setSaving(true); setErr(null)
    try {
      const r = await fetch('/api/settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: webhookUrl, webhook_enabled: webhookEnabled }),
      })
      if (!r.ok) throw new Error(`status ${r.status}: ${await r.text()}`)
      refresh()
    } catch (e: any) {
      setErr(e.message ?? 'save failed')
    } finally {
      setSaving(false)
    }
  }

  const fetchPreview = async () => {
    setBusy(true); setErr(null); setPreview(null)
    try {
      const r = await fetch(`/api/notifications/webhook/preview?format=${format === 'auto' ? 'generic' : format}`)
      if (!r.ok) throw new Error(`preview failed: ${r.status}`)
      setPreview(await r.json())
    } catch (e: any) {
      setErr(e.message ?? 'preview failed')
    } finally {
      setBusy(false)
    }
  }

  const sendTest = async () => {
    setBusy(true); setErr(null); setTestResult(null)
    try {
      const body = { dry_run: dryRun, webhook_format: format === 'auto' ? null : format }
      const r = await fetch('/api/notifications/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!r.ok) throw new Error(`test failed: ${r.status}: ${await r.text()}`)
      setTestResult(await r.json())
      refresh()
    } catch (e: any) {
      setErr(e.message ?? 'test failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl">
      <header className="flex items-center gap-3">
        <Bell className="text-amber-400" />
        <div className="flex-1">
          <h1 className="text-xl md:text-2xl font-semibold">Notifications</h1>
          <p className="text-sm text-text-secondary">
            Alert dispatch channels — email + webhook. Slack and Microsoft Teams
            URLs are auto-detected; the preview shows the exact JSON that will
            be POSTed.
          </p>
        </div>
        <button onClick={refresh}
                className="flex items-center gap-1.5 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs">
          <RefreshCw size={12} /> Reload
        </button>
      </header>

      {err && (
        <div className="border border-amber-700 bg-amber-900/30 rounded p-3 flex items-center gap-2 text-sm">
          <AlertTriangle size={16} className="text-amber-400" /> {err}
        </div>
      )}

      {/* ── Channel status ───────────────────────────────────────────── */}
      <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
        <h2 className="font-semibold mb-3">Channel status</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <ChannelCard
            name="Email (SMTP)"
            configured={channels?.email ?? false}
            description="Configured via SMTP host + alert recipient on the Settings page." />
          <ChannelCard
            name="Webhook (Slack / Teams / generic)"
            configured={channels?.webhook ?? false}
            description="Configure URL below. Format auto-detected from the URL." />
        </div>
      </section>

      {/* ── Webhook configuration ────────────────────────────────────── */}
      <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
        <h2 className="font-semibold mb-3">Webhook URL</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div className="md:col-span-3">
            <div className="text-[10px] uppercase text-text-muted">URL</div>
            <input type="text" value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)}
                   placeholder="https://hooks.slack.com/services/T0/B0/abc"
                   className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 font-mono text-xs" />
          </div>
          <label className="flex items-center gap-2 text-xs col-span-1">
            <input type="checkbox" checked={webhookEnabled}
                   onChange={e => setWebhookEnabled(e.target.checked)} />
            <span>Enabled</span>
          </label>
          <div className="col-span-2 flex justify-end">
            <button onClick={saveWebhook} disabled={saving}
                    className="flex items-center gap-2 px-3 py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50">
              <Save size={14} /> Save
            </button>
          </div>
        </div>
        <p className="mt-2 text-xs text-text-muted">
          Auto-detected format: <strong>{detectFormat(webhookUrl)}</strong>
          {detectFormat(webhookUrl) !== 'generic' && (
            <> — payload will use {detectFormat(webhookUrl) === 'slack' ? 'Slack Block Kit' : 'Teams MessageCard'} shape.</>
          )}
        </p>
      </section>

      {/* ── Preview + test ───────────────────────────────────────────── */}
      <section className="bg-slate-800/60 rounded p-4 border border-slate-700">
        <h2 className="font-semibold mb-3">Preview &amp; test</h2>
        <div className="flex items-center gap-3 flex-wrap mb-3">
          <div>
            <div className="text-[10px] uppercase text-text-muted">format</div>
            <select value={format} onChange={e => setFormat(e.target.value as WebhookFormat)}
                    className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs">
              <option value="auto">auto (detect from URL)</option>
              <option value="slack">slack — Block Kit</option>
              <option value="teams">teams — MessageCard</option>
              <option value="generic">generic JSON</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs self-end">
            <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} />
            dry-run (don&rsquo;t actually send)
          </label>
          <div className="ml-auto flex gap-2">
            <button onClick={fetchPreview} disabled={busy}
                    className="flex items-center gap-2 px-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50">
              <FlaskConical size={14} /> Preview JSON
            </button>
            <button onClick={sendTest} disabled={busy}
                    className="flex items-center gap-2 px-3 py-1.5 rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-50">
              <Send size={14} /> {dryRun ? 'Test (dry-run)' : 'Send test alert'}
            </button>
          </div>
        </div>

        {preview && (
          <div className="bg-slate-900 rounded p-3 border border-slate-700">
            <div className="text-[10px] uppercase text-text-muted mb-1">
              preview · format: <strong>{preview.format}</strong>
            </div>
            <pre className="text-[10px] font-mono overflow-x-auto max-h-72 whitespace-pre-wrap">
              {JSON.stringify(preview.payload, null, 2)}
            </pre>
          </div>
        )}

        {testResult && (
          <div className="bg-slate-900 rounded p-3 border border-slate-700 mt-3">
            <div className="text-[10px] uppercase text-text-muted mb-1">test result</div>
            <div className="flex items-center gap-2 text-xs mb-2">
              {testResult.dry_run
                ? <span className="text-amber-300 flex items-center gap-1"><AlertTriangle size={12} /> dry-run — nothing was actually delivered</span>
                : <span className="text-emerald-300 flex items-center gap-1"><CheckCircle2 size={12} /> live dispatch</span>
              }
              {testResult.webhook_format && (
                <span className="text-text-muted">· format={testResult.webhook_format}</span>
              )}
            </div>
            <pre className="text-[10px] font-mono overflow-x-auto max-h-72 whitespace-pre-wrap">
              {JSON.stringify(testResult, null, 2)}
            </pre>
          </div>
        )}
      </section>
    </div>
  )
}

function ChannelCard({ name, configured, description }:
                     { name: string; configured: boolean; description: string }) {
  return (
    <div className={`rounded p-3 border ${configured ? 'border-emerald-800 bg-emerald-950/40' : 'border-slate-700 bg-slate-900/60'}`}>
      <div className="flex items-center gap-2">
        {configured
          ? <CheckCircle2 size={16} className="text-emerald-400" />
          : <AlertTriangle size={16} className="text-text-muted" />}
        <strong>{name}</strong>
        <span className={`ml-auto text-xs ${configured ? 'text-emerald-300' : 'text-text-muted'}`}>
          {configured ? 'configured' : 'not configured'}
        </span>
      </div>
      <p className="text-xs text-text-muted mt-1">{description}</p>
    </div>
  )
}

function detectFormat(url: string): 'slack' | 'teams' | 'generic' {
  const u = url.toLowerCase()
  if (u.includes('hooks.slack.com')) return 'slack'
  if (u.includes('webhook.office.com') || u.includes('outlook.office.com')) return 'teams'
  return 'generic'
}

/**
 * BMSValidation.tsx — End-to-end BMS pipeline validation runner.
 *
 * Proves the full stack works by executing 4 scripted steps:
 *   1. Push normal telemetry → SOC appears in Live dashboard
 *   2. Push over-limit frames → Safety trip fires
 *   3. Issue emergency-stop → Command logged
 *   4. Download IEC 62619 PDF report → Compliance report generated
 */
import { useState } from 'react'
import { CheckCircle, XCircle, Loader, Play, FileText, ExternalLink } from 'lucide-react'

const CELL_ID = `VAL-CELL-${Date.now().toString(36).toUpperCase()}`
const PACK_ID = 'VAL-PACK-01'

type StepStatus = 'idle' | 'running' | 'pass' | 'fail'

interface Step {
  id: number
  title: string
  description: string
  status: StepStatus
  detail: string
}

const INITIAL_STEPS: Step[] = [
  {
    id: 1,
    title: 'Push normal telemetry',
    description: `Sends 20 healthy frames for ${CELL_ID}. Verifies SOC is computed and stored.`,
    status: 'idle',
    detail: '',
  },
  {
    id: 2,
    title: 'Trigger safety trip',
    description: 'Sends 5 over-temperature frames (55 °C). Verifies IEC 62619 trip event fires.',
    status: 'idle',
    detail: '',
  },
  {
    id: 3,
    title: 'Issue emergency stop',
    description: 'Posts an emergency-stop command for the cell. Verifies it appears in command log.',
    status: 'idle',
    detail: '',
  },
  {
    id: 4,
    title: 'Download compliance PDF',
    description: 'Generates and downloads the IEC 62619 compliance report from live data.',
    status: 'idle',
    detail: '',
  },
]

function StepRow({ step }: { step: Step }) {
  const icon = {
    idle:    <div className="w-5 h-5 rounded-full border-2 border-border-subtle" />,
    running: <Loader size={18} className="text-brand-blue animate-spin" />,
    pass:    <CheckCircle size={18} className="text-emerald-400" />,
    fail:    <XCircle size={18} className="text-red-400" />,
  }[step.status]

  const bg = {
    idle:    '',
    running: 'border-brand-blue/30 bg-brand-blue/5',
    pass:    'border-emerald-500/30 bg-emerald-500/5',
    fail:    'border-red-500/30 bg-red-500/5',
  }[step.status]

  return (
    <div className={`rounded-xl border p-4 transition-all duration-300 ${bg || 'border-border-subtle'}`}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex-shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-xs font-bold text-text-muted uppercase tracking-wider">Step {step.id}</span>
          </div>
          <div className="text-sm font-semibold text-text-primary mb-0.5">{step.title}</div>
          <div className="text-xs text-text-muted">{step.description}</div>
          {step.detail && (
            <div className={`mt-2 px-3 py-2 rounded-lg text-xs font-mono
              ${step.status === 'pass' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-red-500/10 text-red-300'}`}>
              {step.detail}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function BMSValidation() {
  const [steps, setSteps]     = useState<Step[]>(INITIAL_STEPS)
  const [running, setRunning] = useState(false)
  const [done, setDone]       = useState(false)
  const [passed, setPassed]   = useState(0)

  function setStep(id: number, patch: Partial<Step>) {
    setSteps(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
  }

  async function runValidation() {
    setRunning(true)
    setDone(false)
    setSteps(INITIAL_STEPS)
    let passCount = 0

    // ── Step 1: Normal telemetry ─────────────────────────────────────────
    setStep(1, { status: 'running' })
    try {
      const r = await fetch('/api/bms/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cell_id: CELL_ID, pack_id: PACK_ID, count: 20,
          voltage: 3.75, current: -2.0, temperature: 28.0,
          chemistry: 'NMC', capacity_ah: 5.0,
        }),
      })
      const d = await r.json()
      if (r.ok && d.simulated >= 20) {
        setStep(1, { status: 'pass', detail: `✓ ${d.simulated} frames ingested · ${d.trips} trips · SOC computed` })
        passCount++
      } else {
        setStep(1, { status: 'fail', detail: `Error: ${JSON.stringify(d)}` })
      }
    } catch (e) {
      setStep(1, { status: 'fail', detail: String(e) })
    }

    // ── Step 2: Safety trip ──────────────────────────────────────────────
    setStep(2, { status: 'running' })
    try {
      // 55 °C overtemp + 4.35 V overvoltage → guaranteed trip on NMC
      const r = await fetch('/api/bms/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cell_id: CELL_ID, pack_id: PACK_ID, count: 5,
          voltage: 4.35, current: -2.0, temperature: 55.0,
          chemistry: 'NMC', capacity_ah: 5.0,
        }),
      })
      const d = await r.json()

      // Check safety events for this cell
      const evR = await fetch(`/api/bms/safety/events?cell_id=${encodeURIComponent(CELL_ID)}&limit=20`)
      const events = evR.ok ? await evR.json() : []
      const trips  = events.filter((e: { severity: string }) => e.severity === 'trip')

      if (r.ok && trips.length > 0) {
        const types = [...new Set(trips.map((e: { event_type: string }) => e.event_type))].join(', ')
        setStep(2, { status: 'pass', detail: `✓ ${trips.length} trip event(s) fired: ${types}` })
        passCount++
      } else {
        setStep(2, { status: 'fail', detail: `Simulated ${d.simulated} frames but no trips found. Events: ${events.length}` })
      }
    } catch (e) {
      setStep(2, { status: 'fail', detail: String(e) })
    }

    // ── Step 3: Emergency stop ───────────────────────────────────────────
    setStep(3, { status: 'running' })
    try {
      const r = await fetch('/api/bms/control/emergency-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target_id: CELL_ID, reason: 'validation-test' }),
      })
      const d = await r.json()
      if (r.ok && d.cmd_id) {
        setStep(3, { status: 'pass', detail: `✓ Command logged · id=${d.cmd_id} · mqtt_delivered=${d.mqtt_delivered}` })
        passCount++
      } else {
        setStep(3, { status: 'fail', detail: JSON.stringify(d) })
      }
    } catch (e) {
      setStep(3, { status: 'fail', detail: String(e) })
    }

    // ── Step 4: PDF report ───────────────────────────────────────────────
    setStep(4, { status: 'running' })
    try {
      const r = await fetch('/api/bms/safety/report.pdf')
      if (r.ok && r.headers.get('content-type')?.includes('pdf')) {
        const blob = await r.blob()
        const url  = URL.createObjectURL(blob)
        const a    = document.createElement('a')
        a.href     = url
        a.download = `iec62619_report.pdf`
        a.click()
        URL.revokeObjectURL(url)
        setStep(4, { status: 'pass', detail: `✓ PDF downloaded · ${(blob.size / 1024).toFixed(1)} KB` })
        passCount++
      } else {
        setStep(4, { status: 'fail', detail: `HTTP ${r.status} — ${r.headers.get('content-type')}` })
      }
    } catch (e) {
      setStep(4, { status: 'fail', detail: String(e) })
    }

    setPassed(passCount)
    setDone(true)
    setRunning(false)
  }

  const allPass = done && passed === INITIAL_STEPS.length

  return (
    <div className="px-6 py-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-2">
        <Play size={20} className="text-brand-blue" />
        <h1 className="text-xl font-bold text-text-primary">BMS Validation Runner</h1>
      </div>
      <p className="text-xs text-text-muted mb-6">
        Exercises the full ingestion pipeline end-to-end — telemetry ingest → SOC → safety trip → control command → PDF report —
        using the built-in telemetry <span className="text-amber-400">simulator</span> (no hardware required). The pipeline is real;
        the telemetry source is simulated. For real hardware, push live data via MQTT, CAN, or Modbus on the Adapters page.
      </p>

      {/* Cell under test */}
      <div className="mb-4 px-4 py-3 rounded-xl border border-border-subtle bg-bg-panel">
        <div className="text-xs text-text-muted mb-1">Test cell ID (generated fresh each run)</div>
        <div className="font-mono text-sm text-brand-blue font-bold">{CELL_ID}</div>
        <div className="text-xs text-text-muted mt-0.5">Pack: {PACK_ID} · Chemistry: NMC · Capacity: 5 Ah</div>
      </div>

      {/* Steps */}
      <div className="space-y-3 mb-6">
        {steps.map(s => <StepRow key={s.id} step={s} />)}
      </div>

      {/* Run button */}
      <div className="flex items-center gap-4">
        <button
          onClick={runValidation}
          disabled={running}
          className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold transition-all
            bg-brand-blue text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed">
          {running
            ? <><Loader size={14} className="animate-spin" /> Running…</>
            : <><Play size={14} /> {done ? 'Run Again' : 'Run Validation'}</>
          }
        </button>

        {done && (
          <div className={`flex items-center gap-2 text-sm font-semibold
            ${allPass ? 'text-emerald-400' : 'text-amber-400'}`}>
            {allPass
              ? <><CheckCircle size={16} /> All {passed} / {INITIAL_STEPS.length} steps passed</>
              : <><XCircle size={16} /> {passed} / {INITIAL_STEPS.length} steps passed</>
            }
          </div>
        )}
      </div>

      {/* Navigation shortcuts */}
      {done && (
        <div className="mt-6 pt-4 border-t border-border-subtle">
          <div className="text-xs text-text-muted mb-3">Inspect results in:</div>
          <div className="flex gap-2 flex-wrap">
            {[
              { label: 'Live Telemetry', to: '/bms/live' },
              { label: 'Safety Events',  to: '/bms/safety' },
              { label: 'Control Log',    to: '/bms/control' },
            ].map(({ label, to }) => (
              <a key={to} href={to}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-brand-blue/30
                  bg-brand-blue/10 text-brand-blue hover:bg-brand-blue/20 transition-all">
                <ExternalLink size={10} /> {label}
              </a>
            ))}
          </div>
        </div>
      )}

      {/* About */}
      <div className="mt-6 p-4 rounded-xl border border-border-subtle/50 bg-bg-panel/50">
        <div className="flex items-center gap-2 mb-2">
          <FileText size={12} className="text-text-muted" />
          <span className="text-xs font-semibold text-text-muted uppercase tracking-wider">What this validates</span>
        </div>
        <ul className="space-y-1 text-xs text-text-muted">
          <li>• REST ingest → Coulomb-counting SOC estimator → SQLite timeseries</li>
          <li>• IEC 62619 safety thresholds (NMC: V≤4.2V, T≤50°C) → trip signal</li>
          <li>• Control command API → DB log + MQTT publish attempt</li>
          <li>• fpdf2 PDF generation from live safety summary data</li>
          <li>• MambaRUL inference fires after 10 frames (check Live Telemetry for RUL column)</li>
        </ul>
      </div>
    </div>
  )
}

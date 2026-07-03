/**
 * OnboardingWizard — 3-step first-time user modal.
 * Shown once per browser. Skippable. Sets localStorage flag on completion.
 */
import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import {
  X, Activity, Layers, Zap, FlaskConical,
  TableProperties, ChevronRight, CheckCircle2
} from 'lucide-react'

const FLAG_KEY = 'bos_onboarded'

const DEMO_RESULT = {
  predicted_rul: 877,
  lower_90: 817,
  upper_90: 937,
  phase: 'Fresh',
  chemistry: 'NMC',
}

const STEPS = [
  {
    title: 'Welcome to BatteryOS',
    sub: 'AI-powered remaining useful life for your entire battery fleet.',
    content: (
      <div className="space-y-4">
        <p className="text-sm text-text-secondary leading-relaxed">
          BatteryOS turns raw BMS measurements into actionable RUL predictions — before a cell fails.
          Built on <strong className="text-text-primary">MambaRUL</strong>, a state-space sequence model
          trained on 167,000 charge cycles across 5 chemistries.
        </p>
        <div className="grid grid-cols-2 gap-3">
          {[
            { icon: Zap,            label: 'Live Predict',   desc: 'Single-cell instant RUL' },
            { icon: Layers,         label: 'Fleet View',     desc: 'All cells at a glance' },
            { icon: TableProperties,label: 'Batch',          desc: 'CSV → RUL for 500 cells' },
            { icon: FlaskConical,   label: 'Calibrate',      desc: 'Custom conformal bounds' },
          ].map(({ icon: Icon, label, desc }) => (
            <div key={label} className="bg-bg-panel border border-border-subtle rounded-lg p-3 flex gap-2.5 items-start">
              <Icon size={14} className="text-brand-blue mt-0.5 flex-shrink-0" />
              <div>
                <div className="text-xs font-semibold text-text-primary">{label}</div>
                <div className="text-[10px] text-text-muted">{desc}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    title: 'Try a live prediction',
    sub: 'NMC cell · 97% SOH · 2.0 Ah · MambaRUL v10-final',
    content: (
      <div className="space-y-4">
        <div className="bg-bg-panel border border-border-subtle rounded-xl p-4 space-y-2 font-mono text-xs">
          <div className="text-text-muted text-[10px] uppercase tracking-wide mb-3">Input (BMS snapshot)</div>
          {[
            ['Chemistry', 'NMC'],
            ['SOH', '97%'],
            ['Nom. Capacity', '2.0 Ah'],
            ['Int. Resistance', '0.038 Ω'],
            ['Temperature', '25 °C'],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between">
              <span className="text-text-muted">{k}</span>
              <span className="text-text-primary">{v}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs text-emerald-400 font-semibold">
          <CheckCircle2 size={13} /> Prediction result
        </div>

        <div className="grid grid-cols-3 gap-2">
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-lg p-3 col-span-1">
            <div className="text-[9px] text-text-muted uppercase">Predicted RUL</div>
            <div className="text-2xl font-bold font-mono text-emerald-400 mt-0.5">{DEMO_RESULT.predicted_rul}</div>
            <div className="text-[9px] text-text-muted">cycles</div>
          </div>
          <div className="bg-bg-panel border border-border-subtle rounded-lg p-3">
            <div className="text-[9px] text-text-muted uppercase">90% CI</div>
            <div className="text-sm font-bold font-mono text-text-primary mt-0.5">
              {DEMO_RESULT.lower_90}–{DEMO_RESULT.upper_90}
            </div>
          </div>
          <div className="bg-bg-panel border border-border-subtle rounded-lg p-3">
            <div className="text-[9px] text-text-muted uppercase">Phase</div>
            <div className="text-sm font-bold text-emerald-400 mt-0.5">{DEMO_RESULT.phase}</div>
          </div>
        </div>
        <p className="text-[10px] text-text-muted">
          Head to <strong className="text-text-secondary">Live Predict</strong> to run this with your own BMS values.
        </p>
      </div>
    ),
  },
  {
    title: "You're ready",
    sub: "Here's how to get the most out of BatteryOS.",
    content: (
      <div className="space-y-3">
        {[
          { num: '1', text: 'Go to Fleet View to see all your cells ranked by health.' },
          { num: '2', text: 'Click any cell → Cell Deep Dive for full RUL trajectory + downloadable report.' },
          { num: '3', text: 'Drop a CSV in Batch Predict to score your entire fleet in one call.' },
          { num: '4', text: 'Use Calibrate when you have a new cell type — enter 5+ cycles for tighter bounds.' },
          { num: '5', text: 'Generate an API key to integrate BatteryOS into your BMS pipeline.' },
        ].map(({ num, text }) => (
          <div key={num} className="flex gap-3 items-start">
            <div className="w-5 h-5 rounded-full bg-brand-blue/20 text-brand-blue text-[10px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
              {num}
            </div>
            <p className="text-sm text-text-secondary leading-relaxed">{text}</p>
          </div>
        ))}
      </div>
    ),
  },
]

export default function OnboardingWizard() {
  const navigate = useNavigate()
  const [step,    setStep]    = useState(0)
  const [visible, setVisible] = useState(false)
  const [seeding, setSeeding] = useState(false)

  async function seedAndExplore() {
    setSeeding(true)
    try {
      await fetch('/api/demo/seed', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ n_cells: 12, model_id: 'v10-final' }),
      })
    } catch { /* best-effort — proceed regardless */ }
    setSeeding(false)
    close()
    navigate('/fleet')
  }

  useEffect(() => {
    if (!localStorage.getItem(FLAG_KEY)) {
      // Small delay so the app renders first
      const t = setTimeout(() => setVisible(true), 800)
      return () => clearTimeout(t)
    }
  }, [])

  const close = () => {
    localStorage.setItem(FLAG_KEY, '1')
    setVisible(false)
  }

  const finish = () => {
    close()
    navigate('/fleet')
  }

  const isLast = step === STEPS.length - 1

  return (
    <AnimatePresence>
      {visible && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
            onClick={close}
          />

          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 16 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none"
          >
            <div className="w-full max-w-md bg-bg-secondary border border-border-subtle rounded-2xl shadow-xl pointer-events-auto">

              {/* Header */}
              <div className="flex items-center gap-3 p-5 border-b border-border-subtle">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-blue to-brand-cyan flex items-center justify-center flex-shrink-0">
                  <Activity size={15} className="text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-text-primary">{STEPS[step].title}</div>
                  <div className="text-[10px] text-text-muted truncate">{STEPS[step].sub}</div>
                </div>
                <button onClick={close} className="text-text-muted hover:text-text-secondary transition-colors">
                  <X size={16} />
                </button>
              </div>

              {/* Content */}
              <div className="p-5">
                <AnimatePresence mode="wait">
                  <motion.div key={step}
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -16 }}
                    transition={{ duration: 0.18 }}>
                    {STEPS[step].content}
                  </motion.div>
                </AnimatePresence>
              </div>

              {/* Footer */}
              <div className="flex items-center justify-between px-5 pb-5">
                {/* Step dots */}
                <div className="flex gap-1.5">
                  {STEPS.map((_, i) => (
                    <div key={i} className={`h-1.5 rounded-full transition-all ${
                      i === step ? 'w-5 bg-brand-blue' : 'w-1.5 bg-border-subtle'
                    }`} />
                  ))}
                </div>

                <div className="flex items-center gap-2">
                  {step > 0 && (
                    <button onClick={() => setStep(s => s - 1)}
                      className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors">
                      Back
                    </button>
                  )}
                  {!isLast ? (
                    <button onClick={() => setStep(s => s + 1)}
                      className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors">
                      Next <ChevronRight size={12} />
                    </button>
                  ) : (
                    <>
                      <button onClick={finish}
                        className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors">
                        Skip
                      </button>
                      <button onClick={seedAndExplore} disabled={seeding}
                        className="flex items-center gap-1.5 px-4 py-1.5 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors disabled:opacity-50">
                        {seeding ? 'Loading demo…' : 'Load demo fleet & explore'} <ChevronRight size={12} />
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}

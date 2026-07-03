import { useEffect, useState, useCallback } from 'react'
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Upload, Layers, Zap,
  Settings2, LogOut, Bell, FlaskConical,
  BarChart3, BatteryFull, TableProperties, Activity, Key,
  MessageCircle, X, RefreshCw, ShieldAlert, Sliders, Wifi, FlaskRound,
  AlertTriangle, Cpu, Recycle, Award, GitMerge, ShieldCheck,
  Brain, Thermometer, Flame, Menu
} from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from './AuthGate'

const APP_VERSION = '1.0.0'

interface NavItem { to: string; icon: LucideIcon; label: string; exact?: boolean }
interface NavGroup { label: string; items: NavItem[] }

const NAV: NavGroup[] = [
  {
    label: 'Predict',
    items: [
      { to: '/',        icon: LayoutDashboard, label: 'Dashboard',      exact: true },
      { to: '/predict', icon: Zap,             label: 'Live Predict' },
      { to: '/pack',    icon: BatteryFull,     label: 'Pack Predict' },
      { to: '/batch',   icon: TableProperties, label: 'Batch Predict' },
      { to: '/upload',  icon: Upload,          label: 'Upload & Analyze' },
      { to: '/cycler-import', icon: FlaskConical, label: 'Cycler Import' },
      { to: '/cycler-qa',     icon: BarChart3,    label: 'Cycler QA' },
    ],
  },
  {
    label: 'BMS Hardware',
    items: [
      { to: '/bms/live',       icon: Activity,    label: 'Live Telemetry' },
      { to: '/bms/safety',     icon: ShieldAlert, label: 'Safety Events' },
      { to: '/bms/control',    icon: Sliders,     label: 'Control Panel' },
      { to: '/bms/adapters',   icon: Wifi,        label: 'Adapters' },
      { to: '/bms/validation', icon: FlaskRound,  label: 'Validation' },
      { to: '/thermal-coupling', icon: Thermometer, label: 'Thermal Coupling' },
      { to: '/thermal-runaway',  icon: Flame,       label: 'Thermal Runaway' },
    ],
  },
  {
    label: 'Fleet',
    items: [
      { to: '/fleet',   icon: Layers,        label: 'Fleet View' },
      { to: '/alerts',  icon: Bell,          label: 'Alert History' },
      { to: '/anomaly', icon: AlertTriangle, label: 'Anomaly Detector' },
    ],
  },
  {
    label: 'Battery Intelligence',
    items: [
      { to: '/digital-twin', icon: Cpu,          label: 'Digital Twin' },
      { to: '/second-life',  icon: Recycle,      label: 'Second Life' },
      { to: '/grade',        icon: Award,        label: 'Battery Grading' },
      { to: '/weak-cell',    icon: GitMerge,     label: 'Weak Cell' },
      { to: '/warranty',     icon: ShieldCheck,  label: 'Warranty' },
      { to: '/calibrate',    icon: FlaskConical, label: 'Calibrate' },
      { to: '/online-learning', icon: Brain,    label: 'Online Learning' },
      { to: '/internal-state-validation', icon: Activity, label: 'Internal-State Validation' },
    ],
  },
  {
    label: 'Account',
    items: [
      { to: '/analytics', icon: BarChart3, label: 'Analytics' },
      { to: '/keys',      icon: Key,       label: 'API Keys' },
      { to: '/settings',  icon: Settings2, label: 'Settings' },
    ],
  },
]

function NavGroupBlock({ group }: { group: NavGroup }) {
  return (
    <div className="mb-3">
      <div className="px-3 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-widest">
        {group.label}
      </div>
      {group.items.map(({ to, icon: Icon, label, exact = false }) => (
        <NavLink
          key={to}
          to={to}
          end={exact}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-150',
              isActive
                ? 'bg-brand-blue/10 text-brand-blue border border-brand-blue/20'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-panel'
            )
          }
        >
          <Icon size={13} className="flex-shrink-0" />
          <span>{label}</span>
        </NavLink>
      ))}
    </div>
  )
}

export default function Layout() {
  const location   = useLocation()
  const navigate   = useNavigate()
  const { logout } = useAuth()
  const [backendOk,    setBackendOk]    = useState<boolean | null>(null)
  const [unackCount,   setUnackCount]   = useState(0)
  const [updateAvail,  setUpdateAvail]  = useState(false)
  const [supportOpen,  setSupportOpen]  = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.ok ? r.json() : null)
      .then(d => setBackendOk(d?.status === 'ok'))
      .catch(() => setBackendOk(false))
    // Auto-update check
    fetch('/api/version').then(r => r.json()).then(d => {
      if (d.version && d.version !== APP_VERSION) setUpdateAvail(true)
    }).catch(() => {})
  }, [])

  const pollAlerts = useCallback(() => {
    fetch('/api/alerts/count')
      .then(r => r.json())
      .then(d => setUnackCount(d.unacknowledged ?? 0))
      .catch(() => {})
  }, [])

  useEffect(() => {
    pollAlerts()
    const t = setInterval(pollAlerts, 30_000)
    return () => clearInterval(t)
  }, [pollAlerts])

  return (
    <div className="flex h-screen bg-bg-primary overflow-hidden">
      {/* Support modal */}
      {supportOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-80 bg-bg-secondary border border-border-subtle rounded-2xl p-6 space-y-4">
            <div className="flex items-center gap-2">
              <MessageCircle size={15} className="text-brand-blue" />
              <span className="text-sm font-semibold text-text-primary">Support & Feedback</span>
              <button onClick={() => setSupportOpen(false)} className="ml-auto text-text-muted hover:text-text-primary">
                <X size={14} />
              </button>
            </div>
            <p className="text-xs text-text-muted">We're here to help. Reach us through any of the channels below.</p>
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="text-text-muted w-14">Email</span>
                <a href="mailto:support@batteryos.io" className="text-brand-blue hover:underline">support@batteryos.io</a>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-text-muted w-14">Version</span>
                <span className="text-text-secondary font-mono">{APP_VERSION}</span>
              </div>
            </div>
            <textarea
              placeholder="Describe your issue or feedback…"
              rows={4}
              className="w-full px-3 py-2 text-xs bg-bg-panel border border-border-subtle rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-brand-blue/50 resize-none"
            />
            <button
              onClick={() => { window.open('mailto:support@batteryos.io?subject=BatteryOS%20Feedback'); setSupportOpen(false) }}
              className="w-full py-2 bg-brand-blue text-white text-xs font-semibold rounded-lg hover:bg-blue-500 transition-colors">
              Send via Email
            </button>
          </div>
        </div>
      )}

      {/* Update available banner */}
      {updateAvail && (
        <div className="fixed top-0 left-0 right-0 z-40 bg-amber-500/90 text-white text-[11px] flex items-center justify-center gap-3 py-1.5">
          <RefreshCw size={11} />
          A new version of BatteryOS is available — contact your admin to update.
          <button onClick={() => setUpdateAvail(false)} className="opacity-70 hover:opacity-100"><X size={11}/></button>
        </div>
      )}

      {/* Sidebar */}
      {/* Mobile top bar */}
      <div className={`md:hidden fixed inset-x-0 z-30 h-12 bg-bg-secondary border-b border-border-subtle flex items-center gap-3 px-3 ${updateAvail ? 'top-7' : 'top-0'}`}>
        <button onClick={() => setMobileNavOpen(true)}
                className="p-1.5 rounded hover:bg-bg-panel" aria-label="Open menu">
          <Menu size={18} className="text-text-secondary" />
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="w-6 h-6 rounded bg-gradient-to-br from-brand-blue to-brand-cyan flex items-center justify-center">
            <Activity size={12} className="text-white" />
          </div>
          <div className="text-sm font-bold text-text-primary truncate">BatteryOS</div>
        </div>
        <button onClick={() => navigate('/alerts')}
                className="relative p-1.5 rounded hover:bg-bg-panel" aria-label="Alerts">
          <Bell size={16} className={unackCount > 0 ? 'text-red-400' : 'text-text-muted'} />
          {unackCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-red-500 text-white text-[8px] font-bold rounded-full flex items-center justify-center leading-none">
              {unackCount > 9 ? '9+' : unackCount}
            </span>
          )}
        </button>
      </div>

      {/* Mobile drawer backdrop */}
      {mobileNavOpen && (
        <div className="md:hidden fixed inset-0 z-40 bg-black/60"
             onClick={() => setMobileNavOpen(false)} />
      )}

      <aside className={clsx(
        "fixed md:relative inset-y-0 left-0 z-50 w-64 md:w-52 flex-shrink-0",
        "bg-bg-secondary border-r border-border-subtle flex flex-col",
        "transform transition-transform duration-200 md:transform-none",
        mobileNavOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        updateAvail ? "md:mt-7" : "",
      )}>

        {/* Logo */}
        <div className="px-4 py-4 border-b border-border-subtle">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-brand-blue to-brand-cyan flex items-center justify-center shadow-glow-sm">
              <Activity size={16} className="text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-bold text-text-primary leading-none">BatteryOS</div>
              <div className="text-[10px] text-text-muted leading-none mt-0.5">RUL Intelligence</div>
            </div>
            {/* Notification bell */}
            <button
              onClick={() => navigate('/alerts')}
              className="relative p-1 rounded-md hover:bg-bg-panel transition-colors"
              title={unackCount > 0 ? `${unackCount} unacknowledged alerts` : 'Alert history'}>
              <Bell size={14} className={unackCount > 0 ? 'text-red-400' : 'text-text-muted'} />
              {unackCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 bg-red-500 text-white text-[8px] font-bold rounded-full flex items-center justify-center leading-none">
                  {unackCount > 9 ? '9+' : unackCount}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-2 py-3 overflow-y-auto">
          {NAV.map(g => <NavGroupBlock key={g.label} group={g} />)}
        </nav>

        {/* Status + footer */}
        <div className="px-4 py-3 border-t border-border-subtle space-y-2">
          {backendOk !== null && (
            <div className={`flex items-center gap-1.5 text-[10px] ${backendOk ? 'text-emerald-400' : 'text-red-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${backendOk ? 'bg-emerald-400' : 'bg-red-400'}`} />
              {backendOk ? 'Engine online' : 'Engine offline'}
            </div>
          )}
          <div className="text-[10px] text-text-muted">
            <div className="font-medium text-text-secondary">BatteryOS v1.0</div>
            <div className="mt-0.5">AI-powered RUL prediction</div>
          </div>
          <button onClick={() => setSupportOpen(true)}
            className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-brand-blue transition-colors">
            <MessageCircle size={11} /> Support
          </button>
          <button onClick={logout}
            className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-red-400 transition-colors">
            <LogOut size={11} /> Sign out
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className={`flex-1 overflow-y-auto pt-12 md:pt-0 ${updateAvail ? 'md:mt-7' : ''}`}>
        <motion.div
          key={location.pathname}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.18 }}
          className="min-h-full"
        >
          <Outlet />
        </motion.div>
      </main>
    </div>
  )
}

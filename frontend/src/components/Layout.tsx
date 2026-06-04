import { useEffect, useState, useCallback } from 'react'
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Upload, Layers, Zap,
  Activity, Brain, Key, TableProperties, FlaskConical,
  GitCompare, GitMerge, Settings2, LogOut, Bell, BarChart3, BatteryFull, Cpu, Users,
  MessageCircle, Wifi, ShieldAlert, Sliders, Network, FlaskRound, TestTube2, Recycle, ScanLine, BarChart2, Atom, Award, ShieldCheck,
  Thermometer, Flame, Microscope, Menu, X as XIcon, Box
} from 'lucide-react'
import clsx from 'clsx'
import { useAuth } from './AuthGate'
import OnboardingWizard from './OnboardingWizard'

interface NavItem { to: string; icon: LucideIcon; label: string; exact?: boolean; adminOnly?: boolean }
interface NavGroup { label: string; items: NavItem[] }

const NAV: NavGroup[] = [
  {
    label: 'Platform',
    items: [
      { to: '/',        icon: LayoutDashboard, label: 'Dashboard',       exact: true },
      { to: '/upload',  icon: Upload,          label: 'Upload & Analyze' },
      { to: '/cycler-import', icon: FlaskConical, label: 'Cycler Import' },
      { to: '/cycler-qa',     icon: BarChart3,    label: 'Cycler QA' },
      { to: '/fleet',   icon: Layers,          label: 'Fleet View' },
      { to: '/predict', icon: Zap,             label: 'Live Predict' },
      { to: '/pack',    icon: BatteryFull,    label: 'Pack Predict' },
    ],
  },
  {
    label: 'BMS Hardware',
    items: [
      { to: '/bms',          icon: Activity,    label: 'BMS Dashboard' },
      { to: '/bms/live',     icon: Network,     label: 'Live Telemetry' },
      { to: '/bms/safety',   icon: ShieldAlert, label: 'Safety Events' },
      { to: '/bms/control',  icon: Sliders,     label: 'Control Panel' },
      { to: '/bms/adapters',   icon: Wifi,        label: 'Adapters' },
      { to: '/bms/validation', icon: FlaskRound,  label: 'Validation' },
      { to: '/thermal-coupling', icon: Thermometer, label: 'Thermal Coupling' },
      { to: '/thermal-runaway',  icon: Flame,       label: 'Thermal Runaway' },
      { to: '/thermal-twin',     icon: Box,         label: 'Thermal Twin' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/models',          icon: Brain,            label: 'Models' },
      { to: '/batch',           icon: TableProperties,  label: 'Batch Predict' },
      { to: '/finetune',        icon: Cpu,              label: 'Fine-Tune',      adminOnly: true },
      { to: '/online-learning', icon: Brain,            label: 'Online Learning' },
      { to: '/phase-c',         icon: Microscope,       label: 'Phase C Research', adminOnly: true },
      { to: '/experiments',     icon: TestTube2,        label: 'Experiments',    adminOnly: true },
      { to: '/second-life',     icon: Recycle,          label: 'Second Life' },
      { to: '/grade',           icon: Award,            label: 'Battery Grading' },
      { to: '/weak-cell',       icon: GitMerge,         label: 'Weak Cell' },
      { to: '/warranty',        icon: ShieldCheck,      label: 'Warranty' },
      { to: '/anomaly',         icon: ScanLine,         label: 'Anomaly SPC' },
      { to: '/ic-analysis',     icon: BarChart2,        label: 'IC Analysis' },
      { to: '/digital-twin',    icon: Atom,             label: 'Digital Twin' },
      { to: '/calibrate',       icon: FlaskConical,     label: 'Calibrate' },
      { to: '/compare-models',  icon: GitCompare,       label: 'Compare Models' },
      { to: '/analytics',       icon: BarChart3,        label: 'Analytics' },
      { to: '/customers',       icon: Users,            label: 'Customer Hub',   adminOnly: true },
      { to: '/keys',            icon: Key,              label: 'API Keys' },
      { to: '/notifications',   icon: Bell,             label: 'Notifications',  adminOnly: true },
      { to: '/settings',        icon: Settings2,        label: 'Settings',       adminOnly: true },
    ],
  },
]

function NavGroupBlock({ group, isAdmin }: { group: NavGroup; isAdmin: boolean }) {
  const visible = group.items.filter(i => !i.adminOnly || isAdmin)
  if (visible.length === 0) return null
  return (
    <div className="mb-3">
      <div className="px-3 py-1 text-[10px] font-semibold text-text-muted uppercase tracking-widest">
        {group.label}
      </div>
      {visible.map(({ to, icon: Icon, label, exact = false }) => (
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
  const { logout, role } = useAuth()
  const isAdmin = role === 'admin'
  const [backendOk,  setBackendOk]  = useState<boolean | null>(null)
  const [unackCount, setUnackCount] = useState(0)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Auto-close mobile drawer on route change
  useEffect(() => { setMobileNavOpen(false) }, [location.pathname])

  useEffect(() => {
    fetch('/api/health')
      .then(r => r.ok ? r.json() : null)
      .then(d => setBackendOk(d?.status === 'ok'))
      .catch(() => setBackendOk(false))
  }, [])

  const pollAlerts = useCallback(() => {
    fetch('/api/alerts/count')
      .then(r => r.json())
      .then(d => setUnackCount(d.unacknowledged ?? 0))
      .catch(() => {})
  }, [])

  useEffect(() => {
    pollAlerts()
    const t = setInterval(pollAlerts, 30_000)   // poll every 30s
    return () => clearInterval(t)
  }, [pollAlerts])

  return (
    <div className="flex h-screen bg-bg-primary overflow-hidden">
      {/* Mobile top bar (visible <md only) */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 h-12 bg-bg-secondary border-b border-border-subtle flex items-center gap-3 px-3">
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
                className="relative p-1.5 rounded hover:bg-bg-panel"
                aria-label="Alerts">
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

      {/* Sidebar — slides in on mobile, static on md+ */}
      <aside className={clsx(
        "fixed md:relative inset-y-0 left-0 z-50 w-64 md:w-52 flex-shrink-0",
        "bg-bg-secondary border-r border-border-subtle flex flex-col",
        "transform transition-transform duration-200 md:transform-none",
        mobileNavOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
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
          {NAV.map(g => <NavGroupBlock key={g.label} group={g} isAdmin={isAdmin} />)}
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
            <div className="font-medium text-text-secondary">v10-final · R²=0.911</div>
            <div className="mt-0.5">5 chemistries · 167k rows</div>
          </div>
          <a href="mailto:support@batteryos.io"
            className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-brand-blue transition-colors">
            <MessageCircle size={11} /> Support
          </a>
          <button onClick={logout}
            className="flex items-center gap-1.5 text-[10px] text-text-muted hover:text-red-400 transition-colors">
            <LogOut size={11} /> Sign out
          </button>
        </div>
      </aside>

      {/* Mobile-only close button inside the drawer */}
      {mobileNavOpen && (
        <button onClick={() => setMobileNavOpen(false)}
                className="md:hidden fixed top-2 right-2 z-50 p-1.5 rounded bg-bg-secondary border border-border-subtle"
                aria-label="Close menu">
          <XIcon size={18} className="text-text-secondary" />
        </button>
      )}

      {/* Onboarding wizard (shown once on first login) */}
      <OnboardingWizard />

      {/* Main content — leaves room for mobile top bar */}
      <main className="flex-1 overflow-y-auto pt-12 md:pt-0">
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

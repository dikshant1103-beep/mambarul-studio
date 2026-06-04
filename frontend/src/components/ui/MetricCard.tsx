import { motion } from 'framer-motion'
import clsx from 'clsx'

interface MetricCardProps {
  label: string
  value: string | number
  unit?: string
  subtitle?: string
  color?: 'blue' | 'cyan' | 'emerald' | 'amber' | 'red' | 'purple'
  size?: 'sm' | 'md' | 'lg'
  animate?: boolean
}

const COLOR_MAP = {
  blue: 'text-blue-400 border-blue-500/20 bg-blue-500/5',
  cyan: 'text-cyan-400 border-cyan-500/20 bg-cyan-500/5',
  emerald: 'text-emerald-400 border-emerald-500/20 bg-emerald-500/5',
  amber: 'text-amber-400 border-amber-500/20 bg-amber-500/5',
  red: 'text-red-400 border-red-500/20 bg-red-500/5',
  purple: 'text-purple-400 border-purple-500/20 bg-purple-500/5',
}

export default function MetricCard({
  label,
  value,
  unit,
  subtitle,
  color = 'blue',
  size = 'md',
  animate = true,
}: MetricCardProps) {
  const valueClass = {
    sm: 'text-xl',
    md: 'text-2xl',
    lg: 'text-4xl',
  }[size]

  return (
    <motion.div
      initial={animate ? { opacity: 0, scale: 0.95 } : undefined}
      animate={animate ? { opacity: 1, scale: 1 } : undefined}
      transition={{ duration: 0.3 }}
      className={clsx(
        'rounded-xl border p-4 flex flex-col gap-1',
        COLOR_MAP[color]
      )}
    >
      <span className="text-xs font-medium text-text-muted uppercase tracking-wider">{label}</span>
      <div className="flex items-baseline gap-1">
        <span className={clsx('font-mono font-semibold leading-none', valueClass)}>
          {value}
        </span>
        {unit && <span className="text-xs text-text-muted font-medium">{unit}</span>}
      </div>
      {subtitle && <span className="text-xs text-text-muted mt-0.5">{subtitle}</span>}
    </motion.div>
  )
}

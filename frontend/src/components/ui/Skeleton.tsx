import clsx from 'clsx'

interface SkeletonProps { className?: string; lines?: number }

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={clsx(
      'animate-pulse bg-gradient-to-r from-bg-elevated via-bg-panel to-bg-elevated rounded-lg',
      className
    )} />
  )
}

export function SkeletonPanel({ lines = 4 }: SkeletonProps) {
  return (
    <div className="panel p-5 space-y-3">
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={`h-3 ${i === lines - 1 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  )
}

export function SkeletonChart({ height = 240 }: { height?: number }) {
  return (
    <div className="panel p-5">
      <Skeleton className="h-4 w-1/4 mb-4" />
      <div className="animate-pulse bg-bg-elevated rounded-lg flex items-end gap-2 px-3 pb-2"
           style={{ height }}>
        {Array.from({ length: 20 }).map((_, i) => (
          <div key={i} className="flex-1 rounded-t bg-border-subtle/60"
               style={{ height: `${30 + Math.sin(i * 0.7) * 20 + Math.random() * 30}%` }} />
        ))}
      </div>
    </div>
  )
}

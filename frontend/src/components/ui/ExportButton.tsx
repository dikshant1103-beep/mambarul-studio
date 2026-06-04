import { Download } from 'lucide-react'

interface ExportCSVProps {
  data: Record<string, unknown>[]
  filename?: string
  label?: string
}

export function ExportCSV({ data, filename = 'export.csv', label = 'CSV' }: ExportCSVProps) {
  const download = () => {
    if (!data.length) return
    const keys = Object.keys(data[0])
    const csv = [keys.join(','), ...data.map(r => keys.map(k => JSON.stringify(r[k] ?? '')).join(','))].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <button onClick={download} className="btn-ghost flex items-center gap-1.5 text-xs">
      <Download size={13} /> {label}
    </button>
  )
}

export function ExportJSON({ data, filename = 'export.json' }: { data: unknown; filename?: string }) {
  const download = () => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <button onClick={download} className="btn-ghost flex items-center gap-1.5 text-xs">
      <Download size={13} /> JSON
    </button>
  )
}

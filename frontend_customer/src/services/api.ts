const BASE = '/api'

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`)
  return res.json()
}

async function post<T, B>(path: string, body: B): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`API error ${res.status}: ${path}`)
  return res.json()
}

export const api = {
  health: () => get<{ status: string; data_loaded: boolean; rows: number }>('/health'),

  datasets: {
    list: () => get<Record<string, unknown>[]>('/datasets'),
    cells: (dataset: string) => get<Record<string, unknown>[]>(`/datasets/${dataset}/cells`),
    capacity: (dataset: string, cell: string) =>
      get<Record<string, unknown>>(`/datasets/${dataset}/cells/${cell}/capacity`),
    rul: (dataset: string, cell: string) =>
      get<Record<string, unknown>>(`/datasets/${dataset}/cells/${cell}/rul`),
    chemistryStats: () => get<Record<string, unknown>>('/datasets/stats/chemistry'),
  },

  results: {
    benchmark: () => get<Record<string, unknown>[]>('/results/benchmark'),
    chemistry: () => get<Record<string, unknown>[]>('/results/chemistry'),
    versionLadder: () => get<Record<string, unknown>[]>('/results/version-ladder'),
    oxford: () => get<Record<string, unknown>[]>('/results/oxford'),
    ksweep: () => get<Record<string, unknown>[]>('/results/ksweep'),
  },

  features: {
    list: () => get<Record<string, unknown>[]>('/features'),
    importance: (name: string) => get<Record<string, unknown>>(`/features/${name}/importance`),
    pipeline: () => get<Record<string, unknown>[]>('/features/pipeline'),
    leakageAudit: () => get<Record<string, unknown>[]>('/features/leakage-audit'),
  },

  models: {
    list: () => get<Record<string, unknown>[]>('/models'),
    architecture: (id: string) => get<Record<string, unknown>>(`/models/${id}`),
  },

  predict: {
    run: (body: Record<string, unknown>) =>
      post<Record<string, unknown>, Record<string, unknown>>('/predict', body),
    demo: () => get<Record<string, unknown>[]>('/predict/demo'),
  },

  ingest: {
    // Upload a CSV/JSON file; returns IngestResult with summary + per-cycle predictions
    uploadFile: async (file: File): Promise<Record<string, unknown>> => {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`${BASE}/ingest`, { method: 'POST', body: form })
      if (!res.ok) throw new Error(`API error ${res.status}: /ingest`)
      return res.json()
    },
    detectChemistry: (body: { voltage_mean?: number[]; capacity?: number[]; chemistry_hint?: string }) =>
      post<Record<string, unknown>, typeof body>('/detect-chemistry', body),
  },

  figures: {
    list: () => get<Record<string, unknown>>('/figures'),
  },
}

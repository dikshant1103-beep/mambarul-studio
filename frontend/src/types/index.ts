export type Chemistry = 'LCO' | 'LFP' | 'NMC' | 'NCM' | 'NCA'

export interface Dataset {
  name: string
  chemistry: Chemistry
  chemistry_code: number
  form_factor: string
  nominal_capacity: number
  temperature: number | string
  protocol: string
  cell_count: number
  avg_cycles: number
  description: string
}

export interface Cell {
  cell_id: string
  dataset: string
  chemistry: Chemistry
  chemistry_code: number
  split: string
  n_cycles: number
  lifetime: number
}

export interface CapacityCurve {
  cell_id: string
  chemistry: string
  cycles: number[]
  capacity: number[]
  rul: number[]
  soh: number[]
}

export interface Feature {
  id: string
  name: string
  index: number
  category: 'raw' | 'derived'
  leakage: boolean
  formula: string
  description: string
  importance: Record<string, number>
}

export interface ModelArchitecture {
  id: string
  name: string
  family: string
  params: number
  description: string
  best_rmse: number
  best_r2: number
  checkpoint?: string
  layers: ArchitectureLayer[]
  connections: [string, string][]
  anchors?: string[]
}

export interface ArchitectureLayer {
  id: string
  type: LayerType
  label: string
  x: number
  y: number
  color?: string
}

export type LayerType =
  | 'input' | 'output'
  | 'linear' | 'mlp'
  | 'mamba' | 'ssm'
  | 'attention' | 'self_attention'
  | 'conv' | 'tcn'
  | 'lstm' | 'gru' | 'bilstm'
  | 'positional' | 'embedding'
  | 'pooling' | 'norm'
  | 'film' | 'projection'

export interface BenchmarkResult {
  model: string
  model_id: string
  rmse: number
  mae: number | null
  r2: number
  params: number
  chemistry?: string
  rmse_pct?: number
}

export interface ChemistryResults {
  chemistry: string
  rmse: number
  mae: number | null
  r2: number
  rmse_pct: number
  n_cells: number
}

export interface VersionLadderEntry {
  version: string
  features: number | string
  method: string
  calce_rmse: number
  calce_r2: number
  notes: string
  breakthrough?: boolean
}

export interface OxfordResult {
  k: number
  cell7_rmse: number
  cell7_r2: number
  cell8_rmse: number
  cell8_r2: number
  combined_r2: number
  method: string
  notes?: string
}

export interface PredictRequest {
  chemistry: string
  cap_pct: number
  capacity: number
  charge_time?: number
  voltage_mean?: number
  energy?: number
  temperature?: number
  delta_cap?: number
  int_resistance?: number
}

export interface PredictResponse {
  predicted_rul: number
  lower_bound: number
  upper_bound: number
  health_score: number
  phase: string
  chemistry: string
  model: string
}

export interface LeakageAuditData {
  feature: string
  correlation_with_rul: number
  is_leaky: boolean
  description: string
  impact: 'high' | 'medium' | 'low'
}

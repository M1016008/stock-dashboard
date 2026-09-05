import type {
  IntegratedScreeningRow,
  ScreeningCondition,
  ScreeningMetricKey,
} from '@/lib/integrated-screener'
import type { ScreenerReasonContract } from '@/lib/screener-reason'

export type SavedScreenEvaluationStatus = 'NEW' | 'STAY' | 'OUT'

export interface SavedScreenStateContract {
  asOf?: string
  conditions: ScreeningCondition[]
  sort: ScreeningMetricKey
  direction: 'asc' | 'desc'
  columns: ScreeningMetricKey[]
  page?: number
}

export interface SavedScreenEvaluationSummary {
  evaluationId: string
  definitionVersion: number
  evaluatedAt: string
  asOf: string
  snapshotDate: string
  previousEvaluationId: string | null
  previousAsOf: string | null
  matchedCount: number
  newCount: number
  stayCount: number
  outCount: number
  elapsedMs: number
}

export interface SavedScreenDefinitionContract {
  id: string
  name: string
  definitionVersion: number
  state: SavedScreenStateContract
  active: boolean
  createdAt: string
  updatedAt: string
  latestEvaluation: SavedScreenEvaluationSummary | null
  history: SavedScreenEvaluationSummary[]
}

export interface SavedScreenEvaluationMember {
  ticker: string
  name: string
  status: SavedScreenEvaluationStatus
}

export interface SavedScreenEvaluationDetail {
  contractVersion: 'saved-screen-evaluation-v1'
  definition: SavedScreenDefinitionContract
  evaluation: SavedScreenEvaluationSummary
  status: SavedScreenEvaluationStatus
  total: number
  limit: number
  offset: number
  members: SavedScreenEvaluationMember[]
}

export type ScreeningSnapshotValue = number | string | boolean | null

export interface SavedScreenMetricTransition {
  id: string
  metric: ScreeningMetricKey
  label: string
  kind: 'condition_became_true' | 'condition_became_false' | 'value_changed' | 'data_appeared' | 'data_disappeared'
  condition: ScreeningCondition | null
  previous: {
    asOf: string | null
    value: ScreeningSnapshotValue
    formatted: string
    passed: boolean | null
  }
  current: {
    asOf: string
    value: ScreeningSnapshotValue
    formatted: string
    passed: boolean | null
  }
  message: string
  source: {
    source: 'stock_screening_serving'
    sourceMetric: ScreeningMetricKey
    previousAsOf: string | null
    currentAsOf: string
  }
}

export interface SavedScreenChangeReasonContract {
  contractVersion: 'saved-screen-change-reason-v1'
  definitionId: string
  definitionVersion: number
  evaluationId: string
  ticker: string
  name: string
  status: Exclude<SavedScreenEvaluationStatus, 'STAY'>
  previousAsOf: string | null
  currentAsOf: string
  summary: string
  conditionChanges: SavedScreenMetricTransition[]
  contextChanges: SavedScreenMetricTransition[]
  reason: ScreenerReasonContract | null
  generatedAt: string
  elapsedMs: number
  disclaimer: string
}

export interface IntegratedScreeningEvaluationSet {
  asOf: string
  snapshotDate: string
  rows: IntegratedScreeningRow[]
  elapsedMs: number
}

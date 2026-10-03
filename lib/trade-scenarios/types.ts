export type TradeScenarioDirection = 'bullish' | 'bearish' | 'watch'
export type TradeScenarioStatus = 'open' | 'reviewed' | 'archived'
export type TradeScenarioConfidence = 'low' | 'medium' | 'high'

export interface TradeScenarioPriceRow {
  date: string
  high: number
  low: number
  close: number
}

export interface TradeScenarioOutcome {
  status:
    | 'pending'
    | 'target_hit'
    | 'stop_hit'
    | 'direction_matched'
    | 'direction_missed'
    | 'watch_ok'
    | 'watch_missed'
    | 'expired'
    | 'no_data'
  label: string
  tone: 'up' | 'down' | 'neutral'
  maxRisePct: number | null
  maxDrawdownPct: number | null
  endReturnPct: number | null
  targetHitDate: string | null
  targetHitDay: number | null
  stopHitDate: string | null
  stopHitDay: number | null
  evaluatedDays: number
  remainingDays: number
  note: string
}

export interface TradeScenario {
  id: string
  ticker: string
  market: string
  name: string | null
  direction: TradeScenarioDirection
  status: TradeScenarioStatus
  confidence: TradeScenarioConfidence
  anchorDate: string
  anchorClose: number | null
  horizonDays: number
  entryPlanPrice: number | null
  targetPrice: number | null
  stopLossPrice: number | null
  thesis: string
  invalidation: string
  reviewMemo: string | null
  selectedStartDate: string | null
  selectedEndDate: string | null
  sourceRangeLabel: string | null
  contextJson: string
  createdAt: string
  updatedAt: string
  outcome: TradeScenarioOutcome
}

export interface TradeScenarioOverviewItem extends TradeScenario {
  currentDate: string | null
  currentClose: number | null
  currentReturnPct: number | null
  distanceToTargetPct: number | null
  distanceToStopPct: number | null
  targetProgressPct: number | null
  priority: number
  priorityLabel: string
  priorityTone: 'up' | 'down' | 'neutral' | 'warning'
  stages: Array<number | null>
}

export interface TradeScenarioOverview {
  summary: {
    total: number
    active: number
    attention: number
    targetHit: number
    stopHit: number
    reviewDue: number
    pending: number
    latestUpdatedAt: string | null
  }
  items: TradeScenarioOverviewItem[]
}

export interface TradeScenarioCreateInput {
  ticker: string
  market?: string
  name?: string | null
  direction: TradeScenarioDirection
  confidence?: TradeScenarioConfidence
  anchorDate?: string | null
  horizonDays: number
  entryPlanPrice?: number | null
  targetPrice?: number | null
  stopLossPrice?: number | null
  thesis: string
  invalidation?: string | null
  selectedStartDate?: string | null
  selectedEndDate?: string | null
  sourceRangeLabel?: string | null
  context?: Record<string, unknown>
}

export interface TradeScenarioUpdateInput {
  status?: TradeScenarioStatus
  reviewMemo?: string | null
}

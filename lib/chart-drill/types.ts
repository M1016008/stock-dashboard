export type DrillDirection = 'up' | 'down' | 'mixed'
export type DrillTarget = 'jp' | 'us' | 'etf' | 'commodity' | 'watchlist' | 'all'
export type DrillDifficulty = 'beginner' | 'intermediate' | 'advanced' | 'practical'
export type DrillAnswer = 'up' | 'down' | 'pass'
export type DrillConfidence = 'low' | 'medium' | 'high'
export type DrillMarket = 'JP' | 'US'

export interface DrillCandle {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  ma5: number | null
  ma25: number | null
  ma75: number | null
  ma200: number | null
}

export interface DrillStageSnapshot {
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
  previousDailyA: number | null
}

export interface DrillMetricSnapshot {
  priceVsMa25Pct: number | null
  priceVsMa75Pct: number | null
  ma5SlopePct: number | null
  ma25SlopePct: number | null
  ma75SlopePct: number | null
  volumeRatio20: number | null
  velocity20: number | null
  acceleration20: number | null
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

export interface DrillQuestion {
  problemId: string
  ticker: string
  name: string | null
  market: DrillMarket
  marketLabel: string
  target: DrillTarget
  asOfDate: string
  horizonDays: number
  thresholdPct: number
  direction: DrillDirection
  difficulty: DrillDifficulty
  chart: DrillCandle[]
  stage: DrillStageSnapshot
  metrics: DrillMetricSnapshot
  hints: string[]
}

export interface DrillOutcome {
  actual: DrillAnswer
  resultLabel: string
  highVolatility: boolean
  maxUpPct: number
  maxDownPct: number
  maxUpDate: string | null
  maxDownDate: string | null
  maxUpDay: number | null
  maxDownDay: number | null
  thresholdHit: boolean
  thresholdHitDirection: 'up' | 'down' | 'both' | 'none'
  thresholdHitDay: number | null
  thresholdHitDate: string | null
  closeHit: boolean
  closeHitDay: number | null
  closeHitDate: string | null
  endReturnPct: number | null
}

export interface DrillAnswerResult {
  correct: boolean
  expectedAnswer: DrillAnswer
  userAnswer: DrillAnswer
  confidence: DrillConfidence
  memo: string | null
  question: Omit<DrillQuestion, 'problemId'>
  outcome: DrillOutcome
  revealChart: DrillCandle[]
  futureChart: DrillCandle[]
  explanations: string[]
  reviewTags: string[]
}

import { execAll, execGet } from '@/lib/db/client'
import { STAGE_LABELS } from '@/lib/hex-stage'

export type TradeWorkbenchAction = 'buy_candidate' | 'short_candidate' | 'watch' | 'avoid' | 'risk_alert'

export type TradeWorkbenchDirection = 'up' | 'down' | 'wait'

export interface TradeWorkbenchSignalEvidence {
  signalCode: string
  label: string
  horizonDays: number
  count: number
  upRate: number | null
  downRate: number | null
  medianReturnPct: number | null
  avgReturnPct: number | null
}

export interface TradeWorkbenchSignalPatternEvidence {
  signalCode: string
  label: string
  horizonDays: number
  count: number
  hit10Rate: number | null
  hit20Rate: number | null
  hit40Rate: number | null
  maxReturnP50: number | null
  minReturnP50: number | null
  daysToMaxP50: number | null
}

export interface TradeWorkbenchPatternEvidence {
  patternCode: string
  horizonDays: number
  count: number
  p25: number | null
  p50: number | null
  p75: number | null
  p95: number | null
  upRate: number | null
  veryUpRate: number | null
  downRate: number | null
  veryDownRate: number | null
}

export interface TradeWorkbenchModelEvidence {
  direction: 'up' | 'down'
  horizonDays: number
  sampleCount: number
  targetPct: number | null
  baselineHitRate: number | null
  top20HitRate: number | null
  top60HitRate: number | null
  top60AdverseRate: number | null
  top60AvgReturnPct: number | null
  top60DirectionalReturnPct: number | null
  liftTop60VsBaseline: number | null
  split: string | null
}

export interface TradeWorkbenchOrderDraft {
  side: 'BUY' | 'SELL_SHORT'
  orderType: 'LIMIT_DRAFT'
  referencePrice: number | null
  suggestedLimitPrice: number | null
  lotSize: number
  budgetYen: number
  quantity: number | null
  estimatedAmount: number | null
  valid: boolean
  guardrails: string[]
  why: string[]
}

export interface TradeWorkbenchCandidate {
  ticker: string
  name: string | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  marginType: string | null
  signalDate: string | null
  priceDate: string | null
  physicsDate: string | null
  classicMlDate: string | null
  close: number | null
  previousClose: number | null
  changePct: number | null
  volume: number | null
  stageCode: string | null
  stageLabels: string[]
  stages: Array<number | null>
  maState: {
    order: string
    angle: string
    dailyShortSlopePct: number | null
    dailyMiddleSlopePct: number | null
    priceVsMa25Pct: number | null
  }
  signal: {
    rank: number | null
    score: number | null
    codes: string[]
  }
  ml: {
    physicsUp: { rank: number | null; score: number | null; modelName: string | null }
    physicsDown: { rank: number | null; score: number | null; modelName: string | null }
    physicsWait: { rank: number | null; score: number | null; modelName: string | null }
    classicUp: { rank: number | null; score: number | null; modelName: string | null }
    classicDown: { rank: number | null; score: number | null; modelName: string | null }
  }
  historicalEvidence: {
    signalShortTerm: TradeWorkbenchSignalEvidence[]
    signalPattern: TradeWorkbenchSignalPatternEvidence[]
    stagePattern: TradeWorkbenchPatternEvidence | null
    objectiveUp: TradeWorkbenchModelEvidence | null
    objectiveDown: TradeWorkbenchModelEvidence | null
  }
  decision: {
    action: TradeWorkbenchAction
    label: string
    score: number
    confidence: '高' | '中' | '低'
    summary: string
    why: string[]
    riskNotes: string[]
    nextChecks: string[]
  }
  orderDraft: TradeWorkbenchOrderDraft
  nextEarningsDate: string | null
  nextEarningsFiscalPeriod: string | null
  nextEarningsSource: string | null
}

export interface TradeWorkbenchSummary {
  total: number
  buyCandidates: number
  shortCandidates: number
  watch: number
  riskAlerts: number
  avoid: number
  latestDataDate: string | null
  latestSignalDate: string | null
  latestPhysicsDate: string | null
  latestClassicMlDate: string | null
  latestModelEvaluationDate: string | null
  marketContext: {
    date: string | null
    marketReturn20: number | null
    marketAboveSma25Rate: number | null
    advancersRate5: number | null
    regime: 'bull' | 'neutral' | 'bear' | 'unknown'
  }
}

export interface TradeWorkbenchResult {
  summary: TradeWorkbenchSummary
  candidates: TradeWorkbenchCandidate[]
  params: {
    horizonDays: number
    limit: number
    budgetYen: number
  }
}

type RawCandidateRow = {
  ticker: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
  margin_type: string | null
  signal_date: string | null
  price_date: string | null
  physics_date: string | null
  classic_ml_date: string | null
  close: number | null
  previous_close: number | null
  volume: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  prev_ma_5: number | null
  prev_ma_25: number | null
  prev_close_snapshot: number | null
  signal_rank: number | null
  signal_score: number | null
  signal_codes: string | null
  physics_up_rank: number | null
  physics_up_score: number | null
  physics_up_model: string | null
  physics_down_rank: number | null
  physics_down_score: number | null
  physics_down_model: string | null
  physics_wait_rank: number | null
  physics_wait_score: number | null
  physics_wait_model: string | null
  classic_up_rank: number | null
  classic_up_score: number | null
  classic_up_model: string | null
  classic_down_rank: number | null
  classic_down_score: number | null
  classic_down_model: string | null
  next_earnings_date: string | null
  next_earnings_fiscal_period: string | null
  last_earnings_date: string | null
  last_earnings_fiscal_period: string | null
}

type SignalReturnRow = {
  signal_code: string
  horizon_days: number
  count: number
  up_rate: number | null
  down_rate: number | null
  median_return_pct: number | null
  avg_return_pct: number | null
}

type SignalPatternRow = {
  signal_code: string
  pattern_code: string
  horizon_days: number
  count: number
  hit_10_rate: number | null
  hit_20_rate: number | null
  hit_40_rate: number | null
  max_return_p50: number | null
  min_return_p50: number | null
  days_to_max_p50: number | null
}

type PatternStatRow = {
  pattern_code: string
  horizon_days: number
  count: number
  p25: number | null
  p50: number | null
  p75: number | null
  p95: number | null
  very_up_count: number | null
  up_count: number | null
  flat_count: number | null
  down_count: number | null
  very_down_count: number | null
}

type ModelEvaluationRow = {
  evaluation_date: string
  direction: string
  horizon_days: number
  sample_count: number
  precision_at_20: number | null
  precision_at_50: number | null
  hit_rate: number | null
  metrics_json: string
}

type MarketContextRow = {
  date: string
  market_return_20: number | null
  market_above_sma25_rate: number | null
  advancers_rate_5: number | null
}

const DEFAULT_HORIZON = 20
const DEFAULT_LIMIT = 40
const DEFAULT_BUDGET_YEN = 500_000
const INDIVIDUAL_MARKETS = new Set(['プライム', 'スタンダード', 'グロース'])

const SIGNAL_LABELS: Record<string, string> = {
  pullback_candidate: '押し目候補',
  pre_breakout: 'ブレイク直前',
  volatility_squeeze: 'ボラ収縮',
  stage_improvement_setup: '好転予兆',
  higher_timeframe_alignment: '上位足一致',
  high_breakout_continuation: '高値継続',
  ma_cross_up_daily_5: '日5MA上抜け',
  ma_cross_up_daily_25: '日25MA上抜け',
  ma_cross_up_daily_75: '日75MA上抜け',
  ma_cross_up_weekly_5: '週5MA上抜け',
  ma_cross_up_weekly_13: '週13MA上抜け',
  ma_cross_up_weekly_25: '週25MA上抜け',
  ma_touch_daily_5: '日5MA接触',
  ma_touch_daily_25: '日25MA接触',
  ma_touch_daily_75: '日75MA接触',
  ma_touch_weekly_5: '週5MA接触',
  ma_touch_weekly_13: '週13MA接触',
  ma_touch_weekly_25: '週25MA接触',
  ma_upper_touch_daily_25: '日25MA上側タッチ',
  ma_upper_touch_weekly_13: '週13MA上側タッチ',
  ma_lower_touch_daily_5: '日5MA下側タッチ',
  ma_lower_touch_daily_75: '日75MA下側タッチ',
  ma_lower_touch_weekly_5: '週5MA下側タッチ',
  ma_lower_touch_weekly_13: '週13MA下側タッチ',
  ma_lower_touch_weekly_25: '週25MA下側タッチ',
  ma_cross_down_daily_25: '日25MA下抜け',
}

function signalLabel(code: string): string {
  return SIGNAL_LABELS[code] ?? code.replace(/_/g, ' ')
}

function parseSignalCodes(value: string | null): string[] {
  if (!value) return []
  if (value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (Array.isArray(parsed)) return parsed.map((item) => String(item)).filter(Boolean)
    } catch {
      // Fall through to comma parsing.
    }
  }
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function num(value: number | null | undefined): number | null {
  return finite(value) ? value : null
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function ratePct(value: number | null | undefined): number | null {
  if (!finite(value)) return null
  return Math.abs(value) <= 1.5 ? value * 100 : value
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtRate(value: number | null | undefined, digits = 1): string {
  const pct = ratePct(value)
  if (!finite(pct)) return '-'
  return `${pct.toFixed(digits)}%`
}

function fmtRank(rank: number | null | undefined): string {
  return rank ? `#${rank}` : '-'
}

function stageCode(stages: Array<number | null>): string | null {
  if (stages.some((stage) => stage == null)) return null
  return stages.map((stage) => String(stage)).join('')
}

function stageLabels(stages: Array<number | null>): string[] {
  const labels = ['日A', '日B', '週A', '週B', '月A', '月B']
  return stages.map((stage, index) => {
    const label = stage && STAGE_LABELS[stage] ? STAGE_LABELS[stage] : '不明'
    return `${labels[index]} ${stage ?? '-'} ${label}`
  })
}

function stageBullishScore(stages: Array<number | null>): number {
  const weights = [1.3, 0.8, 1.2, 0.9, 1.2, 1.0]
  let score = 0
  let total = 0
  stages.forEach((stage, index) => {
    const weight = weights[index] ?? 1
    total += weight
    if (stage === 1) score += 100 * weight
    else if (stage === 6) score += 86 * weight
    else if (stage === 2) score += 70 * weight
    else if (stage === 5) score += 52 * weight
    else if (stage === 3) score += 28 * weight
    else if (stage === 4) score += 8 * weight
    else score += 40 * weight
  })
  return total > 0 ? score / total : 40
}

function stageRiskScore(stages: Array<number | null>): number {
  const bearish = stages.reduce<number>((sum, stage, index) => {
    const weight = index >= 2 ? 1.25 : 1
    if (stage === 4) return sum + 24 * weight
    if (stage === 3) return sum + 18 * weight
    if (stage === 5) return sum + 8 * weight
    return sum
  }, 0)
  return clamp(bearish, 0, 100)
}

function maState(row: RawCandidateRow) {
  const order =
    finite(row.ma_5) && finite(row.ma_25) && finite(row.ma_75)
      ? row.ma_5 > row.ma_25 && row.ma_25 > row.ma_75
        ? '短期 > 中期 > 長期'
        : row.ma_75 > row.ma_25 && row.ma_25 > row.ma_5
          ? '長期 > 中期 > 短期'
          : '混在'
      : '不明'
  const dailyShortSlopePct = finite(row.ma_5) && finite(row.prev_ma_5) && row.prev_ma_5 !== 0
    ? 100 * (row.ma_5 - row.prev_ma_5) / row.prev_ma_5
    : null
  const dailyMiddleSlopePct = finite(row.ma_25) && finite(row.prev_ma_25) && row.prev_ma_25 !== 0
    ? 100 * (row.ma_25 - row.prev_ma_25) / row.prev_ma_25
    : null
  const priceVsMa25Pct = finite(row.close) && finite(row.ma_25) && row.ma_25 !== 0
    ? 100 * (row.close - row.ma_25) / row.ma_25
    : null
  const angle =
    (dailyShortSlopePct ?? 0) > 0.2 && (dailyMiddleSlopePct ?? 0) >= -0.05
      ? '短期線上向き'
      : (dailyShortSlopePct ?? 0) < -0.2 && (dailyMiddleSlopePct ?? 0) <= 0.05
        ? '短期線下向き'
        : '横ばい/確認'
  return { order, angle, dailyShortSlopePct, dailyMiddleSlopePct, priceVsMa25Pct }
}

function resolveTradeNextEarnings(row: RawCandidateRow): {
  date: string | null
  fiscalPeriod: string | null
  source: string | null
} {
  if (row.next_earnings_date) {
    return {
      date: row.next_earnings_date,
      fiscalPeriod: row.next_earnings_fiscal_period,
      source: 'earnings_calendar',
    }
  }

  const estimated = estimateNextQuarterlyDate(row.last_earnings_date, row.price_date)
  if (!estimated) return { date: null, fiscalPeriod: null, source: null }

  return {
    date: estimated,
    fiscalPeriod: null,
    source: 'estimated_from_previous_earnings',
  }
}

function estimateNextQuarterlyDate(lastKnownDate: string | null, referenceDate: string | null): string | null {
  if (!lastKnownDate || !referenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(lastKnownDate)) return null
  let candidate = lastKnownDate
  for (let i = 0; i < 8; i++) {
    candidate = nextWeekday(addMonthsClamped(candidate, 3))
    if (candidate > referenceDate) return candidate
  }
  return null
}

function addMonthsClamped(dateStr: string, months: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const targetMonthIndex = month - 1 + months
  const targetYear = year + Math.floor(targetMonthIndex / 12)
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const clampedDay = Math.min(day, lastDay)
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`
}

function nextWeekday(dateStr: string): string {
  let time = Date.parse(`${dateStr}T00:00:00.000Z`)
  if (!Number.isFinite(time)) return dateStr
  for (let i = 0; i < 3; i++) {
    const day = new Date(time).getUTCDay()
    if (day >= 1 && day <= 5) {
      const d = new Date(time)
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    }
    time += 86_400_000
  }
  return dateStr
}

function placeholders(length: number): string {
  return Array.from({ length }, () => '?').join(', ')
}

async function latestDate(table: string, column: string): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(${column}) AS date FROM ${table}`))?.date ?? null
}

async function latestObjectiveEvaluationDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(
    `
    SELECT MAX(evaluation_date) AS date
    FROM ml_model_evaluations
    WHERE model_type LIKE '%objective%holdout%'
      AND (model_type LIKE '%enhanced%' OR metrics_json LIKE '%"variant":"enhanced"%')
    `,
  ))?.date ?? null
}

async function fetchRows(horizonDays: number, limit: number): Promise<RawCandidateRow[]> {
  const rowLimit = Math.max(limit * 8, 360)
  return execAll<RawCandidateRow>(
    `
    WITH dates AS (
      SELECT
        (SELECT MAX(date) FROM daily_snapshots) AS snapshot_date,
        (SELECT MAX(date) FROM ohlcv_daily) AS price_date,
        (SELECT MAX(date) FROM serving_latest_signals) AS signal_date,
        (SELECT MAX(as_of_date) FROM serving_ml_physics_candidates) AS physics_date,
        (SELECT MAX(as_of_date) FROM serving_ml_candidates) AS classic_ml_date
    ),
    candidate_tickers AS (
      SELECT ticker
      FROM serving_latest_signals
      WHERE date = (SELECT signal_date FROM dates)
        AND rank <= 280
      UNION
      SELECT ticker
      FROM serving_ml_physics_candidates
      WHERE as_of_date = (SELECT physics_date FROM dates)
        AND horizon_days = ?
        AND direction IN ('up', 'down', 'wait')
        AND rank <= 60
      UNION
      SELECT ticker
      FROM serving_ml_candidates
      WHERE as_of_date = (SELECT classic_ml_date FROM dates)
        AND direction IN ('up', 'down')
        AND rank <= 80
    )
    SELECT
      ct.ticker,
      u.name,
      u.market_segment,
      u.sector17_name,
      u.sector33_name,
      COALESCE(m.margin_type, u.margin_type) AS margin_type,
      (SELECT signal_date FROM dates) AS signal_date,
      (SELECT price_date FROM dates) AS price_date,
      (SELECT physics_date FROM dates) AS physics_date,
      (SELECT classic_ml_date FROM dates) AS classic_ml_date,
      px.close,
      ppx.close AS previous_close,
      px.volume,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      ds.ma_5,
      ds.ma_25,
      ds.ma_75,
      ds.ma_300,
      prev_ds.ma_5 AS prev_ma_5,
      prev_ds.ma_25 AS prev_ma_25,
      prev_px.close AS prev_close_snapshot,
      sig.rank AS signal_rank,
      sig.score AS signal_score,
      sig.signal_codes,
      p_up.rank AS physics_up_rank,
      p_up.candidate_score AS physics_up_score,
      p_up.model_name AS physics_up_model,
      p_down.rank AS physics_down_rank,
      p_down.candidate_score AS physics_down_score,
      p_down.model_name AS physics_down_model,
      p_wait.rank AS physics_wait_rank,
      p_wait.candidate_score AS physics_wait_score,
      p_wait.model_name AS physics_wait_model,
      c_up.rank AS classic_up_rank,
      c_up.candidate_score AS classic_up_score,
      c_up.model_name AS classic_up_model,
      c_down.rank AS classic_down_rank,
      c_down.candidate_score AS classic_down_score,
      c_down.model_name AS classic_down_model,
      earn.announce_date AS next_earnings_date,
      earn.fiscal_period AS next_earnings_fiscal_period,
      last_earn.announce_date AS last_earnings_date,
      last_earn.fiscal_period AS last_earnings_fiscal_period
    FROM candidate_tickers ct
    LEFT JOIN ticker_universe u ON u.ticker = ct.ticker
    LEFT JOIN serving_margin_latest m ON m.ticker = ct.ticker
    LEFT JOIN daily_snapshots ds
      ON ds.ticker = ct.ticker
     AND ds.date = (SELECT snapshot_date FROM dates)
    LEFT JOIN daily_snapshots prev_ds
      ON prev_ds.ticker = ct.ticker
     AND prev_ds.date = (
       SELECT MAX(date)
       FROM daily_snapshots d2
       WHERE d2.ticker = ct.ticker
         AND d2.date < (SELECT snapshot_date FROM dates)
     )
    LEFT JOIN ohlcv_daily px
      ON px.ticker = ct.ticker
     AND px.date = (SELECT price_date FROM dates)
    LEFT JOIN ohlcv_daily ppx
      ON ppx.ticker = ct.ticker
     AND ppx.date = (
       SELECT MAX(date)
       FROM ohlcv_daily o2
       WHERE o2.ticker = ct.ticker
         AND o2.date < (SELECT price_date FROM dates)
     )
    LEFT JOIN ohlcv_daily prev_px
      ON prev_px.ticker = ct.ticker
     AND prev_px.date = (
       SELECT MAX(date)
       FROM ohlcv_daily o3
       WHERE o3.ticker = ct.ticker
         AND o3.date < (SELECT price_date FROM dates)
     )
    LEFT JOIN serving_latest_signals sig
      ON sig.ticker = ct.ticker
     AND sig.date = (SELECT signal_date FROM dates)
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = ct.ticker
     AND p_up.as_of_date = (SELECT physics_date FROM dates)
     AND p_up.horizon_days = ?
     AND p_up.direction = 'up'
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = ct.ticker
     AND p_down.as_of_date = (SELECT physics_date FROM dates)
     AND p_down.horizon_days = ?
     AND p_down.direction = 'down'
    LEFT JOIN serving_ml_physics_candidates p_wait
      ON p_wait.ticker = ct.ticker
     AND p_wait.as_of_date = (SELECT physics_date FROM dates)
     AND p_wait.horizon_days = ?
     AND p_wait.direction = 'wait'
    LEFT JOIN serving_ml_candidates c_up
      ON c_up.ticker = ct.ticker
     AND c_up.as_of_date = (SELECT classic_ml_date FROM dates)
     AND c_up.direction = 'up'
    LEFT JOIN serving_ml_candidates c_down
      ON c_down.ticker = ct.ticker
     AND c_down.as_of_date = (SELECT classic_ml_date FROM dates)
     AND c_down.direction = 'down'
    LEFT JOIN earnings_calendar earn
      ON earn.ticker = ct.ticker
     AND earn.announce_date = (
       SELECT MIN(e2.announce_date)
       FROM earnings_calendar e2
       WHERE e2.ticker = ct.ticker
         AND e2.announce_date >= (SELECT price_date FROM dates)
     )
    LEFT JOIN earnings_calendar last_earn
      ON last_earn.ticker = ct.ticker
     AND last_earn.announce_date = (
       SELECT MAX(e3.announce_date)
       FROM earnings_calendar e3
       WHERE e3.ticker = ct.ticker
         AND e3.announce_date <= (SELECT price_date FROM dates)
     )
    WHERE u.market_segment IN ('プライム', 'スタンダード', 'グロース')
    ORDER BY
      CASE WHEN p_up.rank IS NOT NULL THEN p_up.rank ELSE 999 END ASC,
      CASE WHEN sig.rank IS NOT NULL THEN sig.rank ELSE 9999 END ASC,
      CASE WHEN c_up.rank IS NOT NULL THEN c_up.rank ELSE 999 END ASC,
      ct.ticker ASC
    LIMIT ?
    `,
    [horizonDays, horizonDays, horizonDays, horizonDays, rowLimit],
  )
}

async function fetchSignalReturnEvidence(signalCodes: string[]): Promise<Map<string, SignalReturnRow>> {
  if (signalCodes.length === 0) return new Map()
  const horizons = [5, 10, 15]
  const rows = await execAll<SignalReturnRow>(
    `
    SELECT signal_code, horizon_days, count, up_rate, down_rate, median_return_pct, avg_return_pct
    FROM signal_return_stats
    WHERE signal_code IN (${placeholders(signalCodes.length)})
      AND horizon_days IN (${placeholders(horizons.length)})
    `,
    [...signalCodes, ...horizons],
  )
  return new Map(rows.map((row) => [`${row.signal_code}|${row.horizon_days}`, row]))
}

async function fetchSignalPatternEvidence(signalCodes: string[], horizons: number[]): Promise<Map<string, SignalPatternRow>> {
  if (signalCodes.length === 0 || horizons.length === 0) return new Map()
  const rows = await execAll<SignalPatternRow>(
    `
    SELECT signal_code, pattern_code, horizon_days, count,
           hit_10_rate, hit_20_rate, hit_40_rate, max_return_p50, min_return_p50, days_to_max_p50
    FROM signal_stats
    WHERE signal_code IN (${placeholders(signalCodes.length)})
      AND pattern_code = 'ALL'
      AND horizon_days IN (${placeholders(horizons.length)})
    `,
    [...signalCodes, ...horizons],
  )
  return new Map(rows.map((row) => [`${row.signal_code}|${row.horizon_days}`, row]))
}

async function fetchPatternStats(patternCodes: string[], horizons: number[]): Promise<Map<string, PatternStatRow>> {
  if (patternCodes.length === 0 || horizons.length === 0) return new Map()
  const rows = await execAll<PatternStatRow>(
    `
    SELECT pattern_code, horizon_days, count, p25, p50, p75, p95,
           very_up_count, up_count, flat_count, down_count, very_down_count
    FROM pattern_stats
    WHERE pattern_code IN (${placeholders(patternCodes.length)})
      AND horizon_days IN (${placeholders(horizons.length)})
    `,
    [...patternCodes, ...horizons],
  )
  return new Map(rows.map((row) => [`${row.pattern_code}|${row.horizon_days}`, row]))
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | null {
  const value = record?.[key]
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function objectiveEvidence(row: ModelEvaluationRow): TradeWorkbenchModelEvidence {
  const metrics = parseJson<Record<string, unknown>>(row.metrics_json, {})
  const baseline = metrics.baseline && typeof metrics.baseline === 'object' && !Array.isArray(metrics.baseline)
    ? metrics.baseline as Record<string, unknown>
    : undefined
  const top60 = metrics.top60 && typeof metrics.top60 === 'object' && !Array.isArray(metrics.top60)
    ? metrics.top60 as Record<string, unknown>
    : undefined
  return {
    direction: row.direction === 'down' ? 'down' : 'up',
    horizonDays: Number(row.horizon_days),
    sampleCount: Number(row.sample_count),
    targetPct: readNumber(metrics, 'targetPct'),
    baselineHitRate: readNumber(baseline, 'hitRate') ?? num(row.hit_rate),
    top20HitRate: row.precision_at_20 == null ? null : Number(row.precision_at_20),
    top60HitRate: readNumber(top60, 'hitRate') ?? num(row.precision_at_50),
    top60AdverseRate: readNumber(top60, 'adverseRate'),
    top60AvgReturnPct: readNumber(top60, 'avgReturnPct'),
    top60DirectionalReturnPct: readNumber(top60, 'avgDirectionalReturnPct'),
    liftTop60VsBaseline: readNumber(metrics, 'liftTop60VsBaseline'),
    split: typeof metrics.split === 'string' ? metrics.split : null,
  }
}

async function fetchObjectiveEvidence(horizons: number[]): Promise<Map<string, TradeWorkbenchModelEvidence>> {
  const rows = await execAll<ModelEvaluationRow>(
    `
    SELECT evaluation_date, direction, horizon_days, sample_count,
           precision_at_20, precision_at_50, hit_rate, metrics_json
    FROM ml_model_evaluations
    WHERE direction IN ('up', 'down')
      AND horizon_days IN (${placeholders(horizons.length)})
      AND model_type LIKE '%objective%holdout%'
      AND (model_type LIKE '%enhanced%' OR metrics_json LIKE '%"variant":"enhanced"%')
    ORDER BY horizon_days ASC, direction ASC,
             CASE WHEN metrics_json LIKE '%"split":"test"%' THEN 0 ELSE 1 END ASC,
             evaluation_date DESC, created_at DESC
    `,
    horizons,
  )
  const map = new Map<string, TradeWorkbenchModelEvidence>()
  for (const row of rows) {
    const key = `${row.direction === 'down' ? 'down' : 'up'}|${row.horizon_days}`
    if (!map.has(key)) map.set(key, objectiveEvidence(row))
  }
  return map
}

async function fetchMarketContext(): Promise<TradeWorkbenchSummary['marketContext']> {
  const row = await execGet<MarketContextRow>(
    `
    SELECT date, market_return_20, market_above_sma25_rate, advancers_rate_5
    FROM ml_market_context_features
    ORDER BY date DESC
    LIMIT 1
    `,
  )
  if (!row) {
    return {
      date: null,
      marketReturn20: null,
      marketAboveSma25Rate: null,
      advancersRate5: null,
      regime: 'unknown',
    }
  }
  const marketReturn20 = num(row.market_return_20)
  const marketAboveSma25Rate = num(row.market_above_sma25_rate)
  const regime =
    marketReturn20 == null || marketAboveSma25Rate == null
      ? 'unknown'
      : marketReturn20 >= 2 && marketAboveSma25Rate >= 55
        ? 'bull'
        : marketReturn20 <= -3 || marketAboveSma25Rate <= 42
          ? 'bear'
          : 'neutral'
  return {
    date: row.date,
    marketReturn20,
    marketAboveSma25Rate,
    advancersRate5: num(row.advancers_rate_5),
    regime,
  }
}

function makeSignalEvidence(codes: string[], map: Map<string, SignalReturnRow>): TradeWorkbenchSignalEvidence[] {
  return codes
    .flatMap((code) => [15, 10, 5].map((horizon) => map.get(`${code}|${horizon}`)).filter(Boolean) as SignalReturnRow[])
    .map((row) => ({
      signalCode: row.signal_code,
      label: signalLabel(row.signal_code),
      horizonDays: Number(row.horizon_days),
      count: Number(row.count),
      upRate: num(row.up_rate),
      downRate: num(row.down_rate),
      medianReturnPct: num(row.median_return_pct),
      avgReturnPct: num(row.avg_return_pct),
    }))
    .sort((a, b) => {
      const scoreA = (ratePct(a.upRate) ?? 0) + (a.avgReturnPct ?? 0) * 3 + Math.log10(Math.max(1, a.count))
      const scoreB = (ratePct(b.upRate) ?? 0) + (b.avgReturnPct ?? 0) * 3 + Math.log10(Math.max(1, b.count))
      return scoreB - scoreA
    })
    .slice(0, 5)
}

function makeSignalPatternEvidence(
  codes: string[],
  horizonDays: number,
  map: Map<string, SignalPatternRow>,
): TradeWorkbenchSignalPatternEvidence[] {
  const horizonOrder = [horizonDays, 60, 40, 20, 30, 5].filter((v, i, a) => a.indexOf(v) === i)
  return codes
    .flatMap((code) => horizonOrder.map((horizon) => map.get(`${code}|${horizon}`)).filter(Boolean) as SignalPatternRow[])
    .map((row) => ({
      signalCode: row.signal_code,
      label: signalLabel(row.signal_code),
      horizonDays: Number(row.horizon_days),
      count: Number(row.count),
      hit10Rate: num(row.hit_10_rate),
      hit20Rate: num(row.hit_20_rate),
      hit40Rate: num(row.hit_40_rate),
      maxReturnP50: num(row.max_return_p50),
      minReturnP50: num(row.min_return_p50),
      daysToMaxP50: num(row.days_to_max_p50),
    }))
    .sort((a, b) => {
      const aHit = ratePct(a.hit10Rate) ?? 0
      const bHit = ratePct(b.hit10Rate) ?? 0
      return (bHit + (b.maxReturnP50 ?? 0)) - (aHit + (a.maxReturnP50 ?? 0))
    })
    .slice(0, 4)
}

function makePatternEvidence(
  patternCode: string | null,
  horizonDays: number,
  map: Map<string, PatternStatRow>,
): TradeWorkbenchPatternEvidence | null {
  if (!patternCode) return null
  const row = map.get(`${patternCode}|${horizonDays}`)
    ?? map.get(`${patternCode}|60`)
    ?? map.get(`${patternCode}|40`)
    ?? map.get(`${patternCode}|20`)
  if (!row) return null
  const count = Number(row.count)
  return {
    patternCode: row.pattern_code,
    horizonDays: Number(row.horizon_days),
    count,
    p25: num(row.p25),
    p50: num(row.p50),
    p75: num(row.p75),
    p95: num(row.p95),
    upRate: count > 0 ? ((Number(row.up_count ?? 0) + Number(row.very_up_count ?? 0)) / count) : null,
    veryUpRate: count > 0 ? Number(row.very_up_count ?? 0) / count : null,
    downRate: count > 0 ? ((Number(row.down_count ?? 0) + Number(row.very_down_count ?? 0)) / count) : null,
    veryDownRate: count > 0 ? Number(row.very_down_count ?? 0) / count : null,
  }
}

function rankScore(rank: number | null | undefined, maxRank = 60): number {
  if (!rank || rank <= 0 || rank > maxRank) return 0
  return clamp((maxRank + 1 - rank) / maxRank, 0, 1) * 100
}

function signalEdgeScore(evidence: TradeWorkbenchSignalEvidence[]): number {
  if (evidence.length === 0) return 0
  const top = evidence.slice(0, 3)
  return top.reduce((sum, row) => {
    const up = ratePct(row.upRate) ?? 50
    const avg = row.avgReturnPct ?? 0
    const countBoost = Math.min(10, Math.log10(Math.max(1, row.count)) * 2)
    return sum + clamp((up - 48) * 1.5 + avg * 4 + countBoost, -20, 30)
  }, 0)
}

function patternEdgeScore(pattern: TradeWorkbenchPatternEvidence | null): number {
  if (!pattern) return 0
  const median = pattern.p50 ?? 0
  const p75 = pattern.p75 ?? 0
  const up = ratePct(pattern.upRate) ?? 50
  return clamp((median * 2) + p75 + (up - 50) * 0.5, -18, 24)
}

function patternDownEdgeScore(pattern: TradeWorkbenchPatternEvidence | null): number {
  if (!pattern) return 0
  const p25 = pattern.p25 ?? 0
  const median = pattern.p50 ?? 0
  const down = ratePct(pattern.downRate) ?? 50
  return clamp(Math.abs(Math.min(p25, 0)) * 1.4 + Math.abs(Math.min(median, 0)) * 0.8 + (down - 40) * 0.45, -12, 26)
}

function modelMetricScore(evidence: TradeWorkbenchModelEvidence | null, direction: 'up' | 'down'): number {
  if (!evidence) return 0
  const top60 = ratePct(evidence.top60HitRate) ?? null
  const lift = evidence.liftTop60VsBaseline ?? null
  if (top60 == null) return 0
  const base = direction === 'up'
    ? (top60 - 35) * 0.3
    : (top60 - 35) * 0.25
  return clamp(base + (lift ? (lift - 1) * 8 : 0), -8, 20)
}

function makeDecision(params: {
  row: RawCandidateRow
  stages: Array<number | null>
  signalEvidence: TradeWorkbenchSignalEvidence[]
  signalPatternEvidence: TradeWorkbenchSignalPatternEvidence[]
  patternEvidence: TradeWorkbenchPatternEvidence | null
  objectiveUp: TradeWorkbenchModelEvidence | null
  objectiveDown: TradeWorkbenchModelEvidence | null
  ma: ReturnType<typeof maState>
}): TradeWorkbenchCandidate['decision'] {
  const {
    row,
    stages,
    signalEvidence,
    signalPatternEvidence,
    patternEvidence,
    objectiveUp,
    objectiveDown,
    ma,
  } = params
  const signalScore = Number(row.signal_score ?? 0)
  const upRankScore = rankScore(row.physics_up_rank) * 0.28 + rankScore(row.classic_up_rank, 80) * 0.12
  const downRankScore = rankScore(row.physics_down_rank) * 0.36 + rankScore(row.classic_down_rank, 80) * 0.12
  const waitScore = rankScore(row.physics_wait_rank) * 0.1
  const currentStageScore = stageBullishScore(stages) * 0.22
  const currentRiskScore = stageRiskScore(stages)
  const signalHistoricalScore = signalEdgeScore(signalEvidence)
  const patternScore = patternEdgeScore(patternEvidence)
  const patternDownScore = patternDownEdgeScore(patternEvidence)
  const modelUpScore = modelMetricScore(objectiveUp, 'up')
  const modelDownRisk = modelMetricScore(objectiveDown, 'down')
  const nextEarnings = resolveTradeNextEarnings(row)
  const maBonus =
    ma.order === '短期 > 中期 > 長期'
      ? 8
      : ma.angle === '短期線上向き'
        ? 4
        : ma.angle === '短期線下向き'
          ? -8
          : 0
  const nearEarningsRisk = nextEarnings.date && row.price_date
    ? Math.max(0, 10 - Math.ceil((Date.parse(`${nextEarnings.date}T00:00:00Z`) - Date.parse(`${row.price_date}T00:00:00Z`)) / 86_400_000))
    : 0
  const longScore = clamp(
    24
      + signalScore * 0.18
      + upRankScore
      + currentStageScore
      + signalHistoricalScore
      + patternScore
      + modelUpScore
      + maBonus
      - downRankScore
      - modelDownRisk * 0.8
      - currentRiskScore * 0.2
      - waitScore
      - nearEarningsRisk,
    0,
    100,
  )
  const maShortBonus =
    ma.order === '長期 > 中期 > 短期'
      ? 12
      : ma.angle === '短期線下向き'
        ? 8
        : ma.angle === '短期線上向き'
          ? -8
          : 0
  const shortScore = clamp(
    16
      + downRankScore * 1.55
      + currentRiskScore * 0.45
      + modelDownRisk * 1.45
      + patternDownScore
      + maShortBonus
      - upRankScore * 0.65
      - modelUpScore * 0.55
      - Math.max(0, currentStageScore - 12) * 0.35
      - nearEarningsRisk * 0.4,
    0,
    100,
  )
  const strongRisk = downRankScore + currentRiskScore * 0.35 + modelDownRisk > 44
  const shortReady =
    row.margin_type === '貸借'
    && row.physics_down_rank != null
    && shortScore >= 68
    && (
      currentRiskScore >= 18
      || ma.angle === '短期線下向き'
      || ma.order === '長期 > 中期 > 短期'
      || modelDownRisk >= 10
    )
  const action: TradeWorkbenchAction =
    shortReady
      ? 'short_candidate'
      : strongRisk && longScore < 62
        ? 'risk_alert'
        : longScore >= 72 && row.physics_up_rank != null && !strongRisk
        ? 'buy_candidate'
        : longScore >= 56
          ? 'watch'
          : 'avoid'
  const score = action === 'short_candidate' ? shortScore : longScore
  const confidence: '高' | '中' | '低' =
    score >= 78 && (action === 'short_candidate' || signalEvidence.some((e) => e.count >= 5000)) && !(strongRisk && action === 'buy_candidate')
      ? '高'
      : score >= 58
        ? '中'
        : '低'
  const why: string[] = []
  if (row.physics_up_rank) {
    why.push(`${row.physics_up_rank}位の上昇ML候補です。${objectiveUp?.top60HitRate != null ? `同horizonの強化版モデルtop60は過去検証で的中率${fmtRate(objectiveUp.top60HitRate)}、lift ${objectiveUp.liftTop60VsBaseline?.toFixed(2) ?? '-'}です。` : '過去のMA物理特徴量に近い上昇候補として抽出されています。'}`)
  }
  if (row.physics_down_rank) {
    why.push(`${row.physics_down_rank}位の下落警戒ML候補です。${objectiveDown?.top60HitRate != null ? `同horizonの強化版下落モデルtop60は過去検証で的中率${fmtRate(objectiveDown.top60HitRate)}、lift ${objectiveDown.liftTop60VsBaseline?.toFixed(2) ?? '-'}です。` : '過去のMA物理特徴量に近い下落警戒候補として抽出されています。'}`)
  }
  if (signalEvidence[0]) {
    const top = signalEvidence[0]
    why.push(`主シグナル「${top.label}」は過去${top.horizonDays}営業日で上昇率${fmtRate(top.upRate)}、平均リターン${fmtPct(top.avgReturnPct)}、サンプル${top.count.toLocaleString()}件です。`)
  }
  if (signalPatternEvidence[0]) {
    const top = signalPatternEvidence[0]
    why.push(`同シグナル群の過去${top.horizonDays}営業日では最大上昇中央値${fmtPct(top.maxReturnP50)}、+10%到達率${fmtRate(top.hit10Rate)}です。`)
  }
  if (patternEvidence) {
    why.push(`現在の6桁ステージ${patternEvidence.patternCode}は過去${patternEvidence.horizonDays}営業日で中央値${fmtPct(patternEvidence.p50)}、上位25%は${fmtPct(patternEvidence.p75)}です。`)
  }
  if (ma.order !== '不明') {
    why.push(`MA状態は「${ma.order}」、角度は「${ma.angle}」です。5日MAの直近変化は${fmtPct(ma.dailyShortSlopePct)}です。`)
  }

  const riskNotes: string[] = []
  if (row.physics_down_rank && action !== 'short_candidate') {
    riskNotes.push(`下落警戒MLにも${fmtRank(row.physics_down_rank)}で入っています。買い候補でも逆行確認が必要です。`)
  }
  if (row.physics_up_rank && action === 'short_candidate') {
    riskNotes.push(`上昇MLにも${fmtRank(row.physics_up_rank)}で入っています。空売り候補でも踏み上げ・反発確認が必要です。`)
  }
  if (action === 'short_candidate') {
    riskNotes.push('空売りは貸借銘柄であることを前提にした下書きです。実運用では在庫、逆日歩、規制、売り禁の確認が必須です。')
  }
  if (row.physics_down_rank && row.margin_type !== '貸借') {
    riskNotes.push(`下落MLは強いですが、信用属性が「${row.margin_type ?? '不明'}」のため空売り下書きにはしていません。`)
  }
  if (objectiveDown?.top60HitRate != null && row.physics_down_rank) {
    riskNotes.push(`下落警戒モデルtop60は過去検証で的中率${fmtRate(objectiveDown.top60HitRate)}、逆方向リスクも含めて有効性が確認されています。`)
  }
  if (stages.some((stage) => stage === 4 || stage === 3)) {
    riskNotes.push('6ステージの一部に下降系ステージが残っています。上位足の崩れがないか確認します。')
  }
  if (ma.angle === '短期線下向き') {
    riskNotes.push('短期MA角度が下向きです。注文案を出す場合も終値回復を条件にします。')
  }
  if (nextEarnings.date) {
    const sourceLabel = nextEarnings.source === 'estimated_from_previous_earnings' ? '推定' : '公式予定'
    riskNotes.push(`次回決算${sourceLabel}が${nextEarnings.date}です。決算跨ぎを避けるか、数量を落とす前提で確認します。`)
  }

  const nextChecks = [
    '個別ページで日足・週足・月足チャートを確認する',
    '出来高急増や決算予定など、モデル外のイベント要因を確認する',
    action === 'short_candidate'
      ? '空売りする場合は貸借状況、売り禁、逆日歩、反発時の買い戻しラインを先に確認する'
      : action === 'buy_candidate'
      ? '買う場合は終値基準の指値下書きから始め、逆行時の撤退ラインを先に決める'
      : '根拠が揃うまでは注文案ではなく監視候補として扱う',
  ]

  const label =
    action === 'buy_candidate'
      ? '注文案候補'
      : action === 'short_candidate'
        ? '空売り候補'
        : action === 'watch'
          ? '要確認'
          : action === 'risk_alert'
            ? '下落警戒'
            : '見送り'
  const summary =
    action === 'buy_candidate'
      ? '上昇ML、テクニカルシグナル、過去検証が比較的そろっているため、検証用の買い指値下書きを作れます。'
      : action === 'short_candidate'
        ? '下落警戒ML、下降ステージ、MA下向き、貸借属性がそろっているため、検証用の空売り指値下書きを作れます。'
        : action === 'watch'
          ? '一部の根拠はありますが、下落警戒やMA角度の確認が必要です。'
          : action === 'risk_alert'
            ? '下落警戒モデルや下降ステージの影響が強く、注文案よりリスク管理を優先します。'
            : '学習結果・現在形・リスクのそろい方が弱いため、現時点では注文案を出しません。'

  return {
    action,
    label,
    score: Math.round(score * 10) / 10,
    confidence,
    summary,
    why,
    riskNotes,
    nextChecks,
  }
}

function makeOrderDraft(params: {
  row: RawCandidateRow
  decision: TradeWorkbenchCandidate['decision']
  budgetYen: number
  objectiveUp: TradeWorkbenchModelEvidence | null
  objectiveDown: TradeWorkbenchModelEvidence | null
}): TradeWorkbenchOrderDraft {
  const { row, decision, budgetYen, objectiveUp, objectiveDown } = params
  const isShort = decision.action === 'short_candidate'
  const lotSize = 100
  const referencePrice = num(row.close)
  const suggestedLimitPrice = referencePrice
  const quantity = referencePrice && referencePrice > 0
    ? Math.floor(budgetYen / referencePrice / lotSize) * lotSize
    : null
  const valid = (decision.action === 'buy_candidate' || isShort) && !!quantity && quantity > 0 && (!isShort || row.margin_type === '貸借')
  const estimatedAmount = valid && quantity && referencePrice ? Math.round(quantity * referencePrice) : null
  const guardrails = [
    '実発注ではなく、検証用の注文案下書きです。',
    '成行ではなく終値基準の指値案だけを表示します。',
    `1注文あたりの仮予算は${budgetYen.toLocaleString()}円です。`,
  ]
  if (isShort) guardrails.push('空売りは貸借、在庫、逆日歩、売り禁確認を必須前提にします。')
  if (decision.action !== 'buy_candidate' && !isShort) guardrails.push('根拠が不足またはリスクが高いため、数量は確定扱いにしません。')
  if (!quantity || quantity <= 0) guardrails.push('仮予算内で100株単位の数量を作れません。')
  if (isShort && row.margin_type !== '貸借') guardrails.push('貸借銘柄ではないため、空売り注文案は参考扱いです。')
  if (row.physics_down_rank && !isShort) guardrails.push('下落警戒MLに該当するため、実運用では撤退ラインを先に設定します。')

  const why = isShort
    ? [
        decision.summary,
        objectiveDown?.top60HitRate != null
          ? `下落警戒モデルの過去検証top60的中率は${fmtRate(objectiveDown.top60HitRate)}、ベースライン比liftは${objectiveDown.liftTop60VsBaseline?.toFixed(2) ?? '-'}です。`
          : '下落警戒モデルの過去検証値は不足しています。',
        objectiveUp?.top60HitRate != null && row.physics_up_rank
          ? `ただし上昇モデルにも入り、同モデルtop60的中率は${fmtRate(objectiveUp.top60HitRate)}です。反発リスクを先に確認します。`
          : '上昇候補との重複は限定的です。',
      ]
    : [
        decision.summary,
        objectiveUp?.top60HitRate != null
          ? `上昇モデルの過去検証top60的中率は${fmtRate(objectiveUp.top60HitRate)}、ベースライン比liftは${objectiveUp.liftTop60VsBaseline?.toFixed(2) ?? '-'}です。`
          : '上昇モデルの過去検証値は不足しています。',
        objectiveDown?.top60HitRate != null && row.physics_down_rank
          ? `ただし下落警戒モデルにも入り、同モデルtop60的中率は${fmtRate(objectiveDown.top60HitRate)}です。`
          : '下落警戒との重複は限定的です。',
      ]

  return {
    side: isShort ? 'SELL_SHORT' : 'BUY',
    orderType: 'LIMIT_DRAFT',
    referencePrice,
    suggestedLimitPrice,
    lotSize,
    budgetYen,
    quantity: valid ? quantity : quantity && quantity > 0 ? quantity : null,
    estimatedAmount,
    valid,
    guardrails,
    why,
  }
}

function sortCandidates(a: TradeWorkbenchCandidate, b: TradeWorkbenchCandidate): number {
  const actionWeight: Record<TradeWorkbenchAction, number> = {
    short_candidate: 0,
    buy_candidate: 1,
    watch: 2,
    risk_alert: 3,
    avoid: 4,
  }
  const aw = actionWeight[a.decision.action]
  const bw = actionWeight[b.decision.action]
  if (aw !== bw) return aw - bw
  return b.decision.score - a.decision.score
}

function toCandidate(params: {
  row: RawCandidateRow
  horizonDays: number
  budgetYen: number
  signalReturnMap: Map<string, SignalReturnRow>
  signalPatternMap: Map<string, SignalPatternRow>
  patternStatsMap: Map<string, PatternStatRow>
  objectiveMap: Map<string, TradeWorkbenchModelEvidence>
}): TradeWorkbenchCandidate {
  const { row, horizonDays, budgetYen, signalReturnMap, signalPatternMap, patternStatsMap, objectiveMap } = params
  const stages = [
    num(row.daily_a_stage),
    num(row.daily_b_stage),
    num(row.weekly_a_stage),
    num(row.weekly_b_stage),
    num(row.monthly_a_stage),
    num(row.monthly_b_stage),
  ]
  const patternCode = stageCode(stages)
  const codes = parseSignalCodes(row.signal_codes)
  const signalEvidence = makeSignalEvidence(codes, signalReturnMap)
  const signalPatternEvidence = makeSignalPatternEvidence(codes, horizonDays, signalPatternMap)
  const patternEvidence = makePatternEvidence(patternCode, horizonDays, patternStatsMap)
  const objectiveUp = objectiveMap.get(`up|${horizonDays}`) ?? null
  const objectiveDown = objectiveMap.get(`down|${horizonDays}`) ?? null
  const ma = maState(row)
  const nextEarnings = resolveTradeNextEarnings(row)
  const decision = makeDecision({
    row,
    stages,
    signalEvidence,
    signalPatternEvidence,
    patternEvidence,
    objectiveUp,
    objectiveDown,
    ma,
  })
  const orderDraft = makeOrderDraft({ row, decision, budgetYen, objectiveUp, objectiveDown })
  return {
    ticker: row.ticker,
    name: row.name,
    marketSegment: INDIVIDUAL_MARKETS.has(row.market_segment ?? '') ? row.market_segment : null,
    sector17Name: row.sector17_name,
    sector33Name: row.sector33_name,
    marginType: row.margin_type,
    signalDate: row.signal_date,
    priceDate: row.price_date,
    physicsDate: row.physics_date,
    classicMlDate: row.classic_ml_date,
    close: num(row.close),
    previousClose: num(row.previous_close),
    changePct: finite(row.close) && finite(row.previous_close) && row.previous_close !== 0
      ? 100 * (row.close - row.previous_close) / row.previous_close
      : null,
    volume: num(row.volume),
    stageCode: patternCode,
    stageLabels: stageLabels(stages),
    stages,
    maState: ma,
    signal: {
      rank: num(row.signal_rank),
      score: num(row.signal_score),
      codes,
    },
    ml: {
      physicsUp: {
        rank: num(row.physics_up_rank),
        score: num(row.physics_up_score),
        modelName: row.physics_up_model,
      },
      physicsDown: {
        rank: num(row.physics_down_rank),
        score: num(row.physics_down_score),
        modelName: row.physics_down_model,
      },
      physicsWait: {
        rank: num(row.physics_wait_rank),
        score: num(row.physics_wait_score),
        modelName: row.physics_wait_model,
      },
      classicUp: {
        rank: num(row.classic_up_rank),
        score: num(row.classic_up_score),
        modelName: row.classic_up_model,
      },
      classicDown: {
        rank: num(row.classic_down_rank),
        score: num(row.classic_down_score),
        modelName: row.classic_down_model,
      },
    },
    historicalEvidence: {
      signalShortTerm: signalEvidence,
      signalPattern: signalPatternEvidence,
      stagePattern: patternEvidence,
      objectiveUp,
      objectiveDown,
    },
    decision,
    orderDraft,
    nextEarningsDate: nextEarnings.date,
    nextEarningsFiscalPeriod: nextEarnings.fiscalPeriod,
    nextEarningsSource: nextEarnings.source,
  }
}

export async function getTradeWorkbench(params: {
  horizonDays?: number | null
  limit?: number | null
  budgetYen?: number | null
} = {}): Promise<TradeWorkbenchResult> {
  const horizonDays = [20, 40, 60, 90, 180].includes(Number(params.horizonDays))
    ? Number(params.horizonDays)
    : DEFAULT_HORIZON
  const limit = Math.min(120, Math.max(1, Number(params.limit ?? DEFAULT_LIMIT)))
  const budgetYen = Math.min(10_000_000, Math.max(100_000, Number(params.budgetYen ?? DEFAULT_BUDGET_YEN)))
  const rows = await fetchRows(horizonDays, limit)
  const codes = Array.from(new Set(rows.flatMap((row) => parseSignalCodes(row.signal_codes))))
  const patterns = Array.from(new Set(rows.map((row) => stageCode([
    num(row.daily_a_stage),
    num(row.daily_b_stage),
    num(row.weekly_a_stage),
    num(row.weekly_b_stage),
    num(row.monthly_a_stage),
    num(row.monthly_b_stage),
  ])).filter((value): value is string => Boolean(value))))
  const evidenceHorizons = Array.from(new Set([horizonDays, 20, 40, 60, 90, 180, 30, 5]))

  const [
    signalReturnMap,
    signalPatternMap,
    patternStatsMap,
    objectiveMap,
    marketContext,
    latestDataDate,
    latestSignalDate,
    latestPhysicsDate,
    latestClassicMlDate,
    latestModelEvaluationDate,
  ] = await Promise.all([
    fetchSignalReturnEvidence(codes),
    fetchSignalPatternEvidence(codes, evidenceHorizons),
    fetchPatternStats(patterns, evidenceHorizons),
    fetchObjectiveEvidence([horizonDays]),
    fetchMarketContext(),
    latestDate('daily_snapshots', 'date'),
    latestDate('serving_latest_signals', 'date'),
    latestDate('serving_ml_physics_candidates', 'as_of_date'),
    latestDate('serving_ml_candidates', 'as_of_date'),
    latestObjectiveEvaluationDate(),
  ])

  const candidates = rows
    .map((row) => toCandidate({
      row,
      horizonDays,
      budgetYen,
      signalReturnMap,
      signalPatternMap,
      patternStatsMap,
      objectiveMap,
    }))
    .sort(sortCandidates)
    .slice(0, limit)

  const summary = candidates.reduce<TradeWorkbenchSummary>((acc, candidate) => {
    acc.total += 1
    if (candidate.decision.action === 'buy_candidate') acc.buyCandidates += 1
    else if (candidate.decision.action === 'short_candidate') acc.shortCandidates += 1
    else if (candidate.decision.action === 'watch') acc.watch += 1
    else if (candidate.decision.action === 'risk_alert') acc.riskAlerts += 1
    else acc.avoid += 1
    return acc
  }, {
    total: 0,
    buyCandidates: 0,
    shortCandidates: 0,
    watch: 0,
    riskAlerts: 0,
    avoid: 0,
    latestDataDate,
    latestSignalDate,
    latestPhysicsDate,
    latestClassicMlDate,
    latestModelEvaluationDate,
    marketContext,
  })

  return {
    summary,
    candidates,
    params: { horizonDays, limit, budgetYen },
  }
}

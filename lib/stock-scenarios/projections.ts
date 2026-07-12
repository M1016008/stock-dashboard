import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { analyzePhysicsProfile, type PhysicsAnalysis, type PhysicsStatus } from '@/lib/ml/physics-analysis'
import { normalizeMarket, type MarketCode } from '@/lib/markets'
import {
  defaultMaLinesForInterval,
  intervalToSpec,
  parseInterval,
  resampleOhlcv,
  type ChartIntervalCode,
} from '@/lib/timeframes'
import { loadManualOhlcvRows } from '@/lib/manual-ohlcv'
import type { OHLCV } from '@/types/stock'

export type ScenarioInterval = ChartIntervalCode
export type ProjectionDirection = 'up' | 'down' | 'range'
export type ProjectionScenarioType =
  | 'continuation'
  | 'rebound'
  | 'range'
  | 'breakdown'
  | 'pullback_fail'
  | 'overheat_reversal'
  | 'support_rebound'
  | 'squeeze_breakout'

export interface ProjectionPoint {
  date: string
  value: number
}

export interface ProjectionScenario {
  id: string
  type: ProjectionScenarioType
  direction: ProjectionDirection
  label: string
  score: number
  relativeWeightPct: number
  probabilityRank: number
  scoreBreakdown: ScenarioScoreBreakdown[]
  targetPrice: number | null
  stopPrice: number | null
  upperGuidePrice: number | null
  lowerGuidePrice: number | null
  reboundLine: string | null
  invalidation: string
  thesis: string
  narrative: string
  evidence: string[]
  points: ProjectionPoint[]
}

export interface ScenarioScoreBreakdown {
  key: 'physics_status' | 'physical_momentum' | 'ma_structure' | 'ml_candidate' | 'historical_validation' | 'scenario_shape'
  label: string
  value: number
  max: number
  detail: string
}

export interface ProjectionResponse {
  ok: true
  ticker: string
  interval: ScenarioInterval
  horizonDays: number
  featureSet: string
  baseDate: string
  basePrice: number
  statusLabel: PhysicsStatus
  sourceDates: {
    price: string
    feature: string | null
    featureDerived?: boolean
    physicalMomentum: string | null
    calibration: string | null
    physicsCandidates: string | null
  }
  chart: {
    candles: OHLCV[]
    ma: Record<string, ProjectionPoint[]>
  }
  stats: {
    recentHigh: number | null
    recentLow: number | null
    atrPct: number | null
    ma5: number | null
    ma25: number | null
    ma75: number | null
    ma200: number | null
    pms: number | null
    pfs: number | null
    pes: number | null
    hitRate: number | null
    baseRate: number | null
    lift: number | null
    avgMaxReturnPct: number | null
    avgMinReturnPct: number | null
  }
  scenarios: ProjectionScenario[]
  note: string
}

type RawOhlcvRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type FeatureRow = {
  date: string
  featureJson: string
  stageCode: string | null
}

type MomentumRow = {
  date: string
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

type CalibrationRow = {
  evaluationDate: string
  targetDirection: 'up' | 'down' | 'wait'
  sampleCount: number
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
  adverseRate: number | null
}

type PhysicsCandidateRow = {
  asOfDate: string
  direction: 'up' | 'down' | 'wait'
  rank: number
  candidateScore: number
}

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 8
const SCENARIO_STATS_MA_PERIODS = [5, 25, 75, 200] as const

function normalizeTicker(value: string, market: MarketCode = 'JP'): string {
  const cleaned = value.trim().toUpperCase()
  return market === 'JP' ? cleaned.replace(/\.T$/i, '') : cleaned.replace(/\s+/g, '')
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number | null | undefined, digits = 2): number | null {
  if (!finite(value)) return null
  return Number(value.toFixed(digits))
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function pctToPrice(base: number, pct: number): number {
  return base * (1 + pct / 100)
}

function priceToPct(price: number | null | undefined, base: number): number | null {
  if (!finite(price) || base <= 0) return null
  return ((price - base) / base) * 100
}

function scoreFromStatus(status: PhysicsStatus, direction: ProjectionDirection): number {
  const upStatuses = new Set<PhysicsStatus>(['上昇加速', '上昇継続', '押し目形成', '反発準備'])
  const downStatuses = new Set<PhysicsStatus>(['失速警戒', '下落加速'])
  if (direction === 'up') return upStatuses.has(status) ? 18 : status === '過熱注意' ? 5 : -8
  if (direction === 'down') return downStatuses.has(status) || status === '過熱注意' ? 18 : -8
  return status === '見送り' || status === '算出待ち' ? 14 : 4
}

function scoreFromCandidates(candidates: PhysicsCandidateRow[], direction: ProjectionDirection): number {
  const matched = candidates.filter((row) => {
    if (direction === 'range') return row.direction === 'wait'
    return row.direction === direction
  })
  if (matched.length === 0) return 0
  const best = matched.sort((a, b) => a.rank - b.rank)[0]
  return clamp(18 - best.rank * 0.22, 2, 18)
}

function candidateEvidence(candidates: PhysicsCandidateRow[], direction: ProjectionDirection): string | null {
  const label = direction === 'range' ? 'wait' : direction
  const matched = candidates
    .filter((row) => row.direction === label)
    .sort((a, b) => a.rank - b.rank)
  if (matched.length === 0) return null
  const best = matched[0]
  const ja = label === 'up' ? '上昇' : label === 'down' ? '下落' : '見送り'
  return `物理ML${ja}候補 #${best.rank}`
}

function scoreFromCalibration(calibration: CalibrationRow | null, direction: ProjectionDirection): number {
  if (!calibration) return 0
  const target = direction === 'range' ? 'wait' : direction
  const directionBonus = calibration.targetDirection === target ? 9 : -5
  const liftBonus = finite(calibration.lift) ? clamp((calibration.lift - 1) * 16, -8, 12) : 0
  const hitBonus = finite(calibration.hitRate) && finite(calibration.baseRate)
    ? clamp((calibration.hitRate - calibration.baseRate) * 45, -6, 10)
    : 0
  return directionBonus + liftBonus + hitBonus
}

function scoreFromMomentum(momentum: MomentumRow | null, direction: ProjectionDirection): number {
  const pms = momentum?.physicalMomentumScore ?? null
  const pfs = momentum?.physicalForceScore ?? null
  const pes = momentum?.physicalEnergyScore ?? null
  if (direction === 'up') return clamp((pms ?? 0) * 4 + (pfs ?? 0) * 5 + (pes ?? 0) * 2, -14, 18)
  if (direction === 'down') return clamp(-(pms ?? 0) * 4 - (pfs ?? 0) * 5 + Math.max(0, pes ?? 0) * 1.5, -14, 18)
  return clamp(12 - Math.abs(pms ?? 0) * 4 - Math.abs(pfs ?? 0) * 5, -6, 12)
}

function scoreFromMaStructure(
  stats: {
    ma5: number | null
    ma25: number | null
    ma75: number | null
    ma200: number | null
  },
  metrics: PhysicsAnalysis['metrics'] | null,
  basePrice: number,
  direction: ProjectionDirection,
): number {
  const above5 = finite(stats.ma5) && basePrice >= stats.ma5
  const above25 = finite(stats.ma25) && basePrice >= stats.ma25
  const below5 = finite(stats.ma5) && basePrice <= stats.ma5
  const below25 = finite(stats.ma25) && basePrice <= stats.ma25
  const bullishOrder = finite(stats.ma5) && finite(stats.ma25) && finite(stats.ma75) && stats.ma5 >= stats.ma25 && stats.ma25 >= stats.ma75
  const bearishOrder = finite(stats.ma5) && finite(stats.ma25) && finite(stats.ma75) && stats.ma5 <= stats.ma25 && stats.ma25 <= stats.ma75
  const shortSlope = metrics?.sma5Velocity5 ?? null
  const midSlope = metrics?.sma25Velocity5 ?? null
  const longSlope = metrics?.sma75Velocity10 ?? null
  const gapVelocity = metrics?.gap5To25Velocity5 ?? null
  const priceTo25 = metrics?.priceToSma25 ?? null

  if (direction === 'up') {
    return clamp(
      (above5 ? 2 : -2) +
      (above25 ? 3 : -3) +
      (bullishOrder ? 3 : 0) +
      ((shortSlope ?? 0) > 0 ? 3 : -2) +
      ((midSlope ?? 0) > 0 ? 2 : -2) +
      ((gapVelocity ?? 0) > 0 ? 1 : 0),
      -12,
      14,
    )
  }

  if (direction === 'down') {
    return clamp(
      (below5 ? 2 : -2) +
      (below25 ? 3 : -3) +
      (bearishOrder ? 3 : 0) +
      ((shortSlope ?? 0) < 0 ? 3 : -2) +
      ((midSlope ?? 0) < 0 ? 2 : -2) +
      ((gapVelocity ?? 0) < 0 ? 1 : 0) +
      ((longSlope ?? 0) < 0 ? 1 : 0),
      -12,
      14,
    )
  }

  return clamp(
    (Math.abs(shortSlope ?? 0) <= 0.7 ? 4 : -2) +
    (Math.abs(midSlope ?? 0) <= 0.4 ? 3 : -1) +
    (Math.abs(priceTo25 ?? 999) <= 4 ? 4 : -2) +
    (Math.abs(gapVelocity ?? 0) <= 0.35 ? 3 : -1),
    -10,
    14,
  )
}

function fmtSigned(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`
}

function scoreBreakdown(input: {
  status: PhysicsStatus
  calibration: CalibrationRow | null
  candidates: PhysicsCandidateRow[]
  momentum: MomentumRow | null
  stats: {
    ma5: number | null
    ma25: number | null
    ma75: number | null
    ma200: number | null
  }
  metrics: PhysicsAnalysis['metrics'] | null
  basePrice: number
  direction: ProjectionDirection
}): ScenarioScoreBreakdown[] {
  const { status, calibration, candidates, momentum, stats, metrics, basePrice, direction } = input
  return [
    {
      key: 'physics_status',
      label: '物理状態',
      value: round(scoreFromStatus(status, direction), 1) ?? 0,
      max: 18,
      detail: `${status} / ${direction === 'up' ? '上昇' : direction === 'down' ? '下落' : '横ばい'}方向との整合`,
    },
    {
      key: 'physical_momentum',
      label: 'PMS/PFS/PES',
      value: round(scoreFromMomentum(momentum, direction), 1) ?? 0,
      max: 18,
      detail: `PMS ${fmtSigned(momentum?.physicalMomentumScore, 2)} / PFS ${fmtSigned(momentum?.physicalForceScore, 2)} / PES ${fmtSigned(momentum?.physicalEnergyScore, 2)}`,
    },
    {
      key: 'ma_structure',
      label: 'MA角度/配置',
      value: round(scoreFromMaStructure(stats, metrics, basePrice, direction), 1) ?? 0,
      max: 14,
      detail: `5MA角度 ${fmtSigned(metrics?.sma5Velocity5)} / 25MA角度 ${fmtSigned(metrics?.sma25Velocity5)} / 価格25MA乖離 ${fmtSigned(metrics?.priceToSma25)}%`,
    },
    {
      key: 'ml_candidate',
      label: '物理ML候補',
      value: round(scoreFromCandidates(candidates, direction), 1) ?? 0,
      max: 18,
      detail: candidateEvidence(candidates, direction) ?? '物理ML上位候補には未掲載',
    },
    {
      key: 'historical_validation',
      label: '過去検証',
      value: round(scoreFromCalibration(calibration, direction), 1) ?? 0,
      max: 31,
      detail: finite(calibration?.hitRate) && finite(calibration?.baseRate)
        ? `的中${Math.round((calibration.hitRate ?? 0) * 100)}% / base ${Math.round((calibration.baseRate ?? 0) * 100)}% / lift ${fmtSigned(calibration.lift, 2)}`
        : '該当ステータスの検証値なし',
    },
  ]
}

function toOhlcv(row: RawOhlcvRow): OHLCV {
  return {
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }
}

function aggregateOhlcv(rows: OHLCV[], interval: ScenarioInterval): OHLCV[] {
  return resampleOhlcv(rows, intervalToSpec(interval))
}

function simpleMa(rows: OHLCV[], period: number): ProjectionPoint[] {
  const series: ProjectionPoint[] = []
  for (let i = period - 1; i < rows.length; i += 1) {
    const slice = rows.slice(i - period + 1, i + 1)
    const value = slice.reduce((sum, row) => sum + row.close, 0) / period
    series.push({ date: rows[i].date, value: round(value, 2) ?? value })
  }
  return series
}

function latestMa(rows: OHLCV[], period: number): number | null {
  if (rows.length < period) return null
  const slice = rows.slice(-period)
  return slice.reduce((sum, row) => sum + row.close, 0) / period
}

function atrPct(rows: OHLCV[], lookback = 20): number | null {
  const slice = rows.slice(-lookback)
  if (slice.length === 0) return null
  const values = slice
    .map((row) => row.close > 0 ? ((row.high - row.low) / row.close) * 100 : null)
    .filter((value): value is number => finite(value))
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function recentHigh(rows: OHLCV[], lookback: number): number | null {
  const slice = rows.slice(-lookback)
  return slice.length ? Math.max(...slice.map((row) => row.high)) : null
}

function recentLow(rows: OHLCV[], lookback: number): number | null {
  const slice = rows.slice(-lookback)
  return slice.length ? Math.min(...slice.map((row) => row.low)) : null
}

function addFutureDate(date: string, interval: ScenarioInterval, step: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  const spec = intervalToSpec(interval)
  const multiplier = Math.max(1, Math.floor(spec.multiplier))
  const totalSteps = Math.max(1, step) * multiplier
  if (spec.timeframe === 'day') {
    let added = 0
    while (added < totalSteps) {
      d.setUTCDate(d.getUTCDate() + 1)
      const day = d.getUTCDay()
      if (day !== 0 && day !== 6) added += 1
    }
  } else if (spec.timeframe === 'week') {
    d.setUTCDate(d.getUTCDate() + 7 * totalSteps)
  } else {
    d.setUTCMonth(d.getUTCMonth() + totalSteps)
  }
  return d.toISOString().slice(0, 10)
}

function futurePointCount(interval: ScenarioInterval, horizonDays: number): number {
  const spec = intervalToSpec(interval)
  if (spec.timeframe === 'day') return Math.max(2, Math.min(8, Math.ceil(horizonDays / spec.multiplier)))
  if (spec.timeframe === 'week') return Math.max(2, Math.min(8, Math.ceil(horizonDays / (5 * spec.multiplier))))
  return Math.max(2, Math.min(8, Math.ceil(horizonDays / (20 * spec.multiplier))))
}

function visibleBarsForInterval(interval: ScenarioInterval): number {
  const spec = intervalToSpec(interval)
  if (spec.timeframe === 'day') return spec.multiplier === 1 ? 180 : 140
  if (spec.timeframe === 'week') return spec.multiplier === 1 ? 156 : 120
  return spec.multiplier === 1 ? 120 : 90
}

function lookbackBarsForInterval(interval: ScenarioInterval): number {
  const spec = intervalToSpec(interval)
  if (spec.timeframe === 'day') return Math.max(8, Math.ceil(20 / spec.multiplier))
  if (spec.timeframe === 'week') return Math.max(6, Math.ceil(12 / spec.multiplier))
  return Math.max(4, Math.ceil(8 / spec.multiplier))
}

function maPeriodsForInterval(interval: ScenarioInterval): number[] {
  return Array.from(new Set([
    ...defaultMaLinesForInterval(interval),
    ...SCENARIO_STATS_MA_PERIODS,
  ])).sort((a, b) => a - b)
}

function maAt(rows: OHLCV[], period: number, index: number): number | null {
  if (period <= 0 || index < period - 1 || index >= rows.length) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i += 1) {
    const close = rows[i]?.close
    if (!finite(close)) return null
    sum += close
  }
  return sum / period
}

function maVelocity(rows: OHLCV[], period: number, bars: number, index = rows.length - 1): number | null {
  const current = maAt(rows, period, index)
  const previous = maAt(rows, period, index - bars)
  if (!finite(current) || !finite(previous) || previous === 0) return null
  return ((current - previous) / previous) * 100
}

function maAcceleration(rows: OHLCV[], period: number, bars: number, index = rows.length - 1): number | null {
  const current = maVelocity(rows, period, bars, index)
  const previous = maVelocity(rows, period, bars, index - 1)
  if (!finite(current) || !finite(previous)) return null
  return current - previous
}

function gapPct(shortMa: number | null, longMa: number | null): number | null {
  if (!finite(shortMa) || !finite(longMa) || longMa === 0) return null
  return ((shortMa - longMa) / longMa) * 100
}

function gapVelocity(rows: OHLCV[], shortPeriod: number, longPeriod: number, bars: number, index = rows.length - 1): number | null {
  const current = gapPct(maAt(rows, shortPeriod, index), maAt(rows, longPeriod, index))
  const previous = gapPct(maAt(rows, shortPeriod, index - bars), maAt(rows, longPeriod, index - bars))
  if (!finite(current) || !finite(previous)) return null
  return current - previous
}

function priceToMa(close: number, ma: number | null): number | null {
  if (!finite(ma) || ma === 0) return null
  return ((close - ma) / ma) * 100
}

function maOrderLabel(values: Array<{ label: string; value: number | null }>): string {
  return values
    .filter((item): item is { label: string; value: number } => finite(item.value))
    .sort((a, b) => b.value - a.value)
    .map((item) => item.label)
    .join(' > ')
}

function inferTrendRegime(sma5Velocity5: number | null, sma25Velocity5: number | null, sma5Acceleration5: number | null): string {
  if ((sma5Velocity5 ?? 0) >= 1.2 && (sma25Velocity5 ?? 0) >= -0.2 && (sma5Acceleration5 ?? 0) >= 0.15) return 'up_acceleration'
  if ((sma5Velocity5 ?? 0) > 0.3 && (sma5Acceleration5 ?? 0) <= -0.35) return 'up_deceleration'
  if ((sma5Velocity5 ?? 0) <= -1.2 && (sma25Velocity5 ?? 0) <= 0.2 && (sma5Acceleration5 ?? 0) <= -0.15) return 'down_acceleration'
  return 'sideways'
}

function inferSpreadRegime(gap5To25Pct: number | null, gap5To25Velocity5: number | null, gap25To75Velocity5: number | null): string {
  if ((gap5To25Pct ?? 0) >= 11 && (gap5To25Velocity5 ?? 0) > 0.4) return 'overheated'
  if ((gap5To25Pct ?? 0) > 0 && (gap5To25Velocity5 ?? 0) > 0.35 && (gap25To75Velocity5 ?? 0) >= -0.5) return 'up_expansion'
  if ((gap5To25Pct ?? 0) < 0 && (gap5To25Velocity5 ?? 0) < -0.35) return 'down_expansion'
  if (Math.abs(gap5To25Velocity5 ?? 999) <= 0.35 && Math.abs(gap25To75Velocity5 ?? 999) <= 0.35) return 'compression'
  return 'neutral'
}

function buildLatestChartPhysicsProfile(rows: OHLCV[]): Record<string, unknown> | null {
  if (rows.length < 30) return null
  const latest = rows[rows.length - 1]
  if (!latest || !finite(latest.close)) return null
  const ma5 = maAt(rows, 5, rows.length - 1)
  const ma25 = maAt(rows, 25, rows.length - 1)
  const ma75 = maAt(rows, 75, rows.length - 1)
  const ma200 = maAt(rows, 200, rows.length - 1)
  const sma5Velocity5 = maVelocity(rows, 5, 5)
  const sma25Velocity5 = maVelocity(rows, 25, 5)
  const sma75Velocity10 = maVelocity(rows, 75, 10)
  const sma200Velocity10 = maVelocity(rows, 200, 10)
  const sma5Acceleration5 = maAcceleration(rows, 5, 5)
  const sma25Acceleration5 = maAcceleration(rows, 25, 5)
  const gap5To25Pct = gapPct(ma5, ma25)
  const gap25To75Pct = gapPct(ma25, ma75)
  const gap75To200Pct = gapPct(ma75, ma200)
  const gap5To25Velocity5 = gapVelocity(rows, 5, 25, 5)
  const gap25To75Velocity5 = gapVelocity(rows, 25, 75, 5)
  const recentHighValue = recentHigh(rows, Math.min(60, rows.length))
  const distanceToRecentHighPct = finite(recentHighValue) && latest.close > 0
    ? ((recentHighValue - latest.close) / latest.close) * 100
    : null

  return {
    maOrder: maOrderLabel([
      { label: '5日', value: ma5 },
      { label: '25日', value: ma25 },
      { label: '75日', value: ma75 },
      { label: '200日', value: ma200 },
    ]),
    velocities: {
      sma5: { d5: sma5Velocity5 },
      sma25: { d5: sma25Velocity5 },
      sma75: { d10: sma75Velocity10 },
      sma200: { d10: sma200Velocity10 },
    },
    accelerations: {
      sma5: { d5: sma5Acceleration5 },
      sma25: { d5: sma25Acceleration5 },
    },
    gaps: {
      sma5To25Pct: gap5To25Pct,
      sma25To75Pct: gap25To75Pct,
      sma75To200Pct: gap75To200Pct,
    },
    gapVelocity: {
      sma5To25D5: gap5To25Velocity5,
      sma25To75D5: gap25To75Velocity5,
    },
    pricePosition: {
      sma5: priceToMa(latest.close, ma5),
      sma25: priceToMa(latest.close, ma25),
    },
    distanceToRecentHighPct,
    regimes: {
      trend: inferTrendRegime(sma5Velocity5, sma25Velocity5, sma5Acceleration5),
      spread: inferSpreadRegime(gap5To25Pct, gap5To25Velocity5, gap25To75Velocity5),
    },
  }
}

function makePath(baseDate: string, basePrice: number, target: number, interval: ScenarioInterval, horizonDays: number, curve = 1): ProjectionPoint[] {
  const count = futurePointCount(interval, horizonDays)
  const points: ProjectionPoint[] = [{ date: baseDate, value: round(basePrice, 2) ?? basePrice }]
  for (let i = 1; i <= count; i += 1) {
    const t = i / count
    const curved = curve === 1 ? t : Math.pow(t, curve)
    const value = basePrice + (target - basePrice) * curved
    points.push({ date: addFutureDate(baseDate, interval, i), value: round(value, 2) ?? value })
  }
  return points
}

function guidePrice(current: number, preferredPct: number | null, fallbackPct: number, minAbsPct: number, maxAbsPct: number): number {
  const raw = finite(preferredPct) ? preferredPct : fallbackPct
  const sign = raw >= 0 ? 1 : -1
  const clipped = sign * clamp(Math.abs(raw), minAbsPct, maxAbsPct)
  return pctToPrice(current, clipped)
}

function nearestSupport(base: number, ma5: number | null, ma25: number | null, ma75: number | null, recentLowValue: number | null): { label: string; value: number | null } {
  const candidates = [
    { label: '5MA', value: ma5 },
    { label: '25MA', value: ma25 },
    { label: '75MA', value: ma75 },
    { label: '直近安値', value: recentLowValue },
  ].filter((item): item is { label: string; value: number } => finite(item.value) && item.value < base)
  if (candidates.length === 0) return { label: '下値支持未判定', value: recentLowValue }
  return candidates.sort((a, b) => Math.abs(base - a.value) - Math.abs(base - b.value))[0]
}

function nearestResistance(base: number, ma5: number | null, ma25: number | null, ma75: number | null, recentHighValue: number | null): { label: string; value: number | null } {
  const candidates = [
    { label: '5MA', value: ma5 },
    { label: '25MA', value: ma25 },
    { label: '75MA', value: ma75 },
    { label: '直近高値', value: recentHighValue },
  ].filter((item): item is { label: string; value: number } => finite(item.value) && item.value > base)
  if (candidates.length === 0) return { label: '上値抵抗未判定', value: recentHighValue }
  return candidates.sort((a, b) => Math.abs(base - a.value) - Math.abs(base - b.value))[0]
}

function makeScenario(args: {
  type: ProjectionScenarioType
  direction: ProjectionDirection
  label: string
  baseDate: string
  basePrice: number
  interval: ScenarioInterval
  horizonDays: number
  targetPrice: number | null
  stopPrice: number | null
  upperGuidePrice: number | null
  lowerGuidePrice: number | null
  reboundLine: string | null
  invalidation: string
  thesis: string
  evidence: string[]
  rawScore: number
  scoreBreakdown: ScenarioScoreBreakdown[]
  curve?: number
}): ProjectionScenario {
  const target = args.targetPrice ?? args.basePrice
  return {
    id: `${args.type}_${args.direction}`,
    type: args.type,
    direction: args.direction,
    label: args.label,
    score: clamp(Math.round(args.rawScore), 1, 99),
    relativeWeightPct: 0,
    probabilityRank: 0,
    scoreBreakdown: args.scoreBreakdown,
    targetPrice: round(args.targetPrice, 1),
    stopPrice: round(args.stopPrice, 1),
    upperGuidePrice: round(args.upperGuidePrice, 1),
    lowerGuidePrice: round(args.lowerGuidePrice, 1),
    reboundLine: args.reboundLine,
    invalidation: args.invalidation,
    thesis: args.thesis,
    narrative: args.thesis,
    evidence: args.evidence.filter(Boolean),
    points: makePath(args.baseDate, args.basePrice, target, args.interval, args.horizonDays, args.curve ?? 1),
  }
}

function formatScenarioPrice(value: number | null | undefined, market: MarketCode): string {
  if (!finite(value)) return '-'
  if (market === 'US') return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function localNarrative(scenario: ProjectionScenario, market: MarketCode): string {
  const directionText = scenario.direction === 'up' ? '上方向' : scenario.direction === 'down' ? '下方向' : '横ばい'
  const targetText = finite(scenario.targetPrice) ? `目処は${formatScenarioPrice(scenario.targetPrice, market)}付近` : '目処は未判定'
  const evidence = scenario.evidence.slice(0, 3).join('、')
  return `${directionText}のシナリオです。${targetText}。根拠は${evidence || '現在形状とMA位置'}です。失効条件は「${scenario.invalidation}」。`
}

function buildScenarios(input: {
  market: MarketCode
  interval: ScenarioInterval
  horizonDays: number
  baseDate: string
  basePrice: number
  status: PhysicsStatus
  analysis: PhysicsAnalysis
  calibration: CalibrationRow | null
  candidates: PhysicsCandidateRow[]
  momentum: MomentumRow | null
  stats: {
    atrPct: number | null
    recentHigh: number | null
    recentLow: number | null
    ma5: number | null
    ma25: number | null
    ma75: number | null
    ma200: number | null
  }
}): ProjectionScenario[] {
  const { market, interval, horizonDays, baseDate, basePrice, status, analysis, calibration, candidates, momentum, stats } = input
  const atr = stats.atrPct ?? 2.5
  const upPctFromCalib =
    finite(calibration?.avgMaxReturnPct) && (calibration?.avgMaxReturnPct ?? 0) > 0
      ? calibration.avgMaxReturnPct
      : null
  const downPctFromCalib =
    finite(calibration?.avgMinReturnPct) && (calibration?.avgMinReturnPct ?? 0) < 0
      ? calibration.avgMinReturnPct
      : null
  const resistancePct = priceToPct(stats.recentHigh, basePrice)
  const supportPct = priceToPct(stats.recentLow, basePrice)
  const resistance = nearestResistance(basePrice, stats.ma5, stats.ma25, stats.ma75, stats.recentHigh)
  const support = nearestSupport(basePrice, stats.ma5, stats.ma25, stats.ma75, stats.recentLow)
  const supportBelow =
    support.value ??
    [stats.ma5, stats.ma25, stats.ma75, stats.recentLow].find((value) => finite(value) && (value ?? 0) < basePrice) ??
    pctToPrice(basePrice, -atr)
  const resistanceAbove =
    resistance.value ??
    [stats.ma5, stats.ma25, stats.ma75, stats.recentHigh].find((value) => finite(value) && (value ?? 0) > basePrice) ??
    pctToPrice(basePrice, atr)

  const upTarget = guidePrice(basePrice, upPctFromCalib, Math.max(atr * 1.6, resistancePct ?? 0), Math.max(1.5, atr), 35)
  const downTarget = guidePrice(basePrice, downPctFromCalib, Math.min(-atr * 1.7, supportPct ?? 0), Math.max(1.5, atr), 35)
  const rangeUp = pctToPrice(basePrice, clamp(Math.max(atr, resistancePct ?? atr), 1, 12))
  const rangeDown = pctToPrice(basePrice, -clamp(Math.max(atr, Math.abs(supportPct ?? atr)), 1, 12))
  const pfs = momentum?.physicalForceScore ?? null
  const pms = momentum?.physicalMomentumScore ?? null
  const pes = momentum?.physicalEnergyScore ?? null

  const scorePackage = (direction: ProjectionDirection, adjustment = 0, adjustmentDetail = '') => {
    const parts = scoreBreakdown({
      status,
      calibration,
      candidates,
      momentum,
      stats,
      metrics: analysis.metrics,
      basePrice,
      direction,
    })
    if (adjustment !== 0) {
      const boundedAdjustment = clamp(adjustment, -14, 14)
      parts.push({
        key: 'scenario_shape',
        label: '形状補正',
        value: round(boundedAdjustment, 1) ?? boundedAdjustment,
        max: 14,
        detail: adjustmentDetail || '支持線・抵抗線・収縮/拡散の位置関係',
      })
    }
    return {
      rawScore: 50 + parts.reduce((sum, part) => sum + part.value, 0) * 0.65,
      scoreBreakdown: parts,
    }
  }

  const commonEvidence = [
    `物理状態: ${status}`,
    finite(pms) ? `PMS ${pms.toFixed(2)}` : null,
    finite(pfs) ? `PFS ${pfs.toFixed(2)}` : null,
    finite(pes) ? `PES ${pes.toFixed(2)}` : null,
    finite(calibration?.hitRate) && finite(calibration?.lift)
      ? `過去検証 的中${Math.round((calibration.hitRate ?? 0) * 100)}% / lift ${(calibration.lift ?? 0).toFixed(2)}`
      : null,
  ].filter((item): item is string => Boolean(item))

  const scenarios = [
    makeScenario({
      type: 'continuation',
      direction: 'up',
      label: '上昇継続',
      baseDate,
      basePrice,
      interval,
      horizonDays,
      targetPrice: upTarget,
      stopPrice: supportBelow,
      upperGuidePrice: resistanceAbove,
      lowerGuidePrice: supportBelow,
      reboundLine: resistance.label,
      invalidation: `終値で${support.label}を明確に割り、PFSがマイナス化する場合`,
      thesis: '現在のモメンタムが維持され、短期線の上向きが中期線へ伝わるシナリオ。',
      evidence: [...commonEvidence, candidateEvidence(candidates, 'up') ?? '', `${resistance.label}突破を確認`],
      ...scorePackage('up'),
      curve: 0.9,
    }),
    makeScenario({
      type: 'rebound',
      direction: 'up',
      label: '支持線反発',
      baseDate,
      basePrice,
      interval,
      horizonDays,
      targetPrice: Math.max(basePrice, resistance.value ?? pctToPrice(basePrice, atr * 1.2)),
      stopPrice: supportBelow,
      upperGuidePrice: resistanceAbove,
      lowerGuidePrice: supportBelow,
      reboundLine: support.label,
      invalidation: `${support.label}を終値で割り込み、戻りが弱い場合`,
      thesis: '一度支持線を試したあと、MA付近から反発するシナリオ。',
      evidence: [...commonEvidence, `${support.label}が近い`, '反発時のPFS回復を確認'],
      ...scorePackage('up', -5 + (support.value ? 8 : 0), support.value ? `${support.label}が下値候補として近い` : '明確な支持線が遠い'),
      curve: 1.25,
    }),
    makeScenario({
      type: 'squeeze_breakout',
      direction: 'up',
      label: '収縮後上放れ',
      baseDate,
      basePrice,
      interval,
      horizonDays,
      targetPrice: pctToPrice(basePrice, clamp((upPctFromCalib ?? atr * 2.4) * 0.85, 2, 24)),
      stopPrice: supportBelow,
      upperGuidePrice: stats.recentHigh,
      lowerGuidePrice: supportBelow,
      reboundLine: 'MA束収縮',
      invalidation: 'MA束が下方向へ拡散し、直近安値を割る場合',
      thesis: '力がいったん収縮し、上方向へ再拡散するシナリオ。',
      evidence: [...commonEvidence, candidateEvidence(candidates, 'up') ?? '', 'MA束の再拡散を確認'],
      ...scorePackage('up', Math.max(0, pfs ?? 0) * 8, 'PFSがプラスなら収縮後の上放れを補強'),
      curve: 1.1,
    }),
    makeScenario({
      type: 'range',
      direction: 'range',
      label: '横ばいレンジ',
      baseDate,
      basePrice,
      interval,
      horizonDays,
      targetPrice: basePrice,
      stopPrice: null,
      upperGuidePrice: rangeUp,
      lowerGuidePrice: rangeDown,
      reboundLine: `${formatScenarioPrice(rangeDown, market)}〜${formatScenarioPrice(rangeUp, market)}`,
      invalidation: 'レンジ上限または下限を終値で連続して抜ける場合',
      thesis: 'モメンタムが中立化し、MA付近で方向感を待つシナリオ。',
      evidence: [...commonEvidence, candidateEvidence(candidates, 'range') ?? '', `想定レンジ幅 約±${atr.toFixed(1)}%`],
      ...scorePackage('range'),
      curve: 1,
    }),
    makeScenario({
      type: 'breakdown',
      direction: 'down',
      label: '下落転換',
      baseDate,
      basePrice,
      interval,
      horizonDays,
      targetPrice: downTarget,
      stopPrice: resistanceAbove,
      upperGuidePrice: resistanceAbove,
      lowerGuidePrice: supportBelow ?? downTarget,
      reboundLine: support.label,
      invalidation: `終値で${resistance.label}を回復し、PFSがプラスに戻る場合`,
      thesis: '短期線の下向きが続き、支持線割れから下方向へ拡散するシナリオ。',
      evidence: [...commonEvidence, candidateEvidence(candidates, 'down') ?? '', `${support.label}割れを確認`],
      ...scorePackage('down'),
      curve: 0.9,
    }),
    makeScenario({
      type: 'pullback_fail',
      direction: 'down',
      label: '戻り売り優勢',
      baseDate,
      basePrice,
      interval,
      horizonDays,
      targetPrice: pctToPrice(basePrice, clamp((downPctFromCalib ?? -atr * 1.8) * 0.8, -28, -2)),
      stopPrice: resistanceAbove,
      upperGuidePrice: resistanceAbove,
      lowerGuidePrice: supportBelow,
      reboundLine: resistance.label,
      invalidation: `${resistance.label}を終値で上抜け、25MAが上向きへ戻る場合`,
      thesis: '反発しても上値抵抗で止まり、戻り売りが優勢になるシナリオ。',
      evidence: [...commonEvidence, `${resistance.label}が上値抵抗候補`, '戻りの弱さを確認'],
      ...scorePackage('down', -3 + (resistance.value ? 7 : 0), resistance.value ? `${resistance.label}が戻り売り候補として近い` : '明確な上値抵抗が遠い'),
      curve: 1.2,
    }),
    makeScenario({
      type: 'overheat_reversal',
      direction: 'down',
      label: '過熱反落',
      baseDate,
      basePrice,
      interval,
      horizonDays,
      targetPrice: pctToPrice(basePrice, -clamp(atr * 1.5, 2, 18)),
      stopPrice: resistanceAbove,
      upperGuidePrice: resistanceAbove,
      lowerGuidePrice: supportBelow,
      reboundLine: '5MA/25MA',
      invalidation: '高値更新後もPFSとPESが低下せず、5MA上を維持する場合',
      thesis: '熱量が高い一方で力が鈍化し、短期過熱が反落へつながるシナリオ。',
      evidence: [...commonEvidence, 'PES高止まり時の失速を警戒', candidateEvidence(candidates, 'down') ?? ''],
      ...scorePackage('down', (status === '過熱注意' ? 14 : 0) + Math.max(0, (pes ?? 0) - (pfs ?? 0)) * 3, '過熱状態または熱量に対して力が鈍る場合に補強'),
      curve: 0.85,
    }),
    makeScenario({
      type: 'support_rebound',
      direction: 'range',
      label: '支持線維持',
      baseDate,
      basePrice,
      interval,
      horizonDays,
      targetPrice: supportBelow ? Math.max(basePrice * 0.995, supportBelow * 1.02) : basePrice,
      stopPrice: supportBelow ? supportBelow * 0.985 : pctToPrice(basePrice, -atr),
      upperGuidePrice: resistanceAbove,
      lowerGuidePrice: supportBelow,
      reboundLine: support.label,
      invalidation: `${support.label}を終値で割り込み、下方向の力が拡散する場合`,
      thesis: '下値を試すが支持線を維持し、次の方向を待つシナリオ。',
      evidence: [...commonEvidence, `${support.label}維持を確認`, candidateEvidence(candidates, 'range') ?? ''],
      ...scorePackage('range', support.value ? 6 : 0, support.value ? `${support.label}がレンジ下限候補` : ''),
      curve: 1,
    }),
  ]

  const sorted = scenarios
    .map((scenario) => ({ ...scenario, narrative: localNarrative(scenario, market) }))
    .sort((a, b) => b.score - a.score)
  const scoreTotal = sorted.reduce((sum, scenario) => sum + Math.max(1, scenario.score), 0)
  return sorted
    .map((scenario, index) => ({
      ...scenario,
      probabilityRank: index + 1,
      relativeWeightPct: round((Math.max(1, scenario.score) / scoreTotal) * 100, 1) ?? 0,
    }))
}

async function loadOhlcv(ticker: string, market: MarketCode, asOfDate?: string | null): Promise<OHLCV[]> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  if (market === 'US') {
    const rows = await execAll<RawOhlcvRow>(
      `
        SELECT date, open, high, low, close, volume
        FROM market_ohlcv_daily
        WHERE market = 'US'
          AND ticker = ?
          ${dateFilter}
        ORDER BY date
      `,
      asOfDate ? [ticker, asOfDate] : [ticker],
    )
    return rows.map(toOhlcv)
  }
  const rows = await execAll<RawOhlcvRow>(
    `
      SELECT date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
        ${dateFilter}
      ORDER BY date
    `,
    asOfDate ? [ticker, asOfDate] : [ticker],
  )
  if (rows.length > 0) {
    return rows.map(toOhlcv)
  }
  return loadManualOhlcvRows(ticker, { asOfDate })
}

async function loadFeature(ticker: string, market: MarketCode, asOfDate?: string | null): Promise<FeatureRow | null> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const get = market === 'US' && hasUsAnalyticsDb() ? execUsAnalyticsGet : execGet
  const row = (await get<FeatureRow>(
    `
      SELECT date, feature_json AS featureJson, stage_code AS stageCode
      FROM ml_feature_vectors_v2
      WHERE feature_set = ?
        AND ticker = ?
        ${dateFilter}
      ORDER BY date DESC
      LIMIT 1
    `,
    asOfDate ? [ML_PHYSICS_FEATURE_SET, ticker, asOfDate] : [ML_PHYSICS_FEATURE_SET, ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('US analytics DB not found')) return null
    throw error
  })) ?? null
  return row
}

async function loadMomentum(ticker: string, market: MarketCode, asOfDate?: string | null): Promise<MomentumRow | null> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const useUsAnalytics = market === 'US' && hasUsAnalyticsDb()
  const get = useUsAnalytics ? execUsAnalyticsGet : execGet
  const dbMarkets = useUsAnalytics ? ['US', 'JP'] : [market]
  const placeholders = dbMarkets.map(() => '?').join(', ')
  return (await get<MomentumRow>(
    `
      SELECT
        date,
        physical_momentum_score AS physicalMomentumScore,
        physical_force_score AS physicalForceScore,
        physical_energy_score AS physicalEnergyScore
      FROM physical_momentum_metrics
      WHERE market IN (${placeholders})
        AND symbol = ?
        ${dateFilter}
      ORDER BY CASE market WHEN ? THEN 0 ELSE 1 END, date DESC
      LIMIT 1
    `,
    asOfDate ? [...dbMarkets, ticker, asOfDate, market] : [...dbMarkets, ticker, market],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('US analytics DB not found')) return null
    throw error
  })) ?? null
}

async function loadCalibration(
  status: PhysicsStatus,
  horizonDays: number,
  asOfDate?: string | null,
  market: MarketCode = 'JP',
): Promise<CalibrationRow | null> {
  const dateFilter = asOfDate ? 'AND evaluation_date <= ?' : ''
  const get = market === 'US' && hasUsAnalyticsDb() ? execUsAnalyticsGet : execGet
  return (await get<CalibrationRow>(
    `
      SELECT
        evaluation_date AS evaluationDate,
        target_direction AS targetDirection,
        sample_count AS sampleCount,
        hit_rate AS hitRate,
        base_rate AS baseRate,
        lift,
        avg_max_return_pct AS avgMaxReturnPct,
        avg_min_return_pct AS avgMinReturnPct,
        adverse_rate AS adverseRate
      FROM ml_physics_status_evaluations
      WHERE feature_set = ?
        AND status_label = ?
        AND horizon_days = ?
        AND sample_count > 0
        ${dateFilter}
      ORDER BY evaluation_date DESC
      LIMIT 1
    `,
    asOfDate ? [ML_PHYSICS_FEATURE_SET, status, horizonDays, asOfDate] : [ML_PHYSICS_FEATURE_SET, status, horizonDays],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('US analytics DB not found')) return null
    throw error
  })) ?? null
}

async function loadPhysicsCandidates(
  ticker: string,
  horizonDays: number,
  asOfDate?: string | null,
  market: MarketCode = 'JP',
): Promise<PhysicsCandidateRow[]> {
  const dateFilter = asOfDate ? 'AND as_of_date <= ?' : ''
  const all = market === 'US' && hasUsAnalyticsDb() ? execUsAnalyticsAll : execAll
  return all<PhysicsCandidateRow>(
    `
      WITH latest AS (
        SELECT MAX(as_of_date) AS as_of_date
        FROM serving_ml_physics_candidates
        WHERE horizon_days = ?
          ${dateFilter}
      )
      SELECT
        c.as_of_date AS asOfDate,
        c.direction,
        c.rank,
        c.candidate_score AS candidateScore
      FROM serving_ml_physics_candidates c
      INNER JOIN latest l ON l.as_of_date = c.as_of_date
      WHERE c.horizon_days = ?
        AND c.ticker = ?
      ORDER BY c.rank
    `,
    asOfDate ? [horizonDays, asOfDate, horizonDays, ticker] : [horizonDays, horizonDays, ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table') || message.includes('US analytics DB not found')) return []
    throw error
  })
}

export function normalizeProjectionInterval(value: string | null | undefined): ScenarioInterval {
  return parseInterval(value) ?? 'D'
}

export function defaultProjectionHorizon(interval: ScenarioInterval): number {
  if (interval === '2D') return 10
  if (interval === 'W') return 20
  if (interval === '2W') return 40
  if (interval === 'M') return 60
  if (interval === '2M') return 120
  return 5
}

export async function buildStockScenarioProjection(params: {
  ticker: string
  market?: MarketCode | string | null
  interval: ScenarioInterval
  horizonDays?: number | null
  limit?: number | null
  asOfDate?: string | null
}): Promise<ProjectionResponse | null> {
  const market = normalizeMarket(params.market)
  const ticker = normalizeTicker(params.ticker, market)
  const interval = params.interval
  const horizonDays = params.horizonDays && Number.isFinite(params.horizonDays)
    ? Math.max(1, Math.min(180, Math.floor(params.horizonDays)))
    : defaultProjectionHorizon(interval)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(params.limit ?? DEFAULT_LIMIT)))
  const asOfDate = params.asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(params.asOfDate) ? params.asOfDate : null
  const [ohlcv, feature, momentum] = await Promise.all([
    loadOhlcv(ticker, market, asOfDate),
    loadFeature(ticker, market, asOfDate),
    loadMomentum(ticker, market, asOfDate),
  ])
  if (ohlcv.length === 0) return null

  const grouped = aggregateOhlcv(ohlcv, interval)
  const visibleBars = visibleBarsForInterval(interval)
  const chartCandles = grouped.slice(-visibleBars)
  const latest = grouped[grouped.length - 1]
  if (!latest || !finite(latest.close)) return null

  const storedProfile = parseJson<Record<string, unknown> | null>(feature?.featureJson, null)
  const derivedProfile = buildLatestChartPhysicsProfile(grouped)
  const usesDerivedProfile = !storedProfile || feature?.date !== latest.date
  const profile = usesDerivedProfile ? (derivedProfile ?? storedProfile) : storedProfile
  const analysis = analyzePhysicsProfile(profile)
  const [calibration, candidates] = await Promise.all([
    loadCalibration(analysis.physicsStatus, horizonDays, asOfDate, market),
    loadPhysicsCandidates(ticker, horizonDays, asOfDate, market),
  ])

  const ma = Object.fromEntries(maPeriodsForInterval(interval).map((period) => [String(period), simpleMa(chartCandles, period)]))
  const lookback = lookbackBarsForInterval(interval)
  const stats = {
    atrPct: atrPct(grouped, lookback),
    recentHigh: recentHigh(grouped, lookback),
    recentLow: recentLow(grouped, lookback),
    ma5: latestMa(grouped, 5),
    ma25: latestMa(grouped, 25),
    ma75: latestMa(grouped, 75),
    ma200: latestMa(grouped, 200),
  }
  const scenarios = buildScenarios({
    market,
    interval,
    horizonDays,
    baseDate: latest.date,
    basePrice: latest.close,
    status: analysis.physicsStatus,
    analysis,
    calibration,
    candidates,
    momentum,
    stats,
  }).slice(0, limit)

  return {
    ok: true,
    ticker,
    interval,
    horizonDays,
    featureSet: ML_PHYSICS_FEATURE_SET,
    baseDate: latest.date,
    basePrice: latest.close,
    statusLabel: analysis.physicsStatus,
    sourceDates: {
      price: latest.date,
      feature: usesDerivedProfile && derivedProfile ? latest.date : feature?.date ?? null,
      featureDerived: usesDerivedProfile && !!derivedProfile,
      physicalMomentum: momentum?.date ?? null,
      calibration: calibration?.evaluationDate ?? null,
      physicsCandidates: candidates[0]?.asOfDate ?? null,
    },
    chart: {
      candles: chartCandles,
      ma,
    },
    stats: {
      recentHigh: round(stats.recentHigh, 1),
      recentLow: round(stats.recentLow, 1),
      atrPct: round(stats.atrPct, 2),
      ma5: round(stats.ma5, 1),
      ma25: round(stats.ma25, 1),
      ma75: round(stats.ma75, 1),
      ma200: round(stats.ma200, 1),
      pms: round(momentum?.physicalMomentumScore, 2),
      pfs: round(momentum?.physicalForceScore, 2),
      pes: round(momentum?.physicalEnergyScore, 2),
      hitRate: calibration?.hitRate ?? null,
      baseRate: calibration?.baseRate ?? null,
      lift: calibration?.lift ?? null,
      avgMaxReturnPct: calibration?.avgMaxReturnPct ?? null,
      avgMinReturnPct: calibration?.avgMinReturnPct ?? null,
    },
    scenarios,
    note: 'これは過去データ、物理モメンタム、MA状態、ML候補をもとにした複数シナリオの可視化であり、将来価格を断定するものではありません。',
  }
}

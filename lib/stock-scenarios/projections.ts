import { execAll, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { analyzePhysicsProfile, type PhysicsAnalysis, type PhysicsStatus } from '@/lib/ml/physics-analysis'
import type { OHLCV } from '@/types/stock'

export type ScenarioInterval = 'D' | 'W' | 'M'
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
const MA_PERIODS = [5, 25, 75, 200] as const

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase().replace(/\.T$/i, '')
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
  if (interval === 'D') return rows
  const grouped: OHLCV[] = []
  let currentKey: string | null = null
  let current: OHLCV | null = null
  for (const row of rows) {
    const key = interval === 'W' ? weekKey(row.date) : row.date.slice(0, 7)
    if (key !== currentKey) {
      if (current) grouped.push(current)
      currentKey = key
      current = { ...row }
    } else if (current) {
      current.high = Math.max(current.high, row.high)
      current.low = Math.min(current.low, row.low)
      current.close = row.close
      current.volume += row.volume
      current.date = row.date
    }
  }
  if (current) grouped.push(current)
  return grouped
}

function weekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`
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
  if (interval === 'D') {
    let added = 0
    while (added < step) {
      d.setUTCDate(d.getUTCDate() + 1)
      const day = d.getUTCDay()
      if (day !== 0 && day !== 6) added += 1
    }
  } else if (interval === 'W') {
    d.setUTCDate(d.getUTCDate() + 7 * step)
  } else {
    d.setUTCMonth(d.getUTCMonth() + step)
  }
  return d.toISOString().slice(0, 10)
}

function futurePointCount(interval: ScenarioInterval, horizonDays: number): number {
  if (interval === 'D') return Math.max(2, Math.min(8, horizonDays))
  if (interval === 'W') return Math.max(2, Math.min(8, Math.ceil(horizonDays / 5)))
  return Math.max(2, Math.min(8, Math.ceil(horizonDays / 20)))
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

function localNarrative(scenario: ProjectionScenario): string {
  const directionText = scenario.direction === 'up' ? '上方向' : scenario.direction === 'down' ? '下方向' : '横ばい'
  const targetText = finite(scenario.targetPrice) ? `目処は${scenario.targetPrice?.toLocaleString('ja-JP')}円付近` : '目処は未判定'
  const evidence = scenario.evidence.slice(0, 3).join('、')
  return `${directionText}のシナリオです。${targetText}。根拠は${evidence || '現在形状とMA位置'}です。失効条件は「${scenario.invalidation}」。`
}

function buildScenarios(input: {
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
  const { interval, horizonDays, baseDate, basePrice, status, analysis, calibration, candidates, momentum, stats } = input
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
      parts.push({
        key: 'scenario_shape',
        label: '形状補正',
        value: round(adjustment, 1) ?? adjustment,
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
      reboundLine: `${round(rangeDown, 1)}〜${round(rangeUp, 1)}円`,
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
    .map((scenario) => ({ ...scenario, narrative: localNarrative(scenario) }))
    .sort((a, b) => b.score - a.score)
  const scoreTotal = sorted.reduce((sum, scenario) => sum + Math.max(1, scenario.score), 0)
  return sorted
    .map((scenario, index) => ({
      ...scenario,
      probabilityRank: index + 1,
      relativeWeightPct: round((Math.max(1, scenario.score) / scoreTotal) * 100, 1) ?? 0,
    }))
}

async function loadOhlcv(ticker: string): Promise<OHLCV[]> {
  const rows = await execAll<RawOhlcvRow>(
    `
      SELECT date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
      ORDER BY date
    `,
    [ticker],
  )
  return rows.map(toOhlcv)
}

async function loadFeature(ticker: string): Promise<FeatureRow | null> {
  return (await execGet<FeatureRow>(
    `
      SELECT date, feature_json AS featureJson, stage_code AS stageCode
      FROM ml_feature_vectors_v2
      WHERE feature_set = ?
        AND ticker = ?
      ORDER BY date DESC
      LIMIT 1
    `,
    [ML_PHYSICS_FEATURE_SET, ticker],
  )) ?? null
}

async function loadMomentum(ticker: string): Promise<MomentumRow | null> {
  return (await execGet<MomentumRow>(
    `
      SELECT
        date,
        physical_momentum_score AS physicalMomentumScore,
        physical_force_score AS physicalForceScore,
        physical_energy_score AS physicalEnergyScore
      FROM physical_momentum_metrics
      WHERE market = 'JP'
        AND symbol = ?
      ORDER BY date DESC
      LIMIT 1
    `,
    [ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return null
    throw error
  })) ?? null
}

async function loadCalibration(status: PhysicsStatus, horizonDays: number): Promise<CalibrationRow | null> {
  return (await execGet<CalibrationRow>(
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
      ORDER BY evaluation_date DESC
      LIMIT 1
    `,
    [ML_PHYSICS_FEATURE_SET, status, horizonDays],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return null
    throw error
  })) ?? null
}

async function loadPhysicsCandidates(ticker: string, horizonDays: number): Promise<PhysicsCandidateRow[]> {
  return execAll<PhysicsCandidateRow>(
    `
      WITH latest AS (
        SELECT MAX(as_of_date) AS as_of_date
        FROM serving_ml_physics_candidates
        WHERE horizon_days = ?
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
    [horizonDays, horizonDays, ticker],
  ).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return []
    throw error
  })
}

export function normalizeProjectionInterval(value: string | null | undefined): ScenarioInterval {
  return value === 'W' || value === 'M' ? value : 'D'
}

export function defaultProjectionHorizon(interval: ScenarioInterval): number {
  if (interval === 'W') return 20
  if (interval === 'M') return 60
  return 5
}

export async function buildStockScenarioProjection(params: {
  ticker: string
  interval: ScenarioInterval
  horizonDays?: number | null
  limit?: number | null
}): Promise<ProjectionResponse | null> {
  const ticker = normalizeTicker(params.ticker)
  const interval = params.interval
  const horizonDays = params.horizonDays && Number.isFinite(params.horizonDays)
    ? Math.max(1, Math.min(180, Math.floor(params.horizonDays)))
    : defaultProjectionHorizon(interval)
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(params.limit ?? DEFAULT_LIMIT)))
  const [ohlcv, feature, momentum] = await Promise.all([
    loadOhlcv(ticker),
    loadFeature(ticker),
    loadMomentum(ticker),
  ])
  if (ohlcv.length === 0) return null

  const grouped = aggregateOhlcv(ohlcv, interval)
  const visibleBars = interval === 'D' ? 180 : interval === 'W' ? 156 : 120
  const chartCandles = grouped.slice(-visibleBars)
  const latest = grouped[grouped.length - 1]
  if (!latest || !finite(latest.close)) return null

  const profile = parseJson<Record<string, unknown> | null>(feature?.featureJson, null)
  const analysis = analyzePhysicsProfile(profile)
  const [calibration, candidates] = await Promise.all([
    loadCalibration(analysis.physicsStatus, horizonDays),
    loadPhysicsCandidates(ticker, horizonDays),
  ])

  const ma = Object.fromEntries(MA_PERIODS.map((period) => [String(period), simpleMa(chartCandles, period)]))
  const stats = {
    atrPct: atrPct(grouped, interval === 'D' ? 20 : 12),
    recentHigh: recentHigh(grouped, interval === 'D' ? 20 : 12),
    recentLow: recentLow(grouped, interval === 'D' ? 20 : 12),
    ma5: latestMa(grouped, 5),
    ma25: latestMa(grouped, 25),
    ma75: latestMa(grouped, 75),
    ma200: latestMa(grouped, 200),
  }
  const scenarios = buildScenarios({
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
      feature: feature?.date ?? null,
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

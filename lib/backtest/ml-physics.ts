import { ML_PRIMARY_HORIZONS } from '@/lib/backtest/ml-horizons'

export const ML_PHYSICS_FEATURE_SET_V2 = 'ma_physics_v2'
export const ML_PHYSICS_FEATURE_SET_V3 = 'ma_physics_v3'
export const ML_PHYSICS_FEATURE_SET_V4 = 'ma_physics_v4'

const configuredPhysicsFeatureSet = process.env.ML_PHYSICS_FEATURE_SET?.trim()

export const ML_PHYSICS_FEATURE_SET =
  configuredPhysicsFeatureSet === ML_PHYSICS_FEATURE_SET_V2
    ? ML_PHYSICS_FEATURE_SET_V2
    : configuredPhysicsFeatureSet === ML_PHYSICS_FEATURE_SET_V3
      ? ML_PHYSICS_FEATURE_SET_V3
      : configuredPhysicsFeatureSet === ML_PHYSICS_FEATURE_SET_V4
        ? ML_PHYSICS_FEATURE_SET_V4
        : ML_PHYSICS_FEATURE_SET_V4
export const ML_PHYSICS_VERSION = ML_PHYSICS_FEATURE_SET === ML_PHYSICS_FEATURE_SET_V4
  ? 4
  : ML_PHYSICS_FEATURE_SET === ML_PHYSICS_FEATURE_SET_V3
    ? 3
    : 2
export const ML_PHYSICS_MODEL_TYPE =
  ML_PHYSICS_VERSION >= 4 ? 'logistic_regression_physics_v4'
    : ML_PHYSICS_VERSION >= 3 ? 'logistic_regression_physics_v3'
      : 'logistic_regression_physics_v2'
export const ML_PHYSICS_DEFAULT_HORIZONS = ML_PRIMARY_HORIZONS
export const ML_PHYSICS_DEFAULT_HORIZON_LIST = ML_PHYSICS_DEFAULT_HORIZONS.join(',')

export const ML_PHYSICS_BASE_FEATURE_NAMES = [
  'stageDailyA',
  'stageDailyB',
  'stageWeeklyA',
  'stageWeeklyB',
  'stageMonthlyA',
  'stageMonthlyB',
  'stageTrend',
  'maOrderBullish',
  'maOrderBearish',
  'sma5Velocity1',
  'sma5Velocity3',
  'sma5Velocity5',
  'sma5Velocity10',
  'sma25Velocity1',
  'sma25Velocity3',
  'sma25Velocity5',
  'sma25Velocity10',
  'sma75Velocity5',
  'sma75Velocity10',
  'sma200Velocity10',
  'sma5Acceleration5',
  'sma25Acceleration5',
  'sma75Acceleration5',
  'sma5Acceleration10',
  'sma25Acceleration10',
  'gap5To25',
  'gap25To75',
  'gap75To200',
  'gap5To25Velocity5',
  'gap25To75Velocity5',
  'gap75To200Velocity5',
  'gap5To25Acceleration5',
  'gap25To75Acceleration5',
  'priceToSma5',
  'priceToSma25',
  'priceToSma75',
  'priceToSma200',
  'priceVelocity1',
  'priceVelocity3',
  'priceVelocity5',
  'priceVelocity10',
  'priceAcceleration3',
  'priceAcceleration5',
  'bundleWidthPct',
  'bundleWidthVelocity5',
  'bundleWidthVelocity10',
  'daysAboveSma5',
  'daysAboveSma25',
  'crossUpSma5',
  'crossDownSma5',
  'touchSma5',
  'touchSma25',
  'distanceToRecentHigh',
  'distanceToRecentLow',
  'brokeRecentHigh',
  'brokeRecentLow',
  'marketReturn5',
  'marketReturn20',
  'marketAboveSma25Rate',
  'sector17Return5',
  'sector17RankPct',
  'sector33Return5',
  'sector33RankPct',
  'stageCodeAge',
  'dailyAStageAge',
  'dailyBStageAge',
  'daysSinceCrossUpSma5',
  'daysSinceTouchSma25',
  'upAccelerationRegime',
  'downAccelerationRegime',
  'compressionRegime',
  'expansionRegime',
] as const

export const ML_PHYSICS_V3_FEATURE_NAMES = [
  'weeklyOrderBullish',
  'weeklyOrderBearish',
  'monthlyOrderBullish',
  'monthlyOrderBearish',
  'weeklyMa5Velocity5',
  'weeklyMa13Velocity5',
  'weeklyMa25Velocity10',
  'weeklyMa5Acceleration5',
  'weeklyGap5To13',
  'weeklyGap13To25',
  'weeklyGap25To50',
  'weeklyGap5To13Velocity5',
  'weeklyBundleWidthPct',
  'weeklyPriceToMa5',
  'weeklyPriceToMa13',
  'monthlyMa3Velocity21',
  'monthlyMa5Velocity21',
  'monthlyMa10Velocity21',
  'monthlyMa3Acceleration21',
  'monthlyGap3To5',
  'monthlyGap5To10',
  'monthlyGap10To20',
  'monthlyGap3To5Velocity21',
  'monthlyBundleWidthPct',
  'monthlyPriceToMa3',
  'monthlyPriceToMa5',
  'dailyWeeklyBullishAlignment',
  'dailyWeeklyBearishAlignment',
  'weeklyMonthlyBullishAlignment',
  'weeklyMonthlyBearishAlignment',
  'upperTimeframeSupport',
  'upperTimeframeResistance',
] as const

export const ML_PHYSICS_V4_FEATURE_NAMES = [
  'twoDayOrderBullish',
  'twoDayOrderBearish',
  'twoWeekOrderBullish',
  'twoWeekOrderBearish',
  'twoMonthOrderBullish',
  'twoMonthOrderBearish',
  'twoDayMa5Velocity5',
  'twoDayMa25Velocity5',
  'twoDayMa5Acceleration5',
  'twoDayGap5To25',
  'twoDayGap5To25Velocity5',
  'twoDayBundleWidthPct',
  'twoDayPriceToMa5',
  'twoWeekMa5Velocity5',
  'twoWeekMa13Velocity5',
  'twoWeekMa5Acceleration5',
  'twoWeekGap5To13',
  'twoWeekGap5To13Velocity5',
  'twoWeekBundleWidthPct',
  'twoWeekPriceToMa5',
  'twoMonthMa3Velocity21',
  'twoMonthMa5Velocity21',
  'twoMonthMa3Acceleration21',
  'twoMonthGap3To5',
  'twoMonthGap3To5Velocity21',
  'twoMonthBundleWidthPct',
  'twoMonthPriceToMa3',
] as const

export const ML_PHYSICS_FEATURE_NAMES: readonly string[] =
  ML_PHYSICS_VERSION >= 4
    ? [...ML_PHYSICS_BASE_FEATURE_NAMES, ...ML_PHYSICS_V3_FEATURE_NAMES, ...ML_PHYSICS_V4_FEATURE_NAMES]
    : ML_PHYSICS_VERSION >= 3
      ? [...ML_PHYSICS_BASE_FEATURE_NAMES, ...ML_PHYSICS_V3_FEATURE_NAMES]
      : ML_PHYSICS_BASE_FEATURE_NAMES

export type PhysicsDirection = 'up' | 'down' | 'wait'
export type PhysicsMaKey = 'sma5' | 'sma25' | 'sma75' | 'sma200'
export type PhysicsUpperMaKey = 'ma5' | 'ma13' | 'ma25' | 'ma50' | 'ma100' | 'ma3' | 'ma10' | 'ma20'

export type PhysicsUpperTimeframeProfile = {
  maOrder: string
  ma: Record<string, number | null>
  velocities: Record<string, { d5: number | null; d10: number | null; d21: number | null }>
  accelerations: Record<string, { d5: number | null; d21: number | null }>
  gaps: Record<string, number | null>
  gapVelocity: Record<string, { d5: number | null; d21: number | null }>
  pricePosition: Record<string, number | null>
  bundleWidthPct: number | null
}

export type PhysicsFeatureProfile = {
  ticker: string
  date: string
  close: number | null
  high: number | null
  low: number | null
  stageCode: string
  prevStageCode: string | null
  maOrder: string
  sma: Record<PhysicsMaKey, number | null>
  velocities: Record<PhysicsMaKey, { d1: number | null; d3: number | null; d5: number | null; d10: number | null }>
  accelerations: Record<PhysicsMaKey, { d5: number | null; d10: number | null }>
  gaps: {
    sma5To25Pct: number | null
    sma25To75Pct: number | null
    sma75To200Pct: number | null
  }
  gapVelocity: {
    sma5To25D5: number | null
    sma25To75D5: number | null
    sma75To200D5: number | null
    sma5To25D10: number | null
    sma25To75D10: number | null
    sma75To200D10: number | null
  }
  gapAcceleration: {
    sma5To25D5: number | null
    sma25To75D5: number | null
  }
  pricePosition: Record<PhysicsMaKey, number | null>
  priceVelocity: { d1: number | null; d3: number | null; d5: number | null; d10: number | null }
  priceAcceleration: { d3: number | null; d5: number | null }
  bundleWidthPct: number | null
  bundleWidthVelocity5: number | null
  bundleWidthVelocity10: number | null
  daysAboveSma5: number | null
  daysAboveSma25: number | null
  crosses: {
    upSma5: boolean
    downSma5: boolean
    upSma25: boolean
    downSma25: boolean
  }
  touches: {
    sma5: boolean
    sma25: boolean
    sma75: boolean
    sma200: boolean
  }
  recentHighDate: string | null
  recentHigh: number | null
  distanceToRecentHighPct: number | null
  recentLowDate: string | null
  recentLow: number | null
  distanceToRecentLowPct: number | null
  brokeRecentHigh: boolean
  brokeRecentLow: boolean
  context?: {
    marketReturn5: number | null
    marketReturn20: number | null
    marketAboveSma25Rate: number | null
    sector17Return5: number | null
    sector17RankPct: number | null
    sector33Return5: number | null
    sector33RankPct: number | null
  }
  timeSince?: {
    stageCodeAge: number | null
    dailyAStageAge: number | null
    dailyBStageAge: number | null
    daysSinceCrossUpSma5: number | null
    daysSinceTouchSma25: number | null
  }
  multiTimeframe?: {
    weekly: PhysicsUpperTimeframeProfile
    monthly: PhysicsUpperTimeframeProfile
    twoDay?: PhysicsUpperTimeframeProfile
    twoWeek?: PhysicsUpperTimeframeProfile
    twoMonth?: PhysicsUpperTimeframeProfile
    alignment: {
      dailyWeeklyBullish: number
      dailyWeeklyBearish: number
      weeklyMonthlyBullish: number
      weeklyMonthlyBearish: number
      upperSupport: number
      upperResistance: number
    }
  }
  regimes: {
    trend: 'up_acceleration' | 'up_deceleration' | 'down_acceleration' | 'down_deceleration' | 'sideways'
    spread: 'compression' | 'up_expansion' | 'down_expansion' | 'neutral'
    turn: 'bullish_turn' | 'bearish_turn' | 'rebound_watch' | 'breakdown_watch' | 'none'
  }
}

export type PhysicsCandidateReason = {
  maOrder: string
  velocity: string
  acceleration: string
  distance: string
  pricePosition: string
  regime: string
  context: string
  timing: string
  risk: string
}

export type PhysicsCandidateExplanation = {
  summary: string
  mesh: PhysicsCandidateReason
  watchPoints: string[]
  riskNotes: string[]
  confidenceLabel: string
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function clip(value: number | null | undefined, scale: number): number {
  if (!finite(value) || scale === 0) return 0
  return Math.max(-1, Math.min(1, value / scale))
}

function stageNum(code: string, index: number): number {
  const value = Number(code[index])
  return Number.isFinite(value) ? value : 0
}

function stageTrendScore(stageCode: string, prevStageCode: string | null): number {
  if (!prevStageCode || prevStageCode.length < 6 || stageCode.length < 6) return 0
  let score = 0
  for (let i = 0; i < 6; i += 1) {
    const current = stageNum(stageCode, i)
    const prev = stageNum(prevStageCode, i)
    if (!current || !prev) continue
    if (current < prev) score += 1
    if (current > prev) score -= 1
  }
  return score / 6
}

function maOrderScores(maOrder: string): { bullish: number; bearish: number } {
  const normalized = maOrder.replace(/\s/g, '')
  return {
    bullish: normalized === '5日>25日>75日>200日' ? 1 : normalized.startsWith('5日>25日') ? 0.6 : 0,
    bearish: normalized === '200日>75日>25日>5日' ? 1 : normalized.startsWith('200日>75日') || normalized.endsWith('25日>5日') ? 0.6 : 0,
  }
}

function upperOrderScores(
  maOrder: string | null | undefined,
  bullishLabels: string[],
  bearishLabels: string[],
): { bullish: number; bearish: number } {
  const normalized = (maOrder ?? '').replace(/\s/g, '')
  const bullish = bullishLabels.join('>')
  const bearish = bearishLabels.join('>')
  const bearishTail = `${bearishLabels[bearishLabels.length - 2]}>${bearishLabels[bearishLabels.length - 1]}`
  return {
    bullish: normalized === bullish ? 1 : normalized.startsWith(`${bullishLabels[0]}>${bullishLabels[1]}`) ? 0.6 : 0,
    bearish: normalized === bearish ? 1 : normalized.startsWith(`${bearishLabels[0]}>${bearishLabels[1]}`) || normalized.endsWith(bearishTail) ? 0.6 : 0,
  }
}

export function physicsFeatureVector(profile: PhysicsFeatureProfile): number[] {
  const order = maOrderScores(profile.maOrder)
  const base = [
    stageNum(profile.stageCode, 0) / 10,
    stageNum(profile.stageCode, 1) / 10,
    stageNum(profile.stageCode, 2) / 10,
    stageNum(profile.stageCode, 3) / 10,
    stageNum(profile.stageCode, 4) / 10,
    stageNum(profile.stageCode, 5) / 10,
    stageTrendScore(profile.stageCode, profile.prevStageCode),
    order.bullish,
    order.bearish,
    clip(profile.velocities.sma5.d1, 5),
    clip(profile.velocities.sma5.d3, 8),
    clip(profile.velocities.sma5.d5, 12),
    clip(profile.velocities.sma5.d10, 18),
    clip(profile.velocities.sma25.d1, 3),
    clip(profile.velocities.sma25.d3, 5),
    clip(profile.velocities.sma25.d5, 8),
    clip(profile.velocities.sma25.d10, 12),
    clip(profile.velocities.sma75.d5, 6),
    clip(profile.velocities.sma75.d10, 9),
    clip(profile.velocities.sma200.d10, 6),
    clip(profile.accelerations.sma5.d5, 8),
    clip(profile.accelerations.sma25.d5, 5),
    clip(profile.accelerations.sma75.d5, 4),
    clip(profile.accelerations.sma5.d10, 10),
    clip(profile.accelerations.sma25.d10, 7),
    clip(profile.gaps.sma5To25Pct, 15),
    clip(profile.gaps.sma25To75Pct, 15),
    clip(profile.gaps.sma75To200Pct, 20),
    clip(profile.gapVelocity.sma5To25D5, 8),
    clip(profile.gapVelocity.sma25To75D5, 8),
    clip(profile.gapVelocity.sma75To200D5, 8),
    clip(profile.gapAcceleration.sma5To25D5, 6),
    clip(profile.gapAcceleration.sma25To75D5, 6),
    clip(profile.pricePosition.sma5, 12),
    clip(profile.pricePosition.sma25, 18),
    clip(profile.pricePosition.sma75, 25),
    clip(profile.pricePosition.sma200, 35),
    clip(profile.priceVelocity.d1, 8),
    clip(profile.priceVelocity.d3, 12),
    clip(profile.priceVelocity.d5, 18),
    clip(profile.priceVelocity.d10, 25),
    clip(profile.priceAcceleration.d3, 10),
    clip(profile.priceAcceleration.d5, 14),
    clip(profile.bundleWidthPct, 35),
    clip(profile.bundleWidthVelocity5, 12),
    clip(profile.bundleWidthVelocity10, 18),
    Math.max(0, Math.min(1, (profile.daysAboveSma5 ?? 0) / 20)),
    Math.max(0, Math.min(1, (profile.daysAboveSma25 ?? 0) / 40)),
    profile.crosses.upSma5 ? 1 : 0,
    profile.crosses.downSma5 ? 1 : 0,
    profile.touches.sma5 ? 1 : 0,
    profile.touches.sma25 ? 1 : 0,
    clip(profile.distanceToRecentHighPct == null ? null : -profile.distanceToRecentHighPct, 30),
    clip(profile.distanceToRecentLowPct, 30),
    profile.brokeRecentHigh ? 1 : 0,
    profile.brokeRecentLow ? 1 : 0,
    clip(profile.context?.marketReturn5, 8),
    clip(profile.context?.marketReturn20, 12),
    clip(profile.context?.marketAboveSma25Rate == null ? null : profile.context.marketAboveSma25Rate - 50, 50),
    clip(profile.context?.sector17Return5, 10),
    clip(profile.context?.sector17RankPct == null ? null : 50 - profile.context.sector17RankPct, 50),
    clip(profile.context?.sector33Return5, 10),
    clip(profile.context?.sector33RankPct == null ? null : 50 - profile.context.sector33RankPct, 50),
    Math.max(0, Math.min(1, (profile.timeSince?.stageCodeAge ?? 0) / 40)),
    Math.max(0, Math.min(1, (profile.timeSince?.dailyAStageAge ?? 0) / 40)),
    Math.max(0, Math.min(1, (profile.timeSince?.dailyBStageAge ?? 0) / 40)),
    Math.max(0, Math.min(1, (profile.timeSince?.daysSinceCrossUpSma5 ?? 999) / 40)),
    Math.max(0, Math.min(1, (profile.timeSince?.daysSinceTouchSma25 ?? 999) / 40)),
    profile.regimes.trend === 'up_acceleration' ? 1 : 0,
    profile.regimes.trend === 'down_acceleration' ? 1 : 0,
    profile.regimes.spread === 'compression' ? 1 : 0,
    profile.regimes.spread === 'up_expansion' || profile.regimes.spread === 'down_expansion' ? 1 : 0,
  ]
  if (ML_PHYSICS_VERSION < 3) return base

  const weekly = profile.multiTimeframe?.weekly
  const monthly = profile.multiTimeframe?.monthly
  const weeklyOrder = upperOrderScores(weekly?.maOrder, ['5週', '13週', '25週', '50週', '100週'], ['100週', '50週', '25週', '13週', '5週'])
  const monthlyOrder = upperOrderScores(monthly?.maOrder, ['3か月', '5か月', '10か月', '20か月', '25か月'], ['25か月', '20か月', '10か月', '5か月', '3か月'])
  const v3 = [
    ...base,
    weeklyOrder.bullish,
    weeklyOrder.bearish,
    monthlyOrder.bullish,
    monthlyOrder.bearish,
    clip(weekly?.velocities.ma5?.d5, 10),
    clip(weekly?.velocities.ma13?.d5, 8),
    clip(weekly?.velocities.ma25?.d10, 8),
    clip(weekly?.accelerations.ma5?.d5, 7),
    clip(weekly?.gaps.ma5To13Pct, 18),
    clip(weekly?.gaps.ma13To25Pct, 18),
    clip(weekly?.gaps.ma25To50Pct, 22),
    clip(weekly?.gapVelocity.ma5To13?.d5, 8),
    clip(weekly?.bundleWidthPct, 35),
    clip(weekly?.pricePosition.ma5, 18),
    clip(weekly?.pricePosition.ma13, 22),
    clip(monthly?.velocities.ma3?.d21, 12),
    clip(monthly?.velocities.ma5?.d21, 10),
    clip(monthly?.velocities.ma10?.d21, 8),
    clip(monthly?.accelerations.ma3?.d21, 8),
    clip(monthly?.gaps.ma3To5Pct, 18),
    clip(monthly?.gaps.ma5To10Pct, 18),
    clip(monthly?.gaps.ma10To20Pct, 22),
    clip(monthly?.gapVelocity.ma3To5?.d21, 8),
    clip(monthly?.bundleWidthPct, 40),
    clip(monthly?.pricePosition.ma3, 22),
    clip(monthly?.pricePosition.ma5, 28),
    profile.multiTimeframe?.alignment.dailyWeeklyBullish ?? 0,
    profile.multiTimeframe?.alignment.dailyWeeklyBearish ?? 0,
    profile.multiTimeframe?.alignment.weeklyMonthlyBullish ?? 0,
    profile.multiTimeframe?.alignment.weeklyMonthlyBearish ?? 0,
    profile.multiTimeframe?.alignment.upperSupport ?? 0,
    profile.multiTimeframe?.alignment.upperResistance ?? 0,
  ]
  if (ML_PHYSICS_VERSION < 4) return v3

  const twoDay = profile.multiTimeframe?.twoDay
  const twoWeek = profile.multiTimeframe?.twoWeek
  const twoMonth = profile.multiTimeframe?.twoMonth
  const twoDayOrder = upperOrderScores(twoDay?.maOrder, ['5本', '25本', '75本', '200本'], ['200本', '75本', '25本', '5本'])
  const twoWeekOrder = upperOrderScores(twoWeek?.maOrder, ['5本', '13本', '25本', '50本', '100本'], ['100本', '50本', '25本', '13本', '5本'])
  const twoMonthOrder = upperOrderScores(twoMonth?.maOrder, ['3本', '5本', '10本', '20本', '25本'], ['25本', '20本', '10本', '5本', '3本'])
  return [
    ...v3,
    twoDayOrder.bullish,
    twoDayOrder.bearish,
    twoWeekOrder.bullish,
    twoWeekOrder.bearish,
    twoMonthOrder.bullish,
    twoMonthOrder.bearish,
    clip(twoDay?.velocities.ma5?.d5, 10),
    clip(twoDay?.velocities.ma25?.d5, 8),
    clip(twoDay?.accelerations.ma5?.d5, 7),
    clip(twoDay?.gaps.ma5To25Pct, 18),
    clip(twoDay?.gapVelocity.ma5To25?.d5, 8),
    clip(twoDay?.bundleWidthPct, 35),
    clip(twoDay?.pricePosition.ma5, 18),
    clip(twoWeek?.velocities.ma5?.d5, 10),
    clip(twoWeek?.velocities.ma13?.d5, 8),
    clip(twoWeek?.accelerations.ma5?.d5, 7),
    clip(twoWeek?.gaps.ma5To13Pct, 18),
    clip(twoWeek?.gapVelocity.ma5To13?.d5, 8),
    clip(twoWeek?.bundleWidthPct, 35),
    clip(twoWeek?.pricePosition.ma5, 18),
    clip(twoMonth?.velocities.ma3?.d21, 12),
    clip(twoMonth?.velocities.ma5?.d21, 10),
    clip(twoMonth?.accelerations.ma3?.d21, 8),
    clip(twoMonth?.gaps.ma3To5Pct, 18),
    clip(twoMonth?.gapVelocity.ma3To5?.d21, 8),
    clip(twoMonth?.bundleWidthPct, 40),
    clip(twoMonth?.pricePosition.ma3, 22),
  ]
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function physicsConfidenceLabel(score: number): string {
  if (score >= 0.8) return '強め'
  if (score >= 0.65) return '中立上位'
  if (score >= 0.5) return '要確認'
  return '弱め'
}

export function buildPhysicsExplanation(
  profile: PhysicsFeatureProfile,
  direction: PhysicsDirection,
  score: number,
  horizonDays: number,
): PhysicsCandidateExplanation {
  const directionText = direction === 'up' ? '上昇候補' : direction === 'down' ? '下落候補' : '見送り候補'
  const weekly = profile.multiTimeframe?.weekly
  const monthly = profile.multiTimeframe?.monthly
  const upperSupport = profile.multiTimeframe?.alignment.upperSupport ?? 0
  const upperResistance = profile.multiTimeframe?.alignment.upperResistance ?? 0
  const upperText = weekly || monthly
    ? `週足は ${weekly?.maOrder || '-'}、月足は ${monthly?.maOrder || '-'}、上位足支援${upperSupport.toFixed(2)} / 抵抗${upperResistance.toFixed(2)}です。`
    : '上位足MAの詳細特徴量は未生成です。'
  const mesh: PhysicsCandidateReason = {
    maOrder: `SMA並びは ${profile.maOrder || '-'} です。`,
    velocity: `5日SMA速度は1日${fmtPct(profile.velocities.sma5.d1)}、5日${fmtPct(profile.velocities.sma5.d5)}、25日SMA速度は5日${fmtPct(profile.velocities.sma25.d5)}です。`,
    acceleration: `5日SMA加速度は${fmtPct(profile.accelerations.sma5.d5)}、25日SMA加速度は${fmtPct(profile.accelerations.sma25.d5)}です。`,
    distance: `5-25距離は${fmtPct(profile.gaps.sma5To25Pct)}、距離変化は5日${fmtPct(profile.gapVelocity.sma5To25D5)}です。`,
    pricePosition: `終値は5日SMA比${fmtPct(profile.pricePosition.sma5)}、25日SMA比${fmtPct(profile.pricePosition.sma25)}です。`,
    regime: `流れは ${profile.regimes.trend} / 距離状態は ${profile.regimes.spread} / 転換兆候は ${profile.regimes.turn} です。`,
    context: `市場5日騰落は${fmtPct(profile.context?.marketReturn5)}、17業種5日騰落は${fmtPct(profile.context?.sector17Return5)}、業種内順位は${fmtPct(profile.context?.sector17RankPct)}です。${upperText}`,
    timing: `6桁ステージ継続は${profile.timeSince?.stageCodeAge ?? '-'}営業日、5日SMA上抜けから${profile.timeSince?.daysSinceCrossUpSma5 ?? '-'}営業日です。`,
    risk: `損切り確認点は、5日SMA速度の失速、25日SMAの下向き転換、5-25距離の急縮小です。`,
  }
  const summary =
    direction === 'up'
      ? `${horizonDays}営業日目線で、SMA速度・加速度・距離の広がりが上方向に寄っている銘柄です。`
      : direction === 'down'
        ? `${horizonDays}営業日目線で、SMAの下向き変化や戻り失敗を警戒する銘柄です。`
        : `${horizonDays}営業日目線では、方向感よりも逆行リスクや横ばい化を優先して確認する銘柄です。`

  return {
    summary,
    mesh,
    watchPoints: [
      direction === 'up'
        ? '5日SMAと25日SMAの速度が同時に落ちないかを確認します。'
        : direction === 'down'
          ? '5日SMAを回復し、25日SMAの下向きが止まる場合は下落前提を弱めます。'
          : '5日SMAと25日SMAの距離がどちらへ拡大するかを確認します。',
      'SMA間距離の拡大が加速するか、逆に収縮へ転じるかを確認します。',
      '6桁ステージが次の更新で同じ方向に動くかを確認します。',
    ],
    riskNotes: [
      '短期モデルは1〜2週間の形状判断に寄せており、決算・材料・指数急変は別途確認が必要です。',
      direction === 'wait'
        ? '見送り候補は売買禁止ではなく、条件が成立するまで判断を遅らせる分類です。'
        : '候補は売買指示ではなく、過去データ上で近い形状の抽出です。',
    ],
    confidenceLabel: physicsConfidenceLabel(score),
  }
}

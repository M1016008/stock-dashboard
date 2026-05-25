export const ML_PHYSICS_FEATURE_SET = 'ma_physics_v2'
export const ML_PHYSICS_VERSION = 1

export const ML_PHYSICS_FEATURE_NAMES = [
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
  'upAccelerationRegime',
  'downAccelerationRegime',
  'compressionRegime',
  'expansionRegime',
] as const

export type PhysicsDirection = 'up' | 'down' | 'wait'
export type PhysicsMaKey = 'sma5' | 'sma25' | 'sma75' | 'sma200'

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

export function physicsFeatureVector(profile: PhysicsFeatureProfile): number[] {
  const order = maOrderScores(profile.maOrder)
  return [
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
    profile.regimes.trend === 'up_acceleration' ? 1 : 0,
    profile.regimes.trend === 'down_acceleration' ? 1 : 0,
    profile.regimes.spread === 'compression' ? 1 : 0,
    profile.regimes.spread === 'up_expansion' || profile.regimes.spread === 'down_expansion' ? 1 : 0,
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
  const mesh: PhysicsCandidateReason = {
    maOrder: `SMA並びは ${profile.maOrder || '-'} です。`,
    velocity: `5日SMA速度は1日${fmtPct(profile.velocities.sma5.d1)}、5日${fmtPct(profile.velocities.sma5.d5)}、25日SMA速度は5日${fmtPct(profile.velocities.sma25.d5)}です。`,
    acceleration: `5日SMA加速度は${fmtPct(profile.accelerations.sma5.d5)}、25日SMA加速度は${fmtPct(profile.accelerations.sma25.d5)}です。`,
    distance: `5-25距離は${fmtPct(profile.gaps.sma5To25Pct)}、距離変化は5日${fmtPct(profile.gapVelocity.sma5To25D5)}です。`,
    pricePosition: `終値は5日SMA比${fmtPct(profile.pricePosition.sma5)}、25日SMA比${fmtPct(profile.pricePosition.sma25)}です。`,
    regime: `流れは ${profile.regimes.trend} / 距離状態は ${profile.regimes.spread} / 転換兆候は ${profile.regimes.turn} です。`,
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


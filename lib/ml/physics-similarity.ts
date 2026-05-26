import type { PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'

export type PhysicsSimilarityComponent = {
  key: string
  label: string
  score: number
  weight: number
}

export type PhysicsSimilarityResult = {
  score: number
  components: PhysicsSimilarityComponent[]
  reason: Record<string, string>
}

type MaybeProfile = Partial<PhysicsFeatureProfile> & Record<string, any>
type ContextProfile = Record<string, number | null | undefined>

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function n(value: unknown): number | null {
  return finite(value) ? value : null
}

function avg(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function closeness(a: unknown, b: unknown, scale: number): number {
  const av = n(a)
  const bv = n(b)
  if (av == null || bv == null || scale <= 0) return 0.5
  return Math.max(0, Math.min(1, 1 - Math.abs(av - bv) / scale))
}

function boolCloseness(a: unknown, b: unknown): number {
  if (typeof a !== 'boolean' || typeof b !== 'boolean') return 0.5
  return a === b ? 1 : 0
}

function pct(value: unknown, digits = 1): string {
  const v = n(value)
  if (v == null) return '-'
  return `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
}

function stageCode(profile: MaybeProfile | null | undefined, fallback?: string | null): string | null {
  return typeof profile?.stageCode === 'string' ? profile.stageCode : fallback ?? null
}

function contextOf(profile: MaybeProfile): ContextProfile {
  return (profile.context ?? {}) as ContextProfile
}

export function stageSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0
  const length = Math.min(6, a.length, b.length)
  if (length === 0) return 0
  let same = 0
  for (let i = 0; i < length; i += 1) {
    if (a[i] === b[i]) same += 1
  }
  return same / 6
}

function maOrderSimilarity(a: MaybeProfile, b: MaybeProfile): number {
  const av = typeof a.maOrder === 'string' ? a.maOrder.replace(/\s/g, '') : ''
  const bv = typeof b.maOrder === 'string' ? b.maOrder.replace(/\s/g, '') : ''
  if (!av || !bv) return 0.5
  if (av === bv) return 1
  const aParts = av.split('>')
  const bParts = bv.split('>')
  const topSame = aParts[0] === bParts[0] ? 0.35 : 0
  const bottomSame = aParts.at(-1) === bParts.at(-1) ? 0.2 : 0
  const pairSame = aParts.slice(0, 3).filter((part, index) => part === bParts[index]).length / 3
  return Math.max(0, Math.min(1, topSame + bottomSame + pairSame * 0.45))
}

function regimeSimilarity(a: MaybeProfile, b: MaybeProfile): number {
  const trend = a.regimes?.trend === b.regimes?.trend ? 1 : 0
  const spread = a.regimes?.spread === b.regimes?.spread ? 1 : 0
  const turn = a.regimes?.turn === b.regimes?.turn ? 1 : 0
  return avg([trend, spread, turn])
}

function contextSimilarity(a: MaybeProfile, b: MaybeProfile): number {
  const ac = contextOf(a)
  const bc = contextOf(b)
  return avg([
    closeness(ac.marketAboveSma25Rate, bc.marketAboveSma25Rate, 35),
    closeness(ac.marketReturn5, bc.marketReturn5, 8),
    closeness(ac.sector17Return5, bc.sector17Return5, 10),
    closeness(ac.sector33Return5, bc.sector33Return5, 10),
    closeness(ac.sector17RankPct, bc.sector17RankPct, 50),
    closeness(ac.sector33RankPct, bc.sector33RankPct, 50),
  ])
}

function profileVelocityScore(a: MaybeProfile, b: MaybeProfile): number {
  return avg([
    closeness(a.velocities?.sma5?.d1, b.velocities?.sma5?.d1, 6),
    closeness(a.velocities?.sma5?.d3, b.velocities?.sma5?.d3, 8),
    closeness(a.velocities?.sma5?.d5, b.velocities?.sma5?.d5, 10),
    closeness(a.velocities?.sma5?.d10, b.velocities?.sma5?.d10, 14),
    closeness(a.velocities?.sma25?.d3, b.velocities?.sma25?.d3, 5),
    closeness(a.velocities?.sma25?.d5, b.velocities?.sma25?.d5, 7),
    closeness(a.velocities?.sma75?.d10, b.velocities?.sma75?.d10, 8),
    closeness(a.velocities?.sma200?.d10, b.velocities?.sma200?.d10, 6),
  ])
}

function profileAccelerationScore(a: MaybeProfile, b: MaybeProfile): number {
  return avg([
    closeness(a.accelerations?.sma5?.d5, b.accelerations?.sma5?.d5, 8),
    closeness(a.accelerations?.sma5?.d10, b.accelerations?.sma5?.d10, 10),
    closeness(a.accelerations?.sma25?.d5, b.accelerations?.sma25?.d5, 5),
    closeness(a.accelerations?.sma25?.d10, b.accelerations?.sma25?.d10, 7),
    closeness(a.accelerations?.sma75?.d5, b.accelerations?.sma75?.d5, 4),
  ])
}

function profileDistanceScore(a: MaybeProfile, b: MaybeProfile): number {
  return avg([
    closeness(a.gaps?.sma5To25Pct, b.gaps?.sma5To25Pct, 10),
    closeness(a.gaps?.sma25To75Pct, b.gaps?.sma25To75Pct, 10),
    closeness(a.gaps?.sma75To200Pct, b.gaps?.sma75To200Pct, 15),
    closeness(a.bundleWidthPct, b.bundleWidthPct, 18),
  ])
}

function profileDistanceFlowScore(a: MaybeProfile, b: MaybeProfile): number {
  return avg([
    closeness(a.gapVelocity?.sma5To25D5, b.gapVelocity?.sma5To25D5, 6),
    closeness(a.gapVelocity?.sma25To75D5, b.gapVelocity?.sma25To75D5, 6),
    closeness(a.gapVelocity?.sma75To200D5, b.gapVelocity?.sma75To200D5, 6),
    closeness(a.gapAcceleration?.sma5To25D5, b.gapAcceleration?.sma5To25D5, 5),
    closeness(a.gapAcceleration?.sma25To75D5, b.gapAcceleration?.sma25To75D5, 5),
    closeness(a.bundleWidthVelocity5, b.bundleWidthVelocity5, 8),
  ])
}

function pricePositionScore(a: MaybeProfile, b: MaybeProfile): number {
  return avg([
    closeness(a.pricePosition?.sma5, b.pricePosition?.sma5, 10),
    closeness(a.pricePosition?.sma25, b.pricePosition?.sma25, 14),
    closeness(a.pricePosition?.sma75, b.pricePosition?.sma75, 18),
    closeness(a.pricePosition?.sma200, b.pricePosition?.sma200, 25),
    closeness(a.distanceToRecentHighPct, b.distanceToRecentHighPct, 25),
    closeness(a.distanceToRecentLowPct, b.distanceToRecentLowPct, 25),
    boolCloseness(a.brokeRecentHigh, b.brokeRecentHigh),
    boolCloseness(a.brokeRecentLow, b.brokeRecentLow),
  ])
}

function component(key: string, label: string, score: number, weight: number): PhysicsSimilarityComponent {
  return { key, label, score: Math.max(0, Math.min(1, score)), weight }
}

function physicsSimilarityComponents(
  base: MaybeProfile,
  similar: MaybeProfile,
  fallbackStageBase?: string | null,
  fallbackStageSimilar?: string | null,
): PhysicsSimilarityComponent[] {
  const baseStage = stageCode(base, fallbackStageBase)
  const similarStage = stageCode(similar, fallbackStageSimilar)
  return [
    component('stage', '6桁ステージ', stageSimilarity(baseStage, similarStage), 0.14),
    component('maOrder', 'SMA並び', maOrderSimilarity(base, similar), 0.08),
    component('velocity', 'SMA速度', profileVelocityScore(base, similar), 0.2),
    component('acceleration', 'SMA加速度', profileAccelerationScore(base, similar), 0.16),
    component('distance', 'SMA間距離', profileDistanceScore(base, similar), 0.14),
    component('distanceFlow', '距離変化', profileDistanceFlowScore(base, similar), 0.12),
    component('pricePosition', '株価位置', pricePositionScore(base, similar), 0.08),
    component('regime', '収束/拡散レジーム', regimeSimilarity(base, similar), 0.04),
    component('context', '地合い/業種', contextSimilarity(base, similar), 0.04),
  ]
}

function weightedScore(components: PhysicsSimilarityComponent[]): number {
  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0)
  return Math.min(0.999, Math.max(0, components.reduce((sum, item) => sum + item.score * item.weight, 0) / totalWeight))
}

export function physicsSimilarityScore(
  base: MaybeProfile,
  similar: MaybeProfile,
  fallbackStageBase?: string | null,
  fallbackStageSimilar?: string | null,
): number {
  return weightedScore(physicsSimilarityComponents(base, similar, fallbackStageBase, fallbackStageSimilar))
}

export function physicsSimilarity(
  base: MaybeProfile,
  similar: MaybeProfile,
  fallbackStageBase?: string | null,
  fallbackStageSimilar?: string | null,
): PhysicsSimilarityResult {
  const baseStage = stageCode(base, fallbackStageBase)
  const similarStage = stageCode(similar, fallbackStageSimilar)
  const components = physicsSimilarityComponents(base, similar, fallbackStageBase, fallbackStageSimilar)
  const score = weightedScore(components)
  return {
    score,
    components,
    reason: explainPhysicsSimilarity(base, similar, score, baseStage, similarStage),
  }
}

export function explainPhysicsSimilarity(
  base: MaybeProfile,
  similar: MaybeProfile,
  score: number,
  baseStage?: string | null,
  similarStage?: string | null,
): Record<string, string> {
  const stageRate = Math.round(stageSimilarity(baseStage, similarStage) * 100)
  const baseContext = contextOf(base)
  const similarContext = contextOf(similar)
  return {
    stage: `6桁ステージは ${baseStage ?? '------'} と ${similarStage ?? '------'} で、6軸の一致度は約${stageRate}%です。`,
    maAngle: `5日SMA速度は基準が1日${pct(base.velocities?.sma5?.d1)}・5日${pct(base.velocities?.sma5?.d5)}、候補が1日${pct(similar.velocities?.sma5?.d1)}・5日${pct(similar.velocities?.sma5?.d5)}です。`,
    maAcceleration: `短期SMAの急変は、5日SMA加速度が基準${pct(base.accelerations?.sma5?.d5)}、候補${pct(similar.accelerations?.sma5?.d5)}です。`,
    maDistance: `5-25距離は基準${pct(base.gaps?.sma5To25Pct)}・候補${pct(similar.gaps?.sma5To25Pct)}、25-75距離は基準${pct(base.gaps?.sma25To75Pct)}・候補${pct(similar.gaps?.sma25To75Pct)}です。`,
    maDistanceFlow: `距離変化は5-25の5日変化が基準${pct(base.gapVelocity?.sma5To25D5)}、候補${pct(similar.gapVelocity?.sma5To25D5)}です。`,
    pricePosition: `株価位置は5日SMA比が基準${pct(base.pricePosition?.sma5)}・候補${pct(similar.pricePosition?.sma5)}、25日SMA比が基準${pct(base.pricePosition?.sma25)}・候補${pct(similar.pricePosition?.sma25)}です。`,
    context: `地合いは市場25日SMA上銘柄比率が基準${pct(baseContext.marketAboveSma25Rate)}・候補${pct(similarContext.marketAboveSma25Rate)}、17業種5日騰落が基準${pct(baseContext.sector17Return5)}・候補${pct(similarContext.sector17Return5)}です。`,
    risk: `類似度はSMA速度・加速度・距離変化・6桁ステージを重視して${Math.round(score * 100)}%です。失敗条件は5日SMA速度の失速、25日SMAの下向き転換、5-25距離の急縮小です。`,
  }
}

export function topSimilarityComponents(result: PhysicsSimilarityResult, limit = 4): PhysicsSimilarityComponent[] {
  return [...result.components]
    .sort((a, b) => (b.score * b.weight) - (a.score * a.weight))
    .slice(0, limit)
}

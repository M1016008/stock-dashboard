import type { PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'

export type PhysicsMomentumState = 'up_acceleration' | 'up_deceleration' | 'down_acceleration' | 'sideways' | 'unknown'
export type PhysicsDistanceState = 'up_expansion' | 'down_expansion' | 'compression' | 'overheated' | 'neutral' | 'unknown'
export type PhysicsStatus =
  | '上昇加速'
  | '上昇継続'
  | '押し目形成'
  | '反発準備'
  | '過熱注意'
  | '失速警戒'
  | '下落加速'
  | '見送り'
  | '算出待ち'
export type PullbackVerdict = '本物の押し目に近い' | '反発は弱い' | '下落途中の一時反発' | '判断待ち'

export type PhysicsAnalysis = {
  momentumState: PhysicsMomentumState
  momentumLabel: string
  distanceState: PhysicsDistanceState
  distanceLabel: string
  physicsStatus: PhysicsStatus
  pullbackVerdict: PullbackVerdict
  summary: string
  watchPoints: string[]
  riskNotes: string[]
  metrics: {
    sma5Velocity5: number | null
    sma25Velocity5: number | null
    sma75Velocity10: number | null
    sma200Velocity10: number | null
    sma5Acceleration5: number | null
    sma25Acceleration5: number | null
    gap5To25Pct: number | null
    gap25To75Pct: number | null
    gap75To200Pct: number | null
    gap5To25Velocity5: number | null
    gap25To75Velocity5: number | null
    priceToSma5: number | null
    priceToSma25: number | null
    distanceToRecentHighPct: number | null
  }
}

type MaybeProfile = Partial<PhysicsFeatureProfile> & Record<string, any>

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function n(value: unknown): number | null {
  return finite(value) ? value : null
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function abs(value: number | null): number {
  return finite(value) ? Math.abs(value) : 0
}

function normalizedOrder(profile: MaybeProfile | null): string {
  return typeof profile?.maOrder === 'string' ? profile.maOrder.replace(/\s/g, '') : ''
}

function metric(profile: MaybeProfile | null): PhysicsAnalysis['metrics'] {
  return {
    sma5Velocity5: n(profile?.velocities?.sma5?.d5),
    sma25Velocity5: n(profile?.velocities?.sma25?.d5),
    sma75Velocity10: n(profile?.velocities?.sma75?.d10),
    sma200Velocity10: n(profile?.velocities?.sma200?.d10),
    sma5Acceleration5: n(profile?.accelerations?.sma5?.d5),
    sma25Acceleration5: n(profile?.accelerations?.sma25?.d5),
    gap5To25Pct: n(profile?.gaps?.sma5To25Pct),
    gap25To75Pct: n(profile?.gaps?.sma25To75Pct),
    gap75To200Pct: n(profile?.gaps?.sma75To200Pct),
    gap5To25Velocity5: n(profile?.gapVelocity?.sma5To25D5),
    gap25To75Velocity5: n(profile?.gapVelocity?.sma25To75D5),
    priceToSma5: n(profile?.pricePosition?.sma5),
    priceToSma25: n(profile?.pricePosition?.sma25),
    distanceToRecentHighPct: n(profile?.distanceToRecentHighPct),
  }
}

function classifyMomentum(m: PhysicsAnalysis['metrics'], fallback?: string | null): PhysicsMomentumState {
  if (!finite(m.sma5Velocity5) && !finite(m.sma25Velocity5)) return 'unknown'
  if ((m.sma5Velocity5 ?? 0) >= 1.2 && (m.sma25Velocity5 ?? 0) >= -0.2 && (m.sma5Acceleration5 ?? 0) >= 0.15) return 'up_acceleration'
  if ((m.sma5Velocity5 ?? 0) > 0.3 && (m.sma5Acceleration5 ?? 0) <= -0.35) return 'up_deceleration'
  if ((m.sma5Velocity5 ?? 0) <= -1.2 && (m.sma25Velocity5 ?? 0) <= 0.2 && (m.sma5Acceleration5 ?? 0) <= -0.15) return 'down_acceleration'
  if (abs(m.sma5Velocity5) <= 0.7 && abs(m.sma25Velocity5) <= 0.4) return 'sideways'
  if (fallback === 'up_acceleration') return 'up_acceleration'
  if (fallback === 'up_deceleration') return 'up_deceleration'
  if (fallback === 'down_acceleration' || fallback === 'down_deceleration') return 'down_acceleration'
  return 'sideways'
}

function momentumLabel(value: PhysicsMomentumState): string {
  const labels: Record<PhysicsMomentumState, string> = {
    up_acceleration: '上向き加速',
    up_deceleration: '上昇鈍化',
    down_acceleration: '下向き加速',
    sideways: '横ばい化',
    unknown: '算出待ち',
  }
  return labels[value]
}

function classifyDistance(m: PhysicsAnalysis['metrics'], fallback?: string | null): PhysicsDistanceState {
  if (!finite(m.gap5To25Pct) && !finite(m.gap25To75Pct)) return 'unknown'
  if ((m.gap5To25Pct ?? 0) >= 11 && (m.gap5To25Velocity5 ?? 0) > 0.4) return 'overheated'
  if ((m.gap5To25Pct ?? 0) > 0 && (m.gap5To25Velocity5 ?? 0) > 0.35 && (m.gap25To75Velocity5 ?? 0) >= -0.5) return 'up_expansion'
  if ((m.gap5To25Pct ?? 0) < 0 && (m.gap5To25Velocity5 ?? 0) < -0.35) return 'down_expansion'
  if (abs(m.gap5To25Velocity5) <= 0.35 && abs(m.gap25To75Velocity5) <= 0.35) return 'compression'
  if (fallback === 'up_expansion' || fallback === 'down_expansion' || fallback === 'compression') return fallback
  return 'neutral'
}

function distanceLabel(value: PhysicsDistanceState): string {
  const labels: Record<PhysicsDistanceState, string> = {
    up_expansion: '上方向へ拡散',
    down_expansion: '下方向へ拡散',
    compression: '収束中',
    overheated: '過熱気味',
    neutral: '中立',
    unknown: '算出待ち',
  }
  return labels[value]
}

function classifyStatus(profile: MaybeProfile | null, m: PhysicsAnalysis['metrics'], momentum: PhysicsMomentumState, distance: PhysicsDistanceState): PhysicsStatus {
  if (!profile) return '算出待ち'
  const order = normalizedOrder(profile)
  const bullishOrder = order.startsWith('5日>25日')
  const bearishOrder = order.startsWith('200日>75日') || order.endsWith('25日>5日')
  const nearSma25 = finite(m.priceToSma25) && Math.abs(m.priceToSma25) <= 5
  const aboveSma25 = (m.priceToSma25 ?? -999) >= -1.5
  const belowSma25 = (m.priceToSma25 ?? 999) <= -2

  if (momentum === 'down_acceleration' && (bearishOrder || belowSma25)) return '下落加速'
  if (distance === 'overheated' && momentum !== 'down_acceleration') return '過熱注意'
  if (momentum === 'up_deceleration' && ((m.gap5To25Velocity5 ?? 0) < -0.4 || !aboveSma25)) return '失速警戒'
  if (momentum === 'up_acceleration' && bullishOrder && aboveSma25) return '上昇加速'
  if ((momentum === 'up_acceleration' || distance === 'up_expansion') && aboveSma25) return '上昇継続'
  if (nearSma25 && (m.sma25Velocity5 ?? 0) >= -0.3 && !bearishOrder) return '押し目形成'
  if ((m.priceToSma5 ?? -999) >= -1.5 && (m.sma5Acceleration5 ?? 0) > 0 && !bearishOrder) return '反発準備'
  return '見送り'
}

function classifyPullback(profile: MaybeProfile | null, m: PhysicsAnalysis['metrics'], status: PhysicsStatus): PullbackVerdict {
  if (!profile) return '判断待ち'
  const order = normalizedOrder(profile)
  const bearishOrder = order.startsWith('200日>75日') || order.endsWith('25日>5日')
  const nearSma25 = finite(m.priceToSma25) && Math.abs(m.priceToSma25) <= 7
  const recovering5 = (m.priceToSma5 ?? -999) >= -2 && (m.sma5Acceleration5 ?? 0) > 0
  const stable25 = (m.sma25Velocity5 ?? 0) >= -0.35
  const weak25 = (m.sma25Velocity5 ?? 0) < -0.6 || (m.priceToSma25 ?? 0) < -6

  if ((status === '押し目形成' || status === '反発準備') && nearSma25 && stable25 && !bearishOrder) return '本物の押し目に近い'
  if (recovering5 && weak25 && bearishOrder) return '下落途中の一時反発'
  if (recovering5 && !stable25) return '反発は弱い'
  return '判断待ち'
}

function buildWatchPoints(status: PhysicsStatus, verdict: PullbackVerdict, m: PhysicsAnalysis['metrics']): string[] {
  const points: string[] = []
  if (status === '上昇加速' || status === '上昇継続') {
    points.push('5日SMAの速度が鈍化せず、25日SMAも上向きを保てるかを確認します。')
    points.push(`直近高値までの距離は${fmtPct(m.distanceToRecentHighPct)}です。高値更新時に5日SMA上を維持できるかを見ます。`)
  } else if (status === '押し目形成' || status === '反発準備') {
    points.push('25日SMAを明確に割り込まず、5日SMAが再び上向きに戻るかを確認します。')
    points.push('5-25距離が再拡大し、6桁ステージが悪化しないかを見ます。')
  } else if (status === '失速警戒' || status === '下落加速') {
    points.push('5日SMAの下向き加速が止まるか、25日SMAを回復できるかを確認します。')
    points.push('戻りが25日SMAで止まる場合は、下落継続の可能性を優先して見ます。')
  } else if (status === '過熱注意') {
    points.push('5-25距離が広がりすぎています。5日SMA割れや距離の急縮小に注意します。')
    points.push('上昇継続を見る場合でも、短期の反落余地を先に確認します。')
  } else {
    points.push('方向感が弱いため、5日SMAと25日SMAのどちら側で終値が安定するかを待ちます。')
  }
  if (verdict === '下落途中の一時反発') points.push('押し目に見えても、25日SMAと75日SMAが下向きのままなら戻り売りとして扱います。')
  return points.slice(0, 3)
}

function buildRiskNotes(status: PhysicsStatus, m: PhysicsAnalysis['metrics']): string[] {
  const notes: string[] = []
  if (status === '過熱注意') notes.push(`5-25距離が${fmtPct(m.gap5To25Pct)}まで広がっており、短期の過熱感があります。`)
  if (status === '失速警戒') notes.push(`5日SMA加速度は${fmtPct(m.sma5Acceleration5)}で、短期の勢い低下を確認しています。`)
  if (status === '下落加速') notes.push('短期線が下向きに加速しており、反発よりも戻り売りに注意します。')
  if (notes.length === 0) notes.push('過去データ上の形状分類であり、売買判断は価格・出来高・地合いと合わせて確認します。')
  return notes
}

export function analyzePhysicsProfile(profile: Partial<PhysicsFeatureProfile> | null | undefined): PhysicsAnalysis {
  const safe: MaybeProfile | null = profile ? (profile as MaybeProfile) : null
  const m = metric(safe)
  const momentumState = classifyMomentum(m, safe?.regimes?.trend)
  const distanceState = classifyDistance(m, safe?.regimes?.spread)
  const physicsStatus = classifyStatus(safe, m, momentumState, distanceState)
  const pullbackVerdict = classifyPullback(safe, m, physicsStatus)
  const summary = `${physicsStatus}。${momentumLabel(momentumState)}で、SMA距離は${distanceLabel(distanceState)}です。押し目判定は「${pullbackVerdict}」として確認します。`
  return {
    momentumState,
    momentumLabel: momentumLabel(momentumState),
    distanceState,
    distanceLabel: distanceLabel(distanceState),
    physicsStatus,
    pullbackVerdict,
    summary,
    watchPoints: buildWatchPoints(physicsStatus, pullbackVerdict, m),
    riskNotes: buildRiskNotes(physicsStatus, m),
    metrics: m,
  }
}

export function physicsStatusTone(status: PhysicsStatus): 'red' | 'blue' | 'amber' | 'neutral' {
  if (status === '上昇加速' || status === '上昇継続' || status === '押し目形成' || status === '反発準備') return 'red'
  if (status === '下落加速' || status === '失速警戒') return 'blue'
  if (status === '過熱注意') return 'amber'
  return 'neutral'
}

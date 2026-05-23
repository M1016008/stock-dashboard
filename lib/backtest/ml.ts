export const ML_FEATURE_NAMES = [
  'stageDailyA',
  'stageDailyB',
  'stageWeeklyA',
  'stageWeeklyB',
  'stageMonthlyA',
  'stageMonthlyB',
  'stageTrend',
  'maOrderBullish',
  'maOrderBearish',
  'sma5Slope5',
  'sma25Slope5',
  'sma75Slope5',
  'sma200Slope5',
  'sma5Slope10',
  'sma25Slope10',
  'sma75Slope10',
  'sma200Slope10',
  'gap5To25',
  'gap25To75',
  'gap75To200',
  'priceToSma5',
  'priceToSma25',
  'priceToSma75',
  'priceToSma200',
  'daysAboveSma5',
  'distanceToRecentHigh',
  'brokeRecentHigh',
] as const

export type MlDirection = 'up' | 'down'

export type MlFeatureProfile = {
  ticker: string
  date: string
  close: number | null
  stageCode: string
  prevStageCode: string | null
  maOrder: string
  sma: Record<'sma5' | 'sma25' | 'sma75' | 'sma200', number | null>
  slopes5: Record<'sma5' | 'sma25' | 'sma75' | 'sma200', number | null>
  slopes10: Record<'sma5' | 'sma25' | 'sma75' | 'sma200', number | null>
  gaps: {
    sma5To25Pct: number | null
    sma25To75Pct: number | null
    sma75To200Pct: number | null
  }
  pricePosition: Record<'sma5' | 'sma25' | 'sma75' | 'sma200', number | null>
  daysHeldAboveSma5: number | null
  recentHighDate: string | null
  recentHigh: number | null
  distanceToRecentHighPct: number | null
  brokeRecentHigh: boolean
}

export type CandidateReason = {
  stage: string
  maAngle: string
  maDistance: string
  pricePosition: string
  mlEvidence: string
}

export type CandidateExplanation = {
  summary: string
  mesh: CandidateReason
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

export function sigmoid(value: number): number {
  if (value >= 35) return 1
  if (value <= -35) return 0
  return 1 / (1 + Math.exp(-value))
}

export function dot(weights: number[], vector: number[]): number {
  const length = Math.min(weights.length, vector.length)
  let sum = 0
  for (let i = 0; i < length; i += 1) sum += weights[i] * vector[i]
  return sum
}

export function stageTrendScore(stageCode: string, prevStageCode: string | null): number {
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

export function maOrderScores(maOrder: string): { bullish: number; bearish: number } {
  const normalized = maOrder.replace(/\s/g, '')
  const bullish = normalized === '5日>25日>75日>200日' ? 1 : normalized.startsWith('5日>25日') ? 0.6 : 0
  const bearish = normalized === '200日>75日>25日>5日' ? 1 : normalized.startsWith('200日>75日') ? 0.6 : 0
  return { bullish, bearish }
}

export function featureVector(profile: MlFeatureProfile): number[] {
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
    clip(profile.slopes5.sma5, 8),
    clip(profile.slopes5.sma25, 5),
    clip(profile.slopes5.sma75, 3),
    clip(profile.slopes5.sma200, 2),
    clip(profile.slopes10.sma5, 12),
    clip(profile.slopes10.sma25, 8),
    clip(profile.slopes10.sma75, 5),
    clip(profile.slopes10.sma200, 3),
    clip(profile.gaps.sma5To25Pct, 12),
    clip(profile.gaps.sma25To75Pct, 12),
    clip(profile.gaps.sma75To200Pct, 12),
    clip(profile.pricePosition.sma5, 12),
    clip(profile.pricePosition.sma25, 18),
    clip(profile.pricePosition.sma75, 25),
    clip(profile.pricePosition.sma200, 35),
    Math.max(0, Math.min(1, (profile.daysHeldAboveSma5 ?? 0) / 20)),
    clip(profile.distanceToRecentHighPct == null ? null : -profile.distanceToRecentHighPct, 30),
    profile.brokeRecentHigh ? 1 : 0,
  ]
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtYen(value: number | null | undefined): string {
  if (!finite(value)) return '-'
  return `${Math.round(value).toLocaleString('ja-JP')}円`
}

function slopeLabel(value: number | null | undefined): string {
  if (!finite(value)) return '不明'
  if (value >= 1.5) return `強く上向き(${fmtPct(value)})`
  if (value >= 0.3) return `上向き(${fmtPct(value)})`
  if (value <= -1.5) return `強く下向き(${fmtPct(value)})`
  if (value <= -0.3) return `下向き(${fmtPct(value)})`
  return `横ばい(${fmtPct(value)})`
}

export function confidenceLabel(score: number): string {
  if (score >= 0.75) return '強め'
  if (score >= 0.6) return '中立上位'
  if (score >= 0.45) return '要確認'
  return '弱め'
}

export function heuristicScore(profile: MlFeatureProfile, direction: MlDirection): number {
  const vector = featureVector(profile)
  const index = Object.fromEntries(ML_FEATURE_NAMES.map((name, i) => [name, i])) as Record<string, number>
  const bullish =
    vector[index.maOrderBullish] * 0.16 +
    vector[index.stageTrend] * 0.1 +
    vector[index.sma5Slope5] * 0.14 +
    vector[index.sma25Slope10] * 0.14 +
    vector[index.gap5To25] * 0.1 +
    vector[index.priceToSma5] * 0.1 +
    vector[index.priceToSma25] * 0.1 +
    vector[index.daysAboveSma5] * 0.08 +
    vector[index.distanceToRecentHigh] * 0.08 +
    vector[index.brokeRecentHigh] * 0.1
  const bearish =
    vector[index.maOrderBearish] * 0.18 -
    vector[index.stageTrend] * 0.1 -
    vector[index.sma5Slope5] * 0.16 -
    vector[index.sma25Slope10] * 0.14 -
    vector[index.gap5To25] * 0.08 -
    vector[index.priceToSma5] * 0.12 -
    vector[index.priceToSma25] * 0.1 +
    Math.max(0, -vector[index.distanceToRecentHigh]) * 0.06
  return sigmoid((direction === 'up' ? bullish : bearish) * 4)
}

export function buildCandidateExplanation(
  profile: MlFeatureProfile,
  direction: MlDirection,
  score: number,
): CandidateExplanation {
  const dirLabel = direction === 'up' ? '上昇候補' : '下落警戒'
  const positive = direction === 'up'
  const mesh: CandidateReason = {
    stage: profile.prevStageCode
      ? `6桁ステージは${profile.prevStageCode}から${profile.stageCode}へ変化しています。`
      : `6桁ステージは${profile.stageCode}です。`,
    maAngle: `5日MAは${slopeLabel(profile.slopes5.sma5)}、25日MAは${slopeLabel(profile.slopes10.sma25)}です。`,
    maDistance: `5日-25日MAの距離は${fmtPct(profile.gaps.sma5To25Pct)}、25日-75日MAの距離は${fmtPct(profile.gaps.sma25To75Pct)}です。`,
    pricePosition: `終値は5日MA比${fmtPct(profile.pricePosition.sma5)}、25日MA比${fmtPct(profile.pricePosition.sma25)}の位置です。`,
    mlEvidence: `過去データで学習した6ステージとMA形状のメッシュでは「${confidenceLabel(score)}」の${dirLabel}として抽出されました。`,
  }

  return {
    summary: positive
      ? `${profile.ticker}は、MAの短期線が中期線に対して優位で、株価が短期MAの上を維持できるかを確認したい形です。`
      : `${profile.ticker}は、MAの傾きや並びが弱く、株価が短期MAを回復できるかを確認したい形です。`,
    mesh,
    watchPoints: [
      profile.recentHigh != null
        ? `直近高値${fmtYen(profile.recentHigh)}までの距離を確認します。`
        : '直近高値までの距離を確認します。',
      positive
        ? '5日MAと25日MAが上向きを保ち、株価が5日MAの上に残れるかを見ます。'
        : '5日MAを回復できない場合、短期の弱さが続く可能性を見ます。',
      '6桁ステージが次の更新で改善するか、悪化するかを確認します。',
    ],
    riskNotes: [
      'ML候補は過去データに基づく抽出であり、将来の値動きを断定するものではありません。',
      positive
        ? '5日MAを明確に下回る場合は候補から外す判断材料になります。'
        : '短期MAを強く回復する場合は下落警戒の前提が弱まります。',
    ],
    confidenceLabel: confidenceLabel(score),
  }
}

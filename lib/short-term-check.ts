export type ShortTermCheckLabel = '強気優勢' | '好転候補' | '中立' | '弱含み注意' | '下落警戒'

export type ShortTermCheckTone = 'bullish' | 'positive' | 'neutral' | 'weak' | 'bearish'

export const SHORT_TERM_CHECK_LABELS: ShortTermCheckLabel[] = [
  '強気優勢',
  '好転候補',
  '中立',
  '弱含み注意',
  '下落警戒',
]

export interface ShortTermCheckStageInput {
  dailyA: number | null | undefined
  dailyB: number | null | undefined
  weeklyA: number | null | undefined
  weeklyB: number | null | undefined
  monthlyA: number | null | undefined
  monthlyB: number | null | undefined
}

export interface ShortTermCheckInput {
  stages: ShortTermCheckStageInput | null
  physicalMomentumScore?: number | null
  physicalForceScore?: number | null
  changePercent?: number | null
  mlUpCount?: number | null
  mlDownCount?: number | null
  mlSimilarCount?: number | null
  mlTopSimilarity?: number | null
  physicsStatus?: string | null
}

export interface ShortTermCheckResult {
  label: ShortTermCheckLabel
  tone: ShortTermCheckTone
  score: number
  description: string
  reasons: string[]
  mlText: string
}

export function shortTermStrengthPercent(score: number | null | undefined): number {
  if (score == null || !Number.isFinite(score)) return 0
  return Math.max(0, Math.min(100, Math.round((Math.abs(score) / 10) * 100)))
}

export function shortTermStrengthLabel(label: ShortTermCheckLabel | string | null | undefined): string {
  switch (label) {
    case '強気優勢':
    case '好転候補':
      return '上昇強度'
    case '下落警戒':
    case '弱含み注意':
      return '下落圧力'
    default:
      return '方向感'
  }
}

export function formatShortTermStrength(
  label: ShortTermCheckLabel | string | null | undefined,
  score: number | null | undefined,
): string {
  return `${shortTermStrengthLabel(label)}${shortTermStrengthPercent(score)}%`
}

function normalizeStage(stage: number | null | undefined): number | null {
  if (stage == null || !Number.isFinite(stage)) return null
  const rounded = Math.round(stage)
  return rounded >= 1 && rounded <= 6 ? rounded : null
}

function stageBiasScore(stage: number | null | undefined): number {
  switch (normalizeStage(stage)) {
    case 1: return 2
    case 6: return 1.4
    case 2: return 0.4
    case 5: return 0.2
    case 3: return -1.2
    case 4: return -2
    default: return 0
  }
}

function stageLabelForDecision(stage: number | null | undefined): string {
  switch (normalizeStage(stage)) {
    case 1: return '安定上昇'
    case 6: return '強気初期'
    case 2: return '調整入り'
    case 5: return '反発待ち'
    case 3: return '弱気移行'
    case 4: return '安定下降'
    default: return '未判定'
  }
}

function upperStageLabel(stages: ShortTermCheckStageInput): string {
  const upperStages = [stages.weeklyA, stages.weeklyB, stages.monthlyA, stages.monthlyB]
  const positive = upperStages.filter((value) => [1, 6].includes(normalizeStage(value) ?? 0)).length
  const negative = upperStages.filter((value) => [3, 4].includes(normalizeStage(value) ?? 0)).length
  if (positive >= 3) return '強気整合'
  if (negative >= 3) return '弱気整合'
  if (positive > negative) return 'やや強い'
  if (negative > positive) return 'やや弱い'
  return '混在'
}

function scoreLevelLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'PMS未判定'
  if (value >= 1) return '市場より強い'
  if (value >= 0.35) return 'やや強い'
  if (value <= -1) return '市場より弱い'
  if (value <= -0.35) return 'やや弱い'
  return '市場平均付近'
}

function fmtPct(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function boundedScore(value: number | null | undefined, min: number, max: number): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return Math.max(min, Math.min(max, value))
}

function labelFromScore(score: number): Pick<ShortTermCheckResult, 'label' | 'tone' | 'description'> {
  if (score >= 4) {
    return {
      label: '強気優勢',
      tone: 'bullish',
      description: '短期形状と力の向きが上向き寄りです。高値追いより、MAの上向き維持と押し目の浅さを確認したい状態です。',
    }
  }
  if (score >= 1.4) {
    return {
      label: '好転候補',
      tone: 'positive',
      description: '上向き要素はありますが、上位足や力の継続確認が必要です。初動候補として監視しやすい状態です。',
    }
  }
  if (score <= -4) {
    return {
      label: '下落警戒',
      tone: 'bearish',
      description: 'ステージまたは物理的な力が下方向へ傾いています。反発狙いより、戻りの弱さと下値更新を優先確認します。',
    }
  }
  if (score <= -1.4) {
    return {
      label: '弱含み注意',
      tone: 'weak',
      description: '短期的には慎重に見たい状態です。25日線や直近安値を回復できるかが確認ポイントです。',
    }
  }
  return {
    label: '中立',
    tone: 'neutral',
    description: '売買方向を急がず、ステージ改善・PMS上昇・類似ケースの傾きが揃うかを見る場面です。',
  }
}

function decisionFromLabel(
  label: ShortTermCheckLabel,
  description?: string,
): Pick<ShortTermCheckResult, 'label' | 'tone' | 'description'> {
  switch (label) {
    case '強気優勢':
      return {
        label,
        tone: 'bullish',
        description: description ?? '短期形状と力の向きが上向き寄りです。高値追いより、MAの上向き維持と押し目の浅さを確認したい状態です。',
      }
    case '好転候補':
      return {
        label,
        tone: 'positive',
        description: description ?? '上向き要素はありますが、上位足や力の継続確認が必要です。初動候補として監視しやすい状態です。',
      }
    case '弱含み注意':
      return {
        label,
        tone: 'weak',
        description: description ?? '短期的には慎重に見たい状態です。25日線や直近安値を回復できるかが確認ポイントです。',
      }
    case '下落警戒':
      return {
        label,
        tone: 'bearish',
        description: description ?? 'ステージまたは物理的な力が下方向へ傾いています。反発狙いより、戻りの弱さと下値更新を優先確認します。',
      }
    case '中立':
    default:
      return {
        label: '中立',
        tone: 'neutral',
        description: description ?? '売買方向を急がず、ステージ改善・PMS上昇・類似ケースの傾きが揃うかを見る場面です。',
      }
  }
}

function physicsStatusScore(status: string | null | undefined): number {
  switch (status) {
    case '上昇加速': return 0.6
    case '上昇継続': return 0.4
    case '押し目形成': return 0.25
    case '反発準備': return 0.2
    case '過熱注意': return -0.7
    case '失速警戒': return -1.2
    case '下落加速': return -1.8
    default: return 0
  }
}

function applyShortTermRiskCap(
  decision: Pick<ShortTermCheckResult, 'label' | 'tone' | 'description'>,
  input: ShortTermCheckInput,
): Pick<ShortTermCheckResult, 'label' | 'tone' | 'description'> {
  const status = input.physicsStatus
  const pfs = input.physicalForceScore
  const change = input.changePercent
  const forceCooling = pfs != null && Number.isFinite(pfs) && pfs <= -0.8
  const priceCooling = change != null && Number.isFinite(change) && change <= -2
  const positiveLabel = decision.label === '強気優勢' || decision.label === '好転候補'

  if (status === '過熱注意' && (forceCooling || priceCooling)) {
    if (decision.label === '強気優勢') {
      return decisionFromLabel(
        '好転候補',
        '上位足とPMSは強い一方、短期は過熱冷却中です。高値追いではなく、5日線・25日線付近で下げ止まるかを確認したい状態です。',
      )
    }
    if (decision.label === '好転候補' && forceCooling && priceCooling) {
      return decisionFromLabel(
        '中立',
        '上向き要素は残りますが、短期の力と当日値動きが逆向きです。再加速を確認するまでは様子見寄りです。',
      )
    }
  }

  if (status === '失速警戒' && positiveLabel) {
    return decisionFromLabel(
      forceCooling || priceCooling ? '弱含み注意' : '中立',
      '上向き形状の一部は残りますが、物理ステータスは失速寄りです。戻りの弱さや短期線の下向き加速を優先確認します。',
    )
  }

  if (status === '下落加速' && positiveLabel) {
    return decisionFromLabel(
      '弱含み注意',
      'ステージやPMSに残存する強さがあっても、足元の物理状態は下向き加速です。反発確認までは下落リスクを優先します。',
    )
  }

  return decision
}

function clampScoreToLabel(score: number, label: ShortTermCheckLabel): number {
  switch (label) {
    case '強気優勢': return Math.max(score, 4)
    case '好転候補': return Math.min(Math.max(score, 1.4), 3.95)
    case '中立': return Math.min(Math.max(score, -1.39), 1.39)
    case '弱含み注意': return Math.min(Math.max(score, -3.95), -1.4)
    case '下落警戒': return Math.min(score, -4)
    default: return score
  }
}

export function buildShortTermCheck(input: ShortTermCheckInput): ShortTermCheckResult {
  let score = 0
  const reasons: string[] = []

  if (input.stages) {
    const stages = input.stages
    const shortScore = stageBiasScore(stages.dailyA) + stageBiasScore(stages.dailyB) * 0.8
    const upperScore = (
      stageBiasScore(stages.weeklyA) +
      stageBiasScore(stages.weeklyB) * 0.8 +
      stageBiasScore(stages.monthlyA) * 0.65 +
      stageBiasScore(stages.monthlyB) * 0.55
    ) / 3
    score += shortScore + upperScore
    reasons.push(`日足 ${stageLabelForDecision(stages.dailyA)}`)
    reasons.push(`上位足 ${upperStageLabel(stages)}`)
  } else {
    reasons.push('ステージ未取得')
  }

  const pmsScore = boundedScore(input.physicalMomentumScore, -2, 2)
  if (pmsScore != null) {
    score += pmsScore
    reasons.push(`PMS ${scoreLevelLabel(input.physicalMomentumScore)}`)
  } else {
    reasons.push('PMS未計算')
  }

  if (input.physicalForceScore != null && Number.isFinite(input.physicalForceScore)) {
    const pfs = input.physicalForceScore
    score += pfs >= 0.8 ? 0.8 : pfs <= -0.8 ? -0.8 : 0
    reasons.push(pfs >= 0.8 ? '力が増加' : pfs <= -0.8 ? '力が低下' : '力は中立')
  }

  if (input.changePercent != null && Number.isFinite(input.changePercent) && Math.abs(input.changePercent) >= 2) {
    score += input.changePercent > 0 ? 0.4 : -0.4
    reasons.push(`当日 ${fmtPct(input.changePercent)}`)
  }

  const upCount = Math.max(0, Math.floor(input.mlUpCount ?? 0))
  const downCount = Math.max(0, Math.floor(input.mlDownCount ?? 0))
  const similarCount = Math.max(0, Math.floor(input.mlSimilarCount ?? upCount + downCount))
  if (upCount > downCount) score += 0.8
  if (downCount > upCount) score -= 0.8

  if (input.physicsStatus) {
    score += physicsStatusScore(input.physicsStatus)
    reasons.push(input.physicsStatus)
  }

  const topSimilarity = input.mlTopSimilarity != null && Number.isFinite(input.mlTopSimilarity)
    ? Math.round(input.mlTopSimilarity * 100)
    : null
  const mlText = similarCount > 0
    ? upCount + downCount > 0
      ? `上昇${upCount} / 下落${downCount}${topSimilarity == null ? '' : ` / 最高類似${topSimilarity}%`}`
      : `近似${similarCount}件${topSimilarity == null ? '' : ` / 最高類似${topSimilarity}%`}`
    : '高類似ケースなし'
  const decision = applyShortTermRiskCap(labelFromScore(score), input)

  return {
    ...decision,
    score: clampScoreToLabel(score, decision.label),
    reasons: reasons.slice(0, 6),
    mlText,
  }
}

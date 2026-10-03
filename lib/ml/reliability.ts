export type MlReliabilityTone = 'good' | 'caution' | 'limited'

export type MlReliabilityInput = {
  asOfDate: string | null
  featureDate: string | null
  modelDate: string | null
  evaluationDate: string | null
  similarityScores: number[]
  completedPredictions: number
  hitPredictions: number
  validationRuns: number | null
  validationSamples: number | null
  healthIssueCount: number
}

export type MlReliabilityAssessment = {
  tone: MlReliabilityTone
  label: string
  summary: string
  outOfDistribution: boolean
  featureDate: string | null
  modelDate: string | null
  similarCount: number
  topSimilarity: number | null
  completedPredictions: number
  hitPredictions: number
  historicalAccuracy: number | null
  validationRuns: number | null
  validationSamples: number | null
  warnings: string[]
  notes: string[]
}

function finiteScores(values: number[]): number[] {
  return values.filter((value) => Number.isFinite(value) && value >= 0 && value <= 1)
}

function calendarDayDistance(older: string, newer: string): number | null {
  const start = Date.parse(`${older}T00:00:00Z`)
  const end = Date.parse(`${newer}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.floor((end - start) / 86_400_000)
}

export function assessMlReliability(input: MlReliabilityInput): MlReliabilityAssessment {
  const scores = finiteScores(input.similarityScores)
  const topSimilarity = scores.length > 0 ? Math.max(...scores) : null
  const completedPredictions = Math.max(0, Math.trunc(input.completedPredictions))
  const hitPredictions = Math.min(completedPredictions, Math.max(0, Math.trunc(input.hitPredictions)))
  const historicalAccuracy = completedPredictions > 0 ? hitPredictions / completedPredictions : null
  const warnings: string[] = []
  const notes: string[] = []

  if (!input.featureDate) {
    warnings.push('この銘柄のML特徴量基準日を確認できません')
  } else if (input.asOfDate && input.featureDate !== input.asOfDate) {
    warnings.push(`表示基準日${input.asOfDate}と特徴量基準日${input.featureDate}に差があります`)
  }

  if (!input.modelDate) {
    warnings.push('利用モデルの学習日を確認できません')
  } else if (input.featureDate) {
    const modelAgeDays = calendarDayDistance(input.modelDate, input.featureDate)
    if (modelAgeDays != null && modelAgeDays < 0) {
      warnings.push(`モデル学習日${input.modelDate}が特徴量基準日より後のため、過去日分析では参照範囲を確認してください`)
    } else if (modelAgeDays != null && modelAgeDays > 45) {
      warnings.push(`モデル学習日が特徴量基準日より${modelAgeDays}日古い状態です`)
    }
  }

  const outOfDistribution = scores.length === 0 || (topSimilarity != null && topSimilarity < 0.8)
  if (scores.length === 0) {
    warnings.push('十分に近い過去局面がなく、適用範囲外の可能性があります')
  } else if (topSimilarity != null && topSimilarity < 0.8) {
    warnings.push(`最高類似度が${Math.round(topSimilarity * 100)}%のため、近似として慎重に扱います`)
  } else if (scores.length < 3) {
    warnings.push(`類似候補が${scores.length}件のみで、判断材料が少ない状態です`)
  }

  if (completedPredictions === 0) {
    notes.push('この銘柄の過去予測は実績確定待ちです')
  } else if (completedPredictions < 5) {
    notes.push(`銘柄別一致率は確定${completedPredictions}件の暫定値です`)
  }

  if (input.healthIssueCount > 0) {
    warnings.push(`現行ML基盤に劣化・鮮度警告が${input.healthIssueCount}件あります`)
  }

  if (input.evaluationDate && input.featureDate && input.evaluationDate > input.featureDate) {
    warnings.push(`検証期間の表示日${input.evaluationDate}が特徴量基準日より先のため、検証境界を確認してください`)
  }

  const severelyLimited = !input.featureDate || scores.length === 0 || (topSimilarity != null && topSimilarity < 0.65)
  const tone: MlReliabilityTone = severelyLimited ? 'limited' : warnings.length > 0 ? 'caution' : 'good'
  const label = tone === 'good'
    ? '基盤・類似性は整合'
    : tone === 'caution'
      ? '注意条件あり'
      : '適用範囲外の可能性'
  const summary = tone === 'good'
    ? '特徴量、モデル、類似候補の条件は揃っています。予測ではなく過去局面との比較材料として参照してください。'
    : tone === 'caution'
      ? '利用できますが、下記の注意条件を確認し、6ステージ・MA・価格位置と併用してください。'
      : '類似候補または基盤情報が不足しています。ML候補を主判断にせず、他の分析を優先してください。'

  return {
    tone,
    label,
    summary,
    outOfDistribution,
    featureDate: input.featureDate,
    modelDate: input.modelDate,
    similarCount: scores.length,
    topSimilarity,
    completedPredictions,
    hitPredictions,
    historicalAccuracy,
    validationRuns: input.validationRuns,
    validationSamples: input.validationSamples,
    warnings,
    notes,
  }
}

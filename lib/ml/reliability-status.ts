export type JpMlReliabilityStatusSource = {
  latestFeatureDate: string | null
  latestEvaluationDate: string | null
  models: Array<{
    modelType: string
    trainedAt: number | string | null
  }>
  evaluations: Array<{
    sampleCount: number
  }>
  healthChecks: Array<{
    checkKey: string
    status: string
  }>
}

export type JpMlReliabilityStatus = {
  featureDate: string | null
  modelDate: string | null
  evaluationDate: string | null
  validationRuns: number
  validationSamples: number
  healthIssueCount: number
}

function epochDate(value: number | string | null | undefined) {
  const epoch = Number(value)
  if (!Number.isFinite(epoch) || epoch <= 0) return null
  return new Date(epoch * 1000).toISOString().slice(0, 10)
}

export function summarizeJpMlReliabilityStatus(source: JpMlReliabilityStatusSource): JpMlReliabilityStatus {
  const trainedModels = source.models
    .map((model) => ({ ...model, trainedEpoch: Number(model.trainedAt) }))
    .filter((model) => Number.isFinite(model.trainedEpoch) && model.trainedEpoch > 0)
  const latestEpoch = trainedModels.length > 0 ? Math.max(...trainedModels.map((model) => model.trainedEpoch)) : null
  const latestTypes = new Set(
    trainedModels
      .filter((model) => model.trainedEpoch === latestEpoch)
      .map((model) => model.modelType)
      .filter(Boolean),
  )
  const relevantHealth = source.healthChecks.filter((check) => {
    if (!check.checkKey.startsWith('model_deterioration.')) return true
    return latestTypes.size === 0 || Array.from(latestTypes).some((modelType) => check.checkKey.includes(modelType))
  })
  const validationSamples = source.evaluations.reduce((sum, row) => {
    const value = Number(row.sampleCount)
    return Number.isFinite(value) && value > 0 ? sum + value : sum
  }, 0)

  return {
    featureDate: source.latestFeatureDate,
    modelDate: latestEpoch == null ? null : epochDate(latestEpoch),
    evaluationDate: source.latestEvaluationDate,
    validationRuns: source.evaluations.length,
    validationSamples,
    healthIssueCount: relevantHealth.filter((check) => check.status !== 'ok').length,
  }
}

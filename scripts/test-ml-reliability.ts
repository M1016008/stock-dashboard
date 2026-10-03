import assert from 'node:assert/strict'
import { assessMlReliability } from '@/lib/ml/reliability'
import { summarizeJpMlReliabilityStatus } from '@/lib/ml/reliability-status'

const healthy = assessMlReliability({
  asOfDate: '2026-08-14',
  featureDate: '2026-08-14',
  modelDate: '2026-08-10',
  evaluationDate: '2026-08-13',
  similarityScores: [0.94, 0.88, 0.84, 0.81, 0.8],
  completedPredictions: 12,
  hitPredictions: 8,
  validationRuns: 21,
  validationSamples: 20_000,
  healthIssueCount: 0,
})
assert.equal(healthy.tone, 'good')
assert.equal(healthy.outOfDistribution, false)
assert.equal(healthy.historicalAccuracy, 8 / 12)

const lowSimilarity = assessMlReliability({
  asOfDate: '2026-08-14',
  featureDate: '2026-08-14',
  modelDate: '2026-08-10',
  evaluationDate: '2026-08-13',
  similarityScores: [0.61, 0.58],
  completedPredictions: 0,
  hitPredictions: 0,
  validationRuns: 2,
  validationSamples: 100,
  healthIssueCount: 0,
})
assert.equal(lowSimilarity.tone, 'limited')
assert.equal(lowSimilarity.outOfDistribution, true)
assert.match(lowSimilarity.warnings.join(' '), /最高類似度/)

const warned = assessMlReliability({
  asOfDate: '2026-08-14',
  featureDate: '2026-08-14',
  modelDate: '2026-08-10',
  evaluationDate: '2027-01-01',
  similarityScores: [0.91, 0.86, 0.82],
  completedPredictions: 3,
  hitPredictions: 2,
  validationRuns: 4,
  validationSamples: 1_000,
  healthIssueCount: 2,
})
assert.equal(warned.tone, 'caution')
assert.match(warned.warnings.join(' '), /劣化・鮮度警告/)
assert.match(warned.warnings.join(' '), /検証期間の表示日/)

const futureModel = assessMlReliability({
  asOfDate: '2026-01-15',
  featureDate: '2026-01-15',
  modelDate: '2026-08-13',
  evaluationDate: '2026-01-14',
  similarityScores: [0.91, 0.86, 0.82],
  completedPredictions: 8,
  hitPredictions: 5,
  validationRuns: 4,
  validationSamples: 1_000,
  healthIssueCount: 0,
})
assert.equal(futureModel.tone, 'caution')
assert.match(futureModel.warnings.join(' '), /モデル学習日2026-08-13が特徴量基準日より後/)

const missing = assessMlReliability({
  asOfDate: null,
  featureDate: null,
  modelDate: null,
  evaluationDate: null,
  similarityScores: [],
  completedPredictions: 0,
  hitPredictions: 0,
  validationRuns: null,
  validationSamples: null,
  healthIssueCount: 0,
})
assert.equal(missing.tone, 'limited')
assert.equal(missing.outOfDistribution, true)

const compactStatus = summarizeJpMlReliabilityStatus({
  latestFeatureDate: '2026-08-14',
  latestEvaluationDate: '2026-08-13',
  models: [
    { modelType: 'legacy_v1', trainedAt: 1_700_000_000 },
    { modelType: 'current_v4', trainedAt: 1_765_843_200 },
  ],
  evaluations: [{ sampleCount: 100 }, { sampleCount: 250 }],
  healthChecks: [
    { checkKey: 'model_deterioration.legacy_v1.up.h5', status: 'fail' },
    { checkKey: 'model_deterioration.current_v4.up.h5', status: 'warn' },
    { checkKey: 'ml_feature_vectors_v2', status: 'ok' },
  ],
})
assert.equal(compactStatus.featureDate, '2026-08-14')
assert.equal(compactStatus.validationRuns, 2)
assert.equal(compactStatus.validationSamples, 350)
assert.equal(compactStatus.healthIssueCount, 1)

console.log('ML reliability tests passed')

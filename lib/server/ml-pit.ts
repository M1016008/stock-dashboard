import { execGet } from '@/lib/db/client'
import { endOfTokyoDateEpoch, epochDateInTokyo } from '@/lib/date-time'

export type JpMlPitAvailability = {
  availability: 'available' | 'unavailable'
  availabilityReason: 'no_model_as_of' | null
  asOf: string
  cutoffEpoch: number
  featureDate: string | null
  modelDate: string | null
  evaluationDate: string | null
  validationRuns: number
  validationSamples: number
  healthIssueCount: number
}

export async function getJpMlPitAvailability(asOf: string): Promise<JpMlPitAvailability> {
  const cutoffEpoch = endOfTokyoDateEpoch(asOf)
  const [models, evaluations, features] = await Promise.all([
    execGet<{ count: number; latest_trained_at: number | null }>(`
      SELECT COUNT(*) AS count, MAX(trained_at) AS latest_trained_at
      FROM ml_models
      WHERE trained_at <= ?
    `, [cutoffEpoch]),
    execGet<{ count: number; samples: number; latest_date: string | null }>(`
      SELECT COUNT(*) AS count, COALESCE(SUM(e.sample_count), 0) AS samples,
             MAX(e.evaluation_date) AS latest_date
      FROM ml_model_evaluations e
      WHERE e.evaluation_date <= ?
        AND e.created_at <= ?
        AND e.model_name IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ml_models m
          WHERE m.model_name = e.model_name AND m.trained_at <= ?
        )
    `, [asOf, cutoffEpoch, cutoffEpoch]),
    execGet<{ date: string | null }>(`
      SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE date <= ?
    `, [asOf]),
  ])
  const modelCount = Number(models?.count ?? 0)
  return {
    availability: modelCount > 0 ? 'available' : 'unavailable',
    availabilityReason: modelCount > 0 ? null : 'no_model_as_of',
    asOf,
    cutoffEpoch,
    featureDate: features?.date ?? null,
    modelDate: epochDateInTokyo(models?.latest_trained_at),
    evaluationDate: evaluations?.latest_date ?? null,
    validationRuns: Number(evaluations?.count ?? 0),
    validationSamples: Number(evaluations?.samples ?? 0),
    healthIssueCount: 0,
  }
}

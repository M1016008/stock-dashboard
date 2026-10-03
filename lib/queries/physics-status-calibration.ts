import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { execAll } from '@/lib/db/client'
import type { PhysicsStatus } from '@/lib/ml/physics-analysis'

export type PhysicsStatusCalibration = {
  statusLabel: PhysicsStatus
  targetDirection: 'up' | 'down' | 'wait'
  horizonDays: number
  sampleCount: number
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  confidenceScore: number | null
  evaluationDate: string
}

export async function loadPhysicsStatusCalibration(
  horizonDays: number,
  asOfDate?: string | null,
): Promise<Map<PhysicsStatus, PhysicsStatusCalibration>> {
  const rows = await execAll<{
    status_label: string
    target_direction: 'up' | 'down' | 'wait'
    horizon_days: number
    sample_count: number
    hit_rate: number | null
    base_rate: number | null
    lift: number | null
    confidence_score: number | null
    evaluation_date: string
  }>(`
    WITH latest AS (
      SELECT MAX(evaluation_date) AS evaluation_date
      FROM ml_physics_status_evaluations
      WHERE feature_set = ? AND horizon_days = ? AND sample_count > 0
        ${asOfDate ? 'AND evaluation_date <= ?' : ''}
    )
    SELECT e.status_label, e.target_direction, e.horizon_days, e.sample_count,
      e.hit_rate, e.base_rate, e.lift, e.confidence_score, e.evaluation_date
    FROM ml_physics_status_evaluations e
    INNER JOIN latest l ON l.evaluation_date = e.evaluation_date
    WHERE e.feature_set = ? AND e.horizon_days = ? AND e.sample_count > 0
  `, [
    ML_PHYSICS_FEATURE_SET,
    horizonDays,
    ...(asOfDate ? [asOfDate] : []),
    ML_PHYSICS_FEATURE_SET,
    horizonDays,
  ]).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('no such table')) return []
    throw error
  })

  return new Map(rows.map((row) => [row.status_label as PhysicsStatus, {
    statusLabel: row.status_label as PhysicsStatus,
    targetDirection: row.target_direction,
    horizonDays: Number(row.horizon_days),
    sampleCount: Number(row.sample_count ?? 0),
    hitRate: row.hit_rate,
    baseRate: row.base_rate,
    lift: row.lift,
    confidenceScore: row.confidence_score,
    evaluationDate: row.evaluation_date,
  }]))
}

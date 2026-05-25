// scripts/batch-ml-physics-candidates.ts
//
// 最新日の ma_physics_v2 特徴量から、短期の上昇/下落/見送り候補を生成する。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { dot, sigmoid } from '@/lib/backtest/ml'
import {
  ML_PHYSICS_FEATURE_SET,
  ML_PHYSICS_FEATURE_NAMES,
  buildPhysicsExplanation,
  type PhysicsDirection,
  type PhysicsFeatureProfile,
} from '@/lib/backtest/ml-physics'

type FeatureRow = {
  ticker: string
  date: string
  feature_json: string
  vector_json: string
  name: string | null
  sector_large: string | null
}

type ModelRow = {
  model_name: string
  direction: PhysicsDirection
  horizon_days: number
  weights_json: string
  intercept: number
}

const LIMIT = Number(process.env.ML_PHYSICS_CANDIDATE_LIMIT ?? 60)
const HORIZONS = (process.env.ML_PHYSICS_HORIZONS ?? '5,10,15')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function heuristic(profile: PhysicsFeatureProfile, direction: PhysicsDirection): number {
  const up =
    (profile.regimes.trend === 'up_acceleration' ? 0.22 : 0) +
    (profile.regimes.spread === 'up_expansion' ? 0.18 : 0) +
    (profile.regimes.turn === 'bullish_turn' || profile.regimes.turn === 'rebound_watch' ? 0.16 : 0) +
    Math.max(0, Math.min(0.16, (profile.velocities.sma5.d5 ?? 0) / 30)) +
    Math.max(0, Math.min(0.12, (profile.accelerations.sma5.d5 ?? 0) / 25)) +
    (finite(profile.pricePosition.sma5) && profile.pricePosition.sma5 > 0 ? 0.08 : 0) +
    (finite(profile.gaps.sma5To25Pct) && profile.gaps.sma5To25Pct > 0 ? 0.08 : 0)
  const down =
    (profile.regimes.trend === 'down_acceleration' ? 0.24 : 0) +
    (profile.regimes.spread === 'down_expansion' ? 0.18 : 0) +
    (profile.regimes.turn === 'bearish_turn' || profile.regimes.turn === 'breakdown_watch' ? 0.16 : 0) +
    Math.max(0, Math.min(0.16, -(profile.velocities.sma5.d5 ?? 0) / 30)) +
    Math.max(0, Math.min(0.12, -(profile.accelerations.sma5.d5 ?? 0) / 25)) +
    (finite(profile.pricePosition.sma5) && profile.pricePosition.sma5 < 0 ? 0.08 : 0) +
    (finite(profile.gaps.sma5To25Pct) && profile.gaps.sma5To25Pct < 0 ? 0.08 : 0)
  const wait =
    (profile.regimes.trend === 'sideways' ? 0.22 : 0) +
    (profile.regimes.spread === 'compression' ? 0.2 : 0) +
    (profile.regimes.turn === 'none' ? 0.12 : 0) +
    Math.max(0, 0.14 - Math.abs(profile.velocities.sma5.d5 ?? 0) / 40) +
    Math.max(0, 0.14 - Math.abs(profile.gaps.sma5To25Pct ?? 0) / 80)
  const raw = direction === 'up' ? up - down * 0.35 : direction === 'down' ? down - up * 0.35 : wait - Math.max(up, down) * 0.25
  return Math.max(0, Math.min(0.999, raw + 0.42))
}

function modelScore(row: FeatureRow, model: ModelRow | undefined, direction: PhysicsDirection): { profile: PhysicsFeatureProfile | null; score: number } {
  const profile = parseJson<PhysicsFeatureProfile | null>(row.feature_json, null)
  const vector = parseJson<number[]>(row.vector_json, [])
  if (!profile) return { profile: null, score: 0 }
  if (model && vector.length === ML_PHYSICS_FEATURE_NAMES.length) {
    const weights = parseJson<number[]>(model.weights_json, [])
    return { profile, score: sigmoid((model.intercept ?? 0) + dot(weights, vector)) }
  }
  return { profile, score: heuristic(profile, direction) }
}

async function latestDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE feature_set = ?`,
    [ML_PHYSICS_FEATURE_SET],
  ))?.date ?? null
}

async function models(): Promise<Map<string, ModelRow>> {
  const rows = await execAll<ModelRow>(
    `
    SELECT m.model_name, m.direction, m.horizon_days, m.weights_json, m.intercept
    FROM ml_models m
    INNER JOIN (
      SELECT direction, horizon_days, MAX(trained_at) AS trained_at
      FROM ml_models
      WHERE model_type = 'logistic_regression_physics_v2'
      GROUP BY direction, horizon_days
    ) latest
      ON latest.direction = m.direction
     AND latest.horizon_days = m.horizon_days
     AND latest.trained_at = m.trained_at
    WHERE m.model_type = 'logistic_regression_physics_v2'
    `,
  )
  return new Map(rows.map((row) => [`${row.horizon_days}:${row.direction}`, row]))
}

async function features(date: string): Promise<FeatureRow[]> {
  return execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.feature_json, f.vector_json, u.name,
           COALESCE(u.sector17_name, sm.sector_large) AS sector_large
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    LEFT JOIN sector_master sm ON sm.ticker = f.ticker
    WHERE f.feature_set = ? AND f.date = ?
    `,
    [ML_PHYSICS_FEATURE_SET, date],
  )
}

async function buildDirection(date: string, horizon: number, direction: PhysicsDirection, rows: FeatureRow[], model: ModelRow | undefined): Promise<number> {
  const ranked = rows
    .map((row) => {
      const { profile, score } = modelScore(row, model, direction)
      return { row, profile, score }
    })
    .filter((item): item is { row: FeatureRow; profile: PhysicsFeatureProfile; score: number } => item.profile != null && Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)

  await execRun(
    `DELETE FROM serving_ml_physics_candidates WHERE as_of_date = ? AND horizon_days = ? AND direction = ?`,
    [date, horizon, direction],
  )
  await execBatch(ranked.map((item, index) => {
    const explanation = buildPhysicsExplanation(item.profile, direction, item.score, horizon)
    return {
      sql: `
        INSERT OR REPLACE INTO serving_ml_physics_candidates
          (as_of_date, direction, horizon_days, rank, ticker, name, sector_large,
           candidate_score, model_name, feature_json, reason_json, explanation_json, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        date,
        direction,
        horizon,
        index + 1,
        item.row.ticker,
        item.row.name,
        item.row.sector_large,
        Number(item.score.toFixed(6)),
        model?.model_name ?? 'physics_heuristic_fallback',
        JSON.stringify({ ...item.profile, vector: parseJson<number[]>(item.row.vector_json, []), featureNames: ML_PHYSICS_FEATURE_NAMES }),
        JSON.stringify(explanation.mesh),
        JSON.stringify(explanation),
      ],
    }
  }))
  return ranked.length
}

async function main() {
  const date = await latestDate()
  if (!date) {
    console.log('ml physics candidates: ml_feature_vectors_v2 is empty')
    return
  }
  const [modelMap, rows] = await Promise.all([models(), features(date)])
  for (const horizon of HORIZONS) {
    for (const direction of ['up', 'down', 'wait'] as PhysicsDirection[]) {
      const count = await buildDirection(date, horizon, direction, rows, modelMap.get(`${horizon}:${direction}`))
      console.log(`ml physics candidates ${date}: horizon=${horizon} direction=${direction} rows=${count}/${rows.length}`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })


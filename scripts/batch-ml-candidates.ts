// scripts/batch-ml-candidates.ts
//
// 最新取引日のML特徴量から、Turso表示用の候補銘柄を圧縮生成する。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import {
  ML_FEATURE_NAMES,
  buildCandidateExplanation,
  dot,
  featureVector,
  heuristicScore,
  sigmoid,
  type MlDirection,
  type MlFeatureProfile,
} from '@/lib/backtest/ml'

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
  direction: MlDirection
  horizon_days: number
  weights_json: string
  intercept: number
}

const LIMIT = Number(process.env.ML_CANDIDATE_LIMIT ?? 80)
const HORIZON = Number(process.env.ML_CANDIDATE_HORIZON ?? 40)

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function modelScore(row: FeatureRow, model: ModelRow | undefined, direction: MlDirection): number {
  const profile = parseJson<MlFeatureProfile | null>(row.feature_json, null)
  const vector = parseJson<number[]>(row.vector_json, [])
  if (!profile) return 0
  if (model) {
    const weights = parseJson<number[]>(model.weights_json, [])
    return sigmoid((model.intercept ?? 0) + dot(weights, vector))
  }
  return heuristicScore(profile, direction)
}

async function latestDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM ml_feature_vectors`))?.date ?? null
}

async function models(): Promise<Map<MlDirection, ModelRow>> {
  const rows = await execAll<ModelRow>(
    `
    SELECT model_name, direction, horizon_days, weights_json, intercept
    FROM ml_models
    WHERE horizon_days = ?
    ORDER BY trained_at DESC
    `,
    [HORIZON],
  )
  const map = new Map<MlDirection, ModelRow>()
  for (const row of rows) {
    if (!map.has(row.direction)) map.set(row.direction, row)
  }
  return map
}

async function features(date: string): Promise<FeatureRow[]> {
  return execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.feature_json, f.vector_json, u.name,
           COALESCE(u.sector17_name, sm.sector_large) AS sector_large
    FROM ml_feature_vectors f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    LEFT JOIN sector_master sm ON sm.ticker = f.ticker
    WHERE f.date = ?
    `,
    [date],
  )
}

async function buildDirection(date: string, direction: MlDirection, rows: FeatureRow[], model: ModelRow | undefined): Promise<number> {
  const ranked = rows
    .map((row) => {
      const profile = parseJson<MlFeatureProfile | null>(row.feature_json, null)
      const score = modelScore(row, model, direction)
      return { row, profile, score }
    })
    .filter((item): item is { row: FeatureRow; profile: MlFeatureProfile; score: number } => item.profile != null && Number.isFinite(item.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, LIMIT)

  await execRun(`DELETE FROM serving_ml_candidates WHERE as_of_date = ? AND direction = ?`, [date, direction])
  await execBatch(ranked.map((item, index) => {
    const explanation = buildCandidateExplanation(item.profile, direction, item.score)
    const vector = featureVector(item.profile)
    return {
      sql: `
        INSERT OR REPLACE INTO serving_ml_candidates
          (as_of_date, direction, rank, ticker, name, sector_large, candidate_score,
           model_name, feature_json, reason_json, explanation_json, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        date,
        direction,
        index + 1,
        item.row.ticker,
        item.row.name,
        item.row.sector_large,
        Number(item.score.toFixed(6)),
        model?.model_name ?? 'heuristic_fallback',
        JSON.stringify({ ...item.profile, vector, featureNames: ML_FEATURE_NAMES }),
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
    console.log('ml candidates: ml_feature_vectors is empty')
    return
  }
  const [modelMap, rows] = await Promise.all([models(), features(date)])
  const up = await buildDirection(date, 'up', rows, modelMap.get('up'))
  const down = await buildDirection(date, 'down', rows, modelMap.get('down'))
  console.log(`ml candidates ${date}: up=${up}, down=${down}, rows=${rows.length}, horizon=${HORIZON}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

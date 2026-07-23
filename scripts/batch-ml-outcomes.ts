// scripts/batch-ml-outcomes.ts
//
// 保存済み予測を forward_extrema と照合し、horizon到達済みの実績を記録する。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import { ML_PRIMARY_HORIZON_LIST } from '@/lib/backtest/ml-horizons'

type PredictionRow = {
  as_of_date: string
  horizon_days: number
  direction: 'up' | 'down'
  ticker: string
  score: number
  rank: number
}

type ExtremaRow = {
  return_pct: number | null
  max_return_pct: number | null
  max_return_date: string | null
  days_to_max: number | null
  min_return_pct: number | null
  min_return_date: string | null
  days_to_min: number | null
  hit_10: number | null
  hit_20: number | null
  hit_40: number | null
}

const HORIZONS = (process.env.ML_HORIZONS ?? ML_PRIMARY_HORIZON_LIST)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const START_DATE = process.env.ML_OUTCOME_START_DATE?.trim() || null
const END_DATE = process.env.ML_OUTCOME_END_DATE?.trim() || null
const LIMIT = Number(process.env.ML_OUTCOME_LIMIT ?? 5000)

async function pendingPredictions(): Promise<PredictionRow[]> {
  const where = [
    `p.horizon_days IN (${HORIZONS.map(() => '?').join(', ')})`,
    `NOT EXISTS (
      SELECT 1
      FROM ml_prediction_outcomes o
      WHERE o.as_of_date = p.as_of_date
        AND o.horizon_days = p.horizon_days
        AND o.direction = p.direction
        AND o.ticker = p.ticker
    )`,
  ]
  const args: Array<string | number> = [...HORIZONS]
  if (START_DATE) {
    where.push('p.as_of_date >= ?')
    args.push(START_DATE)
  }
  if (END_DATE) {
    where.push('p.as_of_date <= ?')
    args.push(END_DATE)
  }
  args.push(LIMIT)
  return execAll<PredictionRow>(
    `
    SELECT p.as_of_date, p.horizon_days, p.direction, p.ticker, p.score, p.rank
    FROM ml_predictions p
    WHERE ${where.join(' AND ')}
    ORDER BY p.as_of_date ASC, p.horizon_days ASC, p.direction ASC, p.rank ASC
    LIMIT ?
    `,
    args,
  )
}

async function extrema(row: PredictionRow): Promise<ExtremaRow | null> {
  return (await execGet<ExtremaRow>(
    `
    SELECT return_pct, max_return_pct, max_return_date, days_to_max,
           min_return_pct, min_return_date, days_to_min, hit_10, hit_20, hit_40
    FROM forward_extrema
    WHERE ticker = ? AND date = ? AND horizon_days = ?
    `,
    [row.ticker, row.as_of_date, row.horizon_days],
  )) ?? null
}

async function main() {
  if (HORIZONS.length === 0) {
    console.log('ml outcomes: no horizons')
    return
  }
  const predictions = await pendingPredictions()
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = []
  for (const prediction of predictions) {
    const result = await extrema(prediction)
    if (!result) continue
    const hitLabel =
      prediction.direction === 'up'
        ? (result.max_return_pct ?? -Infinity) >= 10
        : (result.min_return_pct ?? Infinity) <= -5
    const missLabel =
      prediction.direction === 'up'
        ? (result.min_return_pct ?? Infinity) <= -5
        : (result.max_return_pct ?? -Infinity) >= 10
    statements.push({
      sql: `
        INSERT OR REPLACE INTO ml_prediction_outcomes
          (as_of_date, horizon_days, direction, ticker, score, rank,
           return_pct, max_return_pct, min_return_pct, hit_label, miss_label, outcome_json, evaluated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        prediction.as_of_date,
        prediction.horizon_days,
        prediction.direction,
        prediction.ticker,
        prediction.score,
        prediction.rank,
        result.return_pct,
        result.max_return_pct,
        result.min_return_pct,
        hitLabel ? 1 : 0,
        missLabel ? 1 : 0,
        JSON.stringify({
          returnPct: result.return_pct,
          maxReturnPct: result.max_return_pct,
          maxReturnDate: result.max_return_date,
          daysToMax: result.days_to_max,
          minReturnPct: result.min_return_pct,
          minReturnDate: result.min_return_date,
          daysToMin: result.days_to_min,
          hit10: result.hit_10,
          hit20: result.hit_20,
          hit40: result.hit_40,
        }),
      ],
    })
  }
  if (statements.length > 0) await execBatch(statements)
  console.log(`ml outcomes synced: pending=${predictions.length}, inserted=${statements.length}, horizons=${HORIZONS.join('/')}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

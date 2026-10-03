// scripts/batch-ml-predict.ts
//
// serving_ml_candidates を正式な予測履歴 ml_predictions に保存する。
// batch-ml-candidates は同時保存するため、このスクリプトは再同期・復旧用。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'

type CandidateRow = {
  as_of_date: string
  direction: string
  rank: number
  ticker: string
  candidate_score: number
  model_name: string | null
  feature_json: string
  reason_json: string
  explanation_json: string
}

const HORIZON = Number(process.env.ML_CANDIDATE_HORIZON ?? process.env.ML_PREDICT_HORIZON ?? 40)
const DATE = process.env.ML_PREDICT_DATE?.trim() || null

async function latestCandidateDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(as_of_date) AS date FROM serving_ml_candidates`))?.date ?? null
}

async function main() {
  const date = DATE ?? await latestCandidateDate()
  if (!date) {
    console.log('ml predict: serving_ml_candidates is empty')
    return
  }
  const rows = await execAll<CandidateRow>(
    `
    SELECT as_of_date, direction, rank, ticker, candidate_score, model_name,
           feature_json, reason_json, explanation_json
    FROM serving_ml_candidates
    WHERE as_of_date = ?
    ORDER BY direction, rank
    `,
    [date],
  )
  for (const direction of ['up', 'down']) {
    const directionRows = rows.filter((row) => row.direction === direction)
    if (directionRows.length === 0) continue
    const modelName = directionRows[0]?.model_name ?? 'heuristic_fallback'
    const runId = `${date}:${HORIZON}:${direction}:${modelName}`
    await execRun(
      `
      INSERT OR REPLACE INTO ml_prediction_runs
        (run_id, as_of_date, horizon_days, direction, model_name, model_type,
         prediction_count, source, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      [
        runId,
        date,
        HORIZON,
        direction,
        modelName,
        modelName === 'heuristic_fallback' ? 'heuristic_fallback' : 'logistic_regression_v1',
        directionRows.length,
        'batch-ml-predict',
        'success',
      ],
    )
    await execBatch(directionRows.map((row) => ({
      sql: `
        INSERT OR REPLACE INTO ml_predictions
          (as_of_date, horizon_days, direction, ticker, run_id, rank, score,
           model_name, feature_json, reason_json, explanation_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        row.as_of_date,
        HORIZON,
        row.direction,
        row.ticker,
        runId,
        row.rank,
        row.candidate_score,
        row.model_name ?? 'heuristic_fallback',
        row.feature_json,
        row.reason_json,
        row.explanation_json,
      ],
    })))
  }
  console.log(`ml predictions persisted: date=${date}, horizon=${HORIZON}, rows=${rows.length}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

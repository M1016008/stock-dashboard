// scripts/batch-ml-evaluate.ts
//
// 時系列を分割したウォークフォワード検証を行い、モデル評価を保存する。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import { ML_FEATURE_NAMES, dot, sigmoid } from '@/lib/backtest/ml'

type LabeledRow = {
  date: string
  vector_json: string
  up_label: number
  down_label: number
  return_pct: number | null
  max_return_pct: number | null
  min_return_pct: number | null
}

type ScoredRow = {
  score: number
  hit: number
  returnPct: number
  maxReturnPct: number | null
  minReturnPct: number | null
}

const HORIZONS = (process.env.ML_HORIZONS ?? '5,10,20,40,60,90')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const START_DATE = process.env.ML_EVAL_TRAIN_START_DATE?.trim() || '1900-01-01'
const START_YEAR = Number(process.env.ML_EVAL_START_YEAR ?? 2018)
const END_YEAR_ENV = process.env.ML_EVAL_END_YEAR ? Number(process.env.ML_EVAL_END_YEAR) : null
const TRAIN_LIMIT = Number(process.env.ML_EVAL_TRAIN_LIMIT ?? 50000)
const VALIDATION_LIMIT = Number(process.env.ML_EVAL_VALIDATION_LIMIT ?? 20000)
const EPOCHS = Number(process.env.ML_EVAL_EPOCHS ?? 50)
const LR = Number(process.env.ML_EVAL_LR ?? 0.05)

function parseVector(value: string): number[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : []
  } catch {
    return []
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function round(value: number | null | undefined, digits = 6): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function train(rows: Array<{ vector: number[]; label: number }>) {
  const weights = Array.from({ length: ML_FEATURE_NAMES.length }, () => 0)
  let intercept = 0
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    for (const row of rows) {
      const pred = sigmoid(intercept + dot(weights, row.vector))
      const error = pred - row.label
      intercept -= LR * error
      for (let i = 0; i < weights.length; i += 1) weights[i] -= LR * error * (row.vector[i] ?? 0)
    }
  }
  return { weights, intercept }
}

async function maxLabelYear(horizon: number): Promise<number | null> {
  const date = (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_training_labels WHERE horizon_days = ?`,
    [horizon],
  ))?.date
  return date ? Number(date.slice(0, 4)) : null
}

async function loadRows(horizon: number, from: string, to: string, limit: number): Promise<LabeledRow[]> {
  return execAll<LabeledRow>(
    `
    SELECT f.date, f.vector_json, l.up_label, l.down_label,
           l.return_pct, l.max_return_pct, l.min_return_pct
    FROM ml_feature_vectors f
    INNER JOIN ml_training_labels l ON l.ticker = f.ticker AND l.date = f.date
    WHERE l.horizon_days = ?
      AND f.date >= ?
      AND f.date < ?
    ORDER BY ((CAST(f.ticker AS INTEGER) * 1009 + CAST(strftime('%j', f.date) AS INTEGER) * 917) % 1000003), f.date, f.ticker
    LIMIT ?
    `,
    [horizon, from, to, limit],
  )
}

function precisionAt(rows: ScoredRow[], n: number): number | null {
  const top = rows.slice(0, n)
  if (top.length === 0) return null
  return top.filter((row) => row.hit).length / top.length
}

function summarize(rows: ScoredRow[]) {
  const returns = rows.map((row) => row.returnPct).filter(Number.isFinite)
  const hitRate = rows.length ? rows.filter((row) => row.hit).length / rows.length : null
  const avg = returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length)
  const drawdowns = rows.map((row) => row.minReturnPct).filter((value): value is number => value != null && Number.isFinite(value))
  return {
    sampleCount: rows.length,
    precisionAt20: precisionAt(rows, 20),
    precisionAt50: precisionAt(rows, 50),
    precisionAt80: precisionAt(rows, 80),
    hitRate,
    medianReturnPct: median(returns),
    avgReturnPct: returns.length ? avg : null,
    maxDrawdownPct: drawdowns.length ? Math.min(...drawdowns) : null,
  }
}

async function evaluateFold(horizon: number, year: number): Promise<Array<{ sql: string; args: Array<string | number | null> }>> {
  const trainEnd = `${year}-01-01`
  const validationStart = `${year}-01-01`
  const validationEnd = `${year + 1}-01-01`
  const [trainRows, validationRows] = await Promise.all([
    loadRows(horizon, START_DATE, trainEnd, TRAIN_LIMIT),
    loadRows(horizon, validationStart, validationEnd, VALIDATION_LIMIT),
  ])
  const parsedTrain = trainRows
    .map((row) => ({ vector: parseVector(row.vector_json), up: row.up_label ? 1 : 0, down: row.down_label ? 1 : 0 }))
    .filter((row) => row.vector.length === ML_FEATURE_NAMES.length)
  const parsedValidation = validationRows
    .map((row) => ({
      vector: parseVector(row.vector_json),
      up: row.up_label ? 1 : 0,
      down: row.down_label ? 1 : 0,
      returnPct: Number(row.return_pct ?? 0),
      maxReturnPct: row.max_return_pct,
      minReturnPct: row.min_return_pct,
    }))
    .filter((row) => row.vector.length === ML_FEATURE_NAMES.length)
  if (parsedTrain.length === 0 || parsedValidation.length === 0) return []

  const statements: Array<{ sql: string; args: Array<string | number | null> }> = []
  for (const direction of ['up', 'down'] as const) {
    const model = train(parsedTrain.map((row) => ({ vector: row.vector, label: direction === 'up' ? row.up : row.down })))
    const scored = parsedValidation
      .map((row) => ({
        score: sigmoid(model.intercept + dot(model.weights, row.vector)),
        hit: direction === 'up' ? row.up : row.down,
        returnPct: row.returnPct,
        maxReturnPct: row.maxReturnPct,
        minReturnPct: row.minReturnPct,
      }))
      .sort((a, b) => b.score - a.score)
    const summary = summarize(scored)
    const modelName = `walkforward_${direction}_h${horizon}_${year}`
    statements.push({
      sql: `
        INSERT OR REPLACE INTO ml_model_evaluations
          (evaluation_id, model_name, model_type, direction, horizon_days, evaluation_date,
           train_start_date, train_end_date, validation_start_date, validation_end_date,
           sample_count, precision_at_20, precision_at_50, precision_at_80, hit_rate,
           median_return_pct, avg_return_pct, max_drawdown_pct, metrics_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        `${modelName}:${validationStart}:${validationEnd}`,
        modelName,
        'logistic_regression_v1_walkforward',
        direction,
        horizon,
        validationEnd.slice(0, 10),
        START_DATE,
        trainEnd,
        validationStart,
        validationEnd,
        summary.sampleCount,
        round(summary.precisionAt20),
        round(summary.precisionAt50),
        round(summary.precisionAt80),
        round(summary.hitRate),
        round(summary.medianReturnPct, 4),
        round(summary.avgReturnPct, 4),
        round(summary.maxDrawdownPct, 4),
        JSON.stringify({
          mode: 'walk_forward',
          horizon,
          direction,
          year,
          trainSamples: parsedTrain.length,
          validationSamples: parsedValidation.length,
          epochs: EPOCHS,
          lr: LR,
          ...summary,
        }),
      ],
    })
  }
  return statements
}

async function main() {
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = []
  for (const horizon of HORIZONS) {
    const maxYear = END_YEAR_ENV ?? await maxLabelYear(horizon)
    if (!maxYear) continue
    const endYear = Math.max(START_YEAR, maxYear)
    for (let year = START_YEAR; year <= endYear; year += 1) {
      statements.push(...await evaluateFold(horizon, year))
      if (statements.length >= 40) {
        await execBatch(statements.splice(0, statements.length))
      }
      console.log(`ml evaluate: horizon=${horizon}, year=${year}`)
    }
  }
  if (statements.length > 0) await execBatch(statements)
  console.log('ml evaluate complete')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

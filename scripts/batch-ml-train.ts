// scripts/batch-ml-train.ts
//
// 2008年以降のML特徴量と確定済みラベルから、未来情報を混ぜずに軽量モデルを世代保存する。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import { ML_FEATURE_NAMES, dot, sigmoid } from '@/lib/backtest/ml'

type TrainRow = {
  date: string
  vector_json: string
  up_label: number
  down_label: number
}

const HORIZONS = (process.env.ML_HORIZONS ?? '20,40,60,90')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const LIMIT = Number(process.env.ML_TRAIN_LIMIT ?? 80000)
const EPOCHS = Number(process.env.ML_TRAIN_EPOCHS ?? 80)
const LR = Number(process.env.ML_TRAIN_LR ?? 0.06)
const START_DATE = process.env.ML_TRAIN_START_DATE?.trim() || '2008-05-07'
const END_DATE = process.env.ML_TRAIN_END_DATE?.trim() || null
const SAMPLE_MODE = (process.env.ML_TRAIN_SAMPLE_MODE ?? 'yearly').trim()
const PER_YEAR_LIMIT = Number(process.env.ML_TRAIN_PER_YEAR_LIMIT ?? 0)
const LABEL_SOURCE = (process.env.ML_TRAIN_LABEL_SOURCE ?? 'extrema').trim()
const MODEL_VERSION = process.env.ML_MODEL_VERSION?.trim() || timestampVersion()

function timestampVersion(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate()),
    pad(d.getHours()),
    pad(d.getMinutes()),
  ].join('')
}

function minDate(...dates: Array<string | null | undefined>): string | null {
  const values = dates.filter((date): date is string => !!date)
  if (values.length === 0) return null
  return values.sort()[0]
}

function labelJoinSql(): { join: string; select: string; horizonColumn: string; dateColumn: string } {
  if (LABEL_SOURCE === 'forward_returns') {
    return {
      join: `INNER JOIN forward_returns l ON l.ticker = f.ticker AND l.date = f.date`,
      select: `CASE WHEN l.return_pct >= 10 THEN 1 ELSE 0 END AS up_label, CASE WHEN l.return_pct <= -5 THEN 1 ELSE 0 END AS down_label`,
      horizonColumn: 'l.horizon_days',
      dateColumn: 'l.date',
    }
  }
  return {
    join: `INNER JOIN ml_training_labels l ON l.ticker = f.ticker AND l.date = f.date`,
    select: `l.up_label, l.down_label`,
    horizonColumn: 'l.horizon_days',
    dateColumn: 'l.date',
  }
}

async function latestFeatureDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM ml_feature_vectors`))?.date ?? null
}

async function confirmedCutoffDate(horizon: number): Promise<string | null> {
  const latest = await latestFeatureDate()
  if (!latest) return null
  const marketCutoff = (await execGet<{ date: string | null }>(
    `
    SELECT MIN(date) AS date
    FROM (
      SELECT DISTINCT date
      FROM ohlcv_daily
      WHERE date <= ?
      ORDER BY date DESC
      LIMIT ?
    )
    `,
    [latest, horizon + 1],
  ))?.date ?? null
  const labelTable = LABEL_SOURCE === 'forward_returns' ? 'forward_returns' : 'ml_training_labels'
  const labelCutoff = (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ${labelTable} WHERE horizon_days = ?`,
    [horizon],
  ))?.date ?? null
  return minDate(END_DATE, marketCutoff, labelCutoff)
}

function trainingYears(trainEndDate: string): number[] {
  const startYear = Number(START_DATE.slice(0, 4))
  const endYear = Number(trainEndDate.slice(0, 4))
  const years: number[] = []
  for (let year = startYear; year <= endYear; year += 1) years.push(year)
  return years
}

function parseVector(value: string): number[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : []
  } catch {
    return []
  }
}

function train(rows: Array<{ vector: number[]; label: number }>): { weights: number[]; intercept: number; metrics: Record<string, number> } {
  const size = ML_FEATURE_NAMES.length
  const weights = Array.from({ length: size }, () => 0)
  let intercept = 0
  if (rows.length === 0) return { weights, intercept, metrics: { samples: 0, positiveRate: 0, accuracy: 0 } }

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    for (const row of rows) {
      const z = intercept + dot(weights, row.vector)
      const pred = sigmoid(z)
      const error = pred - row.label
      intercept -= LR * error
      for (let i = 0; i < size; i += 1) weights[i] -= LR * error * (row.vector[i] ?? 0)
    }
  }

  let correct = 0
  let positives = 0
  for (const row of rows) {
    positives += row.label
    const pred = sigmoid(intercept + dot(weights, row.vector)) >= 0.5 ? 1 : 0
    if (pred === row.label) correct += 1
  }

  return {
    weights: weights.map((value) => Number(value.toFixed(6))),
    intercept: Number(intercept.toFixed(6)),
    metrics: {
      samples: rows.length,
      positiveRate: Number((positives / rows.length).toFixed(4)),
      accuracy: Number((correct / rows.length).toFixed(4)),
      epochs: EPOCHS,
      lr: LR,
    },
  }
}

async function loadRecentRows(horizon: number, trainEndDate: string): Promise<TrainRow[]> {
  const labelSql = labelJoinSql()
  const args: Array<string | number> = [horizon, START_DATE, trainEndDate]
  const limitSql = LIMIT > 0 ? `LIMIT ?` : ''
  if (LIMIT > 0) args.push(LIMIT)
  return execAll<TrainRow>(
    `
    SELECT f.date, f.vector_json, ${labelSql.select}
    FROM ml_feature_vectors f
    ${labelSql.join}
    WHERE ${labelSql.horizonColumn} = ?
      AND f.date >= ?
      AND f.date <= ?
    ORDER BY ${labelSql.dateColumn} DESC
    ${limitSql}
    `,
    args,
  )
}

async function loadYearlyRows(horizon: number, trainEndDate: string): Promise<TrainRow[]> {
  const labelSql = labelJoinSql()
  const years = trainingYears(trainEndDate)
  const perYear = PER_YEAR_LIMIT > 0
    ? PER_YEAR_LIMIT
    : LIMIT > 0
      ? Math.max(1, Math.ceil(LIMIT / Math.max(1, years.length)))
      : 0
  const rows: TrainRow[] = []
  for (const year of years) {
    const from = year === Number(START_DATE.slice(0, 4)) ? START_DATE : `${year}-01-01`
    const to = year === Number(trainEndDate.slice(0, 4)) ? trainEndDate : `${year}-12-31`
    if (from > trainEndDate || to < START_DATE) continue
    const args: Array<string | number> = [horizon, from, to]
    const limitSql = perYear > 0 ? `LIMIT ?` : ''
    if (perYear > 0) args.push(perYear)
    rows.push(...await execAll<TrainRow>(
      `
      SELECT f.date, f.vector_json, ${labelSql.select}
      FROM ml_feature_vectors f
      ${labelSql.join}
      WHERE ${labelSql.horizonColumn} = ?
        AND f.date >= ?
        AND f.date <= ?
      ORDER BY ((CAST(f.ticker AS INTEGER) * 1009 + CAST(strftime('%j', f.date) AS INTEGER) * 917) % 1000003), f.date, f.ticker
      ${limitSql}
      `,
      args,
    ))
  }
  return rows
}

async function loadRows(horizon: number, trainEndDate: string): Promise<TrainRow[]> {
  if (SAMPLE_MODE === 'yearly') return loadYearlyRows(horizon, trainEndDate)
  return loadRecentRows(horizon, trainEndDate)
}

async function trainHorizon(horizon: number): Promise<void> {
  const trainEndDate = await confirmedCutoffDate(horizon)
  if (!trainEndDate) {
    console.log(`ml train horizon=${horizon}: skipped, no confirmed cutoff`)
    return
  }
  const rows = await loadRows(horizon, trainEndDate)
  if (rows.length === 0) {
    console.log(`ml train horizon=${horizon}: skipped, no rows before ${trainEndDate}`)
    return
  }

  const parsed = rows
    .map((row) => ({ vector: parseVector(row.vector_json), up: row.up_label ? 1 : 0, down: row.down_label ? 1 : 0 }))
    .filter((row) => row.vector.length === ML_FEATURE_NAMES.length)
  const up = train(parsed.map((row) => ({ vector: row.vector, label: row.up })))
  const down = train(parsed.map((row) => ({ vector: row.vector, label: row.down })))

  const baseMetrics = {
    mode: SAMPLE_MODE,
    labelSource: LABEL_SOURCE,
    trainStartDate: START_DATE,
    trainEndDate,
    limit: LIMIT,
    perYearLimit: PER_YEAR_LIMIT,
    featureCount: ML_FEATURE_NAMES.length,
  }
  const upName = `ma_stage_up_h${horizon}_${MODEL_VERSION}`
  const downName = `ma_stage_down_h${horizon}_${MODEL_VERSION}`

  await execBatch([
    {
      sql: `
        INSERT OR REPLACE INTO ml_models
          (model_name, model_type, direction, horizon_days, feature_names_json, weights_json, intercept, metrics_json, trained_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        upName,
        'logistic_regression_v1',
        'up',
        horizon,
        JSON.stringify(ML_FEATURE_NAMES),
        JSON.stringify(up.weights),
        up.intercept,
        JSON.stringify({ ...baseMetrics, ...up.metrics }),
      ],
    },
    {
      sql: `
        INSERT OR REPLACE INTO ml_models
          (model_name, model_type, direction, horizon_days, feature_names_json, weights_json, intercept, metrics_json, trained_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        downName,
        'logistic_regression_v1',
        'down',
        horizon,
        JSON.stringify(ML_FEATURE_NAMES),
        JSON.stringify(down.weights),
        down.intercept,
        JSON.stringify({ ...baseMetrics, ...down.metrics }),
      ],
    },
  ])

  console.log(`ml train horizon=${horizon}: rows=${parsed.length.toLocaleString()} cutoff=${trainEndDate} up=${upName} acc=${up.metrics.accuracy} down=${downName} acc=${down.metrics.accuracy}`)
}

async function main() {
  console.log(`ml train: version=${MODEL_VERSION}, mode=${SAMPLE_MODE}, label_source=${LABEL_SOURCE}, limit=${LIMIT || 'all'}, per_year=${PER_YEAR_LIMIT || 'auto'}, start=${START_DATE}, end=${END_DATE ?? 'auto'}, horizons=${HORIZONS.join('/')}`)
  for (const horizon of HORIZONS) await trainHorizon(horizon)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

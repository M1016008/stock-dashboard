// scripts/batch-ml-train.ts
//
// v1: TypeScriptだけで動く軽量な教師ありモデルを学習する。

import { execAll, execBatch } from '@/lib/db/client'
import { ML_FEATURE_NAMES, dot, sigmoid } from '@/lib/backtest/ml'

type TrainRow = {
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
      for (let i = 0; i < size; i += 1) {
        weights[i] -= LR * error * (row.vector[i] ?? 0)
      }
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

async function trainHorizon(horizon: number): Promise<void> {
  const rows = await execAll<TrainRow>(
    `
    SELECT f.vector_json, l.up_label, l.down_label
    FROM ml_feature_vectors f
    INNER JOIN ml_training_labels l ON l.ticker = f.ticker AND l.date = f.date
    WHERE l.horizon_days = ?
    ORDER BY f.date DESC
    LIMIT ?
    `,
    [horizon, LIMIT],
  )
  if (rows.length === 0) {
    console.log(`ml train horizon=${horizon}: skipped, no rows`)
    return
  }

  const parsed = rows
    .map((row) => ({ vector: parseVector(row.vector_json), up: row.up_label ? 1 : 0, down: row.down_label ? 1 : 0 }))
    .filter((row) => row.vector.length === ML_FEATURE_NAMES.length)
  const up = train(parsed.map((row) => ({ vector: row.vector, label: row.up })))
  const down = train(parsed.map((row) => ({ vector: row.vector, label: row.down })))

  await execBatch([
    {
      sql: `
        INSERT OR REPLACE INTO ml_models
          (model_name, model_type, direction, horizon_days, feature_names_json, weights_json, intercept, metrics_json, trained_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        `ma_stage_up_h${horizon}`,
        'logistic_regression_v1',
        'up',
        horizon,
        JSON.stringify(ML_FEATURE_NAMES),
        JSON.stringify(up.weights),
        up.intercept,
        JSON.stringify(up.metrics),
      ],
    },
    {
      sql: `
        INSERT OR REPLACE INTO ml_models
          (model_name, model_type, direction, horizon_days, feature_names_json, weights_json, intercept, metrics_json, trained_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        `ma_stage_down_h${horizon}`,
        'logistic_regression_v1',
        'down',
        horizon,
        JSON.stringify(ML_FEATURE_NAMES),
        JSON.stringify(down.weights),
        down.intercept,
        JSON.stringify(down.metrics),
      ],
    },
  ])

  console.log(`ml train horizon=${horizon}: rows=${parsed.length.toLocaleString()} up_acc=${up.metrics.accuracy} down_acc=${down.metrics.accuracy}`)
}

async function main() {
  for (const horizon of HORIZONS) await trainHorizon(horizon)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

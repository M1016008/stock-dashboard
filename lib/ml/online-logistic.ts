// lib/ml/online-logistic.ts
//
// batch-ml-train / batch-ml-physics-train で共通の、オンライン確率的勾配降下によるロジスティック回帰の状態と計算。
// DB ローダー・ラベル解釈・ページ走査・モデル命名は各スクリプト側に置く。

import { dot, sigmoid } from '@/lib/backtest/ml'

export type ModelState = {
  weights: number[]
  intercept: number
  samples: number
  positives: number
  correct: number
}

export type TrainedModel = {
  weights: number[]
  intercept: number
  metrics: Record<string, number | string | null>
}

export function createModelState(featureCount: number): ModelState {
  return {
    weights: Array.from({ length: featureCount }, () => 0),
    intercept: 0,
    samples: 0,
    positives: 0,
    correct: 0,
  }
}

export function updateModelState(state: ModelState, vector: number[], label: number, lr: number): void {
  const pred = sigmoid(state.intercept + dot(state.weights, vector))
  const error = pred - label
  state.intercept -= lr * error
  for (let i = 0; i < state.weights.length; i += 1) {
    state.weights[i] -= lr * error * (vector[i] ?? 0)
  }
}

export function resetMetrics(state: ModelState): void {
  state.samples = 0
  state.positives = 0
  state.correct = 0
}

export function evaluateModelState(state: ModelState, vector: number[], label: number): void {
  state.samples += 1
  state.positives += label
  const pred = sigmoid(state.intercept + dot(state.weights, vector)) >= 0.5 ? 1 : 0
  if (pred === label) state.correct += 1
}

export function finalizeModelState(
  state: ModelState,
  metrics: Record<string, number | string | null>,
  epochs: number,
  lr: number,
): TrainedModel {
  return {
    weights: state.weights.map((value) => Number(value.toFixed(6))),
    intercept: Number(state.intercept.toFixed(6)),
    metrics: {
      ...metrics,
      samples: state.samples,
      positiveRate: state.samples ? Number((state.positives / state.samples).toFixed(4)) : 0,
      accuracy: state.samples ? Number((state.correct / state.samples).toFixed(4)) : 0,
      epochs,
      lr,
    },
  }
}

// メモリ上の行を epochs 回なめて学習し、同じ行で精度を測る。
export function trainInMemory(
  rows: Array<{ vector: number[]; label: number }>,
  featureCount: number,
  epochs: number,
  lr: number,
): TrainedModel {
  const state = createModelState(featureCount)
  if (rows.length === 0) return { weights: state.weights, intercept: 0, metrics: { samples: 0, positiveRate: 0, accuracy: 0 } }
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    for (const row of rows) updateModelState(state, row.vector, row.label, lr)
  }
  for (const row of rows) evaluateModelState(state, row.vector, row.label)
  return finalizeModelState(state, {}, epochs, lr)
}

export function modelInsertStatement(model: {
  modelName: string
  modelType: string
  direction: string
  horizon: number
  featureNames: readonly string[]
  weights: number[]
  intercept: number
  metrics: Record<string, number | string | null>
}): { sql: string; args: Array<string | number> } {
  return {
    sql: `
      INSERT OR REPLACE INTO ml_models
        (model_name, model_type, direction, horizon_days, feature_names_json, weights_json, intercept, metrics_json, trained_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `,
    args: [
      model.modelName,
      model.modelType,
      model.direction,
      model.horizon,
      JSON.stringify(model.featureNames),
      JSON.stringify(model.weights),
      model.intercept,
      JSON.stringify(model.metrics),
    ],
  }
}

export function timestampVersion(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes())].join('')
}

export function minDate(...dates: Array<string | null | undefined>): string | null {
  const values = dates.filter((date): date is string => !!date)
  return values.length ? values.sort()[0] : null
}

export function trainingYears(startDate: string, trainEndDate: string): number[] {
  const startYear = Number(startDate.slice(0, 4))
  const endYear = Number(trainEndDate.slice(0, 4))
  const years: number[] = []
  for (let year = startYear; year <= endYear; year += 1) years.push(year)
  return years
}

export function parseVector(value: string): number[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : []
  } catch {
    return []
  }
}

export function labelMapKey(ticker: string, date: string): string {
  return `${ticker}\u0000${date}`
}

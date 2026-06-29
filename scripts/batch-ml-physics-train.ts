// scripts/batch-ml-physics-train.ts
//
// SMAの速度・加速度・距離変化を使う短期モデルを学習し、ml_models に世代保存する。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import {
  ML_PHYSICS_FEATURE_NAMES,
  ML_PHYSICS_DEFAULT_HORIZON_LIST,
  ML_PHYSICS_FEATURE_SET,
  ML_PHYSICS_MODEL_TYPE,
  ML_PHYSICS_VERSION,
  type PhysicsDirection,
} from '@/lib/backtest/ml-physics'
import { dot, sigmoid } from '@/lib/backtest/ml'

type TrainRow = {
  date: string
  vector_json: string
  up_label: number
  down_label: number
  wait_label: number
}

type FeatureRow = {
  ticker: string
  date: string
  vector_json: string
}

type LabelRow = {
  ticker: string
  date: string
  horizon_days: number
  up_label: number
  down_label: number
  wait_label: number
}

const HORIZONS = (process.env.ML_PHYSICS_HORIZONS ?? ML_PHYSICS_DEFAULT_HORIZON_LIST)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const LIMIT = Number(process.env.ML_PHYSICS_TRAIN_LIMIT ?? 120000)
const START_DATE = process.env.ML_PHYSICS_TRAIN_START_DATE?.trim() || '1900-01-01'
const END_DATE = process.env.ML_PHYSICS_TRAIN_END_DATE?.trim() || null
const SAMPLE_MODE = (process.env.ML_PHYSICS_TRAIN_SAMPLE_MODE ?? 'yearly').trim()
const ALL_PAGED_MODE = SAMPLE_MODE === 'all_paged'
const EPOCHS = Number(process.env.ML_PHYSICS_TRAIN_EPOCHS ?? (ALL_PAGED_MODE ? 2 : 60))
const LR = Number(process.env.ML_PHYSICS_TRAIN_LR ?? (ALL_PAGED_MODE ? 0.01 : 0.05))
const PER_YEAR_LIMIT = Number(process.env.ML_PHYSICS_TRAIN_PER_YEAR_LIMIT ?? 0)
const PAGE_DATES = Math.max(1, Number(process.env.ML_PHYSICS_TRAIN_PAGE_DATES ?? 20))
const MODEL_VERSION = process.env.ML_PHYSICS_MODEL_VERSION?.trim() || timestampVersion()

function timestampVersion(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate()), pad(d.getHours()), pad(d.getMinutes())].join('')
}

function minDate(...dates: Array<string | null | undefined>): string | null {
  const values = dates.filter((date): date is string => !!date)
  return values.length ? values.sort()[0] : null
}

async function latestFeatureDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE feature_set = ?`,
    [ML_PHYSICS_FEATURE_SET],
  ))?.date ?? null
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
  const labelCutoff = (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_short_labels WHERE horizon_days = ?`,
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

type ParsedTrainRow = {
  vector: number[]
  up: number
  down: number
  wait: number
}

type ModelState = {
  weights: number[]
  intercept: number
  samples: number
  positives: number
  correct: number
}

type PagedHorizonState = {
  horizon: number
  trainEndDate: string
  states: Record<PhysicsDirection, ModelState>
  trainRows: number
}

function parseTrainRow(row: TrainRow): ParsedTrainRow | null {
  const vector = parseVector(row.vector_json)
  if (vector.length !== ML_PHYSICS_FEATURE_NAMES.length) return null
  return {
    vector,
    up: row.up_label ? 1 : 0,
    down: row.down_label ? 1 : 0,
    wait: row.wait_label ? 1 : 0,
  }
}

function createModelState(): ModelState {
  return {
    weights: Array.from({ length: ML_PHYSICS_FEATURE_NAMES.length }, () => 0),
    intercept: 0,
    samples: 0,
    positives: 0,
    correct: 0,
  }
}

function updateModelState(state: ModelState, vector: number[], label: number): void {
  const pred = sigmoid(state.intercept + dot(state.weights, vector))
  const error = pred - label
  state.intercept -= LR * error
  for (let i = 0; i < state.weights.length; i += 1) {
    state.weights[i] -= LR * error * (vector[i] ?? 0)
  }
}

function resetMetrics(state: ModelState): void {
  state.samples = 0
  state.positives = 0
  state.correct = 0
}

function evaluateModelState(state: ModelState, vector: number[], label: number): void {
  state.samples += 1
  state.positives += label
  const pred = sigmoid(state.intercept + dot(state.weights, vector)) >= 0.5 ? 1 : 0
  if (pred === label) state.correct += 1
}

function finalizeModelState(state: ModelState, metrics: Record<string, number | string | null>): {
  weights: number[]
  intercept: number
  metrics: Record<string, number | string | null>
} {
  return {
    weights: state.weights.map((value) => Number(value.toFixed(6))),
    intercept: Number(state.intercept.toFixed(6)),
    metrics: {
      ...metrics,
      samples: state.samples,
      positiveRate: state.samples ? Number((state.positives / state.samples).toFixed(4)) : 0,
      accuracy: state.samples ? Number((state.correct / state.samples).toFixed(4)) : 0,
      epochs: EPOCHS,
      lr: LR,
    },
  }
}

function train(rows: Array<{ vector: number[]; label: number }>): { weights: number[]; intercept: number; metrics: Record<string, number> } {
  const size = ML_PHYSICS_FEATURE_NAMES.length
  const weights = Array.from({ length: size }, () => 0)
  let intercept = 0
  if (rows.length === 0) return { weights, intercept, metrics: { samples: 0, positiveRate: 0, accuracy: 0 } }

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    for (const row of rows) {
      const pred = sigmoid(intercept + dot(weights, row.vector))
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
  const args: Array<string | number> = [ML_PHYSICS_FEATURE_SET, horizon, START_DATE, trainEndDate]
  const limitSql = LIMIT > 0 ? `LIMIT ?` : ''
  if (LIMIT > 0) args.push(LIMIT)
  return execAll<TrainRow>(
    `
    SELECT f.date, f.vector_json, l.up_label, l.down_label, l.wait_label
    FROM ml_feature_vectors_v2 f
    INNER JOIN ml_short_labels l ON l.ticker = f.ticker AND l.date = f.date
    WHERE f.feature_set = ?
      AND l.horizon_days = ?
      AND f.date >= ?
      AND f.date <= ?
    ORDER BY f.date DESC
    ${limitSql}
    `,
    args,
  )
}

async function loadYearlyRows(horizon: number, trainEndDate: string): Promise<TrainRow[]> {
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
    const args: Array<string | number> = [ML_PHYSICS_FEATURE_SET, horizon, from, to]
    const limitSql = perYear > 0 ? `LIMIT ?` : ''
    if (perYear > 0) args.push(perYear)
    rows.push(...await execAll<TrainRow>(
      `
      SELECT f.date, f.vector_json, l.up_label, l.down_label, l.wait_label
      FROM ml_feature_vectors_v2 f
      INNER JOIN ml_short_labels l ON l.ticker = f.ticker AND l.date = f.date
      WHERE f.feature_set = ?
        AND l.horizon_days = ?
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
  return SAMPLE_MODE === 'yearly' ? loadYearlyRows(horizon, trainEndDate) : loadRecentRows(horizon, trainEndDate)
}

async function loadTrainingDates(horizon: number, trainEndDate: string): Promise<string[]> {
  const rows = await execAll<{ date: string }>(
    `
    SELECT DISTINCT f.date
    FROM ml_feature_vectors_v2 f
    INNER JOIN ml_short_labels l ON l.ticker = f.ticker AND l.date = f.date
    WHERE f.feature_set = ?
      AND l.horizon_days = ?
      AND f.date >= ?
      AND f.date <= ?
    ORDER BY f.date ASC
    `,
    [ML_PHYSICS_FEATURE_SET, horizon, START_DATE, trainEndDate],
  )
  return rows.map((row) => row.date)
}

async function loadFeatureDates(trainEndDate: string): Promise<string[]> {
  const rows = await execAll<{ date: string }>(
    `
    SELECT DISTINCT date
    FROM ml_feature_vectors_v2
    WHERE feature_set = ?
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC
    `,
    [ML_PHYSICS_FEATURE_SET, START_DATE, trainEndDate],
  )
  return rows.map((row) => row.date)
}

async function loadRowsForDates(horizon: number, dates: string[]): Promise<TrainRow[]> {
  if (dates.length === 0) return []
  const placeholders = dates.map(() => '?').join(', ')
  return execAll<TrainRow>(
    `
    SELECT f.date, f.vector_json, l.up_label, l.down_label, l.wait_label
    FROM ml_feature_vectors_v2 f
    INNER JOIN ml_short_labels l ON l.ticker = f.ticker AND l.date = f.date
    WHERE f.feature_set = ?
      AND l.horizon_days = ?
      AND f.date IN (${placeholders})
    ORDER BY f.date ASC, f.ticker ASC
    `,
    [ML_PHYSICS_FEATURE_SET, horizon, ...dates],
  )
}

async function loadFeatureRowsForDates(dates: string[]): Promise<FeatureRow[]> {
  if (dates.length === 0) return []
  const placeholders = dates.map(() => '?').join(', ')
  return execAll<FeatureRow>(
    `
    SELECT ticker, date, vector_json
    FROM ml_feature_vectors_v2
    WHERE feature_set = ?
      AND date IN (${placeholders})
    ORDER BY date ASC, ticker ASC
    `,
    [ML_PHYSICS_FEATURE_SET, ...dates],
  )
}

async function loadLabelRowsForDates(horizons: number[], dates: string[]): Promise<LabelRow[]> {
  if (horizons.length === 0 || dates.length === 0) return []
  const horizonPlaceholders = horizons.map(() => '?').join(', ')
  const datePlaceholders = dates.map(() => '?').join(', ')
  return execAll<LabelRow>(
    `
    SELECT ticker, date, horizon_days, up_label, down_label, wait_label
    FROM ml_short_labels
    WHERE horizon_days IN (${horizonPlaceholders})
      AND date IN (${datePlaceholders})
    ORDER BY date ASC, ticker ASC, horizon_days ASC
    `,
    [...horizons, ...dates],
  )
}

async function forEachTrainingPage(
  horizon: number,
  dates: string[],
  phase: string,
  onRow: (row: ParsedTrainRow) => void,
): Promise<number> {
  let parsedRows = 0
  const totalPages = Math.ceil(dates.length / PAGE_DATES)
  for (let offset = 0; offset < dates.length; offset += PAGE_DATES) {
    const page = Math.floor(offset / PAGE_DATES) + 1
    const pageDates = dates.slice(offset, offset + PAGE_DATES)
    const rows = await loadRowsForDates(horizon, pageDates)
    for (const row of rows) {
      const parsed = parseTrainRow(row)
      if (!parsed) continue
      parsedRows += 1
      onRow(parsed)
    }
    if (page === totalPages || page % 10 === 0) {
      console.log(
        `ml physics train horizon=${horizon} ${phase}: page=${page}/${totalPages}, rows=${parsedRows.toLocaleString()}, dates=${pageDates[0]}..${pageDates.at(-1)}`,
      )
    }
  }
  return parsedRows
}

function labelMapKey(ticker: string, date: string): string {
  return `${ticker}\u0000${date}`
}

async function forEachMultiHorizonPage(
  horizonStates: PagedHorizonState[],
  dates: string[],
  phase: string,
  onRow: (horizonState: PagedHorizonState, row: ParsedTrainRow) => void,
): Promise<Map<number, number>> {
  const horizons = horizonStates.map((state) => state.horizon)
  const counts = new Map<number, number>(horizons.map((horizon) => [horizon, 0]))
  const totalPages = Math.ceil(dates.length / PAGE_DATES)

  for (let offset = 0; offset < dates.length; offset += PAGE_DATES) {
    const page = Math.floor(offset / PAGE_DATES) + 1
    const pageDates = dates.slice(offset, offset + PAGE_DATES)
    const [features, labels] = await Promise.all([
      loadFeatureRowsForDates(pageDates),
      loadLabelRowsForDates(horizons, pageDates),
    ])
    const labelsByTickerDate = new Map<string, Map<number, LabelRow>>()
    for (const label of labels) {
      const key = labelMapKey(label.ticker, label.date)
      const existing = labelsByTickerDate.get(key)
      if (existing) {
        existing.set(label.horizon_days, label)
      } else {
        labelsByTickerDate.set(key, new Map([[label.horizon_days, label]]))
      }
    }

    for (const feature of features) {
      const vector = parseVector(feature.vector_json)
      if (vector.length !== ML_PHYSICS_FEATURE_NAMES.length) continue
      const labelsForFeature = labelsByTickerDate.get(labelMapKey(feature.ticker, feature.date))
      if (!labelsForFeature) continue
      for (const horizonState of horizonStates) {
        if (feature.date > horizonState.trainEndDate) continue
        const label = labelsForFeature.get(horizonState.horizon)
        if (!label) continue
        counts.set(horizonState.horizon, (counts.get(horizonState.horizon) ?? 0) + 1)
        onRow(horizonState, {
          vector,
          up: label.up_label ? 1 : 0,
          down: label.down_label ? 1 : 0,
          wait: label.wait_label ? 1 : 0,
        })
      }
    }

    if (page === totalPages || page % 10 === 0) {
      const countSummary = horizons.map((horizon) => `${horizon}:${(counts.get(horizon) ?? 0).toLocaleString()}`).join(' ')
      console.log(
        `ml physics train multi ${phase}: page=${page}/${totalPages}, rows=[${countSummary}], dates=${pageDates[0]}..${pageDates.at(-1)}`,
      )
    }
  }

  return counts
}

async function trainHorizonAllPaged(horizon: number, trainEndDate: string): Promise<void> {
  const dates = await loadTrainingDates(horizon, trainEndDate)
  if (dates.length === 0) {
    console.log(`ml physics train horizon=${horizon}: skipped, no training dates before ${trainEndDate}`)
    return
  }

  const states: Record<PhysicsDirection, ModelState> = {
    up: createModelState(),
    down: createModelState(),
    wait: createModelState(),
  }

  let trainRows = 0
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    trainRows = await forEachTrainingPage(horizon, dates, `epoch=${epoch + 1}/${EPOCHS}`, (row) => {
      updateModelState(states.up, row.vector, row.up)
      updateModelState(states.down, row.vector, row.down)
      updateModelState(states.wait, row.vector, row.wait)
    })
  }

  for (const direction of ['up', 'down', 'wait'] as PhysicsDirection[]) resetMetrics(states[direction])
  await forEachTrainingPage(horizon, dates, 'evaluate', (row) => {
    evaluateModelState(states.up, row.vector, row.up)
    evaluateModelState(states.down, row.vector, row.down)
    evaluateModelState(states.wait, row.vector, row.wait)
  })

  const baseMetrics = {
    mode: SAMPLE_MODE,
    trainStartDate: START_DATE,
    trainEndDate,
    limit: 0,
    perYearLimit: 0,
    pageDates: PAGE_DATES,
    dateCount: dates.length,
    trainRows,
    featureSet: ML_PHYSICS_FEATURE_SET,
    featureVersion: ML_PHYSICS_VERSION,
    featureCount: ML_PHYSICS_FEATURE_NAMES.length,
  }
  const statements: Array<{ sql: string; args: Array<string | number> }> = []
  for (const direction of ['up', 'down', 'wait'] as PhysicsDirection[]) {
    const model = finalizeModelState(states[direction], baseMetrics)
    const modelName = `ma_physics_v${ML_PHYSICS_VERSION}_${direction}_h${horizon}_${MODEL_VERSION}`
    statements.push({
      sql: `
        INSERT OR REPLACE INTO ml_models
          (model_name, model_type, direction, horizon_days, feature_names_json, weights_json, intercept, metrics_json, trained_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        modelName,
        ML_PHYSICS_MODEL_TYPE,
        direction,
        horizon,
        JSON.stringify(ML_PHYSICS_FEATURE_NAMES),
        JSON.stringify(model.weights),
        model.intercept,
        JSON.stringify(model.metrics),
      ],
    })
    console.log(`ml physics train horizon=${horizon} direction=${direction}: rows=${Number(model.metrics.samples).toLocaleString()} cutoff=${trainEndDate} acc=${model.metrics.accuracy}`)
  }
  await execBatch(statements)
}

async function trainAllHorizonsPaged(): Promise<void> {
  const horizonStates: PagedHorizonState[] = []
  for (const horizon of HORIZONS) {
    const trainEndDate = await confirmedCutoffDate(horizon)
    if (!trainEndDate) {
      console.log(`ml physics train horizon=${horizon}: skipped, no confirmed cutoff`)
      continue
    }
    horizonStates.push({
      horizon,
      trainEndDate,
      states: {
        up: createModelState(),
        down: createModelState(),
        wait: createModelState(),
      },
      trainRows: 0,
    })
  }
  if (horizonStates.length === 0) return

  const maxTrainEndDate = horizonStates.map((state) => state.trainEndDate).sort().at(-1)
  if (!maxTrainEndDate) return
  const dates = await loadFeatureDates(maxTrainEndDate)
  if (dates.length === 0) {
    console.log(`ml physics train: skipped, no feature dates before ${maxTrainEndDate}`)
    return
  }

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const counts = await forEachMultiHorizonPage(horizonStates, dates, `epoch=${epoch + 1}/${EPOCHS}`, (horizonState, row) => {
      updateModelState(horizonState.states.up, row.vector, row.up)
      updateModelState(horizonState.states.down, row.vector, row.down)
      updateModelState(horizonState.states.wait, row.vector, row.wait)
    })
    for (const horizonState of horizonStates) horizonState.trainRows = counts.get(horizonState.horizon) ?? 0
  }

  for (const horizonState of horizonStates) {
    for (const direction of ['up', 'down', 'wait'] as PhysicsDirection[]) resetMetrics(horizonState.states[direction])
  }
  await forEachMultiHorizonPage(horizonStates, dates, 'evaluate', (horizonState, row) => {
    evaluateModelState(horizonState.states.up, row.vector, row.up)
    evaluateModelState(horizonState.states.down, row.vector, row.down)
    evaluateModelState(horizonState.states.wait, row.vector, row.wait)
  })

  const statements: Array<{ sql: string; args: Array<string | number> }> = []
  for (const horizonState of horizonStates) {
    const baseMetrics = {
      mode: 'all_paged_multi',
      requestedMode: SAMPLE_MODE,
      trainStartDate: START_DATE,
      trainEndDate: horizonState.trainEndDate,
      limit: 0,
      perYearLimit: 0,
      pageDates: PAGE_DATES,
      dateCount: dates.filter((date) => date <= horizonState.trainEndDate).length,
      trainRows: horizonState.trainRows,
      featureSet: ML_PHYSICS_FEATURE_SET,
      featureVersion: ML_PHYSICS_VERSION,
      featureCount: ML_PHYSICS_FEATURE_NAMES.length,
    }
    for (const direction of ['up', 'down', 'wait'] as PhysicsDirection[]) {
      const model = finalizeModelState(horizonState.states[direction], baseMetrics)
      const modelName = `ma_physics_v${ML_PHYSICS_VERSION}_${direction}_h${horizonState.horizon}_${MODEL_VERSION}`
      statements.push({
        sql: `
          INSERT OR REPLACE INTO ml_models
            (model_name, model_type, direction, horizon_days, feature_names_json, weights_json, intercept, metrics_json, trained_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        `,
        args: [
          modelName,
          ML_PHYSICS_MODEL_TYPE,
          direction,
          horizonState.horizon,
          JSON.stringify(ML_PHYSICS_FEATURE_NAMES),
          JSON.stringify(model.weights),
          model.intercept,
          JSON.stringify(model.metrics),
        ],
      })
      console.log(`ml physics train horizon=${horizonState.horizon} direction=${direction}: rows=${Number(model.metrics.samples).toLocaleString()} cutoff=${horizonState.trainEndDate} acc=${model.metrics.accuracy}`)
    }
  }
  await execBatch(statements)
}

async function trainHorizon(horizon: number): Promise<void> {
  const trainEndDate = await confirmedCutoffDate(horizon)
  if (!trainEndDate) {
    console.log(`ml physics train horizon=${horizon}: skipped, no confirmed cutoff`)
    return
  }
  if (ALL_PAGED_MODE) {
    await trainHorizonAllPaged(horizon, trainEndDate)
    return
  }
  const rows = await loadRows(horizon, trainEndDate)
  const parsed = rows
    .map((row) => ({
      vector: parseVector(row.vector_json),
      up: row.up_label ? 1 : 0,
      down: row.down_label ? 1 : 0,
      wait: row.wait_label ? 1 : 0,
    }))
    .filter((row) => row.vector.length === ML_PHYSICS_FEATURE_NAMES.length)
  if (parsed.length === 0) {
    console.log(`ml physics train horizon=${horizon}: skipped, no rows before ${trainEndDate}`)
    return
  }

  const baseMetrics = {
    mode: SAMPLE_MODE,
    trainStartDate: START_DATE,
    trainEndDate,
    limit: LIMIT,
    perYearLimit: PER_YEAR_LIMIT,
    featureSet: ML_PHYSICS_FEATURE_SET,
    featureVersion: ML_PHYSICS_VERSION,
    featureCount: ML_PHYSICS_FEATURE_NAMES.length,
  }
  const statements: Array<{ sql: string; args: Array<string | number> }> = []
  for (const direction of ['up', 'down', 'wait'] as PhysicsDirection[]) {
    const model = train(parsed.map((row) => ({ vector: row.vector, label: row[direction] })))
    const modelName = `ma_physics_v${ML_PHYSICS_VERSION}_${direction}_h${horizon}_${MODEL_VERSION}`
    statements.push({
      sql: `
        INSERT OR REPLACE INTO ml_models
          (model_name, model_type, direction, horizon_days, feature_names_json, weights_json, intercept, metrics_json, trained_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        modelName,
        ML_PHYSICS_MODEL_TYPE,
        direction,
        horizon,
        JSON.stringify(ML_PHYSICS_FEATURE_NAMES),
        JSON.stringify(model.weights),
        model.intercept,
        JSON.stringify({ ...baseMetrics, ...model.metrics }),
      ],
    })
    console.log(`ml physics train horizon=${horizon} direction=${direction}: rows=${parsed.length.toLocaleString()} cutoff=${trainEndDate} acc=${model.metrics.accuracy}`)
  }
  await execBatch(statements)
}

async function main() {
  console.log(`ml physics train: version=${MODEL_VERSION}, mode=${SAMPLE_MODE}, limit=${LIMIT || 'all'}, per_year=${PER_YEAR_LIMIT || 'auto'}, page_dates=${PAGE_DATES}, start=${START_DATE}, end=${END_DATE ?? 'auto'}, horizons=${HORIZONS.join('/')}`)
  if (ALL_PAGED_MODE && HORIZONS.length > 1) {
    await trainAllHorizonsPaged()
    return
  }
  for (const horizon of HORIZONS) await trainHorizon(horizon)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

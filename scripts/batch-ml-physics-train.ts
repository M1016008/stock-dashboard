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
import {
  createModelState,
  evaluateModelState,
  finalizeModelState,
  labelMapKey,
  minDate,
  modelInsertStatement,
  parseVector,
  resetMetrics,
  timestampVersion,
  trainInMemory,
  trainingYears,
  updateModelState,
  type ModelState,
  type TrainedModel,
} from '@/lib/ml/online-logistic'

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
const FAST_YEARLY_SAMPLE = (process.env.ML_PHYSICS_TRAIN_FAST_YEARLY_SAMPLE ?? '1') !== '0'
const FAST_YEARLY_MODULO = Number(process.env.ML_PHYSICS_TRAIN_FAST_YEARLY_MODULO ?? 50)
const DIRECTIONS: PhysicsDirection[] = ['up', 'down', 'wait']

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

type ParsedTrainRow = {
  vector: number[]
  up: number
  down: number
  wait: number
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

function createDirectionStates(): Record<PhysicsDirection, ModelState> {
  return {
    up: createModelState(ML_PHYSICS_FEATURE_NAMES.length),
    down: createModelState(ML_PHYSICS_FEATURE_NAMES.length),
    wait: createModelState(ML_PHYSICS_FEATURE_NAMES.length),
  }
}

function modelStatement(direction: PhysicsDirection, horizon: number, model: TrainedModel) {
  return modelInsertStatement({
    modelName: `ma_physics_v${ML_PHYSICS_VERSION}_${direction}_h${horizon}_${MODEL_VERSION}`,
    modelType: ML_PHYSICS_MODEL_TYPE,
    direction,
    horizon,
    featureNames: ML_PHYSICS_FEATURE_NAMES,
    ...model,
  })
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
  const years = trainingYears(START_DATE, trainEndDate)
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
    const args: Array<string | number> = [horizon, ML_PHYSICS_FEATURE_SET, from, to]
    const fastSampleSql = FAST_YEARLY_SAMPLE && perYear > 0 && FAST_YEARLY_MODULO > 1
      ? `AND ((abs(f.rowid * 1009 + CAST(strftime('%j', f.date) AS INTEGER) * 917) % ?) = 0)`
      : ''
    if (fastSampleSql) args.push(FAST_YEARLY_MODULO)
    const orderSql = fastSampleSql
      ? ''
      : `ORDER BY ((CAST(f.ticker AS INTEGER) * 1009 + CAST(strftime('%j', f.date) AS INTEGER) * 917) % 1000003), f.date, f.ticker`
    const limitSql = perYear > 0 ? `LIMIT ?` : ''
    if (PER_YEAR_LIMIT > 0 && fastSampleSql && year === years[0]) {
      console.log(`ml physics train: fast yearly sample enabled modulo=${FAST_YEARLY_MODULO}`)
    } else if (PER_YEAR_LIMIT > 0 && FAST_YEARLY_SAMPLE && year === years[0]) {
      console.log('ml physics train: fast yearly sample enabled without extra modulo filter')
    }
    if (perYear > 0) args.push(perYear)
    rows.push(...await execAll<TrainRow>(
      `
      SELECT f.date, f.vector_json, l.up_label, l.down_label, l.wait_label
      FROM ml_feature_vectors_v2 f INDEXED BY ml_feature_vectors_v2_date_idx
      INNER JOIN ml_short_labels l INDEXED BY sqlite_autoindex_ml_short_labels_1
        ON l.ticker = f.ticker AND l.date = f.date AND l.horizon_days = ?
      WHERE f.feature_set = ?
        AND f.date >= ?
        AND f.date <= ?
        ${fastSampleSql}
      ${orderSql}
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
    SELECT DISTINCT date
    FROM ml_short_labels
    WHERE horizon_days = ?
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC
    `,
    [horizon, START_DATE, trainEndDate],
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

  const states = createDirectionStates()

  let trainRows = 0
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    trainRows = await forEachTrainingPage(horizon, dates, `epoch=${epoch + 1}/${EPOCHS}`, (row) => {
      for (const direction of DIRECTIONS) updateModelState(states[direction], row.vector, row[direction], LR)
    })
  }

  for (const direction of DIRECTIONS) resetMetrics(states[direction])
  await forEachTrainingPage(horizon, dates, 'evaluate', (row) => {
    for (const direction of DIRECTIONS) evaluateModelState(states[direction], row.vector, row[direction])
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
  for (const direction of DIRECTIONS) {
    const model = finalizeModelState(states[direction], baseMetrics, EPOCHS, LR)
    statements.push(modelStatement(direction, horizon, model))
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
    horizonStates.push({ horizon, trainEndDate, states: createDirectionStates(), trainRows: 0 })
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
      for (const direction of DIRECTIONS) updateModelState(horizonState.states[direction], row.vector, row[direction], LR)
    })
    for (const horizonState of horizonStates) horizonState.trainRows = counts.get(horizonState.horizon) ?? 0
  }

  for (const horizonState of horizonStates) {
    for (const direction of DIRECTIONS) resetMetrics(horizonState.states[direction])
  }
  await forEachMultiHorizonPage(horizonStates, dates, 'evaluate', (horizonState, row) => {
    for (const direction of DIRECTIONS) evaluateModelState(horizonState.states[direction], row.vector, row[direction])
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
    for (const direction of DIRECTIONS) {
      const model = finalizeModelState(horizonState.states[direction], baseMetrics, EPOCHS, LR)
      statements.push(modelStatement(direction, horizonState.horizon, model))
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
  const parsed = rows.map(parseTrainRow).filter((row): row is ParsedTrainRow => row !== null)
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
  for (const direction of DIRECTIONS) {
    const model = trainInMemory(parsed.map((row) => ({ vector: row.vector, label: row[direction] })), ML_PHYSICS_FEATURE_NAMES.length, EPOCHS, LR)
    statements.push(modelStatement(direction, horizon, { ...model, metrics: { ...baseMetrics, ...model.metrics } }))
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

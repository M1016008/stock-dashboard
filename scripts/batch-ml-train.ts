// scripts/batch-ml-train.ts
//
// 全期間のML特徴量と確定済みラベルから、未来情報を混ぜずに軽量モデルを世代保存する。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import { ML_FEATURE_NAMES } from '@/lib/backtest/ml'
import { ML_PRIMARY_HORIZON_LIST } from '@/lib/backtest/ml-horizons'
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
}

type FeaturePageRow = { ticker: string; date: string; vector_json: string }
type LabelPageRow = { ticker: string; date: string; horizon_days: number; up_label: number; down_label: number }
type Direction = 'up' | 'down'
type PagedHorizonState = {
  horizon: number
  trainEndDate: string
  states: Record<Direction, ModelState>
  trainRows: number
}

const HORIZONS = (process.env.ML_HORIZONS ?? ML_PRIMARY_HORIZON_LIST)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const LIMIT = Number(process.env.ML_TRAIN_LIMIT ?? 80000)
const START_DATE = process.env.ML_TRAIN_START_DATE?.trim() || '1900-01-01'
const END_DATE = process.env.ML_TRAIN_END_DATE?.trim() || null
const SAMPLE_MODE = (process.env.ML_TRAIN_SAMPLE_MODE ?? 'yearly').trim()
const ALL_PAGED_MODE = SAMPLE_MODE === 'all_paged'
const EPOCHS = Number(process.env.ML_TRAIN_EPOCHS ?? (ALL_PAGED_MODE ? 3 : 80))
const LR = Number(process.env.ML_TRAIN_LR ?? (ALL_PAGED_MODE ? 0.02 : 0.06))
const PER_YEAR_LIMIT = Number(process.env.ML_TRAIN_PER_YEAR_LIMIT ?? 0)
const PAGE_DATES = Math.max(1, Number(process.env.ML_TRAIN_PAGE_DATES ?? 20))
const LABEL_SOURCE = (process.env.ML_TRAIN_LABEL_SOURCE ?? 'extrema').trim()
const MODEL_VERSION = process.env.ML_MODEL_VERSION?.trim() || timestampVersion()
const DIRECTIONS: Direction[] = ['up', 'down']

type ParsedTrainRow = {
  vector: number[]
  up: number
  down: number
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

function parseTrainRow(row: TrainRow): ParsedTrainRow | null {
  const vector = parseVector(row.vector_json)
  if (vector.length !== ML_FEATURE_NAMES.length) return null
  return {
    vector,
    up: row.up_label ? 1 : 0,
    down: row.down_label ? 1 : 0,
  }
}

function createDirectionStates(): Record<Direction, ModelState> {
  return { up: createModelState(ML_FEATURE_NAMES.length), down: createModelState(ML_FEATURE_NAMES.length) }
}

function modelName(direction: Direction, horizon: number): string {
  return `ma_stage_${direction}_h${horizon}_${MODEL_VERSION}`
}

function modelStatement(direction: Direction, horizon: number, model: TrainedModel) {
  return modelInsertStatement({
    modelName: modelName(direction, horizon),
    modelType: 'logistic_regression_v1',
    direction,
    horizon,
    featureNames: ML_FEATURE_NAMES,
    ...model,
  })
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

async function loadTrainingDates(horizon: number, trainEndDate: string): Promise<string[]> {
  if (LABEL_SOURCE !== 'forward_returns') {
    const rows = await execAll<{ date: string }>(
      `
      SELECT date
      FROM forward_extrema_date_coverage
      WHERE horizon_days = ?
        AND date >= ?
        AND date <= ?
      ORDER BY date ASC
      `,
      [horizon, START_DATE, trainEndDate],
    )
    return rows.map((row) => row.date)
  }
  const rows = await execAll<{ date: string }>(
    `
    SELECT DISTINCT date
    FROM forward_returns
    WHERE horizon_days = ?
      AND date >= ?
      AND date <= ?
    ORDER BY date ASC
    `,
    [horizon, START_DATE, trainEndDate],
  )
  return rows.map((row) => row.date)
}

async function loadRowsForDates(horizon: number, dates: string[]): Promise<TrainRow[]> {
  if (dates.length === 0) return []
  const labelSql = labelJoinSql()
  const placeholders = dates.map(() => '?').join(', ')
  return execAll<TrainRow>(
    `
    SELECT f.date, f.vector_json, ${labelSql.select}
    FROM ml_feature_vectors f
    ${labelSql.join}
    WHERE ${labelSql.horizonColumn} = ?
      AND f.date IN (${placeholders})
    ORDER BY f.date ASC, f.ticker ASC
    `,
    [horizon, ...dates],
  )
}

async function loadFeatureRowsForDates(dates: string[]): Promise<FeaturePageRow[]> {
  if (dates.length === 0) return []
  return execAll<FeaturePageRow>(
    `SELECT ticker, date, vector_json
     FROM ml_feature_vectors
     WHERE date IN (${dates.map(() => '?').join(', ')})
     ORDER BY date ASC, ticker ASC`,
    dates,
  )
}

async function loadLabelRowsForDates(horizons: number[], dates: string[]): Promise<LabelPageRow[]> {
  if (horizons.length === 0 || dates.length === 0) return []
  return execAll<LabelPageRow>(
    `SELECT ticker, date, horizon_days, up_label, down_label
     FROM ml_training_labels
     WHERE horizon_days IN (${horizons.map(() => '?').join(', ')})
       AND date IN (${dates.map(() => '?').join(', ')})`,
    [...horizons, ...dates],
  )
}

async function loadMultiTrainingDates(horizons: number[], maxTrainEndDate: string): Promise<string[]> {
  const rows = await execAll<{ date: string }>(
    `SELECT DISTINCT date
     FROM forward_extrema_date_coverage
     WHERE horizon_days IN (${horizons.map(() => '?').join(', ')})
       AND date >= ? AND date <= ?
     ORDER BY date ASC`,
    [...horizons, START_DATE, maxTrainEndDate],
  )
  return rows.map((row) => row.date)
}

async function forEachMultiHorizonPage(
  horizonStates: PagedHorizonState[],
  dates: string[],
  phase: string,
  onRow: (horizonState: PagedHorizonState, row: ParsedTrainRow) => void,
): Promise<Map<number, number>> {
  const horizonList = horizonStates.map((state) => state.horizon)
  const counts = new Map<number, number>(horizonList.map((horizon) => [horizon, 0]))
  const totalPages = Math.ceil(dates.length / PAGE_DATES)
  for (let offset = 0; offset < dates.length; offset += PAGE_DATES) {
    const page = Math.floor(offset / PAGE_DATES) + 1
    const pageDates = dates.slice(offset, offset + PAGE_DATES)
    const [features, labels] = await Promise.all([
      loadFeatureRowsForDates(pageDates),
      loadLabelRowsForDates(horizonList, pageDates),
    ])
    const labelsByTickerDate = new Map<string, Map<number, LabelPageRow>>()
    for (const label of labels) {
      const key = labelMapKey(label.ticker, label.date)
      const existing = labelsByTickerDate.get(key)
      if (existing) existing.set(label.horizon_days, label)
      else labelsByTickerDate.set(key, new Map([[label.horizon_days, label]]))
    }
    for (const feature of features) {
      const vector = parseVector(feature.vector_json)
      if (vector.length !== ML_FEATURE_NAMES.length) continue
      const featureLabels = labelsByTickerDate.get(labelMapKey(feature.ticker, feature.date))
      if (!featureLabels) continue
      for (const horizonState of horizonStates) {
        if (feature.date > horizonState.trainEndDate) continue
        const label = featureLabels.get(horizonState.horizon)
        if (!label) continue
        counts.set(horizonState.horizon, (counts.get(horizonState.horizon) ?? 0) + 1)
        onRow(horizonState, {
          vector,
          up: label.up_label ? 1 : 0,
          down: label.down_label ? 1 : 0,
        })
      }
    }
    if (page === totalPages || page % 10 === 0) {
      const summary = horizonList.map((horizon) => `${horizon}:${(counts.get(horizon) ?? 0).toLocaleString()}`).join(' ')
      console.log(`ml train multi ${phase}: page=${page}/${totalPages}, rows=[${summary}], dates=${pageDates[0]}..${pageDates.at(-1)}`)
    }
  }
  return counts
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
        `ml train horizon=${horizon} ${phase}: page=${page}/${totalPages}, rows=${parsedRows.toLocaleString()}, dates=${pageDates[0]}..${pageDates.at(-1)}`,
      )
    }
  }
  return parsedRows
}

async function trainHorizonAllPaged(horizon: number, trainEndDate: string): Promise<void> {
  const dates = await loadTrainingDates(horizon, trainEndDate)
  if (dates.length === 0) {
    console.log(`ml train horizon=${horizon}: skipped, no training dates before ${trainEndDate}`)
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
    labelSource: LABEL_SOURCE,
    trainStartDate: START_DATE,
    trainEndDate,
    limit: 0,
    perYearLimit: 0,
    pageDates: PAGE_DATES,
    dateCount: dates.length,
    trainRows,
    featureCount: ML_FEATURE_NAMES.length,
  }
  const up = finalizeModelState(states.up, baseMetrics, EPOCHS, LR)
  const down = finalizeModelState(states.down, baseMetrics, EPOCHS, LR)

  await execBatch([modelStatement('up', horizon, up), modelStatement('down', horizon, down)])

  console.log(`ml train horizon=${horizon}: rows=${trainRows.toLocaleString()} cutoff=${trainEndDate} up=${modelName('up', horizon)} acc=${up.metrics.accuracy} down=${modelName('down', horizon)} acc=${down.metrics.accuracy}`)
}

async function trainAllHorizonsPaged(): Promise<void> {
  const horizonStates: PagedHorizonState[] = []
  for (const horizon of HORIZONS) {
    const trainEndDate = await confirmedCutoffDate(horizon)
    if (!trainEndDate) {
      console.log(`ml train horizon=${horizon}: skipped, no confirmed cutoff`)
      continue
    }
    horizonStates.push({ horizon, trainEndDate, states: createDirectionStates(), trainRows: 0 })
  }
  if (horizonStates.length === 0) return
  const maxTrainEndDate = horizonStates.map((state) => state.trainEndDate).sort().at(-1)
  if (!maxTrainEndDate) return
  const dates = await loadMultiTrainingDates(horizonStates.map((state) => state.horizon), maxTrainEndDate)
  if (dates.length === 0) {
    console.log(`ml train multi: skipped, no dates before ${maxTrainEndDate}`)
    return
  }

  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    const counts = await forEachMultiHorizonPage(horizonStates, dates, `epoch=${epoch + 1}/${EPOCHS}`, (state, row) => {
      for (const direction of DIRECTIONS) updateModelState(state.states[direction], row.vector, row[direction], LR)
    })
    for (const state of horizonStates) state.trainRows = counts.get(state.horizon) ?? 0
  }

  for (const state of horizonStates) {
    for (const direction of DIRECTIONS) resetMetrics(state.states[direction])
  }
  await forEachMultiHorizonPage(horizonStates, dates, 'evaluate', (state, row) => {
    for (const direction of DIRECTIONS) evaluateModelState(state.states[direction], row.vector, row[direction])
  })

  const statements: Array<{ sql: string; args: Array<string | number> }> = []
  for (const state of horizonStates) {
    const baseMetrics = {
      mode: 'all_paged_multi',
      requestedMode: SAMPLE_MODE,
      labelSource: LABEL_SOURCE,
      trainStartDate: START_DATE,
      trainEndDate: state.trainEndDate,
      limit: 0,
      perYearLimit: 0,
      pageDates: PAGE_DATES,
      dateCount: dates.filter((date) => date <= state.trainEndDate).length,
      trainRows: state.trainRows,
      featureCount: ML_FEATURE_NAMES.length,
    }
    for (const direction of DIRECTIONS) {
      const model = finalizeModelState(state.states[direction], baseMetrics, EPOCHS, LR)
      statements.push(modelStatement(direction, state.horizon, model))
      console.log(`ml train horizon=${state.horizon} direction=${direction}: rows=${Number(model.metrics.samples).toLocaleString()} cutoff=${state.trainEndDate} acc=${model.metrics.accuracy}`)
    }
  }
  await execBatch(statements)
}

async function trainHorizon(horizon: number): Promise<void> {
  const trainEndDate = await confirmedCutoffDate(horizon)
  if (!trainEndDate) {
    console.log(`ml train horizon=${horizon}: skipped, no confirmed cutoff`)
    return
  }
  if (ALL_PAGED_MODE) {
    await trainHorizonAllPaged(horizon, trainEndDate)
    return
  }
  const rows = await loadRows(horizon, trainEndDate)
  if (rows.length === 0) {
    console.log(`ml train horizon=${horizon}: skipped, no rows before ${trainEndDate}`)
    return
  }

  const parsed = rows.map(parseTrainRow).filter((row): row is ParsedTrainRow => row !== null)
  const up = trainInMemory(parsed.map((row) => ({ vector: row.vector, label: row.up })), ML_FEATURE_NAMES.length, EPOCHS, LR)
  const down = trainInMemory(parsed.map((row) => ({ vector: row.vector, label: row.down })), ML_FEATURE_NAMES.length, EPOCHS, LR)

  const baseMetrics = {
    mode: SAMPLE_MODE,
    labelSource: LABEL_SOURCE,
    trainStartDate: START_DATE,
    trainEndDate,
    limit: LIMIT,
    perYearLimit: PER_YEAR_LIMIT,
    featureCount: ML_FEATURE_NAMES.length,
  }

  await execBatch([
    modelStatement('up', horizon, { ...up, metrics: { ...baseMetrics, ...up.metrics } }),
    modelStatement('down', horizon, { ...down, metrics: { ...baseMetrics, ...down.metrics } }),
  ])

  console.log(`ml train horizon=${horizon}: rows=${parsed.length.toLocaleString()} cutoff=${trainEndDate} up=${modelName('up', horizon)} acc=${up.metrics.accuracy} down=${modelName('down', horizon)} acc=${down.metrics.accuracy}`)
}

async function main() {
  console.log(`ml train: version=${MODEL_VERSION}, mode=${SAMPLE_MODE}, label_source=${LABEL_SOURCE}, limit=${LIMIT || 'all'}, per_year=${PER_YEAR_LIMIT || 'auto'}, page_dates=${PAGE_DATES}, start=${START_DATE}, end=${END_DATE ?? 'auto'}, horizons=${HORIZONS.join('/')}`)
  if (ALL_PAGED_MODE && HORIZONS.length > 1 && LABEL_SOURCE !== 'forward_returns') {
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

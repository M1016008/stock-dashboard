// scripts/batch-ml-objective-validation.ts
//
// 現行 ma_physics 特徴量を、時系列分割で客観検証する。
// 学習: 過去のみ、検証/テスト: 未来の答え合わせのみ。株価データ本体は変更しない。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import { dot, sigmoid } from '@/lib/backtest/ml'
import {
  ML_PHYSICS_DEFAULT_HORIZON_LIST,
  ML_PHYSICS_FEATURE_NAMES,
  ML_PHYSICS_FEATURE_SET,
  ML_PHYSICS_MODEL_TYPE,
  ML_PHYSICS_VERSION,
  type PhysicsDirection,
} from '@/lib/backtest/ml-physics'

type Direction = Extract<PhysicsDirection, 'up' | 'down'>
type ObjectiveVariant = 'enhanced'
type MarketRegime = 'bull' | 'neutral' | 'bear'

type LabeledRow = {
  ticker: string
  date: string
  vector_json: string
  feature_json: string | null
  up_label: number
  down_label: number
  return_pct: number | null
  max_return_pct: number | null
  min_return_pct: number | null
  label_json: string | null
  sector17_name: string | null
  sector33_name: string | null
}

type ParsedRow = {
  ticker: string
  date: string
  vector: number[]
  up: number
  down: number
  returnPct: number
  maxReturnPct: number | null
  minReturnPct: number | null
  daysToMax: number | null
  daysToMin: number | null
  sector17Name: string
  sector33Name: string
  marketReturn20: number | null
  marketAboveSma25Rate: number | null
  marketRegime: MarketRegime
}

type ScoredRow = ParsedRow & {
  direction: Direction
  score: number
  hit: number
  adverse: number
  directionalReturnPct: number
  adverseMovePct: number | null
  daysToBestMove: number | null
}

type ModelState = {
  direction: Direction
  horizonDays: number
  weights: number[]
  intercept: number
}

const OBJECTIVE_VARIANT: ObjectiveVariant = 'enhanced'
const OBJECTIVE_MODE = 'objective_enhanced_holdout'
const OBJECTIVE_MODEL_TYPE = `${ML_PHYSICS_MODEL_TYPE}_${OBJECTIVE_MODE}`
const MARKET_RETURN_20_INDEX = ML_PHYSICS_FEATURE_NAMES.indexOf('marketReturn20')
const MARKET_ABOVE_SMA25_INDEX = ML_PHYSICS_FEATURE_NAMES.indexOf('marketAboveSma25Rate')

const DEFAULT_HORIZONS = ML_PHYSICS_DEFAULT_HORIZON_LIST
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 20)
  .join(',')

const HORIZONS = (process.env.ML_OBJECTIVE_HORIZONS ?? DEFAULT_HORIZONS)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const DIRECTIONS: Direction[] = ['up', 'down']

const TRAIN_START_DATE = process.env.ML_OBJECTIVE_TRAIN_START_DATE?.trim() || '2008-05-07'
const TRAIN_END_DATE = process.env.ML_OBJECTIVE_TRAIN_END_DATE?.trim() || '2021-12-31'
const VALIDATION_START_DATE = process.env.ML_OBJECTIVE_VALIDATION_START_DATE?.trim() || '2022-01-01'
const VALIDATION_END_DATE = process.env.ML_OBJECTIVE_VALIDATION_END_DATE?.trim() || '2023-12-31'
const TEST_START_DATE = process.env.ML_OBJECTIVE_TEST_START_DATE?.trim() || '2024-01-01'
const TEST_END_DATE = process.env.ML_OBJECTIVE_TEST_END_DATE?.trim() || null

const TRAIN_PER_YEAR_LIMIT = Math.max(0, Number(process.env.ML_OBJECTIVE_TRAIN_PER_YEAR_LIMIT ?? 3000))
const EVAL_PER_YEAR_LIMIT = Math.max(0, Number(process.env.ML_OBJECTIVE_EVAL_PER_YEAR_LIMIT ?? 8000))
const EPOCHS = Math.max(1, Number(process.env.ML_OBJECTIVE_EPOCHS ?? 5))
const LR = Number(process.env.ML_OBJECTIVE_LR ?? 0.03)

function parseVector(value: string): number[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => Number(item) || 0) : []
  } catch {
    return []
  }
}

function parseLabelJson(value: string | null): { daysToMax: number | null; daysToMin: number | null } {
  try {
    const parsed = value ? JSON.parse(value) as Record<string, unknown> : {}
    const daysToMax = Number(parsed.daysToMax)
    const daysToMin = Number(parsed.daysToMin)
    return {
      daysToMax: Number.isFinite(daysToMax) ? daysToMax : null,
      daysToMin: Number.isFinite(daysToMin) ? daysToMin : null,
    }
  } catch {
    return { daysToMax: null, daysToMin: null }
  }
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(value) as unknown : null
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function numberFromUnknown(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function round(value: number | null | undefined, digits = 6): number | null {
  if (!finiteNumber(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function yearsBetween(startDate: string, endDate: string): number[] {
  const start = Number(startDate.slice(0, 4))
  const end = Number(endDate.slice(0, 4))
  const years: number[] = []
  for (let year = start; year <= end; year += 1) years.push(year)
  return years
}

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a <= b ? a : b
}

function targetPct(horizonDays: number, direction: Direction): number {
  if (direction === 'up') {
    if (horizonDays <= 5) return 4
    if (horizonDays <= 10) return 6
    if (horizonDays <= 15) return 8
    if (horizonDays <= 20) return 10
    if (horizonDays <= 40) return 15
    if (horizonDays <= 60) return 20
    if (horizonDays <= 90) return 25
    return 30
  }
  if (horizonDays <= 5) return -3
  if (horizonDays <= 10) return -5
  if (horizonDays <= 15) return -7
  if (horizonDays <= 20) return -8
  if (horizonDays <= 40) return -12
  if (horizonDays <= 60) return -15
  if (horizonDays <= 90) return -20
  return -25
}

function marketRegimeFor(marketReturn20: number | null, marketAboveSma25Rate: number | null): MarketRegime {
  const marketReturn = marketReturn20 ?? 0
  const aboveRate = marketAboveSma25Rate ?? 50
  if (marketReturn >= 2 && aboveRate >= 55) return 'bull'
  if (marketReturn <= -3 || aboveRate <= 42) return 'bear'
  return 'neutral'
}

function marketContextFromFeatureJson(value: string | null, vector: number[]) {
  const feature = parseJsonObject(value)
  const context = feature.context != null && typeof feature.context === 'object' && !Array.isArray(feature.context)
    ? feature.context as Record<string, unknown>
    : {}
  const jsonMarketReturn20 = numberFromUnknown(context.marketReturn20)
  const jsonMarketAboveSma25Rate = numberFromUnknown(context.marketAboveSma25Rate)
  const vectorMarketReturn20 = MARKET_RETURN_20_INDEX >= 0
    ? (vector[MARKET_RETURN_20_INDEX] ?? 0) * 12
    : null
  const vectorMarketAboveSma25Rate = MARKET_ABOVE_SMA25_INDEX >= 0
    ? (vector[MARKET_ABOVE_SMA25_INDEX] ?? 0) * 50 + 50
    : null
  const marketReturn20 = jsonMarketReturn20 ?? vectorMarketReturn20
  const marketAboveSma25Rate = jsonMarketAboveSma25Rate ?? vectorMarketAboveSma25Rate
  return {
    marketReturn20,
    marketAboveSma25Rate,
    marketRegime: marketRegimeFor(marketReturn20, marketAboveSma25Rate),
  }
}

async function maxLabelDate(horizonDays: number): Promise<string | null> {
  return (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_short_labels WHERE horizon_days = ?`,
    [horizonDays],
  ))?.date ?? null
}

async function loadRowsForYear(
  horizonDays: number,
  from: string,
  to: string,
  limit: number,
): Promise<ParsedRow[]> {
  const args: Array<string | number> = [ML_PHYSICS_FEATURE_SET, horizonDays, from, to]
  const limitSql = limit > 0 ? 'LIMIT ?' : ''
  if (limit > 0) args.push(limit)
  const rows = await execAll<LabeledRow>(
    `
    SELECT f.ticker, f.date, f.vector_json, f.feature_json,
           l.up_label, l.down_label, l.return_pct, l.max_return_pct, l.min_return_pct, l.label_json,
           u.sector17_name, u.sector33_name
    FROM ml_feature_vectors_v2 f
    INNER JOIN ml_short_labels l ON l.ticker = f.ticker AND l.date = f.date
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE f.feature_set = ?
      AND l.horizon_days = ?
      AND f.date >= ?
      AND f.date <= ?
    ORDER BY ((CAST(f.ticker AS INTEGER) * 1009 + CAST(strftime('%j', f.date) AS INTEGER) * 917) % 1000003), f.date, f.ticker
    ${limitSql}
    `,
    args,
  )
  return rows
    .map((row) => {
      const vector = parseVector(row.vector_json)
      if (vector.length !== ML_PHYSICS_FEATURE_NAMES.length || !finiteNumber(row.return_pct)) return null
      const label = parseLabelJson(row.label_json)
      const marketContext = marketContextFromFeatureJson(row.feature_json, vector)
      return {
        ticker: row.ticker,
        date: row.date,
        vector,
        up: row.up_label ? 1 : 0,
        down: row.down_label ? 1 : 0,
        returnPct: row.return_pct,
        maxReturnPct: row.max_return_pct,
        minReturnPct: row.min_return_pct,
        daysToMax: label.daysToMax,
        daysToMin: label.daysToMin,
        sector17Name: row.sector17_name?.trim() || 'その他',
        sector33Name: row.sector33_name?.trim() || 'その他',
        ...marketContext,
      } satisfies ParsedRow
    })
    .filter((row): row is ParsedRow => row != null)
}

async function loadRowsByYear(
  horizonDays: number,
  startDate: string,
  endDate: string,
  perYearLimit: number,
): Promise<ParsedRow[]> {
  const out: ParsedRow[] = []
  for (const year of yearsBetween(startDate, endDate)) {
    const from = year === Number(startDate.slice(0, 4)) ? startDate : `${year}-01-01`
    const to = year === Number(endDate.slice(0, 4)) ? endDate : `${year}-12-31`
    if (from > to) continue
    out.push(...await loadRowsForYear(horizonDays, from, to, perYearLimit))
  }
  return out
}

function createModel(horizonDays: number, direction: Direction): ModelState {
  return {
    direction,
    horizonDays,
    weights: Array.from({ length: ML_PHYSICS_FEATURE_NAMES.length }, () => 0),
    intercept: 0,
  }
}

function downRiskHit(row: ParsedRow, horizonDays: number): number {
  const target = targetPct(horizonDays, 'down')
  return finiteNumber(row.minReturnPct) && row.minReturnPct <= target ? 1 : 0
}

function severeDrawdownBeforeTarget(row: ParsedRow, horizonDays: number): boolean {
  if (!finiteNumber(row.minReturnPct) || row.minReturnPct > targetPct(horizonDays, 'down')) return false
  if (!finiteNumber(row.daysToMin) || !finiteNumber(row.daysToMax)) return true
  return row.daysToMin < row.daysToMax
}

function cleanUpHit(row: ParsedRow, horizonDays: number): number {
  return finiteNumber(row.maxReturnPct)
    && row.maxReturnPct >= targetPct(horizonDays, 'up')
    && !severeDrawdownBeforeTarget(row, horizonDays)
    ? 1
    : 0
}

function labelFor(row: ParsedRow, model: ModelState): number {
  return model.direction === 'up'
    ? cleanUpHit(row, model.horizonDays)
    : downRiskHit(row, model.horizonDays)
}

function adverseFor(row: ParsedRow, model: ModelState): number {
  return model.direction === 'up'
    ? downRiskHit(row, model.horizonDays)
    : cleanUpHit(row, model.horizonDays)
}

function trainModels(horizonDays: number, rows: ParsedRow[]): ModelState[] {
  const models = DIRECTIONS.map((direction) => createModel(horizonDays, direction))
  for (let epoch = 0; epoch < EPOCHS; epoch += 1) {
    for (const row of rows) {
      for (const model of models) {
        const label = labelFor(row, model)
        const pred = sigmoid(model.intercept + dot(model.weights, row.vector))
        const error = pred - label
        model.intercept -= LR * error
        for (let i = 0; i < model.weights.length; i += 1) {
          model.weights[i] -= LR * error * (row.vector[i] ?? 0)
        }
      }
    }
  }
  return models
}

function scoreRows(model: ModelState, rows: ParsedRow[]): ScoredRow[] {
  return rows
    .map((row) => ({
      ...row,
      direction: model.direction,
      score: sigmoid(model.intercept + dot(model.weights, row.vector)),
      hit: labelFor(row, model),
      adverse: adverseFor(row, model),
      directionalReturnPct: model.direction === 'up'
        ? row.maxReturnPct ?? row.returnPct
        : Math.abs(row.minReturnPct ?? row.returnPct),
      adverseMovePct: model.direction === 'up' ? row.minReturnPct : row.maxReturnPct,
      daysToBestMove: model.direction === 'up' ? row.daysToMax : row.daysToMin,
    }))
    .sort((a, b) => b.score - a.score)
}

function avg(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function summarizeSubset(rows: ScoredRow[]) {
  const returns = rows.map((row) => row.returnPct).filter(Number.isFinite)
  const directionalReturns = rows.map((row) => row.directionalReturnPct).filter(Number.isFinite)
  const drawdowns = rows.map((row) => row.minReturnPct).filter(finiteNumber)
  const adverseMoves = rows.map((row) => row.adverseMovePct).filter(finiteNumber)
  const daysToBest = rows
    .map((row) => row.daysToBestMove)
    .filter(finiteNumber)
  const direction = rows[0]?.direction ?? 'up'
  return {
    count: rows.length,
    hitRate: rows.length ? rows.filter((row) => row.hit).length / rows.length : null,
    adverseRate: rows.length ? rows.filter((row) => row.adverse).length / rows.length : null,
    avgReturnPct: avg(returns),
    medianReturnPct: median(returns),
    avgDirectionalReturnPct: avg(directionalReturns),
    medianDirectionalReturnPct: median(directionalReturns),
    maxDrawdownPct: drawdowns.length ? Math.min(...drawdowns) : null,
    maxAdverseMovePct: adverseMoves.length
      ? (direction === 'up' ? Math.min(...adverseMoves) : Math.max(...adverseMoves))
      : null,
    avgDaysToBestMove: avg(daysToBest),
  }
}

function topSectorSummary(rows: ScoredRow[], sectorType: '17' | '33') {
  const groups = new Map<string, ScoredRow[]>()
  for (const row of rows) {
    const key = sectorType === '17' ? row.sector17Name : row.sector33Name
    const group = groups.get(key) ?? []
    group.push(row)
    groups.set(key, group)
  }
  return Array.from(groups.entries())
    .map(([sectorName, group]) => ({
      sectorName,
      sampleCount: group.length,
      hitRate: summarizeSubset(group).hitRate,
      avgDirectionalReturnPct: summarizeSubset(group).avgDirectionalReturnPct,
    }))
    .sort((a, b) => (b.sampleCount - a.sampleCount) || ((b.hitRate ?? 0) - (a.hitRate ?? 0)))
    .slice(0, 8)
}

function regimeSummary(rows: ScoredRow[]) {
  const groups = new Map<MarketRegime, ScoredRow[]>()
  for (const row of rows) {
    const group = groups.get(row.marketRegime) ?? []
    group.push(row)
    groups.set(row.marketRegime, group)
  }
  return (['bull', 'neutral', 'bear'] as const)
    .map((regime) => {
      const group = groups.get(regime) ?? []
      const summary = summarizeSubset(group)
      return {
        regime,
        sampleCount: group.length,
        hitRate: summary.hitRate,
        adverseRate: summary.adverseRate,
        avgDirectionalReturnPct: summary.avgDirectionalReturnPct,
      }
    })
    .filter((item) => item.sampleCount > 0)
}

function summarize(scored: ScoredRow[]) {
  const top20 = scored.slice(0, 20)
  const top60 = scored.slice(0, 60)
  const top80 = scored.slice(0, 80)
  const baseline = summarizeSubset(scored)
  const top20Summary = summarizeSubset(top20)
  const top60Summary = summarizeSubset(top60)
  const top80Summary = summarizeSubset(top80)
  const lift = baseline.hitRate && top60Summary.hitRate != null
    ? top60Summary.hitRate / baseline.hitRate
    : null
  return {
    sampleCount: scored.length,
    baseline,
    top20: top20Summary,
    top60: top60Summary,
    top80: top80Summary,
    liftTop60VsBaseline: lift,
    liftTop60PctPoint: top60Summary.hitRate != null && baseline.hitRate != null
      ? top60Summary.hitRate - baseline.hitRate
      : null,
    marketRegimesTop60: regimeSummary(top60),
    sectors17Top60: topSectorSummary(top60, '17'),
    sectors33Top60: topSectorSummary(top60, '33'),
    topSamples: top60.slice(0, 12).map((row) => ({
      ticker: row.ticker,
      date: row.date,
      score: round(row.score, 4),
      returnPct: round(row.returnPct, 2),
      maxReturnPct: round(row.maxReturnPct, 2),
      minReturnPct: round(row.minReturnPct, 2),
      hit: Boolean(row.hit),
      adverse: Boolean(row.adverse),
      sector17Name: row.sector17Name,
      sector33Name: row.sector33Name,
      marketRegime: row.marketRegime,
      marketReturn20: round(row.marketReturn20, 2),
      marketAboveSma25Rate: round(row.marketAboveSma25Rate, 2),
    })),
  }
}

async function validationStatements(
  horizonDays: number,
  model: ModelState,
  split: 'validation' | 'test',
  rows: ParsedRow[],
  trainRows: number,
  splitStart: string,
  splitEnd: string,
) {
  const scored = scoreRows(model, rows)
  const summary = summarize(scored)
  const modelType = OBJECTIVE_MODEL_TYPE
  const modelName = `objective_enhanced_${ML_PHYSICS_FEATURE_SET}_${model.direction}_h${horizonDays}`
  const evaluationId = `${modelName}:${split}:${TRAIN_END_DATE}:${splitStart}:${splitEnd}`
  return {
    sql: `
      INSERT OR REPLACE INTO ml_model_evaluations
        (evaluation_id, model_name, model_type, direction, horizon_days, evaluation_date,
         train_start_date, train_end_date, validation_start_date, validation_end_date,
         sample_count, precision_at_20, precision_at_50, precision_at_80, hit_rate,
         median_return_pct, avg_return_pct, max_drawdown_pct, metrics_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    `,
    args: [
      evaluationId,
      modelName,
      modelType,
      model.direction,
      horizonDays,
      splitEnd,
      TRAIN_START_DATE,
      TRAIN_END_DATE,
      splitStart,
      splitEnd,
      summary.sampleCount,
      round(summary.top20.hitRate),
      round(summary.top60.hitRate),
      round(summary.top80.hitRate),
      round(summary.baseline.hitRate),
      round(summary.top60.medianReturnPct, 4),
      round(summary.top60.avgReturnPct, 4),
      round(summary.top60.maxDrawdownPct, 4),
      JSON.stringify({
        mode: OBJECTIVE_MODE,
        variant: OBJECTIVE_VARIANT,
        split,
        featureSet: ML_PHYSICS_FEATURE_SET,
        featureVersion: ML_PHYSICS_VERSION,
        modelType,
        horizonDays,
        direction: model.direction,
        targetPct: targetPct(horizonDays, model.direction),
        labelDefinitions: {
          up: {
            hit: 'max_return_pct reaches the horizon target and no severe drawdown occurs before target day',
            targetPct: targetPct(horizonDays, 'up'),
            drawdownGuardPct: targetPct(horizonDays, 'down'),
          },
          down: {
            hit: 'min_return_pct reaches the drawdown threshold at any point in the horizon',
            targetPct: targetPct(horizonDays, 'down'),
          },
          volume: 'excluded',
        },
        marketRegimeDefinition: {
          bull: 'marketReturn20 >= 2 and marketAboveSma25Rate >= 55',
          bear: 'marketReturn20 <= -3 or marketAboveSma25Rate <= 42',
          neutral: 'other or missing context',
        },
        train: {
          startDate: TRAIN_START_DATE,
          endDate: TRAIN_END_DATE,
          sampleCount: trainRows,
          perYearLimit: TRAIN_PER_YEAR_LIMIT,
          epochs: EPOCHS,
          lr: LR,
        },
        evaluation: {
          startDate: splitStart,
          endDate: splitEnd,
          perYearLimit: EVAL_PER_YEAR_LIMIT,
        },
        ...summary,
      }),
    ],
  }
}

async function main() {
  if (HORIZONS.length === 0) {
    console.log('ml objective validation: no horizons')
    return
  }
  const statements: Awaited<ReturnType<typeof validationStatements>>[] = []
  for (const horizonDays of HORIZONS) {
    const latestLabelDate = await maxLabelDate(horizonDays)
    const testEnd = minDate(TEST_END_DATE, latestLabelDate)
    if (!testEnd || testEnd < TEST_START_DATE) {
      console.log(`ml objective validation: skip h${horizonDays}, no confirmed test labels`)
      continue
    }
    const [trainRows, validationRows, testRows] = await Promise.all([
      loadRowsByYear(horizonDays, TRAIN_START_DATE, TRAIN_END_DATE, TRAIN_PER_YEAR_LIMIT),
      loadRowsByYear(horizonDays, VALIDATION_START_DATE, VALIDATION_END_DATE, EVAL_PER_YEAR_LIMIT),
      loadRowsByYear(horizonDays, TEST_START_DATE, testEnd, EVAL_PER_YEAR_LIMIT),
    ])
    if (trainRows.length === 0 || validationRows.length === 0 || testRows.length === 0) {
      console.log(
        `ml objective validation: skip h${horizonDays}, train=${trainRows.length}, validation=${validationRows.length}, test=${testRows.length}`,
      )
      continue
    }
    const models = trainModels(horizonDays, trainRows)
    for (const model of models) {
      statements.push(await validationStatements(
        horizonDays,
        model,
        'validation',
        validationRows,
        trainRows.length,
        VALIDATION_START_DATE,
        VALIDATION_END_DATE,
      ))
      statements.push(await validationStatements(
        horizonDays,
        model,
        'test',
        testRows,
        trainRows.length,
        TEST_START_DATE,
        testEnd,
      ))
    }
    console.log(
      `ml objective validation ${OBJECTIVE_VARIANT} h${horizonDays}: train=${trainRows.length.toLocaleString()}, validation=${validationRows.length.toLocaleString()}, test=${testRows.length.toLocaleString()}, testEnd=${testEnd}`,
    )
    if (statements.length >= 20) await execBatch(statements.splice(0, statements.length))
  }
  if (statements.length > 0) await execBatch(statements)
  console.log(`ml objective validation ${OBJECTIVE_VARIANT} complete`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

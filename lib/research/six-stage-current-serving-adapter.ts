import crypto from 'node:crypto'
import {
  CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
  CURRENT_SERVING_PROJECTION_MAX_ROWS,
  CURRENT_SERVING_PROJECTION_MIN_AUXILIARY_COVERAGE,
  CURRENT_SERVING_SMA_PERIODS,
  type CurrentServingMarket,
  type CurrentServingProjectionRow,
  type CurrentServingSmaPeriod,
} from '@/lib/research/six-stage-current-serving-projection'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

const STAGE = /^[1-6]{6}$/
export const CURRENT_SERVING_PRICE_BASIS = {
  JP: 'jp-split-normalized-v1',
  US: US_ADJUSTED_PRICE_BASIS,
} as const

export type CurrentServingQuery = <T extends Record<string, unknown>>(
  sql: string,
  args?: readonly (string | number | null)[],
) => Promise<T[]>

export type CurrentServingWatermark = {
  market: CurrentServingMarket
  asOfTradingDate: string
  sourceGeneration: string
  priceBasis: string
  featureSet: string
  snapshotRows: number
  eligibleRows: number
  universeRows: number
  universeIdentityRows: number
  closeRows: number
  mlRows: number
  smaRows: number
  physicalRows: number
}

export type CurrentServingSourceSma = {
  value: number | null
  slope: number | null
  curvature: number | null
}

export type CurrentServingSourceRecord = {
  market: CurrentServingMarket
  ticker: string
  companyName: string
  asOfTradingDate: string
  sourceGeneration: string
  currentStage: string
  previousStage: string | null
  priorStage: string | null
  cAge: number | null
  close: number | null
  sma: Record<CurrentServingSmaPeriod, CurrentServingSourceSma>
  convergence: {
    sma25To75: number | null
    sma75To150: number | null
    sma150To200: number | null
    sma200To300: number | null
  }
  physical: {
    velocity: number | null
    acceleration: number | null
    momentum: number | null
    force: number | null
    energy: number | null
    pms: number | null
    pfs: number | null
    pes: number | null
  }
}

type WatermarkRow = {
  snapshotDate: unknown
  snapshotRows: unknown
  snapshotComputedAt: unknown
  eligibleRows: unknown
  universeRows: unknown
  universeIdentityRows: unknown
  closeRows: unknown
  mlDate: unknown
  mlRows: unknown
  mlComputedAt: unknown
  smaDate: unknown
  smaRows: unknown
  smaComputedAt: unknown
  physicalDate: unknown
  physicalRows: unknown
  physicalComputedAt: unknown
}

type AdapterRow = Record<string, unknown> & {
  ticker: unknown
  companyName: unknown
  asOfTradingDate: unknown
  currentStage: unknown
  previousStage: unknown
  priorStage: unknown
  cAge: unknown
  mlStage: unknown
  historyTruncated: unknown
  currentRegimeLength: unknown
  close: unknown
}

export type LoadCurrentServingMarketOptions = {
  market: CurrentServingMarket
  query: CurrentServingQuery
  priceBasis: string
  featureSet: string
  deadlineMs: number
  maxRows?: number
  minRows?: number
  minAuxiliaryCoverage?: number
  now?: () => number
}

export async function assertCurrentServingProjectionUpdateLock(input: {
  market: CurrentServingMarket
  owner: string
  query: CurrentServingQuery
}): Promise<void> {
  const jobType = input.market === 'JP' ? 'update_latest' : 'us_update_latest'
  if (!input.owner.startsWith(`${jobType}:`)) throw new Error('CURRENT_PROJECTION_UPDATE_LOCK_OWNER_INVALID')
  const rows = await input.query<{ active: unknown }>(
    `SELECT 1 AS active
     FROM update_locks
     WHERE job_type = ?
       AND owner = ?
       AND status = 'running'
       AND lease_expires_at > unixepoch()
     LIMIT 1`,
    [jobType, input.owner],
  )
  if (integer(rows[0]?.active) !== 1) throw new Error('CURRENT_PROJECTION_UPDATE_LOCK_NOT_HELD')
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function integer(value: unknown): number | null {
  const number = finite(value)
  return number !== null && Number.isInteger(number) ? number : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function stage(value: unknown): string | null {
  const normalized = text(value)
  return normalized && STAGE.test(normalized) ? normalized : null
}

function assertDeadline(deadlineMs: number, now: () => number): void {
  if (now() >= deadlineMs) throw new Error('CURRENT_PROJECTION_DEADLINE_EXCEEDED')
}

function generationFor(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function adapterWatermarkSql(): string {
  return `
    WITH snapshot_max AS (
      SELECT MAX(date) AS date FROM daily_snapshots
    ), active_universe AS (
      SELECT ticker, name
      FROM ticker_universe
      WHERE active = 1
    ), eligible_current AS (
      SELECT snapshot.ticker
      FROM daily_snapshots snapshot
      INNER JOIN active_universe universe ON universe.ticker = snapshot.ticker
      CROSS JOIN snapshot_max
      WHERE snapshot.date = snapshot_max.date
        AND snapshot.daily_a_stage BETWEEN 1 AND 6
        AND snapshot.daily_b_stage BETWEEN 1 AND 6
        AND snapshot.weekly_a_stage BETWEEN 1 AND 6
        AND snapshot.weekly_b_stage BETWEEN 1 AND 6
        AND snapshot.monthly_a_stage BETWEEN 1 AND 6
        AND snapshot.monthly_b_stage BETWEEN 1 AND 6
    ), ml_max AS (
      SELECT MAX(date) AS date FROM ml_feature_vectors_v2 WHERE feature_set = ?
    ), sma_max AS (
      SELECT MAX(date) AS date FROM feature_snapshots WHERE timescale = 'daily'
    ), physical_max AS (
      SELECT MAX(date) AS date FROM physical_momentum_metrics WHERE market = ?
    )
    SELECT
      snapshot_max.date AS snapshotDate,
      (SELECT COUNT(*) FROM daily_snapshots WHERE date = snapshot_max.date) AS snapshotRows,
      (SELECT MAX(computed_at) FROM daily_snapshots WHERE date = snapshot_max.date) AS snapshotComputedAt,
      (SELECT COUNT(*) FROM eligible_current) AS eligibleRows,
      (SELECT COUNT(*) FROM active_universe) AS universeRows,
      (SELECT COUNT(*) FROM eligible_current current
       INNER JOIN active_universe universe ON universe.ticker = current.ticker
       WHERE TRIM(universe.name) <> '') AS universeIdentityRows,
      (SELECT COUNT(*)
       FROM eligible_current current
       INNER JOIN ohlcv_daily prices
         ON prices.ticker = current.ticker
        AND prices.date = snapshot_max.date
        AND prices.close IS NOT NULL) AS closeRows,
      ml_max.date AS mlDate,
      (SELECT COUNT(*)
       FROM eligible_current current
       INNER JOIN ml_feature_vectors_v2 vectors
         ON vectors.ticker = current.ticker
        AND vectors.feature_set = ?
        AND vectors.date = snapshot_max.date) AS mlRows,
      (SELECT MAX(vectors.computed_at)
       FROM eligible_current current
       INNER JOIN ml_feature_vectors_v2 vectors
         ON vectors.ticker = current.ticker
        AND vectors.feature_set = ?
        AND vectors.date = snapshot_max.date) AS mlComputedAt,
      sma_max.date AS smaDate,
      (SELECT COUNT(*)
       FROM eligible_current current
       INNER JOIN feature_snapshots features
         ON features.ticker = current.ticker
        AND features.timescale = 'daily'
        AND features.date = snapshot_max.date) AS smaRows,
      (SELECT MAX(features.computed_at)
       FROM eligible_current current
       INNER JOIN feature_snapshots features
         ON features.ticker = current.ticker
        AND features.timescale = 'daily'
        AND features.date = snapshot_max.date) AS smaComputedAt,
      physical_max.date AS physicalDate,
      (SELECT COUNT(*)
       FROM eligible_current current
       INNER JOIN physical_momentum_metrics physical
         ON physical.symbol = current.ticker
        AND physical.market = ?
        AND physical.date = snapshot_max.date) AS physicalRows,
      (SELECT MAX(physical.updated_at)
       FROM eligible_current current
       INNER JOIN physical_momentum_metrics physical
         ON physical.symbol = current.ticker
        AND physical.market = ?
        AND physical.date = snapshot_max.date) AS physicalComputedAt
    FROM snapshot_max, ml_max, sma_max, physical_max
  `
}

export function currentServingAdapterRowsSql(maxRows: number): string {
  const stageCode = (alias: string) => `
    CASE WHEN ${alias}.daily_a_stage BETWEEN 1 AND 6
      AND ${alias}.daily_b_stage BETWEEN 1 AND 6
      AND ${alias}.weekly_a_stage BETWEEN 1 AND 6
      AND ${alias}.weekly_b_stage BETWEEN 1 AND 6
      AND ${alias}.monthly_a_stage BETWEEN 1 AND 6
      AND ${alias}.monthly_b_stage BETWEEN 1 AND 6
    THEN CAST(${alias}.daily_a_stage AS TEXT)
      || CAST(${alias}.daily_b_stage AS TEXT)
      || CAST(${alias}.weekly_a_stage AS TEXT)
      || CAST(${alias}.weekly_b_stage AS TEXT)
      || CAST(${alias}.monthly_a_stage AS TEXT)
      || CAST(${alias}.monthly_b_stage AS TEXT)
    ELSE NULL END
  `
  const priorStage = stageCode('prior')
  return `
    WITH RECURSIVE current_snapshots AS (
      SELECT ticker, date, ${stageCode('snapshot')} AS stage_code
      FROM daily_snapshots snapshot INDEXED BY snapshots_date_idx
      WHERE date = ?
    ), eligible_current AS (
      SELECT snapshots.ticker, snapshots.date, snapshots.stage_code
      FROM current_snapshots snapshots
      INNER JOIN ticker_universe universe
        ON universe.ticker = snapshots.ticker
       AND universe.active = 1
      WHERE snapshots.stage_code GLOB '[1-6][1-6][1-6][1-6][1-6][1-6]'
    ), history(ticker, depth, regime_rank, state, row_date, valid) AS (
      SELECT ticker, 1, 1, stage_code, date, 1
      FROM eligible_current
      UNION ALL
      SELECT
        history.ticker,
        history.depth + 1,
        CASE WHEN (${priorStage}) = history.state
          THEN history.regime_rank ELSE history.regime_rank + 1 END,
        ${priorStage},
        prior.date,
        CASE WHEN (${priorStage}) GLOB '[1-6][1-6][1-6][1-6][1-6][1-6]'
          AND julianday(history.row_date) - julianday(prior.date) BETWEEN 1 AND 60
          THEN 1 ELSE 0 END
      FROM history
      INNER JOIN daily_snapshots prior
        ON prior.ticker = history.ticker
       AND prior.date = (
         SELECT MAX(prior_index.date)
         FROM daily_snapshots prior_index
         WHERE prior_index.ticker = history.ticker
           AND prior_index.date < history.row_date
       )
      WHERE history.depth < 4096
        AND history.regime_rank < 3
        AND history.valid = 1
    ), regime_summary AS (
      SELECT ticker,
        MAX(CASE WHEN regime_rank = 2 AND valid = 1 THEN state END) AS previousStage,
        MAX(CASE WHEN regime_rank = 3 AND valid = 1 THEN state END) AS priorStage,
        MAX(CASE WHEN regime_rank = 1 AND valid = 1 THEN depth END) AS currentRegimeLength,
        MAX(CASE WHEN depth = 4096 AND regime_rank < 3 AND valid = 1 THEN 1 ELSE 0 END) AS historyTruncated
      FROM history
      GROUP BY ticker
    )
    SELECT
      current.ticker AS ticker,
      universe.name AS companyName,
      current.date AS asOfTradingDate,
      current.stage_code AS currentStage,
      regimes.previousStage AS previousStage,
      regimes.priorStage AS priorStage,
      json_extract(vectors.feature_json, '$.timeSince.stageCodeAge') AS cAge,
      vectors.stage_code AS mlStage,
      regimes.historyTruncated AS historyTruncated,
      regimes.currentRegimeLength AS currentRegimeLength,
      prices.close AS close,
      snapshots.ma_5 AS sma5Value,
      snapshots.ma_25 AS sma25Value,
      snapshots.ma_75 AS sma75Value,
      snapshots.ma_150 AS sma150Value,
      json_extract(vectors.feature_json, '$.sma.sma200') AS sma200Value,
      snapshots.ma_300 AS sma300Value,
      features.slope_m1 AS sma5Slope,
      features.slope_m2 AS sma25Slope,
      features.slope_m3 AS sma75Slope,
      features.slope_m4 AS sma150Slope,
      NULL AS sma200Slope,
      features.slope_m5 AS sma300Slope,
      features.accel_m1 AS sma5Curvature,
      features.accel_m2 AS sma25Curvature,
      features.accel_m3 AS sma75Curvature,
      features.accel_m4 AS sma150Curvature,
      NULL AS sma200Curvature,
      features.accel_m5 AS sma300Curvature,
      NULL AS sma25To75Convergence,
      NULL AS sma75To150Convergence,
      NULL AS sma150To200Convergence,
      NULL AS sma200To300Convergence,
      physical.velocity AS velocity,
      physical.acceleration AS acceleration,
      physical.momentum AS momentum,
      physical.force AS force,
      physical.energy AS energy,
      physical.physical_momentum_score AS pms,
      physical.physical_force_score AS pfs,
      physical.physical_energy_score AS pes
    FROM eligible_current current
    LEFT JOIN ticker_universe universe ON universe.ticker = current.ticker AND universe.active = 1
    INNER JOIN daily_snapshots snapshots ON snapshots.ticker = current.ticker AND snapshots.date = current.date
    LEFT JOIN ohlcv_daily prices ON prices.ticker = current.ticker AND prices.date = current.date
    LEFT JOIN ml_feature_vectors_v2 vectors
      ON vectors.feature_set = ? AND vectors.ticker = current.ticker AND vectors.date = current.date
    LEFT JOIN feature_snapshots features
      ON features.ticker = current.ticker AND features.date = current.date AND features.timescale = 'daily'
    LEFT JOIN physical_momentum_metrics physical
      ON physical.market = ? AND physical.symbol = current.ticker AND physical.date = current.date
    LEFT JOIN regime_summary regimes ON regimes.ticker = current.ticker
    ORDER BY current.ticker
    LIMIT ${maxRows + 1}
  `
}

function validateWatermark(input: {
  market: CurrentServingMarket
  row: WatermarkRow | undefined
  priceBasis: string
  featureSet: string
  minRows: number
  minAuxiliaryCoverage: number
}): CurrentServingWatermark {
  const snapshotDate = text(input.row?.snapshotDate)
  const mlDate = text(input.row?.mlDate)
  const smaDate = text(input.row?.smaDate)
  const physicalDate = text(input.row?.physicalDate)
  const snapshotRows = integer(input.row?.snapshotRows) ?? 0
  const eligibleRows = integer(input.row?.eligibleRows) ?? 0
  const universeRows = integer(input.row?.universeRows) ?? 0
  const universeIdentityRows = integer(input.row?.universeIdentityRows) ?? 0
  const closeRows = integer(input.row?.closeRows) ?? 0
  const mlRows = integer(input.row?.mlRows) ?? 0
  const smaRows = integer(input.row?.smaRows) ?? 0
  const physicalRows = integer(input.row?.physicalRows) ?? 0
  if (!snapshotDate) throw new Error('CURRENT_PROJECTION_SOURCE_DATE_MISSING')
  if (mlDate !== snapshotDate || smaDate !== snapshotDate || physicalDate !== snapshotDate) {
    throw new Error('CURRENT_PROJECTION_SOURCE_DATE_MISMATCH')
  }
  if (
    !Number.isSafeInteger(input.minRows)
    || input.minRows < 1
    || !Number.isFinite(input.minAuxiliaryCoverage)
    || input.minAuxiliaryCoverage <= 0
    || input.minAuxiliaryCoverage > 1
  ) {
    throw new Error('CURRENT_PROJECTION_INVALID_COVERAGE_POLICY')
  }
  const minimumAuxiliaryRows = Math.ceil(eligibleRows * input.minAuxiliaryCoverage)
  if (
    snapshotRows < input.minRows
    || eligibleRows < input.minRows
    || universeRows !== eligibleRows
    || universeIdentityRows !== eligibleRows
    || closeRows !== eligibleRows
    || mlRows < minimumAuxiliaryRows
    || smaRows < minimumAuxiliaryRows
    || physicalRows < minimumAuxiliaryRows
  ) {
    throw new Error('CURRENT_PROJECTION_SOURCE_INCOMPLETE')
  }
  const identity = {
    market: input.market,
    asOfTradingDate: snapshotDate,
    priceBasis: input.priceBasis,
    featureSet: input.featureSet,
    snapshotRows,
    eligibleRows,
    universeRows,
    universeIdentityRows,
    closeRows,
    snapshotComputedAt: integer(input.row?.snapshotComputedAt),
    mlRows,
    mlComputedAt: integer(input.row?.mlComputedAt),
    smaRows,
    smaComputedAt: integer(input.row?.smaComputedAt),
    physicalRows,
    physicalComputedAt: integer(input.row?.physicalComputedAt),
  }
  if (
    identity.snapshotComputedAt === null
    || identity.mlComputedAt === null
    || identity.smaComputedAt === null
    || identity.physicalComputedAt === null
  ) {
    throw new Error('CURRENT_PROJECTION_SOURCE_GENERATION_INCOMPLETE')
  }
  return {
    market: input.market,
    asOfTradingDate: snapshotDate,
    sourceGeneration: `${input.market.toLowerCase()}-${snapshotDate}-${generationFor(identity).slice(0, 24)}`,
    priceBasis: input.priceBasis,
    featureSet: input.featureSet,
    snapshotRows,
    eligibleRows,
    universeRows,
    universeIdentityRows,
    closeRows,
    mlRows,
    smaRows,
    physicalRows,
  }
}

async function readWatermark(options: LoadCurrentServingMarketOptions): Promise<CurrentServingWatermark> {
  const expectedPriceBasis = CURRENT_SERVING_PRICE_BASIS[options.market]
  if (options.priceBasis !== expectedPriceBasis) {
    throw new Error('CURRENT_PROJECTION_PRICE_BASIS_CONTRACT_MISMATCH')
  }
  if (options.market === 'US') {
    const sourceBasis = await options.query<{ value: unknown }>(
      `SELECT value FROM us_analytics_metadata WHERE key = 'ohlcv_price_basis' LIMIT 1`,
    )
    if (text(sourceBasis[0]?.value) !== expectedPriceBasis) {
      throw new Error('CURRENT_PROJECTION_SOURCE_PRICE_BASIS_MISMATCH')
    }
  }
  const rows = await options.query<WatermarkRow>(adapterWatermarkSql(), [
    options.featureSet,
    options.market,
    options.featureSet,
    options.featureSet,
    options.market,
    options.market,
  ])
  return validateWatermark({
    market: options.market,
    row: rows[0],
    priceBasis: options.priceBasis,
    featureSet: options.featureSet,
    minRows: options.minRows ?? 1,
    minAuxiliaryCoverage:
      options.minAuxiliaryCoverage ?? CURRENT_SERVING_PROJECTION_MIN_AUXILIARY_COVERAGE,
  })
}

function sourceSma(row: AdapterRow, period: CurrentServingSmaPeriod): CurrentServingSourceSma {
  return {
    value: finite(row[`sma${period}Value`]),
    slope: finite(row[`sma${period}Slope`]),
    curvature: finite(row[`sma${period}Curvature`]),
  }
}

function sourceRecord(
  market: CurrentServingMarket,
  watermark: CurrentServingWatermark,
  row: AdapterRow,
): CurrentServingSourceRecord {
  const ticker = text(row.ticker)
  const companyName = text(row.companyName)
  const asOfTradingDate = text(row.asOfTradingDate)
  const currentStage = stage(row.currentStage)
  if (!ticker || !companyName || !asOfTradingDate || !currentStage) {
    throw new Error('CURRENT_PROJECTION_SOURCE_ROW_INVALID')
  }
  if (asOfTradingDate !== watermark.asOfTradingDate) {
    throw new Error('CURRENT_PROJECTION_GENERATION_MISMATCH')
  }
  if (integer(row.historyTruncated) === 1) {
    throw new Error('CURRENT_PROJECTION_REGIME_HISTORY_TRUNCATED')
  }
  const mlStage = stage(row.mlStage)
  if (mlStage !== null && mlStage !== currentStage) {
    throw new Error('CURRENT_PROJECTION_ML_STAGE_MISMATCH')
  }
  const cAgePresent = row.cAge !== null && row.cAge !== undefined
  if (mlStage === null && cAgePresent) {
    throw new Error('CURRENT_PROJECTION_ML_STAGE_MISSING')
  }
  const cAge = mlStage === currentStage && cAgePresent ? integer(row.cAge) : null
  const currentRegimeLength = integer(row.currentRegimeLength)
  if (cAgePresent && (cAge === null || cAge < 1 || currentRegimeLength === null || cAge !== currentRegimeLength)) {
    throw new Error('CURRENT_PROJECTION_C_AGE_CONTINUITY_MISMATCH')
  }
  return {
    market,
    ticker,
    companyName,
    asOfTradingDate,
    sourceGeneration: watermark.sourceGeneration,
    currentStage,
    previousStage: text(row.previousStage),
    priorStage: text(row.priorStage),
    cAge,
    close: finite(row.close),
    sma: Object.fromEntries(CURRENT_SERVING_SMA_PERIODS.map((period) => [period, sourceSma(row, period)])) as CurrentServingSourceRecord['sma'],
    convergence: {
      sma25To75: finite(row.sma25To75Convergence),
      sma75To150: finite(row.sma75To150Convergence),
      sma150To200: finite(row.sma150To200Convergence),
      sma200To300: finite(row.sma200To300Convergence),
    },
    physical: {
      velocity: finite(row.velocity), acceleration: finite(row.acceleration),
      momentum: finite(row.momentum), force: finite(row.force), energy: finite(row.energy),
      pms: finite(row.pms), pfs: finite(row.pfs), pes: finite(row.pes),
    },
  }
}

export function deriveCurrentRegimeTransition(input: {
  currentStage: string
  previousStage: string | null
  priorStage: string | null
  cAge: number | null
}): CurrentServingProjectionRow['stage'] {
  if (!STAGE.test(input.currentStage)) throw new Error('CURRENT_PROJECTION_INVALID_STAGE')
  const previous = stage(input.previousStage)
  const prior = stage(input.priorStage)
  const cAge = input.cAge !== null && Number.isInteger(input.cAge) && input.cAge >= 1 ? input.cAge : null
  const sequence2 = previous && previous !== input.currentStage
    ? `${previous}>${input.currentStage}`
    : null
  const sequence3 = sequence2 && prior && prior !== previous
    ? `${prior}>${sequence2}`
    : null
  return { current: input.currentStage, sequence2, sequence3, cAge }
}

function percentGap(numerator: number | null, denominator: number | null): number | null {
  return numerator === null || denominator === null || denominator === 0
    ? null
    : numerator / denominator - 1
}

function angle(slope: number | null): number | null {
  // feature_snapshots stores a percent rate (1 = 1% per session).
  return slope === null ? null : Math.atan(slope) * 180 / Math.PI
}

export function adaptCurrentServingRecord(source: CurrentServingSourceRecord): CurrentServingProjectionRow {
  const sma = Object.fromEntries(CURRENT_SERVING_SMA_PERIODS.map((period) => {
    const feature = source.sma[period]
    const closeGap = percentGap(source.close, feature.value)
    const normalizedAngle = angle(feature.slope)
    const position = closeGap === null
      ? null
      : Math.abs(closeGap) <= 0.001 ? 'TOUCH' : closeGap > 0 ? 'ABOVE' : 'BELOW'
    return [period, {
      value: feature.value,
      closeGap,
      slope: feature.slope,
      normalizedAngle,
      curvature: feature.curvature,
      position,
      available: {
        value: feature.value !== null,
        closeGap: closeGap !== null,
        slope: feature.slope !== null,
        normalizedAngle: normalizedAngle !== null,
        curvature: feature.curvature !== null,
        position: position !== null,
      },
    }]
  })) as CurrentServingProjectionRow['sma']
  const distance = (left: CurrentServingSmaPeriod, right: CurrentServingSmaPeriod) => (
    percentGap(sma[left].value, sma[right].value)
  )
  const raw = {
    velocity: source.physical.velocity,
    acceleration: source.physical.acceleration,
    momentum: source.physical.momentum,
    force: source.physical.force,
    energy: source.physical.energy,
  }
  const official = { pms: source.physical.pms, pfs: source.physical.pfs, pes: source.physical.pes }
  return {
    market: source.market,
    ticker: source.ticker,
    companyName: source.companyName,
    asOfTradingDate: source.asOfTradingDate,
    sourceGeneration: source.sourceGeneration,
    definitionVersion: CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
    stage: deriveCurrentRegimeTransition(source),
    close: source.close,
    sma,
    smaShape: {
      order: CURRENT_SERVING_SMA_PERIODS.filter((period) => sma[period].value !== null)
        .sort((left, right) => (sma[right].value ?? -Infinity) - (sma[left].value ?? -Infinity)),
      pairDistance: {
        sma25To75: distance(25, 75),
        sma75To150: distance(75, 150),
        sma150To200: distance(150, 200),
        sma200To300: distance(200, 300),
      },
      convergence: { ...source.convergence },
    },
    physical: {
      raw,
      official,
      available: {
        velocity: raw.velocity !== null, acceleration: raw.acceleration !== null,
        momentum: raw.momentum !== null, force: raw.force !== null, energy: raw.energy !== null,
        pms: official.pms !== null, pfs: official.pfs !== null, pes: official.pes !== null,
      },
    },
  }
}

export async function loadCurrentServingMarketProjection(options: LoadCurrentServingMarketOptions): Promise<{
  watermark: CurrentServingWatermark
  rows: CurrentServingProjectionRow[]
}> {
  const now = options.now ?? Date.now
  const maxRows = options.maxRows ?? CURRENT_SERVING_PROJECTION_MAX_ROWS
  assertDeadline(options.deadlineMs, now)
  const before = await readWatermark(options)
  assertDeadline(options.deadlineMs, now)
  const rows = await options.query<AdapterRow>(currentServingAdapterRowsSql(maxRows), [
    before.asOfTradingDate,
    options.featureSet,
    options.market,
  ])
  if (rows.length === 0 || rows.length > maxRows) throw new Error('CURRENT_PROJECTION_ROW_LIMIT')
  if (rows.length !== before.eligibleRows) throw new Error('CURRENT_PROJECTION_SOURCE_COVERAGE_MISMATCH')
  const adapted = rows.map((row) => adaptCurrentServingRecord(sourceRecord(options.market, before, row)))
  assertDeadline(options.deadlineMs, now)
  const after = await readWatermark(options)
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('CURRENT_PROJECTION_SOURCE_GENERATION_CHANGED')
  }
  assertDeadline(options.deadlineMs, now)
  const rowIdentity = adapted.map(({ sourceGeneration: _sourceGeneration, ...row }) => row)
  const sourceGeneration = `${options.market.toLowerCase()}-${before.asOfTradingDate}-${generationFor({
    watermark: before,
    rows: rowIdentity,
  }).slice(0, 24)}`
  return {
    watermark: { ...before, sourceGeneration },
    rows: adapted.map((row) => ({ ...row, sourceGeneration })),
  }
}

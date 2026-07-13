// scripts/batch-physical-momentum.ts
//
// Physical Momentum Score (PMS) を市場横断で計算する。
// 通常運用も全期間を再評価する。既存データを先に消さず、UPSERTで更新して
// 長時間実行中でも画面が欠損データを拾わないようにする。

import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import {
  PHYSICAL_MOMENTUM_LOOKBACK_DAYS,
  composePhysicalMomentumScores,
  computePhysicalMomentumRawRows,
  meanAndStd,
  zScore,
  type PhysicalMomentumRawKey,
  type PhysicalMomentumRawRow,
} from '@/lib/physical-momentum'

type Market = 'JP' | 'US' | string

type PriceRow = {
  date: string
  close: number | null
  volume: number | null
}

type MetricRow = PhysicalMomentumRawRow & {
  symbol: string
}

type DbMetricRow = {
  symbol: string
  velocity: number | null
  acceleration: number | null
  momentum: number | null
  force: number | null
  maAngleAvg: number | null
  energy: number | null
}

const LOOKBACK_DAYS = Number(process.env.PMS_LOOKBACK_DAYS ?? PHYSICAL_MOMENTUM_LOOKBACK_DAYS)
const RECENT_DAYS = Number(process.env.PMS_RECENT_DAYS ?? 0)
const START_DATE = process.env.PMS_START_DATE?.trim() || null
const END_DATE = process.env.PMS_END_DATE?.trim() || null
const DELETE_EXISTING = process.env.PMS_DELETE_EXISTING === '1'
const MARKETS = (process.env.PMS_MARKETS ?? 'JP')
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean)
const OUTPUT_MARKET = process.env.PMS_OUTPUT_MARKET?.trim().toUpperCase() || null
const RUN_JOB_TYPE = process.env.PMS_RUN_JOB_TYPE?.trim() || 'physical_momentum'
const TICKER_FILTER = new Set(
  (process.env.PMS_TICKERS ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase().replace(/\.T$/, ''))
    .filter(Boolean),
)
const TICKER_OFFSET = Number(process.env.PMS_TICKER_OFFSET ?? 0)
const TICKER_LIMIT = Number(process.env.PMS_TICKER_LIMIT ?? 0)
const DATE_OFFSET = Number(process.env.PMS_DATE_OFFSET ?? 0)
const DATE_LIMIT = Number(process.env.PMS_DATE_LIMIT ?? 0)
const SKIP_RAW = process.env.PMS_SKIP_RAW === '1' || process.env.PMS_NORMALIZE_ONLY === '1'
const SKIP_NORMALIZE = process.env.PMS_SKIP_NORMALIZE === '1' || process.env.PMS_RAW_ONLY === '1'
const CHUNK = Number(process.env.PMS_BATCH_CHUNK ?? 400)
const LOG_EVERY = Number(process.env.PMS_LOG_EVERY ?? 250)

const RAW_KEYS: PhysicalMomentumRawKey[] = [
  'velocity',
  'acceleration',
  'momentum',
  'force',
  'maAngleAvg',
  'energy',
]

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function dbNumber(value: number | null | undefined): number | null {
  return isFiniteNumber(value) ? value : null
}

function dateDaysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function outputMarketFor(sourceMarket: Market): Market {
  return OUTPUT_MARKET || sourceMarket
}

function logLabelFor(sourceMarket: Market): string {
  const outputMarket = outputMarketFor(sourceMarket)
  return outputMarket === sourceMarket
    ? sourceMarket
    : `${outputMarket} source=ohlcv_daily`
}

function sourceTable(market: Market): {
  latestSql: string
  datesSql: (hasStart: boolean, recentDays: number) => string
  tickersSql: string
  rowsSql: (hasWarmup: boolean) => string
} {
  if (market === 'JP') {
    return {
      latestSql: 'SELECT MAX(date) AS latestDate FROM ohlcv_daily',
      datesSql: (hasStart, recentDays) => `
        SELECT date
        FROM (
          SELECT DISTINCT date
          FROM ohlcv_daily
          WHERE date <= ?
            ${hasStart ? 'AND date >= ?' : ''}
          ORDER BY date DESC
          ${recentDays > 0 ? 'LIMIT ?' : ''}
        )
        ORDER BY date
      `,
      tickersSql: `
        SELECT DISTINCT ticker AS symbol
        FROM ohlcv_daily
        WHERE date BETWEEN ? AND ?
        ORDER BY ticker
      `,
      rowsSql: (hasWarmup) => `
        SELECT date, close, volume
        FROM ohlcv_daily
        WHERE ticker = ?
          AND date <= ?
          ${hasWarmup ? 'AND date >= ?' : ''}
        ORDER BY date
      `,
    }
  }

  return {
    latestSql: 'SELECT MAX(date) AS latestDate FROM market_ohlcv_daily WHERE market = ?',
    datesSql: (hasStart, recentDays) => `
      SELECT date
      FROM (
        SELECT DISTINCT date
        FROM market_ohlcv_daily
        WHERE market = ?
          AND date <= ?
          ${hasStart ? 'AND date >= ?' : ''}
        ORDER BY date DESC
        ${recentDays > 0 ? 'LIMIT ?' : ''}
      )
      ORDER BY date
    `,
    tickersSql: `
      SELECT DISTINCT ticker AS symbol
      FROM market_ohlcv_daily
      WHERE market = ?
        AND date BETWEEN ? AND ?
      ORDER BY ticker
    `,
    rowsSql: (hasWarmup) => `
      SELECT date, close, volume
      FROM market_ohlcv_daily
      WHERE market = ?
        AND ticker = ?
        AND date <= ?
        ${hasWarmup ? 'AND date >= ?' : ''}
      ORDER BY date
    `,
  }
}

async function ensurePhysicalMomentumSchema(): Promise<void> {
  await execRun(`
    CREATE TABLE IF NOT EXISTS physical_momentum_metrics (
      market TEXT NOT NULL DEFAULT 'JP',
      symbol TEXT NOT NULL,
      date TEXT NOT NULL,
      velocity REAL,
      acceleration REAL,
      momentum REAL,
      force REAL,
      ma5_angle REAL,
      ma25_angle REAL,
      ma75_angle REAL,
      ma200_angle REAL,
      ma_angle_avg REAL,
      energy REAL,
      z_velocity REAL,
      z_acceleration REAL,
      z_momentum REAL,
      z_force REAL,
      z_ma_angle_avg REAL,
      z_energy REAL,
      physical_momentum_score REAL,
      physical_force_score REAL,
      physical_energy_score REAL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (market, symbol, date)
    )
  `)
  await execRun('CREATE INDEX IF NOT EXISTS physical_momentum_market_date_idx ON physical_momentum_metrics(market, date)')
  await execRun('CREATE INDEX IF NOT EXISTS physical_momentum_market_score_idx ON physical_momentum_metrics(market, date, physical_momentum_score)')
  await execRun('CREATE INDEX IF NOT EXISTS physical_momentum_market_force_score_idx ON physical_momentum_metrics(market, date, physical_force_score)')
  await execRun('CREATE INDEX IF NOT EXISTS physical_momentum_market_energy_score_idx ON physical_momentum_metrics(market, date, physical_energy_score)')
  await execRun('CREATE INDEX IF NOT EXISTS physical_momentum_symbol_date_idx ON physical_momentum_metrics(market, symbol, date)')
}

async function startRun(): Promise<number | null> {
  try {
    const row = await execGet<{ id: number }>(
      `
        INSERT INTO batch_runs (job_type, started_at, status, total_tickers, succeeded, failed, rows_inserted)
        VALUES (?, unixepoch(), 'running', 0, 0, 0, 0)
        RETURNING id
      `,
      [RUN_JOB_TYPE],
    )
    return row?.id ?? null
  } catch {
    return null
  }
}

async function finishRun(
  id: number | null,
  status: 'success' | 'failed',
  payload: { totalTickers: number; succeeded: number; failed: number; rowsInserted: number; errorSummary?: string | null },
): Promise<void> {
  if (!id) return
  await execRun(
    `
      UPDATE batch_runs
      SET finished_at = unixepoch(),
          status = ?,
          total_tickers = ?,
          succeeded = ?,
          failed = ?,
          rows_inserted = ?,
          error_summary = ?
      WHERE id = ?
    `,
    [
      status,
      payload.totalTickers,
      payload.succeeded,
      payload.failed,
      payload.rowsInserted,
      payload.errorSummary ?? null,
      id,
    ],
  )
}

async function latestDateForMarket(market: Market): Promise<string | null> {
  const source = sourceTable(market)
  const row = await execGet<{ latestDate: string | null }>(
    source.latestSql,
    market === 'JP' ? [] : [market],
  )
  return row?.latestDate ?? null
}

async function processingDatesForMarket(market: Market, endDate: string): Promise<string[]> {
  const source = sourceTable(market)
  const hasStart = Boolean(START_DATE)
  const sql = source.datesSql(hasStart, RECENT_DAYS)
  const args =
    market === 'JP'
      ? [
          endDate,
          ...(hasStart ? [START_DATE] : []),
          ...(RECENT_DAYS > 0 ? [RECENT_DAYS] : []),
        ]
      : [
          market,
          endDate,
          ...(hasStart ? [START_DATE] : []),
          ...(RECENT_DAYS > 0 ? [RECENT_DAYS] : []),
        ]
  const rows = await execAll<{ date: string }>(sql, args)
  return rows.map((row) => row.date)
}

async function tickersForMarket(market: Market, startDate: string, endDate: string): Promise<string[]> {
  const source = sourceTable(market)
  const rows = await execAll<{ symbol: string }>(
    source.tickersSql,
    market === 'JP' ? [startDate, endDate] : [market, startDate, endDate],
  )
  const tickers = rows
    .map((row) => row.symbol)
    .filter((symbol) => TICKER_FILTER.size === 0 || TICKER_FILTER.has(symbol.toUpperCase()))
  const offset = Number.isFinite(TICKER_OFFSET) && TICKER_OFFSET > 0 ? Math.floor(TICKER_OFFSET) : 0
  const limit = Number.isFinite(TICKER_LIMIT) && TICKER_LIMIT > 0 ? Math.floor(TICKER_LIMIT) : 0
  return limit > 0 ? tickers.slice(offset, offset + limit) : tickers.slice(offset)
}

async function priceRowsForTicker(
  market: Market,
  symbol: string,
  endDate: string,
  warmupStartDate: string | null,
): Promise<PriceRow[]> {
  const source = sourceTable(market)
  const hasWarmup = Boolean(warmupStartDate)
  return execAll<PriceRow>(
    source.rowsSql(hasWarmup),
    market === 'JP'
      ? [symbol, endDate, ...(hasWarmup ? [warmupStartDate] : [])]
      : [market, symbol, endDate, ...(hasWarmup ? [warmupStartDate] : [])],
  )
}

async function insertRawMetrics(market: Market, rows: MetricRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await execBatch(chunk.map((row) => ({
      sql: `
        INSERT INTO physical_momentum_metrics (
          market, symbol, date,
          velocity, acceleration, momentum, force,
          ma5_angle, ma25_angle, ma75_angle, ma200_angle, ma_angle_avg, energy,
          z_velocity, z_acceleration, z_momentum, z_force, z_ma_angle_avg, z_energy,
          physical_momentum_score, physical_force_score, physical_energy_score,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, unixepoch(), unixepoch())
        ON CONFLICT(market, symbol, date) DO UPDATE SET
          velocity = excluded.velocity,
          acceleration = excluded.acceleration,
          momentum = excluded.momentum,
          force = excluded.force,
          ma5_angle = excluded.ma5_angle,
          ma25_angle = excluded.ma25_angle,
          ma75_angle = excluded.ma75_angle,
          ma200_angle = excluded.ma200_angle,
          ma_angle_avg = excluded.ma_angle_avg,
          energy = excluded.energy,
          updated_at = unixepoch()
      `,
      args: [
        market,
        row.symbol,
        row.date,
        dbNumber(row.velocity),
        dbNumber(row.acceleration),
        dbNumber(row.momentum),
        dbNumber(row.force),
        dbNumber(row.ma5Angle),
        dbNumber(row.ma25Angle),
        dbNumber(row.ma75Angle),
        dbNumber(row.ma200Angle),
        dbNumber(row.maAngleAvg),
        dbNumber(row.energy),
      ],
    })))
  }
}

async function normalizeMarketDate(market: Market, date: string): Promise<void> {
  const rows = await execAll<DbMetricRow>(
    `
      SELECT
        symbol,
        velocity,
        acceleration,
        momentum,
        force,
        ma_angle_avg AS maAngleAvg,
        energy
      FROM physical_momentum_metrics
      WHERE market = ?
        AND date = ?
    `,
    [market, date],
  )

  if (rows.length === 0) return

  const stats = Object.fromEntries(
    RAW_KEYS.map((key) => [key, meanAndStd(rows.map((row) => row[key]))]),
  ) as Record<PhysicalMomentumRawKey, { mean: number | null; std: number | null }>

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await execBatch(chunk.map((row) => {
      const zVelocity = zScore(row.velocity, stats.velocity.mean, stats.velocity.std)
      const zAcceleration = zScore(row.acceleration, stats.acceleration.mean, stats.acceleration.std)
      const zMomentum = zScore(row.momentum, stats.momentum.mean, stats.momentum.std)
      const zForce = zScore(row.force, stats.force.mean, stats.force.std)
      const zMaAngleAvg = zScore(row.maAngleAvg, stats.maAngleAvg.mean, stats.maAngleAvg.std)
      const zEnergy = zScore(row.energy, stats.energy.mean, stats.energy.std)
      const scores = composePhysicalMomentumScores({
        zVelocity,
        zAcceleration,
        zMomentum,
        zForce,
        zMaAngleAvg,
        zEnergy,
      })

      return {
        sql: `
          UPDATE physical_momentum_metrics
          SET z_velocity = ?,
              z_acceleration = ?,
              z_momentum = ?,
              z_force = ?,
              z_ma_angle_avg = ?,
              z_energy = ?,
              physical_momentum_score = ?,
              physical_force_score = ?,
              physical_energy_score = ?,
              updated_at = unixepoch()
          WHERE market = ?
            AND symbol = ?
            AND date = ?
        `,
        args: [
          dbNumber(zVelocity),
          dbNumber(zAcceleration),
          dbNumber(zMomentum),
          dbNumber(zForce),
          dbNumber(zMaAngleAvg),
          dbNumber(zEnergy),
          dbNumber(scores.physicalMomentumScore),
          dbNumber(scores.physicalForceScore),
          dbNumber(scores.physicalEnergyScore),
          market,
          row.symbol,
          date,
        ],
      }
    }))
  }
}

async function deleteExistingMetrics(market: Market, startDate: string, endDate: string, tickers: string[]): Promise<void> {
  if (TICKER_FILTER.size === 0) {
    await execRun(
      'DELETE FROM physical_momentum_metrics WHERE market = ? AND date BETWEEN ? AND ?',
      [market, startDate, endDate],
    )
    return
  }

  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK)
    if (chunk.length === 0) continue
    const placeholders = chunk.map(() => '?').join(',')
    await execRun(
      `
        DELETE FROM physical_momentum_metrics
        WHERE market = ?
          AND date BETWEEN ? AND ?
          AND symbol IN (${placeholders})
      `,
      [market, startDate, endDate, ...chunk],
    )
  }
}

async function processMarket(market: Market): Promise<{ totalTickers: number; succeeded: number; failed: number; rowsInserted: number }> {
  const metricMarket = outputMarketFor(market)
  const logLabel = logLabelFor(market)
  const latestDate = END_DATE ?? await latestDateForMarket(market)
  if (!latestDate) {
    console.log(`[${logLabel}] skipped: no OHLCV data`)
    return { totalTickers: 0, succeeded: 0, failed: 0, rowsInserted: 0 }
  }

  const allDates = await processingDatesForMarket(market, latestDate)
  const dateOffset = Number.isFinite(DATE_OFFSET) && DATE_OFFSET > 0 ? Math.floor(DATE_OFFSET) : 0
  const dateLimit = Number.isFinite(DATE_LIMIT) && DATE_LIMIT > 0 ? Math.floor(DATE_LIMIT) : 0
  const dates = dateLimit > 0 ? allDates.slice(dateOffset, dateOffset + dateLimit) : allDates.slice(dateOffset)
  if (dates.length === 0) {
    console.log(`[${logLabel}] skipped: no processing dates`)
    return { totalTickers: 0, succeeded: 0, failed: 0, rowsInserted: 0 }
  }

  const startDate = dates[0]
  const endDate = dates[dates.length - 1]
  const warmupStartDate = RECENT_DAYS > 0 ? dateDaysBefore(startDate, 560) : null
  const tickers = await tickersForMarket(market, startDate, endDate)

  console.log(
    `[${logLabel}] ${tickers.length} symbols, ${dates.length}/${allDates.length} dates (${startDate} -> ${endDate})`
    + `${TICKER_OFFSET > 0 ? `, ticker_offset=${TICKER_OFFSET}` : ''}`
    + `${TICKER_LIMIT > 0 ? `, ticker_limit=${TICKER_LIMIT}` : ''}`
    + `${DATE_OFFSET > 0 ? `, date_offset=${DATE_OFFSET}` : ''}`
    + `${DATE_LIMIT > 0 ? `, date_limit=${DATE_LIMIT}` : ''}`
    + `${SKIP_RAW ? ', normalize_only' : ''}`
    + `${SKIP_NORMALIZE ? ', raw_only' : ''}`,
  )

  if (DELETE_EXISTING && !SKIP_RAW) {
    await deleteExistingMetrics(metricMarket, startDate, endDate, tickers)
  }

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0

  if (!SKIP_RAW) {
    for (const [index, symbol] of tickers.entries()) {
      try {
        const prices = await priceRowsForTicker(market, symbol, endDate, warmupStartDate)
        const rawRows = computePhysicalMomentumRawRows(prices, LOOKBACK_DAYS)
          .filter((row) => row.date >= startDate && row.date <= endDate)
          .map((row) => ({ ...row, symbol }))

        if (rawRows.length > 0) {
          await insertRawMetrics(metricMarket, rawRows)
          rowsInserted += rawRows.length
        }
        succeeded += 1
      } catch (error) {
        failed += 1
        console.error(`[${logLabel}] ${symbol} failed:`, error instanceof Error ? error.message : error)
      }

      if ((index + 1) % LOG_EVERY === 0) {
        console.log(`[${logLabel}] processed ${index + 1}/${tickers.length}, rows=${rowsInserted}`)
      }
    }
  } else {
    succeeded = tickers.length
  }

  if (!SKIP_NORMALIZE) {
    for (const [index, date] of dates.entries()) {
      await normalizeMarketDate(metricMarket, date)
      if ((index + 1) % 50 === 0) {
        console.log(`[${logLabel}] normalized ${index + 1}/${dates.length} dates`)
      }
    }
  }

  return { totalTickers: tickers.length, succeeded, failed, rowsInserted }
}

async function main(): Promise<void> {
  await ensurePhysicalMomentumSchema()
  const runId = await startRun()
  let totalTickers = 0
  let succeeded = 0
  let failed = 0
  let rowsInserted = 0

  try {
    for (const market of MARKETS) {
      const result = await processMarket(market)
      totalTickers += result.totalTickers
      succeeded += result.succeeded
      failed += result.failed
      rowsInserted += result.rowsInserted
    }

    await finishRun(runId, 'success', { totalTickers, succeeded, failed, rowsInserted })
    console.log(`Physical momentum complete: source_markets=${MARKETS.join(',')}, output_market=${OUTPUT_MARKET ?? 'source'}, tickers=${totalTickers}, rows=${rowsInserted}, failed=${failed}`)
  } catch (error) {
    await finishRun(runId, 'failed', {
      totalTickers,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: error instanceof Error ? error.message : String(error),
    })
    throw error
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal:', error)
    process.exit(1)
  })

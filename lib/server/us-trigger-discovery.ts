import { performance } from 'node:perf_hooks'
import { execAll, execGet } from '@/lib/db/client'
import {
  type TriggerDiscoveryCandidateSnapshot,
  type TriggerDiscoveryDataSource,
  type TriggerDiscoveryFilteredCandidate,
  type TriggerDiscoveryStageSnapshot,
} from '@/lib/server/trigger-discovery-read-model'
import type { TriggerDiscoveryMiniChartDataSource } from '@/lib/server/trigger-discovery-mini-charts'
import { buildContinuousMonthlyMaSeries } from '@/lib/snapshots/continuous-ma'
import { buildContinuousBiweeklyMaSeriesFromWeekly } from '@/lib/trigger-discovery-timeframe'
import type { TriggerDiscoveryMiniChartPoint } from '@/lib/trigger-discovery-contract'
import type { MaZoneTriggerObservation } from '@/lib/trigger-discovery-engine'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'
import type { OHLCV } from '@/types/stock'

const GENERIC_WARMUP_CALENDAR_DAYS = 160
const GENERIC_SESSION_CALENDAR_MULTIPLIER = 4
const BIWEEKLY_HISTORY_BUFFER_WEEKS = 10
// SQLite on the production runtime accepts more than 16k bound values. Keeping the
// current US stock universe in one CTE avoids rescanning the same date range per chunk.
const QUERY_TICKER_CHUNK_SIZE = 10_000

type CandidateRow = {
  ticker: string
  company_name: string | null
  exchange: string | null
  price_date: string | null
  price: number | null
  average_volume: number | null
  average_trading_value: number | null
  liquidity_observation_count: number | null
}

type GenericRow = OHLCV & {
  ticker: string
  is_recent: number
}

type WeeklyRow = OHLCV & {
  ticker: string
  week_start: string
}

type StageRow = {
  ticker: string
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 1_000) / 1_000
}

function finiteNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function stageValue(value: number | null): number | null {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 6
    ? Number(value)
    : null
}

function dateDaysBefore(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() - days)
  return parsed.toISOString().slice(0, 10)
}

function chunks<T>(values: readonly T[], size = QUERY_TICKER_CHUNK_SIZE): T[][] {
  const result: T[][] = []
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size) as T[])
  }
  return result
}

function tickerValuesCte(tickers: readonly string[]): { sql: string; args: string[] } {
  return {
    sql: tickers.map(() => '(?)').join(', '),
    args: [...tickers],
  }
}

function candidateValuesCte(
  candidates: readonly TriggerDiscoveryFilteredCandidate[],
): { sql: string; args: string[] } {
  return {
    sql: candidates.map(() => '(?, ?)').join(', '),
    args: candidates.flatMap((candidate) => [candidate.ticker, candidate.priceDate]),
  }
}

function normalizedOhlcv(row: GenericRow | WeeklyRow): OHLCV {
  return {
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }
}

export type UsTriggerUniverseBasis = 'CURRENT_ACTIVE' | 'TRADING_COVERAGE'

export async function getUsTriggerLatestAsOf(): Promise<string | null> {
  const latest = await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date
    FROM market_ohlcv_daily
    WHERE market = 'US'
  `)
  return latest?.date ?? null
}

export async function getUsTriggerDiscoveryOptions(): Promise<{
  contractVersion: 'us-trigger-discovery-options-v1'
  market: 'US'
  currency: 'USD'
  latestAsOf: string | null
  activeCount: number
  supportedTimeframes: Array<'MONTHLY' | 'BIWEEKLY'>
  exchanges: Array<{ value: string; label: string; count: number }>
}> {
  const symbolClause = usInvestableSymbolSql('ticker')
  const [latest, exchanges, total] = await Promise.all([
    getUsTriggerLatestAsOf(),
    execAll<{ exchange: string | null; count: number }>(`
      SELECT exchange, COUNT(*) AS count
      FROM market_universe
      WHERE market = 'US'
        AND active = 1
        AND COALESCE(asset_type, 'Stock') = 'Stock'
        AND ${symbolClause}
      GROUP BY exchange
      ORDER BY CASE WHEN exchange IS NULL OR TRIM(exchange) = '' THEN 1 ELSE 0 END,
               count DESC,
               exchange
    `),
    execGet<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM market_universe
      WHERE market = 'US'
        AND active = 1
        AND COALESCE(asset_type, 'Stock') = 'Stock'
        AND ${symbolClause}
    `),
  ])
  return {
    contractVersion: 'us-trigger-discovery-options-v1',
    market: 'US',
    currency: 'USD',
    latestAsOf: latest,
    activeCount: Number(total?.count ?? 0),
    supportedTimeframes: ['MONTHLY', 'BIWEEKLY'],
    exchanges: exchanges.map((row) => ({
      value: row.exchange?.trim() || 'UNCLASSIFIED',
      label: row.exchange?.trim() || '取引所未分類',
      count: Number(row.count),
    })),
  }
}

export function createUsTriggerDiscoveryDataSource(): TriggerDiscoveryDataSource {
  return {
    async loadMarketSessions(asOf, limit) {
      const startedAt = performance.now()
      const rows = await execAll<{ date: string }>(`
        SELECT DISTINCT date
        FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
        WHERE market = 'US' AND date <= ?
        ORDER BY date DESC
        LIMIT ?
      `, [asOf, limit])
      return { value: rows.map((row) => row.date), queryCount: 1, queryMs: elapsedMs(startedAt) }
    },

    async loadCandidateSnapshots({ resolvedAsOf, oldestSessionDate, liquidityLookbackSessions }) {
      const startedAt = performance.now()
      const symbolClause = usInvestableSymbolSql('u.ticker')
      const rows = await execAll<CandidateRow>(`
        WITH params AS (
          SELECT ? AS as_of, ? AS lookback,
                 (SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US') AS latest_as_of
        ), ranked_prices AS (
          SELECT o.ticker,
                 o.date,
                 COALESCE(o.adj_close, o.close) AS close,
                 COALESCE(o.adj_volume, o.volume) AS volume,
                 ROW_NUMBER() OVER (PARTITION BY o.ticker ORDER BY o.date DESC) AS rn
          FROM market_ohlcv_daily AS o INDEXED BY market_ohlcv_market_date_idx
          WHERE o.market = 'US'
            AND o.date BETWEEN ? AND ?
        ), prices AS (
          SELECT r.ticker,
                 MAX(CASE WHEN r.rn = 1 THEN r.date END) AS price_date,
                 MAX(CASE WHEN r.rn = 1 THEN r.close END) AS price,
                 AVG(CASE WHEN r.rn <= params.lookback THEN r.volume END) AS average_volume,
                 AVG(CASE WHEN r.rn <= params.lookback THEN r.close * r.volume END) AS average_trading_value,
                 SUM(CASE WHEN r.rn <= params.lookback THEN 1 ELSE 0 END) AS liquidity_observation_count
          FROM ranked_prices AS r
          CROSS JOIN params
          GROUP BY r.ticker
        ), current_company_names AS (
          SELECT ticker, company_name
          FROM (
            SELECT ticker,
                   COALESCE(
                     NULLIF(TRIM(json_extract(raw_json, '$.submission.name')), ''),
                     NULLIF(TRIM(json_extract(raw_json, '$.secMatch.name')), '')
                   ) AS company_name,
                   ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY effective_from DESC) AS rn
            FROM market_classifications
            WHERE market = 'US' AND taxonomy = 'US_SEC_SIC'
          )
          WHERE rn = 1
        )
        SELECT u.ticker,
               COALESCE(
                 current_company_names.company_name,
                 NULLIF(NULLIF(TRIM(u.name), ''), u.ticker),
                 u.ticker
               ) AS company_name,
               CASE WHEN params.as_of = params.latest_as_of THEN u.exchange ELSE NULL END AS exchange,
               prices.price_date,
               prices.price,
               prices.average_volume,
               prices.average_trading_value,
               prices.liquidity_observation_count
        FROM market_universe AS u
        CROSS JOIN params
        LEFT JOIN prices ON prices.ticker = u.ticker
        LEFT JOIN current_company_names ON current_company_names.ticker = u.ticker
        WHERE u.market = 'US'
          AND COALESCE(u.asset_type, 'Stock') = 'Stock'
          AND ${symbolClause}
          AND COALESCE(u.start_date, '0000-01-01') <= params.as_of
          AND COALESCE(u.end_date, params.latest_as_of) >= params.as_of
          AND (params.as_of <> params.latest_as_of OR u.active = 1)
        ORDER BY u.ticker
      `, [resolvedAsOf, liquidityLookbackSessions, oldestSessionDate, resolvedAsOf])
      return {
        value: rows.map((row): TriggerDiscoveryCandidateSnapshot => ({
          ticker: row.ticker,
          companyName: row.company_name?.trim() || row.ticker,
          market: row.exchange?.trim() || null,
          priceDate: row.price_date,
          price: finiteNumber(row.price),
          averageVolume: finiteNumber(row.average_volume),
          averageTradingValue: finiteNumber(row.average_trading_value),
          liquidityObservationCount: Number(row.liquidity_observation_count ?? 0),
        })),
        queryCount: 1,
        queryMs: elapsedMs(startedAt),
      }
    },

    async loadStoredMaObservations() {
      // The US serving DB does not materialize monthly trigger observations.
      return { value: new Map(), queryCount: 0, queryMs: 0, preparationMs: 0 }
    },

    async loadGenericMaObservations({ candidates, ma1Period, ma2Period, requiredObservations }) {
      if (candidates.length === 0) return { value: new Map(), queryCount: 0, queryMs: 0, preparationMs: 0 }
      const maximumPeriod = Math.max(ma1Period, ma2Period)
      const historyCalendarDays = maximumPeriod * 32
        + GENERIC_WARMUP_CALENDAR_DAYS
        + requiredObservations * GENERIC_SESSION_CALENDAR_MULTIPLIER
      const oldestPriceDate = candidates.reduce(
        (oldest, candidate) => candidate.priceDate < oldest ? candidate.priceDate : oldest,
        candidates[0].priceDate,
      )
      const historyStart = dateDaysBefore(oldestPriceDate, historyCalendarDays)
      const recentStart = dateDaysBefore(
        oldestPriceDate,
        requiredObservations * GENERIC_SESSION_CALENDAR_MULTIPLIER + 30,
      )
      const grouped = new Map<string, { byDate: Map<string, OHLCV>; recentDates: Set<string> }>()
      let queryCount = 0
      let queryMs = 0

      for (const candidateChunk of chunks(candidates)) {
        const cte = candidateValuesCte(candidateChunk)
        const queryStartedAt = performance.now()
        const rows = await execAll<GenericRow>(`
          WITH candidates(ticker, price_date) AS (VALUES ${cte.sql}), month_edges AS (
            SELECT o.ticker,
                   substr(o.date, 1, 7) AS month_key,
                   MIN(o.date) AS first_date,
                   MAX(o.date) AS last_date
            FROM candidates AS c
            INNER JOIN market_ohlcv_daily AS o INDEXED BY market_ohlcv_market_ticker_date_idx
              ON o.market = 'US'
             AND o.ticker = c.ticker
             AND o.date BETWEEN ? AND c.price_date
            GROUP BY o.ticker, month_key
          ), monthly_rows AS (
            SELECT o.ticker,
                   o.date,
                   COALESCE(o.adj_open, o.open) AS open,
                   COALESCE(o.adj_high, o.high) AS high,
                   COALESCE(o.adj_low, o.low) AS low,
                   COALESCE(o.adj_close, o.close) AS close,
                   COALESCE(o.adj_volume, o.volume) AS volume,
                   0 AS is_recent
            FROM month_edges AS edges
            INNER JOIN market_ohlcv_daily AS o INDEXED BY market_ohlcv_market_ticker_date_idx
              ON o.market = 'US'
             AND o.ticker = edges.ticker
             AND o.date IN (edges.first_date, edges.last_date)
          ), recent_ranked AS (
            SELECT o.ticker,
                   o.date,
                   COALESCE(o.adj_open, o.open) AS open,
                   COALESCE(o.adj_high, o.high) AS high,
                   COALESCE(o.adj_low, o.low) AS low,
                   COALESCE(o.adj_close, o.close) AS close,
                   COALESCE(o.adj_volume, o.volume) AS volume,
                   ROW_NUMBER() OVER (PARTITION BY o.ticker ORDER BY o.date DESC) AS recent_rank
            FROM candidates AS c
            INNER JOIN market_ohlcv_daily AS o INDEXED BY market_ohlcv_market_ticker_date_idx
              ON o.market = 'US'
             AND o.ticker = c.ticker
             AND o.date BETWEEN ? AND c.price_date
          )
          SELECT ticker, date, open, high, low, close, volume, is_recent FROM monthly_rows
          UNION ALL
          SELECT ticker, date, open, high, low, close, volume, 1 AS is_recent
          FROM recent_ranked
          WHERE recent_rank <= ?
          ORDER BY ticker, date
        `, [...cte.args, historyStart, recentStart, requiredObservations])
        queryMs += elapsedMs(queryStartedAt)
        queryCount += 1
        for (const row of rows) {
          const group = grouped.get(row.ticker) ?? { byDate: new Map(), recentDates: new Set() }
          group.byDate.set(row.date, normalizedOhlcv(row))
          if (Number(row.is_recent) === 1) group.recentDates.add(row.date)
          grouped.set(row.ticker, group)
        }
      }

      const preparationStartedAt = performance.now()
      const value = new Map<string, MaZoneTriggerObservation[]>()
      for (const [ticker, group] of grouped) {
        const recentDateSet = new Set([...group.recentDates].sort().slice(-requiredObservations))
        const series = buildContinuousMonthlyMaSeries(
          [...group.byDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
          [ma1Period, ma2Period],
          { adjustSplits: false },
        )
        value.set(ticker, series.flatMap((point) => {
          if (!recentDateSet.has(point.date)) return []
          const ma1 = point.values.get(ma1Period)
          const ma2 = point.values.get(ma2Period)
          return ma1 == null || ma2 == null
            ? []
            : [{ date: point.date, price: point.close, ma1, ma2 }]
        }))
      }
      return { value, queryCount, queryMs, preparationMs: elapsedMs(preparationStartedAt) }
    },

    async loadBiweeklyMaObservations({ candidates, ma1Period, ma2Period, requiredObservations }) {
      if (candidates.length === 0) {
        return {
          value: new Map(), queryCount: 0, queryMs: 0, preparationMs: 0,
          biweekly: {
            weeklyRowsLoaded: 0,
            currentWeekDailyRowsLoaded: 0,
            weeklyHistoryQueryMs: 0,
            currentWeekQueryMs: 0,
            weeklyAssemblyMs: 0,
            biweeklyAggregationMs: 0,
            maCalculationMs: 0,
          },
        }
      }
      const maximumPeriod = Math.max(ma1Period, ma2Period)
      const requiredBiweeklyBars = maximumPeriod + requiredObservations - 1
      const historyStart = dateDaysBefore(
        candidates.reduce(
          (oldest, candidate) => candidate.priceDate < oldest ? candidate.priceDate : oldest,
          candidates[0].priceDate,
        ),
        (requiredBiweeklyBars * 2 + BIWEEKLY_HISTORY_BUFFER_WEEKS) * 7,
      )
      const weeklyByTicker = new Map<string, OHLCV[]>()
      let queryCount = 0
      let queryMs = 0
      let weeklyRowsLoaded = 0

      for (const candidateChunk of chunks(candidates)) {
        const cte = candidateValuesCte(candidateChunk)
        const queryStartedAt = performance.now()
        const rows = await execAll<WeeklyRow>(`
          WITH candidates(ticker, price_date) AS (VALUES ${cte.sql}), daily AS (
            SELECT o.ticker,
                   o.date,
                   date(o.date, '-' || ((CAST(strftime('%w', o.date) AS INTEGER) + 6) % 7) || ' days') AS week_start,
                   COALESCE(o.adj_open, o.open) AS open,
                   COALESCE(o.adj_high, o.high) AS high,
                   COALESCE(o.adj_low, o.low) AS low,
                   COALESCE(o.adj_close, o.close) AS close,
                   COALESCE(o.adj_volume, o.volume) AS volume
            FROM market_ohlcv_daily AS o INDEXED BY market_ohlcv_market_ticker_date_idx
            INNER JOIN candidates AS c
              ON c.ticker = o.ticker
             AND o.date <= c.price_date
            WHERE o.market = 'US'
              AND o.date >= ?
          ), ranked AS (
            SELECT *,
                   ROW_NUMBER() OVER (PARTITION BY ticker, week_start ORDER BY date ASC) AS first_rank,
                   ROW_NUMBER() OVER (PARTITION BY ticker, week_start ORDER BY date DESC) AS last_rank
            FROM daily
          )
          SELECT ticker,
                 MAX(date) AS date,
                 week_start,
                 MAX(CASE WHEN first_rank = 1 THEN open END) AS open,
                 MAX(high) AS high,
                 MIN(low) AS low,
                 MAX(CASE WHEN last_rank = 1 THEN close END) AS close,
                 SUM(volume) AS volume
          FROM ranked
          GROUP BY ticker, week_start
          ORDER BY ticker, date
        `, [...cte.args, historyStart])
        queryMs += elapsedMs(queryStartedAt)
        queryCount += 1
        weeklyRowsLoaded += rows.length
        for (const row of rows) {
          const weekly = weeklyByTicker.get(row.ticker) ?? []
          weekly.push(normalizedOhlcv(row))
          weeklyByTicker.set(row.ticker, weekly)
        }
      }

      const preparationStartedAt = performance.now()
      let biweeklyAggregationMs = 0
      let maCalculationMs = 0
      const value = new Map<string, MaZoneTriggerObservation[]>()
      for (const candidate of candidates) {
        const aggregationStartedAt = performance.now()
        const weekly = weeklyByTicker.get(candidate.ticker) ?? []
        biweeklyAggregationMs += performance.now() - aggregationStartedAt
        const maStartedAt = performance.now()
        const points = buildContinuousBiweeklyMaSeriesFromWeekly(
          weekly,
          [ma1Period, ma2Period],
          { adjustSplits: false },
        )
        maCalculationMs += performance.now() - maStartedAt
        value.set(candidate.ticker, points.flatMap((point) => {
          const ma1 = point.values.get(ma1Period)
          const ma2 = point.values.get(ma2Period)
          return ma1 == null || ma2 == null
            ? []
            : [{ date: point.date, price: point.close, ma1, ma2 }]
        }).slice(-requiredObservations))
      }
      const weeklyAssemblyMs = elapsedMs(preparationStartedAt)
      const biweekly = {
        weeklyRowsLoaded,
        currentWeekDailyRowsLoaded: 0,
        weeklyHistoryQueryMs: queryMs,
        currentWeekQueryMs: 0,
        weeklyAssemblyMs,
        biweeklyAggregationMs: Math.round(biweeklyAggregationMs * 1_000) / 1_000,
        maCalculationMs: Math.round(maCalculationMs * 1_000) / 1_000,
      }
      return {
        value,
        queryCount,
        queryMs,
        preparationMs: weeklyAssemblyMs,
        biweekly,
      }
    },

    async loadStageSnapshots({ tickers, resolvedAsOf }) {
      if (tickers.length === 0) return { value: new Map(), queryCount: 0, queryMs: 0, preparationMs: 0 }
      const value = new Map<string, TriggerDiscoveryStageSnapshot>()
      let queryCount = 0
      let queryMs = 0
      const preparationStartedAt = performance.now()
      for (const tickerChunk of chunks(tickers)) {
        const cte = tickerValuesCte(tickerChunk)
        const queryStartedAt = performance.now()
        const rows = await execAll<StageRow>(`
          WITH candidates(ticker) AS (VALUES ${cte.sql})
          SELECT snapshots.ticker,
                 snapshots.date,
                 snapshots.daily_a_stage,
                 snapshots.daily_b_stage,
                 snapshots.weekly_a_stage,
                 snapshots.weekly_b_stage,
                 snapshots.monthly_a_stage,
                 snapshots.monthly_b_stage
          FROM candidates
          INNER JOIN market_daily_snapshots AS snapshots
            ON snapshots.market = 'US'
           AND snapshots.ticker = candidates.ticker
           AND snapshots.date = ?
        `, [...cte.args, resolvedAsOf])
        queryMs += elapsedMs(queryStartedAt)
        queryCount += 1
        for (const row of rows) {
          value.set(row.ticker, {
            ticker: row.ticker,
            date: row.date,
            dayAStage: stageValue(row.daily_a_stage),
            dayBStage: stageValue(row.daily_b_stage),
            weekAStage: stageValue(row.weekly_a_stage),
            weekBStage: stageValue(row.weekly_b_stage),
            monthAStage: stageValue(row.monthly_a_stage),
            monthBStage: stageValue(row.monthly_b_stage),
          })
        }
      }
      return { value, queryCount, queryMs, preparationMs: elapsedMs(preparationStartedAt) }
    },
  }
}

function miniCandidate(row: { ticker: string; date: string; close: number }): TriggerDiscoveryFilteredCandidate {
  return {
    ticker: row.ticker,
    companyName: row.ticker,
    market: null,
    priceDate: row.date,
    price: Number(row.close),
    averageVolume: null,
    averageTradingValue: null,
    liquidityObservationCount: 0,
    priceStalenessSessions: 0,
    priceFreshness: 'CURRENT',
    liquidityComplete: false,
  }
}

export function createUsTriggerDiscoveryMiniChartDataSource(): TriggerDiscoveryMiniChartDataSource {
  const discoverySource = createUsTriggerDiscoveryDataSource()
  return {
    async resolveAsOf(requestedAsOf) {
      const startedAt = performance.now()
      const row = await execGet<{ date: string | null }>(`
        SELECT MAX(date) AS date
        FROM market_ohlcv_daily
        WHERE market = 'US' AND date <= ?
      `, [requestedAsOf])
      return { value: row?.date ?? null, queryCount: 1, queryMs: elapsedMs(startedAt) }
    },

    async loadOhlcv({ tickers, fromDate, throughDate }) {
      if (tickers.length === 0) return { value: [], queryCount: 0, queryMs: 0 }
      const cte = tickerValuesCte(tickers)
      const startedAt = performance.now()
      const rows = await execAll<GenericRow>(`
        WITH requested(ticker) AS (VALUES ${cte.sql})
        SELECT prices.ticker,
               prices.date,
               COALESCE(prices.adj_open, prices.open) AS open,
               COALESCE(prices.adj_high, prices.high) AS high,
               COALESCE(prices.adj_low, prices.low) AS low,
               COALESCE(prices.adj_close, prices.close) AS close,
               COALESCE(prices.adj_volume, prices.volume) AS volume,
               0 AS is_recent
        FROM requested
        INNER JOIN market_ohlcv_daily AS prices
          ON prices.market = 'US'
         AND prices.ticker = requested.ticker
         AND prices.date BETWEEN ? AND ?
        ORDER BY prices.ticker, prices.date
      `, [...cte.args, fromDate, throughDate])
      return { value: rows, queryCount: 1, queryMs: elapsedMs(startedAt) }
    },

    async loadBiweeklyPoints({ tickers, throughDate, ma1Period, ma2Period, displayPoints }) {
      if (tickers.length === 0) {
        return {
          value: new Map(), tickersWithPrices: new Set(), queryCount: 0, queryMs: 0,
          biweekly: {
            latestPriceQueryMs: 0,
            weeklyHistoryQueryMs: 0,
            currentWeekQueryMs: 0,
            weeklyAssemblyMs: 0,
            biweeklyAggregationMs: 0,
            maCalculationMs: 0,
          },
        }
      }
      const cte = tickerValuesCte(tickers)
      const latestStartedAt = performance.now()
      const latestRows = await execAll<{ ticker: string; date: string; close: number }>(`
        WITH requested(ticker) AS (VALUES ${cte.sql}), latest AS (
          SELECT requested.ticker, MAX(prices.date) AS date
          FROM requested
          LEFT JOIN market_ohlcv_daily AS prices
            ON prices.market = 'US'
           AND prices.ticker = requested.ticker
           AND prices.date <= ?
          GROUP BY requested.ticker
        )
        SELECT latest.ticker, latest.date, COALESCE(prices.adj_close, prices.close) AS close
        FROM latest
        INNER JOIN market_ohlcv_daily AS prices
          ON prices.market = 'US'
         AND prices.ticker = latest.ticker
         AND prices.date = latest.date
        ORDER BY latest.ticker
      `, [...cte.args, throughDate])
      const latestPriceQueryMs = elapsedMs(latestStartedAt)
      const candidates = latestRows.map(miniCandidate)
      const prepared = await discoverySource.loadBiweeklyMaObservations!({
        candidates,
        ma1Period,
        ma2Period,
        requiredObservations: displayPoints,
      })
      const detail = prepared.biweekly!
      const value = new Map<string, TriggerDiscoveryMiniChartPoint[]>()
      for (const candidate of candidates) {
        value.set(candidate.ticker, (prepared.value.get(candidate.ticker) ?? []).map((point) => ({
          date: point.date,
          close: point.price,
          ma1: point.ma1,
          ma2: point.ma2,
        })))
      }
      return {
        value,
        tickersWithPrices: new Set(latestRows.map((row) => row.ticker)),
        queryCount: 1 + prepared.queryCount,
        queryMs: latestPriceQueryMs + prepared.queryMs,
        biweekly: {
          latestPriceQueryMs,
          weeklyHistoryQueryMs: detail.weeklyHistoryQueryMs,
          currentWeekQueryMs: detail.currentWeekQueryMs,
          weeklyAssemblyMs: detail.weeklyAssemblyMs,
          biweeklyAggregationMs: detail.biweeklyAggregationMs,
          maCalculationMs: detail.maCalculationMs,
        },
      }
    },
  }
}

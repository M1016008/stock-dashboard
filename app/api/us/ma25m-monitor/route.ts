import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import {
  US_ADJUSTED_CLOSE_SQL,
  US_ADJUSTED_HIGH_SQL,
  US_ADJUSTED_LOW_SQL,
  US_ADJUSTED_OPEN_SQL,
  US_ADJUSTED_VOLUME_SQL,
} from '@/lib/us-adjusted-ohlcv'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'
import {
  US_MONTHLY_MA_DEFINITION_VERSION,
  US_MONTHLY_MA_LIST_HISTORY_SESSIONS,
  US_MONTHLY_MA_MONITOR_PERIODS,
  US_MONTHLY_MA_PRICE_BASIS,
  US_MONTHLY_MA_UNAVAILABLE_PERIODS,
  buildUsMonthlyMaMonitorRows,
  filterUsMonthlyMaRows,
  parseUsMonthlyPeriod,
  parseUsMonthlySort,
  parseUsMonthlyStatus,
  summarizeUsMonthlyMaRows,
  usMonthlyMaFilterOptions,
  usMonthlyMaLimitations,
  type UsMonthlyMaSourceRow,
} from '@/lib/us-ma25m-monitor'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type SourceRunRow = {
  id: number
  status: string
  payloadJson: string
  totalTickers: number
  succeeded: number
  failed: number
  finishedAt: number | null
  snapshotMaxComputedAt: number | null
}

type SourceNameRow = { source: string }

const QUERY_NAMES = [
  'period', 'status', 'sort', 'dir', 'contactPct', 'maxDistance', 'minScore',
  'limit', 'offset', 'q', 'exchange', 'sector',
] as const

function oneParam(params: URLSearchParams, name: (typeof QUERY_NAMES)[number]): string | null {
  const values = params.getAll(name)
  if (values.length > 1) throw new Error(`INVALID_QUERY_${name.toUpperCase()}`)
  return values[0] ?? null
}

function strictNumber(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  if (value == null) return fallback
  if (value.trim() === '') throw new Error('INVALID_QUERY_NUMBER')
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum || (integer && !Number.isInteger(parsed))) {
    throw new Error('INVALID_QUERY_NUMBER')
  }
  return parsed
}

function boundedText(value: string | null, maximum: number): string {
  const normalized = value?.trim() ?? ''
  if (normalized.length > maximum) throw new Error('INVALID_QUERY_TEXT')
  return normalized
}

function stableErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked|no such table|STORAGE_|FAILED_SAFE/i.test(message) ? 503 : 500
}

function generationPriceBasis(run: SourceRunRow | undefined): string | null {
  if (!run?.payloadJson) return null
  try {
    const parsed = JSON.parse(run.payloadJson) as { priceBasis?: unknown }
    return typeof parsed.priceBasis === 'string' ? parsed.priceBasis : null
  } catch {
    return null
  }
}

function generationAttested(run: SourceRunRow | undefined): boolean {
  if (!run || run.status !== 'success' || run.finishedAt == null || run.totalTickers <= 0
    || run.succeeded !== run.totalTickers || run.failed !== 0
    || (run.snapshotMaxComputedAt != null && run.snapshotMaxComputedAt > run.finishedAt)) return false
  try {
    const payload = JSON.parse(run.payloadJson) as Record<string, unknown>
    return payload.stage === 'complete'
      && payload.priceBasis === US_MONTHLY_MA_PRICE_BASIS
      && payload.tickerStart == null
      && payload.tickerEnd == null
      && payload.limit == null
      && payload.tickers == null
  } catch {
    return false
  }
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    const values = Object.fromEntries(QUERY_NAMES.map((name) => [name, oneParam(params, name)]))
    const period = parseUsMonthlyPeriod(values.period)
    if (values.period != null && values.period !== '' && period === 'all' && values.period !== 'all') {
      return NextResponse.json({ error: 'invalid_period' }, { status: 400 })
    }
    const status = parseUsMonthlyStatus(values.status)
    if (values.status != null && values.status !== status) {
      return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
    }
    const sort = parseUsMonthlySort(values.sort)
    if (values.sort != null && values.sort !== sort) {
      return NextResponse.json({ error: 'invalid_sort' }, { status: 400 })
    }
    if (values.dir != null && values.dir !== 'asc' && values.dir !== 'desc') {
      return NextResponse.json({ error: 'invalid_direction' }, { status: 400 })
    }
    const direction = values.dir === 'asc' || values.dir === 'desc'
      ? values.dir
      : sort === 'distance' || sort === 'ticker' ? 'asc' : 'desc'
    const contactThreshold = strictNumber(values.contactPct, 2, 0.1, 10)
    const maxDistance = values.maxDistance != null
      ? strictNumber(values.maxDistance, 100, 0, 100)
      : null
    const minScore = strictNumber(values.minScore, 0, 0, 100)
    const limit = strictNumber(values.limit, 100, 1, 200, true)
    const offset = strictNumber(values.offset, 0, 0, 100_000, true)
    const query = boundedText(values.q, 60)
    const exchange = boundedText(values.exchange, 40) || null
    const sector = boundedText(values.sector, 100) || null

    const [latest, sourceRun] = await Promise.all([
      execGet<{ date: string | null }>(
        `SELECT MAX(s.date) AS date
         FROM market_daily_snapshots s
         WHERE s.market = 'US'
           AND EXISTS (
             SELECT 1 FROM market_ohlcv_daily calendar
             WHERE calendar.market = 'US' AND calendar.ticker = 'SPY' AND calendar.date = s.date
           )`,
      ),
      execGet<SourceRunRow>(
        `SELECT id, status, payload_json AS payloadJson,
           total_tickers AS totalTickers, succeeded, failed, finished_at AS finishedAt,
           (SELECT MAX(computed_at) FROM market_daily_snapshots WHERE market = 'US') AS snapshotMaxComputedAt
         FROM market_data_runs
         WHERE market = 'US' AND job_type = 'snapshot_compute' AND status = 'success'
         ORDER BY id DESC LIMIT 1`,
      ),
    ])
    if (!latest?.date) {
      return NextResponse.json({
        error: 'us_monthly_ma_source_unavailable',
        message: 'US snapshot and SPY trading-session sources have no common as-of date.',
      }, { status: 503 })
    }
    const sourcePriceBasis = generationPriceBasis(sourceRun)
    if (!sourceRun || !sourcePriceBasis) {
      return NextResponse.json({
        error: 'us_monthly_ma_generation_unavailable',
      }, { status: 503 })
    }
    if (sourcePriceBasis !== US_MONTHLY_MA_PRICE_BASIS) {
      return NextResponse.json({
        error: 'us_monthly_ma_price_basis_mismatch',
        expected: US_MONTHLY_MA_PRICE_BASIS,
        actual: sourcePriceBasis,
      }, { status: 503 })
    }
    const sourceGenerationAttested = generationAttested(sourceRun)

    const sourceSql = `WITH sessions AS (
      SELECT date
      FROM market_ohlcv_daily
      WHERE market = 'US' AND ticker = 'SPY' AND date <= ?
      ORDER BY date DESC
      LIMIT ?
    ), base AS (
      SELECT
      s.ticker,
      u.name,
      u.exchange,
      u.sector,
      u.industry,
      u.asset_type AS assetType,
      s.date,
      ${US_ADJUSTED_OPEN_SQL} AS open,
      ${US_ADJUSTED_HIGH_SQL} AS high,
      ${US_ADJUSTED_LOW_SQL} AS low,
      ${US_ADJUSTED_CLOSE_SQL} AS close,
      ${US_ADJUSTED_VOLUME_SQL} AS volume,
      s.avg_volume_20 AS avgVolume20,
      s.daily_a_stage AS dailyAStage,
      s.daily_b_stage AS dailyBStage,
      s.weekly_a_stage AS weeklyAStage,
      s.weekly_b_stage AS weeklyBStage,
      s.monthly_a_stage AS monthlyAStage,
      s.monthly_b_stage AS monthlyBStage,
      s.monthly_ma_3 AS monthlyMa3,
      s.monthly_ma_5 AS monthlyMa5,
      s.monthly_ma_10 AS monthlyMa10,
      s.monthly_ma_20 AS monthlyMa20,
      s.monthly_ma_25 AS monthlyMa25
      FROM sessions calendar
      JOIN market_daily_snapshots s
        ON s.market = 'US' AND s.date = calendar.date
      JOIN market_universe u
        ON u.market = s.market AND u.ticker = s.ticker AND u.active = 1
      JOIN market_ohlcv_daily o
        ON o.market = s.market AND o.ticker = s.ticker AND o.date = s.date
      WHERE ${usInvestableSymbolSql('s.ticker')}
    ), source_months AS (
      SELECT DISTINCT ticker, substr(date, 1, 7) AS monthKey
      FROM base
    ), ma15_boundary_dates AS (
      SELECT
        source_months.ticker,
        source_months.monthKey,
        MAX(CASE
          WHEN boundary.date < date(source_months.monthKey || '-01', '-9 months')
          THEN boundary.date
        END) AS anchorDate,
        MIN(CASE
          WHEN boundary.date >= date(source_months.monthKey || '-01', '-9 months')
          THEN boundary.date
        END) AS bridgeDate
      FROM source_months
      LEFT JOIN market_daily_snapshots boundary
        ON boundary.market = 'US'
       AND boundary.ticker = source_months.ticker
       AND boundary.date >= date(source_months.monthKey || '-01', '-10 months')
       AND boundary.date < date(source_months.monthKey || '-01', '-8 months')
      GROUP BY source_months.ticker, source_months.monthKey
    )
    SELECT
      base.*,
      ma15_boundary_dates.anchorDate AS monthlyMa15AnchorDate,
      ma15_boundary_dates.bridgeDate AS monthlyMa15BridgeDate,
      anchor_snapshot.monthly_ma_5 AS monthlyMa15AnchorMa5
    FROM base
    LEFT JOIN ma15_boundary_dates
      ON ma15_boundary_dates.ticker = base.ticker
     AND ma15_boundary_dates.monthKey = substr(base.date, 1, 7)
    LEFT JOIN market_daily_snapshots anchor_snapshot
      ON anchor_snapshot.market = 'US'
     AND anchor_snapshot.ticker = base.ticker
     AND anchor_snapshot.date = ma15_boundary_dates.anchorDate
    ORDER BY base.ticker, base.date`

    const [sourceRows, activeUniverse, sourceNames] = await Promise.all([
      execAll<UsMonthlyMaSourceRow>(sourceSql, [latest.date, US_MONTHLY_MA_LIST_HISTORY_SESSIONS]),
      execGet<{ count: number }>(
        `SELECT COUNT(*) AS count FROM market_universe u
         WHERE u.market = 'US' AND u.active = 1 AND ${usInvestableSymbolSql('u.ticker')}`,
      ),
      execAll<SourceNameRow>(
        `SELECT DISTINCT source
         FROM market_ohlcv_daily
         WHERE market = 'US' AND date = ?
         ORDER BY source`,
        [latest.date],
      ),
    ])

    const normalizedSource = sourceRows.map((row) => ({
      ...row,
      name: getUsDisplayName(row.ticker, row.name),
    }))
    const built = buildUsMonthlyMaMonitorRows(normalizedSource, latest.date, { historyTruncated: true })
    const filtered = filterUsMonthlyMaRows(built.rows, {
      period,
      status,
      query,
      exchange,
      sector,
      maxDistance,
      minScore,
      contactThreshold,
      sort,
      direction,
      offset,
      limit,
    })
    const limitations = usMonthlyMaLimitations(US_MONTHLY_MA_LIST_HISTORY_SESSIONS)

    return NextResponse.json({
      market: 'US',
      date: latest.date,
      period,
      periods: US_MONTHLY_MA_MONITOR_PERIODS,
      unavailablePeriods: US_MONTHLY_MA_UNAVAILABLE_PERIODS,
      rows: filtered.rows,
      total: filtered.total,
      offset,
      limit,
      contactThreshold,
      summary: summarizeUsMonthlyMaRows(built.rows, contactThreshold),
      filterOptions: usMonthlyMaFilterOptions(built.rows),
      coverage: {
        activeUniverse: Number(activeUniverse?.count ?? 0),
        sourceTickers: built.sourceTickers,
        eligibleTickers: built.eligibleTickers,
        missingTickers: Math.max(0, Number(activeUniverse?.count ?? 0) - built.eligibleTickers),
        missingByPeriod: built.missingByPeriod,
        historyStartDate: built.historyStartDate,
        historySessions: US_MONTHLY_MA_LIST_HISTORY_SESSIONS,
      },
      source: {
        definitionVersion: US_MONTHLY_MA_DEFINITION_VERSION,
        priceBasis: US_MONTHLY_MA_PRICE_BASIS,
        sourceGeneration: sourceGenerationAttested ? sourceRun.id : null,
        sourceGenerationStatus: sourceGenerationAttested ? 'attested' : 'unattested',
        sourceNames: sourceNames.map((row) => row.source),
        calendar: 'US:SPY_TRADING_SESSIONS',
        snapshots: 'market_daily_snapshots',
        prices: 'market_ohlcv_daily',
        ma15Basis: 'CURRENT_MA10_PLUS_COMPLETED_MONTH_MINUS_10_MA5',
        formingMonth: 'INCLUDES_AS_OF_ADJUSTED_CLOSE',
        ma15LookupScope: 'MONTH_MINUS_10_END_AND_MONTH_MINUS_9_START',
        classificationBasis: 'CURRENT_REFERENCE',
      },
      limitations,
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('INVALID_QUERY_')) {
      return NextResponse.json({ error: 'invalid_query_parameters' }, { status: 400 })
    }
    console.error('US monthly MA monitor API error:', error)
    const status = stableErrorStatus(error)
    return NextResponse.json({
      error: status === 503 ? 'us_monthly_ma_source_unavailable' : 'us_monthly_ma_failed',
    }, { status })
  }
}


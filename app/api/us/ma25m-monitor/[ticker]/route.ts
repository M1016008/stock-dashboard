import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { isValidTickerForMarket, normalizeTickerForMarket } from '@/lib/markets'
import {
  US_ADJUSTED_CLOSE_SQL,
  US_ADJUSTED_HIGH_SQL,
  US_ADJUSTED_LOW_SQL,
  US_ADJUSTED_OPEN_SQL,
  US_ADJUSTED_VOLUME_SQL,
} from '@/lib/us-adjusted-ohlcv'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'
import {
  attestUsMonthlyMaGeneration,
  type UsMonthlyMaGenerationRun,
} from '@/lib/server/us-monthly-ma-generation'
import {
  US_MONTHLY_MA_DEFINITION_VERSION,
  US_MONTHLY_MA_DETAIL_HISTORY_SESSIONS,
  US_MONTHLY_MA_MONITOR_PERIODS,
  US_MONTHLY_MA_PRICE_BASIS,
  US_MONTHLY_MA_UNAVAILABLE_PERIODS,
  buildUsMonthlyMaHistory,
  buildUsMonthlyMaMonitorRows,
  parseUsMonthlyPeriod,
  usMonthlyMaLimitations,
  type UsMonthlyMaPeriod,
  type UsMonthlyMaSourceRow,
} from '@/lib/us-ma25m-monitor'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function validIsoDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function stableErrorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked|no such table|STORAGE_|FAILED_SAFE/i.test(message) ? 503 : 500
}

function oneParam(params: URLSearchParams, name: 'date' | 'period' | 'limit'): string | null {
  const values = params.getAll(name)
  if (values.length > 1) throw new Error(`INVALID_QUERY_${name.toUpperCase()}`)
  return values[0] ?? null
}

function strictHistoryLimit(value: string | null): number {
  if (value == null) return 120
  if (!/^\d+$/.test(value)) throw new Error('INVALID_QUERY_LIMIT')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 20 || parsed > US_MONTHLY_MA_DETAIL_HISTORY_SESSIONS) {
    throw new Error('INVALID_QUERY_LIMIT')
  }
  return parsed
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await context.params
    const ticker = normalizeTickerForMarket(rawTicker, 'US')
    if (!isValidTickerForMarket(ticker, 'US')) {
      return NextResponse.json({ error: 'invalid_us_ticker' }, { status: 400 })
    }
    const params = request.nextUrl.searchParams
    const requestedDate = oneParam(params, 'date')
    if (requestedDate != null && !validIsoDate(requestedDate)) {
      return NextResponse.json({ error: 'invalid_date' }, { status: 400 })
    }
    const rawPeriod = oneParam(params, 'period')
    const parsedPeriod = parseUsMonthlyPeriod(rawPeriod)
    if (rawPeriod != null && (parsedPeriod === 'all' || String(parsedPeriod) !== rawPeriod)) {
      return NextResponse.json({ error: 'invalid_period' }, { status: 400 })
    }
    const period: UsMonthlyMaPeriod = parsedPeriod === 'all' ? 25 : parsedPeriod
    const historyLimit = strictHistoryLimit(oneParam(params, 'limit'))

    const sourceRun = await execGet<UsMonthlyMaGenerationRun>(
      `SELECT id, status, payload_json AS payloadJson,
         total_tickers AS totalTickers, succeeded, failed, finished_at AS finishedAt,
         (SELECT MAX(computed_at) FROM market_daily_snapshots WHERE market = 'US') AS snapshotMaxComputedAt
       FROM market_data_runs
       WHERE market = 'US' AND job_type = 'snapshot_compute' AND status = 'success'
       ORDER BY id DESC LIMIT 1`,
    )
    const generation = attestUsMonthlyMaGeneration(sourceRun)
    if (!generation.ok && generation.reason === 'unavailable') {
      return NextResponse.json({ error: 'us_monthly_ma_generation_unavailable' }, { status: 503 })
    }
    if (!generation.ok && generation.reason === 'price_basis_mismatch') {
      return NextResponse.json({
        error: 'us_monthly_ma_price_basis_mismatch',
        expected: US_MONTHLY_MA_PRICE_BASIS,
        actual: generation.actualPriceBasis,
      }, { status: 503 })
    }
    if (!generation.ok) {
      return NextResponse.json({ error: 'us_monthly_ma_generation_unattested' }, { status: 503 })
    }

    const rows = await execAll<UsMonthlyMaSourceRow>(
      `WITH selected_base AS (
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
        FROM market_daily_snapshots s
        JOIN market_universe u
          ON u.market = s.market AND u.ticker = s.ticker
        JOIN market_ohlcv_daily o
          ON o.market = s.market AND o.ticker = s.ticker AND o.date = s.date
        WHERE s.market = 'US' AND s.ticker = ?
          ${requestedDate ? 'AND s.date <= ?' : ''}
          AND EXISTS (
            SELECT 1 FROM market_ohlcv_daily calendar
            WHERE calendar.market = 'US' AND calendar.ticker = 'SPY' AND calendar.date = s.date
          )
        ORDER BY s.date DESC
        LIMIT ?
      ), source_months AS (
        SELECT DISTINCT ticker, substr(date, 1, 7) AS monthKey
        FROM selected_base
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
      ), selected AS (
        SELECT
          selected_base.*,
          ma15_boundary_dates.anchorDate AS monthlyMa15AnchorDate,
          ma15_boundary_dates.bridgeDate AS monthlyMa15BridgeDate,
          anchor_snapshot.monthly_ma_5 AS monthlyMa15AnchorMa5
        FROM selected_base
        LEFT JOIN ma15_boundary_dates
          ON ma15_boundary_dates.ticker = selected_base.ticker
         AND ma15_boundary_dates.monthKey = substr(selected_base.date, 1, 7)
        LEFT JOIN market_daily_snapshots anchor_snapshot
          ON anchor_snapshot.market = 'US'
         AND anchor_snapshot.ticker = selected_base.ticker
         AND anchor_snapshot.date = ma15_boundary_dates.anchorDate
      )
      SELECT * FROM selected ORDER BY date`,
      [ticker, ...(requestedDate ? [requestedDate] : []), historyLimit],
    )
    if (!rows.length) {
      return NextResponse.json({
        error: 'us_monthly_ma_ticker_unavailable',
        ticker,
      }, { status: 404 })
    }

    const normalized = rows.map((row) => ({
      ...row,
      name: getUsDisplayName(row.ticker, row.name),
    }))
    const date = normalized.at(-1)!.date
    const built = buildUsMonthlyMaMonitorRows(normalized, date, {
      historyTruncated: rows.length >= historyLimit,
    })
    const monitors = built.rows.filter((row) => row.ticker === ticker)
    const history = buildUsMonthlyMaHistory(normalized, period).slice().reverse()

    return NextResponse.json({
      market: 'US',
      ticker,
      name: normalized.at(-1)?.name ?? ticker,
      date,
      period,
      periods: US_MONTHLY_MA_MONITOR_PERIODS,
      unavailablePeriods: US_MONTHLY_MA_UNAVAILABLE_PERIODS,
      latest: monitors.find((row) => row.period === period) ?? null,
      monitors,
      clusters: [],
      history,
      source: {
        definitionVersion: US_MONTHLY_MA_DEFINITION_VERSION,
        priceBasis: US_MONTHLY_MA_PRICE_BASIS,
        sourceGeneration: generation.generation,
        sourceGenerationStatus: 'attested',
        calendar: 'US:SPY_TRADING_SESSIONS',
        snapshots: 'market_daily_snapshots',
        prices: 'market_ohlcv_daily',
        ma15Basis: 'CURRENT_MA10_PLUS_COMPLETED_MONTH_MINUS_10_MA5',
        formingMonth: 'INCLUDES_AS_OF_ADJUSTED_CLOSE',
        ma15LookupScope: 'MONTH_MINUS_10_END_AND_MONTH_MINUS_9_START',
        classificationBasis: 'CURRENT_REFERENCE',
      },
      coverage: {
        historyStartDate: normalized[0]?.date ?? null,
        historyEndDate: date,
        historySessions: normalized.length,
        historyTruncated: rows.length >= historyLimit,
        missingByPeriod: built.missingByPeriod,
      },
      limitations: usMonthlyMaLimitations(normalized.length),
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('INVALID_QUERY_')) {
      return NextResponse.json({ error: 'invalid_query_parameters' }, { status: 400 })
    }
    console.error('US monthly MA monitor detail API error:', error)
    const status = stableErrorStatus(error)
    return NextResponse.json({
      error: status === 503 ? 'us_monthly_ma_source_unavailable' : 'us_monthly_ma_detail_failed',
    }, { status })
  }
}

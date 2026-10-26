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
  attestUsMonthlyMaGeneration,
  type UsMonthlyMaGenerationRun,
} from '@/lib/server/us-monthly-ma-generation'
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

type SourceNameRow = { source: string }

type MonthlyMaSourceBundle = {
  built: ReturnType<typeof buildUsMonthlyMaMonitorRows>
  activeUniverse: number
  sourceNames: string[]
}

const globalForUsMonthlyMa = globalThis as typeof globalThis & {
  usMonthlyMaSourceCache?: Map<string, Promise<MonthlyMaSourceBundle>>
}
const sourceCache = globalForUsMonthlyMa.usMonthlyMaSourceCache ?? new Map<string, Promise<MonthlyMaSourceBundle>>()
globalForUsMonthlyMa.usMonthlyMaSourceCache = sourceCache

async function readSourceIdentity(): Promise<{
  latestDate: string | null
  priceMaxImportedAt: number | null
  universeMaxUpdatedAt: number | null
  sourceRun: UsMonthlyMaGenerationRun | undefined
}> {
  const [latest, sourceRun] = await Promise.all([
    execGet<{ date: string | null; priceMaxImportedAt: number | null; universeMaxUpdatedAt: number | null }>(
      `WITH latest AS (
         SELECT MAX(s.date) AS date
         FROM market_daily_snapshots s
         WHERE s.market = 'US'
           AND EXISTS (
             SELECT 1 FROM market_ohlcv_daily calendar
             WHERE calendar.market = 'US' AND calendar.ticker = 'SPY' AND calendar.date = s.date
           )
       )
       SELECT latest.date,
         (SELECT MAX(prices.imported_at)
          FROM market_ohlcv_daily prices
          WHERE prices.market = 'US' AND prices.date <= latest.date) AS priceMaxImportedAt,
         (SELECT MAX(universe.updated_at)
          FROM market_universe universe
          WHERE universe.market = 'US') AS universeMaxUpdatedAt
       FROM latest`,
    ),
    execGet<UsMonthlyMaGenerationRun>(
      `SELECT id, status, payload_json AS payloadJson,
         total_tickers AS totalTickers, succeeded, failed, finished_at AS finishedAt,
         (SELECT MAX(computed_at) FROM market_daily_snapshots WHERE market = 'US') AS snapshotMaxComputedAt
       FROM market_data_runs
       WHERE market = 'US' AND job_type = 'snapshot_compute' AND status = 'success'
       ORDER BY id DESC LIMIT 1`,
    ),
  ])
  return {
    latestDate: latest?.date ?? null,
    priceMaxImportedAt: latest?.priceMaxImportedAt ?? null,
    universeMaxUpdatedAt: latest?.universeMaxUpdatedAt ?? null,
    sourceRun,
  }
}

function rememberSource(key: string, value: Promise<MonthlyMaSourceBundle>): void {
  sourceCache.clear()
  sourceCache.set(key, value)
}

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
  return /SQLITE_BUSY|database is locked|no such table|STORAGE_|FAILED_SAFE|SOURCE_GENERATION_CHANGED/i.test(message) ? 503 : 500
}

function stableErrorCode(error: unknown, status: number): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/SOURCE_GENERATION_CHANGED/i.test(message)) return 'us_monthly_ma_source_generation_changed'
  return status === 503 ? 'us_monthly_ma_source_unavailable' : 'us_monthly_ma_failed'
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

    const sourceIdentity = await readSourceIdentity()
    if (!sourceIdentity.latestDate) {
      return NextResponse.json({
        error: 'us_monthly_ma_source_unavailable',
        message: 'US snapshot and SPY trading-session sources have no common as-of date.',
      }, { status: 503 })
    }
    const generation = attestUsMonthlyMaGeneration(sourceIdentity.sourceRun)
    if (!generation.ok && generation.reason === 'unavailable') {
      return NextResponse.json({
        error: 'us_monthly_ma_generation_unavailable',
      }, { status: 503 })
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

    const sourceCacheKey = `${sourceIdentity.latestDate}:${sourceIdentity.priceMaxImportedAt ?? 'null'}:${sourceIdentity.universeMaxUpdatedAt ?? 'null'}:${generation.generation}`
    let sourceBundle = sourceCache.get(sourceCacheKey)
    if (!sourceBundle) {
      sourceBundle = (async (): Promise<MonthlyMaSourceBundle> => {
        const [sourceRows, activeUniverse, sourceNames] = await Promise.all([
          execAll<UsMonthlyMaSourceRow>(sourceSql, [sourceIdentity.latestDate!, US_MONTHLY_MA_LIST_HISTORY_SESSIONS]),
          execGet<{ count: number }>(
            `SELECT COUNT(*) AS count FROM market_universe u
             WHERE u.market = 'US' AND u.active = 1 AND ${usInvestableSymbolSql('u.ticker')}`,
          ),
          execAll<SourceNameRow>(
            `SELECT DISTINCT source
             FROM market_ohlcv_daily
             WHERE market = 'US' AND date = ?
             ORDER BY source`,
            [sourceIdentity.latestDate!],
          ),
        ])
        const completedIdentity = await readSourceIdentity()
        const completedGeneration = attestUsMonthlyMaGeneration(completedIdentity.sourceRun)
        if (
          completedIdentity.latestDate !== sourceIdentity.latestDate
          || completedIdentity.priceMaxImportedAt !== sourceIdentity.priceMaxImportedAt
          || completedIdentity.universeMaxUpdatedAt !== sourceIdentity.universeMaxUpdatedAt
          || !completedGeneration.ok
          || completedGeneration.generation !== generation.generation
        ) {
          throw new Error('US_MONTHLY_MA_SOURCE_GENERATION_CHANGED')
        }
        const normalizedSource = sourceRows.map((row) => ({
          ...row,
          name: getUsDisplayName(row.ticker, row.name),
        }))
        return {
          built: buildUsMonthlyMaMonitorRows(normalizedSource, sourceIdentity.latestDate!, { historyTruncated: true }),
          activeUniverse: Number(activeUniverse?.count ?? 0),
          sourceNames: sourceNames.map((row) => row.source),
        }
      })()
      rememberSource(sourceCacheKey, sourceBundle)
      sourceBundle.catch(() => {
        if (sourceCache.get(sourceCacheKey) === sourceBundle) sourceCache.delete(sourceCacheKey)
      })
    }
    const { built, activeUniverse, sourceNames } = await sourceBundle
    const responseIdentity = await readSourceIdentity()
    const responseGeneration = attestUsMonthlyMaGeneration(responseIdentity.sourceRun)
    if (
      responseIdentity.latestDate !== sourceIdentity.latestDate
      || responseIdentity.priceMaxImportedAt !== sourceIdentity.priceMaxImportedAt
      || responseIdentity.universeMaxUpdatedAt !== sourceIdentity.universeMaxUpdatedAt
      || !responseGeneration.ok
      || responseGeneration.generation !== generation.generation
    ) {
      throw new Error('US_MONTHLY_MA_SOURCE_GENERATION_CHANGED')
    }
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
      date: sourceIdentity.latestDate,
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
        activeUniverse,
        sourceTickers: built.sourceTickers,
        eligibleTickers: built.eligibleTickers,
        missingTickers: Math.max(0, activeUniverse - built.eligibleTickers),
        missingByPeriod: built.missingByPeriod,
        historyStartDate: built.historyStartDate,
        historySessions: US_MONTHLY_MA_LIST_HISTORY_SESSIONS,
      },
      source: {
        definitionVersion: US_MONTHLY_MA_DEFINITION_VERSION,
        priceBasis: US_MONTHLY_MA_PRICE_BASIS,
        sourceGeneration: generation.generation,
        sourceGenerationStatus: 'attested',
        sourceNames,
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
      error: stableErrorCode(error, status),
    }, { status })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { sicMajorGroupFromCode, US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import { findUsAliasTickers, getUsDisplayName } from '@/lib/us-symbol-aliases'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'
import { buildShortTermCheck } from '@/lib/short-term-check'
import { readServingCache, stableCacheKey, writeServingCache } from '@/lib/api/serving-cache'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const SORT_KEYS = new Set([
  'ticker',
  'name',
  'price',
  'changePct',
  'volume',
  'avgVolume20',
  'marketCap',
  'stageCode',
  'sector',
  'industry',
  'exchange',
  'pms',
  'pfs',
  'pes',
  'shortTermCheckScore',
  'shortTermCheckLabel',
  'return5d',
  'return20d',
  'return60d',
  'return120d',
  'ma200Gap',
  'ma200Angle',
  'acceleration',
  'force',
  'earningsNextDate',
  'earningsDays',
])

const US_SCREENER_CACHE_NAMESPACE = 'us-screener-v6'
const EARNINGS_WINDOWS = new Set([14, 30, 60, 90, 180])
const EARNINGS_TIME_BUCKETS = new Set(['before_open', 'market_hours', 'after_close', 'unknown'])
const STAGE_AXES = [
  'daily_a',
  'daily_b',
  'weekly_a',
  'weekly_b',
  'monthly_a',
  'monthly_b',
] as const
type StageAxis = typeof STAGE_AXES[number]

type UsScreenerPayload = {
  market: 'US'
  date: string
  rows: Record<string, unknown>[]
  count: number
  hasMore: boolean
  facets: {
    exchanges: string[]
    sectors: string[]
    industryGroups: Array<{ sector: string | null; code: string; name: string }>
    industries: Array<{ sector: string | null; industryCode: string | null; industry: string }>
  }
  quality: 'standard' | 'all'
  source: 'tiingo'
  mlSource: 'us_analytics' | 'main'
  earnings: {
    source: 'finnhub'
    updatedAt: string | null
    latestRun: {
      status: string
      startedAt: string
      finishedAt: string | null
      rowsInserted: number
    } | null
  }
}

function numeric(value: unknown): number | null {
  if (value == null || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function numericParam(searchParams: URLSearchParams, key: string): number | null {
  const raw = searchParams.get(key)?.trim()
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function stageParams(searchParams: URLSearchParams): Partial<Record<StageAxis, number[]>> {
  const result: Partial<Record<StageAxis, number[]>> = {}
  for (const axis of STAGE_AXES) {
    const values = (searchParams.get(axis) ?? '')
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 6)
    if (values.length > 0) result[axis] = Array.from(new Set(values)).sort()
  }
  return result
}

function physicalStatusLabel(row: Record<string, unknown>): string {
  const acceleration = numeric(row.acceleration)
  const force = numeric(row.force)
  const pms = numeric(row.physical_momentum_score)
  if (acceleration == null || force == null || pms == null) return '算出待ち'
  if (acceleration > 0 && force > 0 && pms >= 1) return '上昇加速'
  if (force > 0 && pms >= 0.25) return '上昇継続'
  if (acceleration > 0 && force <= 0) return '反発準備'
  if (acceleration < 0 && force > 0) return '失速警戒'
  if (acceleration < 0 && force < 0 && pms <= -1) return '下落加速'
  if (force < 0 && pms < -0.25) return '弱含み'
  return '見送り'
}

function screenerCacheTtlMs(): number {
  const value = Number(process.env.US_SCREENER_CACHE_TTL_MS)
  return Number.isFinite(value) && value >= 60_000 ? value : 15 * 60 * 1_000
}

function todayInNewYork(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const date = searchParams.get('date') ?? (await execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date FROM market_daily_snapshots WHERE market = 'US'`,
    ))?.date
    if (!date) {
      return NextResponse.json({ market: 'US', date: null, rows: [], count: 0, message: 'US snapshots are not generated yet.' })
    }
    const limit = Math.min(1000, Math.max(1, Number(searchParams.get('limit') ?? 100)))
    const sort = SORT_KEYS.has(searchParams.get('sort') ?? '') ? searchParams.get('sort')! : 'ticker'
    const dir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
    const q = searchParams.get('q')?.trim().toUpperCase() ?? ''
    const taxonomy = searchParams.get('taxonomy') ?? US_SEC_SIC_TAXONOMY
    const sector = searchParams.get('sector')?.trim()
    const industryGroup = searchParams.get('industryGroup')?.trim()
    const industry = searchParams.get('industry')?.trim()
    const exchange = searchParams.get('exchange')?.trim()
    const stageCode = searchParams.get('stageCode')?.trim()
    const stages = stageParams(searchParams)
    const assetType = searchParams.get('assetType')?.trim()
    const quality = searchParams.get('quality') === 'all' ? 'all' : 'standard'
    const ma200Trend = searchParams.get('ma200Trend') === 'above'
      ? 'above'
      : searchParams.get('ma200Trend') === 'below'
        ? 'below'
        : ''
    const ma200Direction = searchParams.get('ma200Direction') === 'up'
      ? 'up'
      : searchParams.get('ma200Direction') === 'down'
        ? 'down'
        : searchParams.get('ma200Direction') === 'flat'
          ? 'flat'
          : ''
    const pmsMin = numericParam(searchParams, 'pmsMin')
    const pfsMin = numericParam(searchParams, 'pfsMin')
    const pesMin = numericParam(searchParams, 'pesMin')
    const marketCapMin = numericParam(searchParams, 'marketCapMin')
    const marketCapMax = numericParam(searchParams, 'marketCapMax')
    const accelerationPositive = searchParams.get('accelerationPositive') === '1'
    const forcePositive = searchParams.get('forcePositive') === '1'
    const stage23Candidate = searchParams.get('stage23Candidate') === '1'
    const shortTermCheck = searchParams.get('shortTermCheck')?.trim() ?? ''
    const physicalStatus = searchParams.get('physicalStatus')?.trim() ?? ''
    const earningsWindowValue = Number(searchParams.get('earningsWindowDays'))
    const earningsWindowDays = EARNINGS_WINDOWS.has(earningsWindowValue) ? earningsWindowValue : null
    const earningsTimeBucketValue = searchParams.get('earningsTimeBucket')?.trim() ?? ''
    const earningsTimeBucket = EARNINGS_TIME_BUCKETS.has(earningsTimeBucketValue)
      ? earningsTimeBucketValue
      : ''
    const earningsToday = todayInNewYork()
    const avgVolumeMinParam = searchParams.get('avgVolumeMin')?.trim()
    const priceMinParam = searchParams.get('priceMin')?.trim()
    const priceMaxParam = searchParams.get('priceMax')?.trim()
    const avgVolumeMin = avgVolumeMinParam ? Number(avgVolumeMinParam) : null
    const avgVolumeFilter = avgVolumeMin != null && Number.isFinite(avgVolumeMin) && avgVolumeMin > 0 ? avgVolumeMin : null
    const priceMin = priceMinParam ? Number(priceMinParam) : null
    const priceMax = priceMaxParam ? Number(priceMaxParam) : null
    const cacheTtlMs = screenerCacheTtlMs()
    const cacheKey = stableCacheKey({
      date,
      limit,
      sort,
      dir,
      q,
      taxonomy,
      sector: sector ?? '',
      industryGroup: industryGroup ?? '',
      industry: industry ?? '',
      exchange: exchange ?? '',
      stageCode: stageCode ?? '',
      stages,
      assetType: assetType ?? '',
      quality,
      ma200Trend,
      ma200Direction,
      pmsMin,
      pfsMin,
      pesMin,
      marketCapMin,
      marketCapMax,
      accelerationPositive,
      forcePositive,
      stage23Candidate,
      shortTermCheck,
      physicalStatus,
      earningsWindowDays,
      earningsTimeBucket,
      earningsToday,
      avgVolumeMin: avgVolumeMin != null && Number.isFinite(avgVolumeMin) ? avgVolumeMin : null,
      priceMin: priceMin != null && Number.isFinite(priceMin) ? priceMin : null,
      priceMax: priceMax != null && Number.isFinite(priceMax) ? priceMax : null,
    })
    const cached = await readServingCache<UsScreenerPayload>(
      US_SCREENER_CACHE_NAMESPACE,
      cacheKey,
      cacheTtlMs,
    ).catch(() => null)
    if (cached) {
      return NextResponse.json({
        ...cached.payload,
        cache: { status: 'hit', generatedAt: cached.generatedAt },
      })
    }
    const facetRows = await execAll<{
      exchange: string | null
      asset_type: string | null
      sector: string | null
      industry_code: string | null
      industry: string | null
    }>(
      `
      SELECT DISTINCT
        u.exchange,
        u.asset_type,
        COALESCE(c.sector_name, u.sector) AS sector,
        c.industry_code,
        COALESCE(c.industry_name, u.industry) AS industry
      FROM market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
      INNER JOIN market_universe u
        ON u.market = s.market
       AND u.ticker = s.ticker
       AND u.active = 1
      LEFT JOIN market_classifications c
        ON c.market = s.market
       AND c.ticker = s.ticker
       AND c.taxonomy = ?
       AND c.effective_from = '0000-01-01'
      WHERE s.market = 'US'
        AND s.date = ?
        AND ${usInvestableSymbolSql('s.ticker')}
      `,
      [taxonomy, date],
    )
    const industryGroupMap = new Map<string, { sector: string | null; code: string; name: string }>()
    for (const row of facetRows) {
      const group = sicMajorGroupFromCode(row.industry_code)
      if (!group) continue
      industryGroupMap.set(`${row.sector ?? ''}\u0000${group.code}`, {
        sector: row.sector,
        code: group.code,
        name: group.name,
      })
    }
    const facets = {
      exchanges: Array.from(new Set(
        facetRows.map((row) => row.exchange).filter((value): value is string => Boolean(value)),
      )).sort(),
      sectors: Array.from(new Set(
        facetRows.map((row) => row.sector).filter((value): value is string => Boolean(value)),
      )).sort(),
      industryGroups: Array.from(industryGroupMap.values()).sort((a, b) => (
        (a.sector ?? '').localeCompare(b.sector ?? '', 'en')
        || a.code.localeCompare(b.code, 'en')
      )),
      industries: Array.from(new Map(
        facetRows
          .filter((row): row is typeof row & { industry: string } => Boolean(row.industry))
          .map((row) => [`${row.sector ?? ''}\u0000${row.industry}`, {
            sector: row.sector,
            industryCode: row.industry_code,
            industry: row.industry,
          }]),
      ).values()).sort((a, b) => (
        (a.sector ?? '').localeCompare(b.sector ?? '', 'en')
        || a.industry.localeCompare(b.industry, 'en')
      )),
    }
    const qAliasTickers = q ? findUsAliasTickers(q) : []
    const qAliasPlaceholders = qAliasTickers.map(() => '?').join(',')
    const physicalSort = sort === 'pms' || sort === 'pfs' || sort === 'pes'
    const computedSort = (
      sort === 'shortTermCheckScore'
      || sort === 'shortTermCheckLabel'
      || sort === 'acceleration'
      || sort === 'force'
    )
    const hasStageFilters = Object.keys(stages).length > 0
    const hasComputedFilters = (
      pmsMin != null
      || pfsMin != null
      || pesMin != null
      || accelerationPositive
      || forcePositive
      || stage23Candidate
      || Boolean(shortTermCheck)
      || Boolean(physicalStatus)
    )
    const useAnalyticsMetricTop =
      physicalSort
      && hasUsAnalyticsDb()
      && !q
      && !sector
      && !industryGroup
      && !industry
      && !exchange
      && !stageCode
      && !hasStageFilters
      && !assetType
      && quality === 'standard'
      && !ma200Trend
      && !ma200Direction
      && !hasComputedFilters
      && earningsWindowDays == null
      && !earningsTimeBucket
      && marketCapMin == null
      && marketCapMax == null
      && !avgVolumeFilter
      && !(priceMin != null && Number.isFinite(priceMin))
      && !(priceMax != null && Number.isFinite(priceMax))
    const metricColumn =
      sort === 'pms' ? 'physical_momentum_score'
        : sort === 'pfs' ? 'physical_force_score'
          : 'physical_energy_score'
    const metricTopLimit = Math.max(limit * 2, 50)
    const topMetricRows = useAnalyticsMetricTop
      ? await execUsAnalyticsAll<{
          symbol: string
          physical_momentum_score: number | null
          physical_force_score: number | null
          physical_energy_score: number | null
          acceleration: number | null
          force: number | null
          ma5_angle: number | null
          ma25_angle: number | null
          ma75_angle: number | null
          ma200_angle: number | null
        }>(
          `
          WITH latest_date AS (
            SELECT MAX(date) AS date
            FROM physical_momentum_metrics
            WHERE market = 'US'
              AND date <= ?
          )
          SELECT
            symbol,
            physical_momentum_score,
            physical_force_score,
            physical_energy_score,
            acceleration,
            force,
            ma5_angle,
            ma25_angle,
            ma75_angle,
            ma200_angle
          FROM physical_momentum_metrics
          WHERE market = 'US'
            AND date = (SELECT date FROM latest_date)
            AND ${metricColumn} IS NOT NULL
          ORDER BY ${metricColumn} ${dir.toUpperCase()}, symbol ASC
          LIMIT ?
          `,
          [date, metricTopLimit],
        ).catch(() => [])
      : []
    const topMetricTickers = topMetricRows.map((row) => row.symbol).filter(Boolean)
    const metricMap = new Map(topMetricRows.map((row) => [row.symbol, row]))
    const sqlLimit = topMetricTickers.length > 0
      ? topMetricTickers.length
      : physicalSort || computedSort || hasComputedFilters
        ? Math.max(limit * 30, 5000)
        : limit + 1
    const whereMetricTop = topMetricTickers.length > 0 ? `AND s.ticker IN (${topMetricTickers.map(() => '?').join(',')})` : ''
    const physicalMetricColumns = useAnalyticsMetricTop
      ? `
        NULL AS physical_momentum_score,
        NULL AS physical_force_score,
        NULL AS physical_energy_score,
        NULL AS acceleration,
        NULL AS force,
        NULL AS ma5_angle,
        NULL AS ma25_angle,
        NULL AS ma75_angle,
        NULL AS metric_ma200_angle
      `
      : `
        pm.physical_momentum_score,
        pm.physical_force_score,
        pm.physical_energy_score,
        pm.acceleration,
        pm.force,
        pm.ma5_angle,
        pm.ma25_angle,
        pm.ma75_angle,
        pm.ma200_angle AS metric_ma200_angle
      `
    const physicalMetricJoin = useAnalyticsMetricTop
      ? ''
      : `
      LEFT JOIN physical_momentum_metrics pm
        ON pm.market = 'US'
       AND pm.symbol = s.ticker
       AND pm.date = s.date
      `
    const whereExchange = exchange ? `AND u.exchange = ?` : ''
    const whereAssetType = assetType ? `AND COALESCE(u.asset_type, '') = ?` : ''
    const whereQ = q
      ? `AND (s.ticker LIKE ? OR UPPER(COALESCE(u.name, '')) LIKE ?${qAliasTickers.length ? ` OR s.ticker IN (${qAliasPlaceholders})` : ''})`
      : ''
    const whereSector = sector ? `AND COALESCE(c.sector_name, u.sector) = ?` : ''
    const whereIndustryGroup = industryGroup
      ? `AND SUBSTR(PRINTF('%04d', CAST(c.industry_code AS INTEGER)), 1, 2) = ?`
      : ''
    const whereIndustry = industry ? `AND COALESCE(c.industry_name, u.industry) = ?` : ''
    const whereStageCode = stageCode ? `AND (s.daily_a_stage || s.daily_b_stage || s.weekly_a_stage || s.weekly_b_stage || s.monthly_a_stage || s.monthly_b_stage) LIKE ?` : ''
    const stageClauses = STAGE_AXES.flatMap((axis) => {
      const values = stages[axis]
      return values?.length
        ? [`AND s.${axis}_stage IN (${values.map(() => '?').join(',')})`]
        : []
    })
    const whereAvgVolume = avgVolumeFilter ? `AND COALESCE(periods.avg_volume_20, 0) >= ?` : ''
    const wherePriceMin = priceMin != null && Number.isFinite(priceMin) ? `AND COALESCE(cur.adj_close, cur.close) >= ?` : ''
    const wherePriceMax = priceMax != null && Number.isFinite(priceMax) ? `AND COALESCE(cur.adj_close, cur.close) <= ?` : ''
    const whereQuality = quality === 'standard'
      ? `AND COALESCE(cur.adj_close, cur.close) >= 0.1
         AND (
           COALESCE(u.asset_type, 'Stock') = 'Mutual Fund'
           OR COALESCE(cur.adj_volume, cur.volume) > 0
         )
         AND periods.prev_close > 0
         AND ABS(100.0 * (COALESCE(cur.adj_close, cur.close) - periods.prev_close) / periods.prev_close) <= 100`
         + `
         AND NOT (
           LENGTH(s.ticker) >= 5
           AND SUBSTR(s.ticker, -1, 1) IN ('W', 'U', 'R')
         )
         AND (
           periods.close_5d IS NULL
           OR ABS(100.0 * (COALESCE(cur.adj_close, cur.close) - periods.close_5d) / periods.close_5d) <= 200
         )
         AND (
           periods.close_20d IS NULL
           OR ABS(100.0 * (COALESCE(cur.adj_close, cur.close) - periods.close_20d) / periods.close_20d) <= 300
         )
         AND (
           periods.close_60d IS NULL
           OR ABS(100.0 * (COALESCE(cur.adj_close, cur.close) - periods.close_60d) / periods.close_60d) <= 500
         )
         AND (
           periods.close_120d IS NULL
           OR ABS(100.0 * (COALESCE(cur.adj_close, cur.close) - periods.close_120d) / periods.close_120d) <= 500
         )`
      : ''
    const whereMa200 = ma200Trend === 'above'
      ? 'AND periods.ma_200 IS NOT NULL AND COALESCE(cur.adj_close, cur.close) >= periods.ma_200'
      : ma200Trend === 'below'
        ? 'AND periods.ma_200 IS NOT NULL AND COALESCE(cur.adj_close, cur.close) < periods.ma_200'
        : ''
    const whereMa200Direction = ma200Direction === 'up'
      ? 'AND periods.ma_200_prev > 0 AND periods.ma_200 > periods.ma_200_prev * 1.0005'
      : ma200Direction === 'down'
        ? 'AND periods.ma_200_prev > 0 AND periods.ma_200 < periods.ma_200_prev * 0.9995'
        : ma200Direction === 'flat'
          ? 'AND periods.ma_200_prev > 0 AND ABS(periods.ma_200 - periods.ma_200_prev) / periods.ma_200_prev <= 0.0005'
          : ''
    const whereMarketCapMin = marketCapMin != null
      ? 'AND u.shares_outstanding * COALESCE(cur.adj_close, cur.close) >= ?'
      : ''
    const whereMarketCapMax = marketCapMax != null
      ? 'AND u.shares_outstanding * COALESCE(cur.adj_close, cur.close) < ?'
      : ''
    const whereEarningsWindow = earningsWindowDays != null
      ? `AND earnings.report_date <= date((SELECT today FROM earnings_clock), '+${earningsWindowDays} days')`
      : ''
    const whereEarningsBucket = earningsTimeBucket
      ? 'AND COALESCE(earnings.time_bucket, \'unknown\') = ?'
      : ''
    const whereKnownEarnings = sort === 'earningsNextDate' || sort === 'earningsDays'
      ? 'AND earnings.report_date IS NOT NULL'
      : ''
    const args: Array<string | number> = [date, earningsToday, taxonomy, date, date]
    if (q) args.push(`%${q}%`, `%${q.toUpperCase()}%`, ...qAliasTickers)
    if (sector) args.push(sector)
    if (industryGroup) args.push(industryGroup)
    if (industry) args.push(industry)
    if (exchange) args.push(exchange)
    if (assetType) args.push(assetType)
    if (stageCode) args.push(`${stageCode}%`)
    for (const axis of STAGE_AXES) {
      const values = stages[axis]
      if (values?.length) args.push(...values)
    }
    if (avgVolumeFilter) args.push(avgVolumeFilter)
    if (priceMin != null && Number.isFinite(priceMin)) args.push(priceMin)
    if (priceMax != null && Number.isFinite(priceMax)) args.push(priceMax)
    if (marketCapMin != null) args.push(marketCapMin)
    if (marketCapMax != null) args.push(marketCapMax)
    if (earningsTimeBucket) args.push(earningsTimeBucket)
    if (topMetricTickers.length > 0) args.push(...topMetricTickers)
    args.push(sqlLimit)

    const orderExpr: Record<string, string> = {
      ticker: 's.ticker',
      name: 'COALESCE(u.name, s.ticker)',
      price: 'COALESCE(cur.adj_close, cur.close)',
      changePct: 'change_pct',
      volume: 'COALESCE(cur.adj_volume, cur.volume)',
      avgVolume20: 'avg_volume_20',
      marketCap: 'market_cap',
      stageCode: 'stage_code',
      sector: 'sector',
      industry: 'industry',
      exchange: 'u.exchange',
      pms: 'pm.physical_momentum_score',
      pfs: 'pm.physical_force_score',
      pes: 'pm.physical_energy_score',
      shortTermCheckScore: 's.ticker',
      shortTermCheckLabel: 's.ticker',
      return5d: 'return_5d',
      return20d: 'return_20d',
      return60d: 'return_60d',
      return120d: 'return_120d',
      ma200Gap: 'ma_200_gap_pct',
      ma200Angle: 'ma_200_angle',
      acceleration: 's.ticker',
      force: 's.ticker',
      earningsNextDate: 'earnings.report_date',
      earningsDays: 'earnings_days',
    }
    const rows = await execAll<Record<string, unknown>>(
      `
      WITH lookback_dates AS (
        SELECT date, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM (
          SELECT DISTINCT date
          FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
          WHERE market = 'US' AND date <= ?
          ORDER BY date DESC
          LIMIT 201
        )
      ),
      earnings_clock AS (
        SELECT ? AS today
      ),
      next_earnings_dates AS (
        SELECT ticker, MIN(report_date) AS report_date
        FROM market_earnings_calendar INDEXED BY market_earnings_market_date_idx
        WHERE market = 'US'
          AND report_date >= (SELECT today FROM earnings_clock)
        GROUP BY ticker
      ),
      periods AS (
        SELECT
          o.ticker,
          MAX(CASE WHEN d.rn = 2 THEN COALESCE(o.adj_close, o.close) END) AS prev_close,
          MAX(CASE WHEN d.rn = 6 THEN COALESCE(o.adj_close, o.close) END) AS close_5d,
          MAX(CASE WHEN d.rn = 21 THEN COALESCE(o.adj_close, o.close) END) AS close_20d,
          MAX(CASE WHEN d.rn = 61 THEN COALESCE(o.adj_close, o.close) END) AS close_60d,
          MAX(CASE WHEN d.rn = 121 THEN COALESCE(o.adj_close, o.close) END) AS close_120d,
          AVG(CASE WHEN d.rn <= 20 THEN COALESCE(o.adj_volume, o.volume) END) AS avg_volume_20,
          AVG(CASE WHEN d.rn <= 200 THEN COALESCE(o.adj_close, o.close) END) AS ma_200,
          AVG(CASE WHEN d.rn BETWEEN 2 AND 201 THEN COALESCE(o.adj_close, o.close) END) AS ma_200_prev,
          COUNT(CASE WHEN d.rn <= 200 THEN 1 END) AS ma_200_observations
        FROM market_ohlcv_daily o
        INNER JOIN lookback_dates d ON d.date = o.date
        WHERE o.market = 'US'
        GROUP BY o.ticker
      )
      SELECT
        s.ticker,
        COALESCE(u.name, s.ticker) AS name,
        u.exchange,
        u.asset_type,
        COALESCE(c.sector_name, u.sector) AS sector,
        COALESCE(c.industry_name, u.industry) AS industry,
        c.taxonomy AS classification_taxonomy,
        c.source AS classification_source,
        COALESCE(cur.adj_close, cur.close) AS price,
        COALESCE(cur.adj_volume, cur.volume) AS volume,
        periods.avg_volume_20,
        CASE WHEN COALESCE(cur.adj_volume, cur.volume) > 0 AND periods.prev_close > 0 THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - periods.prev_close) / periods.prev_close END AS change_pct,
        CASE WHEN periods.close_5d > 0 THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - periods.close_5d) / periods.close_5d END AS return_5d,
        CASE WHEN periods.close_20d > 0 THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - periods.close_20d) / periods.close_20d END AS return_20d,
        CASE WHEN periods.close_60d > 0 THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - periods.close_60d) / periods.close_60d END AS return_60d,
        CASE WHEN periods.close_120d > 0 THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - periods.close_120d) / periods.close_120d END AS return_120d,
        periods.ma_200,
        CASE
          WHEN periods.ma_200_prev > 0
          THEN 100.0 * (periods.ma_200 - periods.ma_200_prev) / periods.ma_200_prev
        END AS ma_200_angle,
        periods.ma_200_observations,
        CASE WHEN periods.ma_200 > 0 THEN 100.0 * (COALESCE(cur.adj_close, cur.close) - periods.ma_200) / periods.ma_200 END AS ma_200_gap_pct,
        CASE WHEN u.shares_outstanding IS NOT NULL AND COALESCE(cur.adj_close, cur.close) IS NOT NULL THEN u.shares_outstanding * COALESCE(cur.adj_close, cur.close) END AS market_cap,
        s.daily_a_stage || s.daily_b_stage || s.weekly_a_stage || s.weekly_b_stage || s.monthly_a_stage || s.monthly_b_stage AS stage_code,
        s.daily_a_stage,
        s.daily_b_stage,
        s.weekly_a_stage,
        s.weekly_b_stage,
        s.monthly_a_stage,
        s.monthly_b_stage,
        s.ma_5,
        s.ma_25,
        s.ma_75,
        s.ma_300,
        earnings.report_date AS next_earnings_date,
        earnings.hour AS next_earnings_hour,
        COALESCE(earnings.time_bucket, 'unknown') AS next_earnings_time_bucket,
        earnings.fiscal_year AS next_earnings_fiscal_year,
        earnings.fiscal_quarter AS next_earnings_fiscal_quarter,
        earnings.eps_estimate AS next_earnings_eps_estimate,
        earnings.revenue_estimate AS next_earnings_revenue_estimate,
        earnings.source AS next_earnings_source,
        earnings.imported_at AS next_earnings_imported_at,
        CASE
          WHEN earnings.report_date IS NOT NULL
          THEN CAST(julianday(earnings.report_date) - julianday((SELECT today FROM earnings_clock)) AS INTEGER)
        END AS earnings_days,
        ${physicalMetricColumns}
      FROM market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
      LEFT JOIN market_universe u ON u.market = s.market AND u.ticker = s.ticker
      LEFT JOIN market_classifications c
        ON c.market = s.market
       AND c.ticker = s.ticker
       AND c.taxonomy = ?
       AND c.effective_from = '0000-01-01'
      LEFT JOIN market_ohlcv_daily cur INDEXED BY market_ohlcv_market_ticker_date_idx
        ON cur.market = 'US'
       AND cur.ticker = s.ticker
       AND cur.date = ?
      LEFT JOIN periods ON periods.ticker = s.ticker
      LEFT JOIN next_earnings_dates next_earnings
        ON next_earnings.ticker = s.ticker
      LEFT JOIN market_earnings_calendar earnings
        ON earnings.market = 'US'
       AND earnings.ticker = s.ticker
       AND earnings.report_date = next_earnings.report_date
      ${physicalMetricJoin}
      WHERE s.market = 'US' AND s.date = ?
        AND u.active = 1
        AND ${usInvestableSymbolSql('s.ticker')}
        ${whereQ}
        ${whereSector}
        ${whereIndustryGroup}
        ${whereIndustry}
        ${whereExchange}
        ${whereAssetType}
        ${whereStageCode}
        ${stageClauses.join('\n        ')}
        ${whereAvgVolume}
        ${wherePriceMin}
        ${wherePriceMax}
        ${whereQuality}
        ${whereMa200}
        ${whereMa200Direction}
        ${whereMarketCapMin}
        ${whereMarketCapMax}
        ${whereEarningsWindow}
        ${whereEarningsBucket}
        ${whereKnownEarnings}
        ${whereMetricTop}
      ORDER BY ${useAnalyticsMetricTop ? 's.ticker' : orderExpr[sort]} ${dir.toUpperCase()}, s.ticker ASC
      LIMIT ?
      `,
      args,
    )
    if (topMetricRows.length > 0) {
      for (const row of rows) {
        const metric = metricMap.get(String(row.ticker))
        if (!metric) continue
        row.physical_momentum_score = metric.physical_momentum_score
        row.physical_force_score = metric.physical_force_score
        row.physical_energy_score = metric.physical_energy_score
        row.acceleration = metric.acceleration
        row.force = metric.force
        row.ma5_angle = metric.ma5_angle
        row.ma25_angle = metric.ma25_angle
        row.ma75_angle = metric.ma75_angle
        row.metric_ma200_angle = metric.ma200_angle
      }
    }

    if (physicalSort) {
      const key =
        sort === 'pms' ? 'physical_momentum_score'
          : sort === 'pfs' ? 'physical_force_score'
            : 'physical_energy_score'
      rows.sort((a, b) => {
        const av = Number(a[key] ?? (dir === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY))
        const bv = Number(b[key] ?? (dir === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY))
        if (av === bv) return String(a.ticker).localeCompare(String(b.ticker))
        return dir === 'desc' ? bv - av : av - bv
      })
    }

    for (const row of rows) {
      row.name = getUsDisplayName(String(row.ticker), typeof row.name === 'string' ? row.name : null)
      const shortTerm = buildShortTermCheck({
        stages: {
          dailyA: numeric(row.daily_a_stage),
          dailyB: numeric(row.daily_b_stage),
          weeklyA: numeric(row.weekly_a_stage),
          weeklyB: numeric(row.weekly_b_stage),
          monthlyA: numeric(row.monthly_a_stage),
          monthlyB: numeric(row.monthly_b_stage),
        },
        physicalMomentumScore: numeric(row.physical_momentum_score),
        physicalForceScore: numeric(row.physical_force_score),
        changePercent: numeric(row.change_pct),
      })
      row.shortTermCheckLabel = shortTerm.label
      row.shortTermCheckScore = shortTerm.score
      row.shortTermCheckReasons = shortTerm.reasons
      row.shortTermCheckMlText = shortTerm.mlText
      row.physicalStatusLabel = physicalStatusLabel(row)
      const qualityFlags: string[] = []
      const changePct = numeric(row.change_pct)
      if (changePct != null && Math.abs(changePct) > 100) qualityFlags.push('異常騰落')
      if (String(row.asset_type ?? '') !== 'Mutual Fund' && (numeric(row.volume) ?? 0) <= 0) {
        qualityFlags.push('出来高0')
      }
      if ((numeric(row.price) ?? 0) < 0.1) qualityFlags.push('極低価格')
      if (
        String(row.ticker ?? '').length >= 5
        && /[WUR]$/.test(String(row.ticker ?? ''))
      ) qualityFlags.push('特殊証券記号')
      const return5d = numeric(row.return_5d)
      const return20d = numeric(row.return_20d)
      const return60d = numeric(row.return_60d)
      const return120d = numeric(row.return_120d)
      if (
        (return5d != null && Math.abs(return5d) > 200)
        || (return20d != null && Math.abs(return20d) > 300)
        || (return60d != null && Math.abs(return60d) > 500)
        || (return120d != null && Math.abs(return120d) > 500)
      ) {
        qualityFlags.push('期間不連続')
      }
      if ((numeric(row.ma_200_observations) ?? 0) < 200) qualityFlags.push('履歴200日未満')
      row.qualityFlags = qualityFlags
      row.qualityStatus = qualityFlags.some((flag) => flag !== '履歴200日未満') ? 'attention' : 'standard'
    }

    let filteredRows = rows
    if (pmsMin != null) {
      filteredRows = filteredRows.filter((row) => (numeric(row.physical_momentum_score) ?? Number.NEGATIVE_INFINITY) >= pmsMin)
    }
    if (pfsMin != null) {
      filteredRows = filteredRows.filter((row) => (numeric(row.physical_force_score) ?? Number.NEGATIVE_INFINITY) >= pfsMin)
    }
    if (pesMin != null) {
      filteredRows = filteredRows.filter((row) => (numeric(row.physical_energy_score) ?? Number.NEGATIVE_INFINITY) >= pesMin)
    }
    if (accelerationPositive) {
      filteredRows = filteredRows.filter((row) => (numeric(row.acceleration) ?? Number.NEGATIVE_INFINITY) > 0)
    }
    if (forcePositive) {
      filteredRows = filteredRows.filter((row) => (numeric(row.force) ?? Number.NEGATIVE_INFINITY) > 0)
    }
    if (stage23Candidate) {
      filteredRows = filteredRows.filter((row) => (
        (numeric(row.daily_a_stage) === 2 || numeric(row.daily_a_stage) === 3)
        && (numeric(row.physical_momentum_score) ?? Number.NEGATIVE_INFINITY) > 0
        && (numeric(row.physical_force_score) ?? Number.NEGATIVE_INFINITY) > 0
      ))
    }
    if (shortTermCheck) {
      filteredRows = filteredRows.filter((row) => row.shortTermCheckLabel === shortTermCheck)
    }
    if (physicalStatus) {
      filteredRows = filteredRows.filter((row) => row.physicalStatusLabel === physicalStatus)
    }

    if (computedSort) {
      filteredRows.sort((a, b) => {
        const av = sort === 'shortTermCheckScore'
          ? numeric(a.shortTermCheckScore)
          : sort === 'acceleration'
            ? numeric(a.acceleration)
            : sort === 'force'
              ? numeric(a.force)
              : String(a.shortTermCheckLabel ?? '')
        const bv = sort === 'shortTermCheckScore'
          ? numeric(b.shortTermCheckScore)
          : sort === 'acceleration'
            ? numeric(b.acceleration)
            : sort === 'force'
              ? numeric(b.force)
              : String(b.shortTermCheckLabel ?? '')
        if (typeof av === 'number' && typeof bv === 'number') {
          if (av === bv) return String(a.ticker).localeCompare(String(b.ticker))
          return dir === 'desc' ? bv - av : av - bv
        }
        const cmp = String(av).localeCompare(String(bv), 'ja')
        if (cmp !== 0) return dir === 'desc' ? -cmp : cmp
        return String(a.ticker).localeCompare(String(b.ticker))
      })
    }

    const candidatesTruncated = topMetricTickers.length === 0 && rows.length >= sqlLimit
    const [earningsSync, earningsRun] = await Promise.all([
      execGet<{ value: number | null }>(
        `SELECT MAX(imported_at) AS value
         FROM market_earnings_calendar
         WHERE market = 'US' AND source = 'finnhub'`,
      ).catch(() => undefined),
      execGet<{
        status: string
        startedAt: number
        finishedAt: number | null
        rowsInserted: number
      }>(
        `SELECT
           status,
           started_at AS startedAt,
           finished_at AS finishedAt,
           rows_inserted AS rowsInserted
         FROM market_data_runs
         WHERE market = 'US' AND job_type = 'finnhub_earnings'
         ORDER BY started_at DESC
         LIMIT 1`,
      ).catch(() => undefined),
    ])
    const payload: UsScreenerPayload = {
      market: 'US',
      date,
      rows: filteredRows.slice(0, limit),
      count: Math.min(filteredRows.length, limit),
      hasMore: filteredRows.length > limit || candidatesTruncated,
      facets,
      quality,
      source: 'tiingo',
      mlSource: hasUsAnalyticsDb() ? 'us_analytics' : 'main',
      earnings: {
        source: 'finnhub',
        updatedAt: earningsSync?.value
          ? new Date(earningsSync.value * 1000).toISOString()
          : null,
        latestRun: earningsRun ? {
          status: earningsRun.status,
          startedAt: new Date(earningsRun.startedAt * 1000).toISOString(),
          finishedAt: earningsRun.finishedAt
            ? new Date(earningsRun.finishedAt * 1000).toISOString()
            : null,
          rowsInserted: Number(earningsRun.rowsInserted ?? 0),
        } : null,
      },
    }
    const generatedAt = Date.now()
    await writeServingCache(
      US_SCREENER_CACHE_NAMESPACE,
      cacheKey,
      payload,
      cacheTtlMs,
      generatedAt,
    ).catch((error) => {
      console.warn('US screener cache write skipped:', error)
    })
    return NextResponse.json({
      ...payload,
      cache: { status: 'miss', generatedAt },
    })
  } catch (error) {
    console.error('US screener API error:', error)
    return NextResponse.json(
      { error: 'US screener failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}

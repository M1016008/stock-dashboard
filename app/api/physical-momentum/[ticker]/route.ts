import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import {
  PHYSICAL_MOMENTUM_LOOKBACK_DAYS,
  composePhysicalMomentumScores,
  computePhysicalMomentumRawRows,
  meanAndStd,
  zScore,
  type PhysicalMomentumRawKey,
} from '@/lib/physical-momentum'
import { intervalToSpec, resampleOhlcv, type ChartIntervalCode } from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'

export const runtime = 'nodejs'

type RouteContext = {
  params: Promise<{ ticker: string }>
}

type MomentumRow = {
  market: string
  symbol: string
  date: string
  velocity: number | null
  acceleration: number | null
  momentum: number | null
  force: number | null
  ma5Angle: number | null
  ma25Angle: number | null
  ma75Angle: number | null
  ma200Angle: number | null
  maAngleAvg: number | null
  energy: number | null
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

type RankRow = {
  rank: number | null
  totalRanked: number
}

type RuntimeMetricRow = {
  symbol: string
  velocity: number | null
  acceleration: number | null
  momentum: number | null
  force: number | null
  maAngleAvg: number | null
  energy: number | null
}

type ScoreSource = 'stored' | 'runtime_raw' | null

type MomentumPayload = {
  latest: MomentumRow | null
  history: MomentumRow[]
  rank: number | null
  totalRanked: number
  previousScore: number | null
  latestScoredDate: string | null
  scoreSource: ScoreSource
  isScoreRefreshRunning: boolean
}

type TimeframeMomentumView = {
  interval: 'D' | '2D' | 'W' | 'M'
  label: string
  basis: string
  latestDate: string | null
  lookbackBars: number
  approxTradingDays: number | null
  scoreSource: 'market_z' | 'local_timeframe_z'
  historyCount: number
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
  trend: 'rising' | 'falling' | 'flat' | null
}

type GetFn = <T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) => Promise<T | undefined>
type AllFn = <T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) => Promise<T[]>

const RAW_KEYS: PhysicalMomentumRawKey[] = [
  'velocity',
  'acceleration',
  'momentum',
  'force',
  'maAngleAvg',
  'energy',
]

const TIMEFRAME_DEFINITIONS: Array<{
  interval: TimeframeMomentumView['interval']
  label: string
  basis: string
  approxTradingDays: number | null
}> = [
  { interval: 'D', label: '短期 / 日足', basis: '20営業日', approxTradingDays: 20 },
  { interval: '2D', label: '短中期 / 2日足', basis: '20本 = 約40営業日', approxTradingDays: 40 },
  { interval: 'W', label: '中期 / 週足', basis: '20週', approxTradingDays: 100 },
  { interval: 'M', label: '長期 / 月足', basis: '20か月', approxTradingDays: null },
]

function normalizeMarket(value: string | null): string {
  const market = value?.trim().toUpperCase()
  return market === 'US' ? 'US' : 'JP'
}

function normalizeTicker(ticker: string, market: string): string {
  const cleaned = ticker.trim().toUpperCase()
  if (market === 'JP') return cleaned.replace(/\.T$/, '')
  return cleaned
}

function remapMarket(row: MomentumRow, market: string): MomentumRow {
  return { ...row, market }
}

function scoreTrend(current: number | null, previous: number | null): 'rising' | 'falling' | 'flat' | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous)) return null
  if (current > previous) return 'rising'
  if (current < previous) return 'falling'
  return 'flat'
}

function hasCompleteScores(row: MomentumRow | null): boolean {
  return row?.physicalMomentumScore != null
    && row.physicalForceScore != null
    && row.physicalEnergyScore != null
}

async function loadScoreRefreshRunning(get: GetFn): Promise<boolean> {
  const row = await get<{ jobType: string | null }>(
    `
      SELECT jobType
      FROM (
        SELECT job_type AS jobType, started_at AS startedAt
        FROM batch_runs
        WHERE status = 'running'
          AND job_type IN (
            'physical_momentum',
            'physical_momentum_us',
            'physical_momentum_us_normalize_chunk',
            'post_ohlcv_refresh',
            'update_latest',
            'us_update_latest'
          )
        UNION ALL
        SELECT job_type AS jobType, started_at AS startedAt
        FROM update_locks
        WHERE status = 'running'
          AND lease_expires_at > unixepoch()
          AND job_type IN ('post_ohlcv_refresh', 'update_latest', 'us_update_latest')
      )
      ORDER BY startedAt DESC
      LIMIT 1
    `,
  ).catch(() => undefined)
  return Boolean(row?.jobType)
}

async function computeRuntimeScoresForDate(
  all: AllFn,
  market: string,
  date: string,
): Promise<{ scoresBySymbol: Map<string, Pick<MomentumRow, 'physicalMomentumScore' | 'physicalForceScore' | 'physicalEnergyScore'>>; rankBySymbol: Map<string, RankRow> }> {
  const rows = await all<RuntimeMetricRow>(
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
  if (rows.length === 0) return { scoresBySymbol: new Map(), rankBySymbol: new Map() }

  const stats = Object.fromEntries(
    RAW_KEYS.map((key) => [key, meanAndStd(rows.map((row) => row[key]))]),
  ) as Record<PhysicalMomentumRawKey, { mean: number | null; std: number | null }>

  const scores = rows.map((row) => {
    const result = composePhysicalMomentumScores({
      zVelocity: zScore(row.velocity, stats.velocity.mean, stats.velocity.std),
      zAcceleration: zScore(row.acceleration, stats.acceleration.mean, stats.acceleration.std),
      zMomentum: zScore(row.momentum, stats.momentum.mean, stats.momentum.std),
      zForce: zScore(row.force, stats.force.mean, stats.force.std),
      zMaAngleAvg: zScore(row.maAngleAvg, stats.maAngleAvg.mean, stats.maAngleAvg.std),
      zEnergy: zScore(row.energy, stats.energy.mean, stats.energy.std),
    })
    return { symbol: row.symbol, ...result }
  })

  const scoresBySymbol = new Map<string, Pick<MomentumRow, 'physicalMomentumScore' | 'physicalForceScore' | 'physicalEnergyScore'>>()
  for (const row of scores) {
    scoresBySymbol.set(row.symbol, {
      physicalMomentumScore: row.physicalMomentumScore,
      physicalForceScore: row.physicalForceScore,
      physicalEnergyScore: row.physicalEnergyScore,
    })
  }

  const rankedScores = scores
    .map((row) => ({ symbol: row.symbol, score: row.physicalMomentumScore }))
    .filter((row): row is { symbol: string; score: number } => row.score != null && Number.isFinite(row.score))
  const totalRanked = rankedScores.length
  const rankBySymbol = new Map<string, RankRow>()
  for (const row of rankedScores) {
    const rank = rankedScores.reduce((count, other) => count + (other.score > row.score ? 1 : 0), 1)
    rankBySymbol.set(row.symbol, { rank, totalRanked })
  }

  return { scoresBySymbol, rankBySymbol }
}

function latestDailyTimeframeView(
  latest: MomentumRow,
  previousScore: number | null,
): TimeframeMomentumView {
  return {
    interval: 'D',
    label: '短期 / 日足',
    basis: '20営業日',
    latestDate: latest.date,
    lookbackBars: PHYSICAL_MOMENTUM_LOOKBACK_DAYS,
    approxTradingDays: 20,
    scoreSource: 'market_z',
    historyCount: 0,
    physicalMomentumScore: latest.physicalMomentumScore,
    physicalForceScore: latest.physicalForceScore,
    physicalEnergyScore: latest.physicalEnergyScore,
    trend: scoreTrend(latest.physicalMomentumScore, previousScore),
  }
}

function localTimeframeView(
  interval: Exclude<TimeframeMomentumView['interval'], 'D'>,
  candles: OHLCV[],
): TimeframeMomentumView | null {
  const definition = TIMEFRAME_DEFINITIONS.find((item) => item.interval === interval)
  if (!definition) return null

  const rawRows = computePhysicalMomentumRawRows(
    candles.map((row) => ({
      date: row.date,
      close: row.close,
      volume: row.volume,
    })),
    PHYSICAL_MOMENTUM_LOOKBACK_DAYS,
  )
  const scoredRows = rawRows.filter((row) => RAW_KEYS.some((key) => row[key] != null && Number.isFinite(row[key])))
  if (scoredRows.length === 0) {
    return {
      interval,
      label: definition.label,
      basis: definition.basis,
      latestDate: candles.at(-1)?.date ?? null,
      lookbackBars: PHYSICAL_MOMENTUM_LOOKBACK_DAYS,
      approxTradingDays: definition.approxTradingDays,
      scoreSource: 'local_timeframe_z',
      historyCount: candles.length,
      physicalMomentumScore: null,
      physicalForceScore: null,
      physicalEnergyScore: null,
      trend: null,
    }
  }

  const stats = Object.fromEntries(
    RAW_KEYS.map((key) => [key, meanAndStd(scoredRows.map((row) => row[key]))]),
  ) as Record<PhysicalMomentumRawKey, { mean: number | null; std: number | null }>

  const toScores = (row: typeof scoredRows[number] | undefined) => {
    if (!row) return null
    return composePhysicalMomentumScores({
      zVelocity: zScore(row.velocity, stats.velocity.mean, stats.velocity.std),
      zAcceleration: zScore(row.acceleration, stats.acceleration.mean, stats.acceleration.std),
      zMomentum: zScore(row.momentum, stats.momentum.mean, stats.momentum.std),
      zForce: zScore(row.force, stats.force.mean, stats.force.std),
      zMaAngleAvg: zScore(row.maAngleAvg, stats.maAngleAvg.mean, stats.maAngleAvg.std),
      zEnergy: zScore(row.energy, stats.energy.mean, stats.energy.std),
    })
  }

  const latestRaw = scoredRows[scoredRows.length - 1]
  const previousRaw = scoredRows.length >= 2 ? scoredRows[scoredRows.length - 2] : undefined
  const latestScores = toScores(latestRaw)
  const previousScores = toScores(previousRaw)

  return {
    interval,
    label: definition.label,
    basis: definition.basis,
    latestDate: latestRaw?.date ?? candles.at(-1)?.date ?? null,
    lookbackBars: PHYSICAL_MOMENTUM_LOOKBACK_DAYS,
    approxTradingDays: definition.approxTradingDays,
    scoreSource: 'local_timeframe_z',
    historyCount: scoredRows.length,
    physicalMomentumScore: latestScores?.physicalMomentumScore ?? null,
    physicalForceScore: latestScores?.physicalForceScore ?? null,
    physicalEnergyScore: latestScores?.physicalEnergyScore ?? null,
    trend: scoreTrend(latestScores?.physicalMomentumScore ?? null, previousScores?.physicalMomentumScore ?? null),
  }
}

async function loadPriceRowsForTimeframes(
  all: AllFn,
  dbMarket: string,
  ticker: string,
  asOfDate: string | null,
): Promise<OHLCV[]> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const sql = dbMarket === 'JP'
    ? `
        SELECT date, open, high, low, close, volume
        FROM ohlcv_daily
        WHERE ticker = ?
          ${dateFilter}
        ORDER BY date
      `
    : `
        SELECT date, open, high, low, close, volume
        FROM market_ohlcv_daily
        WHERE market = ?
          AND ticker = ?
          ${dateFilter}
        ORDER BY date
      `
  const args = dbMarket === 'JP'
    ? (asOfDate ? [ticker, asOfDate] : [ticker])
    : (asOfDate ? [dbMarket, ticker, asOfDate] : [dbMarket, ticker])
  const rows = await all<OHLCV>(sql, args)
  return rows
    .map((row) => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume ?? 0),
    }))
    .filter((row) => row.date && [row.open, row.high, row.low, row.close].every(Number.isFinite))
}

async function buildTimeframeViews(
  all: AllFn,
  dbMarket: string,
  ticker: string,
  asOfDate: string | null,
  latest: MomentumRow,
  previousScore: number | null,
): Promise<TimeframeMomentumView[]> {
  const views: TimeframeMomentumView[] = [latestDailyTimeframeView(latest, previousScore)]
  let prices = await loadPriceRowsForTimeframes(all, dbMarket, ticker, asOfDate).catch(() => [])
  if (prices.length === 0 && dbMarket !== 'JP' && all !== (execAll as AllFn)) {
    prices = await loadPriceRowsForTimeframes(execAll as AllFn, dbMarket, ticker, asOfDate).catch(() => [])
  }
  if (prices.length === 0) return views

  for (const interval of ['2D', 'W', 'M'] as const) {
    const candles = resampleOhlcv(prices, intervalToSpec(interval as ChartIntervalCode))
    const view = localTimeframeView(interval, candles)
    if (view) views.push(view)
  }
  return views
}

async function loadPayload(
  get: GetFn,
  all: AllFn,
  dbMarket: string,
  publicMarket: string,
  ticker: string,
  limit: number,
  asOfDate: string | null,
): Promise<MomentumPayload> {
  const dateFilter = asOfDate ? 'AND date <= ?' : ''
  const latest = await get<MomentumRow>(
    `
      SELECT
        market,
        symbol,
        date,
        velocity,
        acceleration,
        momentum,
        force,
        ma5_angle AS ma5Angle,
        ma25_angle AS ma25Angle,
        ma75_angle AS ma75Angle,
        ma200_angle AS ma200Angle,
        ma_angle_avg AS maAngleAvg,
        energy,
        physical_momentum_score AS physicalMomentumScore,
        physical_force_score AS physicalForceScore,
        physical_energy_score AS physicalEnergyScore
      FROM physical_momentum_metrics
      WHERE market = ?
        AND symbol = ?
        ${dateFilter}
      ORDER BY date DESC
      LIMIT 1
    `,
    asOfDate ? [dbMarket, ticker, asOfDate] : [dbMarket, ticker],
  )

  if (!latest) {
    return {
      latest: null,
      history: [],
      rank: null,
      totalRanked: 0,
      previousScore: null,
      latestScoredDate: null,
      scoreSource: null,
      isScoreRefreshRunning: false,
    }
  }

  const isScoreRefreshRunning = await loadScoreRefreshRunning(get)
  let latestForResponse = latest
  let runtimeRankRow: RankRow | undefined
  let scoreSource: ScoreSource = hasCompleteScores(latestForResponse) ? 'stored' : null

  if (isScoreRefreshRunning || !hasCompleteScores(latestForResponse)) {
    const runtimeScores = await computeRuntimeScoresForDate(all, dbMarket, latestForResponse.date).catch(() => null)
    const runtimeLatest = runtimeScores?.scoresBySymbol.get(ticker)
    if (
      runtimeLatest
      && runtimeLatest.physicalMomentumScore != null
      && runtimeLatest.physicalForceScore != null
      && runtimeLatest.physicalEnergyScore != null
    ) {
      latestForResponse = { ...latestForResponse, ...runtimeLatest }
      runtimeRankRow = runtimeScores?.rankBySymbol.get(ticker)
      scoreSource = 'runtime_raw'
    }
  }

  const [history, rankRow, prevRow, latestScoredRow] = await Promise.all([
    all<MomentumRow>(
      `
        SELECT *
        FROM (
          SELECT
            market,
            symbol,
            date,
            velocity,
            acceleration,
            momentum,
            force,
            ma5_angle AS ma5Angle,
            ma25_angle AS ma25Angle,
            ma75_angle AS ma75Angle,
            ma200_angle AS ma200Angle,
            ma_angle_avg AS maAngleAvg,
            energy,
            physical_momentum_score AS physicalMomentumScore,
            physical_force_score AS physicalForceScore,
            physical_energy_score AS physicalEnergyScore
          FROM physical_momentum_metrics
          WHERE market = ?
            AND symbol = ?
            AND date <= ?
          ORDER BY date DESC
          LIMIT ?
        )
        ORDER BY date
      `,
      [dbMarket, ticker, latest.date, limit],
    ),
    latestForResponse.physicalMomentumScore == null
      ? Promise.resolve(undefined)
      : runtimeRankRow
        ? Promise.resolve(runtimeRankRow)
      : get<RankRow>(
          `
            SELECT
              SUM(CASE WHEN physical_momentum_score > ? THEN 1 ELSE 0 END) + 1 AS rank,
              COUNT(*) AS totalRanked
            FROM physical_momentum_metrics
            WHERE market = ?
              AND date = ?
              AND physical_momentum_score IS NOT NULL
          `,
          [latestForResponse.physicalMomentumScore, dbMarket, latestForResponse.date],
        ),
    get<{ physicalMomentumScore: number | null }>(
      `
        SELECT physical_momentum_score AS physicalMomentumScore
        FROM physical_momentum_metrics
        WHERE market = ?
          AND symbol = ?
          AND date < ?
          AND physical_momentum_score IS NOT NULL
        ORDER BY date DESC
        LIMIT 1
      `,
      [dbMarket, ticker, latest.date],
    ),
    get<{ date: string | null }>(
      `
        SELECT date
        FROM physical_momentum_metrics
        WHERE market = ?
          AND symbol = ?
          ${dateFilter}
          AND physical_momentum_score IS NOT NULL
          AND physical_force_score IS NOT NULL
          AND physical_energy_score IS NOT NULL
        ORDER BY date DESC
        LIMIT 1
      `,
      asOfDate ? [dbMarket, ticker, asOfDate] : [dbMarket, ticker],
    ),
  ])

  const historyForResponse = history.map((row) => (
    row.date === latestForResponse.date && row.symbol === latestForResponse.symbol
      ? { ...row, ...latestForResponse }
      : row
  ))
  const latestScoreDate = scoreSource === 'runtime_raw'
    ? latestForResponse.date
    : latestScoredRow?.date ?? null

  return {
    latest: remapMarket(latestForResponse, publicMarket),
    history: historyForResponse.map((row) => remapMarket(row, publicMarket)),
    rank: rankRow?.rank ?? null,
    totalRanked: rankRow?.totalRanked ?? 0,
    previousScore: prevRow?.physicalMomentumScore ?? null,
    latestScoredDate: latestScoreDate,
    scoreSource,
    isScoreRefreshRunning,
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { ticker: rawTicker } = await context.params
  const market = normalizeMarket(request.nextUrl.searchParams.get('market'))
  const ticker = normalizeTicker(rawTicker, market)
  const limitParam = Number(request.nextUrl.searchParams.get('limit') ?? 260)
  const limit = Number.isFinite(limitParam) ? Math.max(20, Math.min(800, Math.floor(limitParam))) : 260
  const dateParam = request.nextUrl.searchParams.get('date')?.trim()
  const asOfDate = dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam) ? dateParam : null

  let payload: MomentumPayload
  let source: 'main' | 'us_analytics' = 'main'
  let activeAll: AllFn = execAll as AllFn
  let activeDbMarket = market
  if (market === 'US' && hasUsAnalyticsDb()) {
    payload = await loadPayload(
      execUsAnalyticsGet as GetFn,
      execUsAnalyticsAll as AllFn,
      'US',
      market,
      ticker,
      limit,
      asOfDate,
    ).catch(async (error: unknown) => {
      console.warn('US analytics physical momentum fallback:', error)
      activeAll = execAll as AllFn
      activeDbMarket = market
      return loadPayload(execGet as GetFn, execAll as AllFn, market, market, ticker, limit, asOfDate)
    })
    if (!payload.latest) {
      payload = await loadPayload(
        execUsAnalyticsGet as GetFn,
        execUsAnalyticsAll as AllFn,
        'JP',
        market,
        ticker,
        limit,
        asOfDate,
      ).catch(() => payload)
    }
    if (payload.latest) {
      source = 'us_analytics'
      activeAll = execUsAnalyticsAll as AllFn
      activeDbMarket = 'US'
    }
  } else {
    payload = await loadPayload(execGet as GetFn, execAll as AllFn, market, market, ticker, limit, asOfDate)
  }

  if (!payload.latest) {
    return NextResponse.json({
      ok: true,
      market,
      ticker,
      latest: null,
      history: [],
      rank: null,
      totalRanked: 0,
      trend: null,
      source,
      requestedDate: asOfDate,
      latestScoredDate: null,
      isScoreFresh: false,
      scoreSource: null,
      isScoreRefreshRunning: false,
      timeframeViews: [],
    })
  }

  const previousScore = payload.previousScore
  const latest = payload.latest
  const currentScore = latest.physicalMomentumScore ?? null
  const trend =
    currentScore == null || previousScore == null
      ? null
      : currentScore > previousScore
        ? 'rising'
        : currentScore < previousScore
          ? 'falling'
          : 'flat'

  const timeframeViews = await buildTimeframeViews(
    activeAll,
    activeDbMarket,
    ticker,
    asOfDate,
    latest,
    previousScore,
  )

  return NextResponse.json({
    ok: true,
    market,
    ticker,
    latest,
    history: payload.history,
    rank: payload.rank,
    totalRanked: payload.totalRanked,
    trend,
    source,
    requestedDate: asOfDate,
    latestScoredDate: payload.latestScoredDate,
    isScoreFresh: payload.latestScoredDate === latest.date,
    scoreSource: payload.scoreSource,
    isScoreRefreshRunning: payload.isScoreRefreshRunning,
    timeframeViews,
  })
}

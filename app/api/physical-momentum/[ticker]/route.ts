import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'

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

type MomentumPayload = {
  latest: MomentumRow | null
  history: MomentumRow[]
  rank: number | null
  totalRanked: number
  previousScore: number | null
}

type GetFn = <T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) => Promise<T | undefined>
type AllFn = <T = Record<string, unknown>>(sql: string, args?: readonly unknown[]) => Promise<T[]>

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
        AND physical_momentum_score IS NOT NULL
      ORDER BY date DESC
      LIMIT 1
    `,
    asOfDate ? [dbMarket, ticker, asOfDate] : [dbMarket, ticker],
  )

  if (!latest) {
    return { latest: null, history: [], rank: null, totalRanked: 0, previousScore: null }
  }

  const [history, rankRow, prevRow] = await Promise.all([
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
    get<RankRow>(
      `
        SELECT
          SUM(CASE WHEN physical_momentum_score > ? THEN 1 ELSE 0 END) + 1 AS rank,
          COUNT(*) AS totalRanked
        FROM physical_momentum_metrics
        WHERE market = ?
          AND date = ?
          AND physical_momentum_score IS NOT NULL
      `,
      [latest.physicalMomentumScore ?? 0, dbMarket, latest.date],
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
  ])

  return {
    latest: remapMarket(latest, publicMarket),
    history: history.map((row) => remapMarket(row, publicMarket)),
    rank: rankRow?.rank ?? null,
    totalRanked: rankRow?.totalRanked ?? 0,
    previousScore: prevRow?.physicalMomentumScore ?? null,
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
    if (payload.latest) source = 'us_analytics'
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
  })
}

import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'

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

function normalizeMarket(value: string | null): string {
  const market = value?.trim().toUpperCase()
  return market === 'US' ? 'US' : 'JP'
}

function normalizeTicker(ticker: string, market: string): string {
  const cleaned = ticker.trim().toUpperCase()
  if (market === 'JP') return cleaned.replace(/\.T$/, '')
  return cleaned
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { ticker: rawTicker } = await context.params
  const market = normalizeMarket(request.nextUrl.searchParams.get('market'))
  const ticker = normalizeTicker(rawTicker, market)
  const limitParam = Number(request.nextUrl.searchParams.get('limit') ?? 260)
  const limit = Number.isFinite(limitParam) ? Math.max(20, Math.min(800, Math.floor(limitParam))) : 260

  const latest = await execGet<MomentumRow>(
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
      ORDER BY date DESC
      LIMIT 1
    `,
    [market, ticker],
  )

  if (!latest) {
    return NextResponse.json({
      ok: true,
      market,
      ticker,
      latest: null,
      history: [],
      rank: null,
      totalRanked: 0,
      trend: null,
    })
  }

  const [history, rankRow, prevRow] = await Promise.all([
    execAll<MomentumRow>(
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
          ORDER BY date DESC
          LIMIT ?
        )
        ORDER BY date
      `,
      [market, ticker, limit],
    ),
    execGet<{ rank: number | null; totalRanked: number }>(
      `
        SELECT
          SUM(CASE WHEN physical_momentum_score > ? THEN 1 ELSE 0 END) + 1 AS rank,
          COUNT(*) AS totalRanked
        FROM physical_momentum_metrics
        WHERE market = ?
          AND date = ?
          AND physical_momentum_score IS NOT NULL
      `,
      [latest.physicalMomentumScore ?? 0, market, latest.date],
    ),
    execGet<{ physicalMomentumScore: number | null }>(
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
      [market, ticker, latest.date],
    ),
  ])

  const previousScore = prevRow?.physicalMomentumScore ?? null
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
    history,
    rank: rankRow?.rank ?? null,
    totalRanked: rankRow?.totalRanked ?? 0,
    trend,
  })
}

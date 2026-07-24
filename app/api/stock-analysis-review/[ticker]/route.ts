import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { normalizeMarket, normalizeTickerForMarket, type MarketCode } from '@/lib/markets'
import { loadManualOhlcvRows } from '@/lib/manual-ohlcv'
import type { OHLCV } from '@/types/stock'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const HORIZONS = [5, 10, 20, 40, 60, 90, 120, 200] as const

type RouteContext = {
  params: Promise<{ ticker: string }>
}

type DatedRow = {
  date: string | null
}

function parseDate(value: string | null): string | null {
  const date = value?.trim() ?? ''
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function round(value: number | null | undefined, digits = 2): number | null {
  if (!finite(value)) return null
  return Number(value.toFixed(digits))
}

function pct(base: number, value: number | null | undefined): number | null {
  if (!finite(value) || !finite(base) || base === 0) return null
  return round(((value - base) / base) * 100)
}

async function loadPrices(ticker: string, market: MarketCode): Promise<OHLCV[]> {
  const rows = market === 'US'
    ? await execAll<OHLCV>(
      `
        SELECT date, open, high, low, close, volume, adj_close AS adjustedClose
        FROM market_ohlcv_daily
        WHERE market = 'US'
          AND ticker = ?
        ORDER BY date
      `,
      [ticker],
    )
    : await execAll<OHLCV>(
      `
        SELECT date, open, high, low, close, volume
        FROM ohlcv_daily
        WHERE ticker = ?
        ORDER BY date
      `,
      [ticker],
    )

  if (rows.length > 0 || market === 'US') return rows
  return loadManualOhlcvRows(ticker)
}

async function loadCoverageDate(
  ticker: string,
  market: MarketCode,
  date: string,
  source: 'feature' | 'physical' | 'stage',
): Promise<string | null> {
  if (source === 'stage') {
    const table = market === 'US' ? 'market_daily_snapshots' : 'daily_snapshots'
    const marketClause = market === 'US' ? `market = 'US' AND` : ''
    return (await execGet<DatedRow>(
      `
        SELECT MAX(date) AS date
        FROM ${table}
        WHERE ${marketClause} ticker = ?
          AND date <= ?
      `,
      [ticker, date],
    ).catch(() => undefined))?.date ?? null
  }

  const get = market === 'US' && hasUsAnalyticsDb() ? execUsAnalyticsGet : execGet
  if (source === 'feature') {
    return (await get<DatedRow>(
      `
        SELECT MAX(date) AS date
        FROM ml_feature_vectors_v2
        WHERE feature_set = ?
          AND ticker = ?
          AND date <= ?
      `,
      [ML_PHYSICS_FEATURE_SET, ticker, date],
    ).catch(() => undefined))?.date ?? null
  }

  const preferredMarket = market === 'US' && hasUsAnalyticsDb() ? 'US' : market
  return (await get<DatedRow>(
    `
      SELECT MAX(date) AS date
      FROM physical_momentum_metrics
      WHERE market = ?
        AND symbol = ?
        AND date <= ?
    `,
    [preferredMarket, ticker, date],
  ).catch(() => undefined))?.date ?? null
}

function buildOutcome(prices: OHLCV[], baseIndex: number, horizonDays: number) {
  const base = prices[baseIndex]
  const availableDays = Math.max(0, prices.length - baseIndex - 1)
  const observedDays = Math.min(horizonDays, availableDays)
  if (!base || observedDays === 0) {
    return {
      horizonDays,
      observedDays: 0,
      complete: false,
      targetDate: null,
      close: null,
      returnPct: null,
      maxReturnPct: null,
      minReturnPct: null,
    }
  }

  const window = prices.slice(baseIndex + 1, baseIndex + observedDays + 1)
  const target = window[window.length - 1]
  const highest = window.reduce<number | null>((value, row) => (
    finite(row.high) ? Math.max(value ?? row.high, row.high) : value
  ), null)
  const lowest = window.reduce<number | null>((value, row) => (
    finite(row.low) ? Math.min(value ?? row.low, row.low) : value
  ), null)

  return {
    horizonDays,
    observedDays,
    complete: availableDays >= horizonDays,
    targetDate: target?.date ?? null,
    close: finite(target?.close) ? target.close : null,
    returnPct: pct(base.close, target?.close),
    maxReturnPct: pct(base.close, highest),
    minReturnPct: pct(base.close, lowest),
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { ticker: rawTicker } = await context.params
    const market = normalizeMarket(request.nextUrl.searchParams.get('market'))
    const requestedDate = parseDate(request.nextUrl.searchParams.get('date'))
    if (!requestedDate) {
      return NextResponse.json(
        { ok: false, error: 'invalid_date', message: 'date must be YYYY-MM-DD' },
        { status: 400 },
      )
    }

    const ticker = normalizeTickerForMarket(rawTicker, market)
    const prices = await loadPrices(ticker, market)
    const baseIndex = prices.findLastIndex((row) => row.date <= requestedDate)
    if (baseIndex < 0) {
      return NextResponse.json({
        ok: true,
        available: false,
        ticker,
        market,
        requestedDate,
        message: '指定日以前の価格データがありません。',
      })
    }

    const base = prices[baseIndex]
    const previous = prices[baseIndex - 1] ?? null
    const next = prices[baseIndex + 1] ?? null
    const trailingYear = prices.slice(Math.max(0, baseIndex - 251), baseIndex + 1)
    const [featureDate, physicalDate, stageDate] = await Promise.all([
      loadCoverageDate(ticker, market, base.date, 'feature'),
      loadCoverageDate(ticker, market, base.date, 'physical'),
      loadCoverageDate(ticker, market, base.date, 'stage'),
    ])

    return NextResponse.json({
      ok: true,
      available: true,
      ticker,
      market,
      requestedDate,
      latestAvailableDate: prices.at(-1)?.date ?? base.date,
      base: {
        date: base.date,
        open: base.open,
        high: base.high,
        low: base.low,
        close: base.close,
        volume: base.volume,
        previousDate: previous?.date ?? null,
        previousClose: previous?.close ?? null,
        change: previous && finite(previous.close) ? round(base.close - previous.close) : null,
        changePercent: previous ? pct(previous.close, base.close) : null,
        fiftyTwoWeekHigh: trailingYear.reduce<number | null>((value, row) => (
          finite(row.high) ? Math.max(value ?? row.high, row.high) : value
        ), null),
        fiftyTwoWeekLow: trailingYear.reduce<number | null>((value, row) => (
          finite(row.low) ? Math.min(value ?? row.low, row.low) : value
        ), null),
      },
      adjacent: {
        previousDate: previous?.date ?? null,
        nextDate: next?.date ?? null,
      },
      coverage: {
        price: base.date,
        stage: stageDate,
        physicalMomentum: physicalDate,
        feature: featureDate,
      },
      outcomes: HORIZONS.map((horizon) => buildOutcome(prices, baseIndex, horizon)),
    })
  } catch (error) {
    console.error('stock analysis review API error:', error)
    return NextResponse.json(
      { ok: false, error: 'stock_analysis_review_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}

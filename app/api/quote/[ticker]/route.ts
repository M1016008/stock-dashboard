// app/api/quote/[ticker]/route.ts
// Phase 3.5: 現在価格 = ローカル DB ohlcv_daily の最新行
// Phase 3.6: + 52週高値/安値 (SQL aggregate) + 時価総額 (price × shares_outstanding)
import { NextRequest, NextResponse } from 'next/server'
import { db, client } from '@/lib/db/client'
import { ohlcvDaily, tickerUniverse } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import type { StockQuote } from '@/types/stock'
import { getManualOhlcvHiLo, loadManualLatestOhlcvRows } from '@/lib/manual-ohlcv'
import { buildQuoteTechnicalSummary } from '@/lib/quote-technicals'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

interface QuotePriceRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = decodePathSegment(rawTicker).replace(/\.T$/i, '')

    // 前日比・30日平均出来高・MACDの計算に必要な履歴
    let priceSource: 'jquants' | 'manual_ohlcv' = 'jquants'
    let rows: QuotePriceRow[] = await db
      .select({
        date: ohlcvDaily.date,
        open: ohlcvDaily.open,
        high: ohlcvDaily.high,
        low: ohlcvDaily.low,
        close: ohlcvDaily.close,
        volume: ohlcvDaily.volume,
      })
      .from(ohlcvDaily)
      .where(eq(ohlcvDaily.ticker, ticker))
      .orderBy(desc(ohlcvDaily.date))
      .limit(260)

    if (rows.length === 0) {
      rows = await loadManualLatestOhlcvRows(ticker, 260)
      if (rows.length > 0) {
        priceSource = 'manual_ohlcv'
      }
    }

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'No data', message: `ticker ${ticker} not found in ohlcv_daily or manual_ohlcv_daily` },
        { status: 404 },
      )
    }

    const latest = rows[0]
    const prev = rows[1]
    const change = prev ? latest.close - prev.close : 0
    const changePercent = prev && prev.close !== 0 ? (change / prev.close) * 100 : 0
    const technicals = buildQuoteTechnicalSummary([...rows].reverse())

    // 52 週高値/安値 (約 252 営業日)
    const since52w = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
    let fiftyTwoWeekHigh: number | undefined
    let fiftyTwoWeekLow: number | undefined
    if (priceSource === 'manual_ohlcv') {
      const row = await getManualOhlcvHiLo(ticker, since52w)
      fiftyTwoWeekHigh = row.hi
      fiftyTwoWeekLow = row.lo
    } else {
      const hiLoRes = await client.execute({
        sql: 'SELECT MAX(high) AS hi, MIN(low) AS lo FROM ohlcv_daily WHERE ticker = ? AND date >= ?',
        args: [ticker, since52w],
      })
      const row = hiLoRes.rows[0] as unknown as { hi: number | null; lo: number | null }
      fiftyTwoWeekHigh = row?.hi ?? undefined
      fiftyTwoWeekLow = row?.lo ?? undefined
    }

    // 名前 + 発行済株式数 (時価総額計算用)
    const uniRow = await db
      .select({
        name: tickerUniverse.name,
        shares_outstanding: tickerUniverse.shares_outstanding,
      })
      .from(tickerUniverse)
      .where(eq(tickerUniverse.ticker, ticker))
      .limit(1)
    const name = uniRow[0]?.name ?? ticker
    const shares = uniRow[0]?.shares_outstanding ?? null
    const marketCap = (shares != null && shares > 0)
      ? latest.close * shares
      : undefined

    const quote: StockQuote = {
      ticker,
      market: 'JP',
      currency: 'JPY',
      name,
      price: latest.close,
      change,
      changePercent,
      volume: latest.volume,
      priceDate: latest.date,
      previousPriceDate: prev?.date,
      priceQualityWarning: priceSource === 'manual_ohlcv'
        ? 'J-Quants未収録の補完価格データを表示'
        : undefined,
      marketCap,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      technicals: technicals ?? undefined,
      exchange: priceSource === 'manual_ohlcv' ? 'MANUAL' : 'TSE',
    }

    return NextResponse.json(quote)
  } catch (error) {
    console.error('Quote API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch quote', message: (error as Error).message },
      { status: 500 },
    )
  }
}

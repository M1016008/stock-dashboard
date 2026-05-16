// app/api/quote/[ticker]/route.ts
// Phase 3.5: 現在価格 = ローカル DB ohlcv_daily の最新行
// Phase 3.6: + 52週高値/安値 (SQL aggregate) + 時価総額 (price × shares_outstanding)
import { NextRequest, NextResponse } from 'next/server'
import { db, client } from '@/lib/db/client'
import { ohlcvDaily, tickerUniverse } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import type { StockQuote } from '@/types/stock'

export const revalidate = 60

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = decodeURIComponent(rawTicker).replace(/\.T$/i, '')

    // 直近 2 営業日 (前日比計算用)
    const rows = await db
      .select()
      .from(ohlcvDaily)
      .where(eq(ohlcvDaily.ticker, ticker))
      .orderBy(desc(ohlcvDaily.date))
      .limit(2)

    if (rows.length === 0) {
      return NextResponse.json(
        { error: 'No data', message: `ticker ${ticker} not found in ohlcv_daily` },
        { status: 404 },
      )
    }

    const latest = rows[0]
    const prev = rows[1]
    const change = prev ? latest.close - prev.close : 0
    const changePercent = prev && prev.close !== 0 ? (change / prev.close) * 100 : 0

    // 52 週高値/安値 (約 252 営業日)
    const since52w = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)
    const hiLoRes = await client.execute({
      sql: 'SELECT MAX(high) AS hi, MIN(low) AS lo FROM ohlcv_daily WHERE ticker = ? AND date >= ?',
      args: [ticker, since52w],
    })
    const hiLoRow = hiLoRes.rows[0] as unknown as { hi: number | null; lo: number | null }
    const fiftyTwoWeekHigh = hiLoRow?.hi ?? undefined
    const fiftyTwoWeekLow  = hiLoRow?.lo ?? undefined

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
      marketCap,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      exchange: 'TSE',
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

// app/api/quote/[ticker]/route.ts
// 現在価格を「ローカル DB の ohlcv_daily 最新行」から返す (Phase 3.5 で Yahoo から置換)。
// リアルタイム性は諦め、夜間バッチで更新された終値を返す。
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
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

    // 直近 2 営業日分の OHLCV を取得 (前日比計算のため)
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

    // 名前は ticker_universe から
    const uniRow = await db
      .select({ name: tickerUniverse.name })
      .from(tickerUniverse)
      .where(eq(tickerUniverse.ticker, ticker))
      .limit(1)
    const name = uniRow[0]?.name ?? ticker

    const quote: StockQuote = {
      ticker,
      market: 'JP',
      currency: 'JPY',
      name,
      price: latest.close,
      change,
      changePercent,
      volume: latest.volume,
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

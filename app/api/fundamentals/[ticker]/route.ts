// app/api/fundamentals/[ticker]/route.ts
// Phase 3.5 で完全書き換え: Yahoo の代わりに J-Quants Premium /fins/summary を使う。
// PER / PBR / ROE / 配当利回りは latest 通期レコードと「ローカル DB の最新終値」から計算。
// セクター情報は ticker_universe (J-Quants /equities/master 由来) から。
//
// 注: Premium プランが必要 (Standard では /fins/summary が呼べない)。

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { ohlcvDaily, tickerUniverse } from '@/lib/db/schema'
import { desc, eq } from 'drizzle-orm'
import { fetchJQuantsFinsSummary, computeFundamentals } from '@/lib/jquants'
import type { Fundamentals } from '@/types/stock'

export const revalidate = 3600

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await params
    const ticker = decodeURIComponent(rawTicker).replace(/\.T$/i, '')

    // 1. ローカル DB から最新終値を取得 (PER/PBR/配当利回り計算に必要)
    const [latest] = await db
      .select({ close: ohlcvDaily.close })
      .from(ohlcvDaily)
      .where(eq(ohlcvDaily.ticker, ticker))
      .orderBy(desc(ohlcvDaily.date))
      .limit(1)
    const currentPrice = latest?.close ?? null

    // 2. J-Quants Premium から財務サマリを取得
    let finsRows: Awaited<ReturnType<typeof fetchJQuantsFinsSummary>> = []
    try {
      finsRows = await fetchJQuantsFinsSummary(ticker)
    } catch (err) {
      // Premium プラン未契約 / 銘柄に財務情報なし などのケース
      console.warn(`fins/summary failed for ${ticker}:`, (err as Error).message)
    }

    const computed = computeFundamentals(finsRows, currentPrice)

    // 3. セクター情報は ticker_universe + (将来 sector_master) から
    //    現状は ticker_universe に sector フィールドがないので、空のまま
    const result: Fundamentals = {
      per:           computed.per,
      pbr:           computed.pbr,
      roe:           computed.roe,
      eps:           computed.eps,
      dividendYield: computed.dividendYield,
      revenue:       undefined,         // /fins/summary に直接 sales があるが用途不明、必要なら追加
      operatingIncome: undefined,       // 同上
    }

    // ticker_universe に name は入っているが業種分類はまだ。
    // (将来 batch:listed-info で J-Quants から S17/S33 を入れたら反映)
    const uni = await db
      .select({ name: tickerUniverse.name })
      .from(tickerUniverse)
      .where(eq(tickerUniverse.ticker, ticker))
      .limit(1)
    if (uni[0]?.name) {
      // 銘柄名は別 API で返している、ここでは追加情報なし
    }

    return NextResponse.json(result)
  } catch (error) {
    console.error('Fundamentals API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch fundamentals', message: (error as Error).message },
      { status: 500 },
    )
  }
}

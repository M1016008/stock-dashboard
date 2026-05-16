// app/api/search/route.ts
// Phase 3.5 で完全書き換え: Yahoo search の代わりに、
// ローカル ticker_universe を ticker または name の LIKE で検索する。

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db/client'
import { tickerUniverse } from '@/lib/db/schema'
import { and, eq, like, or } from 'drizzle-orm'

export const revalidate = 0

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const q = (searchParams.get('q') ?? '').trim()
    if (q.length < 1) {
      return NextResponse.json([])
    }

    const escaped = q.replace(/[%_]/g, m => '\\' + m)
    const pattern = `%${escaped}%`

    const rows = await db
      .select({
        ticker: tickerUniverse.ticker,
        name:   tickerUniverse.name,
      })
      .from(tickerUniverse)
      .where(and(
        eq(tickerUniverse.active, true),
        or(like(tickerUniverse.ticker, pattern), like(tickerUniverse.name, pattern)),
      ))
      .limit(10)

    return NextResponse.json(
      rows.map(r => ({
        ticker: r.ticker,
        name:   r.name ?? r.ticker,
        market: 'JP' as const,
      })),
    )
  } catch (error) {
    console.error('Search API error:', error)
    return NextResponse.json(
      { error: 'Search failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}

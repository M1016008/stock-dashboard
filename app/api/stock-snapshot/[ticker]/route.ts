// app/api/stock-snapshot/[ticker]/route.ts
// 個別銘柄の最新スナップショット情報（決算日など）を返す。

import { NextResponse } from 'next/server'
import { execGet } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

interface Row {
  date: string
  ticker: string
  name: string
  earnings_last_date: string | null
  earnings_next_date: string | null
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker: rawTicker } = await context.params
  const ticker = decodeURIComponent(rawTicker)

  const row = await execGet<Row>(
    `SELECT date, ticker, name, earnings_last_date, earnings_next_date
     FROM tv_daily_snapshots
     WHERE ticker = ?
     ORDER BY date DESC
     LIMIT 1`,
    [ticker],
  )

  if (!row) {
    return NextResponse.json({
      ticker,
      date: null,
      earningsLastDate: null,
      earningsNextDate: null,
    })
  }

  return NextResponse.json({
    ticker: row.ticker,
    name: row.name,
    date: row.date,
    earningsLastDate: row.earnings_last_date,
    earningsNextDate: row.earnings_next_date,
  })
}

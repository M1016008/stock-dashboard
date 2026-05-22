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

interface ServingMetricRow {
  as_of_date: string
  payload_json: string
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker: rawTicker } = await context.params
  const ticker = decodeURIComponent(rawTicker)

  const serving = await execGet<ServingMetricRow>(
    `SELECT as_of_date, payload_json FROM serving_stock_metrics WHERE ticker = ?`,
    [ticker],
  )
  if (serving) {
    const payload = parseJson(serving.payload_json)
    const earnings = payload.earnings as { previousDate?: string | null; nextDate?: string | null } | undefined
    return NextResponse.json({
      ticker,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      date: serving.as_of_date,
      earningsLastDate: earnings?.previousDate ?? null,
      earningsNextDate: earnings?.nextDate ?? null,
      source: 'serving_stock_metrics',
    })
  }

  const row = await execGet<Row>(
    `SELECT date, ticker, name, earnings_last_date, earnings_next_date
     FROM tv_daily_snapshots
     WHERE ticker = ?
     ORDER BY date DESC
     LIMIT 1`,
    [ticker],
  )

  if (!row) {
    const latest = await execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date FROM ohlcv_daily WHERE ticker = ?`,
      [ticker],
    )
    const previous = await execGet<{ announce_date: string | null }>(
      `SELECT MAX(announce_date) AS announce_date FROM earnings_calendar WHERE ticker = ? AND announce_date <= COALESCE(?, date('now'))`,
      [ticker, latest?.date ?? null],
    )
    const next = await execGet<{ announce_date: string | null }>(
      `SELECT MIN(announce_date) AS announce_date FROM earnings_calendar WHERE ticker = ? AND announce_date > COALESCE(?, date('now'))`,
      [ticker, latest?.date ?? null],
    )
    return NextResponse.json({
      ticker,
      date: latest?.date ?? null,
      earningsLastDate: previous?.announce_date ?? null,
      earningsNextDate: next?.announce_date ?? null,
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

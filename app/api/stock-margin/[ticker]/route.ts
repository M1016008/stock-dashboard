import { NextResponse } from 'next/server'
import { execAll, execGet, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

function normalizeTicker(raw: string) {
  return decodeURIComponent(raw).replace(/\.T$/i, '')
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    await ensureReady()
    const { ticker: rawTicker } = await params
    const ticker = normalizeTicker(rawTicker)
    const latest = await execGet<{
      ticker: string
      marginType: string | null
      asOfDate: string | null
      longMargin: number | null
      shortMargin: number | null
      longChange: number | null
      shortChange: number | null
      creditRatio: number | null
      shortRatio: number | null
    }>(
      `
      SELECT
        COALESCE(sml.ticker, tu.ticker) AS ticker,
        COALESCE(tu.margin_type, sml.margin_type) AS marginType,
        sml.as_of_date AS asOfDate,
        sml.long_margin AS longMargin,
        sml.short_margin AS shortMargin,
        sml.long_change AS longChange,
        sml.short_change AS shortChange,
        sml.credit_ratio AS creditRatio,
        sml.short_ratio AS shortRatio
      FROM ticker_universe tu
      LEFT JOIN serving_margin_latest sml ON sml.ticker = tu.ticker
      WHERE tu.ticker = ?
      UNION ALL
      SELECT
        sml.ticker,
        sml.margin_type AS marginType,
        sml.as_of_date AS asOfDate,
        sml.long_margin AS longMargin,
        sml.short_margin AS shortMargin,
        sml.long_change AS longChange,
        sml.short_change AS shortChange,
        sml.credit_ratio AS creditRatio,
        sml.short_ratio AS shortRatio
      FROM serving_margin_latest sml
      WHERE sml.ticker = ?
      LIMIT 1
      `,
      [ticker, ticker],
    )

    const history = await execAll<{
      date: string
      longMargin: number | null
      shortMargin: number | null
      longChange: number | null
      shortChange: number | null
    }>(
      `
      SELECT
        date,
        long_margin AS longMargin,
        short_margin AS shortMargin,
        long_change AS longChange,
        short_change AS shortChange
      FROM weekly_margin_interest
      WHERE ticker = ?
      ORDER BY date DESC
      LIMIT 8
      `,
      [ticker],
    )

    return NextResponse.json({
      latest: latest ?? null,
      history,
      source: 'jquants',
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Stock margin failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}

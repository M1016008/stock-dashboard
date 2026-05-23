// app/api/sector-master/[ticker]/route.ts
// 単一銘柄の sector_master 情報（市場区分・17業種・33業種・銘柄名）を返す。

import { NextResponse } from 'next/server'
import { execGet, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    await ensureReady()
    const { ticker } = await params
    const decoded = decodeURIComponent(ticker)
    // .T サフィックスが無い場合（例: "7203"）は補完して両方試す
    const candidates = decoded.endsWith('.T')
      ? [decoded]
      : /^\d{4,5}$/.test(decoded)
        ? [`${decoded}.T`, decoded]
        : [decoded]

    let row: Record<string, unknown> | undefined
    for (const t of candidates) {
      row = await execGet(
        `
        SELECT
          COALESCE(sm.ticker, tu.ticker) AS ticker,
          COALESCE(sm.name, tu.name) AS name,
          COALESCE(tu.sector17_name, sm.sector_large) AS sector_large,
          COALESCE(sm.sector_small, tu.sector33_name) AS sector_small,
          COALESCE(tu.sector33_name, sm.sector33) AS sector33,
          COALESCE(tu.market_segment, sm.market_segment) AS market_segment,
          COALESCE(tu.margin_type, sm.margin_type) AS margin_type,
          sm.updated_at,
          tu.sector17_code,
          tu.sector17_name,
          tu.sector33_code,
          tu.sector33_name
        FROM ticker_universe tu
        LEFT JOIN sector_master sm ON sm.ticker = tu.ticker OR sm.ticker = tu.ticker || '.T'
        WHERE tu.ticker = REPLACE(?, '.T', '')
        UNION ALL
        SELECT
          sm.ticker,
          sm.name,
          sm.sector_large,
          sm.sector_small,
          sm.sector33,
          sm.market_segment,
          sm.margin_type,
          sm.updated_at,
          NULL AS sector17_code,
          sm.sector_large AS sector17_name,
          NULL AS sector33_code,
          sm.sector33 AS sector33_name
        FROM sector_master sm
        WHERE sm.ticker = ?
        LIMIT 1
        `,
        [t, t],
      )
      if (row) break
    }
    if (!row) return NextResponse.json({ master: null })
    return NextResponse.json({ master: row })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

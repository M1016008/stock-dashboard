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
        `SELECT ticker, name, sector_large, sector_small, sector33, market_segment, updated_at
         FROM sector_master WHERE ticker = ?`,
        [t],
      )
      if (row) break
    }
    if (!row) return NextResponse.json({ master: null })
    return NextResponse.json({ master: row })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

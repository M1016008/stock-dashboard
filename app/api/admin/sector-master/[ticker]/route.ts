// app/api/admin/sector-master/[ticker]/route.ts
// 単一銘柄のマスタ手動補完用エンドポイント。
// JPX 公式の data_j.xls に載らない銘柄（A サフィックスの新規上場、ETF、REIT 等）を
// 1件ずつ埋めるための UI から呼ばれる想定。

import { NextResponse } from 'next/server'
import { execRun, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

interface UpsertBody {
  name?: string | null
  sector_large?: string | null
  sector_small?: string | null
  sector33?: string | null
  market_segment?: string | null
  margin_type?: string | null
}

function normalizeTicker(raw: string): string {
  const s = raw.trim()
  if (/^\d{4,5}$/.test(s)) return `${s}.T`
  return s
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length === 0 ? null : s
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    await ensureReady()
    const { ticker: rawTicker } = await params
    const ticker = normalizeTicker(decodeURIComponent(rawTicker))
    if (!/^\d{4,5}\.T$|^[A-Z0-9.\-]+$/.test(ticker)) {
      return NextResponse.json({ error: 'Invalid ticker format' }, { status: 400 })
    }

    const body = (await request.json()) as UpsertBody
    const name           = strOrNull(body.name)
    const sectorLarge    = strOrNull(body.sector_large)
    const sectorSmall    = strOrNull(body.sector_small)
    const sector33       = strOrNull(body.sector33)
    const marketSegment  = strOrNull(body.market_segment)
    const marginType     = strOrNull(body.margin_type)

    // 何も入ってないリクエストは弾く（誤操作防止）
    if (!sectorLarge && !sectorSmall && !sector33 && !marketSegment && !marginType && !name) {
      return NextResponse.json({ error: 'At least one field is required' }, { status: 400 })
    }

    const updatedAt = new Date().toISOString()
    await execRun(
      `INSERT INTO sector_master (
         ticker, name, sector_large, sector_small, sector33, market_segment, margin_type, updated_at, source_file
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(ticker) DO UPDATE SET
         name           = COALESCE(excluded.name,           sector_master.name),
         sector_large   = COALESCE(excluded.sector_large,   sector_master.sector_large),
         sector_small   = COALESCE(excluded.sector_small,   sector_master.sector_small),
         sector33       = COALESCE(excluded.sector33,       sector_master.sector33),
         market_segment = COALESCE(excluded.market_segment, sector_master.market_segment),
         margin_type    = COALESCE(excluded.margin_type,    sector_master.margin_type),
         updated_at     = excluded.updated_at,
         source_file    = excluded.source_file`,
      [ticker, name, sectorLarge, sectorSmall, sector33, marketSegment, marginType, updatedAt, 'manual'],
    )

    return NextResponse.json({
      ok: true,
      ticker,
      saved: { name, sectorLarge, sectorSmall, sector33, marketSegment, marginType },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Upsert failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}

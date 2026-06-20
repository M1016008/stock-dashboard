// app/api/admin/sector-master/route.ts
// sector_master の現在値を返す管理用 API。
// 銘柄マスターの自動更新は J-Quants /equities/master を使う batch:listed-info に統一済み。

import { NextResponse } from 'next/server'
import { adminWriteDisabledResponse } from '@/lib/admin-write-disabled'
import { execAll, ensureReady } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

export async function POST() {
  return adminWriteDisabledResponse('業種マスター手動更新')
}

export async function GET() {
  try {
    await ensureReady()
    const totals = await execAll<{ total: number; large_count: number; segment_count: number; latest: string | null }>(
      `SELECT COUNT(*) AS total,
              COUNT(DISTINCT sector_large) AS large_count,
              COUNT(DISTINCT market_segment) AS segment_count,
              MAX(updated_at) AS latest
       FROM sector_master`,
    )
    const byLarge = await execAll<{ sector_large: string | null; n: number }>(
      `SELECT sector_large, COUNT(*) AS n FROM sector_master GROUP BY sector_large ORDER BY n DESC`,
    )
    const bySegment = await execAll<{ market_segment: string | null; n: number }>(
      `SELECT market_segment, COUNT(*) AS n FROM sector_master GROUP BY market_segment ORDER BY n DESC`,
    )
    return NextResponse.json({ totals: totals[0] ?? null, byLarge, bySegment })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

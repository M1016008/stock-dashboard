// app/api/admin/universe/route.ts
// 銘柄ユニバースの一覧。画面/APIからの一括追加は停止。
import { NextResponse } from 'next/server'
import { adminWriteDisabledResponse } from '@/lib/admin-write-disabled'
import { db, ensureReady } from '@/lib/db/client'
import { tickerUniverse } from '@/lib/db/schema'
import { asc } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureReady()
  const rows = await db
    .select()
    .from(tickerUniverse)
    .orderBy(asc(tickerUniverse.ticker))

  // 統計
  const total = rows.length
  const active = rows.filter(r => r.active).length

  return NextResponse.json({
    total,
    active,
    inactive: total - active,
    items: rows,
  })
}

export async function POST() {
  return adminWriteDisabledResponse('銘柄ユニバース追加')
}

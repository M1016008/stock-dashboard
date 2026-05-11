// app/api/admin/universe/route.ts
// 銘柄ユニバースの一覧 + 一括追加。
import { NextResponse } from 'next/server'
import { db, ensureReady } from '@/lib/db/client'
import { tickerUniverse } from '@/lib/db/schema'
import { asc, sql } from 'drizzle-orm'

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

export async function POST(request: Request) {
  await ensureReady()
  const body = await request.json().catch(() => null) as { tickers?: string[] | string } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  // 文字列 (改行区切り) または配列を受ける
  const raw: string[] = Array.isArray(body.tickers)
    ? body.tickers
    : (body.tickers ?? '').split(/[\s,]+/)

  const tickers = raw
    .map(t => t.trim())
    // .T サフィックスは strip
    .map(t => t.replace(/\.T$/i, ''))
    .filter(t => t.length > 0)

  if (tickers.length === 0) {
    return NextResponse.json({ error: 'No valid tickers' }, { status: 400 })
  }

  // INSERT OR IGNORE 相当
  for (const ticker of tickers) {
    await db
      .insert(tickerUniverse)
      .values({ ticker, active: true })
      .onConflictDoUpdate({
        target: tickerUniverse.ticker,
        // 既存があれば active を立て直すだけ (再有効化動作)
        set: { active: true },
      })
  }

  // 件数更新
  const totalRow = await db
    .select({ c: sql<number>`COUNT(*)` })
    .from(tickerUniverse)
  const total = totalRow[0]?.c ?? 0

  return NextResponse.json({ added: tickers.length, total })
}

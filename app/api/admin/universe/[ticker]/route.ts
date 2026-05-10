// app/api/admin/universe/[ticker]/route.ts
// 個別銘柄の active トグル / 削除。
import { NextResponse } from 'next/server'
import { db, ensureReady } from '@/lib/db/client'
import { tickerUniverse } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  await ensureReady()
  const { ticker } = await params
  const body = await request.json().catch(() => null) as { active?: boolean; name?: string } | null
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })

  const updates: Partial<typeof tickerUniverse.$inferInsert> = {}
  if (typeof body.active === 'boolean') updates.active = body.active
  if (typeof body.name === 'string') updates.name = body.name

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  await db
    .update(tickerUniverse)
    .set(updates)
    .where(eq(tickerUniverse.ticker, ticker))

  return NextResponse.json({ ok: true, ticker, updates })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  await ensureReady()
  const { ticker } = await params

  await db
    .delete(tickerUniverse)
    .where(eq(tickerUniverse.ticker, ticker))

  return NextResponse.json({ ok: true, ticker })
}

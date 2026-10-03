// app/api/admin/universe/route.ts
// 銘柄ユニバースの一覧。画面/APIからの一括追加は停止。
import { NextRequest, NextResponse } from 'next/server'
import { adminWriteDisabledResponse } from '@/lib/admin-write-disabled'
import { ensureReady, execAll, execGet } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

type UniverseStats = {
  total: number
  active: number
}

type UniverseItem = {
  ticker: string
  name: string | null
  active: number
  addedAt: number
}

export async function GET(request: NextRequest) {
  await ensureReady()
  const params = request.nextUrl.searchParams
  const query = (params.get('q') ?? '').trim().slice(0, 100)
  const rawLimit = Number(params.get('limit') ?? 50)
  const rawOffset = Number(params.get('offset') ?? 0)
  const limit = Number.isFinite(rawLimit) ? Math.min(100, Math.max(0, Math.floor(rawLimit))) : 50
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
  const stats = await execGet<UniverseStats>(
    `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END) AS active
      FROM ticker_universe
    `,
  )
  const total = Number(stats?.total ?? 0)
  const active = Number(stats?.active ?? 0)
  const pattern = `%${query}%`
  const matched = query
    ? Number((await execGet<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM ticker_universe
          WHERE ticker LIKE ? OR COALESCE(name, '') LIKE ?
        `,
        [pattern, pattern],
      ))?.count ?? 0)
    : total
  const rows = limit > 0
    ? await execAll<UniverseItem>(
        `
          SELECT ticker, name, active, added_at AS addedAt
          FROM ticker_universe
          ${query ? `WHERE ticker LIKE ? OR COALESCE(name, '') LIKE ?` : ''}
          ORDER BY ticker ASC
          LIMIT ? OFFSET ?
        `,
        query ? [pattern, pattern, limit, offset] : [limit, offset],
      )
    : []

  return NextResponse.json({
    total,
    active,
    inactive: total - active,
    matched,
    limit,
    offset,
    items: rows.map((row) => ({
      ...row,
      active: Boolean(row.active),
    })),
  })
}

export async function POST() {
  return adminWriteDisabledResponse('銘柄ユニバース追加')
}

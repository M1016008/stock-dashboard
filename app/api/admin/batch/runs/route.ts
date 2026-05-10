// app/api/admin/batch/runs/route.ts
// 直近のバッチ実行履歴を返す。/admin/db で表示用。
import { NextResponse } from 'next/server'
import { db, ensureReady } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { desc } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

export async function GET() {
  await ensureReady()
  const rows = await db
    .select()
    .from(batchRuns)
    .orderBy(desc(batchRuns.id))
    .limit(20)

  return NextResponse.json({ runs: rows })
}

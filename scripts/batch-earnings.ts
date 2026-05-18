// scripts/batch-earnings.ts
//
// Phase 4 B12: J-Quants /fins/announcement で業績発表予定を取得し
// earnings_calendar テーブルに upsert。日次実行で 2 週間先まで取り込み。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:earnings

import { db, client } from '@/lib/db/client'
import { earningsCalendar, batchRuns } from '@/lib/db/schema'
import { fetchJQuantsAnnouncement } from '@/lib/jquants'
import { eq } from 'drizzle-orm'

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'earnings_calendar', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  console.log('J-Quants /fins/announcement を取得中...')
  const t0 = Date.now()
  const rows = await fetchJQuantsAnnouncement()
  console.log(`取得: ${rows.length} 件 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  let inserted = 0
  for (const row of rows) {
    const code5 = row.Code
    const ticker = code5.length === 5 && code5.endsWith('0') ? code5.slice(0, 4) : code5
    if (!row.Date) continue
    await client.execute({
      sql: `INSERT INTO earnings_calendar (ticker, announce_date, fiscal_period, imported_at)
            VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(ticker, announce_date) DO UPDATE SET
              fiscal_period = excluded.fiscal_period,
              imported_at = unixepoch()`,
      args: [
        ticker,
        row.Date,
        [row.FiscalYear, row.FiscalQuarter].filter(Boolean).join(' ') || null,
      ],
    })
    inserted++
  }

  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: 'success',
      totalTickers: rows.length,
      succeeded: inserted,
      rowsInserted: inserted,
    })
    .where(eq(batchRuns.id, runId))

  console.log(`完了: ${inserted} 件を earnings_calendar に同期`)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })

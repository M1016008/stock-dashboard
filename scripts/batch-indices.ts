// scripts/batch-indices.ts
//
// Phase 4: J-Quants /indices/bars/daily から主要指数を取得し indices_daily に保存。
// 日経 225 は JPX 配信外なので含まれない。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:indices
//   USE_LOCAL_DB=1 INDICES_FROM=2025-01-01 npm run batch:indices

import { db, client } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { fetchJQuantsIndexBars } from '@/lib/jquants'
import { eq } from 'drizzle-orm'

// 主要指数。ダッシュボードで表示するもの。
const INDEX_CODES: Array<{ code: string; label: string }> = [
  { code: '0000', label: 'TOPIX' },
  { code: '0070', label: '東証グロース250' },
  { code: '0500', label: 'プライム市場指数' },
  { code: '0501', label: 'スタンダード市場指数' },
  { code: '0502', label: 'グロース市場指数' },
  { code: '0503', label: 'JPXプライム150' },
]

function defaultFromDate(): string {
  // デフォルトで直近 1 年
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().slice(0, 10)
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'indices', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  const from = process.env.INDICES_FROM ?? defaultFromDate()
  console.log(`Indices fetch 開始: ${INDEX_CODES.length} 指数 (from=${from})`)

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []

  for (const { code, label } of INDEX_CODES) {
    try {
      const rows = await fetchJQuantsIndexBars(code, from)
      for (const r of rows) {
        await client.execute({
          sql: `INSERT INTO indices_daily (code, date, open, high, low, close)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(code, date) DO UPDATE SET
                  open  = excluded.open,
                  high  = excluded.high,
                  low   = excluded.low,
                  close = excluded.close`,
          args: [r.Code, r.Date, r.O, r.H, r.L, r.C],
        })
        rowsInserted++
      }
      succeeded++
      console.log(`✓ ${code} ${label}: ${rows.length} 行`)
    } catch (err) {
      failed++
      const msg = `${code} ${label}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      console.error(`✗ ${msg}`)
    }
  }

  const finalStatus = failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial'
  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: finalStatus,
      totalTickers: INDEX_CODES.length,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: JSON.stringify(errors.slice(0, 10)),
    })
    .where(eq(batchRuns.id, runId))

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / ${rowsInserted} 行 / ${finalStatus}`)
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })

// scripts/batch-listed-info.ts
//
// Phase 3.5: J-Quants /equities/master から上場銘柄一覧を取得し ticker_universe を更新。
// 既存ティッカーは name を更新 + active=true、廃止銘柄は active=false (将来検討)。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:listed-info

import { db } from '@/lib/db/client'
import { tickerUniverse, batchRuns } from '@/lib/db/schema'
import { fetchJQuantsListedInfo, toJQuantsCode } from '@/lib/jquants'
import { eq, sql } from 'drizzle-orm'

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'listed_info_sync', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  console.log('J-Quants /equities/master を取得中...')
  const t0 = Date.now()
  const listed = await fetchJQuantsListedInfo()
  console.log(`取得: ${listed.length.toLocaleString()} 銘柄 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  // ticker は J-Quants の Code (5桁) のまま保持 (`toJQuantsCode` は 4桁→5桁変換だが、
  // 既存データは Code が 5桁なのでそのまま利用)。
  // ただしアプリ内表記との整合性のため: 5 桁末尾が "0" の普通株は 4 桁化、それ以外は 5 桁そのまま。
  const records = listed.map(info => {
    const code5 = info.Code
    const ticker = code5.length === 5 && code5.endsWith('0') ? code5.slice(0, 4) : code5
    return {
      ticker,
      name: info.CoName,
      active: true,
    }
  })

  // 重複 (例: ETF や種類株式で同じ ticker prefix のもの) を除去 (後勝ち)
  const uniqMap = new Map<string, typeof records[number]>()
  for (const r of records) uniqMap.set(r.ticker, r)
  const uniqRecords = Array.from(uniqMap.values())
  console.log(`重複除去後: ${uniqRecords.length.toLocaleString()} 銘柄`)

  // UPSERT (既存 ticker は name 更新 + active=true)
  const CHUNK = 200
  let inserted = 0
  for (let i = 0; i < uniqRecords.length; i += CHUNK) {
    const chunk = uniqRecords.slice(i, i + CHUNK)
    await db
      .insert(tickerUniverse)
      .values(chunk)
      .onConflictDoUpdate({
        target: tickerUniverse.ticker,
        set: {
          name:   sql`excluded.name`,
          active: sql`excluded.active`,
        },
      })
    inserted += chunk.length
  }

  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: 'success',
      totalTickers: uniqRecords.length,
      succeeded: inserted,
      rowsInserted: inserted,
    })
    .where(eq(batchRuns.id, runId))

  console.log(`完了: ${inserted.toLocaleString()} 銘柄を ticker_universe に同期`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

// scripts/batch-shares-outstanding.ts
//
// Phase 3.6: ticker_universe.shares_outstanding を J-Quants /fins/summary から
// 最新値で更新するバッチ。時価総額計算 (price × shares) のキャッシュ。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:shares-outstanding
//
// 動作:
//   - active な ticker_universe を全銘柄ループ
//   - 各銘柄について fetchJQuantsFinsSummary で最新 ShOutFY を取得
//   - 銘柄あたり 1 リクエスト (パターン × プラン制限内)
//   - shares_updated_at を unixepoch で更新

import { db, client } from '@/lib/db/client'
import { tickerUniverse, batchRuns } from '@/lib/db/schema'
import { fetchJQuantsFinsSummary } from '@/lib/jquants'
import { eq } from 'drizzle-orm'

const RATE_LIMIT_MS = 100
const PROGRESS_EVERY = 100

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function getLatestShares(ticker: string): Promise<number | null> {
  const rows = await fetchJQuantsFinsSummary(ticker)
  if (rows.length === 0) return null
  // 通期 (FY) を優先、なければ最新レコード
  const sorted = [...rows].sort((a, b) => b.DiscDate.localeCompare(a.DiscDate))
  const fy = sorted.find(r => r.CurPerType === 'FY' && r.ShOutFY !== '')
  const target = fy ?? sorted.find(r => r.ShOutFY !== '')
  if (!target) return null
  const n = parseFloat(target.ShOutFY)
  return Number.isFinite(n) ? n : null
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'shares_outstanding', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  const filter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
  const tickers: { ticker: string }[] = filter && filter.length > 0
    ? filter.map(ticker => ({ ticker }))
    : await db
        .select({ ticker: tickerUniverse.ticker })
        .from(tickerUniverse)
        .where(eq(tickerUniverse.active, true))

  let succeeded = 0
  let failed = 0
  let rowsUpdated = 0
  const errors: string[] = []
  const startTime = Date.now()

  console.log(`Shares outstanding fetch 開始: ${tickers.length} 銘柄`)

  for (const [i, { ticker }] of tickers.entries()) {
    try {
      const shares = await getLatestShares(ticker)
      if (shares != null && shares > 0) {
        await client.execute({
          sql: 'UPDATE ticker_universe SET shares_outstanding = ?, shares_updated_at = unixepoch() WHERE ticker = ?',
          args: [Math.round(shares), ticker],
        })
        rowsUpdated++
      }
      succeeded++
      if ((i + 1) % PROGRESS_EVERY === 0 || i === tickers.length - 1) {
        const pct = (((i + 1) / tickers.length) * 100).toFixed(1)
        const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
        console.log(`[${i + 1}/${tickers.length} ${pct}%] ${ticker}: ${shares ?? 'null'} (更新累計 ${rowsUpdated}, 失敗 ${failed}, 経過 ${elapsedMin}min)`)
      }
    } catch (err) {
      failed++
      const msg = `${ticker}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      console.error(`✗ ${msg}`)
    }
    await sleep(RATE_LIMIT_MS)
  }

  const finalStatus =
    failed === 0 ? 'success' :
    succeeded === 0 ? 'failed' :
    'partial'

  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: finalStatus,
      totalTickers: tickers.length,
      succeeded,
      failed,
      rowsInserted: rowsUpdated,
      errorSummary: JSON.stringify(errors.slice(0, 10)),
    })
    .where(eq(batchRuns.id, runId))

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / 更新 ${rowsUpdated} 行 / ${finalStatus}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

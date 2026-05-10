// scripts/batch-snapshots.ts
//
// Phase 2: ohlcv_daily から MA15本 + ステージ6種を計算して daily_snapshots に保存する夜間バッチ。
//
// 使い方:
//   npm run batch:snapshots                       # active な ticker_universe を全件処理
//   TICKERS=7203,6758 npm run batch:snapshots     # 環境変数で銘柄を絞ってテスト
//
// 動作:
//   - 各銘柄について daily_snapshots の最新日付を確認、それ以降の日付分のみ計算
//   - 各日について OHLCV を slice (その日まで) → buildMaValuesFromOhlcv → calculateAllStages
//   - チャンク単位で UPSERT (onConflictDoNothing で冪等)
//   - 銘柄単位で失敗してもバッチは継続、失敗銘柄は batch_runs.error_summary に記録
//
// パフォーマンス注:
//   各日で OHLCV を slice して再計算するため銘柄あたり O(n²)。
//   2年分 = 約 500 日 × 4000 銘柄 = 200万計算。約 5〜10 分目安。
//   将来データ量が増えたら累積計算に最適化する余地あり。

import { db } from '@/lib/db/client'
import { ohlcvDaily, dailySnapshots, tickerUniverse, batchRuns } from '@/lib/db/schema'
import { buildMaValuesFromOhlcv, calculateAllStages } from '@/lib/hex-stage'
import type { OHLCV } from '@/types/stock'
import { eq, asc, max } from 'drizzle-orm'

const MIN_DATA_POINTS = 5  // これ以下では何も計算できない (ma_5 すら出ない)
const PROGRESS_EVERY = 50

async function computeSnapshotsForTicker(ticker: string): Promise<number> {
  // この銘柄の OHLCV を全件取得 (日付昇順)
  const rows = await db
    .select()
    .from(ohlcvDaily)
    .where(eq(ohlcvDaily.ticker, ticker))
    .orderBy(asc(ohlcvDaily.date))

  if (rows.length < MIN_DATA_POINTS) return 0

  const ohlcvData: OHLCV[] = rows.map(r => ({
    date:   r.date,
    open:   r.open,
    high:   r.high,
    low:    r.low,
    close:  r.close,
    volume: r.volume,
  }))

  // 既存スナップショット最新日付を確認 (差分計算)
  const existing = await db
    .select({ maxDate: max(dailySnapshots.date) })
    .from(dailySnapshots)
    .where(eq(dailySnapshots.ticker, ticker))

  const lastSnapshotDate = existing[0]?.maxDate ?? null

  // 各日に対してスナップショットを計算
  type SnapshotRow = typeof dailySnapshots.$inferInsert
  const newSnapshots: SnapshotRow[] = []
  for (let i = 0; i < ohlcvData.length; i++) {
    const date = ohlcvData[i].date
    if (lastSnapshotDate && date <= lastSnapshotDate) continue
    if (i + 1 < MIN_DATA_POINTS) continue

    const slice = ohlcvData.slice(0, i + 1)
    const ma = buildMaValuesFromOhlcv(slice)
    const stages = calculateAllStages(ma)

    newSnapshots.push({
      ticker,
      date,
      ...ma,
      ...stages,
    })
  }

  if (newSnapshots.length === 0) return 0

  // チャンク分割で INSERT (libSQL の SQL長制限対策)
  const CHUNK = 200
  for (let i = 0; i < newSnapshots.length; i += CHUNK) {
    await db
      .insert(dailySnapshots)
      .values(newSnapshots.slice(i, i + CHUNK))
      .onConflictDoNothing()  // 既存日付は触らない (冪等)
  }

  return newSnapshots.length
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'snapshot_compute',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  // 対象銘柄
  const tickerFilter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
  let tickers: { ticker: string }[]
  if (tickerFilter && tickerFilter.length > 0) {
    tickers = tickerFilter.map(ticker => ({ ticker }))
    console.log(`TICKERS env で絞り込み: ${tickers.length} 銘柄`)
  } else {
    tickers = await db
      .select({ ticker: tickerUniverse.ticker })
      .from(tickerUniverse)
      .where(eq(tickerUniverse.active, true))
  }

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []

  console.log(`Snapshot 計算開始: ${tickers.length} 銘柄`)
  const startTime = Date.now()

  for (const [i, { ticker }] of tickers.entries()) {
    try {
      const count = await computeSnapshotsForTicker(ticker)
      succeeded++
      rowsInserted += count
      if ((i + 1) % PROGRESS_EVERY === 0 || i === tickers.length - 1) {
        const pct = (((i + 1) / tickers.length) * 100).toFixed(1)
        const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
        console.log(`[${i + 1}/${tickers.length} ${pct}%] ${ticker}: +${count} snapshots (累計 ${rowsInserted}, 失敗 ${failed}, 経過 ${elapsedMin}min)`)
      }
    } catch (err) {
      failed++
      const msg = `${ticker}: ${err instanceof Error ? err.message : String(err)}`
      errors.push(msg)
      console.error(`✗ ${msg}`)
    }
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
      rowsInserted,
      errorSummary: JSON.stringify(errors.slice(0, 10)),
    })
    .where(eq(batchRuns.id, runId))

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / 計 ${rowsInserted} スナップショット / ステータス: ${finalStatus}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

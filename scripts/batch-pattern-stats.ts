// scripts/batch-pattern-stats.ts
//
// Phase 3: daily_snapshots × forward_returns を JOIN し、6 桁パターンコード (日A日B週A週B月A月B)
// ごとに horizon 別の統計 (件数、p05/25/50/75/95、カテゴリ別件数) を集計して pattern_stats に保存。
//
// 使い方:
//   USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-pattern-stats.ts
//
// 動作:
//   - SQLite はパーセンタイル直接サポートなし → JS 側で計算
//   - SQL で raw return_pct と category を全件取得 (大量だが 1 ティッカーずつではないので速い)
//   - JS 側でパターンコード × horizon ごとにグルーピング、パーセンタイル算出
//   - pattern_stats を全削除 → 再 INSERT (冪等、シンプル)

import { db, client } from '@/lib/db/client'
import { patternStats, batchRuns } from '@/lib/db/schema'
import { percentile } from '@/lib/features'
import { eq } from 'drizzle-orm'

const HORIZONS = [30, 60, 90, 180] as const

async function aggregate(): Promise<number> {
  console.log('既存 pattern_stats 削除...')
  await db.delete(patternStats)

  // horizon ごとに処理して OOM 回避
  const allStatsRecords: Array<typeof patternStats.$inferInsert> = []
  for (const horizon of HORIZONS) {
    console.log(`\n=== horizon=${horizon}d 集計開始 ===`)
    const t0 = Date.now()

    const result = await client.execute({
      sql: `
        SELECT
          printf('%d%d%d%d%d%d',
            s.daily_a_stage, s.daily_b_stage,
            s.weekly_a_stage, s.weekly_b_stage,
            s.monthly_a_stage, s.monthly_b_stage
          ) AS pattern_code,
          f.return_pct AS return_pct,
          f.return_category AS category
        FROM daily_snapshots s
        INNER JOIN forward_returns f
          ON s.ticker = f.ticker AND s.date = f.date
        WHERE f.horizon_days = ?
          AND s.daily_a_stage IS NOT NULL
          AND s.daily_b_stage IS NOT NULL
          AND s.weekly_a_stage IS NOT NULL
          AND s.weekly_b_stage IS NOT NULL
          AND s.monthly_a_stage IS NOT NULL
          AND s.monthly_b_stage IS NOT NULL
      `,
      args: [horizon],
    })

    console.log(`  JOIN 取得: ${result.rows.length.toLocaleString()} 行 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

    // pattern_code → returns[] にグルーピング
    const buckets = new Map<string, number[]>()
    const categories = new Map<string, { very_up: number; up: number; flat: number; down: number; very_down: number }>()

    for (const r of result.rows as unknown as Array<{ pattern_code: string; return_pct: number; category: string }>) {
      let bucket = buckets.get(r.pattern_code)
      if (!bucket) {
        bucket = []
        buckets.set(r.pattern_code, bucket)
        categories.set(r.pattern_code, { very_up: 0, up: 0, flat: 0, down: 0, very_down: 0 })
      }
      bucket.push(r.return_pct)
      const cats = categories.get(r.pattern_code)!
      if (r.category in cats) {
        cats[r.category as keyof typeof cats]++
      }
    }

    console.log(`  バケット数: ${buckets.size.toLocaleString()}`)

    for (const [patternCode, returns] of buckets.entries()) {
      const cats = categories.get(patternCode)!
      allStatsRecords.push({
        pattern_code: patternCode,
        horizon_days: horizon,
        count: returns.length,
        p05: percentile(returns, 5),
        p25: percentile(returns, 25),
        p50: percentile(returns, 50),
        p75: percentile(returns, 75),
        p95: percentile(returns, 95),
        very_up_count:   cats.very_up,
        up_count:        cats.up,
        flat_count:      cats.flat,
        down_count:      cats.down,
        very_down_count: cats.very_down,
      })
    }

    // GC ヒント (大きな Map を捨てる)
    buckets.clear()
    categories.clear()
    if (global.gc) global.gc()
  }

  console.log(`\n統計レコード総数: ${allStatsRecords.length.toLocaleString()}`)
  console.log('pattern_stats に INSERT...')

  // チャンク INSERT
  const CHUNK = 500
  for (let i = 0; i < allStatsRecords.length; i += CHUNK) {
    await db.insert(patternStats).values(allStatsRecords.slice(i, i + CHUNK))
  }

  return allStatsRecords.length
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'pattern_stats', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  let rowsInserted = 0
  let status = 'success'
  let errorMsg: string | null = null

  try {
    rowsInserted = await aggregate()
    console.log(`完了: ${rowsInserted.toLocaleString()} パターン × horizon バケット`)
  } catch (err) {
    status = 'failed'
    errorMsg = err instanceof Error ? err.message : String(err)
    console.error('Fatal:', errorMsg)
  }

  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status,
      totalTickers: 0,
      succeeded: status === 'success' ? 1 : 0,
      failed:    status === 'success' ? 0 : 1,
      rowsInserted,
      errorSummary: errorMsg ? JSON.stringify([errorMsg]) : '[]',
    })
    .where(eq(batchRuns.id, runId))

  if (status !== 'success') process.exit(1)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

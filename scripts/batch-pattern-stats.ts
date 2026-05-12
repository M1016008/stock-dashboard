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

interface JoinedRow {
  pattern_code: string
  horizon: number
  return_pct: number
  category: string
}

async function aggregate(): Promise<number> {
  console.log('SQL JOIN 実行中 (daily_snapshots × forward_returns)...')
  const t0 = Date.now()

  // libSQL 経由で直接 SQL 実行 (大量行を扱うため Drizzle のクエリビルダを通すよりシンプル)
  const result = await client.execute({
    sql: `
      SELECT
        printf('%d%d%d%d%d%d',
          s.daily_a_stage, s.daily_b_stage,
          s.weekly_a_stage, s.weekly_b_stage,
          s.monthly_a_stage, s.monthly_b_stage
        ) AS pattern_code,
        f.horizon_days AS horizon,
        f.return_pct AS return_pct,
        f.return_category AS category
      FROM daily_snapshots s
      INNER JOIN forward_returns f
        ON s.ticker = f.ticker AND s.date = f.date
      WHERE s.daily_a_stage IS NOT NULL
        AND s.daily_b_stage IS NOT NULL
        AND s.weekly_a_stage IS NOT NULL
        AND s.weekly_b_stage IS NOT NULL
        AND s.monthly_a_stage IS NOT NULL
        AND s.monthly_b_stage IS NOT NULL
    `,
    args: [],
  })

  console.log(`JOIN 取得: ${result.rows.length.toLocaleString()} 行 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  // グルーピング: (pattern_code, horizon) → returns[]
  const buckets = new Map<string, number[]>()
  const categories = new Map<string, { very_up: number; up: number; flat: number; down: number; very_down: number }>()

  for (const r of result.rows as unknown as JoinedRow[]) {
    const key = `${r.pattern_code}|${r.horizon}`
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = []
      buckets.set(key, bucket)
      categories.set(key, { very_up: 0, up: 0, flat: 0, down: 0, very_down: 0 })
    }
    bucket.push(r.return_pct)
    const cats = categories.get(key)!
    if (r.category in cats) {
      cats[r.category as keyof typeof cats]++
    }
  }

  console.log(`バケット数: ${buckets.size.toLocaleString()} (pattern × horizon)`)

  // 各バケットの統計
  const statsRecords: Array<typeof patternStats.$inferInsert> = []
  for (const [key, returns] of buckets.entries()) {
    const [patternCode, horizonStr] = key.split('|')
    const horizon = parseInt(horizonStr)
    const cats = categories.get(key)!

    statsRecords.push({
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

  console.log('既存 pattern_stats 削除 + 新規 INSERT...')

  // 既存行を全削除 (集計は冪等で全体再計算が単純)
  await db.delete(patternStats)

  // チャンク INSERT
  const CHUNK = 500
  for (let i = 0; i < statsRecords.length; i += CHUNK) {
    await db.insert(patternStats).values(statsRecords.slice(i, i + CHUNK))
  }

  return statsRecords.length
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

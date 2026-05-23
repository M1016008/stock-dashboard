// scripts/batch-pattern-stats.ts
//
// daily_snapshots × forward_returns をJOINし、6桁パターンコード
// (日A日B週A週B月A月B) ごとに horizon 別の統計を保存する。
//
// 使い方:
//   USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-pattern-stats.ts
//   PATTERN_STAT_HORIZONS=2,3,4,5,10,15 USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-pattern-stats.ts

import { db, client } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

const DEFAULT_HORIZONS = [2, 3, 4, 5, 10, 15, 30, 60, 90, 180]

function parseHorizons(value: string | undefined, fallback: number[]): number[] {
  const source = value?.trim() ? value : fallback.join(',')
  const horizons = [...new Set(
    source
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isInteger(n) && n > 0),
  )].sort((a, b) => a - b)
  if (horizons.length === 0) {
    throw new Error('PATTERN_STAT_HORIZONS に有効な営業日数がありません')
  }
  return horizons
}

const HORIZONS = parseHorizons(process.env.PATTERN_STAT_HORIZONS, DEFAULT_HORIZONS)

async function ensureIndexes() {
  await client.execute(`
    CREATE INDEX IF NOT EXISTS fwd_horizon_ticker_date_idx
    ON forward_returns(horizon_days, ticker, date)
  `)
}

async function aggregateHorizon(horizon: number): Promise<number> {
  const result = await client.execute({
    sql: `
      INSERT INTO pattern_stats
        (pattern_code, horizon_days, count, p05, p25, p50, p75, p95,
         very_up_count, up_count, flat_count, down_count, very_down_count)
      WITH base AS (
        SELECT
          printf('%d%d%d%d%d%d',
            s.daily_a_stage, s.daily_b_stage,
            s.weekly_a_stage, s.weekly_b_stage,
            s.monthly_a_stage, s.monthly_b_stage
          ) AS pattern_code,
          f.return_pct,
          f.return_category
        FROM forward_returns f
        INNER JOIN daily_snapshots s
          ON s.ticker = f.ticker AND s.date = f.date
        WHERE f.horizon_days = ?
          AND s.daily_a_stage IS NOT NULL
          AND s.daily_b_stage IS NOT NULL
          AND s.weekly_a_stage IS NOT NULL
          AND s.weekly_b_stage IS NOT NULL
          AND s.monthly_a_stage IS NOT NULL
          AND s.monthly_b_stage IS NOT NULL
      ),
      ranked AS (
        SELECT
          pattern_code,
          return_pct,
          return_category,
          COUNT(*) OVER (PARTITION BY pattern_code) AS n,
          ROW_NUMBER() OVER (PARTITION BY pattern_code ORDER BY return_pct) AS rn
        FROM base
      )
      SELECT
        pattern_code,
        ? AS horizon_days,
        MAX(n) AS count,
        MAX(CASE WHEN rn = CAST(ROUND((n - 1) * 0.05) AS INTEGER) + 1 THEN return_pct END) AS p05,
        MAX(CASE WHEN rn = CAST(ROUND((n - 1) * 0.25) AS INTEGER) + 1 THEN return_pct END) AS p25,
        MAX(CASE WHEN rn = CAST(ROUND((n - 1) * 0.50) AS INTEGER) + 1 THEN return_pct END) AS p50,
        MAX(CASE WHEN rn = CAST(ROUND((n - 1) * 0.75) AS INTEGER) + 1 THEN return_pct END) AS p75,
        MAX(CASE WHEN rn = CAST(ROUND((n - 1) * 0.95) AS INTEGER) + 1 THEN return_pct END) AS p95,
        SUM(CASE WHEN return_category = 'very_up' THEN 1 ELSE 0 END) AS very_up_count,
        SUM(CASE WHEN return_category = 'up' THEN 1 ELSE 0 END) AS up_count,
        SUM(CASE WHEN return_category = 'flat' THEN 1 ELSE 0 END) AS flat_count,
        SUM(CASE WHEN return_category = 'down' THEN 1 ELSE 0 END) AS down_count,
        SUM(CASE WHEN return_category = 'very_down' THEN 1 ELSE 0 END) AS very_down_count
      FROM ranked
      GROUP BY pattern_code
    `,
    args: [horizon, horizon],
  })
  return Number(result.rowsAffected ?? 0)
}

async function aggregate(): Promise<number> {
  console.log(`既存 pattern_stats 削除: horizons=${HORIZONS.join(',')}`)
  await ensureIndexes()
  await client.execute({
    sql: `DELETE FROM pattern_stats WHERE horizon_days IN (${HORIZONS.map(() => '?').join(', ')})`,
    args: HORIZONS,
  })

  let rowsInserted = 0
  for (const horizon of HORIZONS) {
    console.log(`\n=== horizon=${horizon}d 集計開始 ===`)
    const t0 = Date.now()
    const inserted = await aggregateHorizon(horizon)
    rowsInserted += inserted
    console.log(`  集計INSERT: ${inserted.toLocaleString()} パターン (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  }

  return rowsInserted
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

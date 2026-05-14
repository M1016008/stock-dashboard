// scripts/batch-stage-transitions.ts
//
// Phase 4: daily_snapshots を走査して 6 軸それぞれのステージ遷移カウントを集計、
// stage_transitions テーブルに保存。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:stage-transitions
//
// 動作:
//   - SQLite の LAG() ウィンドウ関数で「前日ステージ」を取得して GROUP BY (高速)
//   - 6 軸を順に処理、それぞれ最大 36 セル (6×6) を集計
//   - 既存 stage_transitions を削除して再投入 (冪等)

import { db, client } from '@/lib/db/client'
import { stageTransitions, batchRuns } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

const AXES = [
  { key: 'daily_a',   col: 'daily_a_stage'   },
  { key: 'daily_b',   col: 'daily_b_stage'   },
  { key: 'weekly_a',  col: 'weekly_a_stage'  },
  { key: 'weekly_b',  col: 'weekly_b_stage'  },
  { key: 'monthly_a', col: 'monthly_a_stage' },
  { key: 'monthly_b', col: 'monthly_b_stage' },
] as const

async function aggregateAxis(axisKey: string, columnName: string): Promise<Array<{ from_stage: number; to_stage: number; count: number }>> {
  const result = await client.execute({
    sql: `
      WITH lagged AS (
        SELECT
          ${columnName} AS curr_stage,
          LAG(${columnName}) OVER (PARTITION BY ticker ORDER BY date) AS prev_stage
        FROM daily_snapshots
      )
      SELECT
        prev_stage AS from_stage,
        curr_stage AS to_stage,
        COUNT(*) AS c
      FROM lagged
      WHERE prev_stage IS NOT NULL AND curr_stage IS NOT NULL
      GROUP BY prev_stage, curr_stage
      ORDER BY prev_stage, curr_stage
    `,
    args: [],
  })

  return (result.rows as unknown as Array<{ from_stage: number; to_stage: number; c: number }>).map(r => ({
    from_stage: r.from_stage,
    to_stage:   r.to_stage,
    count:      Number(r.c),
  }))
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'stage_transitions', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  console.log('既存 stage_transitions 削除...')
  await db.delete(stageTransitions)

  let totalInserted = 0
  const startTime = Date.now()

  for (const axis of AXES) {
    console.log(`\n=== ${axis.key} (column: ${axis.col}) ===`)
    const cells = await aggregateAxis(axis.key, axis.col)
    console.log(`  ${cells.length} セル (${cells.reduce((s, c) => s + c.count, 0).toLocaleString()} 遷移)`)

    if (cells.length === 0) continue
    const records = cells.map(c => ({
      axis:        axis.key,
      from_stage:  c.from_stage,
      to_stage:    c.to_stage,
      count:       c.count,
    }))
    await db.insert(stageTransitions).values(records)
    totalInserted += records.length
  }

  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: 'success',
      rowsInserted: totalInserted,
    })
    .where(eq(batchRuns.id, runId))

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1)
  console.log(`\n完了: ${totalInserted} セル (6軸計, ${elapsedSec}s)`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

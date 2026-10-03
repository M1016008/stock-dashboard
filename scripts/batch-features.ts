// scripts/batch-features.ts
//
// Phase 3: daily_snapshots から各 timescale の特徴量ベクトルを計算して feature_snapshots に保存。
//
// 使い方:
//   USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-features.ts
//   TICKERS=7203,6758 USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-features.ts
//   TICKERS=7203 FEATURE_FORCE_REBUILD=1 USE_LOCAL_DB=1 npx tsx --env-file=.env.local scripts/batch-features.ts
//
// 動作:
//   - active な ticker_universe を順に処理
//   - 各銘柄について daily_snapshots を時系列順に取得
//   - daily/weekly/monthly の3 timescale ぶんを計算
//   - ローリング状態 (MA 系列、拡散履歴、ステージ滞在トラッカー) を保持
//   - チャンク 200 行で INSERT (libSQL の SQL 長制限対策)、onConflictDoNothing で冪等

import { db, execAll, execGet } from '@/lib/db/client'
import { featureSnapshots, batchRuns, computeState } from '@/lib/db/schema'
import * as F from '@/lib/features'
import { eq, sql } from 'drizzle-orm'

type Timescale = 'daily' | 'weekly' | 'monthly'

// 二次回帰の窓 (timescale ごとの「直近 N 期間」)
const QUADRATIC_WINDOW: Record<Timescale, number> = {
  daily:   20,
  weekly:  13,
  monthly: 12,
}

// 拡散率の歴史的分位を取る lookback (営業日)
const HISTORICAL_PERCENTILE_LOOKBACK = 250

const PROGRESS_EVERY = 50
const LOOKBACK_DAYS = Number(process.env.FEATURE_LOOKBACK_DAYS ?? 900)
const FORCE_REBUILD = process.env.FEATURE_FORCE_REBUILD === '1'

// timescale ごとの MA カラム名 (daily_snapshots 上)
const MA_COLUMNS: Record<Timescale, readonly [string, string, string, string, string]> = {
  daily:   ['ma_5', 'ma_25', 'ma_75', 'ma_150', 'ma_300'],
  weekly:  ['weekly_ma_5', 'weekly_ma_13', 'weekly_ma_25', 'weekly_ma_50', 'weekly_ma_100'],
  monthly: ['monthly_ma_3', 'monthly_ma_5', 'monthly_ma_10', 'monthly_ma_20', 'monthly_ma_25'],
}

const STAGE_COLUMNS: Record<Timescale, { a: string; b: string }> = {
  daily:   { a: 'daily_a_stage',   b: 'daily_b_stage'   },
  weekly:  { a: 'weekly_a_stage',  b: 'weekly_b_stage'  },
  monthly: { a: 'monthly_a_stage', b: 'monthly_b_stage' },
}

interface FeatureRow {
  ticker: string
  date: string
  timescale: Timescale
  bin_order_a_12: number | null
  bin_order_a_13: number | null
  bin_order_a_23: number | null
  bin_order_b_12: number | null
  bin_order_b_13: number | null
  bin_order_b_23: number | null
  rel_dist_a_12: number | null
  rel_dist_a_13: number | null
  rel_dist_a_23: number | null
  rel_dist_b_12: number | null
  rel_dist_b_13: number | null
  rel_dist_b_23: number | null
  divergence_a: number | null
  divergence_b: number | null
  divergence_a_delta: number | null
  divergence_b_delta: number | null
  fan_uniformity: number | null
  divergence_percentile: number | null
  stage_a_age: number | null
  stage_b_age: number | null
  slope_m1: number | null
  accel_m1: number | null
  slope_m2: number | null
  accel_m2: number | null
  slope_m3: number | null
  accel_m3: number | null
  slope_m4: number | null
  accel_m4: number | null
  slope_m5: number | null
  accel_m5: number | null
  angle_synchrony: number | null
  stage_a_oh: string | null
  stage_b_oh: string | null
}

function dateDaysBefore(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

async function markFeatureState(ticker: string, lastProcessedDate: string): Promise<void> {
  await db
    .insert(computeState)
    .values({ jobType: 'feature_compute', ticker, lastProcessedDate })
    .onConflictDoUpdate({
      target: [computeState.jobType, computeState.ticker],
      set: {
        lastProcessedDate: sql`excluded.last_processed_date`,
        updatedAt: sql`unixepoch()`,
      },
    })
}

async function computeFeaturesForTicker(ticker: string): Promise<number> {
  const [state, existing] = await Promise.all([
    execGet<{ lastProcessedDate: string | null }>(
      `SELECT last_processed_date AS lastProcessedDate FROM compute_state WHERE job_type = 'feature_compute' AND ticker = ?`,
      [ticker],
    ),
    execGet<{ maxDate: string | null }>(
      `SELECT MAX(date) AS maxDate FROM feature_snapshots WHERE ticker = ?`,
      [ticker],
    ),
  ])
  const lastFeatureDate = FORCE_REBUILD
    ? null
    : [state?.lastProcessedDate, existing?.maxDate]
        .filter((date): date is string => Boolean(date))
        .sort()
        .at(-1) ?? null
  const startDate = lastFeatureDate ? dateDaysBefore(lastFeatureDate, LOOKBACK_DAYS) : null

  const snapshots = await execAll<Record<string, number | string | null>>(
    `
      SELECT *
      FROM daily_snapshots
      WHERE ticker = ?
        ${startDate ? 'AND date >= ?' : ''}
      ORDER BY date
    `,
    startDate ? [ticker, startDate] : [ticker],
  )

  if (snapshots.length === 0) return 0

  const features: FeatureRow[] = []
  const timescales: Timescale[] = ['daily', 'weekly', 'monthly']

  for (const timescale of timescales) {
    const window = QUADRATIC_WINDOW[timescale]
    const maCols = MA_COLUMNS[timescale]
    const stageCols = STAGE_COLUMNS[timescale]

    // 各 MA の時系列 (履歴に合わせて累積)
    const maSeries: number[][] = [[], [], [], [], []]
    const divergenceHistoryA: number[] = []
    const divergenceHistoryB: number[] = []

    // ステージ滞在トラッカー
    let stageARun: { stage: number | null; startIdx: number } = { stage: null, startIdx: 0 }
    let stageBRun: { stage: number | null; startIdx: number } = { stage: null, startIdx: 0 }

    for (let i = 0; i < snapshots.length; i++) {
      const snap = snapshots[i]
      const mas: (number | null)[] = maCols.map(col => snap[col] as number | null)

      // 系列に追加 (null なら追加せず — 古いデータが計算可能性を持つよう、indexは進める)
      for (let k = 0; k < 5; k++) {
        if (mas[k] != null) maSeries[k].push(mas[k]!)
      }

      // 5 本すべて揃ってないとこの日の特徴量は計算不能
      if (mas.some(v => v == null)) continue

      const [m1, m2, m3, m4, m5] = mas as number[]
      const stageA = snap[stageCols.a] as number | null
      const stageB = snap[stageCols.b] as number | null

      // バイナリ順序 (Period A: ma1/ma2/ma3, Period B: ma3/ma4/ma5)
      const binOrderA12 = m1 > m2 ? 1 : 0
      const binOrderA13 = m1 > m3 ? 1 : 0
      const binOrderA23 = m2 > m3 ? 1 : 0
      const binOrderB12 = m3 > m4 ? 1 : 0
      const binOrderB13 = m3 > m5 ? 1 : 0
      const binOrderB23 = m4 > m5 ? 1 : 0

      // 相対距離 (% 表示, (a-b)/b * 100)
      const relDistA12 = ((m1 - m2) / m2) * 100
      const relDistA13 = ((m1 - m3) / m3) * 100
      const relDistA23 = ((m2 - m3) / m3) * 100
      const relDistB12 = ((m3 - m4) / m4) * 100
      const relDistB13 = ((m3 - m5) / m5) * 100
      const relDistB23 = ((m4 - m5) / m5) * 100

      // 拡散率
      const divA = F.divergenceRate(m1, m2, m3)
      const divB = F.divergenceRate(m3, m4, m5)

      // delta (5 期間前との差)
      const divAPrev = divergenceHistoryA[divergenceHistoryA.length - 5]
      const divBPrev = divergenceHistoryB[divergenceHistoryB.length - 5]
      const divADelta = divAPrev != null ? divA - divAPrev : 0
      const divBDelta = divBPrev != null ? divB - divBPrev : 0

      divergenceHistoryA.push(divA)
      divergenceHistoryB.push(divB)

      // fan uniformity (Period A)
      const fanUni = F.fanUniformity(m1, m2, m3)

      // 拡散率の歴史的分位 (Period A の lookback 内)
      const lookback = Math.min(HISTORICAL_PERCENTILE_LOOKBACK, divergenceHistoryA.length - 1)
      const divHistory = divergenceHistoryA.slice(-lookback - 1, -1)
      const divPercentile = divHistory.length > 0
        ? F.historicalPercentile(divA, divHistory)
        : 0.5

      // ステージ滞在期間
      if (stageA !== stageARun.stage) stageARun = { stage: stageA, startIdx: i }
      if (stageB !== stageBRun.stage) stageBRun = { stage: stageB, startIdx: i }
      const stageAAge = stageA != null ? i - stageARun.startIdx : null
      const stageBAge = stageB != null ? i - stageBRun.startIdx : null

      // 二次回帰 (5 本の MA)
      const trends = maSeries.map(s => F.quadraticTrend(s, window))

      // 角度同期
      const synchrony = F.angleSynchrony(trends.map(t => t?.slope ?? null))

      // ステージ one-hot (JSON)
      const stageAOh = stageA != null
        ? JSON.stringify([1, 2, 3, 4, 5, 6].map(s => (s === stageA ? 1 : 0)))
        : null
      const stageBOh = stageB != null
        ? JSON.stringify([1, 2, 3, 4, 5, 6].map(s => (s === stageB ? 1 : 0)))
        : null
      const snapDate = snap.date as string

      if (lastFeatureDate && snapDate <= lastFeatureDate) continue

      features.push({
        ticker,
        date: snapDate,
        timescale,
        bin_order_a_12: binOrderA12,
        bin_order_a_13: binOrderA13,
        bin_order_a_23: binOrderA23,
        bin_order_b_12: binOrderB12,
        bin_order_b_13: binOrderB13,
        bin_order_b_23: binOrderB23,
        rel_dist_a_12: relDistA12,
        rel_dist_a_13: relDistA13,
        rel_dist_a_23: relDistA23,
        rel_dist_b_12: relDistB12,
        rel_dist_b_13: relDistB13,
        rel_dist_b_23: relDistB23,
        divergence_a: divA,
        divergence_b: divB,
        divergence_a_delta: divADelta,
        divergence_b_delta: divBDelta,
        fan_uniformity: fanUni,
        divergence_percentile: divPercentile,
        stage_a_age: stageAAge,
        stage_b_age: stageBAge,
        slope_m1: trends[0]?.slope ?? null,
        accel_m1: trends[0]?.acceleration ?? null,
        slope_m2: trends[1]?.slope ?? null,
        accel_m2: trends[1]?.acceleration ?? null,
        slope_m3: trends[2]?.slope ?? null,
        accel_m3: trends[2]?.acceleration ?? null,
        slope_m4: trends[3]?.slope ?? null,
        accel_m4: trends[3]?.acceleration ?? null,
        slope_m5: trends[4]?.slope ?? null,
        accel_m5: trends[4]?.acceleration ?? null,
        angle_synchrony: synchrony,
        stage_a_oh: stageAOh,
        stage_b_oh: stageBOh,
      })
    }
  }

  if (features.length === 0) {
    const latestSnapshotDate = snapshots[snapshots.length - 1]?.date
    if (typeof latestSnapshotDate === 'string') {
      await markFeatureState(ticker, latestSnapshotDate)
    }
    return 0
  }

  // チャンク INSERT
  const CHUNK = 200
  for (let i = 0; i < features.length; i += CHUNK) {
    const insert = db
      .insert(featureSnapshots)
      .values(features.slice(i, i + CHUNK))
    if (!FORCE_REBUILD) {
      await insert.onConflictDoNothing()
      continue
    }

    await insert.onConflictDoUpdate({
      target: [featureSnapshots.ticker, featureSnapshots.date, featureSnapshots.timescale],
      set: {
        bin_order_a_12: sql`excluded.bin_order_a_12`,
        bin_order_a_13: sql`excluded.bin_order_a_13`,
        bin_order_a_23: sql`excluded.bin_order_a_23`,
        bin_order_b_12: sql`excluded.bin_order_b_12`,
        bin_order_b_13: sql`excluded.bin_order_b_13`,
        bin_order_b_23: sql`excluded.bin_order_b_23`,
        rel_dist_a_12: sql`excluded.rel_dist_a_12`,
        rel_dist_a_13: sql`excluded.rel_dist_a_13`,
        rel_dist_a_23: sql`excluded.rel_dist_a_23`,
        rel_dist_b_12: sql`excluded.rel_dist_b_12`,
        rel_dist_b_13: sql`excluded.rel_dist_b_13`,
        rel_dist_b_23: sql`excluded.rel_dist_b_23`,
        divergence_a: sql`excluded.divergence_a`,
        divergence_b: sql`excluded.divergence_b`,
        divergence_a_delta: sql`excluded.divergence_a_delta`,
        divergence_b_delta: sql`excluded.divergence_b_delta`,
        fan_uniformity: sql`excluded.fan_uniformity`,
        divergence_percentile: sql`excluded.divergence_percentile`,
        stage_a_age: sql`excluded.stage_a_age`,
        stage_b_age: sql`excluded.stage_b_age`,
        slope_m1: sql`excluded.slope_m1`,
        accel_m1: sql`excluded.accel_m1`,
        slope_m2: sql`excluded.slope_m2`,
        accel_m2: sql`excluded.accel_m2`,
        slope_m3: sql`excluded.slope_m3`,
        accel_m3: sql`excluded.accel_m3`,
        slope_m4: sql`excluded.slope_m4`,
        accel_m4: sql`excluded.accel_m4`,
        slope_m5: sql`excluded.slope_m5`,
        accel_m5: sql`excluded.accel_m5`,
        angle_synchrony: sql`excluded.angle_synchrony`,
        stage_a_oh: sql`excluded.stage_a_oh`,
        stage_b_oh: sql`excluded.stage_b_oh`,
        computed_at: sql`unixepoch()`,
      },
    })
  }

  const latestDate = features[features.length - 1]?.date
  if (latestDate) {
    await markFeatureState(ticker, latestDate)
  }

  return features.length
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'feature_compute', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  const filter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
  const tickers: { ticker: string }[] = filter && filter.length > 0
    ? filter.map(ticker => ({ ticker }))
    : await execAll<{ ticker: string }>(`
        SELECT u.ticker
        FROM ticker_universe u
        WHERE u.active = 1
          AND (
            SELECT MAX(s.date)
            FROM daily_snapshots s
            WHERE s.ticker = u.ticker
          ) > COALESCE(
            (
              SELECT cs.last_processed_date
              FROM compute_state cs
              WHERE cs.job_type = 'feature_compute'
                AND cs.ticker = u.ticker
            ),
            (
              SELECT MAX(f.date)
              FROM feature_snapshots f
              WHERE f.ticker = u.ticker
            ),
            ''
          )
        ORDER BY u.ticker
      `)

  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []

  console.log(`Feature compute 開始: ${tickers.length} 銘柄 (FORCE_REBUILD=${FORCE_REBUILD})`)
  const startTime = Date.now()

  for (const [i, { ticker }] of tickers.entries()) {
    try {
      const count = await computeFeaturesForTicker(ticker)
      succeeded++
      rowsInserted += count
      if ((i + 1) % PROGRESS_EVERY === 0 || i === tickers.length - 1) {
        const pct = (((i + 1) / tickers.length) * 100).toFixed(1)
        const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
        console.log(`[${i + 1}/${tickers.length} ${pct}%] ${ticker}: +${count} (累計 ${rowsInserted}, 失敗 ${failed}, 経過 ${elapsedMin}min)`)
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

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / 計 ${rowsInserted} 行 / ${finalStatus}`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})

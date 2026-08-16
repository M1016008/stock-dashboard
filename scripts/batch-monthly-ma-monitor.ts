// 3/5/10/15/20/25か月線を同一ロジックで監視し、連続MAクラスターも保存する。

import { eq, sql } from 'drizzle-orm'
import { db, execAll, execGet, execRun } from '@/lib/db/client'
import {
  batchRuns,
  computeState,
  monthlyMaClusterDaily,
  monthlyMaClusterLatest,
  monthlyMaMonitorDaily,
} from '@/lib/db/schema'
import {
  MONTHLY_MA_CLUSTER_CONFIG,
  MONTHLY_MA_MONITOR_PERIODS,
  buildMonthlyMaClusterGroups,
  buildMonthlyMaMonitorSeries,
  classifyMonthlyMaCluster,
  describeMonthlyMaCluster,
  findMonthlyMaClusters,
  type MonthlyMaCrossDirection,
  type MonthlyMaEventState,
} from '@/lib/monthly-ma-monitor'
import { buildContinuousMonthlyMaSeries } from '@/lib/snapshots/continuous-ma'
import type { OHLCV } from '@/types/stock'

const PERIODS = [...MONTHLY_MA_MONITOR_PERIODS]
const CLUSTER_GROUPS = buildMonthlyMaClusterGroups(PERIODS)
const CONFIG_KEY = `monthly_ma_monitor_${PERIODS.join('_')}`
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.MONTHLY_MA_MONITOR_CONCURRENCY ?? 2)))
const RETENTION_CALENDAR_DAYS = Math.max(60, Number(process.env.MONTHLY_MA_MONITOR_RETENTION_DAYS ?? 220))
const FORCE_REBUILD = process.env.MONTHLY_MA_MONITOR_FORCE_REBUILD === '1'
const PROGRESS_EVERY = Math.max(1, Number(process.env.MONTHLY_MA_MONITOR_PROGRESS_EVERY ?? 100))
const WARMUP_CALENDAR_DAYS = Math.max(...PERIODS) * 32 + 160

interface LatestStateRow extends MonthlyMaEventState {
  period?: number
  clusterKey?: string
  date: string
}

type MonthlyInsert = typeof monthlyMaMonitorDaily.$inferInsert
type ClusterDailyInsert = typeof monthlyMaClusterDaily.$inferInsert
type ClusterLatestInsert = typeof monthlyMaClusterLatest.$inferInsert

function dateDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

function eventState(row: LatestStateRow | undefined): MonthlyMaEventState | undefined {
  if (!row) return undefined
  return {
    lastTouchDate: row.lastTouchDate ?? null,
    touchAgeSessions: row.touchAgeSessions == null ? null : Number(row.touchAgeSessions),
    lastCrossDate: row.lastCrossDate ?? null,
    lastCrossDirection: row.lastCrossDirection as MonthlyMaCrossDirection | null,
    crossAgeSessions: row.crossAgeSessions == null ? null : Number(row.crossAgeSessions),
  }
}

async function loadOhlcv(ticker: string, startDate: string | null): Promise<OHLCV[]> {
  return execAll<OHLCV>(
    `SELECT date, open, high, low, close, volume
     FROM ohlcv_daily
     WHERE ticker = ? ${startDate ? 'AND date >= ?' : ''}
     ORDER BY date`,
    startDate ? [ticker, startDate] : [ticker],
  )
}

async function loadLatestStates(ticker: string): Promise<{
  monthly: Map<number, LatestStateRow>
  clusters: Map<string, LatestStateRow>
}> {
  const [monthlyRows, clusterRows] = await Promise.all([
    execAll<LatestStateRow>(
      `SELECT period, date,
              last_touch_date AS lastTouchDate,
              touch_age_sessions AS touchAgeSessions,
              last_cross_date AS lastCrossDate,
              last_cross_direction AS lastCrossDirection,
              cross_age_sessions AS crossAgeSessions
       FROM monthly_ma_monitor_latest WHERE ticker = ?`,
      [ticker],
    ),
    execAll<LatestStateRow>(
      `SELECT cluster_key AS clusterKey, date,
              last_touch_date AS lastTouchDate,
              touch_age_sessions AS touchAgeSessions,
              last_cross_date AS lastCrossDate,
              last_cross_direction AS lastCrossDirection,
              cross_age_sessions AS crossAgeSessions
       FROM monthly_ma_cluster_latest WHERE ticker = ?`,
      [ticker],
    ),
  ])
  return {
    monthly: new Map(monthlyRows.map((row) => [Number(row.period), row])),
    clusters: new Map(clusterRows.map((row) => [String(row.clusterKey), row])),
  }
}

async function upsertMonthlyRows(rows: MonthlyInsert[]): Promise<void> {
  for (let index = 0; index < rows.length; index += 200) {
    await db.insert(monthlyMaMonitorDaily).values(rows.slice(index, index + 200)).onConflictDoUpdate({
      target: [monthlyMaMonitorDaily.ticker, monthlyMaMonitorDaily.period, monthlyMaMonitorDaily.date],
      set: {
        close: sql`excluded.close`, maValue: sql`excluded.ma_value`,
        distancePct: sql`excluded.distance_pct`, absDistancePct: sql`excluded.abs_distance_pct`,
        distance1dPct: sql`excluded.distance_1d_pct`, distance3dPct: sql`excluded.distance_3d_pct`,
        distance5dPct: sql`excluded.distance_5d_pct`, distance10dPct: sql`excluded.distance_10d_pct`,
        distance20dPct: sql`excluded.distance_20d_pct`, positionSide: sql`excluded.position_side`,
        isApproaching: sql`excluded.is_approaching`, approachDirection: sql`excluded.approach_direction`,
        approachSpeedPctPerDay: sql`excluded.approach_speed_pct_per_day`,
        approachConsistency: sql`excluded.approach_consistency`,
        distanceShrink5Pct: sql`excluded.distance_shrink_5_pct`,
        distanceShrink10Pct: sql`excluded.distance_shrink_10_pct`,
        isContactDefault: sql`excluded.is_contact_default`, isTouch: sql`excluded.is_touch`,
        lastTouchDate: sql`excluded.last_touch_date`, touchAgeSessions: sql`excluded.touch_age_sessions`,
        crossDirection: sql`excluded.cross_direction`, lastCrossDate: sql`excluded.last_cross_date`,
        lastCrossDirection: sql`excluded.last_cross_direction`, crossAgeSessions: sql`excluded.cross_age_sessions`,
        primaryStatus: sql`excluded.primary_status`, closenessScore: sql`excluded.closeness_score`,
        movementScore: sql`excluded.movement_score`, eventScore: sql`excluded.event_score`,
        approachScore: sql`excluded.approach_score`, isRapidApproach: sql`excluded.is_rapid_approach`,
        computedAt: sql`unixepoch()`,
      },
    })
  }
}

async function upsertClusterDailyRows(rows: ClusterDailyInsert[]): Promise<void> {
  for (let index = 0; index < rows.length; index += 200) {
    await db.insert(monthlyMaClusterDaily).values(rows.slice(index, index + 200)).onConflictDoUpdate({
      target: [monthlyMaClusterDaily.ticker, monthlyMaClusterDaily.clusterKey, monthlyMaClusterDaily.date],
      set: {
        periodsJson: sql`excluded.periods_json`, periodCount: sql`excluded.period_count`,
        clusterType: sql`excluded.cluster_type`, isStrong: sql`excluded.is_strong`,
        bandLow: sql`excluded.band_low`, bandHigh: sql`excluded.band_high`,
        bandAverage: sql`excluded.band_average`, spreadPct: sql`excluded.spread_pct`,
        close: sql`excluded.close`, distancePct: sql`excluded.distance_pct`,
        absDistancePct: sql`excluded.abs_distance_pct`, approachDirection: sql`excluded.approach_direction`,
        isApproaching: sql`excluded.is_approaching`,
        approachSpeedPctPerDay: sql`excluded.approach_speed_pct_per_day`,
        isTouch: sql`excluded.is_touch`, lastTouchDate: sql`excluded.last_touch_date`,
        touchAgeSessions: sql`excluded.touch_age_sessions`, crossDirection: sql`excluded.cross_direction`,
        lastCrossDate: sql`excluded.last_cross_date`, lastCrossDirection: sql`excluded.last_cross_direction`,
        crossAgeSessions: sql`excluded.cross_age_sessions`, primaryStatus: sql`excluded.primary_status`,
        approachScore: sql`excluded.approach_score`, computedAt: sql`unixepoch()`,
      },
    })
  }
}

async function replaceLatestRows(
  ticker: string,
  clusterRows: ClusterLatestInsert[],
): Promise<void> {
  await execRun(`DELETE FROM monthly_ma_monitor_latest WHERE ticker = ?`, [ticker])
  await execRun(
    `INSERT INTO monthly_ma_monitor_latest
     SELECT d.* FROM monthly_ma_monitor_daily d
     INNER JOIN (
       SELECT period, MAX(date) AS date
       FROM monthly_ma_monitor_daily WHERE ticker = ? GROUP BY period
     ) latest ON latest.period = d.period AND latest.date = d.date
     WHERE d.ticker = ?`,
    [ticker, ticker],
  )
  // 同一source_dateの明示再実行で新規pointがない場合は、既存イベント状態を維持する。
  if (clusterRows.length > 0) {
    await execRun(`DELETE FROM monthly_ma_cluster_latest WHERE ticker = ?`, [ticker])
    for (let index = 0; index < clusterRows.length; index += 200) {
      await db.insert(monthlyMaClusterLatest).values(clusterRows.slice(index, index + 200))
    }
  }
}

async function markProcessed(ticker: string, date: string): Promise<void> {
  await db.insert(computeState).values({ jobType: CONFIG_KEY, ticker, lastProcessedDate: date })
    .onConflictDoUpdate({
      target: [computeState.jobType, computeState.ticker],
      set: { lastProcessedDate: sql`excluded.last_processed_date`, updatedAt: sql`unixepoch()` },
    })
}

async function writeTicker(ticker: string, latestSourceDate: string, retentionCutoff: string): Promise<number> {
  const states = await loadLatestStates(ticker)
  // 上場後の履歴が短い銘柄は長期MAを持たないため、全期間の存在を再開条件にしない。
  const latestStateDate = [...states.monthly.values()].map((row) => row.date).sort().at(-1) ?? null
  const startDate = !FORCE_REBUILD && latestStateDate
    ? dateDaysBefore(latestStateDate, WARMUP_CALENDAR_DAYS)
    : null
  const rawRows = await loadOhlcv(ticker, startDate)
  if (rawRows.length === 0) {
    await markProcessed(ticker, latestSourceDate)
    return 0
  }
  const series = buildContinuousMonthlyMaSeries(rawRows, PERIODS)
  const monthlyRows: MonthlyInsert[] = []

  for (const period of PERIODS) {
    const latest = states.monthly.get(period)
    const points = buildMonthlyMaMonitorSeries(
      series.flatMap((row) => {
        const maValue = row.values.get(period)
        return maValue == null ? [] : [{ ...row, targetValue: maValue }]
      }),
      {
        seed: FORCE_REBUILD ? undefined : eventState(latest),
        emitAfterDate: FORCE_REBUILD ? null : latest?.date ?? null,
      },
    )
    for (const point of points) {
      if (point.date < retentionCutoff) continue
      monthlyRows.push({
        ticker, period, date: point.date, close: point.close, maValue: point.targetValue,
        distancePct: point.distancePct, absDistancePct: point.absDistancePct,
        distance1dPct: point.distance1dPct, distance3dPct: point.distance3dPct,
        distance5dPct: point.distance5dPct, distance10dPct: point.distance10dPct,
        distance20dPct: point.distance20dPct, positionSide: point.positionSide,
        isApproaching: point.isApproaching, approachDirection: point.approachDirection,
        approachSpeedPctPerDay: point.approachSpeedPctPerDay,
        approachConsistency: point.approachConsistency,
        distanceShrink5Pct: point.distanceShrink5Pct, distanceShrink10Pct: point.distanceShrink10Pct,
        isContactDefault: point.isContactDefault, isTouch: point.isTouch,
        lastTouchDate: point.lastTouchDate, touchAgeSessions: point.touchAgeSessions,
        crossDirection: point.crossDirection, lastCrossDate: point.lastCrossDate,
        lastCrossDirection: point.lastCrossDirection, crossAgeSessions: point.crossAgeSessions,
        primaryStatus: point.primaryStatus, closenessScore: point.closenessScore,
        movementScore: point.movementScore, eventScore: point.eventScore,
        approachScore: point.approachScore, isRapidApproach: point.isRapidApproach,
      })
    }
  }

  const maximalByDate = new Map(series.map((row) => [
    row.date,
    new Set(findMonthlyMaClusters(row.values).map((cluster) => cluster.key)),
  ]))
  const clusterDailyRows: ClusterDailyInsert[] = []
  const clusterLatestRows: ClusterLatestInsert[] = []

  for (const group of CLUSTER_GROUPS) {
    const latest = states.clusters.get(group.key)
    const metadataByDate = new Map<string, {
      definition: NonNullable<ReturnType<typeof describeMonthlyMaCluster>>
      isCluster: boolean
      isMaximal: boolean
    }>()
    const observations = series.flatMap((row) => {
      const definition = describeMonthlyMaCluster(group, row.values, Number.POSITIVE_INFINITY)
      if (!definition) return []
      const isCluster = definition.spreadPct <= MONTHLY_MA_CLUSTER_CONFIG.spreadThresholdPct
      metadataByDate.set(row.date, {
        definition,
        isCluster,
        isMaximal: isCluster && Boolean(maximalByDate.get(row.date)?.has(group.key)),
      })
      return [{
        ...row,
        targetValue: definition.bandAverage,
        targetLow: definition.bandLow,
        targetHigh: definition.bandHigh,
        eventActive: isCluster,
      }]
    })
    const points = buildMonthlyMaMonitorSeries(observations, {
      seed: FORCE_REBUILD ? undefined : eventState(latest),
      emitAfterDate: FORCE_REBUILD ? null : latest?.date ?? null,
    })
    for (const point of points) {
      const metadata = metadataByDate.get(point.date)
      if (!metadata) continue
      const base = {
        ticker, clusterKey: group.key, date: point.date,
        periodsJson: JSON.stringify(group.periods), periodCount: group.periods.length,
        clusterType: classifyMonthlyMaCluster(group.periods),
        isStrong: group.periods.length >= MONTHLY_MA_CLUSTER_CONFIG.strongMinimumPeriods,
        bandLow: metadata.definition.bandLow, bandHigh: metadata.definition.bandHigh,
        bandAverage: metadata.definition.bandAverage, spreadPct: metadata.definition.spreadPct,
        close: point.close, distancePct: point.distancePct, absDistancePct: point.absDistancePct,
        approachDirection: point.approachDirection, isApproaching: point.isApproaching,
        approachSpeedPctPerDay: point.approachSpeedPctPerDay, isTouch: point.isTouch,
        lastTouchDate: point.lastTouchDate, touchAgeSessions: point.touchAgeSessions,
        crossDirection: point.crossDirection, lastCrossDate: point.lastCrossDate,
        lastCrossDirection: point.lastCrossDirection, crossAgeSessions: point.crossAgeSessions,
        primaryStatus: point.primaryStatus, approachScore: point.approachScore,
      }
      if (point.date >= retentionCutoff && metadata.isCluster && metadata.isMaximal) {
        clusterDailyRows.push(base)
      }
      if (point.date === points.at(-1)?.date) {
        clusterLatestRows.push({ ...base, isCluster: metadata.isCluster, isMaximal: metadata.isMaximal })
      }
    }
  }

  if (FORCE_REBUILD) {
    // 計算仕様や元データが変わった場合に、再生成されなくなった古い行を残さない。
    await execRun(`DELETE FROM monthly_ma_monitor_daily WHERE ticker = ?`, [ticker])
    await execRun(`DELETE FROM monthly_ma_cluster_daily WHERE ticker = ?`, [ticker])
  }
  await upsertMonthlyRows(monthlyRows)
  await upsertClusterDailyRows(clusterDailyRows)
  await replaceLatestRows(ticker, clusterLatestRows)
  await markProcessed(ticker, latestSourceDate)
  return monthlyRows.length + clusterDailyRows.length
}

async function main(): Promise<void> {
  const [run] = await db.insert(batchRuns).values({
    jobType: 'monthly_ma_monitor', startedAt: new Date(), status: 'running',
  }).returning({ id: batchRuns.id })
  const runId = run.id

  try {
    const latest = await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM ohlcv_daily`)
    if (!latest?.date) throw new Error('JP OHLCV source date is unavailable')
    const latestSourceDate = latest.date
    const retentionCutoff = dateDaysBefore(latestSourceDate, RETENTION_CALENDAR_DAYS)
    const tickerFilter = process.env.TICKERS?.split(',').map((ticker) => ticker.trim()).filter(Boolean)
    const tickers = tickerFilter?.length
      ? tickerFilter.map((ticker) => ({ ticker }))
      : await execAll<{ ticker: string }>(
          `SELECT u.ticker
           FROM ticker_universe u
           INNER JOIN ohlcv_daily o ON o.ticker = u.ticker AND o.date = ?
           LEFT JOIN compute_state c ON c.job_type = ? AND c.ticker = u.ticker
           WHERE u.active = 1 AND (? = 1 OR c.last_processed_date IS NULL OR c.last_processed_date < ?)
           ORDER BY u.ticker`,
          [latestSourceDate, CONFIG_KEY, FORCE_REBUILD ? 1 : 0, latestSourceDate],
        )

    console.log(`Monthly MA monitor: ${tickers.length} tickers, periods=${PERIODS.join(',')}, latest=${latestSourceDate}, concurrency=${CONCURRENCY}`)
    let nextIndex = 0
    let processed = 0
    let succeeded = 0
    let failed = 0
    let rowsInserted = 0
    const errors: string[] = []

    async function worker(): Promise<void> {
      while (true) {
        const item = tickers[nextIndex++]
        if (!item) return
        try {
          const inserted = await writeTicker(item.ticker, latestSourceDate, retentionCutoff)
          rowsInserted += inserted
          succeeded += 1
        } catch (error) {
          failed += 1
          const message = `${item.ticker}: ${error instanceof Error ? error.message : String(error)}`
          errors.push(message)
          console.error(message)
        } finally {
          processed += 1
          if (processed % PROGRESS_EVERY === 0 || processed === tickers.length) {
            console.log(`[${processed}/${tickers.length}] rows=${rowsInserted}, failed=${failed}`)
          }
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, () => worker()))
    await execRun(`DELETE FROM monthly_ma_monitor_daily WHERE date < ?`, [retentionCutoff])
    await execRun(`DELETE FROM monthly_ma_cluster_daily WHERE date < ?`, [retentionCutoff])
    const status = failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial'
    await db.update(batchRuns).set({
      finishedAt: new Date(), status, totalTickers: tickers.length,
      succeeded, failed, rowsInserted,
      errorSummary: errors.length ? JSON.stringify(errors.slice(0, 10)) : null,
    }).where(eq(batchRuns.id, runId))
    if (failed > 0) {
      console.error(`Monthly MA monitor completed with ${failed} failed tickers`)
      process.exitCode = 1
      return
    }
    console.log(`Monthly MA monitor complete: ${succeeded} tickers, ${rowsInserted} rows`)
  } catch (error) {
    await db.update(batchRuns).set({
      finishedAt: new Date(), status: 'failed', failed: 1,
      errorSummary: error instanceof Error ? error.message : String(error),
    }).where(eq(batchRuns.id, runId))
    throw error
  }
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})

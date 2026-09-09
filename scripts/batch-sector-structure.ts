// 個別銘柄の6ステージを、既存分類ごとに構成比・遷移・波及として集約する。
// 株価を平均せず、daily_snapshots と stock_classification を唯一の入力にする。

import { client, db, ensureReady, execAll } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { historicalUniverseMembershipSql } from '@/lib/historical-universe'
import { SECTOR_STRUCTURE_AXES } from '@/lib/sector-structure'
import {
  buildSectorStructureSeries,
  type SectorStructureGroupRecord,
  type SectorStructureSourceRow,
} from '@/lib/sector-structure-series'
import { acquireExclusiveUpdateLock, type UpdateLockHandle } from '@/lib/server/update-lock'
import { eq } from 'drizzle-orm'

const LOOKBACK_DATES = Math.max(25, Math.min(180, Number(process.env.SECTOR_STRUCTURE_LOOKBACK_DAYS ?? 90)))
const WRITE_CHUNK_SIZE = 150

async function latestDates(): Promise<string[]> {
  const rows = await execAll<{ date: string }>(`
    SELECT date
    FROM (
      SELECT DISTINCT date FROM daily_snapshots ORDER BY date DESC LIMIT ?
    )
    ORDER BY date ASC
  `, [LOOKBACK_DATES])
  return rows.map((row) => row.date)
}

async function loadRows(startDate: string, endDate: string): Promise<SectorStructureSourceRow[]> {
  const historicalMembership = historicalUniverseMembershipSql(
    'source.date',
    'hu',
    'tu',
    'source.ticker IS NOT NULL',
  )
  return execAll<SectorStructureSourceRow>(`
    WITH source AS (
      SELECT
        s.ticker,
        s.date,
        s.daily_a_stage AS dailyA,
        s.daily_b_stage AS dailyB,
        s.weekly_a_stage AS weeklyA,
        s.weekly_b_stage AS weeklyB,
        s.monthly_a_stage AS monthlyA,
        s.monthly_b_stage AS monthlyB,
        LAG(s.daily_a_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevDailyA,
        LAG(s.daily_b_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevDailyB,
        LAG(s.weekly_a_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevWeeklyA,
        LAG(s.weekly_b_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevWeeklyB,
        LAG(s.monthly_a_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevMonthlyA,
        LAG(s.monthly_b_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevMonthlyB
      FROM daily_snapshots AS s
      WHERE s.date >= ? AND s.date <= ?
    )
    SELECT
      source.*,
      COALESCE(hu.sector17_code, tu.sector17_code) AS sector17Code,
      COALESCE(hu.sector17_name, tu.sector17_name) AS sector17Name,
      COALESCE(hu.sector33_code, tu.sector33_code) AS sector33Code,
      COALESCE(hu.sector33_name, tu.sector33_name) AS sector33Name,
      sc.major_category AS majorCategory,
      sc.sub_industry AS subIndustry
    FROM source
    LEFT JOIN historical_universe AS hu ON hu.ticker = source.ticker
    LEFT JOIN ticker_universe AS tu ON tu.ticker = source.ticker
    LEFT JOIN stock_classification AS sc ON sc.ticker = source.ticker
    WHERE source.date > ?
      AND ${historicalMembership}
    ORDER BY source.date, source.ticker
  `, [startDate, endDate, startDate])
}

async function writeGroups(groups: SectorStructureGroupRecord[], lock: UpdateLockHandle | null): Promise<void> {
  for (let offset = 0; offset < groups.length; offset += WRITE_CHUNK_SIZE) {
    const chunk = groups.slice(offset, offset + WRITE_CHUNK_SIZE)
    await client.batch(chunk.map((group) => ({
      sql: `
        INSERT INTO sector_structure_daily (
          taxonomy, group_key, group_name, parent_group, date,
          n_stocks, valid_stage_count, strength_score, transition_change_score,
          momentum_5d, momentum_10d, momentum_20d,
          propagation_direction, propagation_phase, propagation_label,
          improving_count, deteriorating_count, stable_count,
          axis_json, composition_json, computed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(taxonomy, group_key, date) DO UPDATE SET
          group_name = excluded.group_name,
          parent_group = excluded.parent_group,
          n_stocks = excluded.n_stocks,
          valid_stage_count = excluded.valid_stage_count,
          strength_score = excluded.strength_score,
          transition_change_score = excluded.transition_change_score,
          momentum_5d = excluded.momentum_5d,
          momentum_10d = excluded.momentum_10d,
          momentum_20d = excluded.momentum_20d,
          propagation_direction = excluded.propagation_direction,
          propagation_phase = excluded.propagation_phase,
          propagation_label = excluded.propagation_label,
          improving_count = excluded.improving_count,
          deteriorating_count = excluded.deteriorating_count,
          stable_count = excluded.stable_count,
          axis_json = excluded.axis_json,
          composition_json = excluded.composition_json,
          computed_at = unixepoch()
      `,
      args: [
        group.taxonomy, group.groupKey, group.groupName, group.parentGroup, group.date,
        group.nStocks, group.validStageCount, group.strengthScore, group.transitionChangeScore,
        group.momentum5d, group.momentum10d, group.momentum20d,
        group.propagationDirection, group.propagationPhase, group.propagationLabel,
        group.improvingCount, group.deterioratingCount, group.stableCount,
        JSON.stringify(group.axes),
        JSON.stringify(Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => [axis.key, group.axes[axis.key].stages]))),
      ],
    })))
    await lock?.heartbeat()
  }
}

async function main(): Promise<void> {
  await ensureReady()
  const skipLock = process.env.SECTOR_STRUCTURE_SKIP_LOCK === '1'
  const lock = skipLock ? null : await acquireExclusiveUpdateLock('sector_structure')
  if (!skipLock && !lock) throw new Error('sector structure aggregation deferred: another update writer is active')

  const [run] = await db.insert(batchRuns).values({
    jobType: 'sector_structure',
    startedAt: new Date(),
    status: 'running',
  }).returning({ id: batchRuns.id })

  try {
    const dates = await latestDates()
    if (dates.length < 2) throw new Error('sector structure aggregation requires at least two snapshot dates')
    const rows = await loadRows(dates[0], dates[dates.length - 1])
    const groups = buildSectorStructureSeries(rows)
    await writeGroups(groups, lock)
    await db.update(batchRuns).set({
      finishedAt: new Date(),
      status: 'success',
      succeeded: 1,
      rowsInserted: groups.length,
      errorSummary: null,
    }).where(eq(batchRuns.id, run.id))
    console.log(`業種構造集計完了: ${groups.length.toLocaleString()} 行 / ${dates[0]} -> ${dates[dates.length - 1]}`)
  } catch (error) {
    await db.update(batchRuns).set({
      finishedAt: new Date(),
      status: 'failed',
      failed: 1,
      errorSummary: error instanceof Error ? error.message : String(error),
    }).where(eq(batchRuns.id, run.id))
    throw error
  } finally {
    await lock?.release()
  }
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})

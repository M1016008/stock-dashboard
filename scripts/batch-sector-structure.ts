// 個別銘柄の6ステージを、既存分類ごとに構成比・遷移・波及として集約する。
// 株価を平均せず、daily_snapshots と stock_classification を唯一の入力にする。

import { client, db, ensureReady, execAll } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { calculateGroupStructure, propagationFromAxisMomentum, SECTOR_STRUCTURE_AXES, type GroupStageInput, type SectorStructureAxisKey, type SectorStructureTaxonomy } from '@/lib/sector-structure'
import { acquireExclusiveUpdateLock, type UpdateLockHandle } from '@/lib/server/update-lock'
import { eq } from 'drizzle-orm'

const LOOKBACK_DATES = Math.max(25, Math.min(180, Number(process.env.SECTOR_STRUCTURE_LOOKBACK_DAYS ?? 90)))
const WRITE_CHUNK_SIZE = 150

type RawRow = {
  ticker: string
  date: string
  sector17Code: string | null
  sector17Name: string | null
  sector33Code: string | null
  sector33Name: string | null
  majorCategory: string | null
  subIndustry: string | null
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
  prevDailyA: number | null
  prevDailyB: number | null
  prevWeeklyA: number | null
  prevWeeklyB: number | null
  prevMonthlyA: number | null
  prevMonthlyB: number | null
}

type GroupMeta = {
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  groupName: string
  parentGroup: string | null
}

type PendingGroup = GroupMeta & {
  date: string
  inputs: GroupStageInput[]
}

type PersistedGroup = GroupMeta & {
  date: string
  nStocks: number
  validStageCount: number
  strengthScore: number | null
  transitionChangeScore: number
  improvingCount: number
  deterioratingCount: number
  stableCount: number
  axes: ReturnType<typeof calculateGroupStructure>['axes']
  momentum5d: number | null
  momentum10d: number | null
  momentum20d: number | null
  propagationDirection: string
  propagationPhase: number
  propagationLabel: string
}

const axisValue = (row: RawRow, prefix: '' | 'prev', key: SectorStructureAxisKey): number | null => {
  const values: Record<`${'' | 'prev'}${SectorStructureAxisKey}`, number | null> = {
    dailyA: row.dailyA,
    dailyB: row.dailyB,
    weeklyA: row.weeklyA,
    weeklyB: row.weeklyB,
    monthlyA: row.monthlyA,
    monthlyB: row.monthlyB,
    prevdailyA: row.prevDailyA,
    prevdailyB: row.prevDailyB,
    prevweeklyA: row.prevWeeklyA,
    prevweeklyB: row.prevWeeklyB,
    prevmonthlyA: row.prevMonthlyA,
    prevmonthlyB: row.prevMonthlyB,
  }
  return values[`${prefix}${key}`]
}

function asInput(row: RawRow): GroupStageInput {
  return {
    stages: Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => [axis.key, axisValue(row, '', axis.key)])),
    previousStages: Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => [axis.key, axisValue(row, 'prev', axis.key)])),
  }
}

function groupMetas(row: RawRow): GroupMeta[] {
  const metas: GroupMeta[] = []
  if (row.sector17Name) {
    metas.push({ taxonomy: '17', groupKey: row.sector17Code ?? row.sector17Name, groupName: row.sector17Name, parentGroup: null })
  }
  if (row.sector33Name) {
    metas.push({ taxonomy: '33', groupKey: row.sector33Code ?? row.sector33Name, groupName: row.sector33Name, parentGroup: null })
  }
  if (row.majorCategory) {
    metas.push({ taxonomy: 'major', groupKey: row.majorCategory, groupName: row.majorCategory, parentGroup: null })
  }
  if (row.majorCategory && row.subIndustry) {
    metas.push({
      taxonomy: 'subIndustry',
      groupKey: `${row.majorCategory}\u001f${row.subIndustry}`,
      groupName: row.subIndustry,
      parentGroup: row.majorCategory,
    })
  }
  return metas
}

function pendingKey(meta: GroupMeta, date: string): string {
  return `${date}\u001e${meta.taxonomy}\u001e${meta.groupKey}`
}

function groupKey(record: PersistedGroup): string {
  return `${record.taxonomy}\u001e${record.groupKey}`
}

function sumRecent(values: number[], index: number, count: number): number | null {
  if (index < 0) return null
  const start = Math.max(0, index - count + 1)
  const slice = values.slice(start, index + 1)
  return slice.length > 0 ? slice.reduce((sum, value) => sum + value, 0) : null
}

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

async function loadRows(startDate: string, endDate: string): Promise<RawRow[]> {
  return execAll<RawRow>(`
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
      tu.sector17_code AS sector17Code,
      tu.sector17_name AS sector17Name,
      tu.sector33_code AS sector33Code,
      tu.sector33_name AS sector33Name,
      sc.major_category AS majorCategory,
      sc.sub_industry AS subIndustry
    FROM source
    INNER JOIN ticker_universe AS tu ON tu.ticker = source.ticker AND tu.active = 1
    LEFT JOIN stock_classification AS sc ON sc.ticker = source.ticker
    WHERE source.date > ?
    ORDER BY source.date, source.ticker
  `, [startDate, endDate, startDate])
}

function toPersistedGroups(rows: RawRow[]): PersistedGroup[] {
  const pending = new Map<string, PendingGroup>()
  for (const row of rows) {
    const input = asInput(row)
    for (const meta of groupMetas(row)) {
      const key = pendingKey(meta, row.date)
      const existing = pending.get(key)
      if (existing) existing.inputs.push(input)
      else pending.set(key, { ...meta, date: row.date, inputs: [input] })
    }
  }

  const groups = Array.from(pending.values()).map((group) => {
    const summary = calculateGroupStructure(group.inputs)
    return {
      taxonomy: group.taxonomy,
      groupKey: group.groupKey,
      groupName: group.groupName,
      parentGroup: group.parentGroup,
      date: group.date,
      nStocks: summary.nStocks,
      validStageCount: summary.validStageCount,
      strengthScore: summary.strengthScore,
      transitionChangeScore: summary.transitionChangeScore,
      improvingCount: summary.improvingCount,
      deterioratingCount: summary.deterioratingCount,
      stableCount: summary.stableCount,
      axes: summary.axes,
      momentum5d: null,
      momentum10d: null,
      momentum20d: null,
      propagationDirection: 'neutral',
      propagationPhase: 0,
      propagationLabel: '構造変化は中立',
    } satisfies PersistedGroup
  })

  const byGroup = new Map<string, PersistedGroup[]>()
  for (const group of groups) {
    const key = groupKey(group)
    const list = byGroup.get(key) ?? []
    list.push(group)
    byGroup.set(key, list)
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    for (let i = 0; i < list.length; i += 1) {
      const current = list[i]
      current.momentum5d = sumRecent(list.map((item) => item.transitionChangeScore), i, 5)
      current.momentum10d = sumRecent(list.map((item) => item.transitionChangeScore), i, 10)
      current.momentum20d = sumRecent(list.map((item) => item.transitionChangeScore), i, 20)
      const axisMomentum = Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => [
        axis.key,
        sumRecent(list.map((item) => item.axes[axis.key].changeScore), i, 5),
      ]))
      const propagation = propagationFromAxisMomentum(axisMomentum)
      current.propagationDirection = propagation.direction
      current.propagationPhase = propagation.phase
      current.propagationLabel = propagation.label
    }
  }
  return groups
}

async function writeGroups(groups: PersistedGroup[], lock: UpdateLockHandle | null): Promise<void> {
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
    const groups = toPersistedGroups(rows)
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

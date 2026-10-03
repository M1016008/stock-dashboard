import {
  calculateGroupStructure,
  propagationFromAxisMomentum,
  SECTOR_STRUCTURE_AXES,
  type GroupStageInput,
  type SectorStructureAxisKey,
  type SectorStructureTaxonomy,
} from '@/lib/sector-structure'

export type SectorStructureSourceRow = {
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

export type SectorStructureGroupRecord = GroupMeta & {
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
  propagationDirection: 'improving' | 'deteriorating' | 'neutral'
  propagationPhase: number
  propagationLabel: string
}

const axisValue = (
  row: SectorStructureSourceRow,
  prefix: '' | 'prev',
  key: SectorStructureAxisKey,
): number | null => {
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

function asInput(row: SectorStructureSourceRow): GroupStageInput {
  return {
    stages: Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => [axis.key, axisValue(row, '', axis.key)])),
    previousStages: Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => [axis.key, axisValue(row, 'prev', axis.key)])),
  }
}

function groupMetas(row: SectorStructureSourceRow): GroupMeta[] {
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

function recordKey(record: SectorStructureGroupRecord): string {
  return `${record.taxonomy}\u001e${record.groupKey}`
}

function sumRecent(values: number[], index: number, count: number): number | null {
  if (index < 0) return null
  const start = Math.max(0, index - count + 1)
  const slice = values.slice(start, index + 1)
  return slice.length > 0 ? slice.reduce((sum, value) => sum + value, 0) : null
}

export function buildSectorStructureSeries(
  rows: SectorStructureSourceRow[],
  taxonomies?: readonly SectorStructureTaxonomy[],
): SectorStructureGroupRecord[] {
  const taxonomySet = taxonomies ? new Set<SectorStructureTaxonomy>(taxonomies) : null
  const pending = new Map<string, PendingGroup>()
  for (const row of rows) {
    const input = asInput(row)
    for (const meta of groupMetas(row)) {
      if (taxonomySet && !taxonomySet.has(meta.taxonomy)) continue
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
    } satisfies SectorStructureGroupRecord
  })

  const byGroup = new Map<string, SectorStructureGroupRecord[]>()
  for (const group of groups) {
    const key = recordKey(group)
    const list = byGroup.get(key) ?? []
    list.push(group)
    byGroup.set(key, list)
  }
  for (const list of byGroup.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date))
    const transitionScores = list.map((item) => item.transitionChangeScore)
    for (let i = 0; i < list.length; i += 1) {
      const current = list[i]
      current.momentum5d = sumRecent(transitionScores, i, 5)
      current.momentum10d = sumRecent(transitionScores, i, 10)
      current.momentum20d = sumRecent(transitionScores, i, 20)
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

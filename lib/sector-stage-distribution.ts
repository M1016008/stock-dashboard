import { isStage, type StageLevel } from '@/lib/hex-stage'
import {
  SECTOR_STRUCTURE_AXES,
  type SectorStructureAxisKey,
  type SectorStructureTaxonomy,
} from '@/lib/sector-structure'

export const SECTOR_STAGE_LEVELS = [1, 2, 3, 4, 5, 6] as const

export type SectorStageCounts = Record<StageLevel, number>
export type SectorStageComposition = Record<SectorStructureAxisKey, SectorStageCounts>
export type SectorStageDeltas = Record<SectorStructureAxisKey, SectorStageCounts>
export type SectorMarketBaseline = Record<SectorStructureAxisKey, Record<StageLevel, number>>

export type SectorDominantStageChange = {
  axis: SectorStructureAxisKey
  axisLabel: string
  stage: StageLevel
  delta: number
}

function emptyStageCounts(): SectorStageCounts {
  return { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
}

export function emptySectorStageComposition(): SectorStageComposition {
  return Object.fromEntries(
    SECTOR_STRUCTURE_AXES.map((axis) => [axis.key, emptyStageCounts()]),
  ) as SectorStageComposition
}

export function parseSectorStageComposition(raw: string | null | undefined): SectorStageComposition {
  const fallback = emptySectorStageComposition()
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as Partial<Record<SectorStructureAxisKey, Record<string, unknown>>>
    for (const axis of SECTOR_STRUCTURE_AXES) {
      const source = parsed[axis.key]
      if (!source || typeof source !== 'object') continue
      for (const stage of SECTOR_STAGE_LEVELS) {
        const value = Number(source[String(stage)])
        fallback[axis.key][stage] = Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
      }
    }
  } catch {
    // Old or partially written records render as an empty distribution.
  }
  return fallback
}

export function calculateSectorStageDeltas(
  current: SectorStageComposition,
  previous: SectorStageComposition | null,
): SectorStageDeltas {
  const deltas = emptySectorStageComposition()
  if (!previous) return deltas
  for (const axis of SECTOR_STRUCTURE_AXES) {
    for (const stage of SECTOR_STAGE_LEVELS) {
      deltas[axis.key][stage] = current[axis.key][stage] - previous[axis.key][stage]
    }
  }
  return deltas
}

export function calculateSectorMarketBaseline(
  rows: readonly { composition: SectorStageComposition }[],
): SectorMarketBaseline {
  return Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => {
    const counts = emptyStageCounts()
    let total = 0
    for (const row of rows) {
      for (const stage of SECTOR_STAGE_LEVELS) {
        counts[stage] += row.composition[axis.key][stage]
        total += row.composition[axis.key][stage]
      }
    }
    return [
      axis.key,
      Object.fromEntries(SECTOR_STAGE_LEVELS.map((stage) => [stage, total > 0 ? counts[stage] / total : 0])),
    ]
  })) as SectorMarketBaseline
}

export function findDominantStageChange(deltas: SectorStageDeltas): SectorDominantStageChange | null {
  let dominant: SectorDominantStageChange | null = null
  for (const axis of SECTOR_STRUCTURE_AXES) {
    for (const stage of SECTOR_STAGE_LEVELS) {
      const delta = deltas[axis.key][stage]
      if (delta === 0) continue
      if (!dominant || Math.abs(delta) > Math.abs(dominant.delta)) {
        dominant = { axis: axis.key, axisLabel: axis.label, stage, delta }
      }
    }
  }
  return dominant
}

export function normalizeSectorStructureTaxonomy(value: unknown): SectorStructureTaxonomy | null {
  return value === '17' || value === '33' || value === 'major' || value === 'subIndustry'
    ? value
    : null
}

export function normalizeSectorStructureAxis(value: unknown): SectorStructureAxisKey | null {
  return SECTOR_STRUCTURE_AXES.find((axis) => axis.key === value)?.key ?? null
}

export function normalizeSectorStage(value: unknown): StageLevel | null {
  const stage = Number(value)
  return isStage(stage) ? stage : null
}

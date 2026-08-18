import {
  getStageTransitionDirection,
  isStage,
  STAGE_STRUCTURE_STRENGTH,
  type StageLevel,
} from '@/lib/hex-stage'

export const SECTOR_STRUCTURE_AXES = [
  { key: 'dailyA', dbColumn: 'daily_a_stage', label: '日足A', weight: 1.0 },
  { key: 'dailyB', dbColumn: 'daily_b_stage', label: '日足B', weight: 0.9 },
  { key: 'weeklyA', dbColumn: 'weekly_a_stage', label: '週足A', weight: 0.75 },
  { key: 'weeklyB', dbColumn: 'weekly_b_stage', label: '週足B', weight: 0.65 },
  { key: 'monthlyA', dbColumn: 'monthly_a_stage', label: '月足A', weight: 0.5 },
  { key: 'monthlyB', dbColumn: 'monthly_b_stage', label: '月足B', weight: 0.4 },
] as const

export type SectorStructureAxisKey = (typeof SECTOR_STRUCTURE_AXES)[number]['key']
export type SectorStructureTaxonomy = '17' | '33' | 'major' | 'subIndustry'

export type AxisStructureSummary = {
  validCount: number
  stages: Record<StageLevel, number>
  strength: number | null
  improving: number
  deteriorating: number
  stable: number
  jumpImproving: number
  jumpDeteriorating: number
  changeScore: number
}

export type GroupStructureSummary = {
  nStocks: number
  validStageCount: number
  strengthScore: number | null
  transitionChangeScore: number
  improvingCount: number
  deterioratingCount: number
  stableCount: number
  axes: Record<SectorStructureAxisKey, AxisStructureSummary>
}

export type GroupStageInput = {
  stages: Partial<Record<SectorStructureAxisKey, number | null>>
  previousStages: Partial<Record<SectorStructureAxisKey, number | null>>
}

function emptyAxisSummary(): AxisStructureSummary {
  return {
    validCount: 0,
    stages: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
    strength: null,
    improving: 0,
    deteriorating: 0,
    stable: 0,
    jumpImproving: 0,
    jumpDeteriorating: 0,
    changeScore: 0,
  }
}

export function calculateGroupStructure(inputs: GroupStageInput[]): GroupStructureSummary {
  const axes = Object.fromEntries(
    SECTOR_STRUCTURE_AXES.map((axis) => [axis.key, emptyAxisSummary()]),
  ) as Record<SectorStructureAxisKey, AxisStructureSummary>

  for (const input of inputs) {
    for (const axis of SECTOR_STRUCTURE_AXES) {
      const summary = axes[axis.key]
      const stage = input.stages[axis.key] ?? null
      if (isStage(stage)) {
        summary.validCount += 1
        summary.stages[stage] += 1
      }

      const direction = getStageTransitionDirection(input.previousStages[axis.key] ?? null, stage ?? null)
      if (direction === 'improve') summary.improving += 1
      if (direction === 'jump_improve') {
        summary.improving += 1
        summary.jumpImproving += 1
      }
      if (direction === 'deteriorate') summary.deteriorating += 1
      if (direction === 'jump_deteriorate') {
        summary.deteriorating += 1
        summary.jumpDeteriorating += 1
      }
      if (direction === 'stable') summary.stable += 1
    }
  }

  let weightedStrength = 0
  let strengthWeight = 0
  let weightedChange = 0
  let changeWeight = 0
  let validStageCount = 0
  let improvingCount = 0
  let deterioratingCount = 0
  let stableCount = 0

  for (const axis of SECTOR_STRUCTURE_AXES) {
    const summary = axes[axis.key]
    validStageCount += summary.validCount
    improvingCount += summary.improving
    deterioratingCount += summary.deteriorating
    stableCount += summary.stable
    if (summary.validCount > 0) {
      const strengthTotal = (Object.entries(summary.stages) as Array<[string, number]>).reduce(
        (sum, [stage, count]) => sum + STAGE_STRUCTURE_STRENGTH[Number(stage) as StageLevel] * count,
        0,
      )
      summary.strength = strengthTotal / summary.validCount
      weightedStrength += summary.strength * axis.weight
      strengthWeight += axis.weight
    }
    const transitionTotal = summary.improving + summary.deteriorating + summary.stable
    if (transitionTotal > 0) {
      // improving / deteriorating には大幅遷移も既に含めている。
      // jump* を再加算すると変化量を二重計上して ±100 を超えるため、
      // 正本である遷移方向の件数だけで変化モメンタムを集約する。
      summary.changeScore = 100 * ((summary.improving - summary.deteriorating) / transitionTotal)
      weightedChange += summary.changeScore * axis.weight
      changeWeight += axis.weight
    }
  }

  return {
    nStocks: inputs.length,
    validStageCount,
    strengthScore: strengthWeight > 0 ? weightedStrength / strengthWeight : null,
    transitionChangeScore: changeWeight > 0 ? weightedChange / changeWeight : 0,
    improvingCount,
    deterioratingCount,
    stableCount,
    axes,
  }
}

export function propagationFromAxisMomentum(
  axisMomentum: Partial<Record<SectorStructureAxisKey, number | null | undefined>>,
): { direction: 'improving' | 'deteriorating' | 'neutral'; phase: number; label: string } {
  const signs = SECTOR_STRUCTURE_AXES.map((axis) => {
    const value = axisMomentum[axis.key] ?? 0
    return value > 0.0001 ? 1 : value < -0.0001 ? -1 : 0
  })
  const total = signs.reduce<number>((sum, value) => sum + value, 0)
  const direction = total > 0 ? 'improving' : total < 0 ? 'deteriorating' : 'neutral'
  const target = direction === 'improving' ? 1 : direction === 'deteriorating' ? -1 : 0
  let phase = 0
  if (target !== 0) {
    for (const sign of signs) {
      if (sign !== target) break
      phase += 1
    }
  }
  const reached = phase > 0
    ? SECTOR_STRUCTURE_AXES.slice(0, phase).map((axis) => axis.label).join(' → ')
    : ''
  return {
    direction,
    phase,
    label: reached
      ? `${direction === 'improving' ? '改善' : '悪化'}波及: ${reached}`
      : direction === 'improving'
        ? '改善は散発的'
        : direction === 'deteriorating'
          ? '悪化は散発的'
          : '構造変化は中立',
  }
}

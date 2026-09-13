import { isStage, STAGE_STRUCTURE_STRENGTH } from '@/lib/hex-stage'
import { SECTOR_STRUCTURE_AXES, type SectorStructureAxisKey } from '@/lib/sector-structure'
import type { TriggerStatus } from '@/lib/trigger-discovery-engine'

export const TRIGGER_SCORE_VERSION = 1

export interface TriggerScoreConfig {
  weights: {
    proximity: number
    approach: number
    maTrend: number
    stageStructure: number
    liquidity: number
  }
  approachVelocityCapPctPointsPerSession: number
  inZoneApproachFloorRatio: number
  maSlopeCapPct: number
  maTrendWeakestLinkWeight: number
  liquidityFloorYen: number
  liquidityCapYen: number
  missingStageNeutralStrength: number
}

export const DEFAULT_TRIGGER_SCORE_CONFIG: Readonly<TriggerScoreConfig> = Object.freeze({
  weights: Object.freeze({
    proximity: 30,
    approach: 20,
    maTrend: 20,
    stageStructure: 20,
    liquidity: 10,
  }),
  approachVelocityCapPctPointsPerSession: 0.5,
  inZoneApproachFloorRatio: 0.5,
  maSlopeCapPct: 2,
  maTrendWeakestLinkWeight: 0.6,
  liquidityFloorYen: 1_000_000,
  liquidityCapYen: 1_000_000_000,
  missingStageNeutralStrength: 50,
})

export interface TriggerScoreStages {
  dayAStage: number | null
  dayBStage: number | null
  weekAStage: number | null
  weekBStage: number | null
  monthAStage: number | null
  monthBStage: number | null
}

export interface TriggerScoreInput extends TriggerScoreStages {
  triggerStatus: TriggerStatus
  fromAbove: boolean
  zoneDistancePct: number
  maxApproachDistancePct: number
  approachVelocityPctPointsPerSession: number
  ma1SlopePct: number
  ma2SlopePct: number
  averageTradingValue: number | null
}

export interface TriggerScoreBreakdown {
  proximity: number
  approach: number
  maTrend: number
  stageStructure: number
  liquidity: number
  total: number
  stageCoverage: number
  stageAvailableAxes: number
  maximums: TriggerScoreConfig['weights']
  explanations: {
    proximity: string
    approach: string
    maTrend: string
    stageStructure: string
    liquidity: string
  }
}

export interface TriggerScoreResult {
  totalScore: number
  scoreBreakdown: TriggerScoreBreakdown
}

const STAGE_AXES: ReadonlyArray<{
  key: keyof TriggerScoreStages
  structureKey: SectorStructureAxisKey
}> = [
  { key: 'dayAStage', structureKey: 'dailyA' },
  { key: 'dayBStage', structureKey: 'dailyB' },
  { key: 'weekAStage', structureKey: 'weeklyA' },
  { key: 'weekBStage', structureKey: 'weeklyB' },
  { key: 'monthAStage', structureKey: 'monthlyA' },
  { key: 'monthBStage', structureKey: 'monthlyB' },
]

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value))
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function stageAxisWeight(structureKey: SectorStructureAxisKey): number {
  return SECTOR_STRUCTURE_AXES.find((axis) => axis.key === structureKey)?.weight ?? 0
}

export function calculateTriggerProximityScore(
  input: Pick<TriggerScoreInput, 'triggerStatus' | 'zoneDistancePct' | 'maxApproachDistancePct'>,
  config: TriggerScoreConfig = DEFAULT_TRIGGER_SCORE_CONFIG,
): number {
  if (input.triggerStatus === 'BELOW_ZONE') return 0
  if (input.triggerStatus === 'IN_ZONE') return config.weights.proximity
  if (!finite(input.zoneDistancePct) || input.maxApproachDistancePct <= 0) return 0
  const ratio = 1 - Math.abs(input.zoneDistancePct) / input.maxApproachDistancePct
  return rounded(config.weights.proximity * clamp(ratio))
}

export function calculateTriggerApproachScore(
  input: Pick<TriggerScoreInput, 'triggerStatus' | 'fromAbove' | 'approachVelocityPctPointsPerSession'>,
  config: TriggerScoreConfig = DEFAULT_TRIGGER_SCORE_CONFIG,
): number {
  if (input.triggerStatus === 'BELOW_ZONE') return 0
  const normalizedVelocity = finite(input.approachVelocityPctPointsPerSession)
    ? clamp(Math.max(0, input.approachVelocityPctPointsPerSession) / config.approachVelocityCapPctPointsPerSession)
    : 0
  const normalized = input.triggerStatus === 'IN_ZONE' && input.fromAbove
    ? Math.max(normalizedVelocity, config.inZoneApproachFloorRatio)
    : normalizedVelocity
  return rounded(config.weights.approach * clamp(normalized))
}

export function calculateTriggerMaTrendScore(
  input: Pick<TriggerScoreInput, 'ma1SlopePct' | 'ma2SlopePct'>,
  config: TriggerScoreConfig = DEFAULT_TRIGGER_SCORE_CONFIG,
): number {
  if (!finite(input.ma1SlopePct) || !finite(input.ma2SlopePct)) return 0
  const ma1 = clamp(Math.max(0, input.ma1SlopePct) / config.maSlopeCapPct)
  const ma2 = clamp(Math.max(0, input.ma2SlopePct) / config.maSlopeCapPct)
  const weakest = Math.min(ma1, ma2)
  const average = (ma1 + ma2) / 2
  const quality = config.maTrendWeakestLinkWeight * weakest
    + (1 - config.maTrendWeakestLinkWeight) * average
  return rounded(config.weights.maTrend * clamp(quality))
}

export function calculateTriggerStageStructureScore(
  stages: TriggerScoreStages,
  config: TriggerScoreConfig = DEFAULT_TRIGGER_SCORE_CONFIG,
): { score: number; coverage: number; availableAxes: number; knownStrength: number | null } {
  const totalWeight = STAGE_AXES.reduce(
    (sum, axis) => sum + stageAxisWeight(axis.structureKey),
    0,
  )
  let availableWeight = 0
  let weightedStrength = 0
  let availableAxes = 0
  for (const axis of STAGE_AXES) {
    const stage = stages[axis.key]
    if (!isStage(stage)) continue
    const weight = stageAxisWeight(axis.structureKey)
    availableAxes += 1
    availableWeight += weight
    weightedStrength += STAGE_STRUCTURE_STRENGTH[stage] * weight
  }
  const coverage = totalWeight > 0 ? availableWeight / totalWeight : 0
  const knownStrength = availableWeight > 0 ? weightedStrength / availableWeight : null
  const effectiveStrength = (knownStrength ?? config.missingStageNeutralStrength) * coverage
    + config.missingStageNeutralStrength * (1 - coverage)
  return {
    score: rounded(config.weights.stageStructure * clamp(effectiveStrength / 100)),
    coverage: rounded(coverage),
    availableAxes,
    knownStrength: knownStrength == null ? null : rounded(knownStrength),
  }
}

export function calculateTriggerLiquidityScore(
  averageTradingValue: number | null,
  config: TriggerScoreConfig = DEFAULT_TRIGGER_SCORE_CONFIG,
): number {
  if (!finite(averageTradingValue) || averageTradingValue <= 0) return 0
  const floor = Math.log10(config.liquidityFloorYen)
  const cap = Math.log10(config.liquidityCapYen)
  const normalized = (Math.log10(averageTradingValue) - floor) / (cap - floor)
  return rounded(config.weights.liquidity * clamp(normalized))
}

function formatTradingValue(value: number | null): string {
  if (!finite(value)) return '平均売買代金未取得'
  if (value >= 100_000_000) return `平均売買代金 ${(value / 100_000_000).toFixed(1)}億円`
  if (value >= 10_000) return `平均売買代金 ${(value / 10_000).toFixed(0)}万円`
  return `平均売買代金 ${Math.round(value).toLocaleString('ja-JP')}円`
}

export function calculateTriggerScore(
  input: TriggerScoreInput,
  config: TriggerScoreConfig = DEFAULT_TRIGGER_SCORE_CONFIG,
): TriggerScoreResult {
  const proximity = calculateTriggerProximityScore(input, config)
  const approach = calculateTriggerApproachScore(input, config)
  const maTrend = calculateTriggerMaTrendScore(input, config)
  const stage = calculateTriggerStageStructureScore(input, config)
  const liquidity = calculateTriggerLiquidityScore(input.averageTradingValue, config)
  const total = rounded(proximity + approach + maTrend + stage.score + liquidity)
  const proximityText = input.triggerStatus === 'IN_ZONE'
    ? 'Trigger Zone内'
    : `Zoneまで ${Math.abs(input.zoneDistancePct).toFixed(2)}%`
  const approachText = input.triggerStatus === 'IN_ZONE' && input.fromAbove && input.approachVelocityPctPointsPerSession <= 0
    ? '上からZoneへ到達済み'
    : `接近速度 ${input.approachVelocityPctPointsPerSession.toFixed(3)}pt/観測`
  const stageText = stage.availableAxes === 0
    ? 'Stage未取得（中立扱い）'
    : `Stage ${stage.availableAxes}/6軸・既知構造強度 ${stage.knownStrength?.toFixed(0)}`
  return {
    totalScore: total,
    scoreBreakdown: {
      proximity,
      approach,
      maTrend,
      stageStructure: stage.score,
      liquidity,
      total,
      stageCoverage: stage.coverage,
      stageAvailableAxes: stage.availableAxes,
      maximums: { ...config.weights },
      explanations: {
        proximity: proximityText,
        approach: approachText,
        maTrend: `MA上向き度 ${input.ma1SlopePct.toFixed(2)}% / ${input.ma2SlopePct.toFixed(2)}%`,
        stageStructure: stageText,
        liquidity: formatTradingValue(input.averageTradingValue),
      },
    },
  }
}

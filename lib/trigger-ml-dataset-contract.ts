import type { TriggerStatus } from '@/lib/trigger-discovery-engine'
import type { TriggerOutcomeAvailability, TriggerOutcomeHorizon } from '@/lib/trigger-discovery-outcome-contract'
import type { TriggerPathZonePosition } from '@/lib/trigger-path-contract'

export const TRIGGER_ML_FEATURE_SCHEMA_VERSION = 1 as const
export const TRIGGER_ML_LABEL_SCHEMA_VERSION = 1 as const
export const TRIGGER_ML_CHECKPOINTS = ['D0', 'D3', 'D5', 'D10', 'D20', 'LOWER_RECLAIM', 'UPPER_RECLAIM'] as const
export type TriggerMlCheckpoint = typeof TRIGGER_ML_CHECKPOINTS[number]
export type TriggerMlStage = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'UNKNOWN'
export type TriggerMlSplit = 'TRAIN' | 'VALIDATION' | 'TEST'
export type TriggerMlHorizonKey = '20' | '60' | '120' | '245'

export interface TriggerEventFeatureSnapshot {
  ticker: string
  eventDate: string
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  ma1Period: number
  ma2Period: number
  anchorPrice: number
  ma1: number
  ma2: number
  ma1Slope: number | null
  ma2Slope: number | null
  bothRising: boolean | null
  zoneUpper: number
  zoneLower: number
  zoneWidthPct: number
  zoneDistancePct: number
  status: TriggerStatus | null
  fromAbove: boolean | null
  approachVelocity: number | null
  scoreWithoutFlowComponent: number
  dayAStage: TriggerMlStage
  dayBStage: TriggerMlStage
  weekAStage: TriggerMlStage
  weekBStage: TriggerMlStage
  monthAStage: TriggerMlStage
  monthBStage: TriggerMlStage
  spreadPct: number | null
  spreadSlope: number | null
  spreadExpansionRatio: number | null
  spreadExpansionPass: boolean | null
  currentBelowZoneDepthPct: number
  atr20: number | null
  zoneWidthNormalizedPosition: number | null
  atrNormalizedZoneDistance: number | null
}

export interface TriggerPathSnapshot {
  returnSinceHit: number | null
  maxUpsideSoFar: number | null
  maxDownsideSoFar: number | null
  deepestZoneUndershootLowSoFar: number | null
  deepestZoneUndershootCloseSoFar: number | null
  timeToDeepestSoFar: number | null
  totalBelowZoneSessionsSoFar: number | null
  longestBelowZoneStreakSoFar: number | null
  hasBreachedZoneLower: boolean | null
  hasReclaimedZoneLower: boolean | null
  hasReclaimedZoneUpper: boolean | null
  sessionsToLowerReclaimIfKnown: number | null
  currentZonePosition: TriggerPathZonePosition | null
  ma1AsOf: number | null
  ma2AsOf: number | null
  ma1SlopeAsOf: number | null
  ma2SlopeAsOf: number | null
  zoneUpperAsOf: number | null
  zoneLowerAsOf: number | null
  zoneWidthPctAsOf: number | null
  spreadPctAsOf: number | null
  spreadSlopeAsOf: number | null
  spreadExpansionRatioAsOf: number | null
  dayAStageAsOf: TriggerMlStage
  dayBStageAsOf: TriggerMlStage
  weekAStageAsOf: TriggerMlStage
  weekBStageAsOf: TriggerMlStage
  monthAStageAsOf: TriggerMlStage
  monthBStageAsOf: TriggerMlStage
  atr20AsOf: number | null
  undershootToZoneWidthSoFar: number | null
  undershootAtrMultipleSoFar: number | null
}

export interface TriggerMlHorizonLabel {
  labelHorizonSessions: TriggerOutcomeHorizon
  labelAnchorDate: string
  labelAvailableDate: string | null
  labelAvailable: boolean
  availability: TriggerOutcomeAvailability
  return: number | null
  mfe: number | null
  mae: number | null
}

export interface TriggerOutcomeLabel {
  primaryBasis: 'SNAPSHOT_FORWARD'
  eventAnchored: TriggerMlHorizonLabel[]
  snapshotForward: TriggerMlHorizonLabel[]
  derivedFromSnapshot: {
    return60Positive: boolean | null
    mfe60Gte10: boolean | null
    mfe60Gte15: boolean | null
    mfe60Gte10AndMae60GteMinus5: boolean | null
  }
}

export interface TriggerMlDatasetRow {
  datasetRowId: string
  eventKey: string
  episodeKey: string | null
  ticker: string
  eventDate: string
  checkpoint: TriggerMlCheckpoint
  featureAsOfDate: string
  sourceObservationDates: string[]
  split: TriggerMlSplit
  /** A training/evaluation consumer must choose the horizon-specific flag and require labelAvailable. */
  purgedByHorizon: Record<TriggerMlHorizonKey, boolean>
  /** Conservative summary for the longest registered horizon. */
  purged: boolean
  eventFeature: TriggerEventFeatureSnapshot
  /** Source audit only; not in the feature registry or model input. Saved Score contains a flow component. */
  sourceAudit: {
    savedScoreAtHit: number
    savedScoreBreakdown: { proximity: number; approach: number; maTrend: number; stageStructure: number; liquidity: number }
  }
  pathSnapshot: TriggerPathSnapshot
  outcomeLabel: TriggerOutcomeLabel
}

export interface TriggerMlFeatureDefinition {
  name: string
  type: 'number' | 'boolean' | 'category'
  availability: 'EVENT' | 'CHECKPOINT'
  source: 'SAVED_EVENT' | 'PIT_PATH' | 'EXACT_STAGE'
  description: string
}

const eventFeatures = [
  'timeframe', 'ma1Period', 'ma2Period', 'anchorPrice', 'ma1', 'ma2', 'ma1Slope', 'ma2Slope',
  'bothRising', 'zoneUpper', 'zoneLower', 'zoneWidthPct', 'zoneDistancePct', 'status',
  'fromAbove', 'approachVelocity', 'scoreWithoutFlowComponent', 'dayAStage', 'dayBStage',
  'weekAStage', 'weekBStage', 'monthAStage', 'monthBStage', 'spreadPct', 'spreadSlope',
  'spreadExpansionRatio', 'spreadExpansionPass', 'currentBelowZoneDepthPct', 'atr20',
  'zoneWidthNormalizedPosition', 'atrNormalizedZoneDistance',
] as const satisfies readonly (keyof TriggerEventFeatureSnapshot)[]
const pathFeatures = [
  'returnSinceHit', 'maxUpsideSoFar', 'maxDownsideSoFar', 'deepestZoneUndershootLowSoFar',
  'deepestZoneUndershootCloseSoFar', 'timeToDeepestSoFar', 'totalBelowZoneSessionsSoFar',
  'longestBelowZoneStreakSoFar', 'hasBreachedZoneLower', 'hasReclaimedZoneLower',
  'hasReclaimedZoneUpper', 'sessionsToLowerReclaimIfKnown', 'currentZonePosition',
  'ma1AsOf', 'ma2AsOf', 'ma1SlopeAsOf', 'ma2SlopeAsOf', 'zoneUpperAsOf', 'zoneLowerAsOf',
  'zoneWidthPctAsOf', 'spreadPctAsOf', 'spreadSlopeAsOf', 'spreadExpansionRatioAsOf',
  'dayAStageAsOf', 'dayBStageAsOf', 'weekAStageAsOf', 'weekBStageAsOf', 'monthAStageAsOf',
  'monthBStageAsOf', 'atr20AsOf', 'undershootToZoneWidthSoFar', 'undershootAtrMultipleSoFar',
] as const satisfies readonly (keyof TriggerPathSnapshot)[]

const categorical = /^(timeframe|status|currentZonePosition|(?:day|week|month)[AB]Stage(?:AsOf)?)$/
const boolean = /^(bothRising|fromAbove|spreadExpansionPass|hasBreachedZoneLower|hasReclaimedZoneLower|hasReclaimedZoneUpper)$/
export const TRIGGER_ML_FEATURE_REGISTRY: readonly TriggerMlFeatureDefinition[] = [
  ...eventFeatures.map((name) => ({ name: `eventFeature.${name}`,
    type: categorical.test(name) ? 'category' as const : boolean.test(name) ? 'boolean' as const : 'number' as const,
    availability: 'EVENT' as const,
    source: /^(ma1Slope|ma2Slope|bothRising|fromAbove|approachVelocity|atr20|atrNormalizedZoneDistance)$/.test(name)
      ? 'PIT_PATH' as const : 'SAVED_EVENT' as const,
    description: `Event当日までに観測された${name}` })),
  ...pathFeatures.map((name) => ({ name: `pathSnapshot.${name}`,
    type: categorical.test(name) ? 'category' as const : boolean.test(name) ? 'boolean' as const : 'number' as const,
    availability: 'CHECKPOINT' as const,
    source: /StageAsOf$/.test(name) ? 'EXACT_STAGE' as const : 'PIT_PATH' as const,
    description: `Checkpointまでに観測された${name}` })),
]

export const TRIGGER_ML_LABEL_REGISTRY = [
  ...[20, 60, 120, 245].flatMap((horizon) => [
  ...(['eventAnchored', 'snapshotForward'] as const).flatMap((basis) =>
    (['return', 'mfe', 'mae'] as const).map((metric) => ({
      name: `outcomeLabel.${basis}.${metric}${horizon}`,
      type: 'number' as const, anchor: basis, horizonSessions: horizon,
      definition: `${metric} over the next ${horizon} market sessions after the ${basis} anchor`,
    }))),
  ]),
  { name: 'outcomeLabel.derivedFromSnapshot.return60Positive', type: 'boolean' as const,
    anchor: 'snapshotForward', horizonSessions: 60, threshold: { return: 0 },
    definition: 'return60 > 0' },
  { name: 'outcomeLabel.derivedFromSnapshot.mfe60Gte10', type: 'boolean' as const,
    anchor: 'snapshotForward', horizonSessions: 60, threshold: { mfe: 0.10 },
    definition: 'mfe60 >= 10%' },
  { name: 'outcomeLabel.derivedFromSnapshot.mfe60Gte15', type: 'boolean' as const,
    anchor: 'snapshotForward', horizonSessions: 60, threshold: { mfe: 0.15 },
    definition: 'mfe60 >= 15%' },
  { name: 'outcomeLabel.derivedFromSnapshot.mfe60Gte10AndMae60GteMinus5', type: 'boolean' as const,
    anchor: 'snapshotForward', horizonSessions: 60, threshold: { mfe: 0.10, mae: -0.05 },
    definition: 'mfe60 >= 10% AND mae60 >= -5%' },
]

export function validateTriggerMlRow(row: TriggerMlDatasetRow): void {
  if (row.purged !== row.purgedByHorizon['245']
    || (['20', '60', '120', '245'] as const).some((horizon) =>
      typeof row.purgedByHorizon[horizon] !== 'boolean')) throw new Error('invalid_purge_contract')
  if (row.sourceObservationDates.some((date) => date > row.featureAsOfDate)) throw new Error('feature_future_leakage')
  if (row.featureAsOfDate < row.eventDate || row.featureAsOfDate !== row.outcomeLabel.snapshotForward[0]?.labelAnchorDate) {
    throw new Error('feature_anchor_mismatch')
  }
  if (Object.keys(row.eventFeature).some((key) => !eventFeatures.includes(key as typeof eventFeatures[number])
    && !['ticker', 'eventDate'].includes(key))) {
    throw new Error('unknown_event_feature')
  }
  if (Object.keys(row.pathSnapshot).some((key) => !pathFeatures.includes(key as typeof pathFeatures[number]))) {
    throw new Error('unknown_path_feature')
  }
  if (TRIGGER_ML_FEATURE_REGISTRY.some((item) => /volume|liquidity|turnover|tradingvalue|future|outcome|mfe\d|mae\d/i.test(item.name))) {
    throw new Error('forbidden_feature_registry_column')
  }
  for (const label of [...row.outcomeLabel.eventAnchored, ...row.outcomeLabel.snapshotForward]) {
    if (label.labelAvailable && (!label.labelAvailableDate || label.labelAvailableDate <= label.labelAnchorDate
      || label.return == null || label.mfe == null || label.mae == null)) {
      throw new Error('invalid_label_availability')
    }
    if (!label.labelAvailable && (label.return != null || label.mfe != null || label.mae != null)) {
      throw new Error('censored_label_has_value')
    }
  }
  const eligible60 = row.outcomeLabel.snapshotForward.find((label) => label.labelHorizonSessions === 60)?.labelAvailable
  if (!eligible60 && Object.values(row.outcomeLabel.derivedFromSnapshot).some((value) => value != null)) {
    throw new Error('censored_classification_has_value')
  }
}

export interface TriggerMlSplitPolicy {
  validationStart: string
  testStart: string
  embargoSessions: number
  episodeAnchor: 'EARLIEST_EVENT_DATE'
  purgeHorizonSessions: 245
}

export interface TriggerMlDatasetManifest {
  datasetId: string
  generatedAt: string
  analysisCutoffDate: string
  sourceHistoricalScanJobId: string
  sourceOutcomeJobId: string
  sourcePathResearchJobId: string
  sourceSha256: { scan: string; outcome: string; path: string }
  featureSchemaVersion: typeof TRIGGER_ML_FEATURE_SCHEMA_VERSION
  labelSchemaVersion: typeof TRIGGER_ML_LABEL_SCHEMA_VERSION
  pathSchemaVersion: string
  checkpoints: readonly TriggerMlCheckpoint[]
  featureColumns: typeof TRIGGER_ML_FEATURE_REGISTRY
  labelColumns: typeof TRIGGER_ML_LABEL_REGISTRY
  rowCount: number
  eventCount: number
  episodeCount: number
  uniqueTickerCount: number
  eventDateMin: string | null
  eventDateMax: string | null
  timeframe: 'MONTHLY' | 'BIWEEKLY'
  ma1Period: number
  ma2Period: number
  sourceFilters: Record<string, unknown>
  sourceUniverseContract: string
  repeatedEventNote: string
  splitPolicy: TriggerMlSplitPolicy
  rowsByCheckpoint: Record<TriggerMlCheckpoint, number>
  labelAvailableByHorizon: Record<string, number>
  evaluationEligibleByHorizonSplit: Record<TriggerMlHorizonKey, Record<TriggerMlSplit, number>>
  splitCounts: Record<TriggerMlSplit, number>
  purgedRows: number
  featureMissingRate: Record<string, number>
  datasetArtifact: { format: 'NDJSON'; location: string; bytes: number }
  datasetSha256: string
  trainingInputPolicy: 'FEATURE_REGISTRY_ONLY'
  performance: Record<string, number>
}

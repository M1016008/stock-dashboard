import { calculateEventOutcome, type OutcomeOhlcvRow } from '@/lib/server/trigger-discovery-outcome-analysis'
import { calculateTriggerPath } from '@/lib/server/trigger-path-calculation'
import { calculateMaZoneSnapshot, DEFAULT_MA_ZONE_TRIGGER_CONFIG, evaluateMaZoneTrigger,
  type MaZoneTriggerConfig } from '@/lib/trigger-discovery-engine'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import { TRIGGER_OUTCOME_HORIZONS, type TriggerOutcomeHorizon, type TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import type { TriggerPathPoint } from '@/lib/trigger-path-contract'
import type { PathResearchRow } from '@/lib/trigger-path-research-contract'
import { TRIGGER_ML_CHECKPOINTS, validateTriggerMlRow,
  type TriggerMlDatasetRow, type TriggerMlCheckpoint, type TriggerMlHorizonLabel,
  type TriggerMlSplit, type TriggerMlSplitPolicy, type TriggerMlStage,
} from '@/lib/trigger-ml-dataset-contract'

export type ExactStageRow = {
  date: string
  daily_a_stage: number | null; daily_b_stage: number | null
  weekly_a_stage: number | null; weekly_b_stage: number | null
  monthly_a_stage: number | null; monthly_b_stage: number | null
}

function stage(value: number | null | undefined): TriggerMlStage {
  return value != null && Number.isInteger(value) && value >= 1 && value <= 6
    ? `S${value}` as TriggerMlStage : 'UNKNOWN'
}

export function splitPolicyFromSessions(sessions: readonly string[], overrides?: Partial<Pick<TriggerMlSplitPolicy,
  'validationStart' | 'testStart' | 'embargoSessions'>>): TriggerMlSplitPolicy {
  if (sessions.length < 3) throw new Error('insufficient_split_sessions')
  const validationStart = overrides?.validationStart ?? sessions[Math.floor(sessions.length * 0.7)]
  const testStart = overrides?.testStart ?? sessions[Math.floor(sessions.length * 0.85)]
  if (!validationStart || !testStart || validationStart <= sessions[0] || testStart <= validationStart
    || testStart > sessions.at(-1)! || !Number.isInteger(overrides?.embargoSessions ?? 0)
    || (overrides?.embargoSessions ?? 0) < 0) throw new Error('invalid_split_policy')
  return { validationStart, testStart, embargoSessions: overrides?.embargoSessions ?? 0,
    episodeAnchor: 'EARLIEST_EVENT_DATE', purgeHorizonSessions: 245 }
}

export function assignEpisodeSplits(rows: readonly { eventKey: string; episodeKey: string | null; eventDate: string }[],
  policy: TriggerMlSplitPolicy): Map<string, TriggerMlSplit> {
  const earliest = new Map<string, string>()
  for (const row of rows) {
    const key = row.episodeKey ?? `event:${row.eventKey}`
    const first = earliest.get(key)
    if (!first || row.eventDate < first) earliest.set(key, row.eventDate)
  }
  return new Map([...earliest].map(([key, date]) => [key, date >= policy.testStart ? 'TEST'
    : date >= policy.validationStart ? 'VALIDATION' : 'TRAIN']))
}

export function shouldPurge(split: TriggerMlSplit, label: TriggerMlHorizonLabel | undefined,
  policy: TriggerMlSplitPolicy, sessions: readonly string[]): boolean {
  if (split === 'TEST') return false
  const boundary = split === 'TRAIN' ? policy.validationStart : policy.testStart
  const boundaryIndex = sessions.indexOf(boundary)
  if (boundaryIndex < 0) throw new Error('split_boundary_not_market_session')
  const embargoBoundary = sessions[Math.max(0, boundaryIndex - policy.embargoSessions)] ?? boundary
  // An unavailable 245-session label is not an evaluation row; do not silently treat it as a complete label.
  return !label?.labelAvailable || label.labelAvailableDate! >= embargoBoundary
}

function outcomeLabels(outcome: TriggerOutcomeRow, anchorDate: string, sessions: readonly string[]): TriggerMlHorizonLabel[] {
  const index = sessions.indexOf(anchorDate)
  return TRIGGER_OUTCOME_HORIZONS.map((horizon) => {
    const available = outcome[`availability${horizon}`] === 'AVAILABLE'
    return {
      labelHorizonSessions: horizon, labelAnchorDate: anchorDate,
      labelAvailableDate: available && index >= 0 ? sessions[index + horizon] ?? null : null,
      labelAvailable: available, availability: outcome[`availability${horizon}`],
      return: available ? outcome[`return${horizon}`] : null,
      mfe: available ? outcome[`mfe${horizon}`] : null,
      mae: available ? outcome[`mae${horizon}`] : null,
    }
  })
}

function forwardLabels(event: TriggerHistoricalScanEvent, anchorDate: string, anchorClose: number | null,
  daily: readonly OutcomeOhlcvRow[], sessions: readonly string[]): TriggerMlHorizonLabel[] {
  if (anchorClose == null || !(anchorClose > 0)) return TRIGGER_OUTCOME_HORIZONS.map((horizon) => ({
    labelHorizonSessions: horizon, labelAnchorDate: anchorDate, labelAvailableDate: null,
    labelAvailable: false, availability: 'ANCHOR_SESSION_NOT_FOUND', return: null, mfe: null, mae: null,
  }))
  // Existing Outcome semantics: the anchor day is excluded from forward MFE/MAE.
  const result = calculateEventOutcome({ ...event, date: anchorDate, price: anchorClose }, daily,
    TRIGGER_OUTCOME_HORIZONS, sessions)
  return outcomeLabels(result, anchorDate, sessions)
}

function observation(input: readonly TriggerPathPoint[], date: string, config: MaZoneTriggerConfig) {
  const rows = input.filter((point) => point.date <= date && point.ma1 != null && point.ma2 != null)
    .map((point) => ({ date: point.date, price: point.close, ma1: point.ma1!, ma2: point.ma2! }))
  return evaluateMaZoneTrigger({ observations: rows, asOf: date, config })
}

export function buildMlRowsForEvent(input: {
  datasetId: string
  row: PathResearchRow
  event: TriggerHistoricalScanEvent
  series: readonly TriggerPathPoint[]
  daily: readonly OutcomeOhlcvRow[]
  marketSessions: readonly string[]
  stages: ReadonlyMap<string, ExactStageRow>
  config: MaZoneTriggerConfig
  split: TriggerMlSplit
  splitPolicy: TriggerMlSplitPolicy
  analysisCutoffDate: string
  timing?: { pathSnapshotMs: number; labelGenerationMs: number }
}): TriggerMlDatasetRow[] {
  const { event, row, series, marketSessions: sessions } = input
  const eventIndex = sessions.indexOf(event.date)
  if (eventIndex < 0) throw new Error('event_not_market_session')
  const eventSourceDates = [event.priceDate, event.maDate, event.stageDate, event.spreadDiagnosticDate]
    .filter((date): date is string => !!date)
  if (eventSourceDates.some((date) => date > event.date)) throw new Error('saved_event_future_source')
  const hitPoint = series.find((point) => point.date === event.date)
  const atHit = observation(series, event.maDate, input.config)
  const upper = Math.max(event.ma1, event.ma2)
  const lower = Math.min(event.ma1, event.ma2)
  const score = event.scoreBreakdown
  const sourceScore = event.triggerScore
  const eventFeature: TriggerMlDatasetRow['eventFeature'] = {
    ticker: row.ticker, eventDate: event.date, timeframe: row.timeframe,
    ma1Period: row.ma1Period, ma2Period: row.ma2Period, anchorPrice: event.price,
    ma1: event.ma1, ma2: event.ma2,
    ma1Slope: atHit.availability === 'available' ? atHit.ma1SlopePct : null,
    ma2Slope: atHit.availability === 'available' ? atHit.ma2SlopePct : null,
    bothRising: atHit.availability === 'available' ? atHit.bothRising : null,
    zoneUpper: upper, zoneLower: lower, zoneWidthPct: (upper / lower - 1) * 100,
    zoneDistancePct: event.zoneDistancePct, status: event.currentStatus,
    fromAbove: atHit.availability === 'available' ? atHit.fromAbove : null,
    approachVelocity: atHit.availability === 'available' ? atHit.approachVelocityPctPointsPerSession : null,
    scoreWithoutFlowComponent: score.proximity + score.approach + score.maTrend + score.stageStructure,
    dayAStage: stage(event.dayAStage), dayBStage: stage(event.dayBStage),
    weekAStage: stage(event.weekAStage), weekBStage: stage(event.weekBStage),
    monthAStage: stage(event.monthAStage), monthBStage: stage(event.monthBStage),
    spreadPct: event.maSpreadPct ?? null, spreadSlope: event.maSpreadSlope ?? null,
    spreadExpansionRatio: event.maSpreadExpansionRatio ?? null,
    spreadExpansionPass: event.spreadExpansionPass ?? null,
    currentBelowZoneDepthPct: event.price < lower ? (1 - event.price / lower) * 100 : 0,
    atr20: hitPoint?.atr20 ?? null,
    zoneWidthNormalizedPosition: upper > lower ? (event.price - lower) / (upper - lower) : null,
    atrNormalizedZoneDistance: hitPoint?.atr20 && hitPoint.atr20 > 0
      ? (event.price - upper) / hitPoint.atr20 : null,
  }
  const reclaim = row.pathProfile
  const dates = new Map<TriggerMlCheckpoint, string>()
  for (const [checkpoint, offset] of [['D0', 0], ['D3', 3], ['D5', 5], ['D10', 10], ['D20', 20]] as const) {
    const date = sessions[eventIndex + offset]
    if (date && date <= input.analysisCutoffDate) dates.set(checkpoint, date)
  }
  if (reclaim?.firstZoneLowerReclaimDate && reclaim.firstZoneLowerReclaimDate <= input.analysisCutoffDate) {
    dates.set('LOWER_RECLAIM', reclaim.firstZoneLowerReclaimDate)
  }
  if (reclaim?.firstZoneUpperReclaimDate && reclaim.firstZoneUpperReclaimDate <= input.analysisCutoffDate) {
    dates.set('UPPER_RECLAIM', reclaim.firstZoneUpperReclaimDate)
  }
  const result: TriggerMlDatasetRow[] = []
  for (const checkpoint of TRIGGER_ML_CHECKPOINTS) {
    const date = dates.get(checkpoint)
    if (!date) continue
    const point = series.find((item) => item.date === date)
    if (checkpoint !== 'D0' && !point) continue
    const known = series.filter((item) => item.date <= date)
    const asOfSessions = sessions.slice(eventIndex).filter((item) => item <= date)
    const pathStarted = performance.now()
    const asOfProfile = checkpoint !== 'D0' && row.pathStatus === 'AVAILABLE'
      ? calculateTriggerPath({ eventKey: row.eventKey, event, timeframe: row.timeframe,
        ma1Period: row.ma1Period, ma2Period: row.ma2Period, analysisCutoffDate: date,
        marketSessions: asOfSessions, points: known }) : null
    const knownStage = checkpoint === 'D0' ? null : input.stages.get(date)
    const evaluation = point?.ma1 != null && point.ma2 != null
      ? observation(known, date, input.config) : null
    const snapshot = point?.ma1 != null && point.ma2 != null
      ? calculateMaZoneSnapshot(point.close, point.ma1, point.ma2) : null
    const window = asOfProfile
    const observedAtEvent = checkpoint === 'D0' && hitPoint != null
    const pathSnapshot: TriggerMlDatasetRow['pathSnapshot'] = {
      returnSinceHit: point ? point.close / event.price - 1 : null,
      maxUpsideSoFar: window?.maxUpsideToDate ?? null,
      maxDownsideSoFar: window?.maxDownsideToDate ?? null,
      deepestZoneUndershootLowSoFar: window?.maxZoneUndershootLowPct ?? null,
      deepestZoneUndershootCloseSoFar: window?.maxZoneUndershootClosePct ?? null,
      timeToDeepestSoFar: window?.tradingSessionsToDeepest ?? null,
      totalBelowZoneSessionsSoFar: window?.totalBelowZoneSessions ?? (observedAtEvent ? 0 : null),
      longestBelowZoneStreakSoFar: window?.longestConsecutiveBelowZoneSessions ?? (observedAtEvent ? 0 : null),
      hasBreachedZoneLower: window?.breachedZoneLower ?? (observedAtEvent ? false : null),
      hasReclaimedZoneLower: window ? window.firstZoneLowerReclaimDate != null : observedAtEvent ? false : null,
      hasReclaimedZoneUpper: window ? window.firstZoneUpperReclaimDate != null : observedAtEvent ? false : null,
      sessionsToLowerReclaimIfKnown: window?.sessionsFromHitToLowerReclaim ?? null,
      currentZonePosition: snapshot?.pricePosition ?? null,
      ma1AsOf: point?.ma1 ?? null, ma2AsOf: point?.ma2 ?? null,
      ma1SlopeAsOf: evaluation?.availability === 'available' ? evaluation.ma1SlopePct : null,
      ma2SlopeAsOf: evaluation?.availability === 'available' ? evaluation.ma2SlopePct : null,
      zoneUpperAsOf: snapshot?.zoneUpper ?? null, zoneLowerAsOf: snapshot?.zoneLower ?? null,
      zoneWidthPctAsOf: snapshot ? (snapshot.zoneUpper / snapshot.zoneLower - 1) * 100 : null,
      spreadPctAsOf: evaluation?.availability === 'available' ? evaluation.maSpreadPct : null,
      spreadSlopeAsOf: evaluation?.availability === 'available' ? evaluation.maSpreadSlope : null,
      spreadExpansionRatioAsOf: evaluation?.availability === 'available' ? evaluation.maSpreadExpansionRatio : null,
      dayAStageAsOf: checkpoint === 'D0' ? eventFeature.dayAStage : stage(knownStage?.daily_a_stage),
      dayBStageAsOf: checkpoint === 'D0' ? eventFeature.dayBStage : stage(knownStage?.daily_b_stage),
      weekAStageAsOf: checkpoint === 'D0' ? eventFeature.weekAStage : stage(knownStage?.weekly_a_stage),
      weekBStageAsOf: checkpoint === 'D0' ? eventFeature.weekBStage : stage(knownStage?.weekly_b_stage),
      monthAStageAsOf: checkpoint === 'D0' ? eventFeature.monthAStage : stage(knownStage?.monthly_a_stage),
      monthBStageAsOf: checkpoint === 'D0' ? eventFeature.monthBStage : stage(knownStage?.monthly_b_stage),
      atr20AsOf: point?.atr20 ?? null,
      undershootToZoneWidthSoFar: window?.undershootToZoneWidthRatio ?? null,
      undershootAtrMultipleSoFar: window?.undershootAtrMultiple ?? null,
    }
    const sourceObservationDates = [...eventSourceDates, ...known.map((item) => item.date),
      ...(knownStage ? [knownStage.date] : [])]
    if (input.timing) input.timing.pathSnapshotMs += performance.now() - pathStarted
    const labelStarted = performance.now()
    const forward = forwardLabels(event, date, point?.close ?? null, input.daily, sessions)
    const sixty = forward.find((label) => label.labelHorizonSessions === 60)
    const labels = {
      primaryBasis: 'SNAPSHOT_FORWARD' as const,
      eventAnchored: outcomeLabels(row.outcome, event.date, sessions),
      snapshotForward: forward,
      derivedFromSnapshot: {
        return60Positive: sixty?.labelAvailable ? sixty.return! > 0 : null,
        mfe60Gte10: sixty?.labelAvailable ? sixty.mfe! >= 0.10 : null,
        mfe60Gte15: sixty?.labelAvailable ? sixty.mfe! >= 0.15 : null,
        mfe60Gte10AndMae60GteMinus5: sixty?.labelAvailable
          ? sixty.mfe! >= 0.10 && sixty.mae! >= -0.05 : null,
      },
    }
    if (input.timing) input.timing.labelGenerationMs += performance.now() - labelStarted
    const mlRow: TriggerMlDatasetRow = {
      datasetRowId: `${input.datasetId}:${row.eventKey}:${checkpoint}`,
      eventKey: row.eventKey, episodeKey: row.episodeKey, ticker: row.ticker,
      eventDate: event.date, checkpoint, featureAsOfDate: date,
      sourceObservationDates: [...new Set(sourceObservationDates)], split: input.split,
      purgedByHorizon: Object.fromEntries(labels.snapshotForward.map((label) => [String(label.labelHorizonSessions),
        shouldPurge(input.split, label, input.splitPolicy, sessions)])) as TriggerMlDatasetRow['purgedByHorizon'],
      purged: false,
      eventFeature,
      sourceAudit: { savedScoreAtHit: sourceScore,
        savedScoreBreakdown: { proximity: score.proximity, approach: score.approach,
          maTrend: score.maTrend, stageStructure: score.stageStructure, liquidity: score.liquidity } },
      pathSnapshot, outcomeLabel: labels,
    }
    mlRow.purged = mlRow.purgedByHorizon[String(input.splitPolicy.purgeHorizonSessions) as '245']
    validateTriggerMlRow(mlRow)
    result.push(mlRow)
  }
  return result
}

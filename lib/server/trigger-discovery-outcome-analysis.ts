import type { TriggerDiscoveryStageFilters } from '@/lib/trigger-discovery-contract'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import {
  TRIGGER_OUTCOME_HORIZONS,
  TRIGGER_OUTCOME_STAGE_AXES,
  type TriggerOutcomeAvailability,
  type TriggerOutcomeEventSelector,
  type TriggerOutcomeHorizon,
  type TriggerOutcomeHorizonSummary,
  type TriggerOutcomeRow,
} from '@/lib/trigger-discovery-outcome-contract'

export interface OutcomeOhlcvRow {
  ticker: string
  date: string
  high: number
  low: number
  close: number
}

export function outcomeEventMatches(input: {
  event: TriggerHistoricalScanEvent
  eventFilter: TriggerOutcomeEventSelector
  ticker: string | null
  triggerScoreMin: number | null
  triggerScoreMax: number | null
  stageFilters: TriggerDiscoveryStageFilters
}): boolean {
  const { event } = input
  if (input.ticker && event.ticker !== input.ticker) return false
  if (input.triggerScoreMin != null && event.triggerScore < input.triggerScoreMin) return false
  if (input.triggerScoreMax != null && event.triggerScore > input.triggerScoreMax) return false
  if (input.eventFilter === 'NEAR_ENTERED'
    && (event.eventType !== 'STATUS_CHANGED' || event.currentStatus !== 'NEAR')) return false
  if (input.eventFilter === 'IN_ZONE_ENTERED'
    && (event.eventType !== 'STATUS_CHANGED' || event.currentStatus !== 'IN_ZONE')) return false
  if (!['ALL', 'NEAR_ENTERED', 'IN_ZONE_ENTERED'].includes(input.eventFilter)
    && event.eventType !== input.eventFilter) return false

  for (const axis of TRIGGER_OUTCOME_STAGE_AXES) {
    const accepted = input.stageFilters[axis]
    if (!accepted || accepted.length === 0) continue
    const stage = event[axis]
    if (!accepted.some((value) => value === 'unknown' ? stage == null : stage === value)) return false
  }
  return true
}

function nullOutcome(
  event: TriggerHistoricalScanEvent,
  availability: TriggerOutcomeAvailability,
): TriggerOutcomeRow {
  return {
    eventDate: event.date,
    ticker: event.ticker,
    companyName: event.companyName,
    eventType: event.eventType,
    previousStatus: event.previousStatus,
    currentStatus: event.currentStatus,
    anchorPrice: event.price,
    triggerScore: event.triggerScore,
    dayAStage: event.dayAStage,
    dayBStage: event.dayBStage,
    weekAStage: event.weekAStage,
    weekBStage: event.weekBStage,
    monthAStage: event.monthAStage,
    monthBStage: event.monthBStage,
    return20: null,
    return60: null,
    return120: null,
    return245: null,
    mfe20: null,
    mfe60: null,
    mfe120: null,
    mfe245: null,
    mae20: null,
    mae60: null,
    mae120: null,
    mae245: null,
    availability20: availability,
    availability60: availability,
    availability120: availability,
    availability245: availability,
  }
}

export function calculateEventOutcome(
  event: TriggerHistoricalScanEvent,
  series: readonly OutcomeOhlcvRow[],
  selectedHorizons: readonly TriggerOutcomeHorizon[] = TRIGGER_OUTCOME_HORIZONS,
  marketSessions: readonly string[] = series.map((row) => row.date),
): TriggerOutcomeRow {
  const markNotRequested = (row: TriggerOutcomeRow): TriggerOutcomeRow => {
    const enabled = new Set(selectedHorizons)
    for (const horizon of TRIGGER_OUTCOME_HORIZONS) {
      if (!enabled.has(horizon)) row[`availability${horizon}`] = 'NOT_REQUESTED'
    }
    return row
  }
  if (!Number.isFinite(event.price) || event.price <= 0) {
    return markNotRequested(nullOutcome(event, 'INVALID_ANCHOR_PRICE'))
  }
  const eventIndex = marketSessions.indexOf(event.date)
  if (eventIndex < 0) return markNotRequested(nullOutcome(event, 'ANCHOR_SESSION_NOT_FOUND'))

  const result = nullOutcome(event, 'INSUFFICIENT_FUTURE_DATA')
  const enabled = new Set(selectedHorizons)
  const priceByDate = new Map(series.map((row) => [row.date, row]))
  for (const horizon of TRIGGER_OUTCOME_HORIZONS) {
    if (!enabled.has(horizon)) {
      result[`availability${horizon}`] = 'NOT_REQUESTED'
      continue
    }
    const futureDates = marketSessions.slice(eventIndex + 1, eventIndex + horizon + 1)
    const horizonDate = marketSessions[eventIndex + horizon]
    const futureWindow = futureDates.map((date) => priceByDate.get(date))
    const horizonRow = horizonDate ? priceByDate.get(horizonDate) : undefined
    if (!horizonRow || futureDates.length !== horizon || futureWindow.length !== horizon
      || futureWindow.some((row) => !row)
      || !Number.isFinite(horizonRow.close)
      || futureWindow.some((row) => !Number.isFinite(row?.high) || !Number.isFinite(row?.low))) continue
    const completeWindow = futureWindow as OutcomeOhlcvRow[]
    const highest = Math.max(...completeWindow.map((row) => row.high))
    const lowest = Math.min(...completeWindow.map((row) => row.low))
    result[`return${horizon}`] = horizonRow.close / event.price - 1
    result[`mfe${horizon}`] = highest / event.price - 1
    result[`mae${horizon}`] = lowest / event.price - 1
    result[`availability${horizon}`] = 'AVAILABLE'
  }
  return result
}

export function outcomeQuantile(values: readonly number[], probability: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower] ?? null
  const fraction = position - lower
  return (sorted[lower] ?? 0) * (1 - fraction) + (sorted[upper] ?? 0) * fraction
}

interface OutcomeHorizonAccumulator {
  eligibleCount: number
  unavailableByReason: Partial<Record<TriggerOutcomeAvailability, number>>
  returns: number[]
  mfe: number[]
  mae: number[]
}

export interface OutcomeSummaryAccumulator {
  rowCount: number
  tickers: Set<string>
  horizons: Map<TriggerOutcomeHorizon, OutcomeHorizonAccumulator>
}

export function createOutcomeSummaryAccumulator(
  horizons: readonly TriggerOutcomeHorizon[],
): OutcomeSummaryAccumulator {
  return {
    rowCount: 0,
    tickers: new Set<string>(),
    horizons: new Map(horizons.map((horizon) => [horizon, {
      eligibleCount: 0,
      unavailableByReason: {},
      returns: [],
      mfe: [],
      mae: [],
    }])),
  }
}

export function addOutcomeRowToSummary(
  accumulator: OutcomeSummaryAccumulator,
  row: TriggerOutcomeRow,
): void {
  accumulator.rowCount += 1
  accumulator.tickers.add(row.ticker)
  for (const [horizon, values] of accumulator.horizons) {
    const availability = row[`availability${horizon}`]
    if (availability !== 'AVAILABLE') {
      values.unavailableByReason[availability] = (values.unavailableByReason[availability] ?? 0) + 1
      continue
    }
    values.eligibleCount += 1
    const outcomeReturn = row[`return${horizon}`]
    const mfe = row[`mfe${horizon}`]
    const mae = row[`mae${horizon}`]
    if (outcomeReturn != null) values.returns.push(outcomeReturn)
    if (mfe != null) values.mfe.push(mfe)
    if (mae != null) values.mae.push(mae)
  }
}

export function finalizeOutcomeSummary(
  accumulator: OutcomeSummaryAccumulator,
): TriggerOutcomeHorizonSummary[] {
  return Array.from(accumulator.horizons, ([horizon, values]) => {
    const unavailableCount = accumulator.rowCount - values.eligibleCount
    return {
      horizonSessions: horizon,
      totalSelectedEvents: accumulator.rowCount,
      eligibleCount: values.eligibleCount,
      unavailableCount,
      censoredCount: values.unavailableByReason.INSUFFICIENT_FUTURE_DATA ?? 0,
      unavailableByReason: values.unavailableByReason,
      meanReturn: values.returns.length > 0
        ? values.returns.reduce((sum, value) => sum + value, 0) / values.returns.length
        : null,
      medianReturn: outcomeQuantile(values.returns, 0.5),
      positiveReturnRatio: values.returns.length > 0
        ? values.returns.filter((value) => value > 0).length / values.returns.length
        : null,
      p25Return: outcomeQuantile(values.returns, 0.25),
      p75Return: outcomeQuantile(values.returns, 0.75),
      medianMfe: outcomeQuantile(values.mfe, 0.5),
      medianMae: outcomeQuantile(values.mae, 0.5),
    }
  })
}

export function aggregateOutcomeRows(
  rows: readonly TriggerOutcomeRow[],
  horizons: readonly TriggerOutcomeHorizon[],
): TriggerOutcomeHorizonSummary[] {
  const accumulator = createOutcomeSummaryAccumulator(horizons)
  for (const row of rows) addOutcomeRowToSummary(accumulator, row)
  return finalizeOutcomeSummary(accumulator)
}

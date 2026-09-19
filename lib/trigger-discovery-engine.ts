import { regressionSlope } from '@/lib/monthly-ma-monitor'
import { buildContinuousMonthlyMaSeries } from '@/lib/snapshots/continuous-ma'
import { buildContinuousBiweeklyMaSeries } from '@/lib/trigger-discovery-timeframe'
import type { OHLCV } from '@/types/stock'

export const TRIGGER_MA_PERIOD_MIN = 2
export const TRIGGER_MA_PERIOD_MAX = 120
export const TRIGGER_SPREAD_LOOKBACK_INTERVALS_MIN = 2
export const TRIGGER_SPREAD_LOOKBACK_INTERVALS_MAX = 24
export const TRIGGER_MAX_BELOW_ZONE_PCT = 20
export const TRIGGER_ENGINE_VERSION = 1

export type MaTrend = 'RISING' | 'FLAT' | 'FALLING'
export type TriggerPricePosition = 'ABOVE_ZONE' | 'IN_ZONE' | 'BELOW_ZONE'
export type TriggerApproachDirection = 'TOWARD_ZONE' | 'AWAY_FROM_ZONE' | 'FLAT'
export type TriggerStatus = 'NOT_MATCHED' | 'APPROACHING' | 'NEAR' | 'IN_ZONE' | 'BELOW_ZONE'
export type TriggerAvailability = 'available' | 'insufficient_history' | 'invalid_data'

export interface MaZoneTriggerConfig {
  ma1Period: number
  ma2Period: number
  slopeLookbackSessions: number
  approachLookbackSessions: number
  minimumAboveZoneRatio: number
  maxApproachDistancePct: number
  nearDistancePct: number
  slopeTolerancePct: number
  approachVelocityTolerancePctPerSession: number
  numericTolerance: number
  spreadExpansionEnabled: boolean
  spreadLookbackIntervals: number
  minExpansionRatio: number
  requireBullishMaOrder: boolean
  belowZoneToleranceEnabled: boolean
  maxBelowZonePct: number
}

export const DEFAULT_MA_ZONE_TRIGGER_CONFIG: Readonly<MaZoneTriggerConfig> = Object.freeze({
  ma1Period: 20,
  ma2Period: 25,
  slopeLookbackSessions: 20,
  approachLookbackSessions: 20,
  minimumAboveZoneRatio: 0.7,
  maxApproachDistancePct: 5,
  nearDistancePct: 2,
  slopeTolerancePct: 0.01,
  approachVelocityTolerancePctPerSession: 0.001,
  numericTolerance: 1e-9,
  spreadExpansionEnabled: false,
  spreadLookbackIntervals: 4,
  minExpansionRatio: 0.7,
  requireBullishMaOrder: true,
  belowZoneToleranceEnabled: false,
  maxBelowZonePct: 3,
})

export interface MaZoneTriggerObservation {
  date: string
  price: number
  ma1: number
  ma2: number
}

export interface MaSpreadExpansionResult {
  available: boolean
  maSpreadPct: number | null
  maSpreadSlope: number | null
  maSpreadExpansionRatio: number | null
  expandingIntervals: number | null
  bullishMaOrder: boolean
  passed: boolean
}

export function evaluateMaSpreadExpansion(input: {
  observations: readonly MaZoneTriggerObservation[]
  config: Pick<MaZoneTriggerConfig,
    'spreadLookbackIntervals' | 'minExpansionRatio' | 'numericTolerance'
    | 'slopeTolerancePct' | 'requireBullishMaOrder'>
  bothRising: boolean
}): MaSpreadExpansionResult {
  const { observations, config, bothRising } = input
  const count = config.spreadLookbackIntervals + 1
  const spreadRows = observations.slice(-count)
  const available = spreadRows.length === count && spreadRows.every(isValidObservation)
  const current = spreadRows.at(-1)
  const bullishMaOrder = Boolean(current && finitePositive(current.ma1) && finitePositive(current.ma2)
    && current.ma1 - current.ma2 > config.numericTolerance * relativeTolerance(current.ma1, current.ma2))
  if (!available) {
    return { available: false, maSpreadPct: null, maSpreadSlope: null,
      maSpreadExpansionRatio: null, expandingIntervals: null, bullishMaOrder, passed: false }
  }
  const spreadValues = spreadRows.map((row) => ((row.ma1 - row.ma2) / row.ma2) * 100)
  const maSpreadPct = spreadValues.at(-1) ?? null
  const maSpreadSlope = regressionSlope(spreadValues)
  const tolerance = Math.max(config.numericTolerance, config.slopeTolerancePct / config.spreadLookbackIntervals)
  const expandingIntervals = spreadValues.slice(1).filter((value, index) => (
    value - spreadValues[index] > tolerance
  )).length
  const maSpreadExpansionRatio = expandingIntervals / config.spreadLookbackIntervals
  return {
    available: true, maSpreadPct, maSpreadSlope, maSpreadExpansionRatio,
    expandingIntervals, bullishMaOrder,
    passed: bothRising && (!config.requireBullishMaOrder || bullishMaOrder)
      && maSpreadSlope > tolerance
      && maSpreadExpansionRatio + config.numericTolerance >= config.minExpansionRatio,
  }
}

export interface MaZoneSnapshot {
  price: number
  ma1: number
  ma2: number
  zoneUpper: number
  zoneLower: number
  pricePosition: TriggerPricePosition
  ma1DistancePct: number
  ma2DistancePct: number
  zoneDistancePct: number
  absoluteZoneDistancePct: number
}

export interface MaZoneTriggerResult {
  availability: TriggerAvailability
  unavailableReason: 'insufficient_history' | 'invalid_observation' | null
  requestedAsOf: string
  observationDate: string | null
  status: TriggerStatus
  matched: boolean
  ma1Period: number
  ma2Period: number
  ma1Trend: MaTrend | null
  ma2Trend: MaTrend | null
  ma1SlopePct: number | null
  ma2SlopePct: number | null
  bothRising: boolean
  snapshot: MaZoneSnapshot | null
  fromAbove: boolean
  aboveZoneRatio: number | null
  approachDirection: TriggerApproachDirection | null
  approachVelocityPctPointsPerSession: number | null
  maSpreadPct: number | null
  maSpreadSlope: number | null
  maSpreadExpansionRatio: number | null
  maSpreadExpanding: boolean
  bullishMaOrder: boolean
  spreadExpansionAvailable: boolean
  observationsUsed: number
}

export class TriggerConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TriggerConfigError'
  }
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function relativeTolerance(...values: number[]): number {
  return Math.max(1, ...values.map(Math.abs))
}

function validateInteger(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TriggerConfigError(`${name} must be an integer between ${min} and ${max}`)
  }
}

export function validateMaZoneTriggerConfig(config: MaZoneTriggerConfig): void {
  validateInteger('ma1Period', config.ma1Period, TRIGGER_MA_PERIOD_MIN, TRIGGER_MA_PERIOD_MAX)
  validateInteger('ma2Period', config.ma2Period, TRIGGER_MA_PERIOD_MIN, TRIGGER_MA_PERIOD_MAX)
  if (config.ma1Period === config.ma2Period) {
    throw new TriggerConfigError('ma1Period and ma2Period must be different')
  }
  validateInteger('slopeLookbackSessions', config.slopeLookbackSessions, 1, 120)
  validateInteger('approachLookbackSessions', config.approachLookbackSessions, 2, 120)
  validateInteger(
    'spreadLookbackIntervals',
    config.spreadLookbackIntervals,
    TRIGGER_SPREAD_LOOKBACK_INTERVALS_MIN,
    TRIGGER_SPREAD_LOOKBACK_INTERVALS_MAX,
  )
  if (!Number.isFinite(config.minimumAboveZoneRatio)
    || config.minimumAboveZoneRatio < 0
    || config.minimumAboveZoneRatio > 1) {
    throw new TriggerConfigError('minimumAboveZoneRatio must be between 0 and 1')
  }
  if (!Number.isFinite(config.maxApproachDistancePct)
    || config.maxApproachDistancePct < 0
    || config.maxApproachDistancePct > 100) {
    throw new TriggerConfigError('maxApproachDistancePct must be between zero and 100')
  }
  if (!Number.isFinite(config.nearDistancePct)
    || config.nearDistancePct < 0
    || config.nearDistancePct > config.maxApproachDistancePct) {
    throw new TriggerConfigError('nearDistancePct must be between zero and maxApproachDistancePct')
  }
  if (!Number.isFinite(config.minExpansionRatio)
    || config.minExpansionRatio < 0
    || config.minExpansionRatio > 1) {
    throw new TriggerConfigError('minExpansionRatio must be between 0 and 1')
  }
  if (typeof config.spreadExpansionEnabled !== 'boolean') {
    throw new TriggerConfigError('spreadExpansionEnabled must be a boolean')
  }
  if (typeof config.requireBullishMaOrder !== 'boolean') {
    throw new TriggerConfigError('requireBullishMaOrder must be a boolean')
  }
  if (typeof config.belowZoneToleranceEnabled !== 'boolean') {
    throw new TriggerConfigError('belowZoneToleranceEnabled must be a boolean')
  }
  if (!Number.isFinite(config.maxBelowZonePct)
    || config.maxBelowZonePct <= 0 || config.maxBelowZonePct > TRIGGER_MAX_BELOW_ZONE_PCT) {
    throw new TriggerConfigError(`maxBelowZonePct must be greater than zero and at most ${TRIGGER_MAX_BELOW_ZONE_PCT}`)
  }
  for (const [name, value] of [
    ['slopeTolerancePct', config.slopeTolerancePct],
    ['approachVelocityTolerancePctPerSession', config.approachVelocityTolerancePctPerSession],
    ['numericTolerance', config.numericTolerance],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new TriggerConfigError(`${name} must be zero or greater`)
    }
  }
}

export function requiredMaZoneTriggerObservations(config: MaZoneTriggerConfig): number {
  return Math.max(
    config.slopeLookbackSessions,
    config.approachLookbackSessions,
    config.spreadExpansionEnabled ? config.spreadLookbackIntervals : 0,
  ) + 1
}

export function classifyMaTrend(changePct: number, tolerancePct: number): MaTrend {
  if (changePct > tolerancePct) return 'RISING'
  if (changePct < -tolerancePct) return 'FALLING'
  return 'FLAT'
}

export function calculateMaZoneSnapshot(
  price: number,
  ma1: number,
  ma2: number,
  numericTolerance = DEFAULT_MA_ZONE_TRIGGER_CONFIG.numericTolerance,
): MaZoneSnapshot {
  if (![price, ma1, ma2].every(finitePositive)) {
    throw new TypeError('price, ma1 and ma2 must be finite positive numbers')
  }
  const zoneUpper = Math.max(ma1, ma2)
  const zoneLower = Math.min(ma1, ma2)
  const tolerance = numericTolerance * relativeTolerance(price, zoneUpper, zoneLower)
  const pricePosition: TriggerPricePosition = price > zoneUpper + tolerance
    ? 'ABOVE_ZONE'
    : price < zoneLower - tolerance
      ? 'BELOW_ZONE'
      : 'IN_ZONE'
  const zoneDistancePct = pricePosition === 'ABOVE_ZONE'
    ? ((price - zoneUpper) / zoneUpper) * 100
    : pricePosition === 'BELOW_ZONE'
      ? ((price - zoneLower) / zoneLower) * 100
      : 0

  return {
    price,
    ma1,
    ma2,
    zoneUpper,
    zoneLower,
    pricePosition,
    ma1DistancePct: ((price - ma1) / ma1) * 100,
    ma2DistancePct: ((price - ma2) / ma2) * 100,
    zoneDistancePct,
    absoluteZoneDistancePct: Math.abs(zoneDistancePct),
  }
}

function unavailableResult(
  requestedAsOf: string,
  config: MaZoneTriggerConfig,
  availability: Exclude<TriggerAvailability, 'available'>,
  reason: Exclude<MaZoneTriggerResult['unavailableReason'], null>,
  observationsUsed: number,
  observationDate: string | null,
): MaZoneTriggerResult {
  return {
    availability,
    unavailableReason: reason,
    requestedAsOf,
    observationDate,
    status: 'NOT_MATCHED',
    matched: false,
    ma1Period: config.ma1Period,
    ma2Period: config.ma2Period,
    ma1Trend: null,
    ma2Trend: null,
    ma1SlopePct: null,
    ma2SlopePct: null,
    bothRising: false,
    snapshot: null,
    fromAbove: false,
    aboveZoneRatio: null,
    approachDirection: null,
    approachVelocityPctPointsPerSession: null,
    maSpreadPct: null,
    maSpreadSlope: null,
    maSpreadExpansionRatio: null,
    maSpreadExpanding: false,
    bullishMaOrder: false,
    spreadExpansionAvailable: false,
    observationsUsed,
  }
}

function isValidObservation(row: MaZoneTriggerObservation): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(row.date)
    && finitePositive(row.price)
    && finitePositive(row.ma1)
    && finitePositive(row.ma2)
}

export function evaluateMaZoneTrigger(input: {
  observations: MaZoneTriggerObservation[]
  asOf: string
  config?: Partial<MaZoneTriggerConfig>
}): MaZoneTriggerResult {
  const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG, ...input.config }
  validateMaZoneTriggerConfig(config)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)) {
    throw new TriggerConfigError('asOf must use YYYY-MM-DD format')
  }

  const requiredObservations = requiredMaZoneTriggerObservations(config)
  const asOfRows = input.observations
    .filter((row) => row.date <= input.asOf)
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date))
  const recent = asOfRows.slice(-requiredObservations)
  const observationDate = recent.at(-1)?.date ?? null
  if (recent.length < requiredObservations) {
    return unavailableResult(
      input.asOf,
      config,
      'insufficient_history',
      'insufficient_history',
      recent.length,
      observationDate,
    )
  }
  if (!recent.every(isValidObservation)) {
    return unavailableResult(
      input.asOf,
      config,
      'invalid_data',
      'invalid_observation',
      recent.length,
      observationDate,
    )
  }

  const currentIndex = recent.length - 1
  const current = recent[currentIndex]
  const slopeReference = recent[currentIndex - config.slopeLookbackSessions]
  const ma1SlopePct = ((current.ma1 / slopeReference.ma1) - 1) * 100
  const ma2SlopePct = ((current.ma2 / slopeReference.ma2) - 1) * 100
  const ma1Trend = classifyMaTrend(ma1SlopePct, config.slopeTolerancePct)
  const ma2Trend = classifyMaTrend(ma2SlopePct, config.slopeTolerancePct)
  const bothRising = ma1Trend === 'RISING' && ma2Trend === 'RISING'

  const spread = evaluateMaSpreadExpansion({ observations: recent, config, bothRising })
  const { available: spreadExpansionAvailable, maSpreadPct, maSpreadSlope,
    maSpreadExpansionRatio, bullishMaOrder, passed: maSpreadExpanding } = spread
  const spreadConditionPassed = !config.spreadExpansionEnabled || maSpreadExpanding

  const approachRows = recent.slice(-(config.approachLookbackSessions + 1))
  const approachSnapshots = approachRows.map((row) => calculateMaZoneSnapshot(
    row.price,
    row.ma1,
    row.ma2,
    config.numericTolerance,
  ))
  const historyPositions = approachSnapshots.slice(0, -1).map((row) => row.pricePosition)
  const aboveZoneRatio = historyPositions.filter((position) => position === 'ABOVE_ZONE').length
    / historyPositions.length
  const latestNonZonePosition = historyPositions.slice().reverse()
    .find((position) => position !== 'IN_ZONE') ?? null
  const fromAbove = aboveZoneRatio + config.numericTolerance >= config.minimumAboveZoneRatio
    && latestNonZonePosition === 'ABOVE_ZONE'
    && !historyPositions.includes('BELOW_ZONE')

  const approachVelocity = -regressionSlope(
    approachSnapshots.map((row) => row.absoluteZoneDistancePct),
  )
  const approachDirection: TriggerApproachDirection = approachVelocity
    > config.approachVelocityTolerancePctPerSession
    ? 'TOWARD_ZONE'
    : approachVelocity < -config.approachVelocityTolerancePctPerSession
      ? 'AWAY_FROM_ZONE'
      : 'FLAT'
  const snapshot = approachSnapshots.at(-1)!
  const eligibleApproach = bothRising
    && fromAbove
    && approachDirection === 'TOWARD_ZONE'

  let status: TriggerStatus = 'NOT_MATCHED'
  let matched = false
  if (snapshot.pricePosition === 'BELOW_ZONE') {
    status = 'BELOW_ZONE'
    matched = config.belowZoneToleranceEnabled
      && snapshot.zoneDistancePct + config.maxBelowZonePct >= -config.numericTolerance
      && bothRising && fromAbove && spreadConditionPassed
  } else if (snapshot.pricePosition === 'IN_ZONE') {
    status = 'IN_ZONE'
    matched = bothRising && fromAbove && spreadConditionPassed
  } else if (eligibleApproach && snapshot.zoneDistancePct <= config.nearDistancePct + config.numericTolerance) {
    status = 'NEAR'
    matched = spreadConditionPassed
  } else if (eligibleApproach && snapshot.zoneDistancePct <= config.maxApproachDistancePct + config.numericTolerance) {
    status = 'APPROACHING'
    matched = spreadConditionPassed
  }

  return {
    availability: 'available',
    unavailableReason: null,
    requestedAsOf: input.asOf,
    observationDate: current.date,
    status,
    matched,
    ma1Period: config.ma1Period,
    ma2Period: config.ma2Period,
    ma1Trend,
    ma2Trend,
    ma1SlopePct,
    ma2SlopePct,
    bothRising,
    snapshot,
    fromAbove,
    aboveZoneRatio,
    approachDirection,
    approachVelocityPctPointsPerSession: approachVelocity,
    maSpreadPct,
    maSpreadSlope,
    maSpreadExpansionRatio,
    maSpreadExpanding,
    bullishMaOrder,
    spreadExpansionAvailable,
    observationsUsed: recent.length,
  }
}

export function evaluateMonthlyMaPullbackTrigger(input: {
  rows: OHLCV[]
  asOf: string
  config?: Partial<MaZoneTriggerConfig>
}): MaZoneTriggerResult {
  const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG, ...input.config }
  validateMaZoneTriggerConfig(config)
  const source = input.rows.filter((row) => row.date <= input.asOf)
  const monthlySeries = buildContinuousMonthlyMaSeries(source, [config.ma1Period, config.ma2Period])
  const observations = monthlySeries.flatMap((row) => {
    const ma1 = row.values.get(config.ma1Period)
    const ma2 = row.values.get(config.ma2Period)
    return ma1 == null || ma2 == null ? [] : [{ date: row.date, price: row.close, ma1, ma2 }]
  })
  return evaluateMaZoneTrigger({ observations, asOf: input.asOf, config })
}

export function evaluateBiweeklyMaPullbackTrigger(input: {
  rows: OHLCV[]
  asOf: string
  config?: Partial<MaZoneTriggerConfig>
}): MaZoneTriggerResult {
  const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG, ...input.config }
  validateMaZoneTriggerConfig(config)
  const source = input.rows.filter((row) => row.date <= input.asOf)
  const biweeklySeries = buildContinuousBiweeklyMaSeries(
    source,
    [config.ma1Period, config.ma2Period],
  )
  const observations = biweeklySeries.flatMap((row) => {
    const ma1 = row.values.get(config.ma1Period)
    const ma2 = row.values.get(config.ma2Period)
    return ma1 == null || ma2 == null ? [] : [{ date: row.date, price: row.close, ma1, ma2 }]
  })
  return evaluateMaZoneTrigger({ observations, asOf: input.asOf, config })
}

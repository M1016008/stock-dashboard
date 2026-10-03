export const MONTHLY_MA_MONITOR_PERIODS = [3, 5, 10, 15, 20, 25] as const

export type MonthlyMaMonitorPeriod = number
export type MonthlyMaPositionSide = 'above' | 'below' | 'on_line'
export type MonthlyMaApproachDirection = 'above' | 'below' | 'none'
export type MonthlyMaCrossDirection = 'up' | 'down'
export type MonthlyMaPrimaryStatus =
  | 'approaching_above'
  | 'approaching_below'
  | 'contact'
  | 'touch'
  | 'cross_up'
  | 'cross_down'
  | 'watch'

export type MonthlyMaClusterType = 'short_mid' | 'mid' | 'mid_long'

export interface MonthlyMaMonitorConfig {
  contactThresholdPct: number
  regressionSessions: number
  minimumApproachSpeedPctPerDay: number
  minimumShrink5Pct: number
  minimumShrink10Pct: number
  minimumConsistency: number
  minimumSideConsistency: number
  rapidApproachMinDistancePct: number
  rapidApproachMaxDistancePct: number
  rapidApproachMinSpeedPctPerDay: number
  scoring: {
    closenessWeight: number
    movementWeight: number
    eventWeight: number
    closenessZeroAtPct: number
    speedFullScorePctPerDay: number
    shrink5FullScorePct: number
    shrink10FullScorePct: number
  }
}

export const MONTHLY_MA_MONITOR_CONFIG: MonthlyMaMonitorConfig = {
  contactThresholdPct: 2,
  regressionSessions: 5,
  minimumApproachSpeedPctPerDay: 0.05,
  minimumShrink5Pct: 0.25,
  minimumShrink10Pct: 0.5,
  minimumConsistency: 0.4,
  minimumSideConsistency: 0.8,
  rapidApproachMinDistancePct: 3,
  rapidApproachMaxDistancePct: 10,
  rapidApproachMinSpeedPctPerDay: 0.15,
  scoring: {
    closenessWeight: 45,
    movementWeight: 40,
    eventWeight: 15,
    closenessZeroAtPct: 15,
    speedFullScorePctPerDay: 0.75,
    shrink5FullScorePct: 5,
    shrink10FullScorePct: 8,
  },
}

export const MONTHLY_MA_CLUSTER_CONFIG = {
  minimumPeriods: 3,
  spreadThresholdPct: 3,
  strongMinimumPeriods: 4,
} as const

export interface MonthlyMaTargetObservation {
  date: string
  open: number
  high: number
  low: number
  close: number
  targetValue: number
  targetLow?: number
  targetHigh?: number
  eventActive?: boolean
}

export interface MonthlyMaEventState {
  lastTouchDate: string | null
  touchAgeSessions: number | null
  lastCrossDate: string | null
  lastCrossDirection: MonthlyMaCrossDirection | null
  crossAgeSessions: number | null
}

export interface MonthlyMaMonitorPoint extends MonthlyMaEventState {
  date: string
  close: number
  targetValue: number
  targetLow: number
  targetHigh: number
  distancePct: number
  absDistancePct: number
  distance1dPct: number | null
  distance3dPct: number | null
  distance5dPct: number | null
  distance10dPct: number | null
  distance20dPct: number | null
  positionSide: MonthlyMaPositionSide
  isApproaching: boolean
  approachDirection: MonthlyMaApproachDirection
  approachSpeedPctPerDay: number
  approachConsistency: number
  distanceShrink5Pct: number | null
  distanceShrink10Pct: number | null
  isContactDefault: boolean
  isTouch: boolean
  crossDirection: MonthlyMaCrossDirection | null
  primaryStatus: MonthlyMaPrimaryStatus
  closenessScore: number
  movementScore: number
  eventScore: number
  approachScore: number
  isRapidApproach: boolean
}

export interface BuildMonthlyMaSeriesOptions {
  config?: MonthlyMaMonitorConfig
  seed?: MonthlyMaEventState
  emitAfterDate?: string | null
}

export interface MonthlyMaClusterGroup {
  key: string
  periods: number[]
}

export interface MonthlyMaClusterDefinition extends MonthlyMaClusterGroup {
  type: MonthlyMaClusterType
  isStrong: boolean
  bandLow: number
  bandHigh: number
  bandAverage: number
  spreadPct: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function parseBoundedMonitorNumber(
  value: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function targetBounds(observation: MonthlyMaTargetObservation): { low: number; high: number } {
  return {
    low: observation.targetLow ?? observation.targetValue,
    high: observation.targetHigh ?? observation.targetValue,
  }
}

function signedDistancePct(observation: MonthlyMaTargetObservation): number {
  const { low, high } = targetBounds(observation)
  if (observation.close > high) return ((observation.close - high) / observation.targetValue) * 100
  if (observation.close < low) return ((observation.close - low) / observation.targetValue) * 100
  return 0
}

function valueAtLag(values: number[], index: number, lag: number): number | null {
  return index >= lag ? values[index - lag] : null
}

export function regressionSlope(values: number[]): number {
  if (values.length < 2) return 0
  const xMean = (values.length - 1) / 2
  const yMean = values.reduce((sum, value) => sum + value, 0) / values.length
  let numerator = 0
  let denominator = 0
  for (let index = 0; index < values.length; index += 1) {
    numerator += (index - xMean) * (values[index] - yMean)
    denominator += (index - xMean) ** 2
  }
  return denominator === 0 ? 0 : numerator / denominator
}

function positionSide(distance: number): MonthlyMaPositionSide {
  if (Math.abs(distance) < 1e-9) return 'on_line'
  return distance > 0 ? 'above' : 'below'
}

function primaryStatus(args: {
  crossDirection: MonthlyMaCrossDirection | null
  isTouch: boolean
  isApproaching: boolean
  approachDirection: MonthlyMaApproachDirection
  isContact: boolean
}): MonthlyMaPrimaryStatus {
  if (args.crossDirection === 'up') return 'cross_up'
  if (args.crossDirection === 'down') return 'cross_down'
  if (args.isTouch) return 'touch'
  if (args.isApproaching && args.approachDirection === 'above') return 'approaching_above'
  if (args.isApproaching && args.approachDirection === 'below') return 'approaching_below'
  if (args.isContact) return 'contact'
  return 'watch'
}

function recentEventScore(touchAge: number | null, crossAge: number | null, weight: number): number {
  const newestAge = [touchAge, crossAge]
    .filter((value): value is number => value != null)
    .sort((left, right) => left - right)[0]
  if (newestAge == null || newestAge > 10) return 0
  if (newestAge === 0) return weight
  if (newestAge <= 3) return weight * (10 / 15)
  if (newestAge <= 5) return weight * (7 / 15)
  return weight * (4 / 15)
}

export function buildMonthlyMaMonitorSeries(
  source: MonthlyMaTargetObservation[],
  options: BuildMonthlyMaSeriesOptions = {},
): MonthlyMaMonitorPoint[] {
  const config = options.config ?? MONTHLY_MA_MONITOR_CONFIG
  const observations = source
    .filter((row) => {
      const { low, high } = targetBounds(row)
      return row.date
        && Number.isFinite(row.close)
        && Number.isFinite(row.high)
        && Number.isFinite(row.low)
        && Number.isFinite(row.targetValue)
        && row.targetValue > 0
        && Number.isFinite(low)
        && Number.isFinite(high)
        && low > 0
        && high >= low
    })
    .slice()
    .sort((left, right) => left.date.localeCompare(right.date))
  const distances = observations.map(signedDistancePct)
  const absoluteDistances = distances.map(Math.abs)
  const points: MonthlyMaMonitorPoint[] = []
  let state: MonthlyMaEventState = options.seed ?? {
    lastTouchDate: null,
    touchAgeSessions: null,
    lastCrossDate: null,
    lastCrossDirection: null,
    crossAgeSessions: null,
  }

  const emitAfterDate = options.emitAfterDate ?? null
  const firstEventIndex = emitAfterDate
    ? observations.findIndex((row) => row.date > emitAfterDate)
    : 0
  if (emitAfterDate && firstEventIndex < 0) return []

  for (let index = Math.max(0, firstEventIndex); index < observations.length; index += 1) {
    const observation = observations[index]
    const bounds = targetBounds(observation)
    const distance = distances[index]
    const absoluteDistance = absoluteDistances[index]
    const storedDistance = round(distance)
    const storedAbsoluteDistance = Math.abs(storedDistance)
    const side = positionSide(distance)
    const start = Math.max(0, index - config.regressionSessions)
    const recentAbs = absoluteDistances.slice(start, index + 1)
    const recentDistances = distances.slice(start, index + 1)
    const approachSpeed = -regressionSlope(recentAbs)
    const d5 = valueAtLag(distances, index, 5)
    const d10 = valueAtLag(distances, index, 10)
    const shrink5 = d5 == null ? null : Math.abs(d5) - absoluteDistance
    const shrink10 = d10 == null ? null : Math.abs(d10) - absoluteDistance
    let shrinkingSteps = 0
    for (let recentIndex = 1; recentIndex < recentAbs.length; recentIndex += 1) {
      if (recentAbs[recentIndex] < recentAbs[recentIndex - 1]) shrinkingSteps += 1
    }
    const consistency = recentAbs.length > 1 ? shrinkingSteps / (recentAbs.length - 1) : 0
    const matchingSide = side === 'on_line'
      ? 0
      : recentDistances.filter((value) => positionSide(value) === side).length / recentDistances.length
    const enoughTrend = recentAbs.length >= Math.min(4, config.regressionSessions + 1)
    const hasMaterialShrink = (shrink5 != null && shrink5 >= config.minimumShrink5Pct)
      || (shrink10 != null && shrink10 >= config.minimumShrink10Pct)
    const isApproaching = Boolean(
      side !== 'on_line'
      && enoughTrend
      && approachSpeed >= config.minimumApproachSpeedPctPerDay
      && hasMaterialShrink
      && consistency >= config.minimumConsistency
      && matchingSide >= config.minimumSideConsistency,
    )
    const approachDirection: MonthlyMaApproachDirection = !isApproaching
      ? 'none'
      : side === 'above' ? 'above' : 'below'

    const eventActive = observation.eventActive !== false
    const isTouch = eventActive && observation.low <= bounds.high && observation.high >= bounds.low
    const previousDistance = index > 0 ? distances[index - 1] : null
    const previousSide = previousDistance == null ? null : positionSide(previousDistance)
    const previousEventActive = index > 0 && observations[index - 1].eventActive !== false
    const crossDirection: MonthlyMaCrossDirection | null = !eventActive || !previousEventActive || previousDistance == null
      ? null
      : previousSide === 'below' && side === 'above'
        ? 'up'
        : previousSide === 'above' && side === 'below'
          ? 'down'
          : null

    const touchAgeSessions = isTouch
      ? 0
      : state.touchAgeSessions == null ? null : state.touchAgeSessions + 1
    const crossAgeSessions = crossDirection
      ? 0
      : state.crossAgeSessions == null ? null : state.crossAgeSessions + 1
    state = {
      lastTouchDate: isTouch ? observation.date : state.lastTouchDate,
      touchAgeSessions,
      lastCrossDate: crossDirection ? observation.date : state.lastCrossDate,
      lastCrossDirection: crossDirection ?? state.lastCrossDirection,
      crossAgeSessions,
    }

    const { scoring } = config
    const closeness = scoring.closenessWeight
      * clamp(1 - absoluteDistance / scoring.closenessZeroAtPct, 0, 1)
    const speedPart = scoring.movementWeight * 0.5
      * clamp(approachSpeed / scoring.speedFullScorePctPerDay, 0, 1)
    const shrink5Part = scoring.movementWeight * 0.25
      * clamp((shrink5 ?? 0) / scoring.shrink5FullScorePct, 0, 1)
    const shrink10Part = scoring.movementWeight * 0.15
      * clamp((shrink10 ?? 0) / scoring.shrink10FullScorePct, 0, 1)
    const consistencyPart = scoring.movementWeight * 0.1 * consistency
    const movement = speedPart + shrink5Part + shrink10Part + consistencyPart
    const eventScore = recentEventScore(touchAgeSessions, crossAgeSessions, scoring.eventWeight)
    const score = clamp(closeness + movement + eventScore, 0, 100)
    const isContact = storedAbsoluteDistance <= config.contactThresholdPct

    points.push({
      date: observation.date,
      close: round(observation.close),
      targetValue: observation.targetValue,
      targetLow: bounds.low,
      targetHigh: bounds.high,
      distancePct: storedDistance,
      absDistancePct: storedAbsoluteDistance,
      distance1dPct: valueAtLag(distances, index, 1) == null ? null : round(valueAtLag(distances, index, 1)!),
      distance3dPct: valueAtLag(distances, index, 3) == null ? null : round(valueAtLag(distances, index, 3)!),
      distance5dPct: d5 == null ? null : round(d5),
      distance10dPct: d10 == null ? null : round(d10),
      distance20dPct: valueAtLag(distances, index, 20) == null ? null : round(valueAtLag(distances, index, 20)!),
      positionSide: side,
      isApproaching,
      approachDirection,
      approachSpeedPctPerDay: round(approachSpeed),
      approachConsistency: round(consistency),
      distanceShrink5Pct: shrink5 == null ? null : round(shrink5),
      distanceShrink10Pct: shrink10 == null ? null : round(shrink10),
      isContactDefault: isContact,
      isTouch,
      crossDirection,
      ...state,
      primaryStatus: primaryStatus({ crossDirection, isTouch, isApproaching, approachDirection, isContact }),
      closenessScore: round(closeness, 3),
      movementScore: round(movement, 3),
      eventScore: round(eventScore, 3),
      approachScore: round(score, 1),
      isRapidApproach: isApproaching
        && absoluteDistance >= config.rapidApproachMinDistancePct
        && absoluteDistance <= config.rapidApproachMaxDistancePct
        && approachSpeed >= config.rapidApproachMinSpeedPctPerDay,
    })
  }

  return points
}

export function buildMonthlyMaClusterGroups(
  periods: readonly number[] = MONTHLY_MA_MONITOR_PERIODS,
  minimumPeriods: number = MONTHLY_MA_CLUSTER_CONFIG.minimumPeriods,
): MonthlyMaClusterGroup[] {
  const sorted = [...new Set(periods)].sort((left, right) => left - right)
  const groups: MonthlyMaClusterGroup[] = []
  for (let start = 0; start < sorted.length; start += 1) {
    for (let end = start + minimumPeriods; end <= sorted.length; end += 1) {
      const members = sorted.slice(start, end)
      groups.push({ key: members.join('-'), periods: members })
    }
  }
  return groups
}

export function classifyMonthlyMaCluster(periods: number[]): MonthlyMaClusterType {
  if (Math.max(...periods) <= 10) return 'short_mid'
  if (Math.min(...periods) >= 10) return 'mid_long'
  return 'mid'
}

export function describeMonthlyMaCluster(
  group: MonthlyMaClusterGroup,
  values: ReadonlyMap<number, number | null | undefined>,
  spreadThresholdPct: number = MONTHLY_MA_CLUSTER_CONFIG.spreadThresholdPct,
): MonthlyMaClusterDefinition | null {
  const prices = group.periods.map((period) => values.get(period))
  if (prices.some((value) => value == null || !Number.isFinite(value) || value <= 0)) return null
  const finite = prices as number[]
  const bandLow = Math.min(...finite)
  const bandHigh = Math.max(...finite)
  const bandAverage = finite.reduce((sum, value) => sum + value, 0) / finite.length
  const spreadPct = ((bandHigh - bandLow) / bandAverage) * 100
  if (spreadPct > spreadThresholdPct) return null
  return {
    ...group,
    type: classifyMonthlyMaCluster(group.periods),
    isStrong: group.periods.length >= MONTHLY_MA_CLUSTER_CONFIG.strongMinimumPeriods,
    bandLow: round(bandLow),
    bandHigh: round(bandHigh),
    bandAverage: round(bandAverage),
    spreadPct: round(spreadPct),
  }
}

export function findMonthlyMaClusters(
  values: ReadonlyMap<number, number | null | undefined>,
  options: {
    periods?: readonly number[]
    minimumPeriods?: number
    spreadThresholdPct?: number
  } = {},
): MonthlyMaClusterDefinition[] {
  const groups = buildMonthlyMaClusterGroups(
    options.periods ?? MONTHLY_MA_MONITOR_PERIODS,
    options.minimumPeriods ?? MONTHLY_MA_CLUSTER_CONFIG.minimumPeriods,
  )
  const candidates = groups
    .map((group) => describeMonthlyMaCluster(
      group,
      values,
      options.spreadThresholdPct ?? MONTHLY_MA_CLUSTER_CONFIG.spreadThresholdPct,
    ))
    .filter((cluster): cluster is MonthlyMaClusterDefinition => cluster != null)
  return candidates.filter((candidate) => !candidates.some((other) => (
    other.periods.length > candidate.periods.length
    && candidate.periods.every((period) => other.periods.includes(period))
  )))
}

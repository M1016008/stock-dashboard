export const EVENT_PATH_HORIZONS = [5, 10, 15, 20] as const
export const EVENT_PATH_THRESHOLDS = [5, 10, 15, 20] as const
export const EVENT_SMA_PERIODS = [5, 25, 75, 150, 200, 300] as const
export const EVENT_PATH_DISCOVERY_CUTOFF = '2022-12-30' as const

export type EventPathHorizon = typeof EVENT_PATH_HORIZONS[number]
export type EventPathThreshold = typeof EVENT_PATH_THRESHOLDS[number]
export type EventSmaPeriod = typeof EVENT_SMA_PERIODS[number]
export type EventResearchDirection = 'LONG' | 'SHORT'
export type HitOrder = 'FAVORABLE_FIRST' | 'ADVERSE_FIRST' | 'SAME_SESSION'
  | 'FAVORABLE_ONLY' | 'ADVERSE_ONLY' | 'NEITHER'

export type EventPriceBar = {
  date: string
  open: number
  high: number
  low: number
  close: number
}

export type DailyExcursionPoint = {
  day: number
  upReturn: number
  downReturn: number
}

export type ThresholdDays = Record<EventPathThreshold, number | null>

export type RawEventHorizon = {
  horizonSessions: EventPathHorizon
  exitDate: string
  closeReturn: number
  mfe: number
  mae: number
  highestDay: number
  lowestDay: number
  firstUpDay: ThresholdDays
  firstDownDay: ThresholdDays
}

export type EventPathEvaluation = {
  entryDate: string | null
  entryOpen: number | null
  maximumObservedExitDate: string | null
  dailyExcursions: DailyExcursionPoint[]
  completedHorizons: RawEventHorizon[]
  missingHorizons: EventPathHorizon[]
  termination: 'COMPLETE' | 'MISSING_ENTRY' | 'INVALID_PRICE' | 'RIGHT_CENSORED'
}

export type DirectionalEventHorizon = {
  direction: EventResearchDirection
  horizonSessions: EventPathHorizon
  exitDate: string
  priceReturn: number
  mfe: number
  mae: number
  favorableDay: number
  adverseDay: number
  firstFavorableDay: ThresholdDays
  firstAdverseDay: ThresholdDays
  hitOrder: Record<EventPathThreshold, HitOrder>
}

function emptyThresholdDays(): ThresholdDays {
  return { 5: null, 10: null, 15: null, 20: null }
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function assertIsoDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid ${field}`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid ${field}`)
  }
}

function hitOrder(favorable: number | null, adverse: number | null): HitOrder {
  if (favorable != null && adverse != null) {
    return favorable === adverse ? 'SAME_SESSION' : favorable < adverse ? 'FAVORABLE_FIRST' : 'ADVERSE_FIRST'
  }
  if (favorable != null) return 'FAVORABLE_ONLY'
  if (adverse != null) return 'ADVERSE_ONLY'
  return 'NEITHER'
}

export function evaluateEventPricePath(
  prices: readonly EventPriceBar[],
  signalIndex: number,
): EventPathEvaluation {
  const entry = prices[signalIndex + 1]
  if (!entry) {
    return {
      entryDate: null,
      entryOpen: null,
      maximumObservedExitDate: null,
      dailyExcursions: [],
      completedHorizons: [],
      missingHorizons: [...EVENT_PATH_HORIZONS],
      termination: 'MISSING_ENTRY',
    }
  }
  assertIsoDate(entry.date, 'entry date')
  if (entry.date > EVENT_PATH_DISCOVERY_CUTOFF) {
    return {
      entryDate: null,
      entryOpen: null,
      maximumObservedExitDate: null,
      dailyExcursions: [],
      completedHorizons: [],
      missingHorizons: [...EVENT_PATH_HORIZONS],
      termination: 'RIGHT_CENSORED',
    }
  }
  if (!finitePositive(entry.open)) {
    return {
      entryDate: entry.date,
      entryOpen: null,
      maximumObservedExitDate: null,
      dailyExcursions: [],
      completedHorizons: [],
      missingHorizons: [...EVENT_PATH_HORIZONS],
      termination: 'INVALID_PRICE',
    }
  }

  const firstUpDay = emptyThresholdDays()
  const firstDownDay = emptyThresholdDays()
  const completedHorizons: RawEventHorizon[] = []
  const dailyExcursions: DailyExcursionPoint[] = []
  let highest = Number.NEGATIVE_INFINITY
  let lowest = Number.POSITIVE_INFINITY
  let highestDay = 0
  let lowestDay = 0
  let invalidPrice = false
  let maximumObservedExitDate: string | null = null
  let previousDate = prices[signalIndex]?.date ?? null
  if (previousDate != null) assertIsoDate(previousDate, 'signal date')

  for (let day = 1; day <= 20; day += 1) {
    const bar = prices[signalIndex + day]
    if (!bar) break
    assertIsoDate(bar.date, 'outcome date')
    if (previousDate != null && bar.date <= previousDate) throw new Error('price dates must be strictly increasing')
    if (bar.date > EVENT_PATH_DISCOVERY_CUTOFF) break
    maximumObservedExitDate = bar.date
    previousDate = bar.date
    if (!finitePositive(bar.high) || !finitePositive(bar.low) || !finitePositive(bar.close)) {
      invalidPrice = true
      break
    }
    dailyExcursions.push({
      day,
      upReturn: bar.high / entry.open - 1,
      downReturn: bar.low / entry.open - 1,
    })
    if (bar.high > highest) {
      highest = bar.high
      highestDay = day
    }
    if (bar.low < lowest) {
      lowest = bar.low
      lowestDay = day
    }
    for (const threshold of EVENT_PATH_THRESHOLDS) {
      const ratio = threshold / 100
      if (firstUpDay[threshold] == null && bar.high / entry.open >= 1 + ratio) firstUpDay[threshold] = day
      if (firstDownDay[threshold] == null && bar.low / entry.open <= 1 - ratio) firstDownDay[threshold] = day
    }
    if (!EVENT_PATH_HORIZONS.includes(day as EventPathHorizon)) continue
    completedHorizons.push({
      horizonSessions: day as EventPathHorizon,
      exitDate: bar.date,
      closeReturn: bar.close / entry.open - 1,
      mfe: highest / entry.open - 1,
      mae: lowest / entry.open - 1,
      highestDay,
      lowestDay,
      firstUpDay: { ...firstUpDay },
      firstDownDay: { ...firstDownDay },
    })
  }

  const completed = new Set(completedHorizons.map((row) => row.horizonSessions))
  const missingHorizons = EVENT_PATH_HORIZONS.filter((horizon) => !completed.has(horizon))
  return {
    entryDate: entry.date,
    entryOpen: entry.open,
    maximumObservedExitDate,
    dailyExcursions,
    completedHorizons,
    missingHorizons,
    termination: invalidPrice ? 'INVALID_PRICE' : missingHorizons.length ? 'RIGHT_CENSORED' : 'COMPLETE',
  }
}

export type FirstPassageClassification = HitOrder | 'CENSORED_WITHOUT_DECISION' | 'INVALID'

export type FirstPassageResult = {
  classification: FirstPassageClassification
  favorableDay: number | null
  adverseDay: number | null
  observedSessions: number
  horizonSessions: EventPathHorizon
  completeHorizon: boolean
}

function firstMatchingDay(
  points: readonly DailyExcursionPoint[],
  predicate: (point: DailyExcursionPoint) => boolean,
): number | null {
  return points.find(predicate)?.day ?? null
}

export function evaluateFirstPassage(input: {
  excursions: readonly DailyExcursionPoint[]
  direction: EventResearchDirection
  horizonSessions: EventPathHorizon
  favorableThreshold: number
  adverseThreshold: number
  termination: EventPathEvaluation['termination']
}): FirstPassageResult {
  if (!(input.favorableThreshold > 0) || !(input.adverseThreshold > 0)) {
    throw new Error('first-passage thresholds must be positive')
  }
  const observed = input.excursions.filter((point) => point.day <= input.horizonSessions)
  if (
    input.termination === 'MISSING_ENTRY'
    || (input.termination === 'INVALID_PRICE' && observed.length < input.horizonSessions)
    || observed.length === 0
  ) {
    return {
      classification: 'INVALID', favorableDay: null, adverseDay: null,
      observedSessions: observed.length, horizonSessions: input.horizonSessions, completeHorizon: false,
    }
  }
  const favorableDay = input.direction === 'LONG'
    ? firstMatchingDay(observed, (point) => 1 + point.upReturn >= 1 + input.favorableThreshold)
    : firstMatchingDay(observed, (point) => 1 + point.downReturn <= 1 - input.favorableThreshold)
  const adverseDay = input.direction === 'LONG'
    ? firstMatchingDay(observed, (point) => 1 + point.downReturn <= 1 - input.adverseThreshold)
    : firstMatchingDay(observed, (point) => 1 + point.upReturn >= 1 + input.adverseThreshold)
  const completeHorizon = observed.length >= input.horizonSessions
  const order = hitOrder(favorableDay, adverseDay)
  return {
    classification: order === 'NEITHER' && !completeHorizon ? 'CENSORED_WITHOUT_DECISION' : order,
    favorableDay,
    adverseDay,
    observedSessions: observed.length,
    horizonSessions: input.horizonSessions,
    completeHorizon,
  }
}

export type FirstPassageSummary = {
  totalEvents: number
  validEvents: number
  completeHorizonEvents: number
  favorableFirst: number
  adverseFirst: number
  sameSessionUnknown: number
  favorableOnly: number
  adverseOnly: number
  neitherReached: number
  censoredWithoutDecision: number
  invalid: number
  favorableFirstRateAllValid: number | null
  favorableFirstRateDecided: number | null
}

export function summarizeFirstPassage(results: readonly FirstPassageResult[]): FirstPassageSummary {
  const counts = {
    favorableFirst: 0,
    adverseFirst: 0,
    sameSessionUnknown: 0,
    favorableOnly: 0,
    adverseOnly: 0,
    neitherReached: 0,
    censoredWithoutDecision: 0,
    invalid: 0,
  }
  for (const result of results) {
    if (result.classification === 'FAVORABLE_FIRST') counts.favorableFirst += 1
    else if (result.classification === 'ADVERSE_FIRST') counts.adverseFirst += 1
    else if (result.classification === 'SAME_SESSION') counts.sameSessionUnknown += 1
    else if (result.classification === 'FAVORABLE_ONLY') counts.favorableOnly += 1
    else if (result.classification === 'ADVERSE_ONLY') counts.adverseOnly += 1
    else if (result.classification === 'NEITHER') counts.neitherReached += 1
    else if (result.classification === 'CENSORED_WITHOUT_DECISION') counts.censoredWithoutDecision += 1
    else counts.invalid += 1
  }
  const validEvents = results.length - counts.invalid - counts.censoredWithoutDecision
  const favorableDecisions = counts.favorableFirst + counts.favorableOnly
  const adverseDecisions = counts.adverseFirst + counts.adverseOnly
  const decided = favorableDecisions + adverseDecisions
  return {
    totalEvents: results.length,
    validEvents,
    completeHorizonEvents: results.filter((result) => result.completeHorizon).length,
    ...counts,
    favorableFirstRateAllValid: validEvents ? favorableDecisions / validEvents : null,
    favorableFirstRateDecided: decided ? favorableDecisions / decided : null,
  }
}

export function directionalizeEventHorizon(
  row: RawEventHorizon,
  direction: EventResearchDirection,
): DirectionalEventHorizon {
  const favorable = direction === 'LONG' ? row.firstUpDay : row.firstDownDay
  const adverse = direction === 'LONG' ? row.firstDownDay : row.firstUpDay
  return {
    direction,
    horizonSessions: row.horizonSessions,
    exitDate: row.exitDate,
    priceReturn: direction === 'LONG' ? row.closeReturn : -row.closeReturn,
    mfe: direction === 'LONG' ? row.mfe : -row.mae,
    mae: direction === 'LONG' ? row.mae : -row.mfe,
    favorableDay: direction === 'LONG' ? row.highestDay : row.lowestDay,
    adverseDay: direction === 'LONG' ? row.lowestDay : row.highestDay,
    firstFavorableDay: { ...favorable },
    firstAdverseDay: { ...adverse },
    hitOrder: Object.fromEntries(EVENT_PATH_THRESHOLDS.map((threshold) => [
      threshold,
      hitOrder(favorable[threshold], adverse[threshold]),
    ])) as Record<EventPathThreshold, HitOrder>,
  }
}

export type ExistingSmaFeatureInput = {
  canonicalClose: number | null
  dailyFastGap: number | null
  closeGap: Record<Exclude<EventSmaPeriod, 5>, number | null>
  angle: Record<Exclude<EventSmaPeriod, 5>, number | null>
  curvature: Record<Exclude<EventSmaPeriod, 5>, number | null>
}

export type EventSmaSnapshot = {
  values: Record<EventSmaPeriod, number | null>
  closeGap: Record<EventSmaPeriod, number | null>
  angle: Record<EventSmaPeriod, number | null>
  curvature: Record<EventSmaPeriod, number | null>
  highToLowOrder: EventSmaPeriod[]
  completeOrder: boolean
  limitations: Array<'SMA5_ANGLE_REQUIRES_HISTORY' | 'SMA5_CURVATURE_REQUIRES_HISTORY' | 'TRAJECTORY_REQUIRES_HISTORY'>
}

function fromLogGap(close: number | null, gap: number | null): number | null {
  if (close == null || gap == null || !finitePositive(close) || !Number.isFinite(gap)) return null
  const value = close / Math.exp(gap)
  return finitePositive(value) ? value : null
}

export function reconstructEventSmaSnapshot(input: ExistingSmaFeatureInput): EventSmaSnapshot {
  const values = {} as Record<EventSmaPeriod, number | null>
  const closeGap = {} as Record<EventSmaPeriod, number | null>
  const angle = {} as Record<EventSmaPeriod, number | null>
  const curvature = {} as Record<EventSmaPeriod, number | null>
  for (const period of EVENT_SMA_PERIODS.filter((value) => value !== 5) as Array<Exclude<EventSmaPeriod, 5>>) {
    values[period] = fromLogGap(input.canonicalClose, input.closeGap[period])
    closeGap[period] = input.closeGap[period]
    angle[period] = input.angle[period]
    curvature[period] = input.curvature[period]
  }
  values[5] = values[25] == null
    || input.dailyFastGap == null
    || !Number.isFinite(input.dailyFastGap)
    || input.dailyFastGap <= -1
    ? null
    : values[25] * (1 + input.dailyFastGap)
  closeGap[5] = input.canonicalClose == null || values[5] == null
    ? null
    : Math.log(input.canonicalClose / values[5])
  angle[5] = null
  curvature[5] = null
  const available = EVENT_SMA_PERIODS.filter((period) => values[period] != null)
  const highToLowOrder = [...available].sort((left, right) => values[right]! - values[left]!)
  return {
    values,
    closeGap,
    angle,
    curvature,
    highToLowOrder,
    completeOrder: available.length === EVENT_SMA_PERIODS.length,
    limitations: ['SMA5_ANGLE_REQUIRES_HISTORY', 'SMA5_CURVATURE_REQUIRES_HISTORY', 'TRAJECTORY_REQUIRES_HISTORY'],
  }
}

export type SmaMetric = 'VALUE' | 'CLOSE_GAP' | 'ANGLE' | 'CURVATURE'
export type SmaCondition = {
  period: EventSmaPeriod
  metric: SmaMetric
  minimum?: number
  maximum?: number
}

function smaMetric(snapshot: EventSmaSnapshot, condition: SmaCondition): number | null {
  if (condition.metric === 'VALUE') return snapshot.values[condition.period]
  if (condition.metric === 'CLOSE_GAP') return snapshot.closeGap[condition.period]
  if (condition.metric === 'ANGLE') return snapshot.angle[condition.period]
  return snapshot.curvature[condition.period]
}

export function matchesSmaConditions(
  snapshot: EventSmaSnapshot,
  conditions: readonly SmaCondition[],
  exactHighToLowOrder?: readonly EventSmaPeriod[],
): boolean {
  for (const condition of conditions) {
    const value = smaMetric(snapshot, condition)
    if (value == null || !Number.isFinite(value)) return false
    if (condition.minimum != null && value < condition.minimum) return false
    if (condition.maximum != null && value > condition.maximum) return false
  }
  if (exactHighToLowOrder) {
    if (!snapshot.completeOrder || exactHighToLowOrder.length !== EVENT_SMA_PERIODS.length) return false
    if (exactHighToLowOrder.some((period, index) => snapshot.highToLowOrder[index] !== period)) return false
  }
  return true
}

export type DistributionEvent = {
  ticker: string
  signalDate: string
  value: number
}

export type NumericDistributionSummary = {
  samples: number
  mean: number | null
  median: number | null
  p01: number | null
  p05: number | null
  q1: number | null
  q3: number | null
  p95: number | null
  p99: number | null
  minimum: number | null
  maximum: number | null
  positiveRate: number | null
  trimmedMean1: number | null
  trimmedMean5: number | null
  meanWithoutTopAbsolute1: number | null
  meanWithoutTopAbsolute5: number | null
  topAbsolute1Contribution: number | null
  topAbsolute5Contribution: number | null
  distinctTickers: number
  topTickerShare: number | null
  topFiveTickersShare: number | null
  distinctYears: number
  maximumYearShare: number | null
}

function quantile(sorted: readonly number[], probability: number): number | null {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function average(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function symmetricTrimmedMean(sorted: readonly number[], fraction: number): number | null {
  const trim = Math.floor(sorted.length * fraction)
  return average(sorted.slice(trim, sorted.length - trim))
}

function withoutTopAbsolute(values: readonly number[], fraction: number): number | null {
  const remove = Math.min(values.length, Math.ceil(values.length * fraction))
  return average([...values].sort((left, right) => Math.abs(left) - Math.abs(right)).slice(0, values.length - remove))
}

function topAbsoluteContribution(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null
  const absolute = values.map(Math.abs).sort((left, right) => right - left)
  const total = absolute.reduce((sum, value) => sum + value, 0)
  if (total === 0) return 0
  const take = Math.max(1, Math.ceil(values.length * fraction))
  return absolute.slice(0, take).reduce((sum, value) => sum + value, 0) / total
}

function concentrationShares(values: readonly string[]): { distinct: number; top: number | null; topFive: number | null } {
  if (values.length === 0) return { distinct: 0, top: null, topFive: null }
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  const ranked = [...counts.values()].sort((left, right) => right - left)
  return {
    distinct: counts.size,
    top: ranked[0] / values.length,
    topFive: ranked.slice(0, 5).reduce((sum, value) => sum + value, 0) / values.length,
  }
}

export function summarizeDistribution(events: readonly DistributionEvent[]): NumericDistributionSummary {
  const finite = events.filter((event) => Number.isFinite(event.value))
  const values = finite.map((event) => event.value)
  const sorted = [...values].sort((left, right) => left - right)
  const tickers = concentrationShares(finite.map((event) => event.ticker))
  const years = concentrationShares(finite.map((event) => event.signalDate.slice(0, 4)))
  return {
    samples: values.length,
    mean: average(values),
    median: quantile(sorted, 0.5),
    p01: quantile(sorted, 0.01),
    p05: quantile(sorted, 0.05),
    q1: quantile(sorted, 0.25),
    q3: quantile(sorted, 0.75),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    minimum: sorted[0] ?? null,
    maximum: sorted.at(-1) ?? null,
    positiveRate: values.length ? values.filter((value) => value > 0).length / values.length : null,
    trimmedMean1: symmetricTrimmedMean(sorted, 0.01),
    trimmedMean5: symmetricTrimmedMean(sorted, 0.05),
    meanWithoutTopAbsolute1: withoutTopAbsolute(values, 0.01),
    meanWithoutTopAbsolute5: withoutTopAbsolute(values, 0.05),
    topAbsolute1Contribution: topAbsoluteContribution(values, 0.01),
    topAbsolute5Contribution: topAbsoluteContribution(values, 0.05),
    distinctTickers: tickers.distinct,
    topTickerShare: tickers.top,
    topFiveTickersShare: tickers.topFive,
    distinctYears: years.distinct,
    maximumYearShare: years.top,
  }
}

export type ThresholdHitSummary = {
  samples: number
  favorableHitRate: number
  adverseHitRate: number
  orderCounts: Record<HitOrder, number>
}

export function summarizeThresholdHits(
  rows: readonly DirectionalEventHorizon[],
  threshold: EventPathThreshold,
): ThresholdHitSummary {
  const orderCounts: Record<HitOrder, number> = {
    FAVORABLE_FIRST: 0,
    ADVERSE_FIRST: 0,
    SAME_SESSION: 0,
    FAVORABLE_ONLY: 0,
    ADVERSE_ONLY: 0,
    NEITHER: 0,
  }
  let favorable = 0
  let adverse = 0
  for (const row of rows) {
    if (row.firstFavorableDay[threshold] != null) favorable += 1
    if (row.firstAdverseDay[threshold] != null) adverse += 1
    orderCounts[row.hitOrder[threshold]] += 1
  }
  return {
    samples: rows.length,
    favorableHitRate: rows.length ? favorable / rows.length : 0,
    adverseHitRate: rows.length ? adverse / rows.length : 0,
    orderCounts,
  }
}

const LEGACY_DECISION_KEYS = new Set([
  'byQValue', 'iutPass', 'robustLcb', 'selected', 'rejected', 'recommendation', 'verdict',
])

export function assertNoLegacyH10DecisionFields(value: unknown, path = '$'): void {
  if (value == null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoLegacyH10DecisionFields(item, `${path}[${index}]`))
    return
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (LEGACY_DECISION_KEYS.has(key)) throw new Error(`legacy H10 decision field is forbidden: ${path}.${key}`)
    assertNoLegacyH10DecisionFields(nested, `${path}.${key}`)
  }
}

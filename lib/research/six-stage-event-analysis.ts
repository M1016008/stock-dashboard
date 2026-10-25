import {
  summarizeDistribution,
  type NumericDistributionSummary,
  type SmaCondition,
} from '@/lib/research/six-stage-event-path-research'

export const EVENT_SMA_SIMILARITY_FEATURES = [
  'sma5CloseGap', 'sma25CloseGap', 'sma75CloseGap', 'sma150CloseGap', 'sma200CloseGap', 'sma300CloseGap',
  'sma5Angle', 'sma25Angle', 'sma75Angle', 'sma150Angle', 'sma200Angle', 'sma300Angle',
  'sma5Curvature', 'sma25Curvature', 'sma75Curvature', 'sma150Curvature', 'sma200Curvature', 'sma300Curvature',
  'sma25To75Distance', 'sma75To150Distance', 'sma150To200Distance', 'sma200To300Distance',
  'sma25To75Convergence', 'sma75To150Convergence', 'sma150To200Convergence', 'sma200To300Convergence',
] as const

// Close-to-SMA gaps already determine pair distances algebraically. Pair
// distances remain available for filtering/breakdowns but are excluded here.
export const EVENT_SMA_INDEPENDENT_SIMILARITY_FEATURES = EVENT_SMA_SIMILARITY_FEATURES.filter((feature) => (
  !feature.endsWith('Distance')
))

// SMA-derived angles/order are deliberately absent here to avoid double-counting.
export const EVENT_PHYSICAL_SIMILARITY_FEATURES = [
  'velocity', 'acceleration', 'momentum', 'force', 'pms', 'pfs', 'pes',
] as const

export type EventSmaSimilarityFeature = typeof EVENT_SMA_SIMILARITY_FEATURES[number]
export type EventPhysicalSimilarityFeature = typeof EVENT_PHYSICAL_SIMILARITY_FEATURES[number]
export type EventNumericFeature = EventSmaSimilarityFeature | EventPhysicalSimilarityFeature

export type EventSimilarityVector = {
  eventId: string
  ticker: string
  signalDate: string
  sequenceKey: string
  cAge: number
  sma: Partial<Record<EventSmaSimilarityFeature, number | null>>
  physical: Partial<Record<EventPhysicalSimilarityFeature, number | null>>
}

export type FeatureRange = { minimum?: number; maximum?: number }
export type EventExplicitFilters = {
  sequenceKey?: string
  cAge?: FeatureRange
  sma?: Partial<Record<EventSmaSimilarityFeature, FeatureRange>>
  physical?: Partial<Record<EventPhysicalSimilarityFeature, FeatureRange>>
}

export type SimilarityWeights = {
  transition: number
  sma: number
  physical: number
  perFeature?: Partial<Record<EventNumericFeature, number>>
}

export type SimilarityLayer = { score: number | null; coverage: number }
export type EventSimilarityResult = {
  eventId: string
  transition: SimilarityLayer
  sma: SimilarityLayer
  physical: SimilarityLayer
  combined: number | null
}

export type FeatureScales = Partial<Record<EventNumericFeature, number>>

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function rangeMatches(value: number | null | undefined, range: FeatureRange): boolean {
  if (!finite(value)) return false
  if (range.minimum != null && value < range.minimum) return false
  if (range.maximum != null && value > range.maximum) return false
  return true
}

export function matchesExplicitEventFilters(vector: EventSimilarityVector, filters: EventExplicitFilters): boolean {
  if (filters.sequenceKey != null && vector.sequenceKey !== filters.sequenceKey) return false
  if (filters.cAge != null && !rangeMatches(vector.cAge, filters.cAge)) return false
  for (const [key, range] of Object.entries(filters.sma ?? {}) as Array<[EventSmaSimilarityFeature, FeatureRange]>) {
    if (!rangeMatches(vector.sma[key], range)) return false
  }
  for (const [key, range] of Object.entries(filters.physical ?? {}) as Array<[EventPhysicalSimilarityFeature, FeatureRange]>) {
    if (!rangeMatches(vector.physical[key], range)) return false
  }
  return true
}

function featureSimilarity(left: number, right: number, scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('similarity scale must be positive')
  return Math.exp(-Math.abs(left - right) / scale)
}

function numericLayer<K extends string>(input: {
  base: Partial<Record<K, number | null>>
  candidate: Partial<Record<K, number | null>>
  keys: readonly K[]
  scales: Partial<Record<K, number>>
  weights: Partial<Record<K, number>>
}): SimilarityLayer {
  let availableWeight = 0
  let totalWeight = 0
  let weightedScore = 0
  for (const key of input.keys) {
    const weight = input.weights[key] ?? 1
    if (!(weight >= 0) || !Number.isFinite(weight)) throw new Error(`invalid feature weight: ${key}`)
    totalWeight += weight
    const left = input.base[key]
    const right = input.candidate[key]
    const scale = input.scales[key]
    if (!finite(left) || !finite(right) || !finite(scale) || !(scale > 0) || weight === 0) continue
    availableWeight += weight
    weightedScore += weight * featureSimilarity(left, right, scale)
  }
  return {
    score: availableWeight ? weightedScore / availableWeight : null,
    coverage: totalWeight ? availableWeight / totalWeight : 0,
  }
}

export function compareEventSimilarity(input: {
  base: EventSimilarityVector
  candidate: EventSimilarityVector
  scales: FeatureScales
  weights: SimilarityWeights
}): EventSimilarityResult {
  for (const [key, weight] of Object.entries(input.weights)) {
    if (key === 'perFeature') continue
    if (!(Number(weight) >= 0) || !Number.isFinite(Number(weight))) throw new Error(`invalid layer weight: ${key}`)
  }
  const exactSequence = input.base.sequenceKey === input.candidate.sequenceKey ? 1 : 0
  const ageScore = Math.exp(-Math.abs(input.base.cAge - input.candidate.cAge) / 10)
  const transition = { score: (exactSequence * 3 + ageScore) / 4, coverage: 1 }
  const sma = numericLayer({
    base: input.base.sma,
    candidate: input.candidate.sma,
    keys: EVENT_SMA_INDEPENDENT_SIMILARITY_FEATURES,
    scales: input.scales,
    weights: input.weights.perFeature ?? {},
  })
  const physical = numericLayer({
    base: input.base.physical,
    candidate: input.candidate.physical,
    keys: EVENT_PHYSICAL_SIMILARITY_FEATURES,
    scales: input.scales,
    weights: input.weights.perFeature ?? {},
  })
  const layers = [
    [transition, input.weights.transition],
    [sma, input.weights.sma],
    [physical, input.weights.physical],
  ] as const
  let denominator = 0
  let numerator = 0
  for (const [layer, weight] of layers) {
    if (layer.score == null || weight === 0) continue
    const effective = weight * layer.coverage
    denominator += effective
    numerator += layer.score * effective
  }
  return {
    eventId: input.candidate.eventId,
    transition,
    sma,
    physical,
    combined: denominator ? numerator / denominator : null,
  }
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) throw new Error('quantile requires values')
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower)
}

export type AutomaticFeatureBin = {
  feature: EventNumericFeature
  index: number
  minimum: number
  maximum: number
  includeMaximum: boolean
  events: number
}

export function automaticFeatureBins(
  vectors: readonly EventSimilarityVector[],
  feature: EventNumericFeature,
  requestedBins = 5,
): AutomaticFeatureBin[] {
  if (!Number.isInteger(requestedBins) || requestedBins < 2 || requestedBins > 20) {
    throw new Error('automatic bin count must be between 2 and 20')
  }
  const source = (vector: EventSimilarityVector) => (
    EVENT_SMA_SIMILARITY_FEATURES.includes(feature as EventSmaSimilarityFeature)
      ? vector.sma[feature as EventSmaSimilarityFeature]
      : vector.physical[feature as EventPhysicalSimilarityFeature]
  )
  const values = vectors.map(source).filter(finite).sort((left, right) => left - right)
  if (values.length === 0) return []
  const boundaries = Array.from({ length: requestedBins + 1 }, (_, index) => quantile(values, index / requestedBins))
    .filter((value, index, all) => index === 0 || value > all[index - 1])
  if (boundaries.length === 1) boundaries.push(boundaries[0])
  return boundaries.slice(0, -1).map((minimum, index) => {
    const maximum = boundaries[index + 1]
    const includeMaximum = index === boundaries.length - 2
    const events = values.filter((value) => value >= minimum && (includeMaximum ? value <= maximum : value < maximum)).length
    return { feature, index, minimum, maximum, includeMaximum, events }
  })
}

export type EventBreakdownObservation = {
  eventId: string
  ticker: string
  signalDate: string
  vector: EventSimilarityVector
  value: number
  favorableFirst: boolean | null
}

export type AutomaticBreakdownRow = {
  bin: AutomaticFeatureBin
  observations: number
  favorableFirstKnown: number
  favorableFirstCount: number
  favorableFirstRate: number | null
  distribution: NumericDistributionSummary
}

export function buildAutomaticBreakdown(
  observations: readonly EventBreakdownObservation[],
  feature: EventNumericFeature,
  requestedBins = 5,
): AutomaticBreakdownRow[] {
  const bins = automaticFeatureBins(observations.map((observation) => observation.vector), feature, requestedBins)
  const featureValue = (observation: EventBreakdownObservation) => (
    EVENT_SMA_SIMILARITY_FEATURES.includes(feature as EventSmaSimilarityFeature)
      ? observation.vector.sma[feature as EventSmaSimilarityFeature]
      : observation.vector.physical[feature as EventPhysicalSimilarityFeature]
  )
  return bins.map((bin) => {
    const rows = observations.filter((observation) => {
      const value = featureValue(observation)
      return finite(value) && value >= bin.minimum && (bin.includeMaximum ? value <= bin.maximum : value < bin.maximum)
    })
    const known = rows.filter((row) => row.favorableFirst != null)
    const success = known.filter((row) => row.favorableFirst).length
    return {
      bin,
      observations: rows.length,
      favorableFirstKnown: known.length,
      favorableFirstCount: success,
      favorableFirstRate: known.length ? success / known.length : null,
      distribution: summarizeDistribution(rows.map((row) => ({
        ticker: row.ticker,
        signalDate: row.signalDate,
        value: row.value,
      }))),
    }
  })
}

export type ObservedTemplate = {
  sourceEvents: number
  ranges: Partial<Record<EventNumericFeature, FeatureRange>>
  method: 'CENTRAL_50_PERCENT'
}

export function extractObservedTemplate(
  selected: readonly EventSimilarityVector[],
  features: readonly EventNumericFeature[],
): ObservedTemplate {
  const ranges: Partial<Record<EventNumericFeature, FeatureRange>> = {}
  for (const feature of features) {
    const values = selected.map((vector) => (
      EVENT_SMA_SIMILARITY_FEATURES.includes(feature as EventSmaSimilarityFeature)
        ? vector.sma[feature as EventSmaSimilarityFeature]
        : vector.physical[feature as EventPhysicalSimilarityFeature]
    )).filter(finite).sort((left, right) => left - right)
    if (values.length === 0) continue
    ranges[feature] = { minimum: quantile(values, 0.25), maximum: quantile(values, 0.75) }
  }
  return { sourceEvents: selected.length, ranges, method: 'CENTRAL_50_PERCENT' }
}

export function templateToExplicitFilters(template: ObservedTemplate): EventExplicitFilters {
  const sma: EventExplicitFilters['sma'] = {}
  const physical: EventExplicitFilters['physical'] = {}
  for (const [feature, range] of Object.entries(template.ranges) as Array<[EventNumericFeature, FeatureRange]>) {
    if (EVENT_SMA_SIMILARITY_FEATURES.includes(feature as EventSmaSimilarityFeature)) {
      sma[feature as EventSmaSimilarityFeature] = range
    } else {
      physical[feature as EventPhysicalSimilarityFeature] = range
    }
  }
  return { sma, physical }
}

// Kept as an explicit compile-time reminder that the old UI condition type is
// not a ranking gate in this research cycle.
export type LegacyCompatibleSmaCondition = SmaCondition

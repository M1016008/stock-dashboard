export const MA_SEQUENCE_VERSION = 1
export const MA_SEQUENCE_SCORE_VERSION = 7
export const MA_SEQUENCE_PERIODS = [5, 10, 20, 40, 60, 90, 200] as const
export const MA_SEQUENCE_WINDOWS = [10, 20, 40] as const
export const MA_SEQUENCE_WINDOW_WEIGHTS = [0.25, 0.35, 0.4] as const
export const MA_SEQUENCE_MONTHLY_PERIODS = [3, 6, 12, 24, 36, 60] as const
export const MA_SEQUENCE_LONG_TERM_PERIODS = [12, 24, 36, 60, 120] as const
export const MA_SEQUENCE_INDEX_STRIDE = 5
export const MA_SEQUENCE_BAND_COUNT = 4
export const MA_SEQUENCE_BAND_BITS = 12
export const MA_SEQUENCE_EMBEDDING_SCALE = 30

export type MaSequencePriceRow = {
  date: string
  close: number
  open?: number | null
  high?: number | null
  low?: number | null
  volume?: number | null
}

export type MaSequencePoint = {
  date: string
  values: number[]
  stages: number[]
}

export type MaSequencePrepared = {
  rows: MaSequencePriceRow[]
  daily: MaSequenceFrame
  weekly: MaSequenceFrame
  monthly: MaSequenceFrame
  monthlyComparison: MaSequenceFrame
  longTerm: MaSequenceFrame
}

export type MaSequenceFrame = {
  step: number
  periods: readonly number[]
  mas: Array<Array<number | null>>
}

export type MaSequenceEmbedding = {
  values: number[]
  quantized: Uint8Array
  bands: number[]
  coverageMask: number
}

export type MaSequenceScoreComponent = {
  key: 'daily10' | 'daily20' | 'daily40' | 'weekly' | 'monthly' | 'longTerm'
  label: string
  score: number
  weight: number
  available: boolean
}

export type MaSequenceScore = {
  score: number
  components: MaSequenceScoreComponent[]
}

export type MaSequenceScoringProfile = {
  key: string
  label: string
  dailyWindowWeights: readonly [number, number, number]
  timeframeWeights: {
    daily: number
    weekly: number
    monthly: number
    longTerm: number
  }
}

export const MA_SEQUENCE_SCORING_PROFILES = [
  {
    key: 'balanced-v2',
    label: '現行バランス',
    dailyWindowWeights: [0.25, 0.35, 0.4],
    timeframeWeights: { daily: 0.72, weekly: 0.13, monthly: 0.1, longTerm: 0.05 },
  },
  {
    key: 'trajectory-heavy',
    label: '日足軌跡重視',
    dailyWindowWeights: [0.2, 0.3, 0.5],
    timeframeWeights: { daily: 0.8, weekly: 0.1, monthly: 0.07, longTerm: 0.03 },
  },
  {
    key: 'medium-trajectory',
    label: '中期軌跡重視',
    dailyWindowWeights: [0.2, 0.35, 0.45],
    timeframeWeights: { daily: 0.68, weekly: 0.15, monthly: 0.11, longTerm: 0.06 },
  },
  {
    key: 'multiframe',
    label: '上位足重視',
    dailyWindowWeights: [0.2, 0.35, 0.45],
    timeframeWeights: { daily: 0.62, weekly: 0.16, monthly: 0.14, longTerm: 0.08 },
  },
  {
    key: 'structural-context',
    label: '構造文脈重視',
    dailyWindowWeights: [0.18, 0.34, 0.48],
    timeframeWeights: { daily: 0.55, weekly: 0.2, monthly: 0.17, longTerm: 0.08 },
  },
  {
    key: 'short-reactive',
    label: '短期変化重視',
    dailyWindowWeights: [0.4, 0.4, 0.2],
    timeframeWeights: { daily: 0.75, weekly: 0.13, monthly: 0.08, longTerm: 0.04 },
  },
] as const satisfies readonly MaSequenceScoringProfile[]

export const MA_SEQUENCE_DEFAULT_SCORING_PROFILE = MA_SEQUENCE_SCORING_PROFILES[0]

export function maSequenceScoringProfileForMarket(
  market: 'JP' | 'US',
): MaSequenceScoringProfile {
  const key = market === 'US' ? 'trajectory-heavy' : 'structural-context'
  return MA_SEQUENCE_SCORING_PROFILES.find((profile) => profile.key === key)
    ?? MA_SEQUENCE_DEFAULT_SCORING_PROFILE
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function pct(base: number | null | undefined, value: number | null | undefined): number | null {
  if (!finite(base) || !finite(value) || base === 0) return null
  return ((value / base) - 1) * 100
}

function normalizedPct(base: number | null | undefined, value: number | null | undefined, scale: number): number {
  const valuePct = pct(base, value)
  return valuePct == null ? 0 : clamp(valuePct / scale, -3, 3)
}

function sampledSmaSeries(
  rows: MaSequencePriceRow[],
  period: number,
  step: number,
): Array<number | null> {
  const output: Array<number | null> = Array(rows.length).fill(null)
  const span = period * step
  for (let residue = 0; residue < step; residue += 1) {
    let sum = 0
    let count = 0
    for (let index = residue; index < rows.length; index += step) {
      sum += rows[index].close
      count += 1
      if (count > period) sum -= rows[index - span].close
      if (count >= period) output[index] = sum / period
    }
  }
  return output
}

function buildFrame(
  rows: MaSequencePriceRow[],
  periods: readonly number[],
  step: number,
): MaSequenceFrame {
  return {
    step,
    periods,
    mas: periods.map((period) => sampledSmaSeries(rows, period, step)),
  }
}

export function prepareMaSequence(rows: MaSequencePriceRow[]): MaSequencePrepared {
  const ordered = rows
    .filter((row) => row.date && finite(row.close) && row.close > 0)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
  return {
    rows: ordered,
    daily: buildFrame(ordered, MA_SEQUENCE_PERIODS, 1),
    weekly: buildFrame(ordered, MA_SEQUENCE_PERIODS, 5),
    // Keep the legacy monthly frame stable because its compact embedding is
    // persisted in the sidecar index. Exact scoring uses monthlyComparison.
    monthly: buildFrame(ordered, MA_SEQUENCE_PERIODS, 21),
    monthlyComparison: buildFrame(ordered, MA_SEQUENCE_MONTHLY_PERIODS, 21),
    longTerm: buildFrame(ordered, MA_SEQUENCE_LONG_TERM_PERIODS, 21),
  }
}

function frameStructure(
  prepared: MaSequencePrepared,
  frame: MaSequenceFrame,
  index: number,
  includeGapFlow: boolean,
): number[] | null {
  const currentMas = frame.mas.map((series) => series[index])
  if (currentMas.some((value) => !finite(value))) return null
  const close = prepared.rows[index]?.close
  if (!finite(close)) return null
  const velocityOffset = frame.step * 5
  const priorMas = frame.mas.map((series) => series[index - velocityOffset])
  const pricePositions = currentMas.map((ma) => normalizedPct(ma, close, 12))
  const adjacentGaps = currentMas.slice(0, -1).map((ma, maIndex) =>
    normalizedPct(currentMas[maIndex + 1], ma, 10),
  )
  const velocities = currentMas.map((ma, maIndex) =>
    normalizedPct(priorMas[maIndex], ma, 5),
  )
  if (!includeGapFlow) return [...pricePositions, ...adjacentGaps, ...velocities]
  const gapFlows = currentMas.slice(0, -1).map((ma, maIndex) => {
    const currentGap = pct(currentMas[maIndex + 1], ma)
    const previousGap = pct(priorMas[maIndex + 1], priorMas[maIndex])
    if (currentGap == null || previousGap == null) return 0
    return clamp((currentGap - previousGap) / 4, -3, 3)
  })
  return [...pricePositions, ...adjacentGaps, ...velocities, ...gapFlows]
}

function stageFromThree(a: number | null, b: number | null, c: number | null): number {
  if (!finite(a) || !finite(b) || !finite(c)) return 0
  if (a > b && b > c) return 1
  if (b > a && a > c) return 2
  if (b > c && c > a) return 3
  if (c > b && b > a) return 4
  if (c > a && a > b) return 5
  if (a > c && c > b) return 6
  return 0
}

function frameStages(frame: MaSequenceFrame, index: number): number[] {
  const currentMas = frame.mas.map((series) => series[index])
  const stages: number[] = []
  for (let periodIndex = 0; periodIndex + 2 < currentMas.length; periodIndex += 1) {
    stages.push(stageFromThree(
      currentMas[periodIndex],
      currentMas[periodIndex + 1],
      currentMas[periodIndex + 2],
    ))
  }
  return stages
}

function buildPointAt(
  prepared: MaSequencePrepared,
  frame: MaSequenceFrame,
  index: number,
): MaSequencePoint | null {
  const values = frameStructure(prepared, frame, index, true)
  if (!values) return null
  return {
    date: prepared.rows[index].date,
    values,
    stages: frameStages(frame, index),
  }
}

function pointsEndingAt(
  prepared: MaSequencePrepared,
  frame: MaSequenceFrame,
  endIndex: number,
  count: number,
): MaSequencePoint[] {
  const points: MaSequencePoint[] = []
  for (
    let index = endIndex - (count - 1) * frame.step;
    index <= endIndex;
    index += frame.step
  ) {
    if (index < 0) continue
    const point = buildPointAt(prepared, frame, index)
    if (point) points.push(point)
  }
  return points
}

function pointDistance(a: MaSequencePoint, b: MaSequencePoint): number {
  const length = Math.min(a.values.length, b.values.length)
  const periodCount = Math.max(1, Math.floor((length + 2) / 4))
  const featureWeights = [
    ...Array(periodCount).fill(1.15),
    ...Array(Math.max(0, periodCount - 1)).fill(1.35),
    ...Array(periodCount).fill(1),
    ...Array(Math.max(0, periodCount - 1)).fill(0.8),
  ]
  let weighted = 0
  let totalWeight = 0
  for (let index = 0; index < length; index += 1) {
    const delta = a.values[index] - b.values[index]
    const weight = featureWeights[index] ?? 1
    weighted += delta * delta * weight
    totalWeight += weight
  }
  let stageMismatch = 0
  let stageCount = 0
  for (let index = 0; index < Math.min(a.stages.length, b.stages.length); index += 1) {
    if (a.stages[index] === 0 || b.stages[index] === 0) continue
    stageMismatch += a.stages[index] === b.stages[index] ? 0 : 1
    stageCount += 1
  }
  const featureDistance = totalWeight > 0 ? Math.sqrt(weighted / totalWeight) : 3
  const stageDistance = stageCount > 0 ? stageMismatch / stageCount : 0.5
  return featureDistance * 0.84 + stageDistance * 0.16
}

function alignedDistance(a: MaSequencePoint[], b: MaSequencePoint[]): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return Infinity
  let total = 0
  let weight = 0
  for (let index = 0; index < length; index += 1) {
    const recencyWeight = 0.45 + 0.55 * ((index + 1) / length)
    total += pointDistance(a[a.length - length + index], b[b.length - length + index]) * recencyWeight
    weight += recencyWeight
  }
  return total / weight
}

function dtwDistance(a: MaSequencePoint[], b: MaSequencePoint[], bandRatio = 0.2): number {
  if (a.length === 0 || b.length === 0) return Infinity
  const width = Math.max(
    Math.abs(a.length - b.length),
    Math.ceil(Math.max(a.length, b.length) * bandRatio),
  )
  let previous = new Float64Array(b.length + 1)
  let current = new Float64Array(b.length + 1)
  previous.fill(Infinity)
  previous[0] = 0
  for (let rowIndex = 1; rowIndex <= a.length; rowIndex += 1) {
    current.fill(Infinity)
    const from = Math.max(1, rowIndex - width)
    const to = Math.min(b.length, rowIndex + width)
    for (let columnIndex = from; columnIndex <= to; columnIndex += 1) {
      const cost = pointDistance(a[rowIndex - 1], b[columnIndex - 1])
      current[columnIndex] = cost + Math.min(
        previous[columnIndex],
        current[columnIndex - 1],
        previous[columnIndex - 1],
      )
    }
    const swap = previous
    previous = current
    current = swap
  }
  return previous[b.length] / Math.max(a.length, b.length)
}

function sequenceDistance(a: MaSequencePoint[], b: MaSequencePoint[]): number {
  if (a.length === 0 || b.length === 0) return Infinity
  return alignedDistance(a, b) * 0.7 + dtwDistance(a, b) * 0.3
}

function distanceToSimilarity(distance: number): number {
  return finite(distance) ? Math.exp(-1.35 * distance) : 0
}

function compareFrame(
  base: MaSequencePrepared,
  baseIndex: number,
  candidate: MaSequencePrepared,
  candidateIndex: number,
  frame: 'daily' | 'weekly' | 'monthlyComparison' | 'longTerm',
  count: number,
  includeDtw: boolean,
): number | null {
  const basePoints = pointsEndingAt(base, base[frame], baseIndex, count)
  const candidatePoints = pointsEndingAt(candidate, candidate[frame], candidateIndex, count)
  const minimum = Math.max(2, Math.ceil(count * 0.7))
  if (basePoints.length < minimum || candidatePoints.length < minimum) return null
  const distance = includeDtw
    ? sequenceDistance(basePoints, candidatePoints)
    : alignedDistance(basePoints, candidatePoints)
  return distanceToSimilarity(distance)
}

function scoreMaSequenceInternal(
  base: MaSequencePrepared,
  baseIndex: number,
  candidate: MaSequencePrepared,
  candidateIndex: number,
  includeDtw: boolean,
  profile: MaSequenceScoringProfile,
): MaSequenceScore {
  const dailyScores = MA_SEQUENCE_WINDOWS.map((window) =>
    compareFrame(base, baseIndex, candidate, candidateIndex, 'daily', window, includeDtw),
  )
  const weekly = compareFrame(base, baseIndex, candidate, candidateIndex, 'weekly', 10, includeDtw)
  const monthly = compareFrame(
    base,
    baseIndex,
    candidate,
    candidateIndex,
    'monthlyComparison',
    6,
    includeDtw,
  )
  const longTerm = compareFrame(base, baseIndex, candidate, candidateIndex, 'longTerm', 6, includeDtw)
  const components: MaSequenceScoreComponent[] = [
    ...dailyScores.map((score, index) => ({
      key: `daily${MA_SEQUENCE_WINDOWS[index]}` as const,
      label: `日足 ${MA_SEQUENCE_WINDOWS[index]}日`,
      score: score ?? 0,
      weight: profile.dailyWindowWeights[index] * profile.timeframeWeights.daily,
      available: score != null,
    })),
    {
      key: 'weekly',
      label: '週足構造',
      score: weekly ?? 0,
      weight: profile.timeframeWeights.weekly,
      available: weekly != null,
    },
    {
      key: 'monthly',
      label: '月足構造',
      score: monthly ?? 0,
      weight: profile.timeframeWeights.monthly,
      available: monthly != null,
    },
    {
      key: 'longTerm',
      label: '長期構造',
      score: longTerm ?? 0,
      weight: profile.timeframeWeights.longTerm,
      available: longTerm != null,
    },
  ]
  return rescoreMaSequenceComponents(components, profile)
}

export function rescoreMaSequenceComponents(
  components: readonly MaSequenceScoreComponent[],
  profile: MaSequenceScoringProfile,
): MaSequenceScore {
  const dailyWeightByKey = new Map(
    MA_SEQUENCE_WINDOWS.map((window, index) => [
      `daily${window}`,
      profile.dailyWindowWeights[index] * profile.timeframeWeights.daily,
    ]),
  )
  const weightByKey = new Map<string, number>([
    ...dailyWeightByKey,
    ['weekly', profile.timeframeWeights.weekly],
    ['monthly', profile.timeframeWeights.monthly],
    ['longTerm', profile.timeframeWeights.longTerm],
  ])
  const rescored = components.map((component) => ({
    ...component,
    weight: weightByKey.get(component.key) ?? component.weight,
  }))
  const available = rescored.filter((component) => component.available)
  const weight = available.reduce((sum, component) => sum + component.weight, 0)
  const score = weight > 0
    ? available.reduce((sum, component) => sum + component.score * component.weight, 0) / weight
    : 0
  return { score, components: rescored }
}

export function scoreMaSequence(
  base: MaSequencePrepared,
  baseIndex: number,
  candidate: MaSequencePrepared,
  candidateIndex: number,
  profile: MaSequenceScoringProfile = MA_SEQUENCE_DEFAULT_SCORING_PROFILE,
): MaSequenceScore {
  return scoreMaSequenceInternal(base, baseIndex, candidate, candidateIndex, true, profile)
}

export function scoreMaSequenceAligned(
  base: MaSequencePrepared,
  baseIndex: number,
  candidate: MaSequencePrepared,
  candidateIndex: number,
  profile: MaSequenceScoringProfile = MA_SEQUENCE_DEFAULT_SCORING_PROFILE,
): MaSequenceScore {
  return scoreMaSequenceInternal(base, baseIndex, candidate, candidateIndex, false, profile)
}

function embeddingDailyWindow(
  prepared: MaSequencePrepared,
  endIndex: number,
  window: number,
): number[] {
  const startIndex = endIndex - window + 1
  const current = frameStructure(prepared, prepared.daily, endIndex, false)
  const start = frameStructure(prepared, prepared.daily, startIndex, false)
  if (!current || !start) return Array(16).fill(0)
  const positionAndGaps = MA_SEQUENCE_PERIODS.length + MA_SEQUENCE_PERIODS.length - 1
  const changes = current
    .slice(0, positionAndGaps)
    .map((value, index) => clamp(value - start[index], -3, 3))
  const currentGaps = current.slice(MA_SEQUENCE_PERIODS.length, positionAndGaps)
  const startGaps = start.slice(MA_SEQUENCE_PERIODS.length, positionAndGaps)
  const currentCompression = currentGaps.reduce((sum, value) => sum + Math.abs(value), 0) / currentGaps.length
  const startCompression = startGaps.reduce((sum, value) => sum + Math.abs(value), 0) / startGaps.length
  const directionAgreement = current
    .slice(positionAndGaps)
    .reduce((sum, value) => sum + Math.sign(value), 0) / MA_SEQUENCE_PERIODS.length
  return [
    ...changes,
    clamp(currentCompression, -3, 3),
    clamp(currentCompression - startCompression, -3, 3),
    clamp(directionAgreement, -3, 3),
  ]
}

function frameEmbedding(
  prepared: MaSequencePrepared,
  frame: MaSequenceFrame,
  index: number,
): number[] {
  const values = frameStructure(prepared, frame, index, false)
  return values ?? Array(frame.periods.length * 2 + frame.periods.length - 1).fill(0)
}

function projectionHash(dimension: number, bit: number): number {
  let value = Math.imul(dimension + 1, 0x9e3779b1) ^ Math.imul(bit + 1, 0x85ebca6b)
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d)
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b)
  return (value ^ (value >>> 16)) >>> 0
}

function signatureBands(values: number[]): number[] {
  const bitCount = MA_SEQUENCE_BAND_COUNT * MA_SEQUENCE_BAND_BITS
  const accumulators = new Float64Array(bitCount)
  // Candidate recall is driven by the continuous daily trajectory. Higher-timeframe
  // values remain in the compact embedding and take part in the rerank.
  const dailyDimensionCount = 20 + MA_SEQUENCE_WINDOWS.length * 16
  for (let dimension = 0; dimension < Math.min(values.length, dailyDimensionCount); dimension += 1) {
    const value = values[dimension]
    if (!finite(value) || value === 0) continue
    for (let bit = 0; bit < bitCount; bit += 1) {
      const state = projectionHash(dimension, bit)
      const sign = (state & 0x40000000) === 0 ? -1 : 1
      accumulators[bit] += value * sign
    }
  }
  return Array.from({ length: MA_SEQUENCE_BAND_COUNT }, (_, bandIndex) => {
    let band = 0
    for (let bitOffset = 0; bitOffset < MA_SEQUENCE_BAND_BITS; bitOffset += 1) {
      const bitIndex = bandIndex * MA_SEQUENCE_BAND_BITS + bitOffset
      if (accumulators[bitIndex] >= 0) band |= 1 << bitOffset
    }
    return band
  })
}

export function buildMaSequenceEmbedding(
  prepared: MaSequencePrepared,
  endIndex: number,
): MaSequenceEmbedding | null {
  const currentDaily = frameStructure(prepared, prepared.daily, endIndex, false)
  if (!currentDaily || endIndex < MA_SEQUENCE_PERIODS.at(-1)! + MA_SEQUENCE_WINDOWS.at(-1)!) return null
  const weekly = frameEmbedding(prepared, prepared.weekly, endIndex)
  const monthly = frameEmbedding(prepared, prepared.monthly, endIndex)
  const longTerm = frameEmbedding(prepared, prepared.longTerm, endIndex)
  const weeklyAvailable = prepared.weekly.mas.every((series) => finite(series[endIndex]))
  const monthlyAvailable = prepared.monthly.mas.every((series) => finite(series[endIndex]))
  const longTermAvailable = prepared.longTerm.mas.every((series) => finite(series[endIndex]))
  const values = [
    ...currentDaily,
    ...MA_SEQUENCE_WINDOWS.flatMap((window) => embeddingDailyWindow(prepared, endIndex, window)),
    ...weekly,
    ...monthly,
    ...longTerm,
    1,
    weeklyAvailable ? 1 : 0,
    monthlyAvailable ? 1 : 0,
    longTermAvailable ? 1 : 0,
  ]
  const quantized = Uint8Array.from(values, (value) =>
    clamp(Math.round(value * MA_SEQUENCE_EMBEDDING_SCALE), -127, 127) + 128,
  )
  const coverageMask = 1
    | (weeklyAvailable ? 2 : 0)
    | (monthlyAvailable ? 4 : 0)
    | (longTermAvailable ? 8 : 0)
  return {
    values,
    quantized,
    bands: signatureBands(values),
    coverageMask,
  }
}

export function decodeMaSequenceEmbedding(value: Uint8Array): number[] {
  return Array.from(value, (item) => (item - 128) / MA_SEQUENCE_EMBEDDING_SCALE)
}

export function maSequenceEmbeddingDistance(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return Infinity
  let squared = 0
  for (let index = 0; index < length; index += 1) {
    const delta = (a[index] - b[index]) / MA_SEQUENCE_EMBEDDING_SCALE
    squared += delta * delta
  }
  return Math.sqrt(squared / length)
}

export function maSequenceEmbeddingSimilarity(a: Uint8Array, b: Uint8Array): number {
  const distance = maSequenceEmbeddingDistance(a, b)
  return finite(distance) ? Math.exp(-1.25 * distance) : 0
}

export function maSequenceEmbeddingSimilarityRanges(
  a: Uint8Array,
  b: Uint8Array,
  ranges: ReadonlyArray<readonly [number, number]>,
): number {
  let squared = 0
  let used = 0
  for (const [from, to] of ranges) {
    const end = Math.min(to, a.length, b.length)
    for (let index = Math.max(0, from); index < end; index += 1) {
      const delta = (a[index] - b[index]) / MA_SEQUENCE_EMBEDDING_SCALE
      squared += delta * delta
      used += 1
    }
  }
  if (used === 0) return 0
  return Math.exp(-1.25 * Math.sqrt(squared / used))
}

export function maSequenceBandNeighbors(band: number, maxBitDistance = 1): number[] {
  const values = [band]
  if (maxBitDistance >= 1) {
    for (let bit = 0; bit < MA_SEQUENCE_BAND_BITS; bit += 1) values.push(band ^ (1 << bit))
  }
  return values
}

export function stageCodeAt(prepared: MaSequencePrepared, index: number): string | null {
  const stages = frameStages(prepared.daily, index)
  if (stages.some((stage) => stage === 0)) return null
  return stages.join('')
}

export function findMaSequenceIndex(prepared: MaSequencePrepared, date: string): number {
  let low = 0
  let high = prepared.rows.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const current = prepared.rows[middle].date
    if (current === date) return middle
    if (current < date) low = middle + 1
    else high = middle - 1
  }
  return high
}

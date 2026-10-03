import type { MaSequenceRangeWeights } from '@/lib/ml/ma-sequence'

export type HistoricalAnalogSort = 'similarity' | 'recent'
export type HistoricalAnalogRecency = 'all' | '2w' | '1m' | '3m'
export type HistoricalAnalogProfile = 'balanced' | 'short' | 'long'
export type HistoricalAnalogTimeframe = 'daily' | 'weekly' | 'monthly' | 'yearly'

const HISTORICAL_ANALOG_TIMEFRAMES: readonly HistoricalAnalogTimeframe[] = [
  'daily',
  'weekly',
  'monthly',
  'yearly',
]

export type HistoricalAnalogProfileConfig = {
  key: HistoricalAnalogProfile
  label: string
  description: string
  weights: MaSequenceRangeWeights
}

export const HISTORICAL_ANALOG_PROFILES: readonly HistoricalAnalogProfileConfig[] = [
  {
    key: 'balanced',
    label: '標準（日足40%・週足25%・月足20%・年足15%）',
    description: '短期・中期・長期・超長期の構造を総合して評価します。',
    weights: { daily: 0.4, weekly: 0.25, monthly: 0.2, yearly: 0.15 },
  },
  {
    key: 'short',
    label: '日足を優先（日足55%・週足20%・月足15%・年足10%）',
    description: '目先の値動きと移動平均線構造を強く評価します。',
    weights: { daily: 0.55, weekly: 0.2, monthly: 0.15, yearly: 0.1 },
  },
  {
    key: 'long',
    label: '上位足を優先（日足25%・週足30%・月足25%・年足20%）',
    description: '週足・月足・年足のトレンドと大局的な位置関係を強く評価します。',
    weights: { daily: 0.25, weekly: 0.3, monthly: 0.25, yearly: 0.2 },
  },
] as const

const DAY_MS = 86_400_000

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseUtcDate(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`)
}

export function normalizeHistoricalAnalogSort(
  value: string | null | undefined,
): HistoricalAnalogSort {
  return value === 'recent' ? 'recent' : 'similarity'
}

export function normalizeHistoricalAnalogRecency(
  value: string | null | undefined,
): HistoricalAnalogRecency {
  if (value === '2w' || value === '1m' || value === '3m') return value
  return 'all'
}

export function normalizeHistoricalAnalogProfile(
  value: string | null | undefined,
): HistoricalAnalogProfile {
  if (value === 'short' || value === 'long') return value
  return 'balanced'
}

export function historicalAnalogProfileConfig(
  profile: HistoricalAnalogProfile,
): HistoricalAnalogProfileConfig {
  return HISTORICAL_ANALOG_PROFILES.find((item) => item.key === profile)
    ?? HISTORICAL_ANALOG_PROFILES[0]
}

export function requiredHistoricalAnalogComponents(
  available: readonly string[],
): HistoricalAnalogTimeframe[] {
  const required = HISTORICAL_ANALOG_TIMEFRAMES.filter((timeframe) =>
    available.includes(timeframe),
  )
  return required.includes('daily') && required.includes('weekly') ? required : []
}

export function historicalAnalogRecencyDays(recency: HistoricalAnalogRecency): number | null {
  if (recency === '2w') return 14
  if (recency === '1m') return 31
  if (recency === '3m') return 92
  return null
}

export function calendarDaysBetween(fromDate: string, toDate: string): number {
  const from = parseUtcDate(fromDate)
  const to = parseUtcDate(toDate)
  if (!finite(from) || !finite(to)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor((to - from) / DAY_MS))
}

export function historicalAnalogRecencyBucket(
  elapsedDays: number,
): Exclude<HistoricalAnalogRecency, 'all'> | 'older' {
  if (elapsedDays <= 14) return '2w'
  if (elapsedDays <= 31) return '1m'
  if (elapsedDays <= 92) return '3m'
  return 'older'
}

export function paginateHistoricalAnalogRows<T>(
  rows: readonly T[],
  offset: number,
  limit: number,
): {
  rows: T[]
  offset: number
  limit: number
  hasMore: boolean
  nextOffset: number | null
} {
  const safeOffset = Math.max(0, Math.floor(offset))
  const safeLimit = Math.max(1, Math.floor(limit))
  const pageRows = rows.slice(safeOffset, safeOffset + safeLimit)
  const nextOffset = safeOffset + pageRows.length
  const hasMore = nextOffset < rows.length
  return {
    rows: pageRows,
    offset: safeOffset,
    limit: safeLimit,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  }
}

export function isWithinHistoricalAnalogRecency(
  candidateEndDate: string,
  latestMarketDate: string,
  recency: HistoricalAnalogRecency,
): boolean {
  const maxDays = historicalAnalogRecencyDays(recency)
  return maxDays == null || calendarDaysBetween(candidateEndDate, latestMarketDate) <= maxDays
}

export type HistoricalAnalogCandidateRole = 'start' | 'middle' | 'end'

export type HistoricalAnalogShortlistCandidate = {
  ticker: string
  date: string
  baseOffsetSessions: number
  sourceRole: HistoricalAnalogCandidateRole
}

export type HistoricalAnalogShortlistDiagnostics = {
  policy: 'global-stage-first' | 'recency-first'
  totalLimit: number
  recencyTarget: number
  recencyPoolCount: number
  recencyShortlistCount: number
  stagePoolCount: number
  stageShortlistCount: number
  fallbackShortlistCount: number
}

type HistoricalAnalogShortlistOptions = {
  latestMarketDate: string
  recency: HistoricalAnalogRecency
  periodSessions: number
  resultLimit: number
  totalLimit: number
  stageLimit: number
  recencyLimit: number
  maxAnchorsPerTicker: number
  minimumSpacingDays?: number
}

function subtractCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

export function historicalAnalogRecencyShortlistTarget(
  recency: HistoricalAnalogRecency,
  resultLimit: number,
  totalLimit: number,
  recencyLimit: number,
): number {
  if (recency === 'all') return 0
  const resultDriven = Math.max(1, Math.floor(resultLimit)) * 6
  const poolDriven = Math.ceil(Math.max(1, Math.floor(totalLimit)) * 0.55)
  return Math.min(
    Math.max(1, Math.floor(totalLimit)),
    Math.max(1, Math.floor(recencyLimit)),
    Math.max(resultDriven, poolDriven),
  )
}

export function buildHistoricalAnalogShortlist<
  T extends HistoricalAnalogShortlistCandidate,
>(
  stageCandidates: readonly T[],
  approximateCandidates: readonly T[],
  options: HistoricalAnalogShortlistOptions,
): { rows: T[]; diagnostics: HistoricalAnalogShortlistDiagnostics } {
  const totalLimit = Math.max(1, Math.floor(options.totalLimit))
  const stageLimit = Math.max(0, Math.floor(options.stageLimit))
  const maxAnchorsPerTicker = Math.max(1, Math.floor(options.maxAnchorsPerTicker))
  const minimumSpacingMs = Math.max(0, options.minimumSpacingDays ?? 12) * DAY_MS
  const recencyTarget = historicalAnalogRecencyShortlistTarget(
    options.recency,
    options.resultLimit,
    totalLimit,
    options.recencyLimit,
  )
  const selected: T[] = []
  const priorAnchors = new Map<string, T[]>()
  const appendCandidate = (row: T): boolean => {
    if (selected.length >= totalLimit) return false
    const prior = priorAnchors.get(row.ticker) ?? []
    if (prior.length >= maxAnchorsPerTicker) return false
    const currentTime = parseUtcDate(row.date)
    if (prior.some((anchor) =>
      Math.abs(currentTime - parseUtcDate(anchor.date)) < minimumSpacingMs
      && Math.abs(anchor.baseOffsetSessions - row.baseOffsetSessions) < 10,
    )) return false
    selected.push(row)
    priorAnchors.set(row.ticker, [...prior, row])
    return true
  }

  const recencyPool = options.recency === 'all'
    ? []
    : approximateCandidates.filter((row) =>
        row.sourceRole === 'end'
        && isWithinHistoricalAnalogRecency(
          row.date,
          options.latestMarketDate,
          options.recency,
        ),
      )
  let recencyShortlistCount = 0
  for (const row of recencyPool) {
    if (appendCandidate(row)) recencyShortlistCount += 1
    if (recencyShortlistCount >= recencyTarget || selected.length >= totalLimit) break
  }

  const stagePool = options.recency === 'all'
    ? stageCandidates
    : stageCandidates.filter((row) =>
        isWithinHistoricalAnalogRecency(
          row.date,
          options.latestMarketDate,
          options.recency,
        ),
      )
  let stageShortlistCount = 0
  for (const row of stagePool) {
    if (appendCandidate(row)) stageShortlistCount += 1
    if (stageShortlistCount >= stageLimit || selected.length >= totalLimit) break
  }

  const recencyDays = historicalAnalogRecencyDays(options.recency)
  const potentialAnchorFloor = recencyDays == null
    ? null
    : subtractCalendarDays(
        options.latestMarketDate,
        recencyDays + Math.max(60, Math.ceil(options.periodSessions * 2.1)),
      )
  let fallbackShortlistCount = 0
  for (const row of approximateCandidates) {
    if (selected.length >= totalLimit) break
    if (
      potentialAnchorFloor
      && (
        row.sourceRole === 'end'
          ? !isWithinHistoricalAnalogRecency(
              row.date,
              options.latestMarketDate,
              options.recency,
            )
          : row.date < potentialAnchorFloor
      )
    ) continue
    if (appendCandidate(row)) fallbackShortlistCount += 1
  }

  return {
    rows: selected,
    diagnostics: {
      policy: options.recency === 'all' ? 'global-stage-first' : 'recency-first',
      totalLimit,
      recencyTarget,
      recencyPoolCount: recencyPool.length,
      recencyShortlistCount,
      stagePoolCount: stagePool.length,
      stageShortlistCount,
      fallbackShortlistCount,
    },
  }
}

export function dateRangesOverlap(
  firstStart: string,
  firstEnd: string,
  secondStart: string,
  secondEnd: string,
): boolean {
  return firstStart <= secondEnd && secondStart <= firstEnd
}

export function stageNeighborCodes(stageCode: string | null | undefined, maxDistance = 1): string[] {
  if (!stageCode || !/^[1-6]{5,6}$/.test(stageCode)) return stageCode ? [stageCode] : []
  const seen = new Set<string>([stageCode])
  let frontier = [stageCode]
  for (let distance = 1; distance <= maxDistance; distance += 1) {
    const next: string[] = []
    for (const code of frontier) {
      for (let position = 0; position < code.length; position += 1) {
        for (let stage = 1; stage <= 6; stage += 1) {
          const replacement = String(stage)
          if (replacement === code[position]) continue
          const candidate = `${code.slice(0, position)}${replacement}${code.slice(position + 1)}`
          if (seen.has(candidate)) continue
          seen.add(candidate)
          next.push(candidate)
        }
      }
    }
    frontier = next
  }
  return [...seen]
}

export function normalizedVectorSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  if (length === 0) return 0
  let squared = 0
  let used = 0
  for (let index = 0; index < length; index += 1) {
    if (!finite(a[index]) || !finite(b[index])) continue
    const delta = a[index] - b[index]
    squared += delta * delta
    used += 1
  }
  if (used === 0) return 0
  const rmse = Math.sqrt(squared / used)
  return Math.max(0, Math.min(1, Math.exp(-1.8 * rmse)))
}

export function weightedVectorSequenceSimilarity(
  base: Array<number[] | null>,
  candidate: Array<number[] | null>,
  weights: number[] = [0.25, 0.3, 0.45],
): number | null {
  return weightedVectorSequenceSimilarityDetails(base, candidate, weights)?.score ?? null
}

export function weightedVectorSequenceSimilarityDetails(
  base: Array<number[] | null>,
  candidate: Array<number[] | null>,
  weights: number[] = [0.25, 0.3, 0.45],
): { score: number; pointCount: number; totalPoints: number } | null {
  const length = Math.min(base.length, candidate.length, weights.length)
  let weighted = 0
  let totalWeight = 0
  let pointCount = 0
  for (let index = 0; index < length; index += 1) {
    const baseVector = base[index]
    const candidateVector = candidate[index]
    const weight = weights[index]
    if (!baseVector?.length || !candidateVector?.length || !finite(weight) || weight <= 0) continue
    weighted += normalizedVectorSimilarity(baseVector, candidateVector) * weight
    totalWeight += weight
    pointCount += 1
  }
  return totalWeight > 0
    ? { score: weighted / totalWeight, pointCount, totalPoints: length }
    : null
}

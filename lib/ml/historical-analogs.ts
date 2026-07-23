import { physicsSimilarity, type PhysicsSimilarityComponent } from '@/lib/ml/physics-similarity'

export const HISTORICAL_ANALOG_HORIZONS = [5, 10, 15, 20, 40, 60, 90, 200] as const

export type HistoricalAnalogHorizon = typeof HISTORICAL_ANALOG_HORIZONS[number]
export type HistoricalAnalogSort = 'similarity' | 'return_desc' | 'return_asc' | 'max_return' | 'min_return'

export type HistoricalAnalogCandidate = {
  ticker: string
  date: string
  stageCode: string | null
  featureJson: string
  vectorJson: string
  name: string | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  returnPct: number | null
  maxReturnPct: number | null
  minReturnPct: number | null
}

export type ScoredHistoricalAnalog = HistoricalAnalogCandidate & {
  similarityScore: number
  structuralScore: number
  vectorScore: number
  components: PhysicsSimilarityComponent[]
  reason: Record<string, string>
}

type MaybeProfile = Record<string, any>

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isHistoricalAnalogHorizon(value: number): value is HistoricalAnalogHorizon {
  return HISTORICAL_ANALOG_HORIZONS.includes(value as HistoricalAnalogHorizon)
}

export function normalizeHistoricalAnalogSort(value: string | null | undefined): HistoricalAnalogSort {
  if (value === 'return_desc' || value === 'return_asc' || value === 'max_return' || value === 'min_return') return value
  return 'similarity'
}

export function stageNeighborCodes(stageCode: string | null | undefined, maxDistance = 1): string[] {
  if (!stageCode || !/^[1-6]{6}$/.test(stageCode)) return stageCode ? [stageCode] : []
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

export function scoreHistoricalAnalog(
  base: { stageCode: string | null; profile: MaybeProfile; vector: number[] },
  candidate: HistoricalAnalogCandidate,
): ScoredHistoricalAnalog | null {
  const profile = parseJson<MaybeProfile | null>(candidate.featureJson, null)
  const vector = parseJson<number[]>(candidate.vectorJson, [])
  if (!profile || vector.length === 0) return null
  const structural = physicsSimilarity(base.profile, profile, base.stageCode, candidate.stageCode)
  const vectorScore = normalizedVectorSimilarity(base.vector, vector)
  const similarityScore = Math.min(0.999, Math.max(0, structural.score * 0.85 + vectorScore * 0.15))
  return {
    ...candidate,
    similarityScore,
    structuralScore: structural.score,
    vectorScore,
    components: structural.components,
    reason: structural.reason,
  }
}

function comparable(value: number | null, fallback: number): number {
  return finite(value) ? value : fallback
}

export function sortHistoricalAnalogs(rows: ScoredHistoricalAnalog[], sort: HistoricalAnalogSort): ScoredHistoricalAnalog[] {
  return [...rows].sort((a, b) => {
    if (sort === 'return_desc') return comparable(b.returnPct, -Infinity) - comparable(a.returnPct, -Infinity)
    if (sort === 'return_asc') return comparable(a.returnPct, Infinity) - comparable(b.returnPct, Infinity)
    if (sort === 'max_return') return comparable(b.maxReturnPct, -Infinity) - comparable(a.maxReturnPct, -Infinity)
    if (sort === 'min_return') return comparable(a.minReturnPct, Infinity) - comparable(b.minReturnPct, Infinity)
    return b.similarityScore - a.similarityScore
  })
}

export function diversifyHistoricalAnalogs(rows: ScoredHistoricalAnalog[], limit: number): ScoredHistoricalAnalog[] {
  const selected: ScoredHistoricalAnalog[] = []
  const tickerDates = new Map<string, string[]>()
  for (const row of rows) {
    const priorDates = tickerDates.get(row.ticker) ?? []
    const candidateTime = Date.parse(`${row.date}T00:00:00Z`)
    const tooClose = priorDates.some((date) => Math.abs(candidateTime - Date.parse(`${date}T00:00:00Z`)) < 21 * 86_400_000)
    if (tooClose) continue
    selected.push(row)
    tickerDates.set(row.ticker, [...priorDates, row.date])
    if (selected.length >= limit) break
  }
  return selected
}

export function topHistoricalAnalogComponents(components: PhysicsSimilarityComponent[], limit = 4): PhysicsSimilarityComponent[] {
  return [...components]
    .sort((a, b) => (b.score * b.weight) - (a.score * a.weight))
    .slice(0, limit)
}

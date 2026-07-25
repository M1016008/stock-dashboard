import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet } from '@/lib/db/us-analytics'
import { readServingCache, stableCacheKey, writeServingCache } from '@/lib/api/serving-cache'
import {
  assertAnalogSequenceIndexReady,
  searchAnalogSequenceIndex,
  searchAnalogSequenceIndexByStage,
  type AnalogSequenceIndexRow,
  type AnalogSequenceMarket,
} from '@/lib/db/analog-sequence-index'
import {
  MA_SEQUENCE_MONTHLY_PERIODS,
  MA_SEQUENCE_PERIODS,
  MA_SEQUENCE_SCORE_VERSION,
  MA_SEQUENCE_VERSION,
  MA_SEQUENCE_WEEKLY_PERIODS,
  MA_SEQUENCE_YEARLY_PERIODS,
  buildMaSequenceEmbedding,
  findMaSequenceIndex,
  maSequenceEmbeddingRangesForCoverage,
  maSequenceEmbeddingSimilarityRanges,
  prepareMaSequence,
  scoreMaSequenceRange,
  scoreMaSequenceRangeAligned,
  stageCodeAt,
  type MaSequencePrepared,
  type MaSequencePriceRow,
  type MaSequenceRangeComponent,
} from '@/lib/ml/ma-sequence'
import {
  buildHistoricalAnalogShortlist,
  calendarDaysBetween,
  dateRangesOverlap,
  historicalAnalogProfileConfig,
  historicalAnalogRecencyBucket,
  isWithinHistoricalAnalogRecency,
  normalizeHistoricalAnalogProfile,
  normalizeHistoricalAnalogRecency,
  normalizeHistoricalAnalogSort,
  requiredHistoricalAnalogComponents,
  stageNeighborCodes,
  weightedVectorSequenceSimilarityDetails,
  type HistoricalAnalogSort,
} from '@/lib/ml/historical-analogs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CACHE_NAMESPACE = 'historical_analogs_period_v10'
const CACHE_TTL_MS = boundedEnv(
  'HISTORICAL_ANALOG_CACHE_TTL_MS',
  24 * 60 * 60 * 1_000,
  60_000,
  24 * 60 * 60 * 1_000,
)
const APPROXIMATE_LIMIT = boundedEnv('ANALOG_SEQUENCE_APPROXIMATE_LIMIT', 450, 150, 900)
const MAX_ANCHORS_PER_TICKER = 4
const LOCAL_ALIGNED_LIMIT = 2
const LOCAL_ALIGNED_RADIUS = 8
const STAGE_SHORTLIST_LIMIT = 120
const RECENCY_SHORTLIST_LIMIT = boundedEnv('ANALOG_SEQUENCE_RECENCY_SHORTLIST_LIMIT', 260, 50, 350)
const ML_RERANK_WEIGHT = 0.1
const CANDIDATE_HISTORY_DAYS = 4_300
const CANDIDATE_FUTURE_DAYS = 500
const MIN_PERIOD_SESSIONS = 5
const MAX_PERIOD_SESSIONS = 250
const PRESENTATION_CONTEXT_BEFORE = 35
const PRESENTATION_CONTEXT_AFTER = 18
const CACHE_MAX_ENTRIES = 80
const CORE_CACHE_MAX_ENTRIES = 8
const DAY_MS = 86_400_000

const responseCache = new Map<string, { generatedAt: number; payload: Record<string, unknown> }>()
const coreSearchCache = new Map<string, {
  generatedAt: number
  exactRanked: ExactCandidate[]
  search: SearchDiagnostics
}>()
const globalForHistoricalAnalogs = global as unknown as {
  historicalAnalogSearchTail?: Promise<void>
  historicalAnalogSearchDepth?: number
}

type Market = AnalogSequenceMarket
type DbArgs = readonly (string | number | null)[]

type PriceRow = MaSequencePriceRow & {
  ticker: string
}

type UniverseRow = {
  ticker: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
  margin_type: string | null
}

type VectorRow = {
  candidate_key: string
  point_index: number
  vector_json: string
  version: number
}

type DateRow = {
  date: string | null
}

type VectorScore = {
  score: number
  pointCount: number
  totalPoints: number
}

type VersionedVector = {
  vector: number[]
  version: number
}

type ScoreComponent = {
  key: string
  label: string
  score: number
  weight: number
  available: boolean
}

type ExactCandidate = {
  ticker: string
  startDate: string
  middleDate: string
  endDate: string
  score: number
  dailyScore: number | null
  weeklyScore: number | null
  monthlyScore: number | null
  yearlyScore: number | null
  mlFeatureScore: number | null
  mlFeaturePointCount: number
  mlFeatureTotalPoints: number
  components: ScoreComponent[]
  approximationScore: number
  bandMatches: number
  stageCode: string | null
}

type IndexedAnchor = AnalogSequenceIndexRow & {
  approximationScore: number
  baseOffsetSessions: number
  sourceRole: 'start' | 'middle' | 'end'
}

type CandidateRange = {
  ticker: string
  fromDate: string
  toDate: string
}

type SearchDiagnostics = {
  method: string
  maPeriods: readonly number[]
  maPeriodsByTimeframe: {
    daily: readonly number[]
    weekly: readonly number[]
    monthly: readonly number[]
    yearly: readonly number[]
  }
  periodSessions: number
  higherTimeframes: string[]
  scoringProfile: {
    key: string
    label: string
    weights: {
      daily: number
      weekly: number
      monthly: number
      yearly: number
    }
  }
  mlRerankWeight: number
  indexedCandidateCount: number
  coverageRejectedCount: number
  exactCoverageRejectedCount: number
  requiredComponents: string[]
  approximateCount: number
  stageCandidateCount: number
  stageShortlistCount: number
  retrievalPolicy: 'global-stage-first' | 'recency-first'
  recencyShortlistTarget: number
  recencyPoolCount: number
  recencyShortlistCount: number
  recencyStagePoolCount: number
  fallbackShortlistCount: number
  candidateRangeCount: number
  candidatePriceRowCount: number
  alignedCount: number
  dtwRerankCount: number
  scoredCount: number
  coverageFrom: string | null
  coverageTo: string | null
  indexSourceDate: string | null
  indexRows: number
  indexVersion: number
  indexFeatureSchema: string | null
  indexEmbeddingBytes: number | null
  truncated: boolean
}

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validIsoDate(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function normalizeMarket(value: string | null): Market | null {
  if (value == null || value.toUpperCase() === 'JP') return 'JP'
  if (value.toUpperCase() === 'US') return 'US'
  return null
}

function normalizeTicker(value: string | null, market: Market): string | null {
  const normalized = value?.trim().toUpperCase().replace(/\.T$/i, '') ?? ''
  if (!normalized) return null
  if (market === 'JP') return /^\d{4}$/.test(normalized) ? normalized : null
  return /^[A-Z0-9.^-]{1,16}$/.test(normalized) ? normalized : null
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function subtractCalendarDays(date: string, days: number): string {
  return addCalendarDays(date, -days)
}

function createDbAdapter(market: Market) {
  return market === 'US'
    ? {
        all: <T>(sql: string, args: DbArgs = []) => execUsAnalyticsAll<T>(sql, args),
        get: <T>(sql: string, args: DbArgs = []) => execUsAnalyticsGet<T>(sql, args),
      }
    : {
        all: <T>(sql: string, args: DbArgs = []) => execAll<T>(sql, args),
        get: <T>(sql: string, args: DbArgs = []) => execGet<T>(sql, args),
      }
}

async function proxyToAnalogWorker(request: NextRequest): Promise<NextResponse | null> {
  const proxyUrl = process.env.ANALOG_SEARCH_PROXY_URL?.trim()
  if (!proxyUrl || process.env.ANALOG_SEARCH_WORKER === '1') return null
  try {
    const target = new URL(`${request.nextUrl.pathname}${request.nextUrl.search}`, proxyUrl)
    const response = await fetch(target, {
      cache: 'no-store',
      signal: AbortSignal.timeout(120_000),
    })
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    console.error('historical analog worker proxy failed:', error)
    return NextResponse.json(
      { error: '類似局面検索ワーカーが応答していません。自動再起動後に再試行してください。' },
      { status: 503 },
    )
  }
}

function logSearchPhase(
  market: Market,
  ticker: string,
  phase: string,
  startedAt: number,
): number {
  const completedAt = Date.now()
  const elapsedMs = completedAt - startedAt
  if (elapsedMs >= 2_000 || process.env.ANALOG_SEARCH_PHASE_LOGS === '1') {
    console.info(`[historical-analogs] ${market}:${ticker} ${phase} ${elapsedMs}ms`)
  }
  return completedAt
}

async function acquireSearchSlot(): Promise<() => void> {
  const prior = globalForHistoricalAnalogs.historicalAnalogSearchTail ?? Promise.resolve()
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  globalForHistoricalAnalogs.historicalAnalogSearchTail = prior
    .catch(() => undefined)
    .then(() => current)
  globalForHistoricalAnalogs.historicalAnalogSearchDepth =
    (globalForHistoricalAnalogs.historicalAnalogSearchDepth ?? 0) + 1
  await prior.catch(() => undefined)
  let released = false
  return () => {
    if (released) return
    released = true
    globalForHistoricalAnalogs.historicalAnalogSearchDepth = Math.max(
      0,
      (globalForHistoricalAnalogs.historicalAnalogSearchDepth ?? 1) - 1,
    )
    releaseCurrent()
  }
}

function normalizePriceRows(rows: PriceRow[]): PriceRow[] {
  const normalized: PriceRow[] = []
  for (const row of rows) {
    const ticker = String(row.ticker)
    const date = String(row.date)
    const close = Number(row.close)
    if (!date || !finite(close) || close <= 0) continue
    const optionalPrice = (value: unknown): number | null => {
      const parsed = Number(value)
      return finite(parsed) && parsed > 0 ? parsed : null
    }
    const optionalVolume = (value: unknown): number | null => {
      const parsed = Number(value)
      return finite(parsed) && parsed >= 0 ? parsed : null
    }
    normalized.push({
      ticker,
      date,
      close,
      open: optionalPrice(row.open),
      high: optionalPrice(row.high),
      low: optionalPrice(row.low),
      volume: optionalVolume(row.volume),
    })
  }
  return normalized
}

function splitContinuous(rows: PriceRow[], maxGapDays = 60): PriceRow[][] {
  if (rows.length === 0) return []
  const output: PriceRow[][] = []
  let current = [rows[0]]
  for (let index = 1; index < rows.length; index += 1) {
    const from = Date.parse(`${rows[index - 1].date}T00:00:00Z`)
    const to = Date.parse(`${rows[index].date}T00:00:00Z`)
    if ((to - from) / DAY_MS > maxGapDays) {
      output.push(current)
      current = []
    }
    current.push(rows[index])
  }
  output.push(current)
  return output
}

function buildPreparedSegments(rows: PriceRow[]): MaSequencePrepared[] {
  return splitContinuous(rows)
    .map((segment) => prepareMaSequence(segment))
    .filter((prepared) => prepared.rows.length > 240)
}

function findPreparedSegment(
  segments: MaSequencePrepared[],
  date: string,
): { prepared: MaSequencePrepared; index: number } | null {
  for (const prepared of segments) {
    const first = prepared.rows[0]?.date
    const last = prepared.rows.at(-1)?.date
    if (!first || !last || date < first || date > last) continue
    const index = findMaSequenceIndex(prepared, date)
    if (index >= 0) return { prepared, index }
  }
  return null
}

function findPreparedSegmentAtOrBefore(
  segments: MaSequencePrepared[],
  date: string,
): { prepared: MaSequencePrepared; index: number } | null {
  for (let segmentIndex = segments.length - 1; segmentIndex >= 0; segmentIndex -= 1) {
    const prepared = segments[segmentIndex]
    const first = prepared.rows[0]?.date
    if (!first || date < first) continue
    const index = findMaSequenceIndex(prepared, date)
    if (index >= 0) return { prepared, index }
  }
  return null
}

function firstIndexAtOrAfter(prepared: MaSequencePrepared, date: string): number {
  let low = 0
  let high = prepared.rows.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (prepared.rows[middle].date < date) low = middle + 1
    else high = middle
  }
  return low < prepared.rows.length ? low : -1
}

function compactStagePath(
  prepared: MaSequencePrepared,
  startIndex: number,
  endIndex: number,
) {
  const path: Array<{ relativeDay: number; date: string; stageCode: string }> = []
  let previous: string | null = null
  for (let index = startIndex; index <= endIndex; index += 1) {
    const code = stageCodeAt(prepared, index)
    if (!code || code === previous) continue
    path.push({
      relativeDay: index - startIndex,
      date: prepared.rows[index].date,
      stageCode: code,
    })
    previous = code
  }
  return path
}

function buildRangeWindow(
  prepared: MaSequencePrepared,
  startIndex: number,
  endIndex: number,
) {
  const rows: Array<Record<string, number | string | null>> = []
  const fromIndex = Math.max(0, startIndex - PRESENTATION_CONTEXT_BEFORE)
  const toIndex = Math.min(
    prepared.rows.length - 1,
    endIndex + PRESENTATION_CONTEXT_AFTER,
  )
  for (let index = fromIndex; index <= toIndex; index += 1) {
    const row = prepared.rows[index]
    const point: Record<string, number | string | null> = {
      relativeDay: index - startIndex,
      date: row.date,
      open: finite(row.open) ? row.open : null,
      high: finite(row.high) ? row.high : null,
      low: finite(row.low) ? row.low : null,
      close: row.close,
      volume: finite(row.volume) ? row.volume : null,
    }
    MA_SEQUENCE_PERIODS.forEach((period, periodIndex) => {
      const value = prepared.daily.mas[periodIndex][index]
      point[`ma${period}`] = finite(value) ? value : null
    })
    rows.push(point)
  }
  return rows
}

function buildVolumeSnapshot(prepared: MaSequencePrepared, endIndex: number) {
  const volume = prepared.rows[endIndex]?.volume
  const observations = prepared.rows
    .slice(Math.max(0, endIndex - 29), endIndex + 1)
    .map((row) => row.volume)
    .filter((value): value is number => finite(value) && value >= 0)
  const avgVolume30 = observations.length > 0
    ? observations.reduce((sum, value) => sum + value, 0) / observations.length
    : null
  return {
    volume: finite(volume) && volume >= 0 ? volume : null,
    avgVolume30,
    volumeObservationCount: observations.length,
    volumeRatio30: finite(volume) && volume >= 0 && avgVolume30 != null && avgVolume30 > 0
      ? volume / avgVolume30
      : null,
  }
}

function buildCandidateRanges(
  anchors: IndexedAnchor[],
  latestMarketDate: string,
): CandidateRange[] {
  const requested = anchors
    .map((anchor) => ({
      ticker: anchor.ticker,
      fromDate: subtractCalendarDays(anchor.date, CANDIDATE_HISTORY_DAYS),
      toDate: [latestMarketDate, addCalendarDays(anchor.date, CANDIDATE_FUTURE_DAYS)].sort()[0],
    }))
    .sort((a, b) =>
      a.ticker.localeCompare(b.ticker)
      || a.fromDate.localeCompare(b.fromDate),
    )
  const merged: CandidateRange[] = []
  for (const range of requested) {
    const prior = merged.at(-1)
    if (prior && prior.ticker === range.ticker && range.fromDate <= prior.toDate) {
      if (range.toDate > prior.toDate) prior.toDate = range.toDate
      continue
    }
    merged.push({ ...range })
  }
  return merged
}

function componentReasons(components: ScoreComponent[]) {
  const order = new Map([
    ['daily', 0],
    ['weekly', 1],
    ['monthly', 2],
    ['yearly', 3],
    ['mlFeatures', 4],
  ])
  return components
    .filter((component) => component.available)
    .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99))
    .map((component) => ({
      key: component.key,
      label: component.label,
      score: component.score,
      weight: component.weight,
    }))
}

function parseVector(value: string | null | undefined): number[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function vectorCandidateKey(row: Pick<ExactCandidate, 'ticker' | 'startDate' | 'endDate'>): string {
  return `${row.ticker}|${row.startDate}|${row.endDate}`
}

function boundedRequestNumber(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
  integer = false,
): number | null {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  const bounded = Math.min(max, Math.max(min, parsed))
  return integer ? Math.floor(bounded) : bounded
}

async function loadVectorScores(
  db: ReturnType<typeof createDbAdapter>,
  baseTicker: string,
  baseDates: readonly [string, string, string],
  candidates: ExactCandidate[],
): Promise<Map<string, VectorScore>> {
  const baseRows = await db.all<{ date: string; vector_json: string; version: number }>(
    `
    SELECT date, vector_json, version
    FROM ml_feature_vectors_v2
    WHERE feature_set = 'ma_physics_v4'
      AND ticker = ?
      AND date IN (?, ?, ?)
    `,
    [baseTicker, ...baseDates],
  )
  const baseByDate = new Map(baseRows.map((row) => [
    row.date,
    { vector: parseVector(row.vector_json), version: Number(row.version) },
  ]))
  const basePoints = baseDates.map((date) => baseByDate.get(date) ?? null)
  if (basePoints.every((point) => !point?.vector.length)) return new Map()
  const scores = new Map<string, VectorScore>()
  for (let offset = 0; offset < candidates.length; offset += 50) {
    const chunk = candidates.slice(offset, offset + 50)
    if (chunk.length === 0) continue
    const targets = chunk.flatMap((row) => {
      const key = vectorCandidateKey(row)
      return [
        { key, ticker: row.ticker, date: row.startDate, pointIndex: 0 },
        { key, ticker: row.ticker, date: row.middleDate, pointIndex: 1 },
        { key, ticker: row.ticker, date: row.endDate, pointIndex: 2 },
      ]
    })
    const values = targets.map(() => '(?, ?, ?, ?)').join(', ')
    const args = targets.flatMap((row) => [row.key, row.ticker, row.date, row.pointIndex])
    const rows = await db.all<VectorRow>(
      `
      WITH targets(candidate_key, ticker, date, point_index) AS (VALUES ${values})
      SELECT t.candidate_key, t.point_index, f.vector_json, f.version
      FROM ml_feature_vectors_v2 f
      INNER JOIN targets t
        ON t.ticker = f.ticker
       AND t.date = f.date
      WHERE f.feature_set = 'ma_physics_v4'
      `,
      args,
    )
    const vectorsByCandidate = new Map<string, Array<VersionedVector | null>>()
    for (const row of rows) {
      const vector = parseVector(row.vector_json)
      if (vector.length === 0) continue
      const points = vectorsByCandidate.get(row.candidate_key) ?? [null, null, null]
      points[Number(row.point_index)] = { vector, version: Number(row.version) }
      vectorsByCandidate.set(row.candidate_key, points)
    }
    for (const [key, candidatePoints] of vectorsByCandidate) {
      const baseVectors = basePoints.map((basePoint, index) => {
        const candidatePoint = candidatePoints[index]
        return basePoint && candidatePoint && basePoint.version === candidatePoint.version
          ? basePoint.vector
          : null
      })
      const candidateVectors = candidatePoints.map((candidatePoint, index) =>
        baseVectors[index] ? candidatePoint?.vector ?? null : null
      )
      const score = weightedVectorSequenceSimilarityDetails(baseVectors, candidateVectors)
      if (score) scores.set(key, score)
    }
  }
  return scores
}

async function loadTickerMetadata(
  db: ReturnType<typeof createDbAdapter>,
  tickers: string[],
): Promise<Map<string, UniverseRow>> {
  if (tickers.length === 0) return new Map()
  const unique = [...new Set(tickers)]
  const placeholders = unique.map(() => '?').join(', ')
  const rows = await db.all<UniverseRow>(
    `
    SELECT ticker, name, market_segment, sector17_name, sector33_name, margin_type
    FROM ticker_universe
    WHERE ticker IN (${placeholders})
    `,
    unique,
  )
  return new Map(rows.map((row) => [row.ticker, row]))
}

async function loadPresentations(
  db: ReturnType<typeof createDbAdapter>,
  rows: ExactCandidate[],
) {
  const output = new Map<string, {
    window: ReturnType<typeof buildRangeWindow>
    stagePath: ReturnType<typeof compactStagePath>
    volume: number | null
    avgVolume30: number | null
    volumeRatio30: number | null
    volumeObservationCount: number
  }>()
  const byTicker = new Map<string, ExactCandidate[]>()
  for (const row of rows) {
    const tickerRows = byTicker.get(row.ticker) ?? []
    tickerRows.push(row)
    byTicker.set(row.ticker, tickerRows)
  }
  for (const [ticker, tickerRows] of byTicker) {
    const fromDate = subtractCalendarDays(
      tickerRows.map((row) => row.startDate).sort()[0],
      520,
    )
    const toDate = addCalendarDays(
      tickerRows.map((row) => row.endDate).sort().at(-1)!,
      45,
    )
    const prices = normalizePriceRows(await db.all<PriceRow>(
      `
      SELECT ticker, date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
        AND date >= ?
        AND date <= ?
      ORDER BY date
      `,
      [ticker, fromDate, toDate],
    ))
    const segments = buildPreparedSegments(prices)
    for (const row of tickerRows) {
      const located = findPreparedSegment(segments, row.endDate)
      if (!located) continue
      const startIndex = findMaSequenceIndex(located.prepared, row.startDate)
      if (startIndex < 0 || located.prepared.rows[startIndex]?.date !== row.startDate) continue
      const key = `${row.ticker}\u0000${row.startDate}\u0000${row.endDate}`
      const volumeSnapshot = buildVolumeSnapshot(located.prepared, located.index)
      output.set(key, {
        window: buildRangeWindow(located.prepared, startIndex, located.index),
        stagePath: compactStagePath(located.prepared, startIndex, located.index),
        ...volumeSnapshot,
      })
    }
  }
  return output
}

function sortExact(rows: ExactCandidate[], sort: HistoricalAnalogSort, latestMarketDate: string) {
  return [...rows].sort((a, b) => {
    if (sort === 'recent') {
      return calendarDaysBetween(a.endDate, latestMarketDate)
        - calendarDaysBetween(b.endDate, latestMarketDate)
        || b.score - a.score
    }
    return b.score - a.score || b.endDate.localeCompare(a.endDate)
  })
}

function diversify(
  rows: ExactCandidate[],
  limit: number,
  minimumSpacingDays: number,
): ExactCandidate[] {
  const selected: ExactCandidate[] = []
  const tickerDates = new Map<string, string[]>()
  for (const row of rows) {
    const priorDates = tickerDates.get(row.ticker) ?? []
    if (priorDates.length >= 2) continue
    const candidateTime = Date.parse(`${row.endDate}T00:00:00Z`)
    const tooClose = priorDates.some((date) =>
      Math.abs(candidateTime - Date.parse(`${date}T00:00:00Z`))
        < minimumSpacingDays * DAY_MS,
    )
    if (tooClose) continue
    selected.push(row)
    tickerDates.set(row.ticker, [...priorDates, row.endDate])
    if (selected.length >= limit) break
  }
  return selected
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function coverageKeys(components: MaSequenceRangeComponent[]): string[] {
  return components.filter((component) => component.available).map((component) => component.key)
}

export async function GET(request: NextRequest) {
  const proxied = await proxyToAnalogWorker(request)
  if (proxied) return proxied
  try {
    const params = request.nextUrl.searchParams
    const market = normalizeMarket(params.get('market'))
    if (!market) {
      return NextResponse.json(
        { error: '市場はJPまたはUSを指定してください。' },
        { status: 400 },
      )
    }
    const ticker = normalizeTicker(params.get('ticker'), market)
    if (!ticker) {
      return NextResponse.json({ error: '有効な銘柄コードを指定してください。' }, { status: 400 })
    }
    const requestedStartDate = params.get('startDate')
    const requestedEndDate = params.get('endDate')
    if (!validIsoDate(requestedStartDate) || !validIsoDate(requestedEndDate)) {
      return NextResponse.json(
        { error: '分析対象の開始日と終了日を指定してください。' },
        { status: 400 },
      )
    }
    if (requestedStartDate > requestedEndDate) {
      return NextResponse.json(
        { error: '開始日は終了日以前の日付を指定してください。' },
        { status: 400 },
      )
    }

    const requestedSort = params.get('sort')
    const requestedRecency = params.get('recency')
    const requestedProfile = params.get('profile')
    if (requestedSort && requestedSort !== 'similarity' && requestedSort !== 'recent') {
      return NextResponse.json({ error: '有効な並び順を指定してください。' }, { status: 400 })
    }
    if (
      requestedRecency
      && !['all', '2w', '1m', '3m'].includes(requestedRecency)
    ) {
      return NextResponse.json({ error: '有効な発生時期を指定してください。' }, { status: 400 })
    }
    if (
      requestedProfile
      && !['balanced', 'short', 'long'].includes(requestedProfile)
    ) {
      return NextResponse.json({ error: '比較で重視する時間軸を正しく指定してください。' }, { status: 400 })
    }
    const sort = normalizeHistoricalAnalogSort(requestedSort)
    const recency = normalizeHistoricalAnalogRecency(requestedRecency)
    const profile = normalizeHistoricalAnalogProfile(requestedProfile)
    const profileConfig = historicalAnalogProfileConfig(profile)
    const limit = boundedRequestNumber(params.get('limit'), 20, 3, 40, true)
    const minScore = boundedRequestNumber(params.get('minScore'), 0.4, 0.15, 0.95)
    if (limit == null || minScore == null) {
      return NextResponse.json(
        { error: '表示件数と最低類似度には数値を指定してください。' },
        { status: 400 },
      )
    }
    const db = createDbAdapter(market)
    const [indexMeta, latestRow, basePriceRows] = await Promise.all([
      assertAnalogSequenceIndexReady(market),
      db.get<DateRow>('SELECT MAX(date) AS date FROM ohlcv_daily'),
      db.all<PriceRow>(
        `
        SELECT ticker, date, open, high, low, close, volume
        FROM ohlcv_daily
        WHERE ticker = ?
        ORDER BY date
        `,
        [ticker],
      ),
    ])
    const latestMarketDate = latestRow?.date
    if (!latestMarketDate) {
      return NextResponse.json({ error: `${market}市場の価格データがありません。` }, { status: 404 })
    }
    if (!indexMeta.sourceDate || indexMeta.sourceDate < latestMarketDate) {
      return NextResponse.json(
        {
          error: `${market}市場の局面検索索引を更新中です（価格 ${latestMarketDate} / 索引 ${indexMeta.sourceDate ?? '未作成'}）。`,
        },
        { status: 503 },
      )
    }

    const baseRows = normalizePriceRows(basePriceRows)
    const baseSegments = buildPreparedSegments(baseRows)
    const locatedEnd = findPreparedSegmentAtOrBefore(baseSegments, requestedEndDate)
    if (!locatedEnd) {
      return NextResponse.json(
        { error: `${ticker} の指定終了日以前に比較可能な価格データがありません。` },
        { status: 404 },
      )
    }
    const basePrepared = locatedEnd.prepared
    const baseEndIndex = locatedEnd.index
    const baseStartIndex = firstIndexAtOrAfter(basePrepared, requestedStartDate)
    if (baseStartIndex < 0 || baseStartIndex > baseEndIndex) {
      return NextResponse.json(
        { error: `${ticker} の指定期間に価格データがありません。` },
        { status: 404 },
      )
    }
    const periodSessions = baseEndIndex - baseStartIndex + 1
    if (periodSessions < MIN_PERIOD_SESSIONS || periodSessions > MAX_PERIOD_SESSIONS) {
      return NextResponse.json(
        {
          error: `分析対象期間は${MIN_PERIOD_SESSIONS}〜${MAX_PERIOD_SESSIONS}営業日で指定してください（現在${periodSessions}営業日）。`,
        },
        { status: 422 },
      )
    }
    if (baseStartIndex < 240) {
      return NextResponse.json(
        { error: '指定期間の開始前に、移動平均線構造を計算するための価格履歴が不足しています。' },
        { status: 422 },
      )
    }

    const baseStartDate = basePrepared.rows[baseStartIndex].date
    const baseEndDate = basePrepared.rows[baseEndIndex].date
    const baseSelfScore = scoreMaSequenceRange(
      basePrepared,
      baseStartIndex,
      baseEndIndex,
      basePrepared,
      baseStartIndex,
      baseEndIndex,
      profileConfig.weights,
    )
    const baseComponents = coverageKeys(baseSelfScore.components)
    const requiredComponents = requiredHistoricalAnalogComponents(baseComponents)
    if (requiredComponents.length === 0) {
      return NextResponse.json(
        {
          error: '指定期間の開始前に、日足・週足の構造を比較するための価格履歴が不足しています。',
        },
        { status: 422 },
      )
    }
    const coverageBitByComponent: Record<string, number> = {
      daily: 1,
      weekly: 2,
      monthly: 4,
      yearly: 8,
    }
    const requiredCoverageMask = requiredComponents.reduce(
      (mask, component) => mask | (coverageBitByComponent[component] ?? 0),
      0,
    )
    const middleIndex = baseStartIndex + Math.floor((periodSessions - 1) / 2)
    const baseAnchors = [
      { role: 'start' as const, index: baseStartIndex },
      { role: 'middle' as const, index: middleIndex },
      { role: 'end' as const, index: baseEndIndex },
    ].filter((item, index, items) =>
      items.findIndex((candidate) => candidate.index === item.index) === index,
    ).map((anchor) => ({
      ...anchor,
      embedding: buildMaSequenceEmbedding(basePrepared, anchor.index),
      baseOffsetSessions: baseEndIndex - anchor.index,
    }))
    if (baseAnchors.some((anchor) => !anchor.embedding)) {
      return NextResponse.json(
        { error: `${ticker} の指定期間から検索用の構造索引を生成できません。` },
        { status: 422 },
      )
    }

    const cacheKey = stableCacheKey({
      market,
      ticker,
      baseStartDate,
      baseEndDate,
      latestMarketDate,
      indexSourceDate: indexMeta.sourceDate,
      version: MA_SEQUENCE_VERSION,
      scoreVersion: MA_SEQUENCE_SCORE_VERSION,
      profile,
      recency,
      sort,
      minScore,
      limit,
      mlRerankWeight: ML_RERANK_WEIGHT,
    })
    const memoryCached = responseCache.get(cacheKey)
    if (memoryCached && Date.now() - memoryCached.generatedAt < CACHE_TTL_MS) {
      return NextResponse.json({
        ...memoryCached.payload,
        cache: { hit: true, generatedAt: new Date(memoryCached.generatedAt).toISOString() },
      })
    }
    const stored = await readServingCache<Record<string, unknown>>(
      CACHE_NAMESPACE,
      cacheKey,
      CACHE_TTL_MS,
    )
    if (stored) {
      responseCache.set(cacheKey, stored)
      return NextResponse.json({
        ...stored.payload,
        cache: { hit: true, generatedAt: new Date(stored.generatedAt).toISOString() },
      })
    }

    const coreCacheKey = stableCacheKey({
      market,
      ticker,
      baseStartDate,
      baseEndDate,
      latestMarketDate,
      indexSourceDate: indexMeta.sourceDate,
      version: MA_SEQUENCE_VERSION,
      scoreVersion: MA_SEQUENCE_SCORE_VERSION,
      profile,
      recency,
      approximateLimit: APPROXIMATE_LIMIT,
      recencyShortlistLimit: RECENCY_SHORTLIST_LIMIT,
      mlRerankWeight: ML_RERANK_WEIGHT,
    })
    const releaseSearchSlot = await acquireSearchSlot()
    try {
      const cachedCore = coreSearchCache.get(coreCacheKey)
      const freshCore = cachedCore && Date.now() - cachedCore.generatedAt < CACHE_TTL_MS
        ? cachedCore
        : null
      if (cachedCore && !freshCore) coreSearchCache.delete(coreCacheKey)
      let exactCore = freshCore?.exactRanked ?? null
      let searchDiagnostics = freshCore?.search ?? null

      if (!exactCore || !searchDiagnostics) {
        let phaseStartedAt = Date.now()
        const beforeDate = addCalendarDays(latestMarketDate, 1)
        const indexedByKey = new Map<string, IndexedAnchor>()
        let coverageRejectedCount = 0

        for (const baseAnchor of baseAnchors) {
          const embedding = baseAnchor.embedding!
          let indexed = await searchAnalogSequenceIndex({
            market,
            bands: embedding.bands,
            beforeDate,
            maxBitDistance: 0,
            perBandLimit: 12_000,
          })
          if (indexed.length < 1_200) {
            const expanded = await searchAnalogSequenceIndex({
              market,
              bands: embedding.bands,
              beforeDate,
              maxBitDistance: 1,
              perBandLimit: 8_000,
            })
            const merged = new Map(indexed.map((row) => [`${row.ticker}\u0000${row.date}`, row]))
            for (const row of expanded) {
              const key = `${row.ticker}\u0000${row.date}`
              if (!merged.has(key)) merged.set(key, row)
            }
            indexed = [...merged.values()]
          }
          for (const row of indexed) {
            if ((row.coverageMask & requiredCoverageMask) !== requiredCoverageMask) {
              coverageRejectedCount += 1
              continue
            }
            const approximationScore = maSequenceEmbeddingSimilarityRanges(
              embedding.quantized,
              row.embedding,
              maSequenceEmbeddingRangesForCoverage(
                embedding.coverageMask & row.coverageMask,
              ),
            )
            const key = `${row.ticker}\u0000${row.date}\u0000${baseAnchor.baseOffsetSessions}`
            const prior = indexedByKey.get(key)
            if (prior && prior.approximationScore >= approximationScore) continue
            indexedByKey.set(key, {
              ...row,
              approximationScore,
              baseOffsetSessions: baseAnchor.baseOffsetSessions,
              sourceRole: baseAnchor.role,
            })
          }
        }
        phaseStartedAt = logSearchPhase(market, ticker, 'three-point-index', phaseStartedAt)

        const endAnchor = baseAnchors.find((anchor) => anchor.role === 'end')!
        const baseStageCode = stageCodeAt(basePrepared, baseEndIndex)
        const stageRows = baseStageCode
          ? await searchAnalogSequenceIndexByStage({
              market,
              stageCodes: stageNeighborCodes(baseStageCode, 1),
              beforeDate,
            })
          : []
        const stageCandidates: IndexedAnchor[] = stageRows
          .filter((row) => (row.coverageMask & requiredCoverageMask) === requiredCoverageMask)
          .map((row) => ({
            ...row,
            approximationScore: maSequenceEmbeddingSimilarityRanges(
              endAnchor.embedding!.quantized,
              row.embedding,
              maSequenceEmbeddingRangesForCoverage(
                endAnchor.embedding!.coverageMask & row.coverageMask,
              ),
            ),
            baseOffsetSessions: 0,
            sourceRole: 'end' as const,
          }))
          .sort((a, b) =>
            Number(b.stageCode === baseStageCode) - Number(a.stageCode === baseStageCode)
            || b.approximationScore - a.approximationScore,
          )
        phaseStartedAt = logSearchPhase(market, ticker, 'stage-index', phaseStartedAt)

        const approximate = [...indexedByKey.values()].sort((a, b) =>
          (b.approximationScore + b.bandMatches * 0.005)
          - (a.approximationScore + a.bandMatches * 0.005),
        )
        const shortlist = buildHistoricalAnalogShortlist(
          stageCandidates,
          approximate,
          {
            latestMarketDate,
            recency,
            periodSessions,
            resultLimit: limit,
            totalLimit: APPROXIMATE_LIMIT,
            stageLimit: STAGE_SHORTLIST_LIMIT,
            recencyLimit: RECENCY_SHORTLIST_LIMIT,
            maxAnchorsPerTicker: MAX_ANCHORS_PER_TICKER,
          },
        )
        const approximateShortlist = shortlist.rows
        const shortlistDiagnostics = shortlist.diagnostics

        const candidateRanges = buildCandidateRanges(approximateShortlist, latestMarketDate)
        const anchorsByTicker = new Map<string, IndexedAnchor[]>()
        for (const anchor of approximateShortlist) {
          const anchors = anchorsByTicker.get(anchor.ticker) ?? []
          anchors.push(anchor)
          anchorsByTicker.set(anchor.ticker, anchors)
        }

        const periodSpanSessions = periodSessions - 1
        const exactByKey = new Map<string, ExactCandidate>()
        let alignedCount = 0
        let exactCoverageRejectedCount = 0
        let candidatePriceRowCount = 0
        for (const range of candidateRanges) {
          const candidateRows = normalizePriceRows(await db.all<PriceRow>(
            `
            SELECT ticker, date, open, high, low, close, volume
            FROM ohlcv_daily
            WHERE ticker = ?
              AND date >= ?
              AND date <= ?
            ORDER BY date
            `,
            [range.ticker, range.fromDate, range.toDate],
          ))
          candidatePriceRowCount += candidateRows.length
          const segments = buildPreparedSegments(candidateRows)
          const anchors = (anchorsByTicker.get(range.ticker) ?? [])
            .filter((anchor) => anchor.date >= range.fromDate && anchor.date <= range.toDate)
          for (const anchor of anchors) {
            const located = findPreparedSegment(segments, anchor.date)
            if (!located) continue
            const localAligned: Array<{
              startIndex: number
              endIndex: number
              startDate: string
              endDate: string
              score: number
            }> = []
            for (let offset = -LOCAL_ALIGNED_RADIUS; offset <= LOCAL_ALIGNED_RADIUS; offset += 1) {
              const candidateEndIndex = located.index + anchor.baseOffsetSessions + offset
              const candidateStartIndex = candidateEndIndex - periodSpanSessions
              const startRow = located.prepared.rows[candidateStartIndex]
              const endRow = located.prepared.rows[candidateEndIndex]
              if (
                !startRow
                || !endRow
                || candidateStartIndex < 240
                || endRow.date > latestMarketDate
              ) continue
              if (
                anchor.ticker === ticker
                && dateRangesOverlap(startRow.date, endRow.date, baseStartDate, baseEndDate)
              ) continue
              const aligned = scoreMaSequenceRangeAligned(
                basePrepared,
                baseStartIndex,
                baseEndIndex,
                located.prepared,
                candidateStartIndex,
                candidateEndIndex,
                profileConfig.weights,
              )
              alignedCount += 1
              localAligned.push({
                startIndex: candidateStartIndex,
                endIndex: candidateEndIndex,
                startDate: startRow.date,
                endDate: endRow.date,
                score: aligned.score,
              })
            }
            for (const local of localAligned
              .sort((a, b) => b.score - a.score)
              .slice(0, LOCAL_ALIGNED_LIMIT)) {
              const result = scoreMaSequenceRange(
                basePrepared,
                baseStartIndex,
                baseEndIndex,
                located.prepared,
                local.startIndex,
                local.endIndex,
                profileConfig.weights,
              )
              const availableKeys = new Set(coverageKeys(result.components))
              if (!requiredComponents.every((key) => availableKeys.has(key))) {
                exactCoverageRejectedCount += 1
                continue
              }
              const key = `${anchor.ticker}\u0000${local.startDate}\u0000${local.endDate}`
              const existing = exactByKey.get(key)
              if (existing && existing.score >= result.score) continue
              exactByKey.set(key, {
                ticker: anchor.ticker,
                startDate: local.startDate,
                middleDate: located.prepared.rows[
                  local.startIndex + Math.floor(periodSpanSessions / 2)
                ].date,
                endDate: local.endDate,
                score: result.score,
                dailyScore: result.dailyScore,
                weeklyScore: result.weeklyScore,
                monthlyScore: result.monthlyScore,
                yearlyScore: result.yearlyScore,
                mlFeatureScore: null,
                mlFeaturePointCount: 0,
                mlFeatureTotalPoints: 3,
                components: result.components,
                approximationScore: anchor.approximationScore,
                bandMatches: anchor.bandMatches,
                stageCode: stageCodeAt(located.prepared, local.endIndex),
              })
            }
          }
        }
        phaseStartedAt = logSearchPhase(market, ticker, 'period-exact-rerank', phaseStartedAt)

        const maRanked = [...exactByKey.values()].sort((a, b) => b.score - a.score)
        const vectorScores = await loadVectorScores(
          db,
          ticker,
          [
            baseStartDate,
            basePrepared.rows[middleIndex].date,
            baseEndDate,
          ],
          maRanked,
        )
        logSearchPhase(market, ticker, 'feature-vector-rerank', phaseStartedAt)
        exactCore = maRanked
          .map((row) => {
            const vectorScore = vectorScores.get(vectorCandidateKey(row))
            if (!vectorScore) return row
            const effectiveMlWeight = ML_RERANK_WEIGHT
              * (vectorScore.pointCount / vectorScore.totalPoints)
            return {
              ...row,
              score: row.score * (1 - effectiveMlWeight) + vectorScore.score * effectiveMlWeight,
              mlFeatureScore: vectorScore.score,
              mlFeaturePointCount: vectorScore.pointCount,
              mlFeatureTotalPoints: vectorScore.totalPoints,
              components: [
                ...row.components.map((component) => ({
                  ...component,
                  weight: component.weight * (1 - effectiveMlWeight),
                })),
                {
                  key: 'mlFeatures',
                  label: `期間学習特徴量 ${vectorScore.pointCount}/${vectorScore.totalPoints}時点`,
                  score: vectorScore.score,
                  weight: effectiveMlWeight,
                  available: true,
                },
              ],
            }
          })
          .sort((a, b) => b.score - a.score)
        searchDiagnostics = {
          method: 'recency-aware three-point-lsh + full-period daily-weekly-monthly-yearly aligned-dtw',
          maPeriods: MA_SEQUENCE_PERIODS,
          maPeriodsByTimeframe: {
            daily: MA_SEQUENCE_PERIODS,
            weekly: MA_SEQUENCE_WEEKLY_PERIODS,
            monthly: MA_SEQUENCE_MONTHLY_PERIODS,
            yearly: MA_SEQUENCE_YEARLY_PERIODS,
          },
          periodSessions,
          higherTimeframes: ['daily', 'weekly', 'monthly', 'yearly'],
          scoringProfile: {
            key: profileConfig.key,
            label: profileConfig.label,
            weights: profileConfig.weights,
          },
          mlRerankWeight: ML_RERANK_WEIGHT,
          indexedCandidateCount: indexedByKey.size,
          coverageRejectedCount,
          exactCoverageRejectedCount,
          requiredComponents,
          approximateCount: approximateShortlist.length,
          stageCandidateCount: stageCandidates.length,
          stageShortlistCount: shortlistDiagnostics.stageShortlistCount,
          retrievalPolicy: shortlistDiagnostics.policy,
          recencyShortlistTarget: shortlistDiagnostics.recencyTarget,
          recencyPoolCount: shortlistDiagnostics.recencyPoolCount,
          recencyShortlistCount: shortlistDiagnostics.recencyShortlistCount,
          recencyStagePoolCount: shortlistDiagnostics.stagePoolCount,
          fallbackShortlistCount: shortlistDiagnostics.fallbackShortlistCount,
          candidateRangeCount: candidateRanges.length,
          candidatePriceRowCount,
          alignedCount,
          dtwRerankCount: exactByKey.size,
          scoredCount: exactCore.length,
          coverageFrom: indexMeta.coverageFrom,
          coverageTo: indexMeta.coverageTo,
          indexSourceDate: indexMeta.sourceDate,
          indexRows: indexMeta.rowCount,
          indexVersion: indexMeta.version,
          indexFeatureSchema: indexMeta.featureSchema,
          indexEmbeddingBytes: indexMeta.embeddingBytes,
          truncated: approximateShortlist.length >= APPROXIMATE_LIMIT,
        }
        const coreGeneratedAt = Date.now()
        coreSearchCache.set(coreCacheKey, {
          generatedAt: coreGeneratedAt,
          exactRanked: exactCore,
          search: searchDiagnostics,
        })
        if (coreSearchCache.size > CORE_CACHE_MAX_ENTRIES) {
          const oldestKey = coreSearchCache.keys().next().value
          if (oldestKey) coreSearchCache.delete(oldestKey)
        }
      }

      if (!exactCore || !searchDiagnostics) {
        throw new Error('類似局面の精密検索結果を生成できませんでした。')
      }
      const filtered = exactCore.filter((row) =>
        row.score >= minScore
        && isWithinHistoricalAnalogRecency(row.endDate, latestMarketDate, recency),
      )
      const minimumSpacingDays = Math.max(
        14,
        Math.ceil(calendarDaysBetween(baseStartDate, baseEndDate) * 0.4),
      )
      const selected = diversify(
        sortExact(filtered, sort, latestMarketDate),
        limit,
        minimumSpacingDays,
      )
      const [metadata, presentations] = await Promise.all([
        loadTickerMetadata(db, [ticker, ...selected.map((row) => row.ticker)]),
        loadPresentations(db, selected),
      ])
      const analogs = selected.map((row, index) => {
        const info = metadata.get(row.ticker)
        const key = `${row.ticker}\u0000${row.startDate}\u0000${row.endDate}`
        const presentation = presentations.get(key)
        const elapsedDays = calendarDaysBetween(row.endDate, latestMarketDate)
        return {
          rank: index + 1,
          ticker: row.ticker,
          name: info?.name ?? null,
          marketSegment: info?.market_segment ?? null,
          sector17Name: info?.sector17_name ?? null,
          sector33Name: info?.sector33_name ?? null,
          marginType: info?.margin_type ?? null,
          caseStartDate: row.startDate,
          caseEndDate: row.endDate,
          elapsedDays,
          recencyBucket: historicalAnalogRecencyBucket(elapsedDays),
          stageCode: row.stageCode,
          similarityScore: row.score,
          dailyScore: row.dailyScore,
          weeklyScore: row.weeklyScore,
          monthlyScore: row.monthlyScore,
          yearlyScore: row.yearlyScore,
          mlFeatureScore: row.mlFeatureScore,
          mlFeaturePointCount: row.mlFeaturePointCount,
          mlFeatureTotalPoints: row.mlFeatureTotalPoints,
          approximationScore: row.approximationScore,
          bandMatches: row.bandMatches,
          components: componentReasons(row.components),
          volume: presentation?.volume ?? null,
          avgVolume30: presentation?.avgVolume30 ?? null,
          volumeRatio30: presentation?.volumeRatio30 ?? null,
          volumeObservationCount: presentation?.volumeObservationCount ?? 0,
          window: presentation?.window ?? [],
          stagePath: presentation?.stagePath ?? [],
        }
      })
      const generatedAt = Date.now()
      const payload = {
        market,
        ticker,
        latestMarketDate,
        featureSet: `ma_period_sequence_score_v${MA_SEQUENCE_SCORE_VERSION}_index_v${MA_SEQUENCE_VERSION}`,
        base: {
          ticker,
          name: metadata.get(ticker)?.name ?? null,
          startDate: baseStartDate,
          endDate: baseEndDate,
          sessionCount: periodSessions,
          stageCode: stageCodeAt(basePrepared, baseEndIndex),
          window: buildRangeWindow(basePrepared, baseStartIndex, baseEndIndex),
          stagePath: compactStagePath(basePrepared, baseStartIndex, baseEndIndex),
        },
        profile,
        recency,
        sort,
        minScore,
        summary: {
          matchCount: filtered.length,
          displayedCount: analogs.length,
          sameTickerCount: filtered.filter((row) => row.ticker === ticker).length,
          otherTickerCount: filtered.filter((row) => row.ticker !== ticker).length,
          latestMatchEndDate: filtered.map((row) => row.endDate).sort().at(-1) ?? null,
          medianSimilarity: median(filtered.map((row) => row.score)),
        },
        analogs,
        search: searchDiagnostics,
        cache: { hit: false, generatedAt: new Date(generatedAt).toISOString() },
      }
      responseCache.set(cacheKey, { generatedAt, payload })
      if (responseCache.size > CACHE_MAX_ENTRIES) {
        const oldestKey = responseCache.keys().next().value
        if (oldestKey) responseCache.delete(oldestKey)
      }
      writeServingCache(CACHE_NAMESPACE, cacheKey, payload, CACHE_TTL_MS, generatedAt).catch((error) => {
        console.warn('historical analog period cache write failed:', error)
      })
      return NextResponse.json(payload)
    } finally {
      releaseSearchSlot()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('historical analog period search failed:', error)
    const indexMissing = /局面検索索引が未構築/.test(message)
    return NextResponse.json({
      error: indexMissing ? message : '本質類似局面の検索に失敗しました。',
      code: indexMissing ? 'ANALOG_SEQUENCE_INDEX_REQUIRED' : 'ANALOG_SEQUENCE_SEARCH_FAILED',
      message,
    }, { status: indexMissing ? 503 : 500 })
  }
}

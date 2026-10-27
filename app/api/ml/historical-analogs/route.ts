import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet } from '@/lib/db/us-analytics'
import { readServingCache, stableCacheKey, writeServingCache } from '@/lib/api/serving-cache'
import {
  assertAnalogSequenceIndexReady,
  readAnalogSequencePriceChunks,
  readAnalogSequencePrices,
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
  maSequenceEmbeddingRangesForCoverage,
  maSequenceEmbeddingSimilarityRanges,
  scoreMaSequenceRange,
  scoreMaSequenceRangeAligned,
  stageCodeAt,
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
  paginateHistoricalAnalogRows,
  requiredHistoricalAnalogComponents,
  stageNeighborCodes,
  weightedVectorSequenceSimilarityDetails,
  type HistoricalAnalogSort,
} from '@/lib/ml/historical-analogs'
import { isValidTickerForMarket } from '@/lib/markets'
import { KeyedSingleflight } from '@/lib/server/keyed-singleflight'
import {
  HISTORICAL_ANALOG_ML_RERANK_WEIGHT,
  historicalAnalogResponseCacheKey,
  historicalAnalogSourceGeneration,
} from '@/lib/server/historical-analog-cache'
import {
  addCalendarDays,
  buildPreparedSegments,
  buildRangeWindow,
  compactStagePath,
  findPreparedSegment,
  findPreparedSegmentAtOrBefore,
  firstIndexAtOrAfter,
  loadPresentations,
  normalizePriceRows,
  subtractCalendarDays,
  type HistoricalAnalogPriceRow as PriceRow,
} from '@/lib/server/historical-analog-presentations'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const HISTORICAL_ANALOG_CACHE_NAMESPACE = 'historical_analogs_period_v13'
const CACHE_TTL_MS = boundedEnv(
  'HISTORICAL_ANALOG_CACHE_TTL_MS',
  24 * 60 * 60 * 1_000,
  60_000,
  24 * 60 * 60 * 1_000,
)
const APPROXIMATE_LIMIT = boundedEnv('ANALOG_SEQUENCE_APPROXIMATE_LIMIT', 450, 150, 900)
const MAX_ANCHORS_PER_TICKER = 4
const LOCAL_ALIGNED_LIMIT = 2
const MAX_PAGINATED_RESULTS = APPROXIMATE_LIMIT * LOCAL_ALIGNED_LIMIT
const LOCAL_ALIGNED_RADIUS = 8
const STAGE_SHORTLIST_LIMIT = 120
const RECENCY_SHORTLIST_LIMIT = boundedEnv('ANALOG_SEQUENCE_RECENCY_SHORTLIST_LIMIT', 260, 50, 350)
const ML_RERANK_WEIGHT = HISTORICAL_ANALOG_ML_RERANK_WEIGHT
const CANDIDATE_HISTORY_DAYS = 4_300
const CANDIDATE_FUTURE_DAYS = 500
const CANDIDATE_RANGE_QUERY_CHUNK = 50
const MIN_PERIOD_SESSIONS = 5
const MAX_PERIOD_SESSIONS = 250
const CACHE_MAX_ENTRIES = 80
const CORE_CACHE_MAX_ENTRIES = 8
const DAY_MS = 86_400_000
const SEARCH_CONCURRENCY = boundedEnv('ANALOG_SEARCH_CONCURRENCY', 2, 1, 4)
const ANALOG_GENERATION_CHANGED = 'historical_analog_generation_changed'

const responseCache = new Map<string, { generatedAt: number; payload: Record<string, unknown> }>()
const coreSearchCache = new Map<string, {
  generatedAt: number
  exactRanked: ExactCandidate[]
  search: SearchDiagnostics
}>()
const globalForHistoricalAnalogs = global as unknown as {
  historicalAnalogCoreSingleflight?: KeyedSingleflight
}

type Market = AnalogSequenceMarket
type DbArgs = readonly (string | number | null)[]

function assertHistoricalAnalogGeneration(
  market: AnalogSequenceMarket,
  expectedGeneration: string,
): void {
  if (historicalAnalogSourceGeneration(market) !== expectedGeneration) {
    throw new Error(ANALOG_GENERATION_CHANGED)
  }
}

type UniverseRow = {
  ticker: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
  margin_type: string | null
}

const CURRENT_REFERENCE_METADATA_CONTRACT = {
  basis: 'CURRENT_REFERENCE',
  source: 'ticker_universe',
  asOf: null,
  asOfStatus: 'NOT_VERSIONED',
  fields: [
    'name',
    'marketSegment',
    'sector17Name',
    'sector33Name',
    'marginType',
  ],
  usage: 'DISPLAY_AND_LOADED_PAGE_FILTER_ONLY',
  affectsSimilarityRanking: false,
  affectsMatchCount: false,
} as const

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

export type ExactCandidate = {
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
  return isValidTickerForMarket(normalized, market) ? normalized : null
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
    const body = await response.arrayBuffer()
    return new NextResponse(body, {
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

function analogCoreSingleflight(): KeyedSingleflight {
  globalForHistoricalAnalogs.historicalAnalogCoreSingleflight ??=
    new KeyedSingleflight(SEARCH_CONCURRENCY)
  return globalForHistoricalAnalogs.historicalAnalogCoreSingleflight
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

async function loadCandidateRangeChunk(
  db: ReturnType<typeof createDbAdapter>,
  market: Market,
  usePriceChunks: boolean,
  usePriceMirror: boolean,
  ranges: CandidateRange[],
): Promise<Map<string, PriceRow[]>> {
  if (ranges.length === 0) return new Map()
  let rawRows: PriceRow[]
  if (usePriceChunks) {
    rawRows = await readAnalogSequencePriceChunks(market, ranges)
  } else if (usePriceMirror) {
    rawRows = await readAnalogSequencePrices(market, ranges)
  } else {
    rawRows = await db.all<PriceRow>(
      `
        SELECT ticker, date, open, high, low, close, volume
        FROM ohlcv_daily
        WHERE ${ranges.map(() => '(ticker = ? AND date >= ? AND date <= ?)').join(' OR ')}
        ORDER BY ticker, date
      `,
      ranges.flatMap((range) => [range.ticker, range.fromDate, range.toDate]),
    )
  }
  const rows = normalizePriceRows(rawRows)
  const byTicker = new Map<string, PriceRow[]>()
  for (const row of rows) {
    const tickerRows = byTicker.get(row.ticker) ?? []
    tickerRows.push(row)
    byTicker.set(row.ticker, tickerRows)
  }
  return byTicker
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
    const limit = boundedRequestNumber(params.get('limit'), 20, 3, 100, true)
    const offset = boundedRequestNumber(
      params.get('offset'),
      0,
      0,
      MAX_PAGINATED_RESULTS - 1,
      true,
    )
    const minScore = boundedRequestNumber(params.get('minScore'), 0.4, 0.15, 0.95)
    if (limit == null || offset == null || minScore == null) {
      return NextResponse.json(
        { error: '表示件数、表示位置、最低類似度には数値を指定してください。' },
        { status: 400 },
      )
    }
    const sourceGeneration = historicalAnalogSourceGeneration(market)
    const db = createDbAdapter(market)
    const [indexMeta, latestRow] = await Promise.all([
      assertAnalogSequenceIndexReady(market),
      db.get<DateRow>('SELECT MAX(date) AS date FROM ohlcv_daily'),
    ])
    assertHistoricalAnalogGeneration(market, sourceGeneration)
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

    const cacheKey = historicalAnalogResponseCacheKey({
      market,
      ticker,
      requestedStartDate,
      requestedEndDate,
      latestMarketDate,
      indexSourceDate: indexMeta.sourceDate,
      indexUpdatedAt: indexMeta.updatedAt,
      sourceGeneration,
      profile,
      recency,
      sort,
      minScore,
      limit,
      offset,
    })
    const memoryCached = responseCache.get(cacheKey)
    if (memoryCached && Date.now() - memoryCached.generatedAt < CACHE_TTL_MS) {
      assertHistoricalAnalogGeneration(market, sourceGeneration)
      return NextResponse.json({
        ...memoryCached.payload,
        cache: { hit: true, generatedAt: new Date(memoryCached.generatedAt).toISOString() },
      })
    }
    const stored = await readServingCache<Record<string, unknown>>(
      HISTORICAL_ANALOG_CACHE_NAMESPACE,
      cacheKey,
      CACHE_TTL_MS,
    )
    if (stored) {
      assertHistoricalAnalogGeneration(market, sourceGeneration)
      responseCache.set(cacheKey, stored)
      return NextResponse.json({
        ...stored.payload,
        cache: { hit: true, generatedAt: new Date(stored.generatedAt).toISOString() },
      })
    }

    const basePriceRows = await db.all<PriceRow>(
      `
      SELECT ticker, date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
      ORDER BY date
      `,
      [ticker],
    )
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

    const coreCacheKey = stableCacheKey({
      market,
      ticker,
      baseStartDate,
      baseEndDate,
      latestMarketDate,
      indexSourceDate: indexMeta.sourceDate,
      indexUpdatedAt: indexMeta.updatedAt,
      sourceGeneration,
      version: MA_SEQUENCE_VERSION,
      scoreVersion: MA_SEQUENCE_SCORE_VERSION,
      profile,
      recency,
      approximateLimit: APPROXIMATE_LIMIT,
      recencyShortlistLimit: RECENCY_SHORTLIST_LIMIT,
      mlRerankWeight: ML_RERANK_WEIGHT,
    })
    const cachedCore = coreSearchCache.get(coreCacheKey)
    const freshCore = cachedCore && Date.now() - cachedCore.generatedAt < CACHE_TTL_MS
      ? cachedCore
      : null
    if (cachedCore && !freshCore) coreSearchCache.delete(coreCacheKey)
    if (!freshCore) {
      await analogCoreSingleflight().run(coreCacheKey, async () => {
        const joinedCore = coreSearchCache.get(coreCacheKey)
        if (joinedCore && Date.now() - joinedCore.generatedAt < CACHE_TTL_MS) return
        let exactCore: ExactCandidate[] = []
        let searchDiagnostics: SearchDiagnostics
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
            resultLimit: APPROXIMATE_LIMIT,
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
        let candidateLoadMs = 0
        let candidatePrepareMs = 0
        let candidateAlignedMs = 0
        let candidateDtwMs = 0
        for (let chunkOffset = 0; chunkOffset < candidateRanges.length; chunkOffset += CANDIDATE_RANGE_QUERY_CHUNK) {
          const rangeChunk = candidateRanges.slice(chunkOffset, chunkOffset + CANDIDATE_RANGE_QUERY_CHUNK)
          let operationStartedAt = Date.now()
          const chunkRows = await loadCandidateRangeChunk(
            db,
            market,
            indexMeta.priceChunksCompleted && indexMeta.priceChunksSourceDate === latestMarketDate,
            indexMeta.priceCompleted && indexMeta.priceSourceDate === latestMarketDate,
            rangeChunk,
          )
          candidateLoadMs += Date.now() - operationStartedAt
          for (const range of rangeChunk) {
            const candidateRows = (chunkRows.get(range.ticker) ?? [])
              .filter((row) => row.date >= range.fromDate && row.date <= range.toDate)
            candidatePriceRowCount += candidateRows.length
            operationStartedAt = Date.now()
            const segments = buildPreparedSegments(candidateRows)
            candidatePrepareMs += Date.now() - operationStartedAt
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
              operationStartedAt = Date.now()
              const aligned = scoreMaSequenceRangeAligned(
                basePrepared,
                baseStartIndex,
                baseEndIndex,
                located.prepared,
                candidateStartIndex,
                candidateEndIndex,
                profileConfig.weights,
              )
              candidateAlignedMs += Date.now() - operationStartedAt
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
              operationStartedAt = Date.now()
              const result = scoreMaSequenceRange(
                basePrepared,
                baseStartIndex,
                baseEndIndex,
                located.prepared,
                local.startIndex,
                local.endIndex,
                profileConfig.weights,
              )
              candidateDtwMs += Date.now() - operationStartedAt
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
        }
        if (process.env.ANALOG_SEARCH_PHASE_LOGS === '1') {
          console.info(
            `[historical-analogs] ${market}:${ticker} exact-detail `
            + `load=${candidateLoadMs}ms prepare=${candidatePrepareMs}ms `
            + `aligned=${candidateAlignedMs}ms dtw=${candidateDtwMs}ms`,
          )
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
      })
    }

    const resolvedCore = coreSearchCache.get(coreCacheKey)
    if (!resolvedCore || Date.now() - resolvedCore.generatedAt >= CACHE_TTL_MS) {
      throw new Error('類似局面の精密検索結果を生成できませんでした。')
    }
    const exactCore = resolvedCore.exactRanked
    const searchDiagnostics = resolvedCore.search
    const filtered = exactCore.filter((row) =>
        row.score >= minScore
        && isWithinHistoricalAnalogRecency(row.endDate, latestMarketDate, recency),
      )
      const minimumSpacingDays = Math.max(
        14,
        Math.ceil(calendarDaysBetween(baseStartDate, baseEndDate) * 0.4),
      )
      const diversified = diversify(
        sortExact(filtered, sort, latestMarketDate),
        MAX_PAGINATED_RESULTS,
        minimumSpacingDays,
      )
      const page = paginateHistoricalAnalogRows(diversified, offset, limit)
      const selected = page.rows
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
          rank: offset + index + 1,
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
        metadataBasis: {
          tickerUniverse: CURRENT_REFERENCE_METADATA_CONTRACT,
        },
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
          matchCount: diversified.length,
          displayedCount: analogs.length,
          sameTickerCount: diversified.filter((row) => row.ticker === ticker).length,
          otherTickerCount: diversified.filter((row) => row.ticker !== ticker).length,
          latestMatchEndDate: diversified.map((row) => row.endDate).sort().at(-1) ?? null,
          medianSimilarity: median(diversified.map((row) => row.score)),
        },
        pagination: {
          offset: page.offset,
          limit: page.limit,
          hasMore: page.hasMore,
          nextOffset: page.nextOffset,
        },
        analogs,
        search: searchDiagnostics,
        cache: { hit: false, generatedAt: new Date(generatedAt).toISOString() },
      }
      assertHistoricalAnalogGeneration(market, sourceGeneration)
      responseCache.set(cacheKey, { generatedAt, payload })
      if (responseCache.size > CACHE_MAX_ENTRIES) {
        const oldestKey = responseCache.keys().next().value
        if (oldestKey) responseCache.delete(oldestKey)
      }
      writeServingCache(HISTORICAL_ANALOG_CACHE_NAMESPACE, cacheKey, payload, CACHE_TTL_MS, generatedAt).catch((error) => {
        console.warn('historical analog period cache write failed:', error)
      })
    return NextResponse.json(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('historical analog period search failed:', error)
    const indexMissing = /局面検索索引が未構築/.test(message)
    const generationChanged = message.includes(ANALOG_GENERATION_CHANGED)
      || message.includes('analog_sequence_generation_changed')
    const promotionPending = /promotion (?:journal|requires operator review)/i.test(message)
    const retryable = generationChanged
    return NextResponse.json({
      error: indexMissing
        ? message
        : promotionPending
          ? '分析データの更新が未完了です。運用者の確認が必要です。'
          : retryable
          ? '分析データが更新されたため、最新世代で検索をやり直してください。'
          : '本質類似局面の検索に失敗しました。',
      code: indexMissing
        ? 'ANALOG_SEQUENCE_INDEX_REQUIRED'
        : promotionPending
          ? 'ANALOG_GENERATION_PROMOTION_PENDING'
          : generationChanged
          ? 'ANALOG_GENERATION_CHANGED'
          : 'ANALOG_SEQUENCE_SEARCH_FAILED',
      retryable,
    }, {
      status: indexMissing || generationChanged || promotionPending ? 503 : 500,
      headers: retryable ? { 'Retry-After': '2' } : undefined,
    })
  }
}

import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet } from '@/lib/db/us-analytics'
import { readServingCache, stableCacheKey, writeServingCache } from '@/lib/api/serving-cache'
import {
  assertAnalogSequenceIndexReady,
  searchAnalogSequenceIndex,
  searchAnalogSequenceIndexByStage,
  type AnalogSequenceMarket,
} from '@/lib/db/analog-sequence-index'
import {
  MA_SEQUENCE_PERIODS,
  MA_SEQUENCE_LONG_TERM_PERIODS,
  MA_SEQUENCE_MONTHLY_PERIODS,
  MA_SEQUENCE_SCORE_VERSION,
  MA_SEQUENCE_VERSION,
  buildMaSequenceEmbedding,
  findMaSequenceIndex,
  maSequenceScoringProfileForMarket,
  maSequenceEmbeddingSimilarityRanges,
  prepareMaSequence,
  scoreMaSequence,
  scoreMaSequenceAligned,
  stageCodeAt,
  type MaSequencePrepared,
  type MaSequencePriceRow,
} from '@/lib/ml/ma-sequence'
import {
  isHistoricalAnalogHorizon,
  normalizedVectorSimilarity,
  normalizeHistoricalAnalogSort,
  stageNeighborCodes,
  type HistoricalAnalogSort,
} from '@/lib/ml/historical-analogs'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const CACHE_NAMESPACE = 'historical_analogs_sequence_v13'
const CACHE_TTL_MS = boundedEnv(
  'HISTORICAL_ANALOG_CACHE_TTL_MS',
  24 * 60 * 60 * 1_000,
  60_000,
  24 * 60 * 60 * 1_000,
)
const APPROXIMATE_LIMIT = boundedEnv('ANALOG_SEQUENCE_APPROXIMATE_LIMIT', 400, 120, 800)
const EXACT_POOL_LIMIT = boundedEnv('ANALOG_SEQUENCE_EXACT_POOL_LIMIT', 250, 60, 400)
const MAX_ANCHORS_PER_TICKER = 2
const LOCAL_ALIGNED_LIMIT = 2
const LOCAL_ALIGNED_RADIUS = 8
const STAGE_SHORTLIST_LIMIT = 120
const ML_RERANK_WEIGHT = 0
const CANDIDATE_HISTORY_DAYS = 4_300
const CANDIDATE_FUTURE_DAYS = 340
const MAX_OUTCOME_HORIZON = 200
const CACHE_MAX_ENTRIES = 100
const CORE_CACHE_MAX_ENTRIES = 20
const responseCache = new Map<string, { generatedAt: number; payload: Record<string, unknown> }>()

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
}

type VectorRow = {
  ticker: string
  date: string
  vector_json: string
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
  date: string
  score: number
  components: ScoreComponent[]
  approximationScore: number
  bandMatches: number
  stageCode: string | null
  preWindow: ReturnType<typeof buildPreWindow>
  stagePath: ReturnType<typeof compactStagePath>
  outcome: ReturnType<typeof buildOutcome>
}

type CandidateRange = {
  ticker: string
  fromDate: string
  toDate: string
}

type SearchDiagnostics = {
  method: string
  maPeriods: readonly number[]
  dailyWindows: number[]
  higherTimeframes: string[]
  monthlyPeriods: readonly number[]
  longTermPeriods: readonly number[]
  scoringProfile: {
    key: string
    label: string
  }
  mlRerankWeight: number
  indexedCandidateCount: number
  coverageRejectedCount: number
  exactCoverageRejectedCount: number
  requiredComponents: string[]
  approximateCount: number
  stageCandidateCount: number
  stageShortlistCount: number
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
  truncated: boolean
}

const coreSearchCache = new Map<string, {
  generatedAt: number
  exactRanked: ExactCandidate[]
  search: SearchDiagnostics
}>()

function boundedEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function normalizeMarket(value: string | null): Market {
  return value?.toUpperCase() === 'US' ? 'US' : 'JP'
}

function normalizeTicker(value: string | null, market: Market): string | null {
  const normalized = value?.trim().toUpperCase().replace(/\.T$/i, '') ?? ''
  if (!normalized) return null
  if (market === 'JP') return /^\d{4}$/.test(normalized) ? normalized : null
  return /^[A-Z0-9.^-]{1,16}$/.test(normalized) ? normalized : null
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

function subtractCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
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

function normalizePriceRows(rows: PriceRow[]): PriceRow[] {
  const normalized: PriceRow[] = []
  for (const row of rows) {
    row.ticker = String(row.ticker)
    row.date = String(row.date)
    row.close = Number(row.close)
    row.open = row.open == null ? null : Number(row.open)
    row.high = row.high == null ? null : Number(row.high)
    row.low = row.low == null ? null : Number(row.low)
    row.volume = row.volume == null ? null : Number(row.volume)
    if (row.date && finite(row.close) && row.close > 0) normalized.push(row)
  }
  return normalized
}

function buildCandidateRanges(
  anchors: Array<{ ticker: string; date: string }>,
  baseDate: string,
): CandidateRange[] {
  const requested = anchors
    .map((anchor) => ({
      ticker: anchor.ticker,
      fromDate: subtractCalendarDays(anchor.date, CANDIDATE_HISTORY_DAYS),
      toDate: [
        baseDate,
        subtractCalendarDays(anchor.date, -CANDIDATE_FUTURE_DAYS),
      ].sort()[0],
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

function splitContinuous(rows: PriceRow[], maxGapDays = 60): PriceRow[][] {
  if (rows.length === 0) return []
  const output: PriceRow[][] = []
  let current = [rows[0]]
  for (let index = 1; index < rows.length; index += 1) {
    const from = Date.parse(`${rows[index - 1].date}T00:00:00Z`)
    const to = Date.parse(`${rows[index].date}T00:00:00Z`)
    if ((to - from) / 86_400_000 > maxGapDays) {
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

function compactStagePath(prepared: MaSequencePrepared, endIndex: number, lookback = 40) {
  const path: Array<{ relativeDay: number; date: string; stageCode: string }> = []
  let previous: string | null = null
  const start = Math.max(0, endIndex - lookback + 1)
  for (let index = start; index <= endIndex; index += 1) {
    const code = stageCodeAt(prepared, index)
    if (!code || code === previous) continue
    path.push({
      relativeDay: index - endIndex,
      date: prepared.rows[index].date,
      stageCode: code,
    })
    previous = code
  }
  return path
}

function buildPreWindow(prepared: MaSequencePrepared, endIndex: number, lookback = 60) {
  const baseClose = prepared.rows[endIndex]?.close
  if (!finite(baseClose) || baseClose === 0) return []
  const start = Math.max(0, endIndex - lookback + 1)
  const rows: Array<Record<string, number | string | null>> = []
  for (let index = start; index <= endIndex; index += 1) {
    const point: Record<string, number | string | null> = {
      relativeDay: index - endIndex,
      date: prepared.rows[index].date,
      close: Number(((prepared.rows[index].close / baseClose) * 100).toFixed(4)),
    }
    MA_SEQUENCE_PERIODS.forEach((period, periodIndex) => {
      const value = prepared.daily.mas[periodIndex][index]
      point[`ma${period}`] = finite(value)
        ? Number(((value / baseClose) * 100).toFixed(4))
        : null
    })
    rows.push(point)
  }
  return rows
}

function buildOutcome(prepared: MaSequencePrepared, index: number, horizon: number) {
  const baseClose = prepared.rows[index]?.close
  if (!finite(baseClose) || baseClose === 0) {
    return {
      horizonDays: horizon,
      complete: false,
      availableDays: 0,
      returnPct: null,
      maxReturnPct: null,
      minReturnPct: null,
      path: [],
    }
  }
  const availableDays = Math.min(horizon, prepared.rows.length - index - 1)
  const future = prepared.rows.slice(index + 1, index + availableDays + 1)
  const path = [
    { afterDays: 0, date: prepared.rows[index].date, value: 100 },
    ...future.map((row, futureIndex) => ({
      afterDays: futureIndex + 1,
      date: row.date,
      value: Number(((row.close / baseClose) * 100).toFixed(4)),
    })),
  ]
  const closes = future.map((row) => row.close)
  const finalClose = availableDays >= horizon ? prepared.rows[index + horizon]?.close : null
  return {
    horizonDays: horizon,
    complete: availableDays >= horizon,
    availableDays,
    returnPct: finite(finalClose) ? ((finalClose / baseClose) - 1) * 100 : null,
    maxReturnPct: closes.length > 0 ? ((Math.max(...closes) / baseClose) - 1) * 100 : null,
    minReturnPct: closes.length > 0 ? ((Math.min(...closes) / baseClose) - 1) * 100 : null,
    path,
  }
}

function projectOutcome(
  source: ReturnType<typeof buildOutcome>,
  horizon: number,
): ReturnType<typeof buildOutcome> {
  const availableDays = Math.min(horizon, source.availableDays)
  const path = source.path.filter((point) => point.afterDays <= availableDays)
  const futureValues = path.slice(1).map((point) => point.value)
  const finalPoint = path.find((point) => point.afterDays === horizon)
  return {
    horizonDays: horizon,
    complete: source.availableDays >= horizon,
    availableDays,
    returnPct: finalPoint ? finalPoint.value - 100 : null,
    maxReturnPct: futureValues.length > 0 ? Math.max(...futureValues) - 100 : null,
    minReturnPct: futureValues.length > 0 ? Math.min(...futureValues) - 100 : null,
    path,
  }
}

function comparable(value: number | null, fallback: number): number {
  return finite(value) ? value : fallback
}

function sortExact<T extends ExactCandidate & {
  outcome: ReturnType<typeof buildOutcome>
}>(rows: T[], sort: HistoricalAnalogSort): T[] {
  return [...rows].sort((a, b) => {
    if (sort === 'return_desc') {
      return comparable(b.outcome.returnPct, -Infinity) - comparable(a.outcome.returnPct, -Infinity)
    }
    if (sort === 'return_asc') {
      return comparable(a.outcome.returnPct, Infinity) - comparable(b.outcome.returnPct, Infinity)
    }
    if (sort === 'max_return') {
      return comparable(b.outcome.maxReturnPct, -Infinity) - comparable(a.outcome.maxReturnPct, -Infinity)
    }
    if (sort === 'min_return') {
      return comparable(a.outcome.minReturnPct, Infinity) - comparable(b.outcome.minReturnPct, Infinity)
    }
    return b.score - a.score
  })
}

function diversify<T extends { ticker: string; date: string }>(rows: T[], limit: number): T[] {
  const selected: T[] = []
  const tickerDates = new Map<string, string[]>()
  for (const row of rows) {
    const priorDates = tickerDates.get(row.ticker) ?? []
    if (priorDates.length >= 2) continue
    const candidateTime = Date.parse(`${row.date}T00:00:00Z`)
    const tooClose = priorDates.some((date) =>
      Math.abs(candidateTime - Date.parse(`${date}T00:00:00Z`)) < 10 * 86_400_000,
    )
    if (tooClose) continue
    selected.push(row)
    tickerDates.set(row.ticker, [...priorDates, row.date])
    if (selected.length >= limit) break
  }
  return selected
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function quantile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * ratio
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function summarizeOutcomes(rows: Array<{ outcome: ReturnType<typeof buildOutcome> }>) {
  const completed = rows.filter((row) => row.outcome.complete)
  const returns = completed.map((row) => row.outcome.returnPct).filter(finite)
  const maxReturns = completed.map((row) => row.outcome.maxReturnPct).filter(finite)
  const minReturns = completed.map((row) => row.outcome.minReturnPct).filter(finite)
  return {
    sampleCount: returns.length,
    partialCount: rows.length - completed.length,
    upRate: returns.length > 0 ? returns.filter((value) => value > 0).length / returns.length : null,
    averageReturnPct: average(returns),
    medianReturnPct: quantile(returns, 0.5),
    lowerQuartileReturnPct: quantile(returns, 0.25),
    upperQuartileReturnPct: quantile(returns, 0.75),
    averageMaxReturnPct: average(maxReturns),
    averageMinReturnPct: average(minReturns),
  }
}

function componentReasons(components: ScoreComponent[]) {
  const order = new Map([
    ['daily10', 0],
    ['daily20', 1],
    ['daily40', 2],
    ['weekly', 3],
    ['monthly', 4],
    ['longTerm', 5],
    ['mlFeatures', 6],
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

async function loadVectorScores(
  db: ReturnType<typeof createDbAdapter>,
  baseTicker: string,
  baseDate: string,
  candidates: ExactCandidate[],
): Promise<Map<string, number>> {
  const base = await db.get<VectorRow>(
    `
    SELECT ticker, date, vector_json
    FROM ml_feature_vectors_v2
    WHERE feature_set = 'ma_physics_v4'
      AND ticker = ?
      AND date <= ?
    ORDER BY date DESC
    LIMIT 1
    `,
    [baseTicker, baseDate],
  )
  const baseVector = parseVector(base?.vector_json)
  if (baseVector.length === 0) return new Map()
  const scores = new Map<string, number>()
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const chunk = candidates.slice(offset, offset + 100)
    if (chunk.length === 0) continue
    const values = chunk.map(() => '(?, ?)').join(', ')
    const args = chunk.flatMap((row) => [row.ticker, row.date])
    const rows = await db.all<VectorRow>(
      `
      WITH targets(ticker, date) AS (VALUES ${values})
      SELECT f.ticker, f.date, f.vector_json
      FROM ml_feature_vectors_v2 f
      INNER JOIN targets t ON t.ticker = f.ticker AND t.date = f.date
      WHERE f.feature_set = 'ma_physics_v4'
      `,
      args,
    )
    for (const row of rows) {
      const vector = parseVector(row.vector_json)
      if (vector.length === 0) continue
      scores.set(`${row.ticker}\u0000${row.date}`, normalizedVectorSimilarity(baseVector, vector))
    }
  }
  return scores
}

async function loadTickerMetadata(
  db: ReturnType<typeof createDbAdapter>,
  tickers: string[],
): Promise<Map<string, UniverseRow>> {
  if (tickers.length === 0) return new Map()
  const placeholders = tickers.map(() => '?').join(', ')
  const rows = await db.all<UniverseRow>(
    `
    SELECT ticker, name, market_segment, sector17_name, sector33_name
    FROM ticker_universe
    WHERE ticker IN (${placeholders})
    `,
    tickers,
  )
  return new Map(rows.map((row) => [row.ticker, row]))
}

export async function GET(request: NextRequest) {
  const proxied = await proxyToAnalogWorker(request)
  if (proxied) return proxied
  try {
    const params = request.nextUrl.searchParams
    const market = normalizeMarket(params.get('market'))
    const ticker = normalizeTicker(params.get('ticker'), market)
    if (!ticker) {
      return NextResponse.json({ error: '有効な銘柄コードを指定してください。' }, { status: 400 })
    }
    const requestedHorizon = Number(params.get('horizon') ?? 20)
    const horizon = isHistoricalAnalogHorizon(requestedHorizon) ? requestedHorizon : 20
    const sort = normalizeHistoricalAnalogSort(params.get('sort'))
    const limit = Math.min(40, Math.max(3, Number(params.get('limit') ?? 12)))
    const minScore = Math.min(0.9, Math.max(0.15, Number(params.get('minScore') ?? 0.35)))
    const requestedDate = /^\d{4}-\d{2}-\d{2}$/.test(params.get('date') ?? '')
      ? params.get('date')
      : null
    const db = createDbAdapter(market)
    const indexMeta = await assertAnalogSequenceIndexReady(market)
    const baseRows = normalizePriceRows(await db.all<PriceRow>(
      `
      SELECT ticker, date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ticker = ?
        ${requestedDate ? 'AND date <= ?' : ''}
      ORDER BY date
      `,
      requestedDate ? [ticker, requestedDate] : [ticker],
    ))
    const baseSegments = buildPreparedSegments(baseRows)
    const basePrepared = baseSegments.at(-1)
    const baseIndex = basePrepared ? basePrepared.rows.length - 1 : -1
    if (!basePrepared || baseIndex < 240) {
      return NextResponse.json({ error: `${ticker} の局面比較に必要な価格履歴が不足しています。` }, { status: 404 })
    }
    const baseDate = basePrepared.rows[baseIndex].date
    const scoringProfile = maSequenceScoringProfileForMarket(market)
    const baseSelfScore = scoreMaSequence(
      basePrepared,
      baseIndex,
      basePrepared,
      baseIndex,
      scoringProfile,
    )
    const requiredComponents = baseSelfScore.components
      .filter((component) => component.available)
      .map((component) => component.key)
    const requiredCoverageMask = 1
      | (requiredComponents.includes('weekly') ? 2 : 0)
      | (requiredComponents.includes('longTerm') ? 8 : 0)
    const baseEmbedding = buildMaSequenceEmbedding(basePrepared, baseIndex)
    if (!baseEmbedding) {
      return NextResponse.json({ error: `${ticker} の局面埋め込みを生成できません。` }, { status: 422 })
    }
    const cacheKey = stableCacheKey({
      market,
      ticker,
      baseDate,
      indexSourceDate: indexMeta.sourceDate,
      version: MA_SEQUENCE_VERSION,
      scoreVersion: MA_SEQUENCE_SCORE_VERSION,
      approximateLimit: APPROXIMATE_LIMIT,
      exactPoolLimit: EXACT_POOL_LIMIT,
      maxAnchorsPerTicker: MAX_ANCHORS_PER_TICKER,
      localAlignedLimit: LOCAL_ALIGNED_LIMIT,
      localAlignedRadius: LOCAL_ALIGNED_RADIUS,
      stageShortlistLimit: STAGE_SHORTLIST_LIMIT,
      candidateHistoryDays: CANDIDATE_HISTORY_DAYS,
      candidateFutureDays: CANDIDATE_FUTURE_DAYS,
      maxOutcomeHorizon: MAX_OUTCOME_HORIZON,
      mlRerankWeight: ML_RERANK_WEIGHT,
      preferCompleteOutcomes: true,
      horizon,
      sort,
      limit,
      minScore,
    })
    const memoryCached = responseCache.get(cacheKey)
    if (memoryCached && Date.now() - memoryCached.generatedAt < CACHE_TTL_MS) {
      return NextResponse.json({
        ...memoryCached.payload,
        cache: { hit: true, generatedAt: new Date(memoryCached.generatedAt).toISOString() },
      })
    }
    const stored = await readServingCache<Record<string, unknown>>(CACHE_NAMESPACE, cacheKey, CACHE_TTL_MS)
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
      baseDate,
      indexSourceDate: indexMeta.sourceDate,
      version: MA_SEQUENCE_VERSION,
      scoreVersion: MA_SEQUENCE_SCORE_VERSION,
      approximateLimit: APPROXIMATE_LIMIT,
      exactPoolLimit: EXACT_POOL_LIMIT,
      maxAnchorsPerTicker: MAX_ANCHORS_PER_TICKER,
      localAlignedLimit: LOCAL_ALIGNED_LIMIT,
      localAlignedRadius: LOCAL_ALIGNED_RADIUS,
      stageShortlistLimit: STAGE_SHORTLIST_LIMIT,
      candidateHistoryDays: CANDIDATE_HISTORY_DAYS,
      candidateFutureDays: CANDIDATE_FUTURE_DAYS,
      maxOutcomeHorizon: MAX_OUTCOME_HORIZON,
      mlRerankWeight: ML_RERANK_WEIGHT,
    })
    const cachedCore = coreSearchCache.get(coreCacheKey)
    const freshCore = cachedCore && Date.now() - cachedCore.generatedAt < CACHE_TTL_MS
      ? cachedCore
      : null
    if (cachedCore && !freshCore) coreSearchCache.delete(coreCacheKey)
    let exactCore = freshCore?.exactRanked ?? null
    let searchDiagnostics = freshCore?.search ?? null

    if (!exactCore || !searchDiagnostics) {
    const excludeAfterDate = subtractCalendarDays(baseDate, 90)
    const initialIndexedCandidates = await searchAnalogSequenceIndex({
      market,
      bands: baseEmbedding.bands,
      beforeDate: baseDate,
      excludeTicker: ticker,
      excludeAfterDate,
      maxBitDistance: 0,
    })
    let coverageRejectedCount = initialIndexedCandidates.filter((row) =>
      (row.coverageMask & requiredCoverageMask) !== requiredCoverageMask,
    ).length
    let indexedCandidates = initialIndexedCandidates.filter((row) =>
      (row.coverageMask & requiredCoverageMask) === requiredCoverageMask,
    )
    if (indexedCandidates.length < 1_500) {
      const expanded = await searchAnalogSequenceIndex({
        market,
        bands: baseEmbedding.bands,
        beforeDate: baseDate,
        excludeTicker: ticker,
        excludeAfterDate,
        maxBitDistance: 1,
        perBandLimit: 8_000,
      })
      coverageRejectedCount += expanded.filter((row) =>
        (row.coverageMask & requiredCoverageMask) !== requiredCoverageMask,
      ).length
      const byKey = new Map(indexedCandidates.map((row) => [`${row.ticker}\u0000${row.date}`, row]))
      for (const row of expanded) {
        if ((row.coverageMask & requiredCoverageMask) !== requiredCoverageMask) continue
        const key = `${row.ticker}\u0000${row.date}`
        if (!byKey.has(key)) byKey.set(key, row)
      }
      indexedCandidates = [...byKey.values()]
    }
    const baseStageCode = stageCodeAt(basePrepared, baseIndex)
    const stageCandidates = baseStageCode
      ? (await searchAnalogSequenceIndexByStage({
          market,
          stageCodes: stageNeighborCodes(baseStageCode, 1),
          beforeDate: baseDate,
          excludeTicker: ticker,
          excludeAfterDate,
        })).filter((row) =>
          (row.coverageMask & requiredCoverageMask) === requiredCoverageMask,
        )
      : []
    const approximate = indexedCandidates
      .map((row) => ({
        ...row,
        approximationScore: maSequenceEmbeddingSimilarityRanges(
          baseEmbedding.quantized,
          row.embedding,
          [[0, 68]],
        ),
      }))
      .sort((a, b) =>
        (b.approximationScore + b.bandMatches * 0.005)
        - (a.approximationScore + a.bandMatches * 0.005),
      )

    const approximateShortlist: typeof approximate = []
    const anchorDates = new Map<string, string[]>()
    const appendCandidate = (row: (typeof approximate)[number]) => {
      const prior = anchorDates.get(row.ticker) ?? []
      if (prior.length >= MAX_ANCHORS_PER_TICKER) return false
      const currentTime = Date.parse(`${row.date}T00:00:00Z`)
      if (prior.some((date) =>
        Math.abs(currentTime - Date.parse(`${date}T00:00:00Z`)) < 15 * 86_400_000,
      )) return false
      approximateShortlist.push(row)
      anchorDates.set(row.ticker, [...prior, row.date])
      return true
    }
    const stageApproximate = stageCandidates
      .map((row) => ({
        ...row,
        approximationScore: maSequenceEmbeddingSimilarityRanges(
          baseEmbedding.quantized,
          row.embedding,
          [[0, 68]],
        ),
      }))
      .sort((a, b) =>
        Number(b.stageCode === baseStageCode) - Number(a.stageCode === baseStageCode)
        || b.approximationScore - a.approximationScore,
      )
    let stageShortlistCount = 0
    for (const row of stageApproximate) {
      if (appendCandidate(row)) stageShortlistCount += 1
      if (stageShortlistCount >= STAGE_SHORTLIST_LIMIT) break
    }
    for (const row of approximate) {
      if (approximateShortlist.length >= APPROXIMATE_LIMIT) break
      appendCandidate(row)
    }
    const candidateRanges = buildCandidateRanges(approximateShortlist, baseDate)
    const anchorsByTicker = new Map<string, typeof approximateShortlist>()
    for (const anchor of approximateShortlist) {
      const anchors = anchorsByTicker.get(anchor.ticker) ?? []
      anchors.push(anchor)
      anchorsByTicker.set(anchor.ticker, anchors)
    }
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
          index: number
          date: string
          score: number
        }> = []
        for (let offset = -LOCAL_ALIGNED_RADIUS; offset <= LOCAL_ALIGNED_RADIUS; offset += 1) {
          const candidateIndex = located.index + offset
          const row = located.prepared.rows[candidateIndex]
          if (!row || candidateIndex < 240 || row.date >= baseDate) continue
          if (anchor.ticker === ticker && row.date >= excludeAfterDate) continue
          const aligned = scoreMaSequenceAligned(
            basePrepared,
            baseIndex,
            located.prepared,
            candidateIndex,
            scoringProfile,
          )
          alignedCount += 1
          localAligned.push({
            index: candidateIndex,
            date: row.date,
            score: aligned.score,
          })
        }
        for (const local of localAligned
          .sort((a, b) => b.score - a.score)
          .slice(0, LOCAL_ALIGNED_LIMIT)) {
          const result = scoreMaSequence(
            basePrepared,
            baseIndex,
            located.prepared,
            local.index,
            scoringProfile,
          )
          const availableKeys = new Set(
            result.components
              .filter((component) => component.available)
              .map((component) => component.key),
          )
          if (!requiredComponents.every((key) => availableKeys.has(key))) {
            exactCoverageRejectedCount += 1
            continue
          }
          const key = `${anchor.ticker}\u0000${local.date}`
          const existing = exactByKey.get(key)
          if (existing && existing.score >= result.score) continue
          exactByKey.set(key, {
            ticker: anchor.ticker,
            date: local.date,
            score: result.score,
            components: result.components,
            approximationScore: anchor.approximationScore,
            bandMatches: anchor.bandMatches,
            stageCode: stageCodeAt(located.prepared, local.index),
            preWindow: buildPreWindow(located.prepared, local.index),
            stagePath: compactStagePath(located.prepared, local.index),
            outcome: buildOutcome(located.prepared, local.index, MAX_OUTCOME_HORIZON),
          })
        }
      }
    }
    const maRanked = [...exactByKey.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(500, Math.max(EXACT_POOL_LIMIT, 320)))
    const vectorScores = await loadVectorScores(db, ticker, baseDate, maRanked)
    exactCore = maRanked
      .map((row) => {
        const vectorScore = vectorScores.get(`${row.ticker}\u0000${row.date}`)
        if (vectorScore == null) return row
        return {
          ...row,
          score: row.score * (1 - ML_RERANK_WEIGHT) + vectorScore * ML_RERANK_WEIGHT,
          components: [
            ...row.components,
            {
              key: 'mlFeatures',
              label: '学習特徴量',
              score: vectorScore,
              weight: ML_RERANK_WEIGHT,
              available: true,
            },
          ],
        }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, EXACT_POOL_LIMIT)
    searchDiagnostics = {
      method: 'multiscale-ma-sequence-lsh + exact-aligned-dtw',
      maPeriods: MA_SEQUENCE_PERIODS,
      dailyWindows: [10, 20, 40],
      higherTimeframes: ['weekly', 'monthly', 'monthly-derived-long-term'],
      monthlyPeriods: MA_SEQUENCE_MONTHLY_PERIODS,
      longTermPeriods: MA_SEQUENCE_LONG_TERM_PERIODS,
      scoringProfile: {
        key: scoringProfile.key,
        label: scoringProfile.label,
      },
      mlRerankWeight: ML_RERANK_WEIGHT,
      indexedCandidateCount: indexedCandidates.length,
      coverageRejectedCount,
      exactCoverageRejectedCount,
      requiredComponents,
      approximateCount: approximateShortlist.length,
      stageCandidateCount: stageCandidates.length,
      stageShortlistCount,
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
    const exactRanked = exactCore.map((row) => ({
      ...row,
      outcome: projectOutcome(row.outcome, horizon),
    }))
    const filtered = exactRanked.filter((row) => row.score >= minScore)
    const completeFiltered = filtered.filter((row) => row.outcome.complete)
    const completeRanked = exactRanked.filter((row) => row.outcome.complete)
    const similarityPool = filtered.length >= limit ? filtered : exactRanked
    const outcomePool = completeFiltered.length >= limit
      ? completeFiltered
      : completeRanked.length >= limit
        ? completeRanked
        : similarityPool
    const sortablePool = sort === 'similarity' ? similarityPool : outcomePool
    const selected = diversify(sortExact(sortablePool, sort), limit)
    const metadata = await loadTickerMetadata(db, [
      ticker,
      ...new Set(selected.map((row) => row.ticker)),
    ])
    const analogs = selected.map((row, index) => {
      const info = metadata.get(row.ticker)
      return {
        rank: index + 1,
        ticker: row.ticker,
        name: info?.name ?? null,
        marketSegment: info?.market_segment ?? null,
        sector17Name: info?.sector17_name ?? null,
        sector33Name: info?.sector33_name ?? null,
        caseDate: row.date,
        stageCode: row.stageCode,
        similarityScore: row.score,
        approximationScore: row.approximationScore,
        bandMatches: row.bandMatches,
        components: componentReasons(row.components),
        preWindow: row.preWindow,
        stagePath: row.stagePath,
        outcome: row.outcome,
      }
    })
    const generatedAt = Date.now()
    const payload = {
      market,
      ticker,
      asOfDate: baseDate,
      featureSet: `ma_sequence_score_v${MA_SEQUENCE_SCORE_VERSION}_index_v${MA_SEQUENCE_VERSION}`,
      base: {
        ticker,
        name: metadata.get(ticker)?.name ?? null,
        date: baseDate,
        stageCode: stageCodeAt(basePrepared, baseIndex),
        preWindow: buildPreWindow(basePrepared, baseIndex),
        stagePath: compactStagePath(basePrepared, baseIndex),
      },
      horizon,
      sort,
      minScore,
      summary: summarizeOutcomes(selected),
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
      console.warn('historical analog sequence cache write failed:', error)
    })
    return NextResponse.json(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('historical analog sequence search failed:', error)
    const indexMissing = /局面検索索引が未構築/.test(message)
    return NextResponse.json({
      error: indexMissing ? message : '過去局面検索に失敗しました。',
      code: indexMissing ? 'ANALOG_SEQUENCE_INDEX_REQUIRED' : 'ANALOG_SEQUENCE_SEARCH_FAILED',
      message,
    }, { status: indexMissing ? 503 : 500 })
  }
}

import { execAll, execGet, execRun } from '@/lib/db/client'
import { inferLikelySplitAdjustment } from '@/lib/physical-momentum'
import {
  US_ADJUSTED_CLOSE_SQL,
  US_ADJUSTED_HIGH_SQL,
  US_ADJUSTED_LOW_SQL,
  US_ADJUSTED_OPEN_SQL,
  US_ADJUSTED_PRICE_BASIS,
  US_ADJUSTED_VOLUME_SQL,
} from '@/lib/us-adjusted-ohlcv'
import {
  detectRisingCloseLines,
  twoYearBlockStartYear,
  twoYearPeriod,
  type TwoYearCandle,
  type TwoYearMarket,
} from '@/lib/two-year-candles'
import {
  matchesTwoYearLineQuery,
  selectTwoYearLineSummaryForQuery,
  summarizeTwoYearLine,
  type TwoYearLineFilter,
  type TwoYearLineQuery,
  type TwoYearLineSummary,
  type TwoYearRegistryAvailability,
} from '@/lib/two-year-line-registry'

export interface TwoYearLineSearchEntry {
  ticker: string
  summaries: readonly TwoYearLineSummary[]
  hasConfirmed: boolean
  hasProvisional: boolean
  latest: TwoYearLineSummary | null
  latestConfirmed: TwoYearLineSummary | null
  latestProvisional: TwoYearLineSummary | null
  availability: TwoYearRegistryAvailability
}

export interface TwoYearLineSearchMetadata {
  market: TwoYearMarket
  asOfDate: string
  priceBasisVersion: string
  calendarProxy: '1306' | 'SPY'
  calendarAvailable: boolean
  requestedTickerCount: number
  availableTickerCount: number
  unavailableTickerCount: number
}

export interface TwoYearLineSearchResult {
  entries: Map<string, TwoYearLineSearchEntry>
  metadata: TwoYearLineSearchMetadata
}

interface SearchCacheEntry {
  expiresAt: number
  sessions: string[]
  entries: Map<string, TwoYearLineSearchEntry>
}

interface SourceGenerationState {
  latestRunId: number
  latestPublishableRunId: number
  runningCount: number
}

interface PersistedServingPayload {
  schemaVersion: 1
  definitionVersion: string
  market: TwoYearMarket
  asOfDate: string
  priceBasisVersion: string
  calendarProxy: '1306' | 'SPY'
  calendarAvailable: boolean
  sourceGeneration: number
  generatedAt: number
  entries: TwoYearLineSearchEntry[]
}

interface PersistedServingRow {
  payloadJson: string
  computedAt: number
}

interface ServingMemoEntry {
  computedAt: number
  payload: PersistedServingPayload
}

export interface TwoYearLineServingBuildResult {
  cacheKey: string
  sourceGeneration: number
  generatedAt: number
  elapsedMs: number
  result: TwoYearLineSearchResult
}

export class TwoYearLineServingUnavailableError extends Error {
  readonly status = 503

  constructor(message: string) {
    super(message)
    this.name = 'TwoYearLineServingUnavailableError'
  }
}

interface CompactBlockRow {
  ticker: string
  startYear: number
  firstSourceDate: string
  lastSourceDate: string
  rawOpen: number
  rawClose: number
  observedCount: number
  matchedSessionCount: number
}

interface SplitCandidateRow {
  ticker: string
  previousDate: string
  currentDate: string
  previousClose: number
  currentClose: number
  previousVolume: number
  currentVolume: number
}

interface SplitEvent {
  date: string
  factor: number
}

const globalCache = globalThis as typeof globalThis & {
  __twoYearLineSearchCacheV4?: Map<string, SearchCacheEntry>
  __twoYearLineServingMemoV1?: Map<string, ServingMemoEntry>
}
globalCache.__twoYearLineSearchCacheV4 ??= new Map()
globalCache.__twoYearLineServingMemoV1 ??= new Map()

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_KEYS = 4
const CHUNK_SIZE = 500
const SEARCH_BLOCK_COUNT = 5
const SERVING_SCHEMA_VERSION = 1 as const
const SERVING_CACHE_PREFIX = 'two-year-line-serving:v1'
const SERVING_CACHE_RETAIN_PER_MARKET = 8
const SERVING_MEMO_MAX_KEYS = 4
export const TWO_YEAR_LINE_SERVING_DEFINITION_VERSION = 'patterns-v1+angle-v1+jp-split-inference-v1'

/** Reads only a precomputed, generation-matched serving payload. */
export async function loadTwoYearLineSearchEntries(options: Readonly<{
  market: TwoYearMarket
  tickers: readonly string[]
  asOfDate: string
}>): Promise<TwoYearLineSearchResult> {
  const tickers = [...new Set(options.tickers.map(normalizeTicker).filter(Boolean))].sort()
  const benchmark = options.market === 'JP' ? '1306' : 'SPY'
  const priceBasisVersion = priceBasisVersionForMarket(options.market)
  const effectiveAsOfDate = await resolveEffectiveAsOfDate(options.market, options.asOfDate, benchmark)
  const source = await readSourceGeneration(options.market)
  assertSafeSourceGeneration(options.market, source)
  const cacheKey = servingCacheKey({
    market: options.market,
    asOfDate: effectiveAsOfDate,
    priceBasisVersion,
    sourceGeneration: source.latestRunId,
  })
  const payload = await readServingPayload(cacheKey)
  if (!payload) {
    throw new TwoYearLineServingUnavailableError(
      `${options.market} 24-month screener serving cache is unavailable for ${effectiveAsOfDate}`,
    )
  }
  assertServingPayload(payload, {
    market: options.market,
    asOfDate: effectiveAsOfDate,
    priceBasisVersion,
    sourceGeneration: source.latestRunId,
  })
  const allEntries = new Map(payload.entries.map((entry) => [entry.ticker, entry]))
  const missing = tickers.filter((ticker) => !allEntries.has(ticker))
  if (missing.length > 0) {
    throw new TwoYearLineServingUnavailableError(
      `${options.market} 24-month screener cache does not cover ${missing.length} requested ticker(s)`,
    )
  }
  const entries = new Map(tickers.map((ticker) => [ticker, allEntries.get(ticker)!]))
  const sourceAfter = await readSourceGeneration(options.market)
  assertSafeSourceGeneration(options.market, sourceAfter)
  if (sourceAfter.latestRunId !== source.latestRunId) {
    throw new TwoYearLineServingUnavailableError(
      `${options.market} source generation changed while reading the 24-month serving cache`,
    )
  }
  const availableTickerCount = [...entries.values()].filter((entry) => entry.availability === 'available').length
  return {
    entries,
    metadata: {
      market: options.market,
      asOfDate: effectiveAsOfDate,
      priceBasisVersion,
      calendarProxy: benchmark,
      calendarAvailable: payload.calendarAvailable,
      requestedTickerCount: tickers.length,
      availableTickerCount,
      unavailableTickerCount: tickers.length - availableTickerCount,
    },
  }
}

/**
 * Computes the registry from bounded historical rows. This is intentionally
 * exported for the update-time builder and parity tests, never for API fallback.
 */
export async function computeTwoYearLineSearchEntries(options: Readonly<{
  market: TwoYearMarket
  tickers: readonly string[]
  asOfDate: string
  sourceGeneration?: number
}>): Promise<TwoYearLineSearchResult> {
  const tickers = [...new Set(options.tickers.map(normalizeTicker).filter(Boolean))].sort()
  const benchmark = options.market === 'JP' ? '1306' : 'SPY'
  const priceBasisVersion = priceBasisVersionForMarket(options.market)
  const cache = await getSearchCache(
    options.market,
    options.asOfDate,
    benchmark,
    options.sourceGeneration ?? 0,
  )
  const effectiveAsOfDate = cache.sessions.at(-1) ?? options.asOfDate
  const historyStartDate = twoYearLineSearchHistoryStartDate(effectiveAsOfDate)
  const missing = tickers.filter((ticker) => !cache.entries.has(ticker))

  for (let offset = 0; offset < missing.length; offset += CHUNK_SIZE) {
    const chunk = missing.slice(offset, offset + CHUNK_SIZE)
    const blockRows = options.market === 'JP'
      ? await loadJpCompactBlocks(chunk, historyStartDate, effectiveAsOfDate)
      : await loadUsCompactBlocks(chunk, historyStartDate, effectiveAsOfDate)
    const splitEvents = options.market === 'JP'
      ? await loadJpSplitEvents(chunk, historyStartDate, effectiveAsOfDate)
      : new Map<string, SplitEvent[]>()
    const blocksByTicker = groupBlocks(blockRows)

    for (const ticker of chunk) {
      cache.entries.set(ticker, buildSearchEntry({
        market: options.market,
        ticker,
        asOfDate: effectiveAsOfDate,
        sessions: cache.sessions,
        blocks: blocksByTicker.get(ticker) ?? [],
        splitEvents: splitEvents.get(ticker) ?? [],
      }))
    }
  }

  const entries = new Map(tickers.map((ticker) => [ticker, cache.entries.get(ticker)!]))
  const availableTickerCount = [...entries.values()].filter((entry) => entry.availability === 'available').length
  return {
    entries,
    metadata: {
      market: options.market,
      asOfDate: effectiveAsOfDate,
      priceBasisVersion,
      calendarProxy: benchmark,
      calendarAvailable: cache.sessions.length > 0,
      requestedTickerCount: tickers.length,
      availableTickerCount,
      unavailableTickerCount: tickers.length - availableTickerCount,
    },
  }
}

export async function buildTwoYearLineServingCache(options: Readonly<{
  market: TwoYearMarket
  tickers: readonly string[]
  asOfDate: string
  beforePersistForQa?: () => Promise<void>
}>): Promise<TwoYearLineServingBuildResult> {
  const startedAt = Date.now()
  const sourceBefore = await readSourceGeneration(options.market)
  assertSafeSourceGeneration(options.market, sourceBefore)
  const result = await computeTwoYearLineSearchEntries({
    ...options,
    sourceGeneration: sourceBefore.latestRunId,
  })
  await options.beforePersistForQa?.()
  const sourceAfter = await readSourceGeneration(options.market)
  assertSafeSourceGeneration(options.market, sourceAfter)
  if (sourceBefore.latestRunId !== sourceAfter.latestRunId) {
    throw new TwoYearLineServingUnavailableError(
      `${options.market} source generation changed during 24-month serving build`,
    )
  }

  const generatedAt = Date.now()
  const payload: PersistedServingPayload = {
    schemaVersion: SERVING_SCHEMA_VERSION,
    definitionVersion: TWO_YEAR_LINE_SERVING_DEFINITION_VERSION,
    market: options.market,
    asOfDate: result.metadata.asOfDate,
    priceBasisVersion: result.metadata.priceBasisVersion,
    calendarProxy: result.metadata.calendarProxy,
    calendarAvailable: result.metadata.calendarAvailable,
    sourceGeneration: sourceAfter.latestRunId,
    generatedAt,
    entries: [...result.entries.values()],
  }
  const cacheKey = servingCacheKey({
    market: options.market,
    asOfDate: payload.asOfDate,
    priceBasisVersion: payload.priceBasisVersion,
    sourceGeneration: payload.sourceGeneration,
  })
  await execRun(
    `INSERT INTO dashboard_trade_signal_cache (cache_key, payload_json, computed_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET
       payload_json = excluded.payload_json,
       computed_at = excluded.computed_at`,
    [cacheKey, JSON.stringify(payload), generatedAt],
  )
  setServingMemo(cacheKey, { computedAt: generatedAt, payload })
  await pruneServingCache(options.market, payload.sourceGeneration)
  return {
    cacheKey,
    sourceGeneration: payload.sourceGeneration,
    generatedAt,
    elapsedMs: Date.now() - startedAt,
    result,
  }
}

export function clearTwoYearLineSearchCachesForQa(): void {
  globalCache.__twoYearLineSearchCacheV4!.clear()
  globalCache.__twoYearLineServingMemoV1!.clear()
}

export function twoYearLineServingCacheSqlForQa(): string {
  return 'SELECT payload_json AS payloadJson, computed_at AS computedAt FROM dashboard_trade_signal_cache WHERE cache_key = ?'
}

/**
 * The registry can expose only the current provisional line and the line ending
 * at the immediately preceding confirmed block. A four-candle line therefore
 * needs the current block plus four preceding blocks, and no earlier prices.
 */
export function twoYearLineSearchHistoryStartDate(asOfDate: string): string {
  const currentBlockStartYear = twoYearBlockStartYear(asOfDate)
  return `${currentBlockStartYear - ((SEARCH_BLOCK_COUNT - 1) * 2)}-01-01`
}

export function twoYearLineSearchSqlForQa(
  market: TwoYearMarket,
  tickerCount: number,
): Readonly<{ compactBlocks: string; splitEvents: string | null }> {
  if (!Number.isInteger(tickerCount) || tickerCount < 1 || tickerCount > CHUNK_SIZE) {
    throw new RangeError(`tickerCount must be between 1 and ${CHUNK_SIZE}`)
  }
  const placeholders = Array.from({ length: tickerCount }, () => '?').join(',')
  return market === 'JP'
    ? { compactBlocks: jpCompactBlocksSql(placeholders), splitEvents: jpSplitEventsSql(placeholders) }
    : { compactBlocks: usCompactBlocksSql(placeholders), splitEvents: null }
}

export function selectTwoYearLineSummary(
  entry: TwoYearLineSearchEntry | undefined,
  filter: TwoYearLineFilter | TwoYearLineQuery,
): TwoYearLineSummary | null {
  if (!entry) return null
  const query: TwoYearLineQuery = typeof filter === 'string'
    ? { status: filter, pattern: 'either', minAngleDeg: null, maxAngleDeg: null }
    : filter
  return selectTwoYearLineSummaryForQuery(entry.summaries, query)
}

export function matchesTwoYearLineSearchEntry(
  entry: TwoYearLineSearchEntry | undefined,
  query: TwoYearLineQuery,
): boolean {
  return Boolean(entry && entry.availability === 'available' && matchesTwoYearLineQuery(entry.summaries, query))
}

async function resolveEffectiveAsOfDate(
  market: TwoYearMarket,
  asOfDate: string,
  benchmark: '1306' | 'SPY',
): Promise<string> {
  const row = market === 'JP'
    ? await execGet<{ date: string | null }>(
        'SELECT MAX(date) AS date FROM ohlcv_daily WHERE ticker = ? AND date <= ?',
        [benchmark, asOfDate],
      )
    : await execGet<{ date: string | null }>(
        "SELECT MAX(date) AS date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = ? AND date <= ?",
        [benchmark, asOfDate],
      )
  return row?.date ?? asOfDate
}

async function readSourceGeneration(market: TwoYearMarket): Promise<SourceGenerationState> {
  const row = market === 'JP'
    ? await execGet<Record<string, unknown>>(
        `WITH relevant AS (
           SELECT id, status
           FROM batch_runs
           WHERE job_type = 'ohlcv_fetch:jquants'
         ), latest AS (
           SELECT id, status FROM relevant ORDER BY id DESC LIMIT 1
         )
         SELECT
           COALESCE((SELECT id FROM latest), 0) AS latestRunId,
           COALESCE((SELECT MAX(id) FROM relevant WHERE status IN ('success', 'partial')), 0) AS latestPublishableRunId,
           CASE WHEN (SELECT status FROM latest) = 'running' THEN 1 ELSE 0 END AS runningCount`,
      )
    : await execGet<Record<string, unknown>>(
        `WITH relevant AS (
           SELECT id, status
           FROM market_data_runs
           WHERE market = 'US' AND job_type = 'tiingo_ohlcv'
         ), latest AS (
           SELECT id, status FROM relevant ORDER BY id DESC LIMIT 1
         )
         SELECT
           COALESCE((SELECT id FROM latest), 0) AS latestRunId,
           COALESCE((SELECT MAX(id) FROM relevant WHERE status IN ('success', 'partial')), 0) AS latestPublishableRunId,
           CASE WHEN (SELECT status FROM latest) = 'running' THEN 1 ELSE 0 END AS runningCount`,
      )
  return {
    latestRunId: numberValue(row?.latestRunId),
    latestPublishableRunId: numberValue(row?.latestPublishableRunId),
    runningCount: numberValue(row?.runningCount),
  }
}

function assertSafeSourceGeneration(market: TwoYearMarket, source: SourceGenerationState): void {
  if (
    source.latestRunId <= 0
    || source.latestPublishableRunId !== source.latestRunId
    || source.runningCount !== 0
  ) {
    throw new TwoYearLineServingUnavailableError(
      `${market} 24-month serving source is not a completed immutable generation`,
    )
  }
}

function priceBasisVersionForMarket(market: TwoYearMarket): string {
  return market === 'JP' ? 'jp-split-normalized-v1' : US_ADJUSTED_PRICE_BASIS
}

function servingCacheKey(options: Readonly<{
  market: TwoYearMarket
  asOfDate: string
  priceBasisVersion: string
  sourceGeneration: number
}>): string {
  return [
    SERVING_CACHE_PREFIX,
    options.market,
    options.asOfDate,
    options.priceBasisVersion,
    TWO_YEAR_LINE_SERVING_DEFINITION_VERSION,
    String(options.sourceGeneration),
  ].map(encodeURIComponent).join(':')
}

async function readServingPayload(cacheKey: string): Promise<PersistedServingPayload | null> {
  const row = await execGet<PersistedServingRow>(twoYearLineServingCacheSqlForQa(), [cacheKey])
  if (!row) return null
  const computedAt = numberValue(row.computedAt)
  const memo = globalCache.__twoYearLineServingMemoV1!.get(cacheKey)
  if (memo?.computedAt === computedAt) return memo.payload
  let candidate: unknown
  try {
    candidate = JSON.parse(row.payloadJson)
  } catch {
    throw new TwoYearLineServingUnavailableError('24-month screener cache payload is not valid JSON')
  }
  const payload = parseServingPayload(candidate)
  setServingMemo(cacheKey, { computedAt, payload })
  return payload
}

function setServingMemo(cacheKey: string, value: ServingMemoEntry): void {
  const memo = globalCache.__twoYearLineServingMemoV1!
  memo.delete(cacheKey)
  memo.set(cacheKey, value)
  while (memo.size > SERVING_MEMO_MAX_KEYS) {
    const oldestKey = memo.keys().next().value as string | undefined
    if (!oldestKey) break
    memo.delete(oldestKey)
  }
}

function assertServingPayload(
  payload: PersistedServingPayload,
  expected: Readonly<{
    market: TwoYearMarket
    asOfDate: string
    priceBasisVersion: string
    sourceGeneration: number
  }>,
): void {
  if (
    payload.schemaVersion !== SERVING_SCHEMA_VERSION
    || payload.definitionVersion !== TWO_YEAR_LINE_SERVING_DEFINITION_VERSION
    || payload.market !== expected.market
    || payload.asOfDate !== expected.asOfDate
    || payload.priceBasisVersion !== expected.priceBasisVersion
    || payload.sourceGeneration !== expected.sourceGeneration
  ) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache metadata does not match the request')
  }
}

function parseServingPayload(value: unknown): PersistedServingPayload {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache payload has an invalid shape')
  }
  const entries = value.entries.map(parseServingEntry)
  const tickers = new Set(entries.map((entry) => entry.ticker))
  if (tickers.size !== entries.length) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache contains duplicate tickers')
  }
  if (
    value.schemaVersion !== SERVING_SCHEMA_VERSION
    || value.definitionVersion !== TWO_YEAR_LINE_SERVING_DEFINITION_VERSION
    || (value.market !== 'JP' && value.market !== 'US')
    || typeof value.asOfDate !== 'string'
    || typeof value.priceBasisVersion !== 'string'
    || (value.calendarProxy !== '1306' && value.calendarProxy !== 'SPY')
    || typeof value.calendarAvailable !== 'boolean'
    || !isPositiveInteger(value.sourceGeneration)
    || !isNonNegativeFiniteNumber(value.generatedAt)
  ) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache metadata is invalid')
  }
  if (!value.calendarAvailable && entries.some((entry) => entry.availability === 'available')) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache calendar state is inconsistent')
  }
  return {
    schemaVersion: SERVING_SCHEMA_VERSION,
    definitionVersion: TWO_YEAR_LINE_SERVING_DEFINITION_VERSION,
    market: value.market,
    asOfDate: value.asOfDate,
    priceBasisVersion: value.priceBasisVersion,
    calendarProxy: value.calendarProxy,
    calendarAvailable: value.calendarAvailable,
    sourceGeneration: value.sourceGeneration,
    generatedAt: value.generatedAt,
    entries,
  }
}

function parseServingEntry(value: unknown): TwoYearLineSearchEntry {
  if (!isRecord(value) || typeof value.ticker !== 'string' || normalizeTicker(value.ticker) !== value.ticker) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache contains an invalid ticker entry')
  }
  if (
    !Array.isArray(value.summaries)
    || typeof value.hasConfirmed !== 'boolean'
    || typeof value.hasProvisional !== 'boolean'
    || !isRegistryAvailability(value.availability)
  ) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache contains an invalid search entry')
  }
  const summaries = value.summaries.map(parseLineSummary)
  const byId = new Map(summaries.map((summary) => [summary.lineId, summary]))
  const parsed: TwoYearLineSearchEntry = {
    ticker: value.ticker,
    summaries,
    hasConfirmed: value.hasConfirmed,
    hasProvisional: value.hasProvisional,
    latest: parseSummaryReference(value.latest, byId),
    latestConfirmed: parseSummaryReference(value.latestConfirmed, byId),
    latestProvisional: parseSummaryReference(value.latestProvisional, byId),
    availability: value.availability,
  }
  if (
    parsed.hasConfirmed !== summaries.some((summary) => summary.status === 'confirmed')
    || parsed.hasProvisional !== summaries.some((summary) => summary.status === 'provisional')
    || (parsed.latestConfirmed !== null && parsed.latestConfirmed.status !== 'confirmed')
    || (parsed.latestProvisional !== null && parsed.latestProvisional.status !== 'provisional')
    || (parsed.availability !== 'available' && summaries.length > 0)
  ) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache entry flags are inconsistent')
  }
  return parsed
}

function parseLineSummary(value: unknown): TwoYearLineSummary {
  if (
    !isRecord(value)
    || typeof value.lineId !== 'string'
    || (value.pattern !== 'three' && value.pattern !== 'four')
    || (value.status !== 'confirmed' && value.status !== 'provisional')
    || !Array.isArray(value.sourcePeriods)
    || !value.sourcePeriods.every(isInteger)
    || value.sourcePeriods.length !== (value.pattern === 'three' ? 3 : 4)
    || !Array.isArray(value.anchorDates)
    || value.anchorDates.length !== 2
    || !value.anchorDates.every((date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
  ) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache contains an invalid line summary')
  }
  for (const key of [
    'lineStartClose', 'lineEndClose', 'lastCandleOpen', 'lastCandleClose', 'lastCandleRisePct', 'angleDeg',
  ] as const) {
    if (!isFiniteNumber(value[key])) {
      throw new TwoYearLineServingUnavailableError(`24-month screener cache has invalid ${key}`)
    }
  }
  if (
    numberValue(value.lineStartClose) <= 0
    || numberValue(value.lineEndClose) <= 0
    || numberValue(value.lastCandleOpen) <= 0
    || numberValue(value.lastCandleClose) <= 0
  ) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache has non-positive line prices')
  }
  for (const key of ['linePriceAsOf', 'currentConfirmedClose', 'distancePct'] as const) {
    if (value[key] !== null && !isFiniteNumber(value[key])) {
      throw new TwoYearLineServingUnavailableError(`24-month screener cache has invalid ${key}`)
    }
  }
  return value as unknown as TwoYearLineSummary
}

function parseSummaryReference(
  value: unknown,
  summaries: ReadonlyMap<string, TwoYearLineSummary>,
): TwoYearLineSummary | null {
  if (value === null) return null
  const parsed = parseLineSummary(value)
  const canonical = summaries.get(parsed.lineId)
  if (!canonical || JSON.stringify(canonical) !== JSON.stringify(parsed)) {
    throw new TwoYearLineServingUnavailableError('24-month screener cache has an invalid line reference')
  }
  return canonical
}

async function pruneServingCache(market: TwoYearMarket, sourceGeneration: number): Promise<void> {
  const prefix = `${[SERVING_CACHE_PREFIX, market].map(encodeURIComponent).join(':')}:%`
  const rows = await execAll<{ cacheKey: string }>(
    `SELECT cache_key AS cacheKey
     FROM dashboard_trade_signal_cache
     WHERE cache_key LIKE ?
     ORDER BY computed_at DESC, cache_key DESC`,
    [prefix],
  )
  const currentGenerationKeys = rows
    .map((row) => ({ cacheKey: row.cacheKey, parts: servingCacheKeyParts(row.cacheKey) }))
    .filter((row) => row.parts?.sourceGeneration === sourceGeneration)
    .sort((left, right) => right.parts!.asOfDate.localeCompare(left.parts!.asOfDate))
  const protectedCurrentKey = currentGenerationKeys[0]?.cacheKey
  const retained = new Set<string>()
  if (protectedCurrentKey) retained.add(protectedCurrentKey)
  for (const row of rows) {
    if (retained.size >= SERVING_CACHE_RETAIN_PER_MARKET) break
    retained.add(row.cacheKey)
  }
  const staleKeys = rows.filter((row) => !retained.has(row.cacheKey)).map((row) => row.cacheKey)
  for (const cacheKey of staleKeys) {
    await execRun('DELETE FROM dashboard_trade_signal_cache WHERE cache_key = ?', [cacheKey])
    globalCache.__twoYearLineServingMemoV1!.delete(cacheKey)
  }
}

function servingCacheKeyParts(cacheKey: string): { asOfDate: string; sourceGeneration: number } | null {
  const parts = cacheKey.split(':')
  if (parts.length !== 6 || decodeURIComponent(parts[0]) !== SERVING_CACHE_PREFIX) return null
  const sourceGeneration = Number(parts[5])
  if (!Number.isInteger(sourceGeneration) || sourceGeneration <= 0) return null
  return { asOfDate: decodeURIComponent(parts[2]), sourceGeneration }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRegistryAvailability(value: unknown): value is TwoYearRegistryAvailability {
  return value === 'available' || value === 'calendar_unavailable' || value === 'history_unavailable'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isPositiveInteger(value: unknown): value is number {
  return isInteger(value) && value > 0
}

async function getSearchCache(
  market: TwoYearMarket,
  asOfDate: string,
  benchmark: '1306' | 'SPY',
  sourceGeneration: number,
): Promise<SearchCacheEntry> {
  const key = `${market}:${asOfDate}:${sourceGeneration}`
  const now = Date.now()
  for (const [cacheKey, value] of globalCache.__twoYearLineSearchCacheV4!) {
    if (value.expiresAt <= now) globalCache.__twoYearLineSearchCacheV4!.delete(cacheKey)
  }
  const cached = globalCache.__twoYearLineSearchCacheV4!.get(key)
  if (cached) return cached

  // The requested date may be beyond the latest confirmed market session and
  // therefore in the next two-year block. Read one extra benchmark block, then
  // trim after resolving the effective as-of date.
  const sessionHistoryStartDate = `${twoYearBlockStartYear(asOfDate) - (SEARCH_BLOCK_COUNT * 2)}-01-01`
  const candidateSessions = market === 'JP'
    ? (await execAll<{ date: string }>(
        'SELECT date FROM ohlcv_daily WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date',
        [benchmark, sessionHistoryStartDate, asOfDate],
      )).map((row) => row.date)
    : (await execAll<{ date: string }>(
        "SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = ? AND date >= ? AND date <= ? ORDER BY date",
        [benchmark, sessionHistoryStartDate, asOfDate],
      )).map((row) => row.date)
  const effectiveAsOfDate = candidateSessions.at(-1) ?? asOfDate
  const historyStartDate = twoYearLineSearchHistoryStartDate(effectiveAsOfDate)
  const sessions = candidateSessions.filter((date) => date >= historyStartDate)
  const created: SearchCacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    sessions,
    entries: new Map(),
  }
  globalCache.__twoYearLineSearchCacheV4!.set(key, created)
  while (globalCache.__twoYearLineSearchCacheV4!.size > MAX_CACHE_KEYS) {
    const oldestKey = globalCache.__twoYearLineSearchCacheV4!.keys().next().value as string | undefined
    if (!oldestKey) break
    globalCache.__twoYearLineSearchCacheV4!.delete(oldestKey)
  }
  return created
}

async function loadJpCompactBlocks(
  tickers: readonly string[],
  historyStartDate: string,
  asOfDate: string,
): Promise<CompactBlockRow[]> {
  if (tickers.length === 0) return []
  const placeholders = tickers.map(() => '?').join(',')
  return execAll<CompactBlockRow>(
    jpCompactBlocksSql(placeholders),
    [...tickers, historyStartDate, asOfDate, historyStartDate, asOfDate],
  )
}

function jpCompactBlocksSql(placeholders: string): string {
  return `WITH valid AS (
       SELECT
         ticker, date, open, close,
         CAST(substr(date, 1, 4) AS INTEGER) - (CAST(substr(date, 1, 4) AS INTEGER) % 2) AS startYear
       FROM ohlcv_daily
       WHERE ticker IN (${placeholders}) AND date >= ? AND date <= ?
         AND open > 0 AND high > 0 AND low > 0 AND close > 0 AND volume >= 0
         AND high >= MAX(open, close, low) AND low <= MIN(open, close, high)
     ), market_sessions AS MATERIALIZED (
       SELECT date
       FROM ohlcv_daily
       WHERE ticker = '1306' AND date >= ? AND date <= ?
     ), stats AS (
       SELECT
         valid.ticker,
         valid.startYear,
         MIN(valid.date) AS firstSourceDate,
         MAX(valid.date) AS lastSourceDate,
         COUNT(*) AS observedCount,
         SUM(CASE WHEN valid.date IN (SELECT date FROM market_sessions) THEN 1 ELSE 0 END) AS matchedSessionCount
       FROM valid
       GROUP BY valid.ticker, valid.startYear
     )
     SELECT
       stats.ticker,
       stats.startYear,
       stats.firstSourceDate,
       stats.lastSourceDate,
       (SELECT firstRow.open
        FROM ohlcv_daily AS firstRow
        WHERE firstRow.ticker = stats.ticker AND firstRow.date = stats.firstSourceDate) AS rawOpen,
       (SELECT lastRow.close
        FROM ohlcv_daily AS lastRow
        WHERE lastRow.ticker = stats.ticker AND lastRow.date = stats.lastSourceDate) AS rawClose,
       stats.observedCount,
       stats.matchedSessionCount
     FROM stats`
}

async function loadUsCompactBlocks(
  tickers: readonly string[],
  historyStartDate: string,
  asOfDate: string,
): Promise<CompactBlockRow[]> {
  if (tickers.length === 0) return []
  const placeholders = tickers.map(() => '?').join(',')
  return execAll<CompactBlockRow>(
    usCompactBlocksSql(placeholders),
    [...tickers, historyStartDate, asOfDate, historyStartDate, asOfDate],
  )
}

function usCompactBlocksSql(placeholders: string): string {
  return `WITH priced AS (
       SELECT
         ticker, date,
         ${US_ADJUSTED_OPEN_SQL} AS adjustedOpen,
         ${US_ADJUSTED_HIGH_SQL} AS adjustedHigh,
         ${US_ADJUSTED_LOW_SQL} AS adjustedLow,
         ${US_ADJUSTED_CLOSE_SQL} AS adjustedClose,
         ${US_ADJUSTED_VOLUME_SQL} AS adjustedVolume
       FROM market_ohlcv_daily
       WHERE market = 'US' AND ticker IN (${placeholders}) AND date >= ? AND date <= ?
     ), valid AS (
       SELECT
         ticker, date, adjustedOpen, adjustedClose,
         CAST(substr(date, 1, 4) AS INTEGER) - (CAST(substr(date, 1, 4) AS INTEGER) % 2) AS startYear
       FROM priced
       WHERE adjustedOpen > 0 AND adjustedHigh > 0 AND adjustedLow > 0 AND adjustedClose > 0 AND adjustedVolume >= 0
         AND adjustedHigh >= MAX(adjustedOpen, adjustedClose, adjustedLow)
         AND adjustedLow <= MIN(adjustedOpen, adjustedClose, adjustedHigh)
     ), market_sessions AS MATERIALIZED (
       SELECT date
       FROM market_ohlcv_daily
       WHERE market = 'US' AND ticker = 'SPY' AND date >= ? AND date <= ?
     ), stats AS (
       SELECT
         valid.ticker,
         valid.startYear,
         MIN(valid.date) AS firstSourceDate,
         MAX(valid.date) AS lastSourceDate,
         COUNT(*) AS observedCount,
         SUM(CASE WHEN valid.date IN (SELECT date FROM market_sessions) THEN 1 ELSE 0 END) AS matchedSessionCount
       FROM valid
       GROUP BY valid.ticker, valid.startYear
     )
     SELECT
       stats.ticker,
       stats.startYear,
       stats.firstSourceDate,
       stats.lastSourceDate,
       (SELECT ${qualifiedUsSql(US_ADJUSTED_OPEN_SQL, 'firstRow')}
        FROM market_ohlcv_daily AS firstRow
        WHERE firstRow.market = 'US' AND firstRow.ticker = stats.ticker
          AND firstRow.date = stats.firstSourceDate) AS rawOpen,
       (SELECT ${qualifiedUsSql(US_ADJUSTED_CLOSE_SQL, 'lastRow')}
        FROM market_ohlcv_daily AS lastRow
        WHERE lastRow.market = 'US' AND lastRow.ticker = stats.ticker
          AND lastRow.date = stats.lastSourceDate) AS rawClose,
       stats.observedCount,
       stats.matchedSessionCount
     FROM stats`
}

function qualifiedUsSql(expression: string, alias: string): string {
  return expression.replace(
    /\b(adj_open|adj_high|adj_low|adj_close|adj_volume|open|high|low|close|volume)\b/g,
    `${alias}.$1`,
  )
}

async function loadJpSplitEvents(
  tickers: readonly string[],
  historyStartDate: string,
  asOfDate: string,
): Promise<Map<string, SplitEvent[]>> {
  if (tickers.length === 0) return new Map()
  const placeholders = tickers.map(() => '?').join(',')
  const candidates = await execAll<SplitCandidateRow>(
    jpSplitEventsSql(placeholders),
    [...tickers, historyStartDate, asOfDate],
  )
  const grouped = new Map<string, SplitEvent[]>()
  for (const row of candidates) {
    const factor = inferLikelySplitAdjustment(
      { date: row.previousDate, close: numberValue(row.previousClose), volume: numberValue(row.previousVolume) },
      { date: row.currentDate, close: numberValue(row.currentClose), volume: numberValue(row.currentVolume) },
    )
    if (factor == null) continue
    const ticker = normalizeTicker(row.ticker)
    const bucket = grouped.get(ticker) ?? []
    bucket.push({ date: row.currentDate, factor })
    grouped.set(ticker, bucket)
  }
  return grouped
}

function jpSplitEventsSql(placeholders: string): string {
  return `WITH ordered AS (
       SELECT
         ticker,
         LAG(date) OVER (PARTITION BY ticker ORDER BY date) AS previousDate,
         date AS currentDate,
         LAG(close) OVER (PARTITION BY ticker ORDER BY date) AS previousClose,
         close AS currentClose,
         LAG(volume) OVER (PARTITION BY ticker ORDER BY date) AS previousVolume,
         volume AS currentVolume
       FROM ohlcv_daily
       WHERE ticker IN (${placeholders}) AND date >= ? AND date <= ?
     )
     SELECT ticker, previousDate, currentDate, previousClose, currentClose, previousVolume, currentVolume
     FROM ordered
     WHERE previousDate IS NOT NULL
       AND previousClose > 0 AND currentClose > 0
       AND previousVolume > 0 AND currentVolume > 0
       AND (currentClose / previousClose >= 2 OR currentClose / previousClose <= 0.5)
     ORDER BY ticker, currentDate`
}

function buildSearchEntry(options: Readonly<{
  market: TwoYearMarket
  ticker: string
  asOfDate: string
  sessions: readonly string[]
  blocks: readonly CompactBlockRow[]
  splitEvents: readonly SplitEvent[]
}>): TwoYearLineSearchEntry {
  const availability: TwoYearRegistryAvailability = options.blocks.length === 0
    ? 'history_unavailable'
    : options.sessions.length === 0
      ? 'calendar_unavailable'
      : 'available'
  const candles = compactBlocksToCandles(options)
  const lines = availability === 'available' ? detectRisingCloseLines(candles) : []
  const summaries = lines
    .map((line) => summarizeTwoYearLine(line, candles, options.asOfDate))
    .filter((summary): summary is TwoYearLineSummary => summary !== null)
  const confirmed = summaries.filter((summary) => summary.status === 'confirmed')
  const provisional = summaries.filter((summary) => summary.status === 'provisional')
  return {
    ticker: options.ticker,
    summaries,
    hasConfirmed: confirmed.length > 0,
    hasProvisional: provisional.length > 0,
    latest: summaries.at(-1) ?? null,
    latestConfirmed: confirmed.at(-1) ?? null,
    latestProvisional: provisional.at(-1) ?? null,
    availability,
  }
}

function compactBlocksToCandles(options: Readonly<{
  market: TwoYearMarket
  asOfDate: string
  sessions: readonly string[]
  blocks: readonly CompactBlockRow[]
  splitEvents: readonly SplitEvent[]
}>): TwoYearCandle[] {
  const asOfBlock = twoYearBlockStartYear(options.asOfDate)
  const sessionStats = new Map<number, { count: number; first: string }>()
  for (const date of options.sessions) {
    if (date > options.asOfDate) continue
    const startYear = twoYearBlockStartYear(date)
    const stats = sessionStats.get(startYear)
    if (stats) stats.count += 1
    else sessionStats.set(startYear, { count: 1, first: date })
  }
  return options.blocks
    .slice()
    .sort((left, right) => numberValue(left.startYear) - numberValue(right.startYear))
    .map((raw): TwoYearCandle => {
      const startYear = numberValue(raw.startYear)
      const period = twoYearPeriod(startYear)
      const expected = sessionStats.get(startYear)
      const observedCount = numberValue(raw.observedCount)
      const matchedSessionCount = numberValue(raw.matchedSessionCount)
      const coverageComplete = Boolean(expected && expected.first <= raw.firstSourceDate && matchedSessionCount === expected.count)
      const status = coverageComplete ? (startYear === asOfBlock ? 'forming' : 'confirmed') : 'incomplete'
      const open = numberValue(raw.rawOpen) * adjustmentAfter(raw.firstSourceDate, options.splitEvents)
      const close = numberValue(raw.rawClose) * adjustmentAfter(raw.lastSourceDate, options.splitEvents)
      return {
        date: period.midpointDate,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 0,
        adjustedClose: close,
        ...period,
        firstSourceDate: raw.firstSourceDate,
        lastSourceDate: raw.lastSourceDate,
        startYear,
        status,
        provisionalEligible: status === 'forming' && options.asOfDate >= period.midpointDate,
        missingSessionCount: expected ? Math.max(0, expected.count - matchedSessionCount) : 0,
        exchangeTimeZone: options.market === 'JP' ? 'Asia/Tokyo' : 'America/New_York',
      }
    })
}

function adjustmentAfter(date: string, events: readonly SplitEvent[]): number {
  return events.reduce((factor, event) => event.date > date ? factor * event.factor : factor, 1)
}

function groupBlocks(rows: readonly CompactBlockRow[]): Map<string, CompactBlockRow[]> {
  const grouped = new Map<string, CompactBlockRow[]>()
  for (const raw of rows) {
    const row: CompactBlockRow = {
      ...raw,
      ticker: normalizeTicker(raw.ticker),
      startYear: numberValue(raw.startYear),
      rawOpen: numberValue(raw.rawOpen),
      rawClose: numberValue(raw.rawClose),
      observedCount: numberValue(raw.observedCount),
      matchedSessionCount: numberValue(raw.matchedSessionCount),
    }
    const bucket = grouped.get(row.ticker) ?? []
    bucket.push(row)
    grouped.set(row.ticker, bucket)
  }
  return grouped
}

function numberValue(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function normalizeTicker(value: string): string {
  return value.trim().replace(/\.T$/i, '').toUpperCase()
}

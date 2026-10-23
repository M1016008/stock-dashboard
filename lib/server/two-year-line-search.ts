import { execAll } from '@/lib/db/client'
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
  __twoYearLineSearchCacheV3?: Map<string, SearchCacheEntry>
}
globalCache.__twoYearLineSearchCacheV3 ??= new Map()

const CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CACHE_KEYS = 4
const CHUNK_SIZE = 400

/**
 * Loads only two-year block boundaries/counts plus likely JP split events.
 * It intentionally avoids materializing every daily row for every screener
 * candidate in Node. Results are cached per market/as-of and filled by ticker.
 */
export async function loadTwoYearLineSearchEntries(options: Readonly<{
  market: TwoYearMarket
  tickers: readonly string[]
  asOfDate: string
}>): Promise<TwoYearLineSearchResult> {
  const tickers = [...new Set(options.tickers.map(normalizeTicker).filter(Boolean))].sort()
  const benchmark = options.market === 'JP' ? '1306' : 'SPY'
  const priceBasisVersion = options.market === 'JP' ? 'jp-split-normalized-v1' : US_ADJUSTED_PRICE_BASIS
  const cache = await getSearchCache(options.market, options.asOfDate, benchmark)
  const effectiveAsOfDate = cache.sessions.at(-1) ?? options.asOfDate
  const missing = tickers.filter((ticker) => !cache.entries.has(ticker))

  for (let offset = 0; offset < missing.length; offset += CHUNK_SIZE) {
    const chunk = missing.slice(offset, offset + CHUNK_SIZE)
    const blockRows = options.market === 'JP'
      ? await loadJpCompactBlocks(chunk, effectiveAsOfDate)
      : await loadUsCompactBlocks(chunk, effectiveAsOfDate)
    const splitEvents = options.market === 'JP'
      ? await loadJpSplitEvents(chunk, effectiveAsOfDate)
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

async function getSearchCache(
  market: TwoYearMarket,
  asOfDate: string,
  benchmark: '1306' | 'SPY',
): Promise<SearchCacheEntry> {
  const key = `${market}:${asOfDate}`
  const now = Date.now()
  for (const [cacheKey, value] of globalCache.__twoYearLineSearchCacheV3!) {
    if (value.expiresAt <= now) globalCache.__twoYearLineSearchCacheV3!.delete(cacheKey)
  }
  const cached = globalCache.__twoYearLineSearchCacheV3!.get(key)
  if (cached) return cached

  const sessions = market === 'JP'
    ? (await execAll<{ date: string }>(
        'SELECT date FROM ohlcv_daily WHERE ticker = ? AND date <= ? ORDER BY date',
        [benchmark, asOfDate],
      )).map((row) => row.date)
    : (await execAll<{ date: string }>(
        "SELECT date FROM market_ohlcv_daily WHERE market = 'US' AND ticker = ? AND date <= ? ORDER BY date",
        [benchmark, asOfDate],
      )).map((row) => row.date)
  const created: SearchCacheEntry = {
    expiresAt: now + CACHE_TTL_MS,
    sessions,
    entries: new Map(),
  }
  globalCache.__twoYearLineSearchCacheV3!.set(key, created)
  while (globalCache.__twoYearLineSearchCacheV3!.size > MAX_CACHE_KEYS) {
    const oldestKey = globalCache.__twoYearLineSearchCacheV3!.keys().next().value as string | undefined
    if (!oldestKey) break
    globalCache.__twoYearLineSearchCacheV3!.delete(oldestKey)
  }
  return created
}

async function loadJpCompactBlocks(tickers: readonly string[], asOfDate: string): Promise<CompactBlockRow[]> {
  if (tickers.length === 0) return []
  const placeholders = tickers.map(() => '?').join(',')
  return execAll<CompactBlockRow>(
    `WITH valid AS (
       SELECT
         ticker, date, open, close,
         CAST(strftime('%Y', date) AS INTEGER) - (CAST(strftime('%Y', date) AS INTEGER) % 2) AS startYear
       FROM ohlcv_daily
       WHERE ticker IN (${placeholders}) AND date <= ?
         AND open > 0 AND high > 0 AND low > 0 AND close > 0 AND volume >= 0
         AND high >= MAX(open, close, low) AND low <= MIN(open, close, high)
     ), ranked AS (
       SELECT *,
         ROW_NUMBER() OVER (PARTITION BY ticker, startYear ORDER BY date) AS firstRank,
         ROW_NUMBER() OVER (PARTITION BY ticker, startYear ORDER BY date DESC) AS lastRank,
         COUNT(*) OVER (PARTITION BY ticker, startYear) AS observedCount,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM ohlcv_daily AS marketSession
           WHERE marketSession.ticker = '1306' AND marketSession.date = valid.date
         ) THEN 1 ELSE 0 END) OVER (PARTITION BY ticker, startYear) AS matchedSessionCount
       FROM valid
     )
     SELECT
       ticker,
       startYear,
       MAX(CASE WHEN firstRank = 1 THEN date END) AS firstSourceDate,
       MAX(CASE WHEN lastRank = 1 THEN date END) AS lastSourceDate,
       MAX(CASE WHEN firstRank = 1 THEN open END) AS rawOpen,
       MAX(CASE WHEN lastRank = 1 THEN close END) AS rawClose,
       MAX(observedCount) AS observedCount,
       MAX(matchedSessionCount) AS matchedSessionCount
     FROM ranked
     GROUP BY ticker, startYear
     ORDER BY ticker, startYear`,
    [...tickers, asOfDate],
  )
}

async function loadUsCompactBlocks(tickers: readonly string[], asOfDate: string): Promise<CompactBlockRow[]> {
  if (tickers.length === 0) return []
  const placeholders = tickers.map(() => '?').join(',')
  return execAll<CompactBlockRow>(
    `WITH priced AS (
       SELECT
         ticker, date,
         ${US_ADJUSTED_OPEN_SQL} AS adjustedOpen,
         ${US_ADJUSTED_HIGH_SQL} AS adjustedHigh,
         ${US_ADJUSTED_LOW_SQL} AS adjustedLow,
         ${US_ADJUSTED_CLOSE_SQL} AS adjustedClose,
         ${US_ADJUSTED_VOLUME_SQL} AS adjustedVolume
       FROM market_ohlcv_daily
       WHERE market = 'US' AND ticker IN (${placeholders}) AND date <= ?
     ), valid AS (
       SELECT
         ticker, date, adjustedOpen, adjustedClose,
         CAST(strftime('%Y', date) AS INTEGER) - (CAST(strftime('%Y', date) AS INTEGER) % 2) AS startYear
       FROM priced
       WHERE adjustedOpen > 0 AND adjustedHigh > 0 AND adjustedLow > 0 AND adjustedClose > 0 AND adjustedVolume >= 0
         AND adjustedHigh >= MAX(adjustedOpen, adjustedClose, adjustedLow)
         AND adjustedLow <= MIN(adjustedOpen, adjustedClose, adjustedHigh)
     ), ranked AS (
       SELECT *,
         ROW_NUMBER() OVER (PARTITION BY ticker, startYear ORDER BY date) AS firstRank,
         ROW_NUMBER() OVER (PARTITION BY ticker, startYear ORDER BY date DESC) AS lastRank,
         COUNT(*) OVER (PARTITION BY ticker, startYear) AS observedCount,
         SUM(CASE WHEN EXISTS (
           SELECT 1 FROM market_ohlcv_daily AS marketSession
           WHERE marketSession.market = 'US' AND marketSession.ticker = 'SPY'
             AND marketSession.date = valid.date
         ) THEN 1 ELSE 0 END) OVER (PARTITION BY ticker, startYear) AS matchedSessionCount
       FROM valid
     )
     SELECT
       ticker,
       startYear,
       MAX(CASE WHEN firstRank = 1 THEN date END) AS firstSourceDate,
       MAX(CASE WHEN lastRank = 1 THEN date END) AS lastSourceDate,
       MAX(CASE WHEN firstRank = 1 THEN adjustedOpen END) AS rawOpen,
       MAX(CASE WHEN lastRank = 1 THEN adjustedClose END) AS rawClose,
       MAX(observedCount) AS observedCount,
       MAX(matchedSessionCount) AS matchedSessionCount
     FROM ranked
     GROUP BY ticker, startYear
     ORDER BY ticker, startYear`,
    [...tickers, asOfDate],
  )
}

async function loadJpSplitEvents(tickers: readonly string[], asOfDate: string): Promise<Map<string, SplitEvent[]>> {
  if (tickers.length === 0) return new Map()
  const placeholders = tickers.map(() => '?').join(',')
  const candidates = await execAll<SplitCandidateRow>(
    `WITH ordered AS (
       SELECT
         ticker,
         LAG(date) OVER (PARTITION BY ticker ORDER BY date) AS previousDate,
         date AS currentDate,
         LAG(close) OVER (PARTITION BY ticker ORDER BY date) AS previousClose,
         close AS currentClose,
         LAG(volume) OVER (PARTITION BY ticker ORDER BY date) AS previousVolume,
         volume AS currentVolume
       FROM ohlcv_daily
       WHERE ticker IN (${placeholders}) AND date <= ?
     )
     SELECT ticker, previousDate, currentDate, previousClose, currentClose, previousVolume, currentVolume
     FROM ordered
     WHERE previousDate IS NOT NULL
       AND previousClose > 0 AND currentClose > 0
       AND previousVolume > 0 AND currentVolume > 0
       AND (currentClose / previousClose >= 2 OR currentClose / previousClose <= 0.5)
     ORDER BY ticker, currentDate`,
    [...tickers, asOfDate],
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

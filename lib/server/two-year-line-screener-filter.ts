import type { TwoYearMarket } from '@/lib/two-year-candles'
import { parseTwoYearLineFilter, parseTwoYearLinePatternFilter, twoYearConfirmedDistancePriority, type TwoYearLineQuery } from '@/lib/two-year-line-registry'
import { loadTwoYearLineSearchEntries, matchesTwoYearLineSearchEntry, selectTwoYearLineSummary, type TwoYearLineSearchMetadata } from '@/lib/server/two-year-line-search'

type NumberParam = (searchParams: URLSearchParams, key: string) => number | null

function invalidAngleParam(searchParams: URLSearchParams, key: string): boolean {
  const raw = searchParams.get(key)?.trim()
  if (!raw) return false
  const value = Number(raw)
  return !Number.isFinite(value) || value < 0 || value > 90
}

/** `numberParam` stays market-specific: JP and US read blank angle values differently. */
export function parseTwoYearLineScreenerQuery(
  searchParams: URLSearchParams,
  numberParam: NumberParam,
): { query: TwoYearLineQuery } | { error: string } {
  const status = parseTwoYearLineFilter(searchParams.get('twoYearLine'))
  const pattern = parseTwoYearLinePatternFilter(searchParams.get('twoYearPattern'))
  if (invalidAngleParam(searchParams, 'twoYearAngleMin') || invalidAngleParam(searchParams, 'twoYearAngleMax')) {
    return { error: 'Invalid 24-month line angle' }
  }
  const angle = (key: string) => {
    const value = numberParam(searchParams, key)
    return value !== null && value >= 0 && value <= 90 ? value : null
  }
  const minAngleDeg = angle('twoYearAngleMin')
  const maxAngleDeg = angle('twoYearAngleMax')
  if (minAngleDeg !== null && maxAngleDeg !== null && minAngleDeg > maxAngleDeg) {
    return { error: 'Invalid 24-month line angle range' }
  }
  return {
    query: {
      status,
      pattern: status === 'none' ? 'either' : pattern,
      minAngleDeg: status === 'none' ? null : minAngleDeg,
      maxAngleDeg: status === 'none' ? null : maxAngleDeg,
    },
  }
}

/** Annotates and filters rows by the 24-month line query; loads nothing when the query is `none`. */
export async function applyTwoYearLineScreenerFilter<T>(
  rows: T[],
  query: TwoYearLineQuery,
  options: Readonly<{
    market: TwoYearMarket
    asOfDate: string
    ticker: (row: T) => string
    entryKey: (ticker: string) => string
  }>,
): Promise<{ rows: T[]; metadata: TwoYearLineSearchMetadata | null }> {
  if (query.status === 'none') return { rows, metadata: null }
  const { entries, metadata } = await loadTwoYearLineSearchEntries({
    market: options.market,
    tickers: rows.map(options.ticker),
    asOfDate: options.asOfDate,
  })
  const result: T[] = []
  for (const row of rows) {
    const ticker = options.ticker(row)
    const entry = entries.get(options.entryKey(ticker))
    if (!matchesTwoYearLineSearchEntry(entry, query)) continue
    const summary = selectTwoYearLineSummary(entry, query)
    const confirmedDistance = entry?.latestConfirmed?.distancePct ?? null
    result.push({
      ...row,
      ticker,
      twoYearLineStatus: summary?.status ?? null,
      twoYearLinePattern: summary?.pattern ?? null,
      twoYearLinePeriods: summary?.sourcePeriods ?? null,
      twoYearLineStartClose: summary?.lineStartClose ?? null,
      twoYearLineEndClose: summary?.lineEndClose ?? null,
      twoYearLineAngleDeg: summary?.angleDeg ?? null,
      twoYearLineLastCandleRisePct: summary?.lastCandleRisePct ?? null,
      twoYearLineConfirmedDistancePct: confirmedDistance,
      twoYearLineConfirmedDistancePriority: twoYearConfirmedDistancePriority(confirmedDistance),
      twoYearLineAsOfDate: metadata.asOfDate,
      twoYearLinePriceBasisVersion: metadata.priceBasisVersion,
    })
  }
  return { rows: result, metadata }
}

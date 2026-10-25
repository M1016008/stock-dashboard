import {
  MA_SEQUENCE_PERIODS,
  findMaSequenceIndex,
  prepareMaSequence,
  stageCodeAt,
  type MaSequencePrepared,
  type MaSequencePriceRow,
} from '@/lib/ml/ma-sequence'

const DAY_MS = 86_400_000
const PRESENTATION_CONTEXT_BEFORE = 35
const PRESENTATION_CONTEXT_AFTER = 18

type DbArgs = readonly (string | number | null)[]

export type HistoricalAnalogPriceRow = MaSequencePriceRow & {
  ticker: string
}

export type HistoricalAnalogPresentationCandidate = {
  ticker: string
  startDate: string
  endDate: string
}

export type HistoricalAnalogPresentationDb = {
  all: <T>(sql: string, args?: DbArgs) => Promise<T[]>
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

export function subtractCalendarDays(date: string, days: number): string {
  return addCalendarDays(date, -days)
}

export function normalizePriceRows(rows: HistoricalAnalogPriceRow[]): HistoricalAnalogPriceRow[] {
  const normalized: HistoricalAnalogPriceRow[] = []
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

function splitContinuous(rows: HistoricalAnalogPriceRow[], maxGapDays = 60): HistoricalAnalogPriceRow[][] {
  if (rows.length === 0) return []
  const output: HistoricalAnalogPriceRow[][] = []
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

export function buildPreparedSegments(rows: HistoricalAnalogPriceRow[]): MaSequencePrepared[] {
  return splitContinuous(rows)
    .map((segment) => prepareMaSequence(segment))
    .filter((prepared) => prepared.rows.length > 240)
}

export function findPreparedSegment(
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

export function findPreparedSegmentAtOrBefore(
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

export function firstIndexAtOrAfter(prepared: MaSequencePrepared, date: string): number {
  let low = 0
  let high = prepared.rows.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (prepared.rows[middle].date < date) low = middle + 1
    else high = middle
  }
  return low < prepared.rows.length ? low : -1
}

export function compactStagePath(
  prepared: MaSequencePrepared,
  startIndex: number,
  endIndex: number,
) {
  const path: Array<{ relativeDay: number; date: string; stageCode: string }> = []
  let previous: string | null = null
  for (let index = startIndex; index <= endIndex; index += 1) {
    const code = stageCodeAt(prepared, index)
    if (!code || code === previous) continue
    path.push({ relativeDay: index - startIndex, date: prepared.rows[index].date, stageCode: code })
    previous = code
  }
  return path
}

export function buildRangeWindow(
  prepared: MaSequencePrepared,
  startIndex: number,
  endIndex: number,
) {
  const rows: Array<Record<string, number | string | null>> = []
  const fromIndex = Math.max(0, startIndex - PRESENTATION_CONTEXT_BEFORE)
  const toIndex = Math.min(prepared.rows.length - 1, endIndex + PRESENTATION_CONTEXT_AFTER)
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

export async function loadPresentations(
  db: HistoricalAnalogPresentationDb,
  rows: HistoricalAnalogPresentationCandidate[],
) {
  const output = new Map<string, {
    window: ReturnType<typeof buildRangeWindow>
    stagePath: ReturnType<typeof compactStagePath>
    volume: number | null
    avgVolume30: number | null
    volumeRatio30: number | null
    volumeObservationCount: number
  }>()
  const byTicker = new Map<string, HistoricalAnalogPresentationCandidate[]>()
  for (const row of rows) {
    const tickerRows = byTicker.get(row.ticker) ?? []
    tickerRows.push(row)
    byTicker.set(row.ticker, tickerRows)
  }
  const ranges = [...byTicker.entries()].map(([ticker, tickerRows]) => ({
    ticker,
    fromDate: subtractCalendarDays(tickerRows.map((row) => row.startDate).sort()[0], 520),
    toDate: addCalendarDays(tickerRows.map((row) => row.endDate).sort().at(-1)!, 45),
  }))
  if (ranges.length === 0) return output
  const prices = normalizePriceRows(await db.all<HistoricalAnalogPriceRow>(
    `
      SELECT ticker, date, open, high, low, close, volume
      FROM ohlcv_daily
      WHERE ${ranges.map(() => '(ticker = ? AND date >= ? AND date <= ?)').join(' OR ')}
      ORDER BY ticker, date
    `,
    ranges.flatMap((range) => [range.ticker, range.fromDate, range.toDate]),
  ))
  const pricesByTicker = new Map<string, HistoricalAnalogPriceRow[]>()
  for (const price of prices) {
    const tickerPrices = pricesByTicker.get(price.ticker) ?? []
    tickerPrices.push(price)
    pricesByTicker.set(price.ticker, tickerPrices)
  }
  for (const [ticker, tickerRows] of byTicker) {
    const segments = buildPreparedSegments(pricesByTicker.get(ticker) ?? [])
    for (const row of tickerRows) {
      const located = findPreparedSegment(segments, row.endDate)
      if (!located) continue
      const startIndex = findMaSequenceIndex(located.prepared, row.startDate)
      if (startIndex < 0 || located.prepared.rows[startIndex]?.date !== row.startDate) continue
      const key = `${row.ticker}\u0000${row.startDate}\u0000${row.endDate}`
      output.set(key, {
        window: buildRangeWindow(located.prepared, startIndex, located.index),
        stagePath: compactStagePath(located.prepared, startIndex, located.index),
        ...buildVolumeSnapshot(located.prepared, located.index),
      })
    }
  }
  return output
}

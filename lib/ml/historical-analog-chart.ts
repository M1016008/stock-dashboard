import type { OHLCV } from '@/types/stock'
import { smaSeries } from '@/lib/timeframes'

export type HistoricalAnalogChartInterval = 'D' | 'W' | 'M' | 'Y'

export type HistoricalAnalogChartPoint = OHLCV & {
  relativeDay: number
  ma3: number | null
  ma5: number | null
  ma9: number | null
  ma10: number | null
  ma13: number | null
  ma20: number | null
  ma24: number | null
  ma25: number | null
  ma26: number | null
  ma40: number | null
  ma52: number | null
  ma60: number | null
  ma75: number | null
  ma90: number | null
  ma200: number | null
}

export type HistoricalAnalogChartSeries = {
  points: HistoricalAnalogChartPoint[]
  highlightStart: string
  highlightEnd: string
  startPrice: number | null
  endPrice: number | null
  returnPct: number | null
}

type AggregateRow = OHLCV & {
  sourceStartDate: string
  sourceEndDate: string
}

const MA_PERIODS = [
  3,
  5,
  9,
  10,
  13,
  20,
  24,
  25,
  26,
  40,
  52,
  60,
  75,
  90,
  200,
] as const

const CONTEXT_BARS: Record<
  HistoricalAnalogChartInterval,
  { before: number; after: number }
> = {
  D: { before: 35, after: 18 },
  W: { before: 26, after: 12 },
  M: { before: 24, after: 12 },
  Y: { before: 8, after: 4 },
}

function dateParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day }
}

function weekKey(date: string): string {
  const { year, month, day } = dateParts(date)
  const value = new Date(Date.UTC(year, month - 1, day))
  const weekday = value.getUTCDay() || 7
  value.setUTCDate(value.getUTCDate() - weekday + 1)
  return value.toISOString().slice(0, 10)
}

function bucketKey(date: string, interval: HistoricalAnalogChartInterval): string {
  if (interval === 'D') return date
  if (interval === 'W') return weekKey(date)
  if (interval === 'M') return date.slice(0, 7)
  return date.slice(0, 4)
}

function normalizeRows(rows: OHLCV[]): OHLCV[] {
  return rows
    .filter((row) =>
      /^\d{4}-\d{2}-\d{2}$/.test(row.date)
      && [row.open, row.high, row.low, row.close].every(Number.isFinite)
    )
    .map((row) => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number.isFinite(row.volume) ? Number(row.volume) : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

function aggregateRows(
  rows: OHLCV[],
  interval: HistoricalAnalogChartInterval,
): AggregateRow[] {
  const grouped: AggregateRow[] = []
  let currentKey = ''

  for (const row of rows) {
    const key = bucketKey(row.date, interval)
    const current = grouped.at(-1)
    if (!current || key !== currentKey) {
      currentKey = key
      grouped.push({
        ...row,
        sourceStartDate: row.date,
        sourceEndDate: row.date,
      })
      continue
    }
    current.high = Math.max(current.high, row.high)
    current.low = Math.min(current.low, row.low)
    current.close = row.close
    current.volume += row.volume
    current.sourceEndDate = row.date
  }

  return grouped
}

function rangeIndexes(
  rows: AggregateRow[],
  startDate: string,
  endDate: string,
): { startIndex: number; endIndex: number } | null {
  if (rows.length === 0) return null
  const overlapping = rows
    .map((row, index) =>
      row.sourceEndDate >= startDate && row.sourceStartDate <= endDate ? index : -1
    )
    .filter((index) => index >= 0)
  if (overlapping.length > 0) {
    return {
      startIndex: overlapping[0],
      endIndex: overlapping[overlapping.length - 1],
    }
  }

  const nearest = rows.findIndex((row) => row.sourceStartDate >= startDate)
  const index = nearest >= 0 ? nearest : rows.length - 1
  return { startIndex: index, endIndex: index }
}

function priceAtStart(rows: OHLCV[], startDate: string, endDate: string): number | null {
  return rows.find((row) => row.date >= startDate && row.date <= endDate)?.close ?? null
}

function priceAtEnd(rows: OHLCV[], startDate: string, endDate: string): number | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row.date >= startDate && row.date <= endDate) return row.close
  }
  return null
}

export function buildHistoricalAnalogChartSeries(
  rows: OHLCV[],
  interval: HistoricalAnalogChartInterval,
  startDate: string,
  endDate: string,
): HistoricalAnalogChartSeries | null {
  const normalized = normalizeRows(rows)
  const grouped = aggregateRows(normalized, interval)
  const indexes = rangeIndexes(grouped, startDate, endDate)
  if (!indexes) return null

  const maValues = new Map<number, Array<number | null>>()
  for (const period of MA_PERIODS) {
    maValues.set(period, smaSeries(grouped, period))
  }

  const context = CONTEXT_BARS[interval]
  const fromIndex = Math.max(0, indexes.startIndex - context.before)
  const toIndex = Math.min(grouped.length - 1, indexes.endIndex + context.after)
  const points = grouped.slice(fromIndex, toIndex + 1).map((row, offset) => {
    const index = fromIndex + offset
    return {
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      relativeDay: index - indexes.startIndex,
      ma3: maValues.get(3)?.[index] ?? null,
      ma5: maValues.get(5)?.[index] ?? null,
      ma9: maValues.get(9)?.[index] ?? null,
      ma10: maValues.get(10)?.[index] ?? null,
      ma13: maValues.get(13)?.[index] ?? null,
      ma20: maValues.get(20)?.[index] ?? null,
      ma24: maValues.get(24)?.[index] ?? null,
      ma25: maValues.get(25)?.[index] ?? null,
      ma26: maValues.get(26)?.[index] ?? null,
      ma40: maValues.get(40)?.[index] ?? null,
      ma52: maValues.get(52)?.[index] ?? null,
      ma60: maValues.get(60)?.[index] ?? null,
      ma75: maValues.get(75)?.[index] ?? null,
      ma90: maValues.get(90)?.[index] ?? null,
      ma200: maValues.get(200)?.[index] ?? null,
    }
  })

  const startPrice = priceAtStart(normalized, startDate, endDate)
  const endPrice = priceAtEnd(normalized, startDate, endDate)
  const returnPct = startPrice != null && endPrice != null && startPrice !== 0
    ? ((endPrice / startPrice) - 1) * 100
    : null

  return {
    points,
    highlightStart: grouped[indexes.startIndex].date,
    highlightEnd: grouped[indexes.endIndex].date,
    startPrice,
    endPrice,
    returnPct,
  }
}

import type { OHLCV } from '@/types/stock'

export type TimeframeUnit = 'day' | 'week' | 'month' | 'year'
export type ChartIntervalCode =
  | 'D' | '2D' | '3D'
  | 'W' | '2W' | '3W'
  | 'M' | '2M' | '3M' | '6M'
  | 'Y' | '2Y' | '3Y' | '5Y'

export interface TimeframeSpec {
  timeframe: TimeframeUnit
  multiplier: number
}

export const CHART_INTERVAL_OPTIONS: Array<{
  code: ChartIntervalCode
  label: string
  spec: TimeframeSpec
  defaultPeriod: string
  initialVisiblePeriod: string
  defaultMaLines: number[]
}> = [
  { code: 'D', label: '日足', spec: { timeframe: 'day', multiplier: 1 }, defaultPeriod: '1y', initialVisiblePeriod: '1y', defaultMaLines: [5, 25, 75, 200] },
  { code: '2D', label: '2日足', spec: { timeframe: 'day', multiplier: 2 }, defaultPeriod: '2y', initialVisiblePeriod: '1y', defaultMaLines: [5, 25, 75, 200] },
  { code: '3D', label: '3日足', spec: { timeframe: 'day', multiplier: 3 }, defaultPeriod: '5y', initialVisiblePeriod: '2y', defaultMaLines: [5, 25, 75, 200] },
  { code: 'W', label: '週足', spec: { timeframe: 'week', multiplier: 1 }, defaultPeriod: '5y', initialVisiblePeriod: '5y', defaultMaLines: [13, 26, 52] },
  { code: '2W', label: '2週足', spec: { timeframe: 'week', multiplier: 2 }, defaultPeriod: '10y', initialVisiblePeriod: '5y', defaultMaLines: [13, 26, 52] },
  { code: '3W', label: '3週足', spec: { timeframe: 'week', multiplier: 3 }, defaultPeriod: 'all', initialVisiblePeriod: '10y', defaultMaLines: [13, 26, 52] },
  { code: 'M', label: '月足', spec: { timeframe: 'month', multiplier: 1 }, defaultPeriod: '10y', initialVisiblePeriod: '10y', defaultMaLines: [9, 24, 60] },
  { code: '2M', label: '2ヶ月足', spec: { timeframe: 'month', multiplier: 2 }, defaultPeriod: '10y', initialVisiblePeriod: '10y', defaultMaLines: [9, 24, 60] },
  { code: '3M', label: '3ヶ月足', spec: { timeframe: 'month', multiplier: 3 }, defaultPeriod: 'all', initialVisiblePeriod: '10y', defaultMaLines: [9, 24, 60] },
  { code: '6M', label: '6ヶ月足', spec: { timeframe: 'month', multiplier: 6 }, defaultPeriod: 'all', initialVisiblePeriod: 'all', defaultMaLines: [9, 24, 60] },
  { code: 'Y', label: '年足', spec: { timeframe: 'year', multiplier: 1 }, defaultPeriod: 'all', initialVisiblePeriod: 'all', defaultMaLines: [3, 5, 10] },
  { code: '2Y', label: '2年足', spec: { timeframe: 'year', multiplier: 2 }, defaultPeriod: 'all', initialVisiblePeriod: 'all', defaultMaLines: [3, 5, 10] },
  { code: '3Y', label: '3年足', spec: { timeframe: 'year', multiplier: 3 }, defaultPeriod: 'all', initialVisiblePeriod: 'all', defaultMaLines: [3, 5, 10] },
  { code: '5Y', label: '5年足', spec: { timeframe: 'year', multiplier: 5 }, defaultPeriod: 'all', initialVisiblePeriod: 'all', defaultMaLines: [3, 5, 10] },
]

const OPTION_BY_CODE = new Map(CHART_INTERVAL_OPTIONS.map((option) => [option.code, option]))

export function intervalToSpec(interval: ChartIntervalCode): TimeframeSpec {
  return OPTION_BY_CODE.get(interval)?.spec ?? { timeframe: 'day', multiplier: 1 }
}

export function intervalLabel(interval: ChartIntervalCode): string {
  return OPTION_BY_CODE.get(interval)?.label ?? interval
}

export function defaultPeriodForInterval(interval: ChartIntervalCode): string {
  return OPTION_BY_CODE.get(interval)?.defaultPeriod ?? '1y'
}

export function initialVisiblePeriodForInterval(interval: ChartIntervalCode): string {
  return OPTION_BY_CODE.get(interval)?.initialVisiblePeriod ?? '1y'
}

export function defaultMaLinesForInterval(interval: ChartIntervalCode): number[] {
  return OPTION_BY_CODE.get(interval)?.defaultMaLines ?? [5, 25, 75, 200]
}

export function parseInterval(value: string | null | undefined): ChartIntervalCode | null {
  if (!value) return null
  const normalized = value.trim().toUpperCase()
  return OPTION_BY_CODE.has(normalized as ChartIntervalCode) ? normalized as ChartIntervalCode : null
}

export function parseTimeframeSpec(args: {
  interval?: string | null
  timeframe?: string | null
  multiplier?: string | null
}): TimeframeSpec | null {
  const interval = parseInterval(args.interval)
  if (interval) return intervalToSpec(interval)

  const timeframe = args.timeframe?.trim().toLowerCase()
  if (timeframe !== 'day' && timeframe !== 'week' && timeframe !== 'month' && timeframe !== 'year') return null

  const multiplier = Number(args.multiplier ?? '1')
  if (!Number.isInteger(multiplier) || multiplier < 1 || multiplier > 12) return null
  return { timeframe, multiplier }
}

export function specToIntervalCode(spec: TimeframeSpec): ChartIntervalCode | null {
  for (const option of CHART_INTERVAL_OPTIONS) {
    if (option.spec.timeframe === spec.timeframe && option.spec.multiplier === spec.multiplier) {
      return option.code
    }
  }
  return null
}

export function resampleOhlcv(rows: OHLCV[], spec: TimeframeSpec): OHLCV[] {
  const multiplier = Math.max(1, Math.floor(spec.multiplier))
  const sorted = rows
    .filter((row) => row.date && Number.isFinite(row.open) && Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))

  if (sorted.length === 0 || (spec.timeframe === 'day' && multiplier === 1)) {
    return sorted.map((row) => ({ ...row }))
  }

  if (spec.timeframe === 'day') {
    return aggregateConsecutive(sorted, multiplier)
  }

  const grouped: OHLCV[] = []
  let currentKey: number | null = null
  let current: OHLCV | null = null
  for (const row of sorted) {
    const rawKey = spec.timeframe === 'week'
      ? calendarWeekBucket(row.date)
      : spec.timeframe === 'month'
        ? calendarMonthBucket(row.date)
        : yearBucket(row.date)
    // Fixed epoch buckets keep 2x/3x candles identical regardless of the requested history window.
    const key = Math.floor(rawKey / multiplier)

    if (key !== currentKey) {
      if (current) grouped.push(current)
      currentKey = key
      current = { ...row }
      continue
    }

    current = mergeCandle(current, row)
  }

  if (current) grouped.push(current)
  return grouped
}

export function smaAt(rows: OHLCV[], period: number, index = rows.length - 1): number | null {
  if (!Number.isInteger(period) || period <= 0 || index < period - 1 || index >= rows.length) return null
  let sum = 0
  for (let i = index - period + 1; i <= index; i += 1) {
    const close = rows[i]?.close
    if (!Number.isFinite(close)) return null
    sum += close
  }
  return sum / period
}

export function smaSeries(rows: OHLCV[], period: number): Array<number | null> {
  const out: Array<number | null> = []
  let sum = 0
  for (let i = 0; i < rows.length; i += 1) {
    sum += rows[i].close
    if (i >= period) sum -= rows[i - period].close
    out.push(i >= period - 1 ? sum / period : null)
  }
  return out
}

export function stageFromThreeMa(ma1: number | null, ma2: number | null, ma3: number | null): number | null {
  if (ma1 == null || ma2 == null || ma3 == null) return null
  if (ma1 > ma2 && ma2 > ma3) return 1
  if (ma2 > ma1 && ma1 > ma3) return 2
  if (ma2 > ma3 && ma3 > ma1) return 3
  if (ma3 > ma2 && ma2 > ma1) return 4
  if (ma3 > ma1 && ma1 > ma2) return 5
  if (ma1 > ma3 && ma3 > ma2) return 6
  return null
}

export function angleDeg(current: number | null | undefined, previous: number | null | undefined, bars: number): number | null {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous === 0 || bars <= 0) return null
  const slope = (((current - previous) / previous) * 100) / bars
  return Math.atan(slope) * (180 / Math.PI)
}

function aggregateConsecutive(rows: OHLCV[], size: number): OHLCV[] {
  const grouped: OHLCV[] = []
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size)
    if (slice.length === 0) continue
    grouped.push(slice.reduce((current, row, index) => index === 0 ? { ...row } : mergeCandle(current, row), slice[0]))
  }
  return grouped
}

function mergeCandle(current: OHLCV | null, row: OHLCV): OHLCV {
  if (!current) return { ...row }
  return {
    date: row.date,
    open: current.open,
    high: Math.max(current.high, row.high),
    low: Math.min(current.low, row.low),
    close: row.close,
    volume: current.volume + row.volume,
    adjustedClose: row.adjustedClose ?? current.adjustedClose ?? null,
  }
}

export function calendarWeekBucket(isoDate: string): number {
  const monday = mondayUtc(isoDate)
  const epochMonday = Date.UTC(1970, 0, 5)
  return Math.floor((monday.getTime() - epochMonday) / (7 * 86_400_000))
}

export function calendarMonthBucket(isoDate: string): number {
  const year = Number(isoDate.slice(0, 4))
  const month = Number(isoDate.slice(5, 7))
  return (year - 1970) * 12 + (month - 1)
}

function yearBucket(isoDate: string): number {
  return Number(isoDate.slice(0, 4)) - 1970
}

function mondayUtc(isoDate: string): Date {
  const date = new Date(`${isoDate}T00:00:00Z`)
  const day = date.getUTCDay()
  const daysFromMonday = day === 0 ? 6 : day - 1
  date.setUTCDate(date.getUTCDate() - daysFromMonday)
  date.setUTCHours(0, 0, 0, 0)
  return date
}

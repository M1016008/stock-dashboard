import { calculateAllStages, type MaValues, type StageResult } from '@/lib/hex-stage'
import { adjustLikelySplitOhlcv } from '@/lib/physical-momentum'
import { calendarMonthBucket, calendarWeekBucket } from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'

export const MIN_SNAPSHOT_DATA_POINTS = 5
export const MAX_CONTINUOUS_HISTORY_GAP_DAYS = 60

export const REQUIRED_ACTIVE_PERIODS = {
  daily_a_stage: 75,
  daily_b_stage: 300,
  weekly_a_stage: 25,
  weekly_b_stage: 100,
  monthly_a_stage: 10,
  monthly_b_stage: 25,
} as const

export type SnapshotCalculation = MaValues & StageResult & {
  date: string
  activeDays: number
  segmentStartDate: string
}

export function daysBetween(fromDate: string, toDate: string): number {
  const from = Date.parse(`${fromDate}T00:00:00Z`)
  const to = Date.parse(`${toDate}T00:00:00Z`)
  return (to - from) / 86_400_000
}

export function getActiveSegmentStart(
  rows: { date: string }[],
  maxGapDays = MAX_CONTINUOUS_HISTORY_GAP_DAYS,
): string | null {
  if (rows.length === 0) return null

  let startDate = rows[0].date
  for (let i = 1; i < rows.length; i++) {
    if (daysBetween(rows[i - 1].date, rows[i].date) > maxGapDays) {
      startDate = rows[i].date
    }
  }

  return startDate
}

export function splitContinuousHistory<T extends { date: string }>(
  rows: T[],
  maxGapDays = MAX_CONTINUOUS_HISTORY_GAP_DAYS,
): T[][] {
  if (rows.length === 0) return []

  const segments: T[][] = []
  let current: T[] = [rows[0]]

  for (let i = 1; i < rows.length; i++) {
    if (daysBetween(rows[i - 1].date, rows[i].date) > maxGapDays) {
      segments.push(current)
      current = []
    }
    current.push(rows[i])
  }

  segments.push(current)
  return segments
}

export function stageWithEnoughHistory(
  value: number | null,
  activePeriods: number | null,
  requiredPeriods: number,
): number | null {
  if (activePeriods == null) return value
  return activePeriods >= requiredPeriods ? value : null
}

function buildClosePrefix(rows: OHLCV[]): number[] {
  const prefix = [0]
  for (const row of rows) {
    prefix.push(prefix[prefix.length - 1] + row.close)
  }
  return prefix
}

function dailySmaAt(prefix: number[], index: number, period: number): number | null {
  const end = index + 1
  if (end < period) return null
  return (prefix[end] - prefix[end - period]) / period
}

class CalendarCloseAccumulator {
  private currentBucket: number | null = null
  private currentClose: number | null = null
  private readonly completedPrefix = [0]

  constructor(private readonly bucketForDate: (date: string) => number) {}

  update(row: OHLCV): void {
    const bucket = this.bucketForDate(row.date)
    if (this.currentBucket !== null && bucket !== this.currentBucket) {
      this.completedPrefix.push(
        this.completedPrefix[this.completedPrefix.length - 1] + (this.currentClose ?? 0),
      )
    }
    this.currentBucket = bucket
    this.currentClose = row.close
  }

  sma(period: number): number | null {
    if (this.currentClose === null) return null
    const completedCount = this.completedPrefix.length - 1
    const totalPeriods = completedCount + 1
    if (totalPeriods < period) return null
    const completedNeeded = period - 1
    const completedSum = this.completedPrefix[completedCount]
      - this.completedPrefix[completedCount - completedNeeded]
    return (completedSum + this.currentClose) / period
  }
}

export type ContinuousMonthlyMaPoint = OHLCV & {
  values: Map<number, number | null>
  activeDays: number
  segmentStartDate: string
}

/**
 * 暦月終値SMAを任意期間の配列から日次で算出する共通経路。
 * daily_snapshots と同じ分割調整・連続履歴・当月終値の扱いを使う。
 */
export function buildContinuousMonthlyMaSeries(
  rows: OHLCV[],
  periods: readonly number[],
): ContinuousMonthlyMaPoint[] {
  const results: ContinuousMonthlyMaPoint[] = []
  const normalizedPeriods = [...new Set(periods)]
    .filter((period) => Number.isInteger(period) && period > 0)
    .sort((left, right) => left - right)
  if (normalizedPeriods.length === 0) return results

  for (const segment of splitContinuousHistory(adjustLikelySplitOhlcv(rows))) {
    const monthly = new CalendarCloseAccumulator(calendarMonthBucket)
    const segmentStartDate = segment[0]?.date
    for (let index = 0; index < segment.length; index += 1) {
      const row = segment[index]
      monthly.update(row)
      results.push({
        ...row,
        values: new Map(normalizedPeriods.map((period) => [period, monthly.sma(period)])),
        activeDays: index + 1,
        segmentStartDate,
      })
    }
  }

  return results
}

export function buildMaValuesAtIndex(rows: OHLCV[], prefix: number[], index: number): MaValues {
  const weekly = new CalendarCloseAccumulator(calendarWeekBucket)
  const monthly = new CalendarCloseAccumulator(calendarMonthBucket)
  for (let i = 0; i <= index; i++) {
    weekly.update(rows[i])
    monthly.update(rows[i])
  }

  return {
    ma_5: dailySmaAt(prefix, index, 5),
    ma_25: dailySmaAt(prefix, index, 25),
    ma_75: dailySmaAt(prefix, index, 75),
    ma_150: dailySmaAt(prefix, index, 150),
    ma_300: dailySmaAt(prefix, index, 300),
    weekly_ma_5: weekly.sma(5),
    weekly_ma_13: weekly.sma(13),
    weekly_ma_25: weekly.sma(25),
    weekly_ma_50: weekly.sma(50),
    weekly_ma_100: weekly.sma(100),
    monthly_ma_3: monthly.sma(3),
    monthly_ma_5: monthly.sma(5),
    monthly_ma_10: monthly.sma(10),
    monthly_ma_20: monthly.sma(20),
    monthly_ma_25: monthly.sma(25),
  }
}

export function buildSnapshotCalculations(
  rows: OHLCV[],
  options: { includeWarmup?: boolean } = {},
): SnapshotCalculation[] {
  const results: SnapshotCalculation[] = []
  const adjustedRows = adjustLikelySplitOhlcv(rows)

  for (const segment of splitContinuousHistory(adjustedRows)) {
    if (!options.includeWarmup && segment.length < MIN_SNAPSHOT_DATA_POINTS) continue

    const prefix = buildClosePrefix(segment)
    const segmentStartDate = segment[0].date
    const weekly = new CalendarCloseAccumulator(calendarWeekBucket)
    const monthly = new CalendarCloseAccumulator(calendarMonthBucket)

    for (let i = 0; i < segment.length; i++) {
      weekly.update(segment[i])
      monthly.update(segment[i])
      if (!options.includeWarmup && i + 1 < MIN_SNAPSHOT_DATA_POINTS) continue

      const ma: MaValues = {
        ma_5: dailySmaAt(prefix, i, 5),
        ma_25: dailySmaAt(prefix, i, 25),
        ma_75: dailySmaAt(prefix, i, 75),
        ma_150: dailySmaAt(prefix, i, 150),
        ma_300: dailySmaAt(prefix, i, 300),
        weekly_ma_5: weekly.sma(5),
        weekly_ma_13: weekly.sma(13),
        weekly_ma_25: weekly.sma(25),
        weekly_ma_50: weekly.sma(50),
        weekly_ma_100: weekly.sma(100),
        monthly_ma_3: monthly.sma(3),
        monthly_ma_5: monthly.sma(5),
        monthly_ma_10: monthly.sma(10),
        monthly_ma_20: monthly.sma(20),
        monthly_ma_25: monthly.sma(25),
      }
      const stages = calculateAllStages(ma)

      results.push({
        date: segment[i].date,
        activeDays: i + 1,
        segmentStartDate,
        ...ma,
        ...stages,
      })
    }
  }

  return results
}

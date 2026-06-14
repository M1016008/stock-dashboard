import { calculateAllStages, type MaValues, type StageResult } from '@/lib/hex-stage'
import type { OHLCV } from '@/types/stock'

export const MIN_SNAPSHOT_DATA_POINTS = 5
export const MAX_CONTINUOUS_HISTORY_GAP_DAYS = 60

export const REQUIRED_ACTIVE_DAYS = {
  daily_a_stage: 75,
  daily_b_stage: 300,
  weekly_a_stage: 121,
  weekly_b_stage: 496,
  monthly_a_stage: 190,
  monthly_b_stage: 505,
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
  activeDays: number | null,
  requiredDays: number,
): number | null {
  if (activeDays == null) return value
  return activeDays >= requiredDays ? value : null
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

function sampledSmaAt(rows: OHLCV[], index: number, step: number, period: number): number | null {
  const firstIndex = index - (period - 1) * step
  if (firstIndex < 0) return null
  let sum = 0
  for (let i = 0; i < period; i++) {
    sum += rows[index - i * step].close
  }
  return sum / period
}

export function buildMaValuesAtIndex(rows: OHLCV[], prefix: number[], index: number): MaValues {
  return {
    ma_5: dailySmaAt(prefix, index, 5),
    ma_25: dailySmaAt(prefix, index, 25),
    ma_75: dailySmaAt(prefix, index, 75),
    ma_150: dailySmaAt(prefix, index, 150),
    ma_300: dailySmaAt(prefix, index, 300),
    weekly_ma_5: sampledSmaAt(rows, index, 5, 5),
    weekly_ma_13: sampledSmaAt(rows, index, 5, 13),
    weekly_ma_25: sampledSmaAt(rows, index, 5, 25),
    weekly_ma_50: sampledSmaAt(rows, index, 5, 50),
    weekly_ma_100: sampledSmaAt(rows, index, 5, 100),
    monthly_ma_3: sampledSmaAt(rows, index, 21, 3),
    monthly_ma_5: sampledSmaAt(rows, index, 21, 5),
    monthly_ma_10: sampledSmaAt(rows, index, 21, 10),
    monthly_ma_20: sampledSmaAt(rows, index, 21, 20),
    monthly_ma_25: sampledSmaAt(rows, index, 21, 25),
  }
}

export function buildSnapshotCalculations(rows: OHLCV[]): SnapshotCalculation[] {
  const results: SnapshotCalculation[] = []

  for (const segment of splitContinuousHistory(rows)) {
    if (segment.length < MIN_SNAPSHOT_DATA_POINTS) continue

    const prefix = buildClosePrefix(segment)
    const segmentStartDate = segment[0].date

    for (let i = 0; i < segment.length; i++) {
      if (i + 1 < MIN_SNAPSHOT_DATA_POINTS) continue

      const ma = buildMaValuesAtIndex(segment, prefix, i)
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

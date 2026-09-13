import { adjustLikelySplitOhlcv } from '@/lib/physical-momentum'
import { splitContinuousHistory } from '@/lib/snapshots/continuous-ma'
import {
  CALENDAR_WEEK_ANCHOR_MONDAY,
  resampleOhlcv,
  smaSeries,
} from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'

export type TriggerDiscoveryTimeframe = 'MONTHLY' | 'BIWEEKLY'

export const DEFAULT_TRIGGER_DISCOVERY_TIMEFRAME: TriggerDiscoveryTimeframe = 'MONTHLY'
export const BIWEEKLY_ANCHOR_MONDAY = CALENDAR_WEEK_ANCHOR_MONDAY

export type ContinuousBiweeklyMaPoint = OHLCV & {
  values: Map<number, number | null>
  segmentStartDate: string
}

export interface BiweeklySeriesOptions {
  /** Set false when the supplied weekly rows already use split-adjusted prices. */
  adjustSplits?: boolean
}

function normalizedPeriods(periods: readonly number[]): number[] {
  return [...new Set(periods)]
    .filter((period) => Number.isInteger(period) && period > 0)
    .sort((left, right) => left - right)
}

export function attachBiweeklyMovingAverages(
  biweeklyRows: OHLCV[],
  periods: readonly number[],
  segmentStartDate = biweeklyRows[0]?.date ?? '',
): ContinuousBiweeklyMaPoint[] {
  const requestedPeriods = normalizedPeriods(periods)
  if (requestedPeriods.length === 0) return []
  const valuesByPeriod = new Map(
    requestedPeriods.map((period) => [period, smaSeries(biweeklyRows, period)]),
  )
  return biweeklyRows.map((row, index) => ({
    ...row,
    values: new Map(requestedPeriods.map((period) => [
      period,
      valuesByPeriod.get(period)?.[index] ?? null,
    ])),
    segmentStartDate,
  }))
}

/**
 * Pair the canonical Monday-start weekly candles into fixed 14-day buckets.
 * resampleOhlcv uses the 1970-01-05 Monday epoch, so appending future weeks
 * cannot change any earlier bucket assignment.
 */
export function buildBiweeklyBarsFromWeekly(weeklyRows: OHLCV[]): OHLCV[] {
  return resampleOhlcv(weeklyRows, { timeframe: 'week', multiplier: 2 })
}

/** Build the canonical weekly series first, then pair those weekly candles. */
export function buildBiweeklyBarsFromDaily(
  rows: OHLCV[],
  options: BiweeklySeriesOptions = {},
): OHLCV[] {
  const normalized = options.adjustSplits === false ? rows : adjustLikelySplitOhlcv(rows)
  return splitContinuousHistory(normalized).flatMap((segment) => {
    const weekly = resampleOhlcv(segment, { timeframe: 'week', multiplier: 1 })
    return buildBiweeklyBarsFromWeekly(weekly)
  })
}

export function buildContinuousBiweeklyMaSeriesFromWeekly(
  weeklyRows: OHLCV[],
  periods: readonly number[],
  options: BiweeklySeriesOptions = {},
): ContinuousBiweeklyMaPoint[] {
  const requestedPeriods = normalizedPeriods(periods)
  if (requestedPeriods.length === 0) return []

  const normalized = options.adjustSplits === false
    ? weeklyRows.slice()
    : adjustLikelySplitOhlcv(weeklyRows)
  const sorted = normalized.sort((left, right) => left.date.localeCompare(right.date))

  return splitContinuousHistory(sorted).flatMap((segment) => {
    const biweekly = buildBiweeklyBarsFromWeekly(segment)
    const segmentStartDate = segment[0]?.date ?? ''
    return attachBiweeklyMovingAverages(biweekly, requestedPeriods, segmentStartDate)
  })
}

export function buildContinuousBiweeklyMaSeries(
  rows: OHLCV[],
  periods: readonly number[],
  options: BiweeklySeriesOptions = {},
): ContinuousBiweeklyMaPoint[] {
  const normalized = options.adjustSplits === false ? rows : adjustLikelySplitOhlcv(rows)
  return splitContinuousHistory(normalized).flatMap((segment) => {
    const weekly = resampleOhlcv(segment, { timeframe: 'week', multiplier: 1 })
    return buildContinuousBiweeklyMaSeriesFromWeekly(weekly, periods, { adjustSplits: false })
  })
}

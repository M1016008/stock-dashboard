import { sampleCalendarPeriodEnds, type SnapshotGranularity } from '@/lib/snapshots/calendar-periods'

export const STAGE_HISTORY_TRADING_DAY_PRESETS = [200, 600, 1200] as const
export const DEFAULT_STAGE_HISTORY_TRADING_DAYS = STAGE_HISTORY_TRADING_DAY_PRESETS[0]
export const MAX_STAGE_HISTORY_TRADING_DAYS = STAGE_HISTORY_TRADING_DAY_PRESETS.at(-1) ?? 1200

// UI表示件数。上の200/600/1200は日次ソース窓を週/月へ集約するAPI用で、
// こちらは選択した粒度で最終的に描画する点数を表す。
export const STAGE_TIMELINE_DISPLAY_PRESETS: Record<SnapshotGranularity, readonly number[]> = {
  daily: [20, 60, 120, 300],
  weekly: [13, 26, 52],
  monthly: [12, 24, 60],
}

export const DEFAULT_STAGE_TIMELINE_DISPLAY_COUNTS: Record<SnapshotGranularity, number> = {
  daily: 60,
  weekly: 13,
  monthly: 24,
}

export const MAX_STAGE_TIMELINE_DISPLAY_COUNTS: Record<SnapshotGranularity, number> = {
  daily: Math.max(...STAGE_TIMELINE_DISPLAY_PRESETS.daily),
  weekly: 104,
  monthly: 120,
}

export interface StageHistoryWindowMetadata {
  requestedTradingDays: number
  sourceTradingDays: number
  sourceStartDate: string | null
  sourceEndDate: string | null
  displayPoints: number
  displayStartDate: string | null
  displayEndDate: string | null
}

export interface StageHistoryWindow<T> {
  sourceRows: T[]
  displayRows: T[]
  metadata: StageHistoryWindowMetadata
}

/**
 * Selects a trailing active-trading-day window first, then samples its
 * calendar period ends. Stage values must already be calculated before this
 * function is called so changing the display window cannot change a Stage.
 */
export function selectStageHistoryWindow<T extends { date: string }>(
  rows: T[],
  granularity: SnapshotGranularity,
  requestedTradingDays: number,
  endDate: string | null = null,
): StageHistoryWindow<T> {
  const eligibleRows = endDate ? rows.filter((row) => row.date <= endDate) : rows
  const sourceRows = eligibleRows.slice(-requestedTradingDays)
  const displayRows = sampleCalendarPeriodEnds(sourceRows, granularity, sourceRows.length)

  return {
    sourceRows,
    displayRows,
    metadata: {
      requestedTradingDays,
      sourceTradingDays: sourceRows.length,
      sourceStartDate: sourceRows[0]?.date ?? null,
      sourceEndDate: sourceRows.at(-1)?.date ?? null,
      displayPoints: displayRows.length,
      displayStartDate: displayRows[0]?.date ?? null,
      displayEndDate: displayRows.at(-1)?.date ?? null,
    },
  }
}

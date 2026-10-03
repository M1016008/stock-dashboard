import { averageTrueRange } from '@/lib/ma-trajectory/core'
import { buildContinuousMonthlyMaSeries, splitContinuousHistory } from '@/lib/snapshots/continuous-ma'
import { buildBiweeklySeries, currentBiweeklyObservations } from '@/lib/server/trigger-discovery-historical-scan'
import { buildTriggerPathPoints, calculateTriggerPath } from '@/lib/server/trigger-path-calculation'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'
import type { TriggerPathProfile, TriggerPathPoint } from '@/lib/trigger-path-contract'
import { calendarWeekStart } from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'

export type PathDailyRow = { date: string; open: number; high: number; low: number; close: number }
export type PathWeeklyRow = PathDailyRow & { week_start_date: string }

export function pathDaysBefore(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() - days)
  return value.toISOString().slice(0, 10)
}

export function pathHistoryStart(contextStart: string, timeframe: TriggerDiscoveryTimeframe, maxPeriod: number): string {
  return pathDaysBefore(contextStart, maxPeriod * (timeframe === 'MONTHLY' ? 31 : 16) + 180)
}

export function pathWeeklyStart(contextStart: string, maxPeriod: number): string {
  return pathDaysBefore(calendarWeekStart(contextStart), (maxPeriod * 2 + 20) * 7)
}

// Shared by on-demand Follow-up and ticker-batched research. Only the data loading differs.
export function buildPathFromLoadedRows(input: {
  eventKey: string
  event: TriggerHistoricalScanEvent
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  analysisCutoffDate: string
  contextStart: string
  marketSessions: readonly string[]
  daily: readonly PathDailyRow[]
  weekly: readonly PathWeeklyRow[]
}): {
  profile: TriggerPathProfile
  series: TriggerPathPoint[]
  maZoneBuildMs: number
  atrMs: number
  pathCalculationMs: number
} {
  const maStarted = performance.now()
  const maByDate = new Map<string, { ma1: number | null; ma2: number | null; atr20: number | null }>()
  if (input.timeframe === 'MONTHLY') {
    const rows: OHLCV[] = input.daily.map((row) => ({ ...row, volume: 0 }))
    for (const point of buildContinuousMonthlyMaSeries(rows, [input.ma1Period, input.ma2Period], { adjustSplits: false })) {
      maByDate.set(point.date, {
        ma1: point.values.get(input.ma1Period) ?? null,
        ma2: point.values.get(input.ma2Period) ?? null,
        atr20: null,
      })
    }
  } else {
    const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG, ma1Period: input.ma1Period, ma2Period: input.ma2Period }
    const prepared = buildBiweeklySeries(input.weekly.map((row) => ({ ...row, ticker: input.event.ticker, volume: 0 })), config)
    const weeklyStart = pathWeeklyStart(input.contextStart, Math.max(input.ma1Period, input.ma2Period))
    for (const row of input.daily) {
      if (row.date < input.contextStart) continue
      const observation = currentBiweeklyObservations(
        prepared, row.date, Number(row.close), config, 1, weeklyStart,
      ).at(-1)
      maByDate.set(row.date, {
        ma1: observation?.date === row.date ? observation.ma1 : null,
        ma2: observation?.date === row.date ? observation.ma2 : null,
        atr20: null,
      })
    }
  }
  const maZoneBuildMs = performance.now() - maStarted
  const atrStarted = performance.now()
  for (const segment of splitContinuousHistory([...input.daily])) {
    for (let index = 20; index < segment.length; index += 1) {
      const row = segment[index]
      const ma = maByDate.get(row.date)
      if (ma) ma.atr20 = averageTrueRange(segment, index, 20)
    }
  }
  const atrMs = performance.now() - atrStarted
  const calculationStarted = performance.now()
  const chartRows = input.daily.filter((row) => row.date >= input.contextStart && row.date <= input.analysisCutoffDate)
  const series = buildTriggerPathPoints({ rows: chartRows, maByDate, marketSessions: input.marketSessions, event: input.event })
  const profile = calculateTriggerPath({
    eventKey: input.eventKey, event: input.event, timeframe: input.timeframe,
    ma1Period: input.ma1Period, ma2Period: input.ma2Period,
    analysisCutoffDate: input.analysisCutoffDate, marketSessions: input.marketSessions, points: series,
  })
  return { profile, series, maZoneBuildMs, atrMs, pathCalculationMs: performance.now() - calculationStarted }
}

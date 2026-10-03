import { calendarMonthBucket, calendarWeekBucket } from '@/lib/timeframes'

export type SnapshotGranularity = 'daily' | 'weekly' | 'monthly'

function periodBucket(date: string, granularity: Exclude<SnapshotGranularity, 'daily'>): number {
  return granularity === 'weekly' ? calendarWeekBucket(date) : calendarMonthBucket(date)
}

export function sampleCalendarPeriodEnds<T extends { date: string }>(
  rows: T[],
  granularity: SnapshotGranularity,
  count: number,
): T[] {
  if (granularity === 'daily') return rows.slice(-count)

  const periodEnds: T[] = []
  for (const row of rows) {
    const bucket = periodBucket(row.date, granularity)
    const last = periodEnds[periodEnds.length - 1]
    if (!last || periodBucket(last.date, granularity) !== bucket) {
      periodEnds.push(row)
    } else {
      periodEnds[periodEnds.length - 1] = row
    }
  }
  return periodEnds.slice(-count)
}

export function activeCalendarPeriodCounts(
  rows: Array<{ date: string }>,
  granularity: Exclude<SnapshotGranularity, 'daily'>,
): Map<string, number> {
  const counts = new Map<string, number>()
  let previousBucket: number | null = null
  let count = 0
  for (const row of rows) {
    const bucket = periodBucket(row.date, granularity)
    if (bucket !== previousBucket) {
      previousBucket = bucket
      count += 1
    }
    counts.set(row.date, count)
  }
  return counts
}

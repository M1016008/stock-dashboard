import { execAll, execGet } from '@/lib/db/client'
import { getHistoricalScanEventByKey } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import {
  buildPathFromLoadedRows, pathHistoryStart, pathWeeklyStart,
  type PathDailyRow, type PathWeeklyRow,
} from '@/lib/server/trigger-path-source'
import { TRIGGER_PATH_CONTRACT_VERSION, type TriggerPathResponse } from '@/lib/trigger-path-contract'

function duration(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100
}

export async function getTriggerPathFollowUp(input: {
  jobId: string
  eventKey: string
  preEventSessions?: number
}): Promise<TriggerPathResponse | null | 'NOT_READY' | 'EXPIRED' | 'NO_MARKET_DATA'> {
  const started = performance.now()
  let peakHeapBytes = process.memoryUsage().heapUsed
  const measureHeap = () => { peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed) }
  const saved = await getHistoricalScanEventByKey({ id: input.jobId, eventKey: input.eventKey })
  if (!saved || saved === 'NOT_READY' || saved === 'EXPIRED') return saved
  const artifactLookupMs = duration(started)
  const { event, timeframe, ma1Period, ma2Period } = saved
  const preEventSessions = input.preEventSessions ?? 20
  if (!Number.isInteger(preEventSessions) || preEventSessions < 0 || preEventSessions > 120) {
    throw new RangeError('preEventSessions must be an integer between 0 and 120')
  }
  const maxPeriod = Math.max(ma1Period, ma2Period)
  let sqlMs = 0
  let sqlQueryCount = 0
  let queryStarted = performance.now()
  const cutoff = await execGet<{ date: string | null }>('SELECT MAX(date) AS date FROM ohlcv_daily')
  sqlMs += duration(queryStarted)
  sqlQueryCount += 1
  if (!cutoff?.date || cutoff.date < event.date) return 'NO_MARKET_DATA'
  const analysisCutoffDate = cutoff.date

  queryStarted = performance.now()
  const market = await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date BETWEEN ? AND ? ORDER BY date',
    [event.date, analysisCutoffDate],
  )
  sqlMs += duration(queryStarted)
  sqlQueryCount += 1
  const marketSessions = market.map((row) => row.date)
  if (marketSessions[0] !== event.date) return 'NO_MARKET_DATA'

  queryStarted = performance.now()
  const context = preEventSessions === 0 ? [] : await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date<? ORDER BY date DESC LIMIT ?',
    [event.date, preEventSessions],
  )
  sqlMs += duration(queryStarted)
  sqlQueryCount += 1
  const contextStart = context.at(-1)?.date ?? event.date
  const historyStart = pathHistoryStart(contextStart, timeframe, maxPeriod)
  queryStarted = performance.now()
  const daily = await execAll<PathDailyRow>(
    `SELECT date, open, high, low, close FROM ohlcv_daily
     WHERE ticker=? AND date BETWEEN ? AND ? ORDER BY date`,
    [event.ticker, historyStart, analysisCutoffDate],
  )
  sqlMs += duration(queryStarted)
  sqlQueryCount += 1
  let ohlcvLoadMs = duration(queryStarted)
  measureHeap()

  let weekly: PathWeeklyRow[] = []
  if (timeframe === 'BIWEEKLY') {
    const weeklyStart = pathWeeklyStart(contextStart, maxPeriod)
    queryStarted = performance.now()
    weekly = await execAll<PathWeeklyRow>(
      `SELECT date, week_start_date, open, high, low, close FROM weekly_ohlcv
       WHERE ticker=? AND date BETWEEN ? AND ? ORDER BY date`,
      [event.ticker, weeklyStart, analysisCutoffDate],
    )
    const weeklyLoadMs = duration(queryStarted)
    sqlMs += weeklyLoadMs
    ohlcvLoadMs += weeklyLoadMs
    sqlQueryCount += 1
  }
  const built = buildPathFromLoadedRows({
    eventKey: input.eventKey, event, timeframe, ma1Period, ma2Period, analysisCutoffDate,
    contextStart, marketSessions, daily, weekly,
  })
  measureHeap()
  return {
    contractVersion: TRIGGER_PATH_CONTRACT_VERSION,
    event,
    pathProfile: built.profile,
    series: built.series,
    meta: {
      scanJobId: input.jobId,
      analysisCutoffDate,
      preEventSessions,
      atrPeriod: 20,
      atrNormalizationBasis: 'DEEPEST_DATE',
      maxReboundExcludesDeepestSession: true,
      derivedOnDemand: true,
      performance: {
        artifactLookupMs, sqlMs, sqlQueryCount, ohlcvLoadMs,
        maZoneBuildMs: built.maZoneBuildMs, atrMs: built.atrMs,
        pathCalculationMs: built.pathCalculationMs, peakHeapBytes,
        totalMs: duration(started),
      },
    },
  }
}

import assert from 'node:assert/strict'
import { execAll, execGet } from '@/lib/db/client'
import { calculateEventOutcome } from '@/lib/server/trigger-discovery-outcome-analysis'
import { getHistoricalScanJobResult } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { getTriggerPathFollowUp } from '@/lib/server/trigger-path-read-model'
import { buildBiweeklySeries, currentBiweeklyObservations } from '@/lib/server/trigger-discovery-historical-scan'
import { buildContinuousMonthlyMaSeries } from '@/lib/snapshots/continuous-ma'
import { DEFAULT_MA_ZONE_TRIGGER_CONFIG } from '@/lib/trigger-discovery-engine'
import { calculateMaZoneSnapshot } from '@/lib/trigger-discovery-engine'
import type { TriggerPathResponse } from '@/lib/trigger-path-contract'
import type { TriggerPathPoint } from '@/lib/trigger-path-contract'

const jobs = (process.env.TRIGGER_PATH_AUDIT_JOBS ?? '').split(',').filter(Boolean)
if (jobs.length !== 2) throw new Error('Set TRIGGER_PATH_AUDIT_JOBS=monthlyJobId,biweeklyJobId')

function close(actual: number | null, expected: number, label: string): void {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-8 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} != ${expected}`)
}

function independentlyCheck(input: {
  points: TriggerPathPoint[]
  profile: NonNullable<Awaited<ReturnType<typeof getTriggerPathFollowUp>>> & object
}) {
  const { points } = input
  const profile = (input.profile as { pathProfile: import('@/lib/trigger-path-contract').TriggerPathProfile }).pathProfile
  const future = points.filter((row) => row.date > profile.eventDate)
  const latest = points.filter((row) => row.date >= profile.eventDate).at(-1)
  assert.equal(profile.latestDate, latest?.date ?? null)
  if (latest) close(profile.returnToDate, latest.close / profile.anchorPrice - 1, 'return to date')
  const rowsWithZone = future.filter((row) => row.zoneLower != null && row.zoneUpper != null)
  const breached = rowsWithZone.filter((row) => row.low < row.zoneLower!)
  const deepest = breached.reduce<TriggerPathPoint | null>((current, row) => !current
    || row.low / row.zoneLower! < current.low / current.zoneLower! ? row : current, null)
  assert.equal(profile.breachedZoneLower, deepest != null)
  assert.equal(profile.deepestDate, deepest?.date ?? null)
  if (deepest) {
    assert.equal(profile.deepestLow, deepest.low)
    assert.equal(profile.deepestClose, deepest.close)
    assert.equal(profile.zoneLowerAtDeepest, deepest.zoneLower)
    close(profile.maxZoneUndershootLowPct, (deepest.low / deepest.zoneLower! - 1) * 100, 'dynamic depth')
    close(profile.dynamicUndershootClosePctAtDeepest, (deepest.close / deepest.zoneLower! - 1) * 100, 'dynamic close at depth')
    close(profile.fixedAnchorUndershootLowPctAtDeepest, (deepest.low / profile.anchorZoneLower - 1) * 100, 'fixed depth')
    close(profile.fixedAnchorUndershootClosePctAtDeepest, (deepest.close / profile.anchorZoneLower - 1) * 100, 'fixed close at depth')
    assert.equal(profile.tradingSessionsToDeepest, deepest.marketSession)
    if (latest) close(profile.returnDeepestToLatest, latest.close / deepest.low - 1, 'deepest -> latest')
    if (deepest.atr20 != null) close(profile.undershootAtrMultiple,
      (deepest.zoneLower! - deepest.low) / deepest.atr20, 'ATR normalization')
  }
  assert.equal(profile.firstZoneLowerBreachDate, breached[0]?.date ?? null)
  assert.equal(profile.intradayOnlyUndershootOccurred,
    breached.some((row) => row.close >= row.zoneLower!))
  const below = rowsWithZone.filter((row) => row.close < row.zoneLower!)
  assert.equal(profile.totalBelowZoneSessions, below.length)
  let streak = 0
  let longest = 0
  let prior = 0
  for (const row of future) {
    if (row.zoneLower != null && row.close < row.zoneLower && row.marketSession != null) {
      streak = row.marketSession === prior + 1 ? streak + 1 : 1
      longest = Math.max(streak, longest)
    } else streak = 0
    prior = row.marketSession ?? prior
  }
  assert.equal(profile.longestConsecutiveBelowZoneSessions, longest)
  const firstClose = below[0]
  assert.equal(profile.firstZoneLowerCloseBreachDate, firstClose?.date ?? null)
  const reclaim = firstClose && rowsWithZone.find((row) => row.date > firstClose.date && row.close >= row.zoneLower!)
  assert.equal(profile.firstZoneLowerReclaimDate, reclaim?.date ?? null)
  const upper = reclaim && rowsWithZone.find((row) => row.date >= reclaim.date && row.close >= row.zoneUpper!)
  assert.equal(profile.firstZoneUpperReclaimDate, upper?.date ?? null)
  if (reclaim) close(profile.returnFromLowerReclaimToLatest, latest!.close / reclaim.close - 1, 'reclaim -> latest')
  const minFixedLow = future.reduce<number | null>((minimum, row) => minimum == null
    ? row.low : Math.min(minimum, row.low), null)
  if (minFixedLow != null) close(profile.fixedAnchorUndershootLowPct,
    (minFixedLow / profile.anchorZoneLower - 1) * 100, 'fixed worst low')
  if (rowsWithZone.length) close(profile.maxZoneUndershootClosePct,
    Math.min(...rowsWithZone.map((row) => (row.close / row.zoneLower! - 1) * 100)), 'worst close')
  const position = latest?.ma1 == null || latest.ma2 == null ? null
    : calculateMaZoneSnapshot(latest.close, latest.ma1, latest.ma2).pricePosition
  assert.equal(profile.currentZonePosition, position)
  for (const horizon of profile.horizonPaths) {
    if (!horizon.availability) continue
    const window = future.filter((point) => point.marketSession != null && point.marketSession <= horizon.horizonSessions)
    assert.equal(window.length, horizon.horizonSessions)
    assert.equal(horizon.path?.deepestDate, window.filter((row) => row.low < row.zoneLower!)
      .reduce<TriggerPathPoint | null>((minimum, row) => !minimum || row.low / row.zoneLower! < minimum.low / minimum.zoneLower!
        ? row : minimum, null)?.date ?? null)
  }
}

async function verifyPrefixAndAtr(result: TriggerPathResponse): Promise<number> {
  const { timeframe, ticker, ma1Period, ma2Period } = result.pathProfile
  const samples = [result.series.find((row) => row.date === result.event.date),
    result.series.find((row) => row.marketSession === 20),
    result.series.find((row) => row.marketSession === 60)].filter((row) => row?.ma1 != null && row.ma2 != null)
  let checked = 0
  for (const point of samples) {
    if (!point) continue
    if (timeframe === 'MONTHLY') {
      const rows = await execAll<{ date: string; close: number }>(
        'SELECT date, close FROM ohlcv_daily WHERE ticker=? AND date<=? ORDER BY date',
        [ticker, point.date],
      )
      const prefix = buildContinuousMonthlyMaSeries(rows.map((row) => ({
        date: row.date, close: Number(row.close), open: Number(row.close), high: Number(row.close),
        low: Number(row.close), volume: 0,
      })), [ma1Period, ma2Period], { adjustSplits: false }).at(-1)
      if (prefix?.values.get(ma1Period) != null && prefix.values.get(ma2Period) != null) {
        close(point.ma1, prefix.values.get(ma1Period)!, 'monthly prefix MA1')
        close(point.ma2, prefix.values.get(ma2Period)!, 'monthly prefix MA2')
        checked += 1
      }
    } else {
      const weekly = await execAll<{ date: string; week_start_date: string; close: number }>(
        'SELECT date, week_start_date, close FROM weekly_ohlcv WHERE ticker=? AND date<=? ORDER BY date',
        [ticker, point.date],
      )
      const config = { ...DEFAULT_MA_ZONE_TRIGGER_CONFIG, ma1Period, ma2Period }
      const prepared = buildBiweeklySeries(weekly.map((row) => ({
        ...row, ticker, open: Number(row.close), high: Number(row.close), low: Number(row.close),
        close: Number(row.close), volume: 0,
      })), config)
      const partial = currentBiweeklyObservations(prepared, point.date, point.close,
        config, 1, weekly[0]?.date ?? '').at(-1)
      if (partial) {
        close(point.ma1, partial.ma1, 'biweekly prefix MA1')
        close(point.ma2, partial.ma2, 'biweekly prefix MA2')
        checked += 1
      }
    }
  }
  const deepest = result.series.find((row) => row.date === result.pathProfile.deepestDate)
  if (deepest?.atr20 != null) {
    const rows = await execAll<{ date: string; high: number; low: number; close: number }>(
      `SELECT date, high, low, close FROM ohlcv_daily
       WHERE ticker=? AND date<=? ORDER BY date DESC LIMIT 21`, [ticker, deepest.date],
    )
    const chronological = rows.reverse()
    if (chronological.length === 21) {
      const mean = chronological.slice(1).reduce((sum, row, index) => {
        const priorClose = Number(chronological[index].close)
        return sum + Math.max(Number(row.high) - Number(row.low),
          Math.abs(Number(row.high) - priorClose), Math.abs(Number(row.low) - priorClose))
      }, 0) / 20
      close(deepest.atr20, mean, 'ATR20 independent 21 OHLCV rows')
      checked += 1
    }
  }
  return checked
}

async function main() {
  const all: Array<{ jobId: string; eventKey: string; ticker: string; timeframe: string; ms: number }> = []
  const byJob: Record<string, number> = {}
  let prefixAndAtrChecks = 0
  for (const jobId of jobs) {
    const page = await getHistoricalScanJobResult({ id: jobId, eventOffset: 0, eventLimit: 1000, eventType: 'ENTERED' })
    assert.ok(page && typeof page === 'object' && page.events.length >= 15, `not enough saved events in ${jobId}`)
    const selected = Array.from({ length: 15 }, (_, i) => page.events[Math.floor(i * (page.events.length - 1) / 14)])
    const unique = new Set(selected.map((event) => event.eventKey))
    assert.equal(unique.size, 15)
    for (const event of selected) {
      const result = await getTriggerPathFollowUp({ jobId, eventKey: event.eventKey! })
      assert.ok(result && typeof result === 'object')
      assert.equal(result.event.price, event.price)
      assert.equal(result.event.date, event.date)
      assert.equal(result.pathProfile.anchorZoneLower, Math.min(event.ma1, event.ma2))
      assert.equal(result.pathProfile.anchorZoneUpper, Math.max(event.ma1, event.ma2))
      assert.equal(result.pathProfile.timeframe, page.scanMeta.timeframe)
      assert.equal(result.pathProfile.ma1Period, page.scanMeta.ma1Period)
      assert.equal(result.pathProfile.ma2Period, page.scanMeta.ma2Period)
      if (result.event.maDate === result.event.date) {
        const eventPoint = result.series.find((row) => row.date === result.event.date)
        if (eventPoint?.ma1 != null && eventPoint.ma2 != null) {
          close(eventPoint.ma1, result.event.ma1, 'saved event vs as-of MA1')
          close(eventPoint.ma2, result.event.ma2, 'saved event vs as-of MA2')
        }
      }
      const date = await execGet<{ date: string }>('SELECT MAX(date) AS date FROM ohlcv_daily')
      assert.equal(result.meta.analysisCutoffDate, date?.date)
      assert.ok(result.series.every((point) => point.date <= result.meta.analysisCutoffDate))
      assert.ok(result.meta.performance.sqlQueryCount <= 5)
      const latest = await execGet<{ date: string; close: number }>(
        'SELECT date, close FROM ohlcv_daily WHERE ticker=? AND date BETWEEN ? AND ? ORDER BY date DESC LIMIT 1',
        [event.ticker, event.date, result.meta.analysisCutoffDate],
      )
      assert.equal(result.pathProfile.latestDate, latest?.date ?? null)
      if (latest) assert.equal(result.pathProfile.latestClose, Number(latest.close))
      independentlyCheck({ points: result.series, profile: result })
      if (selected.indexOf(event) < 3) prefixAndAtrChecks += await verifyPrefixAndAtr(result)
      const marketSessions = (await execAll<{ date: string }>(
        'SELECT DISTINCT date FROM ohlcv_daily WHERE date BETWEEN ? AND ? ORDER BY date',
        [event.date, result.meta.analysisCutoffDate],
      )).map((row) => row.date)
      assert.equal(result.pathProfile.elapsedTradingSessions, marketSessions.length - 1)
      const outcome = calculateEventOutcome(event, result.series.map((row) => ({ ticker: event.ticker, ...row })),
        [20, 60, 120, 245], marketSessions)
      for (const horizon of result.pathProfile.horizonPaths) {
        if (!horizon.availability) continue
        const period = horizon.horizonSessions
        assert.equal(outcome[`availability${period}`], 'AVAILABLE')
        const end = result.series.find((row) => row.date === horizon.endDate)!
        close(outcome[`return${period}`], end.close / event.price - 1, `outcome return ${period}`)
        close(outcome[`mfe${period}`], horizon.path!.maxUpsideToDate!, `outcome mfe ${period}`)
        close(outcome[`mae${period}`], horizon.path!.maxDownsideToDate!, `outcome mae ${period}`)
      }
      all.push({ jobId, eventKey: event.eventKey!, ticker: event.ticker,
        timeframe: page.scanMeta.timeframe, ms: result.meta.performance.totalMs })
    }
    byJob[`${page.scanMeta.timeframe} ${page.scanMeta.ma1Period}/${page.scanMeta.ma2Period}`] = selected.length
  }
  assert.equal(all.length, 30)
  assert.ok(prefixAndAtrChecks >= 12, `only ${prefixAndAtrChecks} independent PIT / ATR checks`)
  console.log(JSON.stringify({ crossChecked: all.length, byJob, prefixAndAtrChecks,
    latencyMs: { min: Math.min(...all.map((row) => row.ms)), max: Math.max(...all.map((row) => row.ms)),
      mean: all.reduce((sum, row) => sum + row.ms, 0) / all.length },
    sample: all.slice(0, 3).concat(all.slice(15, 18)) }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })

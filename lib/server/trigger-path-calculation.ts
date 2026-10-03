import { calculateMaZoneSnapshot } from '@/lib/trigger-discovery-engine'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'
import {
  TRIGGER_PATH_HORIZONS,
  type TriggerPathPoint,
  type TriggerPathProfile,
  type TriggerPathWindow,
  type TriggerPathZonePosition,
} from '@/lib/trigger-path-contract'

type PriceRow = Pick<TriggerPathPoint, 'date' | 'high' | 'low' | 'close'>
type MaRow = { ma1: number | null; ma2: number | null; atr20: number | null }

export function buildTriggerPathPoints(input: {
  rows: readonly PriceRow[]
  maByDate: ReadonlyMap<string, MaRow>
  marketSessions: readonly string[]
  event: TriggerHistoricalScanEvent
}): TriggerPathPoint[] {
  const sessionByDate = new Map(input.marketSessions.map((date, index) => [date, index]))
  const anchorLower = Math.min(input.event.ma1, input.event.ma2)
  return input.rows.map((row) => {
    const ma = input.maByDate.get(row.date)
    const snapshot = ma?.ma1 != null && ma.ma2 != null
      ? calculateMaZoneSnapshot(row.close, ma.ma1, ma.ma2)
      : null
    return {
      ...row,
      ma1: ma?.ma1 ?? null,
      ma2: ma?.ma2 ?? null,
      atr20: ma?.atr20 ?? null,
      zoneUpper: snapshot?.zoneUpper ?? null,
      zoneLower: snapshot?.zoneLower ?? null,
      zoneDistancePct: snapshot?.zoneDistancePct ?? null,
      dynamicUndershootLowPct: snapshot ? (row.low / snapshot.zoneLower - 1) * 100 : null,
      dynamicUndershootClosePct: snapshot ? (row.close / snapshot.zoneLower - 1) * 100 : null,
      fixedAnchorUndershootLowPct: anchorLower > 0 ? (row.low / anchorLower - 1) * 100 : null,
      fixedAnchorUndershootClosePct: anchorLower > 0 ? (row.close / anchorLower - 1) * 100 : null,
      marketSession: sessionByDate.get(row.date) ?? null,
    }
  })
}

function pathWindow(
  points: readonly TriggerPathPoint[],
  anchorPrice: number,
  anchorSession: number,
): TriggerPathWindow {
  let high: TriggerPathPoint | null = null
  let low: TriggerPathPoint | null = null
  let deepest: TriggerPathPoint | null = null
  let worstClose: number | null = null
  let fixedLow: number | null = null
  let fixedClose: number | null = null
  let firstLowBreach: string | null = null
  let firstCloseBreach: TriggerPathPoint | null = null
  let lowerReclaim: TriggerPathPoint | null = null
  let upperReclaim: TriggerPathPoint | null = null
  let belowSessions = 0
  let streak = 0
  let longestStreak = 0
  let previousSession = anchorSession
  let intradayOnly = false
  for (const row of points) {
    if (!high || row.high > high.high) high = row
    if (!low || row.low < low.low) low = row
    if (row.fixedAnchorUndershootLowPct != null && (fixedLow == null || row.fixedAnchorUndershootLowPct < fixedLow)) {
      fixedLow = row.fixedAnchorUndershootLowPct
    }
    if (row.fixedAnchorUndershootClosePct != null && (fixedClose == null || row.fixedAnchorUndershootClosePct < fixedClose)) {
      fixedClose = row.fixedAnchorUndershootClosePct
    }
    if (row.zoneLower == null || row.zoneUpper == null || row.marketSession == null) {
      streak = 0
      previousSession = row.marketSession ?? previousSession
      continue
    }
    if (row.dynamicUndershootClosePct != null && (worstClose == null || row.dynamicUndershootClosePct < worstClose)) {
      worstClose = row.dynamicUndershootClosePct
    }
    if (row.low < row.zoneLower) {
      firstLowBreach ??= row.date
      if (row.close >= row.zoneLower) intradayOnly = true
      if (!deepest || row.dynamicUndershootLowPct! < deepest.dynamicUndershootLowPct!) deepest = row
    }
    if (row.close < row.zoneLower) {
      belowSessions += 1
      streak = previousSession === row.marketSession - 1 ? streak + 1 : 1
      longestStreak = Math.max(longestStreak, streak)
      firstCloseBreach ??= row
    } else {
      streak = 0
      if (firstCloseBreach && !lowerReclaim) lowerReclaim = row
      if (lowerReclaim && row.close >= row.zoneUpper && !upperReclaim) upperReclaim = row
    }
    previousSession = row.marketSession
  }
  const latest = points.at(-1) ?? null
  let rebound: TriggerPathPoint | null = null
  let afterReclaimHigh: TriggerPathPoint | null = null
  for (const row of points) {
    if (deepest && row.marketSession != null && deepest.marketSession != null
      && row.marketSession > deepest.marketSession && (!rebound || row.high > rebound.high)) rebound = row
    if (lowerReclaim && row.marketSession != null && lowerReclaim.marketSession != null
      && row.marketSession > lowerReclaim.marketSession && (!afterReclaimHigh || row.high > afterReclaimHigh.high)) {
      afterReclaimHigh = row
    }
  }
  const widthAtDeepest = deepest && deepest.zoneLower != null && deepest.zoneUpper != null
    ? (deepest.zoneUpper / deepest.zoneLower - 1) * 100
    : null
  const depth = deepest?.dynamicUndershootLowPct ?? null
  return {
    observedSessions: points.length,
    maxUpsideToDate: high ? high.high / anchorPrice - 1 : null,
    maxUpsideDate: high?.date ?? null,
    maxDownsideToDate: low ? low.low / anchorPrice - 1 : null,
    maxDownsideDate: low?.date ?? null,
    breachedZoneLower: deepest != null,
    firstZoneLowerBreachDate: firstLowBreach,
    firstZoneLowerCloseBreachDate: firstCloseBreach?.date ?? null,
    deepestDate: deepest?.date ?? null,
    deepestLow: deepest?.low ?? null,
    deepestClose: deepest?.close ?? null,
    zoneUpperAtDeepest: deepest?.zoneUpper ?? null,
    zoneLowerAtDeepest: deepest?.zoneLower ?? null,
    dynamicUndershootLowPctAtDeepest: depth,
    dynamicUndershootClosePctAtDeepest: deepest?.dynamicUndershootClosePct ?? null,
    fixedAnchorUndershootLowPctAtDeepest: deepest?.fixedAnchorUndershootLowPct ?? null,
    fixedAnchorUndershootClosePctAtDeepest: deepest?.fixedAnchorUndershootClosePct ?? null,
    maxZoneUndershootLowPct: depth,
    maxZoneUndershootClosePct: worstClose,
    fixedAnchorUndershootLowPct: fixedLow,
    fixedAnchorUndershootClosePct: fixedClose,
    tradingSessionsToDeepest: deepest?.marketSession == null ? null : deepest.marketSession - anchorSession,
    totalBelowZoneSessions: belowSessions,
    longestConsecutiveBelowZoneSessions: longestStreak,
    intradayOnlyUndershootOccurred: intradayOnly,
    firstZoneLowerReclaimDate: lowerReclaim?.date ?? null,
    firstZoneUpperReclaimDate: upperReclaim?.date ?? null,
    sessionsFromHitToLowerReclaim: lowerReclaim?.marketSession == null ? null : lowerReclaim.marketSession - anchorSession,
    sessionsFromDeepestToLowerReclaim: lowerReclaim?.marketSession == null || deepest?.marketSession == null
      || lowerReclaim.marketSession < deepest.marketSession ? null : lowerReclaim.marketSession - deepest.marketSession,
    reclaimStatus: !firstCloseBreach ? 'NOT_BREACHED'
      : !latest || latest.zoneLower == null || latest.close < latest.zoneLower || !lowerReclaim ? 'BREACHED_NOT_RECLAIMED'
        : latest.zoneUpper != null && latest.close >= latest.zoneUpper ? 'UPPER_RECLAIMED' : 'LOWER_RECLAIMED',
    returnDeepestToLatest: deepest && latest ? latest.close / deepest.low - 1 : null,
    maxReboundFromDeepest: deepest && rebound ? rebound.high / deepest.low - 1 : null,
    maxReboundDate: rebound?.date ?? null,
    returnFromLowerReclaimToLatest: lowerReclaim && latest ? latest.close / lowerReclaim.close - 1 : null,
    maxUpsideAfterLowerReclaim: lowerReclaim && afterReclaimHigh ? afterReclaimHigh.high / lowerReclaim.close - 1 : null,
    maxUpsideAfterLowerReclaimDate: afterReclaimHigh?.date ?? null,
    zoneWidthPctAtDeepest: widthAtDeepest,
    undershootToZoneWidthRatio: depth != null && widthAtDeepest != null && widthAtDeepest > 0
      ? Math.abs(depth) / widthAtDeepest : null,
    atrAtDeepest: deepest?.atr20 ?? null,
    undershootAtrMultiple: deepest?.atr20 && deepest.zoneLower != null
      ? (deepest.zoneLower - deepest.low) / deepest.atr20 : null,
  }
}

export function calculateTriggerPath(input: {
  eventKey: string
  event: TriggerHistoricalScanEvent
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  analysisCutoffDate: string
  marketSessions: readonly string[]
  points: readonly TriggerPathPoint[]
}): TriggerPathProfile {
  const { event, marketSessions } = input
  const anchorSession = marketSessions.indexOf(event.date)
  if (anchorSession < 0 || !(event.price > 0) || !(event.ma1 > 0) || !(event.ma2 > 0)) {
    throw new RangeError('The saved event has no valid market-session or price/MA anchor')
  }
  const anchorUpper = Math.max(event.ma1, event.ma2)
  const anchorLower = Math.min(event.ma1, event.ma2)
  const future = input.points.filter((row) => row.marketSession != null && row.marketSession > anchorSession)
  const latest = input.points.filter((row) => row.date >= event.date).at(-1) ?? null
  const elapsed = marketSessions.length - anchorSession - 1
  const path = pathWindow(future, event.price, anchorSession)
  const currentZonePosition: TriggerPathZonePosition | null = latest?.zoneLower == null || latest.zoneUpper == null
    || latest.ma1 == null || latest.ma2 == null
    ? null : calculateMaZoneSnapshot(latest.close, latest.ma1, latest.ma2).pricePosition
  return {
    ...path,
    eventKey: input.eventKey,
    ticker: event.ticker,
    companyName: event.companyName,
    eventDate: event.date,
    timeframe: input.timeframe,
    ma1Period: input.ma1Period,
    ma2Period: input.ma2Period,
    analysisCutoffDate: input.analysisCutoffDate,
    anchorPrice: event.price,
    anchorZoneUpper: anchorUpper,
    anchorZoneLower: anchorLower,
    zoneWidthPctAtHit: (anchorUpper / anchorLower - 1) * 100,
    latestDate: latest?.date ?? null,
    latestClose: latest?.close ?? null,
    returnToDate: latest ? latest.close / event.price - 1 : null,
    elapsedTradingSessions: elapsed,
    atrAtHit: input.points.find((row) => row.date === event.date)?.atr20 ?? null,
    currentZonePosition,
    horizonPaths: TRIGGER_PATH_HORIZONS.map((horizon) => {
      const endDate = marketSessions[anchorSession + horizon] ?? null
      const dates = marketSessions.slice(anchorSession + 1, anchorSession + horizon + 1)
      const selected = future.filter((row) => row.marketSession != null && row.marketSession <= anchorSession + horizon)
      const available = endDate != null && dates.length === horizon
        && selected.length === horizon && selected.every((row, index) => row.date === dates[index]
          && row.zoneLower != null && row.zoneUpper != null)
      return {
        horizonSessions: horizon,
        availability: available,
        endDate,
        returnFromHit: available ? selected.at(-1)!.close / event.price - 1 : null,
        path: available ? pathWindow(selected, event.price, anchorSession) : null,
      }
    }),
  }
}

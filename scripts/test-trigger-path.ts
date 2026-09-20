import assert from 'node:assert/strict'
import { calculateEventOutcome } from '@/lib/server/trigger-discovery-outcome-analysis'
import { buildTriggerPathPoints, calculateTriggerPath } from '@/lib/server/trigger-path-calculation'
import { historicalEventKey } from '@/lib/server/trigger-discovery-historical-scan-jobs'
import { averageTrueRange } from '@/lib/ma-trajectory/core'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerPathPoint } from '@/lib/trigger-path-contract'

const day = (offset: number): string => {
  const date = new Date('2025-01-06T00:00:00Z')
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

function event(date = day(0)): TriggerHistoricalScanEvent {
  return {
    date, ticker: '7003', companyName: 'Fixture', eventType: 'ENTERED',
    previousStatus: null, currentStatus: 'NEAR', snapshotBasis: 'CURRENT',
    price: 110, ma1: 110, ma2: 100, zoneDistancePct: 0,
    triggerScore: 50, scoreBreakdown: {} as TriggerHistoricalScanEvent['scoreBreakdown'],
    priceDate: date, maDate: date, stageDate: null,
    dayAStage: null, dayBStage: null, weekAStage: null, weekBStage: null,
    monthAStage: null, monthBStage: null,
  }
}

function run(rows: Array<{ close: number; low: number; high?: number; lower?: number; upper?: number; atr?: number }>,
  missing: number[] = []) {
  const marketSessions = Array.from({ length: rows.length + 1 }, (_, index) => day(index))
  const prices = rows.flatMap((row, index) => missing.includes(index + 1) ? [] : [{
    date: day(index + 1), high: row.high ?? row.close + 2,
    low: row.low, close: row.close,
  }])
  const maByDate = new Map(prices.map((row) => {
    const fixture = rows[marketSessions.indexOf(row.date) - 1]
    return [row.date, { ma1: fixture.upper ?? 110, ma2: fixture.lower ?? 100, atr20: fixture.atr ?? 5 }] as const
  }))
  const points = buildTriggerPathPoints({ rows: prices, maByDate, marketSessions, event: event() })
  const profile = calculateTriggerPath({
    eventKey: 'e0', event: event(), timeframe: 'MONTHLY',
    ma1Period: 20, ma2Period: 25, analysisCutoffDate: marketSessions.at(-1)!,
    marketSessions, points,
  })
  return { profile, points }
}

function near(actual: number | null, expected: number, label: string): void {
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`)
}

function fixtures() {
  assert.equal(historicalEventKey(0), 'e0')
  assert.equal(historicalEventKey(35), 'ez')
  const a = run([{ close: 106, low: 102 }, { close: 105, low: 101 }]).profile
  assert.equal(a.breachedZoneLower, false)
  assert.equal(a.deepestDate, null)
  assert.equal(a.reclaimStatus, 'NOT_BREACHED')
  assert.equal(a.maxUpsideDate, day(1))

  const b = run([{ close: 102, low: 98 }]).profile
  assert.equal(b.intradayOnlyUndershootOccurred, true)
  assert.equal(b.firstZoneLowerCloseBreachDate, null)
  assert.equal(b.totalBelowZoneSessions, 0)
  near(b.maxZoneUndershootLowPct, -2, 'intraday depth')
  near(b.undershootAtrMultiple, 0.4, 'ATR normalization')

  const c = run([{ close: 96, low: 95 }, { close: 97, low: 94 }]).profile
  assert.equal(c.firstZoneLowerCloseBreachDate, day(1))
  assert.equal(c.reclaimStatus, 'BREACHED_NOT_RECLAIMED')
  assert.equal(c.longestConsecutiveBelowZoneSessions, 2)

  const d = run([{ close: 96, low: 95 }, { close: 94, low: 93 }, { close: 97, low: 92 }]).profile
  assert.equal(d.totalBelowZoneSessions, 3)
  assert.equal(d.longestConsecutiveBelowZoneSessions, 3)
  assert.equal(d.deepestDate, day(3))
  assert.equal(d.tradingSessionsToDeepest, 3)

  const ef = run([
    { close: 98, low: 94 }, { close: 103, low: 92 },
    { close: 111, low: 102 }, { close: 96, low: 91 },
    { close: 102, low: 93 }, { close: 112, low: 105 },
  ]).profile
  assert.equal(ef.firstZoneLowerReclaimDate, day(2))
  assert.equal(ef.firstZoneUpperReclaimDate, day(3))
  assert.equal(ef.deepestDate, day(4))
  assert.equal(ef.sessionsFromDeepestToLowerReclaim, null)
  assert.equal(ef.totalBelowZoneSessions, 2)
  assert.equal(ef.longestConsecutiveBelowZoneSessions, 1)
  assert.equal(ef.reclaimStatus, 'UPPER_RECLAIMED')
  near(ef.returnDeepestToLatest, 112 / 91 - 1, 'rebound')
  assert.equal(ef.maxReboundDate, day(6))

  const moving = run([
    { close: 101, low: 99, lower: 102, upper: 112 },
    { close: 108, low: 99, lower: 108, upper: 118 },
  ]).profile
  assert.equal(moving.deepestDate, day(2))
  near(moving.maxZoneUndershootLowPct, (99 / 108 - 1) * 100, 'moving zone')
  near(moving.fixedAnchorUndershootLowPctAtDeepest, -1, 'fixed zone')
  assert.equal(moving.firstZoneLowerReclaimDate, day(2))
  const tie = run([{ close: 98, low: 95, high: 120 }, { close: 98, low: 95, high: 120 }]).profile
  assert.equal(tie.deepestDate, day(1))
  assert.equal(tie.maxUpsideDate, day(1))

  const empty = calculateTriggerPath({
    eventKey: 'e0', event: event(), timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
    analysisCutoffDate: day(0), marketSessions: [day(0)], points: [],
  })
  assert.equal(empty.elapsedTradingSessions, 0)
  assert.equal(empty.maxDownsideToDate, null)
  assert.equal(empty.horizonPaths[0].availability, false)
  assert.equal(empty.horizonPaths[0].returnFromHit, null)
  assert.equal(empty.latestDate, null)
  const sameDayPoints = buildTriggerPathPoints({
    rows: [{ date: day(0), high: 111, low: 109, close: 110 }],
    maByDate: new Map([[day(0), { ma1: 110, ma2: 100, atr20: null }]]),
    marketSessions: [day(0)], event: event(),
  })
  const sameDay = calculateTriggerPath({
    eventKey: 'e0', event: event(), timeframe: 'MONTHLY', ma1Period: 20, ma2Period: 25,
    analysisCutoffDate: day(0), marketSessions: [day(0)], points: sameDayPoints,
  })
  assert.equal(sameDay.latestDate, day(0))
  assert.equal(sameDay.returnToDate, 0)
  assert.equal(sameDay.maxUpsideToDate, null)

  const long = run(Array.from({ length: 250 }, (_, i) => ({
    close: 101 + i / 5, low: 98 + i / 5, high: 105 + i / 5,
  })))
  const outcome = calculateEventOutcome(event(), long.points.map((row) => ({ ticker: '7003', ...row })),
    [20, 60, 120, 245], Array.from({ length: 251 }, (_, index) => day(index)))
  for (const horizon of [20, 60, 120, 245] as const) {
    const window = long.profile.horizonPaths.find((item) => item.horizonSessions === horizon)!
    assert.equal(window.availability, true)
    assert.equal(outcome[`availability${horizon}`], 'AVAILABLE')
    const horizonClose = long.points[horizon - 1].close
    near(outcome[`return${horizon}`], horizonClose / event().price - 1, `return ${horizon}`)
    near(window.returnFromHit, horizonClose / event().price - 1, `path return ${horizon}`)
    near(outcome[`mfe${horizon}`], window.path!.maxUpsideToDate!, `mfe ${horizon}`)
    near(outcome[`mae${horizon}`], window.path!.maxDownsideToDate!, `mae ${horizon}`)
  }
  const missing = run(Array.from({ length: 25 }, () => ({ close: 95, low: 93 })), [5])
  assert.equal(missing.profile.elapsedTradingSessions, 25)
  assert.equal(missing.profile.horizonPaths[0].availability, false)
  assert.equal(missing.profile.horizonPaths[0].returnFromHit, null)
  assert.equal(missing.profile.longestConsecutiveBelowZoneSessions, 20)
  const delisted = run(Array.from({ length: 260 }, () => ({ close: 95, low: 93 })),
    Array.from({ length: 258 }, (_, index) => index + 3)).profile
  assert.equal(delisted.latestDate, day(2))
  assert.equal(delisted.elapsedTradingSessions, 260)
  assert.equal(delisted.horizonPaths.every((row) => !row.availability), true)
  assert.equal(averageTrueRange(Array.from({ length: 21 }, (_, i) => ({ date: day(i), close: 100, high: 102, low: 98 })), 20, 20), 4)
  console.log('Trigger Path fixtures: A-G, moving/fixed zone, ties, multiple breaches, ATR, 4 horizons, missing sessions PASS')
}

fixtures()

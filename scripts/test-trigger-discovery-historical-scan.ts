import assert from 'node:assert/strict'
import { execGet } from '@/lib/db/client'
import {
  deriveHistoricalScanEvents,
  getTriggerHistoricalScan,
} from '@/lib/server/trigger-discovery-historical-scan'
import { parseTriggerHistoricalScanRequest } from '@/lib/server/trigger-discovery-historical-scan-request'
import { getTriggerDiscovery, type TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import type { TriggerHistoricalScanCandidateSnapshot } from '@/lib/trigger-discovery-historical-scan-contract'
import { calculateTriggerScore } from '@/lib/trigger-score'

type SideEffects = {
  evaluations: number
  members: number
  lifecycle: number
  outbox: number
  deliveryAttempts: number
}

function score(status: 'APPROACHING' | 'NEAR' | 'IN_ZONE') {
  return calculateTriggerScore({
    triggerStatus: status,
    fromAbove: true,
    zoneDistancePct: status === 'IN_ZONE' ? 0 : status === 'NEAR' ? 1 : 4,
    maxApproachDistancePct: 5,
    approachVelocityPctPointsPerSession: 0.2,
    ma1SlopePct: 0.5,
    ma2SlopePct: 0.4,
    averageTradingValue: 100_000_000,
    dayAStage: 1, dayBStage: 1, weekAStage: 1,
    weekBStage: 1, monthAStage: 1, monthBStage: 1,
  })
}

function fixture(status: 'APPROACHING' | 'NEAR' | 'IN_ZONE'): TriggerHistoricalScanCandidateSnapshot {
  const calculated = score(status)
  return {
    ticker: 'TEST', companyName: 'Fixture', market: 'プライム',
    triggerStatus: status,
    triggerScore: calculated.totalScore,
    scoreBreakdown: calculated.scoreBreakdown,
    price: 100, ma1: 98, ma2: 96,
    zoneDistancePct: status === 'IN_ZONE' ? 0 : status === 'NEAR' ? 1 : 4,
    maSpreadPct: 2.083333333333333,
    maSpreadSlope: 0.4,
    maSpreadExpansionRatio: 0.75,
    spreadExpansionPass: true,
    spreadExpansionAvailable: true,
    bullishMaOrder: true,
    priceDate: '2026-01-01', maDate: '2026-01-01', stageDate: '2026-01-01',
    dayAStage: 1, dayBStage: 1, weekAStage: 1,
    weekBStage: 1, monthAStage: 1, monthBStage: 1,
  }
}

function rowProjection(row: TriggerDiscoveryRow) {
  return {
    ticker: row.ticker,
    triggerStatus: row.triggerStatus,
    triggerScore: row.triggerScore,
    price: row.price,
    ma1: row.ma1Value,
    ma2: row.ma2Value,
    zoneDistancePct: row.zoneDistancePct,
    stages: [row.dayAStage, row.dayBStage, row.weekAStage,
      row.weekBStage, row.monthAStage, row.monthBStage],
  }
}

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9
}

function assertRowsEqual(actual: TriggerDiscoveryRow[], expected: TriggerDiscoveryRow[], label: string): void {
  const actualByTicker = new Map(actual.map((row) => [row.ticker, row]))
  const expectedByTicker = new Map(expected.map((row) => [row.ticker, row]))
  assert.deepEqual([...actualByTicker.keys()].sort(), [...expectedByTicker.keys()].sort(), `${label} ticker set`)
  for (const [ticker, row] of actualByTicker) {
    const reference = expectedByTicker.get(ticker)!
    assert.equal(row.triggerStatus, reference.triggerStatus, `${label} ${ticker} status`)
    assert.equal(row.triggerScore, reference.triggerScore, `${label} ${ticker} score`)
    assert.ok(closeEnough(row.price, reference.price), `${label} ${ticker} price`)
    assert.ok(closeEnough(row.ma1Value, reference.ma1Value), `${label} ${ticker} MA1`)
    assert.ok(closeEnough(row.ma2Value, reference.ma2Value), `${label} ${ticker} MA2`)
    assert.ok(closeEnough(row.zoneDistancePct, reference.zoneDistancePct), `${label} ${ticker} zone distance`)
    assert.deepEqual(rowProjection(row).stages, rowProjection(reference).stages, `${label} ${ticker} Stage`)
  }
}

async function sideEffects(): Promise<SideEffects> {
  const row = await execGet<Record<string, number>>(`
    SELECT (SELECT COUNT(*) FROM trigger_evaluations) AS evaluations,
           (SELECT COUNT(*) FROM trigger_evaluation_members) AS members,
           (SELECT COUNT(*) FROM trigger_lifecycle_events) AS lifecycle,
           (SELECT COUNT(*) FROM notification_outbox) AS outbox,
           (SELECT COUNT(*) FROM notification_delivery_attempts) AS delivery_attempts
  `)
  return {
    evaluations: Number(row?.evaluations ?? 0),
    members: Number(row?.members ?? 0),
    lifecycle: Number(row?.lifecycle ?? 0),
    outbox: Number(row?.outbox ?? 0),
    deliveryAttempts: Number(row?.delivery_attempts ?? 0),
  }
}

function assertEventFixture(): void {
  const seen = new Set<string>()
  let previous: Map<string, TriggerHistoricalScanCandidateSnapshot> | null = null
  const eventTypes: string[] = []
  const days: Array<TriggerHistoricalScanCandidateSnapshot | null> = [
    fixture('NEAR'),
    fixture('NEAR'),
    fixture('IN_ZONE'),
    null,
    fixture('NEAR'),
  ]
  days.forEach((snapshot, index) => {
    const current = new Map(snapshot ? [[snapshot.ticker, snapshot]] : [])
    eventTypes.push(...deriveHistoricalScanEvents({
      date: `2026-01-0${index + 1}`,
      previous,
      current,
      seen,
    }).map((event) => event.eventType))
    previous = current
  })
  assert.deepEqual(eventTypes, ['STATUS_CHANGED', 'EXITED', 'RE_ENTRY'])

  const diagnosticEvent = deriveHistoricalScanEvents({
    date: '2026-01-02', previous: new Map(),
    current: new Map([['TEST', fixture('NEAR')]]), seen: new Set(),
  })[0]!
  assert.equal(diagnosticEvent.spreadExpansionPass, true)
  assert.equal(diagnosticEvent.spreadExpansionAvailable, true)
  assert.equal(diagnosticEvent.maSpreadExpansionRatio, 0.75)
  assert.equal(diagnosticEvent.spreadDiagnosticDate, '2026-01-01')
  const exited = deriveHistoricalScanEvents({
    date: '2026-01-03', previous: new Map([['TEST', fixture('NEAR')]]),
    current: new Map(), seen: new Set(['TEST']),
  })[0]!
  assert.equal(exited.snapshotBasis, 'PREVIOUS')
  assert.equal(exited.spreadDiagnosticDate, '2026-01-01')

  const introduced = new Map([['NEW', { ...fixture('APPROACHING'), ticker: 'NEW' }]])
  assert.deepEqual(
    deriveHistoricalScanEvents({
      date: '2026-01-02',
      previous: new Map(),
      current: introduced,
      seen: new Set(),
    }).map((event) => event.eventType),
    ['ENTERED'],
  )
}

async function compareSingleDay(
  date: string,
  timeframe: 'MONTHLY' | 'BIWEEKLY',
  spreadExpansionEnabled = false,
): Promise<{ matched: number; totalMs: number }> {
  let scanRows: TriggerDiscoveryRow[] = []
  const scan = await getTriggerHistoricalScan({
    requestedStartDate: date,
    requestedEndDate: date,
    timeframe,
    criteria: { triggerConfig: {
      ma1Period: 20,
      ma2Period: 25,
      spreadExpansionEnabled,
      spreadLookbackIntervals: 4,
      minExpansionRatio: 0.7,
      requireBullishMaOrder: true,
    } },
    eventOffset: 0,
    eventLimit: 100,
  }, { onDay: (_day, rows) => { scanRows = rows } })
  const single = await getTriggerDiscovery({
    asOf: date,
    triggerConfig: {
      ma1Period: 20,
      ma2Period: 25,
      spreadExpansionEnabled,
      spreadLookbackIntervals: 4,
      minExpansionRatio: 0.7,
      requireBullishMaOrder: true,
    },
    limit: 10_000,
  }, { timeframe })
  assert.equal(scan.scanMeta.resolvedStartDate, single.resolvedAsOf)
  assert.equal(scan.scanMeta.baselineCandidateCount, single.totalMatched)
  assert.equal(scan.summary.totalEventCount, 0, 'first scan day is a baseline')
  assertRowsEqual(scanRows, single.rows, `${timeframe} ${date}`)
  return { matched: scanRows.length, totalMs: scan.performance.totalMs }
}

async function compareSpreadPeriodWithSingleDays(): Promise<{
  tradingDays: number
  firstDate: string
  lastDate: string
}> {
  const rowsByDate = new Map<string, TriggerDiscoveryRow[]>()
  const triggerConfig = {
    ma1Period: 20,
    ma2Period: 25,
    spreadExpansionEnabled: true,
    spreadLookbackIntervals: 4,
    minExpansionRatio: 0.7,
    requireBullishMaOrder: true,
  }
  const scan = await getTriggerHistoricalScan({
    requestedStartDate: '2026-08-03',
    requestedEndDate: '2026-08-31',
    timeframe: 'MONTHLY',
    criteria: { triggerConfig },
    eventOffset: 0,
    eventLimit: 10,
  }, { onDay: (date, rows) => { rowsByDate.set(date, rows) } })
  const dates = scan.dailyCounts.map((day) => day.date)
  assert.ok(dates.length >= 20, 'Spread parity audit requires at least 20 trading days')
  for (const date of dates) {
    const single = await getTriggerDiscovery({
      asOf: date,
      triggerConfig,
      limit: 10_000,
    }, { timeframe: 'MONTHLY' })
    assert.equal(single.resolvedAsOf, date, `${date}: single-day Spread PIT resolution`)
    assertRowsEqual(rowsByDate.get(date) ?? [], single.rows, `MONTHLY Spread period parity ${date}`)
  }
  return {
    tradingDays: dates.length,
    firstDate: dates[0],
    lastDate: dates.at(-1)!,
  }
}

async function compareSparseMonthlyHistory(): Promise<void> {
  const rowsByDate = new Map<string, TriggerDiscoveryRow[]>()
  const scan = await getTriggerHistoricalScan({
    requestedStartDate: '2025-02-27',
    requestedEndDate: '2025-03-04',
    timeframe: 'MONTHLY',
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 10,
  }, { onDay: (date, rows) => { rowsByDate.set(date, rows) } })
  for (const date of ['2025-02-28', '2025-03-03', '2025-03-04']) {
    const single = await getTriggerDiscovery({ asOf: date, limit: 10_000 }, { timeframe: 'MONTHLY' })
    assert.equal(scan.dailyCounts.find((day) => day.date === date)?.candidateCount, single.totalMatched)
    assertRowsEqual(rowsByDate.get(date) ?? [], single.rows, `sparse monthly history ${date}`)
  }
  assert.ok(rowsByDate.get('2025-02-28')?.some((row) => row.ticker === '2523'))
  assert.ok(rowsByDate.get('2025-02-28')?.some((row) => row.ticker === '1479'))
  assert.ok(rowsByDate.get('2025-03-03')?.some((row) => row.ticker === '2560'))
}

async function main() {
  const before = await sideEffects()
  assertEventFixture()

  const parsed = parseTriggerHistoricalScanRequest({
    startDate: '2026-08-22',
    endDate: '2026-08-25',
    timeframe: 'BIWEEKLY',
    ma1Period: 20,
    ma2Period: 25,
    eventOffset: 10,
    eventLimit: 25,
  })
  assert.equal(parsed.timeframe, 'BIWEEKLY')
  assert.equal(parsed.eventOffset, 10)
  assert.equal(parsed.eventLimit, 25)
  assert.throws(() => parseTriggerHistoricalScanRequest({
    startDate: '2026-08-26', endDate: '2026-08-25',
  }), /startDate/)
  assert.throws(() => parseTriggerHistoricalScanRequest({
    startDate: 'invalid', endDate: '2026-08-25',
  }), /YYYY-MM-DD/)
  assert.throws(() => parseTriggerHistoricalScanRequest({
    startDate: '2026-08-24', endDate: '2026-08-25', eventLimit: 5_001,
  }), /eventLimit/)

  await assert.rejects(() => getTriggerHistoricalScan({
    requestedStartDate: '2024-01-01',
    requestedEndDate: '2026-09-11',
    timeframe: 'MONTHLY',
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 10,
  }), /at most 520 trading days/)

  const monthly = await compareSingleDay('2026-08-25', 'MONTHLY')
  const biweekly = await compareSingleDay('2026-08-25', 'BIWEEKLY')
  const monthlySpread = await compareSingleDay('2026-08-25', 'MONTHLY', true)
  const biweeklySpread = await compareSingleDay('2026-08-25', 'BIWEEKLY', true)
  await compareSparseMonthlyHistory()
  const spreadPeriodParity = process.env.SPREAD_PERIOD_PARITY === '1'
    ? await compareSpreadPeriodWithSingleDays()
    : null

  const fiveDay = await getTriggerHistoricalScan({
    requestedStartDate: '2026-08-24',
    requestedEndDate: '2026-08-28',
    timeframe: 'MONTHLY',
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 25,
  })
  assert.equal(fiveDay.scanMeta.tradingDayCount, 5)
  assert.equal(fiveDay.dailyCounts.length, 5)
  assert.equal(fiveDay.dailyCounts[0].date, '2026-08-24')
  assert.equal(fiveDay.dailyCounts.at(-1)?.date, '2026-08-28')
  assert.equal(fiveDay.eventPage.totalCount, fiveDay.summary.totalEventCount)

  const weekend = await getTriggerHistoricalScan({
    requestedStartDate: '2026-08-22',
    requestedEndDate: '2026-08-25',
    timeframe: 'MONTHLY',
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 10,
  })
  assert.equal(weekend.scanMeta.resolvedStartDate, '2026-08-24')
  assert.equal(weekend.scanMeta.resolvedEndDate, '2026-08-25')

  const future = await getTriggerHistoricalScan({
    requestedStartDate: '2999-01-01',
    requestedEndDate: '2999-01-05',
    timeframe: 'MONTHLY',
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 10,
  })
  assert.equal(future.scanMeta.tradingDayCount, 0)
  assert.equal(future.events.length, 0)

  const latest = await execGet<{ date: string }>('SELECT MAX(date) AS date FROM ohlcv_daily')
  assert.ok(latest?.date)
  const futureEnd = await getTriggerHistoricalScan({
    requestedStartDate: latest!.date,
    requestedEndDate: '2999-01-05',
    timeframe: 'MONTHLY',
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 10,
  })
  assert.equal(futureEnd.scanMeta.resolvedStartDate, latest!.date)
  assert.equal(futureEnd.scanMeta.resolvedEndDate, latest!.date)
  assert.equal(futureEnd.scanMeta.tradingDayCount, 1)

  if (process.env.HISTORICAL_SCAN_EXTENDED === '1') {
    for (const [label, startDate, endDate, timeframe] of [
      ['one-month', '2026-08-01', '2026-08-31', 'MONTHLY'],
      ['three-month', '2026-06-01', '2026-08-31', 'MONTHLY'],
      ['three-month-biweekly', '2026-06-01', '2026-08-31', 'BIWEEKLY'],
    ] as const) {
      const result = await getTriggerHistoricalScan({
        requestedStartDate: startDate, requestedEndDate: endDate, timeframe,
        criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
        eventOffset: 0, eventLimit: 10,
      })
      assert.ok(result.scanMeta.tradingDayCount > 0, label)
      assert.equal(result.dailyCounts.length, result.scanMeta.tradingDayCount, label)
    }
  }

  const after = await sideEffects()
  assert.deepEqual(after, before, 'Historical scan must remain read-only')
  console.log(JSON.stringify({ monthly, biweekly, monthlySpread, biweeklySpread, spreadPeriodParity, fiveDay: fiveDay.summary,
    weekend: weekend.scanMeta, sideEffectsBefore: before, sideEffectsAfter: after }, null, 2))
  console.log('Trigger Discovery historical period scan tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

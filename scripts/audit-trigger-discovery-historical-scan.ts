import assert from 'node:assert/strict'
import { execAll, execGet } from '@/lib/db/client'
import { getTriggerHistoricalScan } from '@/lib/server/trigger-discovery-historical-scan'
import { getTriggerDiscovery, type TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'
import { calendarWeekBucket } from '@/lib/timeframes'

type SideEffects = {
  evaluations: number
  members: number
  lifecycle: number
  outbox: number
  deliveryAttempts: number
}

const RANGE_START = '2025-09-01'
const RANGE_END = '2026-08-31'

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

function closeEnough(left: number, right: number): boolean {
  return Math.abs(left - right) <= Math.max(1, Math.abs(left), Math.abs(right)) * 1e-9
}

function assertRowsEqual(actual: TriggerDiscoveryRow[], expected: TriggerDiscoveryRow[], label: string): void {
  const actualByTicker = new Map(actual.map((row) => [row.ticker, row]))
  const expectedByTicker = new Map(expected.map((row) => [row.ticker, row]))
  assert.deepEqual([...actualByTicker.keys()].sort(), [...expectedByTicker.keys()].sort(), `${label}: ticker set`)
  for (const [ticker, row] of actualByTicker) {
    const reference = expectedByTicker.get(ticker)!
    assert.equal(row.triggerStatus, reference.triggerStatus, `${label}: ${ticker} status`)
    assert.equal(row.triggerScore, reference.triggerScore, `${label}: ${ticker} score`)
    assert.ok(closeEnough(row.price, reference.price), `${label}: ${ticker} price`)
    assert.ok(closeEnough(row.ma1Value, reference.ma1Value), `${label}: ${ticker} MA1`)
    assert.ok(closeEnough(row.ma2Value, reference.ma2Value), `${label}: ${ticker} MA2`)
    assert.ok(closeEnough(row.zoneDistancePct, reference.zoneDistancePct), `${label}: ${ticker} zone distance`)
    assert.deepEqual(
      [row.dayAStage, row.dayBStage, row.weekAStage, row.weekBStage, row.monthAStage, row.monthBStage],
      [reference.dayAStage, reference.dayBStage, reference.weekAStage,
        reference.weekBStage, reference.monthAStage, reference.monthBStage],
      `${label}: ${ticker} Stage`,
    )
  }
}

function boundaryDates(dates: string[], keyOf: (date: string) => string | number): string[] {
  const transitions: Array<[string, string]> = []
  for (let index = 1; index < dates.length; index += 1) {
    if (keyOf(dates[index - 1]) !== keyOf(dates[index])) {
      transitions.push([dates[index - 1], dates[index]])
    }
  }
  assert.ok(transitions.length >= 5, 'at least five period boundaries are required')
  const selected = new Set<string>()
  for (let index = 0; index < 5; index += 1) {
    const transitionIndex = Math.round(index * (transitions.length - 1) / 4)
    selected.add(transitions[transitionIndex][0])
    selected.add(transitions[transitionIndex][1])
  }
  assert.equal(selected.size, 10)
  return [...selected].sort()
}

async function crossCheck(
  timeframe: TriggerDiscoveryTimeframe,
  selectedDates: string[],
): Promise<Record<string, unknown>> {
  const selected = new Set(selectedDates)
  const scanRowsByDate = new Map<string, TriggerDiscoveryRow[]>()
  let stageMissingRows = 0
  let listingBoundaryViolations = 0
  const membershipRows = await execAll<{
    ticker: string
    first_trade_date: string | null
    last_trade_date: string | null
    latest_ohlcv_date: string | null
  }>(`SELECT ticker, first_trade_date, last_trade_date, latest_ohlcv_date FROM historical_universe`)
  const membershipByTicker = new Map(membershipRows.map((row) => [row.ticker, row]))
  const scan = await getTriggerHistoricalScan({
    requestedStartDate: RANGE_START,
    requestedEndDate: RANGE_END,
    timeframe,
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 1,
  }, {
    onDay: (date, rows) => {
      if (selected.has(date)) scanRowsByDate.set(date, rows)
      for (const row of rows) {
        if (!row.stageAvailable) stageMissingRows += 1
        const membership = membershipByTicker.get(row.ticker)
        if (!membership?.first_trade_date || !membership.last_trade_date
          || !membership.latest_ohlcv_date) continue
        if (date < membership.first_trade_date
          || (date <= membership.latest_ohlcv_date && date > membership.last_trade_date)) {
          listingBoundaryViolations += 1
        }
      }
    },
  })
  assert.equal(listingBoundaryViolations, 0, `${timeframe}: listing period boundary`)
  assert.equal(scanRowsByDate.size, selectedDates.length, `${timeframe}: selected scan dates captured`)

  const comparisons: Array<Record<string, unknown>> = []
  for (const date of selectedDates) {
    const single = await getTriggerDiscovery({
      asOf: date,
      triggerConfig: { ma1Period: 20, ma2Period: 25 },
      limit: 10_000,
    }, { timeframe })
    const scanRows = scanRowsByDate.get(date)!
    assert.equal(single.resolvedAsOf, date, `${timeframe} ${date}: single-day resolution`)
    assertRowsEqual(scanRows, single.rows, `${timeframe} ${date}`)
    comparisons.push({ date, candidates: scanRows.length })
  }
  return {
    timeframe,
    selectedDates,
    comparisons,
    stageMissingRows,
    listingBoundaryViolations,
    scanPerformance: scan.performance,
  }
}

async function benchmark(
  label: string,
  startDate: string,
  endDate: string,
  timeframe: TriggerDiscoveryTimeframe,
): Promise<Record<string, unknown>> {
  const response = await getTriggerHistoricalScan({
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    timeframe,
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25 } },
    eventOffset: 0,
    eventLimit: 1,
  })
  return {
    label,
    scanMeta: response.scanMeta,
    summary: response.summary,
    performance: response.performance,
  }
}

async function main() {
  const before = await sideEffects()
  const dates = (await execAll<{ date: string }>(`
    SELECT DISTINCT date FROM ohlcv_daily
    WHERE date BETWEEN ? AND ? ORDER BY date
  `, [RANGE_START, RANGE_END])).map((row) => row.date)
  const monthlyDates = boundaryDates(dates, (date) => date.slice(0, 7))
  const biweeklyDates = boundaryDates(dates, (date) => Math.floor(calendarWeekBucket(date) / 2))

  const mode = process.env.HISTORICAL_SCAN_AUDIT_MODE ?? 'all'
  const output: Record<string, unknown> = { mode, before }
  if (mode === 'all' || mode === 'cross-check') {
    output.monthlyCrossCheck = await crossCheck('MONTHLY', monthlyDates)
    output.biweeklyCrossCheck = await crossCheck('BIWEEKLY', biweeklyDates)
  }
  if (mode === 'all' || mode === 'benchmark') {
    const requestedCase = process.env.HISTORICAL_SCAN_BENCHMARK_CASE
    const cases = [
      ['monthly-3m', '2026-06-01', '2026-08-31', 'MONTHLY'],
      ['monthly-1y', RANGE_START, RANGE_END, 'MONTHLY'],
      ['biweekly-3m', '2026-06-01', '2026-08-31', 'BIWEEKLY'],
      ['biweekly-1y', RANGE_START, RANGE_END, 'BIWEEKLY'],
      ['biweekly-2y', '2024-09-01', RANGE_END, 'BIWEEKLY'],
    ] as const
    output.benchmarks = []
    for (const [label, startDate, endDate, timeframe] of cases) {
      if (requestedCase && requestedCase !== label) continue
      ;(output.benchmarks as Array<Record<string, unknown>>).push(
        await benchmark(label, startDate, endDate, timeframe),
      )
    }
  }
  const after = await sideEffects()
  assert.deepEqual(after, before, 'historical scan audit must not write Trigger or notification tables')
  output.after = after
  console.log(JSON.stringify(output, null, 2))
  console.log('Trigger Discovery period historical scan audit passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

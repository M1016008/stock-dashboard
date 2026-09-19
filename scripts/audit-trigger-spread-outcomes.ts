import assert from 'node:assert/strict'
import { execAll } from '@/lib/db/client'
import { buildContinuousMonthlyMaSeries } from '@/lib/snapshots/continuous-ma'
import { getTriggerHistoricalScan } from '@/lib/server/trigger-discovery-historical-scan'
import {
  aggregateOutcomeRows,
  calculateEventOutcome,
  type OutcomeOhlcvRow,
} from '@/lib/server/trigger-discovery-outcome-analysis'
import { spreadBucketForOutcomeRow } from '@/lib/server/trigger-discovery-outcome-segmentation'
import type { TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import type { TriggerHistoricalScanEvent } from '@/lib/trigger-discovery-historical-scan-contract'
import { TRIGGER_OUTCOME_HORIZONS, type TriggerOutcomeRow } from '@/lib/trigger-discovery-outcome-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'
import type { OHLCV } from '@/types/stock'

const START = '2025-02-03'
const END = '2025-05-02'
const SOURCE_FIELDS = [
  'spreadExpansionPass', 'spreadExpansionAvailable', 'bullishMaOrder',
  'maSpreadPct', 'maSpreadSlope', 'maSpreadExpansionRatio', 'spreadDiagnosticDate',
] as const

function selectors(event: TriggerHistoricalScanEvent): 'NEAR' | 'ZONE' | null {
  if (event.eventType !== 'STATUS_CHANGED') return null
  return event.currentStatus === 'NEAR' ? 'NEAR'
    : event.currentStatus === 'IN_ZONE' ? 'ZONE' : null
}

function signedSlope(values: number[]): number {
  const midpoint = (values.length - 1) / 2
  const average = values.reduce((sum, value) => sum + value, 0) / values.length
  const numerator = values.reduce((sum, value, index) => sum + (index - midpoint) * (value - average), 0)
  const denominator = values.reduce((sum, _, index) => sum + (index - midpoint) ** 2, 0)
  return numerator / denominator
}

function close(actual: number | null | undefined, expected: number, label: string): void {
  assert.ok(actual != null && Math.abs(actual - expected) <= Math.max(1, Math.abs(expected)) * 1e-8,
    `${label}: ${actual} != ${expected}`)
}

async function auditMonthlyEventDiagnostics(events: TriggerHistoricalScanEvent[]): Promise<number> {
  const selected = events.filter((event) => event.snapshotBasis === 'CURRENT'
    && event.spreadExpansionAvailable && selectors(event)).slice(0, 30)
  assert.equal(selected.length, 30, 'at least 30 current NEAR/Zone events are required')
  for (const event of selected) {
    const daily = await execAll<{ date: string; close: number; volume: number }>(
      'SELECT date,close,volume FROM ohlcv_daily WHERE ticker=? AND date<=? ORDER BY date',
      [event.ticker, event.date],
    )
    const candles: OHLCV[] = daily.map((row) => ({
      date: row.date, open: row.close, high: row.close, low: row.close,
      close: row.close, volume: row.volume,
    }))
    const points = buildContinuousMonthlyMaSeries(candles, [20, 25], { adjustSplits: false })
      .flatMap((point) => {
        const ma1 = point.values.get(20)
        const ma2 = point.values.get(25)
        return ma1 == null || ma2 == null ? [] : [{ date: point.date, ma1, ma2 }]
      }).filter((point) => point.date <= event.date)
    const recent = points.slice(-21)
    assert.equal(recent.at(-1)?.date, event.spreadDiagnosticDate, `${event.ticker} ${event.date} PIT MA date`)
    const spread = recent.slice(-5).map((point) => (point.ma1 - point.ma2) / point.ma2 * 100)
    assert.equal(spread.length, 5)
    const slope = signedSlope(spread)
    const tolerance = Math.max(1e-9, 0.01 / 4)
    const ratio = spread.slice(1).filter((value, index) => value - spread[index] > tolerance).length / 4
    const current = recent.at(-1)!
    const prior = recent[0]!
    const rising = (current.ma1 / prior.ma1 - 1) * 100 > 0.01
      && (current.ma2 / prior.ma2 - 1) * 100 > 0.01
    const bullish = current.ma1 - current.ma2 > 1e-9 * Math.max(1, Math.abs(current.ma1), Math.abs(current.ma2))
    const pass = rising && bullish && slope > tolerance && ratio + 1e-9 >= 0.7
    close(event.maSpreadPct, spread.at(-1)!, `${event.ticker} spread`)
    close(event.maSpreadSlope, slope, `${event.ticker} slope`)
    close(event.maSpreadExpansionRatio, ratio, `${event.ticker} ratio`)
    assert.equal(event.bullishMaOrder, bullish, `${event.ticker} bullish`)
    assert.equal(event.spreadExpansionPass, pass, `${event.ticker} pass`)
  }
  return selected.length
}

async function scan(timeframe: TriggerDiscoveryTimeframe, enabled: boolean, start = START, end = END) {
  const events: TriggerHistoricalScanEvent[] = []
  const candidatesByDay = new Map<string, Set<string>>()
  const candidateRowsByDay = new Map<string, Map<string, TriggerDiscoveryRow>>()
  const result = await getTriggerHistoricalScan({
    requestedStartDate: start, requestedEndDate: end, timeframe,
    criteria: { triggerConfig: { ma1Period: 20, ma2Period: 25,
      spreadExpansionEnabled: enabled, spreadLookbackIntervals: 4,
      minExpansionRatio: 0.7, requireBullishMaOrder: true } },
    eventOffset: 0, eventLimit: 0,
  }, {
    onDay: (date, rows: TriggerDiscoveryRow[]) => {
      candidatesByDay.set(date, new Set(rows.map((row) => row.ticker)))
      candidateRowsByDay.set(date, new Map(rows.map((row) => [row.ticker, row])))
    },
    onEvents: (_date, batch) => { events.push(...batch) },
  })
  assert.equal(events.length, result.summary.totalEventCount)
  const oldBytes = Buffer.byteLength(events.map((event) => JSON.stringify(
    Object.fromEntries(Object.entries(event).filter(([key]) => !SOURCE_FIELDS.includes(key as typeof SOURCE_FIELDS[number]))),
  )).join('\n'))
  const newBytes = Buffer.byteLength(events.map((event) => JSON.stringify(event)).join('\n'))
  return { result, events, candidatesByDay, candidateRowsByDay,
    artifactBytes: { oldBytes, newBytes, increaseBytes: newBytes - oldBytes } }
}

async function outcomes(events: TriggerHistoricalScanEvent[]): Promise<TriggerOutcomeRow[]> {
  if (events.length === 0) return []
  const marketSessions = (await execAll<{ date: string }>(
    'SELECT DISTINCT date FROM ohlcv_daily WHERE date BETWEEN ? AND ? ORDER BY date',
    [events[0]!.date, '2026-09-18'],
  )).map((row) => row.date)
  const byTicker = new Map<string, TriggerHistoricalScanEvent[]>()
  for (const event of events) {
    const batch = byTicker.get(event.ticker) ?? []
    batch.push(event)
    byTicker.set(event.ticker, batch)
  }
  const rows: TriggerOutcomeRow[] = []
  const tickers = [...byTicker.keys()]
  for (let index = 0; index < tickers.length; index += 100) {
    const batch = tickers.slice(index, index + 100)
    const sqlRows = await execAll<OutcomeOhlcvRow>(`SELECT ticker,date,high,low,close FROM ohlcv_daily
      WHERE ticker IN (${batch.map(() => '?').join(',')}) AND date BETWEEN ? AND ? ORDER BY ticker,date`,
    [...batch, events[0]!.date, '2026-09-18'])
    const series = new Map<string, OutcomeOhlcvRow[]>()
    for (const row of sqlRows) {
      const values = series.get(row.ticker) ?? []
      values.push(row)
      series.set(row.ticker, values)
    }
    for (const ticker of batch) {
      for (const event of byTicker.get(ticker) ?? []) {
        rows.push(calculateEventOutcome(event, series.get(ticker) ?? [], TRIGGER_OUTCOME_HORIZONS, marketSessions))
      }
    }
  }
  return rows
}

function summarize(rows: TriggerOutcomeRow[]) {
  const grouped = Object.fromEntries((['PASS', 'FAIL', 'UNKNOWN'] as const).map((bucket) => {
    const selected = rows.filter((row) => spreadBucketForOutcomeRow(row) === bucket)
    return [bucket, {
      eventCount: selected.length,
      uniqueTickerCount: new Set(selected.map((row) => row.ticker)).size,
      horizons: aggregateOutcomeRows(selected, TRIGGER_OUTCOME_HORIZONS),
    }]
  }))
  assert.equal(Object.values(grouped).reduce((sum, value) => sum + value.eventCount, 0), rows.length)
  return grouped
}

async function main() {
  const report: Record<string, unknown> = {}
  for (const timeframe of ['MONTHLY', 'BIWEEKLY'] as const) {
    const off = await scan(timeframe, false)
    const on = await scan(timeframe, true)
    let unchangedCandidateRows = 0
    for (const [date, onTickers] of on.candidatesByDay) {
      const offTickers = off.candidatesByDay.get(date)
      assert.ok(offTickers, `${timeframe} ${date} OFF candidates missing`)
      for (const ticker of onTickers) {
        assert.ok(offTickers!.has(ticker), `${timeframe} ${date} ${ticker} subset`)
        const offRow: TriggerDiscoveryRow | undefined = off.candidateRowsByDay.get(date)?.get(ticker)
        const onRow: TriggerDiscoveryRow | undefined = on.candidateRowsByDay.get(date)?.get(ticker)
        assert.ok(offRow && onRow)
        assert.equal(onRow.triggerScore, offRow.triggerScore, `${timeframe} ${date} ${ticker} Score`)
        assert.deepEqual(onRow.scoreBreakdown, offRow.scoreBreakdown, `${timeframe} ${date} ${ticker} Score breakdown`)
        assert.deepEqual([
          onRow.dayAStage, onRow.dayBStage, onRow.weekAStage, onRow.weekBStage,
          onRow.monthAStage, onRow.monthBStage,
        ], [
          offRow.dayAStage, offRow.dayBStage, offRow.weekAStage, offRow.weekBStage,
          offRow.monthAStage, offRow.monthBStage,
        ], `${timeframe} ${date} ${ticker} Stage`)
        assert.equal(onRow.triggerStatus, offRow.triggerStatus, `${timeframe} ${date} ${ticker} Status`)
        assert.equal(onRow.ma1Value, offRow.ma1Value, `${timeframe} ${date} ${ticker} MA1`)
        assert.equal(onRow.ma2Value, offRow.ma2Value, `${timeframe} ${date} ${ticker} MA2`)
        assert.equal(onRow.zoneDistancePct, offRow.zoneDistancePct, `${timeframe} ${date} ${ticker} Zone distance`)
        unchangedCandidateRows += 1
      }
    }
    const sourceEvents = off.events.filter((event) => selectors(event))
    const onEvents = on.events.filter((event) => selectors(event))
    const sourceOutcome = await outcomes(sourceEvents)
    const operationalOutcome = await outcomes(onEvents)
    for (const event of sourceEvents) assert.ok(event.spreadDiagnosticDate == null || event.spreadDiagnosticDate <= event.date)
    const diagnosticsChecked = timeframe === 'MONTHLY' ? await auditMonthlyEventDiagnostics(sourceEvents) : 0
    report[timeframe] = {
      period: [START, END],
      primaryAnalysisType: 'CONDITIONED_EVENT_COMPARISON',
      secondaryAnalysisType: 'OPERATIONAL_SCAN_COMPARISON',
      offScan: { candidates: off.result.summary.uniqueCandidateCount, events: off.result.summary.totalEventCount,
        near: off.events.filter((event) => selectors(event) === 'NEAR').length,
        zone: off.events.filter((event) => selectors(event) === 'ZONE').length },
      onScan: { candidates: on.result.summary.uniqueCandidateCount, events: on.result.summary.totalEventCount,
        near: on.events.filter((event) => selectors(event) === 'NEAR').length,
        zone: on.events.filter((event) => selectors(event) === 'ZONE').length },
      primary: Object.fromEntries((['NEAR', 'ZONE'] as const).map((selector) => [selector,
        summarize(sourceOutcome.filter((row) => (row.currentStatus === 'NEAR' ? 'NEAR' : 'ZONE') === selector))])),
      secondary: Object.fromEntries((['NEAR', 'ZONE'] as const).map((selector) => [selector,
        aggregateOutcomeRows(operationalOutcome.filter((row) => (row.currentStatus === 'NEAR' ? 'NEAR' : 'ZONE') === selector), TRIGGER_OUTCOME_HORIZONS)])),
      diagnosticsChecked,
      unchangedCandidateRows,
      performanceMs: { off: off.result.performance.totalMs, on: on.result.performance.totalMs },
      artifactBytes: off.artifactBytes,
    }
  }
  if (process.env.SPREAD_AUDIT_ONE_YEAR === '1') {
    const yearly = await scan('MONTHLY', false, '2024-01-04', '2024-12-30')
    report.monthlyOneYear = { performanceMs: yearly.result.performance.totalMs,
      eventCount: yearly.events.length, artifactBytes: yearly.artifactBytes }
  }
  if (process.env.SPREAD_AUDIT_COMPACT === '1') {
    const compact = Object.fromEntries(Object.entries(report).map(([key, value]) => {
      if (key === 'monthlyOneYear') return [key, value]
      const entry = value as {
        offScan: unknown; onScan: unknown; diagnosticsChecked: number; unchangedCandidateRows: number
        performanceMs: unknown; artifactBytes: unknown
        primary: Record<string, Record<string, { eventCount: number; uniqueTickerCount: number; horizons: ReturnType<typeof aggregateOutcomeRows> }>>
        secondary: Record<string, ReturnType<typeof aggregateOutcomeRows>>
      }
      const primary = Object.fromEntries(Object.entries(entry.primary).map(([selector, groups]) => [selector,
        Object.fromEntries(Object.entries(groups).map(([bucket, group]) => [bucket, {
          eventCount: group.eventCount,
          uniqueTickerCount: group.uniqueTickerCount,
          horizons: group.horizons.map((horizon) => ({
            sessions: horizon.horizonSessions,
            eligible: horizon.eligibleCount,
            median: horizon.medianReturn,
            mean: horizon.meanReturn,
            positive: horizon.positiveReturnRatio,
            q25: horizon.p25Return,
            q75: horizon.p75Return,
            mfe: horizon.medianMfe,
            mae: horizon.medianMae,
          })),
        }])),
      ]))
      return [key, { offScan: entry.offScan, onScan: entry.onScan, primary,
        secondary: Object.fromEntries(Object.entries(entry.secondary).map(([selector, horizons]) => [selector,
          horizons.map((horizon) => ({ sessions: horizon.horizonSessions,
            eventCount: horizon.totalSelectedEvents, eligible: horizon.eligibleCount,
            median: horizon.medianReturn, positive: horizon.positiveReturnRatio }))])),
        diagnosticsChecked: entry.diagnosticsChecked,
        unchangedCandidateRows: entry.unchangedCandidateRows,
        performanceMs: entry.performanceMs,
        artifactBytes: entry.artifactBytes }]
    }))
    console.log(JSON.stringify(compact))
  } else console.log(JSON.stringify(report))
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })

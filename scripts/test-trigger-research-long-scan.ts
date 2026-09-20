import assert from 'node:assert/strict'
import { runResearchLongScan } from '@/lib/server/trigger-research-long-scan'
import type { TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import type { TriggerHistoricalScanEvent, TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'

const days = ['2024-01-04', '2024-01-05', '2024-01-09', '2024-01-10', '2024-01-11']
const members = [
  [['A', 'APPROACHING']],
  [['A', 'NEAR'], ['B', 'APPROACHING']],
  [['A', 'NEAR'], ['B', 'APPROACHING']],
  [['B', 'IN_ZONE']],
  [['A', 'NEAR'], ['B', 'IN_ZONE']],
] as const

function row(ticker: string, status: TriggerDiscoveryRow['triggerStatus'], date: string): TriggerDiscoveryRow {
  return {
    ticker, companyName: ticker, market: 'プライム', triggerStatus: status,
    triggerScore: 50, scoreBreakdown: { proximity: 0, approach: 0, maTrend: 0, stageStructure: 0, liquidity: 0 },
    price: 100, ma1Value: 95, ma2Value: 90, zoneDistancePct: 1,
    priceDate: date, maDate: date, stageDate: date,
    dayAStage: 1, dayBStage: 2, weekAStage: 3, weekBStage: 4, monthAStage: 5, monthBStage: 6,
  } as TriggerDiscoveryRow
}

const fakeScan = (async (input: { requestedStartDate: string; requestedEndDate: string },
  options: { onDay?: (date: string, rows: TriggerDiscoveryRow[]) => Promise<void> | void }) => {
  const selected = days.filter((date) => date >= input.requestedStartDate && date <= input.requestedEndDate)
  for (const date of selected) {
    const index = days.indexOf(date)
    await options.onDay?.(date, members[index].map(([ticker, status]) => row(ticker, status, date)))
  }
  return {
    scanMeta: { resolvedStartDate: selected[0], resolvedEndDate: selected.at(-1),
      tradingDayCount: selected.length },
    dailyCounts: selected.map((date) => ({ date,
      candidateCount: members[days.indexOf(date)].length,
      approachingCount: 0, nearCount: 0, inZoneCount: 0 })),
    performance: { totalMs: 1, queryCount: 6, tradingDays: selected.length,
      sourceTickerCount: 2, sourceRows: { ohlcv: 2, storedMonthlyMa: 0, weeklyOhlcv: 0, stage: 2 },
      sqlMs: { marketSessions: 0, universe: 0, ohlcv: 0, storedMonthlyMa: 0,
        weeklyOhlcv: 0, stage: 0, total: 0 },
      seriesBuildMs: 0, maPreparationMs: 0, liquidityMs: 0, universeFilterMs: 0,
      triggerEngineMs: 0, stageJoinMs: 0, scoreMs: 0, eventDerivationMs: 0,
      peakHeapBytes: 1, peakRssBytes: 1, heapDeltaBytes: 0 },
  } as TriggerHistoricalScanResponse
}) as typeof import('@/lib/server/trigger-discovery-historical-scan').getTriggerHistoricalScan

async function run(chunkSessions: number) {
  const events: TriggerHistoricalScanEvent[] = []
  const result = await runResearchLongScan({
    request: { startDate: days[0], endDate: days.at(-1)!, timeframe: 'MONTHLY',
      ma1Period: 20, ma2Period: 25 },
    sessions: days, chunkSessions, scan: fakeScan,
    onEvents: (_date, rows) => { events.push(...rows) },
  })
  return { ...result, events }
}

async function main() {
  const whole = await run(5)
  const chunks = await run(2)
  assert.deepEqual(chunks.events, whole.events)
  assert.deepEqual(chunks.response.dailyCounts, whole.response.dailyCounts)
  assert.equal(chunks.response.scanMeta.baselineCandidateCount, 1)
  assert.equal(chunks.response.summary.uniqueCandidateCount, 2)
  assert.deepEqual(chunks.events.map((event) => [event.date, event.ticker, event.eventType]), [
    ['2024-01-05', 'A', 'STATUS_CHANGED'],
    ['2024-01-05', 'B', 'ENTERED'],
    ['2024-01-10', 'A', 'EXITED'],
    ['2024-01-10', 'B', 'STATUS_CHANGED'],
    ['2024-01-11', 'A', 'RE_ENTRY'],
  ])
  assert.deepEqual(chunks.chunkRanges, [
    ['2024-01-04', '2024-01-05'], ['2024-01-09', '2024-01-10'], ['2024-01-11', '2024-01-11'],
  ])
  await assert.rejects(() => runResearchLongScan({
    request: { startDate: days[0], endDate: days.at(-1)! },
    sessions: [days[0], days[0]], chunkSessions: 1, scan: fakeScan,
    onEvents: () => undefined,
  }), /invalid_research_sessions/)
  console.log('research chunk continuity PASS')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })

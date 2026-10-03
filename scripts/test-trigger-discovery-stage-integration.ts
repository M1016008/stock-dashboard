import assert from 'node:assert/strict'
import {
  getTriggerDiscovery,
  sortTriggerDiscoveryRows,
  type TriggerDiscoveryCandidateSnapshot,
  type TriggerDiscoveryDataSource,
  type TriggerDiscoveryFilteredCandidate,
  type TriggerDiscoveryStageSnapshot,
} from '@/lib/server/trigger-discovery-read-model'
import type { MaZoneTriggerObservation } from '@/lib/trigger-discovery-engine'

const AS_OF = '2026-09-04'
const SESSIONS = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(`${AS_OF}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - index)
  return date.toISOString().slice(0, 10)
})

function observations(): MaZoneTriggerObservation[] {
  return [...SESSIONS].reverse().slice(-24).map((date, index) => {
    const ma1 = 100 + index * 0.25
    const ma2 = 96 + index * 0.2
    const distance = 6 - index * 0.21
    return { date, price: ma1 * (1 + distance / 100), ma1, ma2 }
  })
}

const candidates: TriggerDiscoveryCandidateSnapshot[] = ['1001', '1002', '1003'].map((ticker) => ({
  ticker,
  companyName: ticker,
  market: 'プライム',
  priceDate: AS_OF,
  price: observations().at(-1)!.price,
  averageVolume: 1_000,
  averageTradingValue: 1_000_000,
  liquidityObservationCount: 20,
}))

class StageFixtureSource implements TriggerDiscoveryDataSource {
  stageCalls = 0
  stageTickerCounts: number[] = []

  constructor(private readonly withStages: boolean) {}

  async loadMarketSessions() {
    return { value: SESSIONS, queryCount: 1, queryMs: 1 }
  }

  async loadCandidateSnapshots() {
    return { value: candidates, queryCount: 1, queryMs: 1 }
  }

  async loadStoredMaObservations(input: { candidates: TriggerDiscoveryFilteredCandidate[] }) {
    return {
      value: new Map(input.candidates.map((candidate) => [candidate.ticker, observations()])),
      queryCount: 1,
      queryMs: 1,
    }
  }

  async loadGenericMaObservations(input: { candidates: TriggerDiscoveryFilteredCandidate[] }) {
    return {
      value: new Map(input.candidates.map((candidate) => [candidate.ticker, observations()])),
      queryCount: 1,
      queryMs: 1,
    }
  }

  async loadStageSnapshots(input: { tickers: string[]; resolvedAsOf: string }) {
    this.stageCalls += 1
    this.stageTickerCounts.push(input.tickers.length)
    const value = new Map<string, TriggerDiscoveryStageSnapshot>()
    if (this.withStages) {
      value.set('1001', {
        ticker: '1001', date: input.resolvedAsOf,
        dayAStage: 1, dayBStage: 2, weekAStage: 3, weekBStage: 4, monthAStage: 5, monthBStage: 6,
      })
      value.set('1002', {
        ticker: '1002', date: input.resolvedAsOf,
        dayAStage: 6, dayBStage: 5, weekAStage: null, weekBStage: 3, monthAStage: 2, monthBStage: 1,
      })
      value.set('1003', {
        ticker: '1003', date: '2026-09-05',
        dayAStage: 1, dayBStage: 1, weekAStage: 1, weekBStage: 1, monthAStage: 1, monthBStage: 1,
      })
    }
    return { value, queryCount: input.tickers.length > 0 ? 1 : 0, queryMs: 1 }
  }
}

async function main() {
  const source = new StageFixtureSource(true)
  const result = await getTriggerDiscovery({ asOf: AS_OF, limit: 500 }, { dataSource: source })
  assert.equal(result.totalMatched, 3)
  assert.equal(result.diagnostics.performance.queryCount, 4)
  assert.ok(result.diagnostics.performance.scoreCalculationMs >= 0)
  assert.equal(source.stageCalls, 1, 'Stage snapshots are loaded in one bulk call')
  assert.deepEqual(source.stageTickerCounts, [3], 'all matched tickers share the bulk Stage load')

  const complete = result.rows.find((row) => row.ticker === '1001')!
  assert.deepEqual(
    [complete.dayAStage, complete.dayBStage, complete.weekAStage, complete.weekBStage, complete.monthAStage, complete.monthBStage],
    [1, 2, 3, 4, 5, 6],
  )
  assert.equal(complete.stageDate, AS_OF)
  assert.equal(complete.stageAvailable, true)
  assert.equal(complete.stageComplete, true)
  assert.equal(complete.scoreBreakdown.stageAvailableAxes, 6)
  assert.equal(complete.scoreBreakdown.stageCoverage, 1)

  const partial = result.rows.find((row) => row.ticker === '1002')!
  assert.equal(partial.weekAStage, null)
  assert.equal(partial.stageAvailable, true)
  assert.equal(partial.stageComplete, false)
  assert.equal(partial.scoreBreakdown.stageAvailableAxes, 5)
  assert.ok(partial.scoreBreakdown.stageCoverage > 0 && partial.scoreBreakdown.stageCoverage < 1)

  const futureOnly = result.rows.find((row) => row.ticker === '1003')!
  assert.equal(futureOnly.stageDate, null, 'a future snapshot never satisfies the exact PIT join contract')
  assert.equal(futureOnly.stageAvailable, false)
  assert.equal(futureOnly.stageComplete, false)
  assert.equal(futureOnly.scoreBreakdown.stageStructure, 10, 'missing Stage is neutral rather than zero or full points')
  assert.equal(futureOnly.scoreBreakdown.stageCoverage, 0)
  assert.deepEqual(
    [futureOnly.dayAStage, futureOnly.dayBStage, futureOnly.weekAStage, futureOnly.weekBStage, futureOnly.monthAStage, futureOnly.monthBStage],
    [null, null, null, null, null, null],
  )
  assert.deepEqual(result.diagnostics.counts, {
    universe: 3,
    afterMarket: 3,
    afterStalePrice: 3,
    currentPrice: 3,
    staleAccepted: 0,
    afterPrice: 3,
    afterVolume: 3,
    afterTradingValue: 3,
    evaluated: 3,
    matched: 3,
    afterStageFilter: 3,
    stageRows: 2,
    stageComplete: 1,
    stageIncomplete: 2,
  })

  const withoutStages = await getTriggerDiscovery(
    { asOf: AS_OF, limit: 500 },
    { dataSource: new StageFixtureSource(false) },
  )
  assert.deepEqual(
    result.rows.map((row) => row.ticker),
    withoutStages.rows.map((row) => row.ticker),
    'Stage availability cannot alter the Trigger candidate set or order',
  )
  assert.equal(withoutStages.totalMatched, result.totalMatched)
  assert.ok(withoutStages.rows.every((row) => !row.stageAvailable && !row.stageComplete))
  assert.ok(withoutStages.rows.every((row) => row.scoreBreakdown.stageStructure === 10))

  const stageFiltered = await getTriggerDiscovery({
    asOf: AS_OF,
    stageFilters: { weekAStage: [3, 'unknown'], monthAStage: [5] },
    limit: 500,
  }, { dataSource: new StageFixtureSource(true) })
  assert.deepEqual(stageFiltered.rows.map((row) => row.ticker), ['1001'])
  assert.equal(stageFiltered.totalTriggerMatched, 3, 'Stage filters do not change Trigger matched count')
  assert.equal(stageFiltered.totalMatched, 1, 'Stage filters are applied after Stage attachment')

  const unknownFiltered = await getTriggerDiscovery({
    asOf: AS_OF,
    stageFilters: { weekAStage: ['unknown'] },
    limit: 500,
  }, { dataSource: new StageFixtureSource(true) })
  assert.deepEqual(unknownFiltered.rows.map((row) => row.ticker), ['1002', '1003'])

  const stageAscending = await getTriggerDiscovery({
    asOf: AS_OF,
    sortBy: 'dayAStage',
    sortDirection: 'asc',
    limit: 2,
  }, { dataSource: new StageFixtureSource(true) })
  assert.deepEqual(stageAscending.rows.map((row) => row.ticker), ['1001', '1002'])
  assert.equal(stageAscending.hasMore, true, 'sorting applies to the full set before pagination')

  const stageDescending = await getTriggerDiscovery({
    asOf: AS_OF,
    sortBy: 'dayAStage',
    sortDirection: 'desc',
    limit: 500,
  }, { dataSource: new StageFixtureSource(true) })
  assert.deepEqual(stageDescending.rows.map((row) => row.ticker), ['1002', '1001', '1003'], 'null Stage remains last for descending sort')

  const stageSortCases = [
    ['dayAStage', ['1001', '1002', '1003'], ['1002', '1001', '1003']],
    ['dayBStage', ['1001', '1002', '1003'], ['1002', '1001', '1003']],
    ['weekAStage', ['1001', '1002', '1003'], ['1001', '1002', '1003']],
    ['weekBStage', ['1002', '1001', '1003'], ['1001', '1002', '1003']],
    ['monthAStage', ['1002', '1001', '1003'], ['1001', '1002', '1003']],
    ['monthBStage', ['1002', '1001', '1003'], ['1001', '1002', '1003']],
  ] as const
  for (const [sortBy, expectedAscending, expectedDescending] of stageSortCases) {
    assert.deepEqual(
      sortTriggerDiscoveryRows(result.rows, sortBy, 'asc').map((row) => row.ticker),
      expectedAscending,
      `${sortBy} ascending sort keeps missing Stage values last`,
    )
    assert.deepEqual(
      sortTriggerDiscoveryRows(result.rows, sortBy, 'desc').map((row) => row.ticker),
      expectedDescending,
      `${sortBy} descending sort keeps missing Stage values last`,
    )
  }

  const scoreAscending = sortTriggerDiscoveryRows(result.rows, 'triggerScore', 'asc')
  const scoreDescending = sortTriggerDiscoveryRows(result.rows, 'triggerScore', 'desc')
  assert.ok(scoreAscending.every((row, index) => index === 0 || scoreAscending[index - 1].triggerScore <= row.triggerScore))
  assert.ok(scoreDescending.every((row, index) => index === 0 || scoreDescending[index - 1].triggerScore >= row.triggerScore))

  const primeOnly = await getTriggerDiscovery({
    asOf: AS_OF,
    markets: ['プライム'],
    sortBy: 'ticker',
    sortDirection: 'asc',
    limit: 1,
  }, { dataSource: new StageFixtureSource(true) })
  const baseline1001 = result.rows.find((row) => row.ticker === '1001')!
  assert.equal(primeOnly.rows[0].ticker, '1001')
  assert.equal(primeOnly.rows[0].triggerScore, baseline1001.triggerScore, 'Universe and pagination do not alter a ticker score')
  assert.deepEqual(primeOnly.rows[0].scoreBreakdown, baseline1001.scoreBreakdown)

  console.log('trigger discovery Stage integration tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

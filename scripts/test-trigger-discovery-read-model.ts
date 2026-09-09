import assert from 'node:assert/strict'
import { isHistoricalUniverseMemberAt } from '@/lib/historical-universe'
import {
  filterTriggerDiscoveryCandidates,
  getTriggerDiscovery,
  TriggerDiscoveryInputError,
  type TriggerDiscoveryCandidateSnapshot,
  type TriggerDiscoveryDataSource,
  type TriggerDiscoveryFilteredCandidate,
} from '@/lib/server/trigger-discovery-read-model'
import type { MaZoneTriggerObservation } from '@/lib/trigger-discovery-engine'

let assertions = 0
function check(value: unknown, message: string): asserts value {
  assertions += 1
  assert.ok(value, message)
}

function equal<T>(actual: T, expected: T, message: string): void {
  assertions += 1
  assert.equal(actual, expected, message)
}

function observationSeries(endDate = '2026-09-04'): MaZoneTriggerObservation[] {
  const end = Date.parse(`${endDate}T00:00:00Z`)
  return Array.from({ length: 24 }, (_, index) => {
    const date = new Date(end - (23 - index) * 86_400_000).toISOString().slice(0, 10)
    const ma1 = 100 + index * 0.25
    const ma2 = 96 + index * 0.2
    const distance = 6 - index * 0.21
    return { date, price: ma1 * (1 + distance / 100), ma1, ma2 }
  })
}

const sessions = [
  '2026-09-04', '2026-09-03', '2026-09-02', '2026-09-01', '2026-08-31',
  '2026-08-28', '2026-08-27', '2026-08-26', '2026-08-25', '2026-08-24',
  '2026-08-21', '2026-08-20', '2026-08-19', '2026-08-18', '2026-08-17',
  '2026-08-14', '2026-08-13', '2026-08-12', '2026-08-11', '2026-08-10',
  '2026-08-07', '2026-08-06', '2026-08-05', '2026-08-04', '2026-08-03',
  '2026-07-31', '2026-07-30', '2026-07-29', '2026-07-28', '2026-07-27',
]

const fixtureCandidates: TriggerDiscoveryCandidateSnapshot[] = [
  { ticker: '1001', companyName: 'Prime Boundary', market: 'プライム', priceDate: '2026-09-04', price: 500, averageVolume: 1_000, averageTradingValue: 500_000, liquidityObservationCount: 20 },
  { ticker: '1002', companyName: 'Standard Stale', market: 'スタンダード', priceDate: '2026-09-02', price: 900, averageVolume: 2_000, averageTradingValue: 1_800_000, liquidityObservationCount: 20 },
  { ticker: '1003', companyName: 'Growth Low', market: 'グロース', priceDate: '2026-09-04', price: 499, averageVolume: 999, averageTradingValue: 498_501, liquidityObservationCount: 20 },
  { ticker: '1004', companyName: 'Old Price', market: 'プライム', priceDate: '2026-08-28', price: 700, averageVolume: 1_500, averageTradingValue: 1_050_000, liquidityObservationCount: 20 },
  { ticker: '1005', companyName: 'Short History', market: null, priceDate: '2026-09-04', price: 600, averageVolume: 1_000, averageTradingValue: 600_000, liquidityObservationCount: 5 },
]

function filter(overrides: Partial<Parameters<typeof filterTriggerDiscoveryCandidates>[0]> = {}) {
  return filterTriggerDiscoveryCandidates({
    candidates: fixtureCandidates,
    marketSessionsDescending: sessions,
    priceMin: null,
    priceMax: null,
    averageVolumeMin: null,
    averageVolumeMax: null,
    averageTradingValueMin: null,
    averageTradingValueMax: null,
    liquidityLookbackSessions: 20,
    maxPriceStalenessSessions: 3,
    ...overrides,
  })
}

equal(filter().candidates.length, 4, 'all DB markets including NULL are retained when the market filter is omitted')
equal(filter({ markets: ['プライム'] }).candidates.map((row) => row.ticker).join(','), '1001', 'a single market filter is exact')
equal(filter({ markets: ['プライム', 'スタンダード'] }).candidates.map((row) => row.ticker).join(','), '1001,1002', 'multiple markets use inclusive membership')
equal(filter({ markets: ['存在しない市場'] }).candidates.length, 0, 'unknown markets return no candidates')
equal(filter({ markets: [null] }).candidates.map((row) => row.ticker).join(','), '1005', 'NULL market remains an explicit DB value')
equal(filter({ priceMin: 500 }).candidates.map((row) => row.ticker).join(','), '1001,1002,1005', 'price minimum is inclusive')
equal(filter({ priceMax: 500 }).candidates.map((row) => row.ticker).join(','), '1001,1003', 'price maximum is inclusive')
equal(filter({ priceMin: 500, priceMax: 600 }).candidates.map((row) => row.ticker).join(','), '1001,1005', 'two-sided price range is inclusive')
equal(filter({ averageVolumeMin: 1_000 }).candidates.map((row) => row.ticker).join(','), '1001,1002,1005', 'volume minimum includes its boundary')
equal(filter({ averageVolumeMax: 1_000 }).candidates.map((row) => row.ticker).join(','), '1001,1003,1005', 'volume maximum includes its boundary')
equal(filter({ averageTradingValueMin: 500_000 }).candidates.map((row) => row.ticker).join(','), '1001,1002,1005', 'trading-value minimum includes its boundary')
equal(filter({ averageTradingValueMax: 500_000 }).candidates.map((row) => row.ticker).join(','), '1001,1003', 'trading-value maximum includes its boundary')
equal(filter({ priceMin: 500, averageVolumeMin: 1_000, averageTradingValueMin: 600_000 }).candidates.map((row) => row.ticker).join(','), '1002,1005', 'combined cheap filters are applied before MA evaluation')
equal(filter().candidates.find((row) => row.ticker === '1005')?.liquidityComplete, false, 'short histories use their available observations and disclose incompleteness')
equal(filter().rejected.STALE_PRICE, 1, 'prices older than three market sessions are excluded by default')
equal(filter({ maxPriceStalenessSessions: 0 }).candidates.some((row) => row.ticker === '1002'), false, 'zero tolerance requires the resolved market date')

equal(isHistoricalUniverseMemberAt({
  asOf: '2024-06-30', currentActive: false, historicalRecordExists: true,
  firstTradeDate: '2024-07-01', lastTradeDate: '2026-09-04', ledgerThrough: '2026-09-04',
}), false, 'IPO-before PIT membership is rejected')
equal(isHistoricalUniverseMemberAt({
  asOf: '2024-07-01', currentActive: false, historicalRecordExists: true,
  firstTradeDate: '2024-07-01', lastTradeDate: '2025-12-30', ledgerThrough: '2026-09-04',
}), true, 'a ticker is included during its listing window regardless of current activity')
equal(isHistoricalUniverseMemberAt({
  asOf: '2026-01-05', currentActive: false, historicalRecordExists: true,
  firstTradeDate: '2024-07-01', lastTradeDate: '2025-12-30', ledgerThrough: '2026-09-04',
}), false, 'post-delisting PIT membership is rejected')

class FixtureSource implements TriggerDiscoveryDataSource {
  genericCalls = 0
  fastCalls = 0
  private readonly candidates: TriggerDiscoveryCandidateSnapshot[]
  private readonly observations: Map<string, MaZoneTriggerObservation[]>

  constructor(candidates = fixtureCandidates) {
    this.observations = new Map(candidates.map((candidate) => [
      candidate.ticker,
      observationSeries(candidate.priceDate ?? '2026-09-04'),
    ]))
    this.candidates = candidates.map((candidate) => ({
      ...candidate,
      price: this.observations.get(candidate.ticker)?.at(-1)?.price ?? candidate.price,
    }))
  }

  async loadMarketSessions(asOf: string, limit: number) {
    return { value: sessions.filter((date) => date <= asOf).slice(0, limit), queryCount: 1, queryMs: 1 }
  }

  async loadCandidateSnapshots() {
    return { value: this.candidates, queryCount: 1, queryMs: 1 }
  }

  async loadStoredMaObservations(input: { candidates: TriggerDiscoveryFilteredCandidate[] }) {
    this.fastCalls += 1
    return { value: new Map(input.candidates.map((candidate) => [candidate.ticker, this.observations.get(candidate.ticker) ?? []])), queryCount: 1, queryMs: 1 }
  }

  async loadGenericMaObservations(input: { candidates: TriggerDiscoveryFilteredCandidate[] }) {
    this.genericCalls += 1
    return { value: new Map(input.candidates.map((candidate) => [candidate.ticker, this.observations.get(candidate.ticker) ?? []])), queryCount: 1, queryMs: 1 }
  }
}

async function main() {
  const source = new FixtureSource()
  const result = await getTriggerDiscovery({
    asOf: '2026-09-06',
    markets: ['プライム', 'スタンダード'],
    averageVolumeMin: 1_000,
    averageTradingValueMin: 500_000,
  }, { dataSource: source })
  equal(result.requestedAsOf, '2026-09-06', 'requested non-trading asOf is preserved')
  equal(result.resolvedAsOf, '2026-09-04', 'asOf resolves to the latest prior market session')
  equal(result.diagnostics.counts.evaluated, 2, 'only cheap-filter survivors reach the Trigger Engine')
  equal(result.diagnostics.performance.queryCount, 3, 'fast path query count is constant')
  equal(source.fastCalls, 1, 'saved 20M/25M periods use the fast path')
  equal(source.genericCalls, 0, 'complete fast-path input does not call generic loading')
  check(result.rows.every((row) => row.matched && row.maPath === 'fast'), 'Discovery returns matched rows only')
  check(result.rows.every((row) => row.maDate <= result.resolvedAsOf!), 'future MA observations never pass resolvedAsOf')
  check(result.rows.every((row) => row.priceDate <= result.resolvedAsOf!), 'future price observations never pass resolvedAsOf')

  const genericSource = new FixtureSource()
  const generic = await getTriggerDiscovery({
    asOf: '2026-09-04',
    triggerConfig: { ma1Period: 20, ma2Period: 50 },
    limit: 1,
  }, { dataSource: genericSource })
  equal(genericSource.fastCalls, 0, 'arbitrary 20M/50M periods do not use a saved-MA fast path')
  equal(genericSource.genericCalls, 1, 'arbitrary MA periods use one generic bulk load')
  equal(generic.rows.length, 1, 'pagination limits returned matched rows')
  equal(generic.hasMore, generic.totalMatched > 1, 'pagination metadata is deterministic')

  const paritySource = new FixtureSource()
  const fast = await getTriggerDiscovery({ asOf: '2026-09-04', limit: 500 }, { dataSource: paritySource, maPath: 'fast' })
  const genericParity = await getTriggerDiscovery({ asOf: '2026-09-04', limit: 500 }, { dataSource: paritySource, maPath: 'generic' })
  equal(fast.rows.map((row) => `${row.ticker}:${row.triggerStatus}`).join(','), genericParity.rows.map((row) => `${row.ticker}:${row.triggerStatus}`).join(','), 'fast and generic paths share identical Engine results')

  await assert.rejects(
    () => getTriggerDiscovery({ asOf: '2026-09-04', priceMin: 100, priceMax: 99 }, { dataSource: new FixtureSource() }),
    TriggerDiscoveryInputError,
  )
  assertions += 1
  await assert.rejects(
    () => getTriggerDiscovery({ asOf: '2026-09-04', triggerConfig: { ma1Period: 20, ma2Period: 50 } }, { dataSource: new FixtureSource(), maPath: 'fast' }),
    TriggerDiscoveryInputError,
  )
  assertions += 1

  console.log(`trigger discovery read model tests passed (${assertions} assertions)`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

import assert from 'node:assert/strict'
import {
  createTriggerDiscoverySqlDataSource,
  filterTriggerDiscoveryCandidates,
  getTriggerDiscovery,
  type TriggerDiscoveryFilteredCandidate,
  type TriggerDiscoveryInput,
  type TriggerDiscoveryResult,
} from '@/lib/server/trigger-discovery-read-model'
import {
  DEFAULT_MA_ZONE_TRIGGER_CONFIG,
  evaluateMaZoneTrigger,
} from '@/lib/trigger-discovery-engine'
import { execAll, execGet } from '@/lib/db/client'

const AS_OF = process.env.TRIGGER_DISCOVERY_AS_OF ?? '2026-09-07'
const dataSource = createTriggerDiscoverySqlDataSource()

const cases: Array<{ id: string; input: TriggerDiscoveryInput }> = [
  { id: 'A', input: { asOf: AS_OF, triggerConfig: { ma1Period: 20, ma2Period: 25 }, limit: 500 } },
  { id: 'B', input: { asOf: AS_OF, triggerConfig: { ma1Period: 20, ma2Period: 25 }, markets: ['プライム', 'スタンダード'], priceMin: 500, averageTradingValueMin: 100_000_000, limit: 500 } },
  { id: 'C', input: { asOf: AS_OF, triggerConfig: { ma1Period: 20, ma2Period: 50 }, limit: 500 } },
  { id: 'D', input: { asOf: AS_OF, triggerConfig: { ma1Period: 50, ma2Period: 100 }, limit: 500 } },
]

type RawStageRow = {
  ticker: string
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

async function auditAttachedStages(result: TriggerDiscoveryResult) {
  const samples = result.rows.slice(0, 5)
  if (!result.resolvedAsOf || samples.length === 0) return
  const placeholders = samples.map(() => '?').join(', ')
  const rawRows = await execAll<RawStageRow>(`
    SELECT ticker, date,
           daily_a_stage, daily_b_stage,
           weekly_a_stage, weekly_b_stage,
           monthly_a_stage, monthly_b_stage
    FROM daily_snapshots
    WHERE date = ? AND ticker IN (${placeholders})
  `, [result.resolvedAsOf, ...samples.map((row) => row.ticker)])
  const rawByTicker = new Map(rawRows.map((row) => [row.ticker, row]))
  const comparisons = samples.map((row) => {
    const raw = rawByTicker.get(row.ticker)
    const attached = [
      row.dayAStage, row.dayBStage, row.weekAStage,
      row.weekBStage, row.monthAStage, row.monthBStage,
    ]
    const expected = raw
      ? [
          raw.daily_a_stage, raw.daily_b_stage, raw.weekly_a_stage,
          raw.weekly_b_stage, raw.monthly_a_stage, raw.monthly_b_stage,
        ]
      : [null, null, null, null, null, null]
    assert.deepEqual(attached, expected, `${row.ticker} six-axis Stage values`)
    assert.equal(row.stageDate, raw?.date ?? null, `${row.ticker} exact Stage date`)
    assert.equal(row.stageAvailable, raw != null, `${row.ticker} Stage row availability`)
    assert.equal(row.stageComplete, raw != null && expected.every((stage) => stage != null), `${row.ticker} Stage completeness`)
    return { ticker: row.ticker, stageDate: row.stageDate, attached, expected }
  })
  console.log(JSON.stringify({ stageDirectComparison: comparisons }))
  console.log(JSON.stringify({
    stageMissingExamples: {
      complete: result.rows.find((row) => row.stageComplete)?.ticker ?? null,
      partial: result.rows.find((row) => row.stageAvailable && !row.stageComplete)?.ticker ?? null,
      noSnapshot: result.rows.find((row) => !row.stageAvailable)?.ticker ?? null,
    },
  }))
}

async function runCase(testCase: typeof cases[number], pass: 'cold' | 'warm') {
  const result = await getTriggerDiscovery(testCase.input)
  console.log(JSON.stringify({
    case: testCase.id,
    pass,
    requestedAsOf: result.requestedAsOf,
    resolvedAsOf: result.resolvedAsOf,
    counts: result.diagnostics.counts,
    matched: result.totalMatched,
    performance: result.diagnostics.performance,
    representatives: result.rows.slice(0, 5).map((row) => `${row.ticker} ${row.companyName}`),
  }))
  return result
}

async function parityAt(asOf: string, tickers: string[]) {
  const requiredObservations = Math.max(
    DEFAULT_MA_ZONE_TRIGGER_CONFIG.slopeLookbackSessions,
    DEFAULT_MA_ZONE_TRIGGER_CONFIG.approachLookbackSessions,
  ) + 1
  const sessions = await dataSource.loadMarketSessions(asOf, 32)
  const resolvedAsOf = sessions.value[0]
  assert.ok(resolvedAsOf)
  const candidatesLoad = await dataSource.loadCandidateSnapshots({
    resolvedAsOf,
    oldestSessionDate: sessions.value.at(-1)!,
    liquidityLookbackSessions: 20,
  })
  const filtered = filterTriggerDiscoveryCandidates({
    candidates: candidatesLoad.value.filter((candidate) => tickers.includes(candidate.ticker)),
    marketSessionsDescending: sessions.value,
    priceMin: null,
    priceMax: null,
    averageVolumeMin: null,
    averageVolumeMax: null,
    averageTradingValueMin: null,
    averageTradingValueMax: null,
    liquidityLookbackSessions: 20,
    maxPriceStalenessSessions: 3,
  }).candidates
  const input = {
    candidates: filtered,
    ma1Period: 20,
    ma2Period: 25,
  }
  const fast = await dataSource.loadStoredMaObservations({
    ...input,
    oldestObservationDate: sessions.value.at(-1)!,
    requiredObservations,
  })
  const generic = await dataSource.loadGenericMaObservations({
    ...input,
    requiredObservations,
  })
  const comparisons = filtered.map((candidate: TriggerDiscoveryFilteredCandidate) => {
    const fastResult = evaluateMaZoneTrigger({ observations: fast.value.get(candidate.ticker) ?? [], asOf: resolvedAsOf })
    const genericResult = evaluateMaZoneTrigger({ observations: generic.value.get(candidate.ticker) ?? [], asOf: resolvedAsOf })
    assert.equal(genericResult.observationDate, fastResult.observationDate, `${candidate.ticker} observation date`)
    assert.equal(genericResult.status, fastResult.status, `${candidate.ticker} status`)
    assert.equal(genericResult.matched, fastResult.matched, `${candidate.ticker} matched`)
    if (fastResult.snapshot && genericResult.snapshot) {
      assert.ok(Math.abs(fastResult.snapshot.ma1 - genericResult.snapshot.ma1) < 1e-6, `${candidate.ticker} MA1`)
      assert.ok(Math.abs(fastResult.snapshot.ma2 - genericResult.snapshot.ma2) < 1e-6, `${candidate.ticker} MA2`)
    }
    return {
      ticker: candidate.ticker,
      date: fastResult.observationDate,
      status: fastResult.status,
      matched: fastResult.matched,
      ma1Difference: fastResult.snapshot && genericResult.snapshot ? genericResult.snapshot.ma1 - fastResult.snapshot.ma1 : null,
      ma2Difference: fastResult.snapshot && genericResult.snapshot ? genericResult.snapshot.ma2 - fastResult.snapshot.ma2 : null,
    }
  })
  console.log(JSON.stringify({ parityAsOf: asOf, resolvedAsOf, comparisons }))
}

async function pitUniverseAudit() {
  const ledger = await execGet<{ through_date: string }>(`
    SELECT MAX(latest_ohlcv_date) AS through_date FROM historical_universe
  `)
  const postIpo = await execGet<{ ticker: string; first_date: string }>(`
    SELECT ticker, first_trade_date AS first_date
    FROM historical_universe
    WHERE first_trade_date > '2026-08-25' AND first_trade_date <= latest_ohlcv_date
    ORDER BY first_trade_date, ticker
    LIMIT 1
  `)
  const delisted = await execGet<{ ticker: string; first_date: string; last_date: string }>(`
    SELECT ticker, first_trade_date AS first_date, last_trade_date AS last_date
    FROM historical_universe
    WHERE last_trade_date < latest_ohlcv_date
      AND trading_days >= 40
    ORDER BY last_trade_date DESC, ticker
    LIMIT 1
  `)
  assert.ok(ledger?.through_date)
  assert.ok(postIpo)
  assert.ok(delisted)

  async function members(asOf: string) {
    const sessions = await dataSource.loadMarketSessions(asOf, 30)
    assert.ok(sessions.value[0])
    const rows = await dataSource.loadCandidateSnapshots({
      resolvedAsOf: sessions.value[0],
      oldestSessionDate: sessions.value.at(-1)!,
      liquidityLookbackSessions: 20,
    })
    return new Set(rows.value.map((row) => row.ticker))
  }

  const preIpo = await members('2026-08-25')
  const duringIpo = await members(postIpo!.first_date)
  const duringDelisted = await members(delisted!.last_date)
  const afterDelisted = await members(ledger!.through_date)
  assert.equal(preIpo.has(postIpo!.ticker), false, 'IPO ticker must not exist before first trade')
  assert.equal(duringIpo.has(postIpo!.ticker), true, 'IPO ticker must exist from first trade')
  assert.equal(duringDelisted.has(delisted!.ticker), true, 'delisted ticker must exist during listing')
  assert.equal(afterDelisted.has(delisted!.ticker), false, 'delisted ticker must not exist after last trade')
  console.log(JSON.stringify({ pitUniverse: { ledger, postIpo, delisted, passed: true } }))
}

async function main() {
  await pitUniverseAudit()
  await parityAt(AS_OF, ['7003', '7203', '8306', '4502', '7974'])
  await parityAt('2026-08-25', ['7003', '7203', '8306'])
  for (const testCase of cases) {
    const cold = await runCase(testCase, 'cold')
    if (testCase.id === 'A') await auditAttachedStages(cold)
    await runCase(testCase, 'warm')
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

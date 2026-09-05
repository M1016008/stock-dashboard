import assert from 'node:assert/strict'
import { queryIntegratedScreener } from '@/lib/server/integrated-screener-serving'
import type { ScreeningCondition } from '@/lib/integrated-screener'

const scenarios: Array<{ id: string; conditions: ScreeningCondition[] }> = [
  { id: 'A', conditions: [
    { id: 'a1', metric: 'roe', operator: 'gte', value: 10 },
    { id: 'a2', metric: 'forwardPer', operator: 'lte', value: 15 },
  ] },
  { id: 'B', conditions: [
    { id: 'b1', metric: 'revenueGrowth', operator: 'gte', value: 10 },
    { id: 'b2', metric: 'weeklyAStage', operator: 'eq', value: 2 },
  ] },
  { id: 'C', conditions: [
    { id: 'c1', metric: 'forecastDividendYield', operator: 'gte', value: 3 },
    { id: 'c2', metric: 'consecutiveIncreaseYears', operator: 'gte', value: 3 },
  ] },
  { id: 'D', conditions: [
    { id: 'd1', metric: 'sectorStructureScore', operator: 'gte', value: 70 },
    { id: 'd2', metric: 'pms', operator: 'gt', value: 0 },
    { id: 'd3', metric: 'forwardPer', operator: 'lte', value: 20 },
  ] },
  { id: 'E', conditions: [
    { id: 'e1', metric: 'revenueGrowth', operator: 'gte', value: 5 },
    { id: 'e2', metric: 'roe', operator: 'gte', value: 10 },
    { id: 'e3', metric: 'pbr', operator: 'lte', value: 1.5 },
    { id: 'e4', metric: 'weeklyAStage', operator: 'eq', value: 2 },
    { id: 'e5', metric: 'sectorStructureScore', operator: 'gte', value: 60 },
  ] },
]

async function run(asOf: string | null, scenario: typeof scenarios[number]) {
  const result = await queryIntegratedScreener({ asOf, conditions: scenario.conditions, sort: 'marketCap', direction: 'desc', limit: 10 })
  assert.equal(result.contractVersion, 'integrated-screener-v1')
  assert.ok(result.universe >= 4_500)
  assert.ok(result.total >= 0)
  for (const row of result.rows) {
    assert.ok(row.snapshotDate <= result.asOf)
    if (row.valuationDate) assert.ok(row.valuationDate <= result.asOf)
  }
  console.log(JSON.stringify({ scenario: scenario.id, requestedAsOf: asOf, asOf: result.asOf, snapshotDate: result.snapshotDate, total: result.total, representatives: result.rows.slice(0, 5).map((row) => `${row.ticker} ${row.name}`), elapsedMs: result.elapsedMs, cacheHit: result.cacheHit }))
}

async function main() {
  for (const scenario of scenarios) await run(null, scenario)
  await run('2026-05-29', scenarios[0])
  await run('2026-07-31', scenarios[3])
  await queryIntegratedScreener({ conditions: scenarios[0].conditions, sort: 'marketCap', direction: 'desc', limit: 10 })
  const warm = await queryIntegratedScreener({ conditions: scenarios[0].conditions, sort: 'marketCap', direction: 'desc', limit: 10 })
  assert.equal(warm.cacheHit, true)
  console.log(JSON.stringify({ warmElapsedMs: warm.elapsedMs }))
  console.log('integrated screener scenarios, PIT, and cache tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

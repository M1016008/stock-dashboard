import assert from 'node:assert/strict'
import type { ScreeningCondition } from '@/lib/integrated-screener'
import { getScreenerReason } from '@/lib/server/integrated-screener-reason'
import { getIntegratedScreeningReasonData, queryIntegratedScreener } from '@/lib/server/integrated-screener-serving'

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

function verifyPIT(asOf: string, sourceDate: string | null): void {
  if (!sourceDate) return
  assert.ok(sourceDate.slice(0, 10) <= asOf, `${sourceDate} must be no later than ${asOf}`)
}

async function verifyScenario(scenario: typeof scenarios[number], asOf?: string) {
  const result = await queryIntegratedScreener({ asOf, conditions: scenario.conditions, sort: 'marketCap', direction: 'desc', limit: 3 })
  assert.ok(result.rows.length > 0, `scenario ${scenario.id} should have representative rows`)
  const examples = []
  for (const row of result.rows) {
    const reason = await getScreenerReason({ ticker: row.ticker, asOf: result.asOf, conditions: scenario.conditions })
    assert.ok(reason)
    assert.equal(reason.contractVersion, 'screener-reason-v1')
    assert.equal(reason.asOf, result.asOf)
    assert.equal(reason.matchedConditions.length, scenario.conditions.length)
    assert.ok(reason.supportingFacts.length <= 3)
    assert.ok(reason.cautions.length <= 3)
    for (const item of [...reason.matchedConditions, ...reason.supportingFacts, ...reason.cautions]) {
      assert.equal(item.source.asOf, reason.asOf)
      verifyPIT(reason.asOf, item.source.sourceDate)
      assert.ok(item.message.length > 0)
    }
    examples.push({
      ticker: row.ticker,
      matches: reason.matchedConditions.map((item) => item.message),
      supporting: reason.supportingFacts.map((item) => item.message),
      cautions: reason.cautions.map((item) => item.message),
      elapsedMs: reason.elapsedMs,
    })
  }
  console.log(JSON.stringify({ scenario: scenario.id, asOf: result.asOf, total: result.total, examples }))
}

async function main() {
  for (const scenario of scenarios) await verifyScenario(scenario)
  await verifyScenario(scenarios[0], '2026-05-29')
  await verifyScenario(scenarios[3], '2026-07-31')

  const hasPbr: ScreeningCondition[] = [{ id: 'pbr-data', metric: 'pbr', operator: 'has_data' }]
  const bankData = await getIntegratedScreeningReasonData('8306')
  assert.ok(bankData)
  assert.equal(bankData.row.evEbitda, null, 'financial-sector EV/EBITDA must remain missing, not zero')
  const bank = await getScreenerReason({ ticker: '8306', conditions: hasPbr })
  assert.ok(bank)
  assert.ok(bank.matchedConditions.length === 1)
  assert.ok(![...bank.supportingFacts, ...bank.cautions].some((item) => item.metric === 'evEbitda'))

  const loss = await getScreenerReason({ ticker: '4755', conditions: hasPbr })
  assert.ok(loss)
  assert.ok(loss.cautions.some((item) => item.metric === 'actual_eps' && Number(item.actual.value) <= 0), 'loss company should state its non-positive actual EPS')

  const first = await getScreenerReason({ ticker: '7203', conditions: scenarios[0].conditions })
  const warm = await getScreenerReason({ ticker: '7203', conditions: scenarios[0].conditions })
  assert.ok(first && warm)
  assert.equal(warm.cacheHit, true)
  assert.ok(warm.elapsedMs < 50, `warm reason should be below 50ms, got ${warm.elapsedMs}`)
  console.log(JSON.stringify({ bank: bank.cautions.map((item) => item.message), loss: loss.cautions.map((item) => item.message), warmElapsedMs: warm.elapsedMs }))
  console.log('integrated screener Reason Contract, PIT, missing, bank, loss, and cache tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

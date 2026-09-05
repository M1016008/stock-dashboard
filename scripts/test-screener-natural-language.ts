import assert from 'node:assert/strict'
import { SCREENING_METRIC_MAP, type ScreeningCondition, type ScreeningMetricKey } from '@/lib/integrated-screener'
import { validateNaturalLanguageConditions } from '@/lib/screener-natural-language'
import { interpretScreenerNaturalLanguage } from '@/lib/server/screener-natural-language'

function conditionFor(conditions: ScreeningCondition[], metric: ScreeningMetricKey): ScreeningCondition {
  const condition = conditions.find((item) => item.metric === metric)
  assert.ok(condition, `expected ${metric}`)
  return condition
}

function assertCondition(conditions: ScreeningCondition[], metric: ScreeningMetricKey, operator: ScreeningCondition['operator'], value: unknown): void {
  const condition = conditionFor(conditions, metric)
  assert.equal(condition.operator, operator, `${metric} operator`)
  assert.deepEqual(condition.value, value, `${metric} value`)
}

async function proposal(query: string) {
  const result = await interpretScreenerNaturalLanguage(query, { forceFallback: true })
  assert.equal(result.contractVersion, 'screener-natural-language-v1')
  assert.equal(result.query, query)
  assert.equal(result.source, 'fallback')
  assert.equal(result.validationErrors.length, 0)
  for (const condition of result.conditions) {
    const definition = SCREENING_METRIC_MAP.get(condition.metric)
    assert.ok(definition)
    assert.ok(definition.operators.includes(condition.operator))
  }
  return result
}

async function main() {
  const largeValue = await proposal('ROEが高くて割安な大型株')
  assertCondition(largeValue.conditions, 'roe', 'gte', 10)
  assertCondition(largeValue.conditions, 'forwardPer', 'lte', 15)
  assertCondition(largeValue.conditions, 'pbr', 'lte', 1.5)
  assertCondition(largeValue.conditions, 'marketCap', 'gte', 500_000_000_000)
  assert.ok(largeValue.assumptions.some((item) => item.term === 'ROEが高い'))
  assert.ok(largeValue.assumptions.some((item) => item.term === '割安'))

  const growingWeekly = await proposal('売上が伸びていて週足が上向き')
  assertCondition(growingWeekly.conditions, 'revenueGrowth', 'gte', 10)
  assertCondition(growingWeekly.conditions, 'weeklyAStage', 'eq', 2)

  const dividends = await proposal('配当3%以上で3年以上増配')
  assertCondition(dividends.conditions, 'forecastDividendYield', 'gte', 3)
  assertCondition(dividends.conditions, 'consecutiveIncreaseYears', 'gte', 3)

  const structure = await proposal('PBR1倍以下で業種構造が強い')
  assertCondition(structure.conditions, 'pbr', 'lte', 1)
  assertCondition(structure.conditions, 'sectorStructureScore', 'gte', 70)
  assertCondition(structure.conditions, 'pms', 'gt', 0)

  const growthValue = await proposal('成長しているけどPERは20倍以下')
  assertCondition(growthValue.conditions, 'revenueGrowth', 'gte', 10)
  assertCondition(growthValue.conditions, 'epsGrowth', 'gte', 10)
  assertCondition(growthValue.conditions, 'per', 'lte', 20)

  const mixedOperators = await proposal('ROEは10%以上、PERは20倍以下')
  assertCondition(mixedOperators.conditions, 'roe', 'gte', 10)
  assertCondition(mixedOperators.conditions, 'per', 'lte', 20)

  const vague = await proposal('いい感じの株')
  assert.equal(vague.status, 'clarification')
  assert.equal(vague.conditions.length, 0)
  assert.ok(vague.clarificationQuestions.length > 0)

  const unsupported = await proposal('社長が優秀でブランド力が高い会社')
  assert.equal(unsupported.status, 'unsupported')
  assert.equal(unsupported.conditions.length, 0)
  assert.ok(unsupported.unsupportedConcepts.length >= 2)

  const invalid = validateNaturalLanguageConditions([
    { metric: 'unknownMetric', operator: 'gte', value: 1 },
    { metric: 'roe', operator: 'execute_sql', value: 10 },
    { metric: 'weeklyAStage', operator: 'eq', value: 7 },
    { metric: 'market', operator: 'eq', value: 'UNKNOWN' },
    { metric: 'pbr', operator: 'between', value: 2, valueTo: 1 },
  ])
  assert.equal(invalid.conditions.length, 1)
  assert.equal(invalid.errors.length, 4)
  assertCondition(invalid.conditions, 'pbr', 'between', 1)
  assert.equal(invalid.conditions[0].valueTo, 2)

  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.OPENAI_API_KEY
  let requestBody: Record<string, unknown> | null = null
  process.env.OPENAI_API_KEY = 'sk-test-screener-natural-language-contract'
  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    return new Response(JSON.stringify({
      output_text: JSON.stringify({
        conditions: [
          { metric: 'roe', operator: 'gte', value: 12 },
          { metric: 'notRegistered', operator: 'eq', value: 1 },
        ],
        assumptions: [{ term: 'ROEが高い', interpretation: 'ROE >= 12%として提案', conditionMetrics: ['roe'] }],
        unsupportedConcepts: [],
        clarificationQuestions: [],
      }),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    const openAiProposal = await interpretScreenerNaturalLanguage('ROEは12%以上')
    assert.equal(openAiProposal.source, 'openai')
    assert.equal(openAiProposal.conditions.length, 1)
    assertCondition(openAiProposal.conditions, 'roe', 'gte', 12)
    assert.equal(openAiProposal.validationErrors.length, 1)
    const capturedBody = requestBody as Record<string, unknown> | null
    assert.ok(capturedBody)
    assert.equal(capturedBody.store, false)
    assert.ok(Array.isArray(capturedBody.input), 'Responses API input should be role-structured')
  } finally {
    globalThis.fetch = originalFetch
    if (originalApiKey == null) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalApiKey
  }

  console.log(JSON.stringify({
    examples: {
      largeValue: largeValue.conditions,
      growingWeekly: growingWeekly.conditions,
      dividends: dividends.conditions,
      structure: structure.conditions,
      growthValue: growthValue.conditions,
      vague: vague.clarificationQuestions,
      unsupported: unsupported.unsupportedConcepts,
    },
  }))
  console.log('natural-language proposal, ambiguity, unsupported-concept, and schema-validation tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

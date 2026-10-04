import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { paddedNumericDomain } from '@/components/stock/SimilarityComparisonDetail'
import { summarizeStageStability } from '@/components/stock/StageTimeline'
import { compareWithMedian, validValuationPeerValue } from '@/lib/valuation-comparison'

assert.deepEqual(compareWithMedian(15, 10, 'MULTIPLE'), { kind: 'ratio_percent', value: 50 })
assert.deepEqual(compareWithMedian(-5.31, -0.84, 'PERCENT'), { kind: 'percentage_point', value: -4.47 })
assert.deepEqual(compareWithMedian(1.5, -0.5, 'PERCENT'), { kind: 'percentage_point', value: 2 })
assert.deepEqual(compareWithMedian(10, 0, 'MULTIPLE'), { kind: 'absolute_difference', value: 10 })
assert.deepEqual(compareWithMedian(null, 1, 'PERCENT'), { kind: 'unavailable', value: null })
assert.equal(validValuationPeerValue('revenueGrowth', -5.31), true)
assert.equal(validValuationPeerValue('forwardPer', -3), false)

const domain = paddedNumericDomain([-5, 10])
assert.ok(domain[0] < -5 && domain[1] > 10, 'scatter domains must include edge padding')
const flatDomain = paddedNumericDomain([4, 4])
assert.ok(flatDomain[0] < 4 && flatDomain[1] > 4, 'single-value domains must not collapse')

const stageSummary = summarizeStageStability([
  { date: '2026-09-11', daily_a_stage: 2, daily_b_stage: 1, weekly_a_stage: 1, weekly_b_stage: 1, monthly_a_stage: 1, monthly_b_stage: 1, close: 1 },
  { date: '2026-09-18', daily_a_stage: 1, daily_b_stage: 1, weekly_a_stage: 1, weekly_b_stage: 1, monthly_a_stage: 1, monthly_b_stage: 1, close: 1 },
  { date: '2026-09-25', daily_a_stage: 1, daily_b_stage: 1, weekly_a_stage: 1, weekly_b_stage: 1, monthly_a_stage: 1, monthly_b_stage: 1, close: 1 },
])
assert.deepEqual(stageSummary, {
  availableAxes: 6,
  alignedAxes: 6,
  dominantStage: 1,
  transitionCount: 1,
  observationCount: 3,
})

const valuationSource = readFileSync(new URL('../components/stock/ValuationDetail.tsx', import.meta.url), 'utf8')
assert.match(valuationSource, /観測 n=/)
assert.match(valuationSource, /観測期間が限定的/)
assert.match(valuationSource, /percentage_point/)
assert.doesNotMatch(valuationSource, /filter\(\(value\) => value\.availability !== 'missing'\)/)

const similaritySource = readFileSync(new URL('../components/stock/SimilarityComparisonDetail.tsx', import.meta.url), 'utf8')
assert.match(similaritySource, /比較候補が少ないため参考値/)
assert.match(similaritySource, /closestGroup\?\.candidates\.length/)
assert.match(similaritySource, /resolvedRequestRef/)
assert.match(similaritySource, /domain=\{scatterDomains\.x\}/)

const scenarioSource = readFileSync(new URL('../components/stock/ScenarioProjectionChart.tsx', import.meta.url), 'utf8')
assert.match(scenarioSource, /その他のシナリオ \{scenarios\.length - 3\}件/)
assert.match(scenarioSource, /判定不能/)

console.log('stock detail Phase 4 robustness regression passed')

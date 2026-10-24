import assert from 'node:assert/strict'
import { scenarios } from './scenarios/priority-search'

const expected = new Set([
  'jp-screener/compound-filter-sort-page',
  'us-screener/computed-filter-sort-page',
  'integrated-screener/compound-filter',
  'stage-transition/jp-custom-range',
  'stage-transition/us-custom-range',
  'two-year-line/jp-full-api',
  'two-year-line/us-full-api',
  'period-explorer/return-ranking',
  'analog-search/jp-similar-period',
  'analog-search/us-similar-period',
])

assert.deepEqual(new Set(scenarios.map((scenario) => scenario.id)), expected)
for (const scenario of scenarios) {
  assert.equal(scenario.priority, 'A')
  assert.equal(scenario.fixture.id, 'priority-search')
  assert.ok(scenario.normalize, `${scenario.id} must define deterministic normalization`)
  assert.ok(scenario.concurrency?.length, `${scenario.id} must exercise concurrency`)
}
assert.ok(scenarios.some((scenario) => scenario.setup), 'runtime-local sidecars must be exercised')
assert.equal(scenarios.find((scenario) => scenario.id === 'stage-transition/us-custom-range')?.planDatabase, 'usAnalytics')
assert.equal(scenarios.find((scenario) => scenario.id === 'analog-search/jp-similar-period')?.planDatabase, 'analogJp')
assert.equal(scenarios.find((scenario) => scenario.id === 'analog-search/us-similar-period')?.planDatabase, 'analogUs')
console.log('priority search benchmark scenario contract: PASS')

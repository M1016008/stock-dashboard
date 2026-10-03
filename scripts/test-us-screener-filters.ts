import assert from 'node:assert/strict'
import {
  normalizeUsClassificationFilters,
  supportsUsSicClassification,
} from '../lib/us-screener-filters'

assert.equal(supportsUsSicClassification(''), true)
assert.equal(supportsUsSicClassification('Stock'), true)
assert.equal(supportsUsSicClassification('ETF'), false)
assert.equal(supportsUsSicClassification('Mutual Fund'), false)

assert.deepEqual(normalizeUsClassificationFilters({
  assetType: 'Stock',
  sector: 'Retail Trade',
  industryGroup: '59',
  industry: 'Retail-Catalog & Mail-Order Houses',
}), {
  assetType: 'Stock',
  sector: 'Retail Trade',
  industryGroup: '59',
  industry: 'Retail-Catalog & Mail-Order Houses',
})

for (const assetType of ['ETF', 'Mutual Fund']) {
  assert.deepEqual(normalizeUsClassificationFilters({
    assetType,
    sector: 'Retail Trade',
    industryGroup: '59',
    industry: 'Retail-Catalog & Mail-Order Houses',
  }), {
    assetType,
    sector: '',
    industryGroup: '',
    industry: '',
  })
}

console.log('US screener filter normalization tests: ok')

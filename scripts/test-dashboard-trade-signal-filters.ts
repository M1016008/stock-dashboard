import assert from 'node:assert/strict'
import {
  dashboardIndustryOptions,
  dashboardIndustryValue,
} from '@/lib/dashboard-trade-signal-filters'

const rows = [
  { market: 'JP', side: 'buy', industry17: '素材・化学', industry33: '化学' },
  { market: 'JP', side: 'buy', industry17: '電機・精密', industry33: '電気機器' },
  { market: 'JP', side: 'sell', industry17: '小売', industry33: '小売業' },
  { market: 'US', side: 'buy', industry17: 'Technology', industry33: 'Software' },
] as const

assert.deepEqual(
  dashboardIndustryOptions([...rows], 'JP', 'buy', '17'),
  ['素材・化学', '電機・精密'],
  'industry options must only include the active market and candidate side',
)
assert.deepEqual(
  dashboardIndustryOptions([...rows], 'JP', 'sell', '17'),
  ['小売'],
  'switching candidate side must expose only industries with matching rows',
)
assert.deepEqual(
  dashboardIndustryOptions([...rows], 'JP', 'buy', '33'),
  ['化学', '電気機器'],
  'industry level must select the matching taxonomy',
)
assert.deepEqual(
  dashboardIndustryOptions([...rows], 'US', 'buy', '33'),
  ['Software'],
  'market switching must not retain industries from another market',
)
assert.equal(dashboardIndustryValue(rows[0], '17'), '素材・化学')
assert.equal(dashboardIndustryValue(rows[0], '33'), '化学')

console.log('dashboard trade signal industry controls: PASS')

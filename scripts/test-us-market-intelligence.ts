import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildUsMarketIntelligence, rankUsMomentumRows } from '@/lib/server/us-market-intelligence'

const analyticsRows = [
  { ticker: 'AAA', price: 10, volume: 100, change_pct: 2, return_1w: 3, return_1m: 4, pms: 1.2, pfs: 0.8, pes: 0.4, daily_a_stage: 1, daily_b_stage: 1, weekly_a_stage: 2, weekly_b_stage: 2, monthly_a_stage: 3, monthly_b_stage: 3 },
  { ticker: 'BBB', price: 20, volume: 200, change_pct: -1, return_1w: -2, return_1m: -3, pms: 0.7, pfs: -0.6, pes: -0.2, daily_a_stage: 2, daily_b_stage: 2, weekly_a_stage: 3, weekly_b_stage: 3, monthly_a_stage: 4, monthly_b_stage: 4 },
  { ticker: 'CCC', price: 30, volume: 300, change_pct: -3, return_1w: -4, return_1m: -5, pms: -1.4, pfs: -0.9, pes: 1.2, daily_a_stage: 6, daily_b_stage: 6, weekly_a_stage: 5, weekly_b_stage: 5, monthly_a_stage: 4, monthly_b_stage: 4 },
  { ticker: 'DDD', price: 40, volume: 400, change_pct: 0, return_1w: 0, return_1m: 0, pms: 0.5, pfs: null, pes: 0, daily_a_stage: 1, daily_b_stage: 1, weekly_a_stage: 1, weekly_b_stage: 1, monthly_a_stage: 1, monthly_b_stage: 1 },
  { ticker: 'EEE', price: 50, volume: 500, change_pct: 0.5, return_1w: 0.5, return_1m: 0.5, pms: 0.2, pfs: 0.1, pes: 0, daily_a_stage: 1, daily_b_stage: 1, weekly_a_stage: 1, weekly_b_stage: 1, monthly_a_stage: 1, monthly_b_stage: null },
]
const metadataRows = [
  { ticker: 'AAA', name: 'Alpha', exchange: 'NYSE', sector_code: 'MANUFACTURING', sector_name: 'Manufacturing', industry_code: '35', industry_name: 'Industrial Machinery' },
  { ticker: 'BBB', name: 'Beta', exchange: 'NASDAQ', sector_code: 'SERVICES', sector_name: 'Services', industry_code: '73', industry_name: 'Business Services' },
  { ticker: 'CCC', name: 'Gamma', exchange: 'NYSE', sector_code: 'MANUFACTURING', sector_name: 'Manufacturing', industry_code: '35', industry_name: 'Industrial Machinery' },
]

const current = buildUsMarketIntelligence({ latestDate: '2026-10-09', date: '2026-10-09', requestedDate: null, analyticsRows, metadataRows })
assert.equal(current.classificationAvailability, 'CURRENT')
assert.equal(current.rows.length, 5)
assert.equal(current.sectors.length, 2)
assert.equal(current.exchanges.length, 2)
assert.equal(current.coverage.classifiedRows, 3)
assert.equal(current.coverage.stageRows, 4, '6 Stage coverage requires all six axes')
assert.equal(current.lanes.initial[0]?.ticker, 'AAA')
assert.equal(current.lanes.continuation[0]?.ticker, 'AAA')
assert.equal(current.lanes.stall[0]?.ticker, 'BBB')
assert.equal(current.lanes.drop[0]?.ticker, 'CCC')
for (const lane of Object.values(current.lanes)) assert.equal(lane.some((row) => row.ticker === 'DDD'), false, 'missing PFS must not be coerced to zero')
assert.equal(rankUsMomentumRows(current.rows, 'drop')[0]?.ticker, 'CCC')

const historical = buildUsMarketIntelligence({ latestDate: '2026-10-09', date: '2026-09-30', requestedDate: '2026-09-30', analyticsRows, metadataRows })
assert.equal(historical.classificationAvailability, 'CURRENT_DATE_ONLY')
assert.equal(historical.sectors.length, 0, 'current SEC classification must not leak into historical aggregation')
assert.equal(historical.industries.length, 0)
assert.equal(historical.exchanges.length, 0)
assert.equal(historical.rows[0]?.sector, null)
assert.equal(historical.rows[0]?.exchange, null)
assert.equal(historical.coverage.classificationPct, null)

const source = fs.readFileSync('lib/server/us-market-intelligence.ts', 'utf8')
assert.match(source, /execUsAnalyticsAll/, 'US momentum must use the fresh US analytics database')
assert.match(source, /US_SEC_SIC_TAXONOMY/, 'latest classification must use the SEC SIC taxonomy')
assert.match(source, /classificationAvailability: isLatest \? 'CURRENT' : 'CURRENT_DATE_ONLY'/)
assert.doesNotMatch(source, /FROM physical_momentum_metrics[\s\S]{0,300}execAll/, 'physical momentum must not fall back to the primary database')

console.log('US market intelligence contract tests passed')

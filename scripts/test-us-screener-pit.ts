import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  assertUsScreenerHistoricalFilters,
  createUsScreenerPitContract,
  parseUsScreenerRequestedDate,
  UsScreenerPitError,
} from '@/lib/us-screener-pit'

assert.equal(parseUsScreenerRequestedDate(null), null)
assert.equal(parseUsScreenerRequestedDate('2026-10-09'), '2026-10-09')
assert.throws(() => parseUsScreenerRequestedDate('10/09/2026'), UsScreenerPitError)
assert.throws(() => parseUsScreenerRequestedDate('2026-02-30'), UsScreenerPitError)
assert.throws(() => parseUsScreenerRequestedDate('2026-99-99'), UsScreenerPitError)

const latest = createUsScreenerPitContract({
  requestedDate: null,
  resolvedDate: '2026-10-09',
  latestDate: '2026-10-09',
})
assert.equal(latest.mode, 'LATEST')
assert.equal(latest.fields.marketCap, 'CURRENT_REFERENCE')
assert.equal(latest.fields.classification, 'CURRENT_REFERENCE')
assert.equal(latest.fields.earnings, 'CURRENT_REFERENCE')

const historical = createUsScreenerPitContract({
  requestedDate: '2025-01-04',
  resolvedDate: '2025-01-03',
  latestDate: '2026-10-09',
})
assert.equal(historical.mode, 'HISTORICAL')
assert.equal(historical.resolvedDate, '2025-01-03')
assert.equal(historical.fields.price, 'POINT_IN_TIME')
assert.equal(historical.fields.stages, 'POINT_IN_TIME')
assert.equal(historical.fields.marketCap, 'UNAVAILABLE')
assert.equal(historical.fields.classification, 'UNAVAILABLE')
assert.equal(historical.fields.earnings, 'AS_OF_IMPORT_CUTOFF')
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { sector: 'Technology' }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { marketCapMin: 1_000_000 }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.doesNotThrow(() => assertUsScreenerHistoricalFilters(historical, { sort: 'ticker' }))

const route = fs.readFileSync('app/api/us/screener/route.ts', 'utf8')
assert.doesNotMatch(route, /todayInNewYork/)
assert.match(route, /earningsImportCutoff/)
assert.match(route, /imported_at < CAST\(strftime/)
assert.match(route, /pit\.mode === 'HISTORICAL'/)
assert.match(route, /WHEN '\$\{pit\.mode\}' = 'LATEST'/)
assert.doesNotMatch(route, /AND u\.active = 1/)

console.log('US screener PIT contract tests: ok')

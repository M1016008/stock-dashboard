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
assert.equal(historical.fields.earnings, 'UNAVAILABLE')
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { sector: 'Technology' }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { marketCapMin: 1_000_000 }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { exchange: 'NASDAQ' }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { assetType: 'Stock' }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { sort: 'exchange' }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { earningsWindowDays: 30 }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.throws(
  () => assertUsScreenerHistoricalFilters(historical, { sort: 'earningsNextDate' }),
  (error) => error instanceof UsScreenerPitError && error.status === 422,
)
assert.doesNotThrow(() => assertUsScreenerHistoricalFilters(historical, { sort: 'ticker' }))

const route = fs.readFileSync('app/api/us/screener/route.ts', 'utf8')
assert.match(route, /const earningsAnchorDate = pit\.mode === 'LATEST' \? todayInNewYork\(\) : date/)
assert.match(route, /earningsImportCutoff/)
assert.match(route, /const earningsImportCutoff = earningsCoverage\.ok \? '' : 'AND 1 = 0'/)
assert.match(route, /pit\.mode === 'LATEST'[\s\S]*historical_unavailable/)
assert.match(route, /pit\.mode === 'HISTORICAL'/)
assert.match(route, /WHEN '\$\{pit\.mode\}' = 'LATEST'/)
assert.doesNotMatch(route, /AND u\.active = 1/)
assert.doesNotMatch(route, /MAX\(CASE WHEN/)
assert.match(route, /WHERE market = 'US' AND date <= \?/)

const page = fs.readFileSync('app/us/screener/page.tsx', 'utf8')
const client = fs.readFileSync('app/us/screener/UsScreenerClient.tsx', 'utf8')
assert.match(
  page,
  /getUsDashboardAsOfState\(requestedDate\)/,
  'US screener must resolve its initial PIT mode on the server before rendering client filters',
)
assert.match(
  page,
  /Array\.isArray\(params\.date\) \? params\.date\.join\(','\)/,
  'Duplicate date parameters must remain invalid instead of collapsing to latest',
)
assert.match(
  page,
  /initialAsOf=\{\{/,
  'US screener must pass the resolved initial PIT contract to its client',
)
assert.match(page, /availability: asOf\.availability/)
assert.match(page, /earliestDate: asOf\.earliestDate/)
assert.match(
  client,
  /if \(unavailableDateReason\) \{[\s\S]*?setLoading\(false\)[\s\S]*?return[\s\S]*?let cancelled = false/,
  'Malformed and out-of-coverage dates must stop the screener request instead of fetching latest',
)
assert.match(
  client,
  /最新データは代わりに表示していません/,
  'Unavailable date states must explicitly disclose that latest data was not substituted',
)
assert.match(
  client,
  /if \(requestedDate\) sp\.set\('date', requestedDate\)/,
  'US screener must propagate its selected date to the API request',
)
assert.match(
  client,
  /requestedDate !== latestDate/,
  'Selecting the latest known date must not clear current-only filters',
)
assert.match(
  client,
  /href=\{usStockHref\(row\.ticker, linkDate\)\}/,
  'Historical screener result links must preserve the resolved trading date',
)
assert.match(
  client,
  /analysisDate=\{linkDate\}/,
  'Historical screener previews must preserve the resolved trading date',
)

console.log('US screener PIT contract tests: ok')

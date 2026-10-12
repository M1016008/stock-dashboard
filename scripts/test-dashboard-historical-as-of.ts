import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildDashboardAsOfState, isValidDashboardDate } from '@/lib/queries/dashboard-as-of'

const coverage = {
  earliestDate: '2008-05-13',
  latestDate: '2026-10-07',
}

assert.equal(isValidDashboardDate('2026-10-07'), true)
assert.equal(isValidDashboardDate('2026-02-29'), false)
assert.equal(isValidDashboardDate('not-a-date'), false)

assert.deepEqual(
  buildDashboardAsOfState(null, { ...coverage, resolvedDate: '2026-10-07' }),
  {
    requestedDate: null,
    resolvedDate: '2026-10-07',
    earliestDate: '2008-05-13',
    latestDate: '2026-10-07',
    availability: 'available',
    mode: 'latest',
    adjustedToPriorSession: false,
  },
)

assert.deepEqual(
  buildDashboardAsOfState('2010-01-04', { ...coverage, resolvedDate: '2010-01-04' }),
  {
    requestedDate: '2010-01-04',
    resolvedDate: '2010-01-04',
    earliestDate: '2008-05-13',
    latestDate: '2026-10-07',
    availability: 'available',
    mode: 'historical',
    adjustedToPriorSession: false,
  },
)

const nonTrading = buildDashboardAsOfState('2010-01-03', { ...coverage, resolvedDate: '2009-12-30' })
assert.equal(nonTrading.mode, 'historical')
assert.equal(nonTrading.adjustedToPriorSession, true)
assert.equal(nonTrading.resolvedDate, '2009-12-30')

const beforeCoverage = buildDashboardAsOfState('2000-06-01', { ...coverage, resolvedDate: null })
assert.equal(beforeCoverage.mode, 'unavailable')
assert.equal(beforeCoverage.availability, 'before_coverage')
assert.equal(beforeCoverage.resolvedDate, null)

const invalid = buildDashboardAsOfState('2000-99-99', { ...coverage, resolvedDate: null })
assert.equal(invalid.mode, 'unavailable')
assert.equal(invalid.availability, 'invalid')
assert.equal(invalid.resolvedDate, null)

const repoRoot = process.cwd()
const dashboardSource = fs.readFileSync(path.join(repoRoot, 'lib/queries/dashboard.ts'), 'utf8')
assert.doesNotMatch(
  dashboardSource,
  /return row\?\.d \?\? await getLatestDate\(\)/,
  'An explicit historical date must not fall back to the latest Dashboard date',
)

const signalSource = fs.readFileSync(path.join(repoRoot, 'lib/queries/dashboard-trade-signals.ts'), 'utf8')
assert.doesNotMatch(
  signalSource,
  /SELECT COALESCE\([\s\S]{0,180}MAX\(date\)[\s\S]{0,180}MAX\(date\)/,
  'Trade signals must not use a latest-date fallback when no observation exists on or before the request',
)
assert.match(
  signalSource,
  /market\?: DashboardTradeSignalMarket \| 'ALL'/,
  'Dashboard trade candidates must support an explicit JP/US market scope',
)
assert.match(
  signalSource,
  /const historical = date != null/,
  'US trade candidates must distinguish historical requests from latest requests',
)
assert.match(
  signalSource,
  /historical[\s\S]{0,240}\? 'NULL AS sector, NULL AS industry'/,
  'Historical US trade candidates must not reuse current classifications',
)
assert.match(
  signalSource,
  /href: `\$\{row\.href\}\$\{separator\}date=\$\{encodeURIComponent\(row\.date\)\}`/,
  'Historical trade-candidate links must preserve the resolved observation date',
)

const asOfSource = fs.readFileSync(path.join(repoRoot, 'lib/queries/dashboard-as-of.ts'), 'utf8')
assert.match(
  asOfSource,
  /export async function getUsDashboardAsOfState/,
  'US dashboard must expose the same explicit as-of state contract as JP',
)
assert.match(
  asOfSource,
  /FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx[\s\S]{0,100}WHERE market = 'US'/,
  'US dashboard as-of coverage must come from US snapshots only',
)
assert.doesNotMatch(
  asOfSource.slice(asOfSource.indexOf('const readUsDashboardAsOf')),
  /SELECT MIN\(date\)|SELECT MAX\(date\)[\s\S]{0,80}AS latestDate/,
  'US coverage boundaries must use indexed first/last lookups instead of scanning aggregate pairs',
)

const signalTableSource = fs.readFileSync(
  path.join(repoRoot, 'components/dashboard/DashboardTradeSignalTable.tsx'),
  'utf8',
)
const signalClientSource = fs.readFileSync(
  path.join(repoRoot, 'components/dashboard/DashboardTradeSignalTableClient.tsx'),
  'utf8',
)
assert.match(
  signalTableSource,
  /usHistorical=\{market === 'US' && date != null\}/,
  'US historical classification availability must be an explicit server contract',
)
assert.match(
  signalTableSource,
  /previewAnalysisDate=\{market === 'US' \? date : undefined\}/,
  'Latest US dashboard previews must not be mislabeled as historical merely because rows have dates',
)
assert.match(
  signalClientSource,
  /const classificationAvailable = market !== 'US' \|\| !usHistorical/,
  'US classification availability must not be inferred from row contents',
)
assert.match(
  signalClientSource,
  /analysisDate=\{previewAnalysisDate === undefined \? row\.date : previewAnalysisDate\}/,
  'The dashboard must pass its explicit preview date contract through each candidate row',
)

const hexSource = fs.readFileSync(path.join(repoRoot, 'lib/queries/hex.ts'), 'utf8')
assert.match(
  hexSource,
  /return row\?\.d \?\? null/,
  'An explicit historical HEX date before coverage must resolve to unavailable, not latest',
)

console.log('dashboard historical as-of regression PASS')

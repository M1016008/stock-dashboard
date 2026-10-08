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

const hexSource = fs.readFileSync(path.join(repoRoot, 'lib/queries/hex.ts'), 'utf8')
assert.match(
  hexSource,
  /return row\?\.d \?\? null/,
  'An explicit historical HEX date before coverage must resolve to unavailable, not latest',
)

console.log('dashboard historical as-of regression PASS')

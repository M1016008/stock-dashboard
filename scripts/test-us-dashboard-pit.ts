import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

async function main() {
  const incidentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-dashboard-pit-incidents-'))
  process.env.STOCK_DATA_INCIDENT_DIR = incidentDir
  process.once('exit', () => fs.rmSync(incidentDir, { recursive: true, force: true }))

  const [{ getDashboardTradeSignals }, { getUsDashboardAsOfState }] = await Promise.all([
    import('@/lib/queries/dashboard-trade-signals'),
    import('@/lib/queries/dashboard-as-of'),
  ])
  const requestedDate = '2026-10-04'
  const [latestState, historicalState, beforeCoverageState, invalidState] = await Promise.all([
    getUsDashboardAsOfState(null),
    getUsDashboardAsOfState(requestedDate),
    getUsDashboardAsOfState('1900-01-01'),
    getUsDashboardAsOfState('2026-99-99'),
  ])
  assert.equal(latestState.mode, 'latest')
  assert.equal(latestState.resolvedDate, latestState.latestDate)
  assert.equal(historicalState.mode, 'historical')
  assert.equal(historicalState.resolvedDate, '2026-10-02')
  assert.equal(historicalState.adjustedToPriorSession, true)
  assert.equal(beforeCoverageState.mode, 'unavailable')
  assert.equal(beforeCoverageState.availability, 'before_coverage')
  assert.equal(beforeCoverageState.resolvedDate, null)
  assert.equal(invalidState.mode, 'unavailable')
  assert.equal(invalidState.availability, 'invalid')
  assert.equal(invalidState.resolvedDate, null)

  const result = await getDashboardTradeSignals({
    date: requestedDate,
    market: 'US',
    forceRefresh: true,
  })

  assert.equal(result.jpDate, null, 'US-only dashboard query must not read or report a JP date')
  assert.ok(result.usDate, 'historical US dashboard must resolve a trading date')
  assert.ok(result.usDate <= requestedDate, 'resolved US date must not exceed the requested date')
  assert.ok(result.rows.length > 0, 'historical US dashboard must return trade candidates')
  assert.ok(result.rows.every((row) => row.market === 'US'), 'US dashboard must not include JP rows')
  assert.ok(result.rows.every((row) => row.date === result.usDate), 'all candidate rows must use the resolved PIT date')
  assert.ok(
    result.rows.every((row) => row.industry17 === '未分類' && row.industry33 === '未分類'),
    'historical US candidates must not reuse current classifications',
  )
  assert.ok(
    result.rows.every((row) => row.href.includes(`date=${encodeURIComponent(result.usDate!)}`)),
    'historical candidate links must preserve the resolved PIT date',
  )

  console.log(JSON.stringify({
    ok: true,
    requestedDate,
    resolvedDate: result.usDate,
    latestDate: latestState.latestDate,
    earliestDate: latestState.earliestDate,
    beforeCoverage: beforeCoverageState.availability,
    invalidDate: invalidState.availability,
    rows: result.rows.length,
    markets: Array.from(new Set(result.rows.map((row) => row.market))),
    currentClassificationsReused: false,
    datedLinks: result.rows.length,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

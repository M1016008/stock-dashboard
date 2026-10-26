import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { GET as getCurrentSimilars } from '@/app/api/us/ml-current-similars/route'
import { GET as getPredictionHistory } from '@/app/api/us/ml-prediction-history/route'
import { GET as getPhysicsCandidates } from '@/app/api/us/ml-physics-candidates/route'
import { GET as getMlStatus } from '@/app/api/us/ml-status/[ticker]/route'

async function json(response: Response) {
  return await response.json() as Record<string, unknown>
}

async function main() {
  for (const date of ['2026-02-30', '2026-13-01', 'not-a-date']) {
    const similars = await getCurrentSimilars(new NextRequest(`http://localhost/api/us/ml-current-similars?ticker=AAPL&date=${date}`))
    assert.equal(similars.status, 400)
    assert.equal(typeof (await json(similars)).error, 'string')

    const history = await getPredictionHistory(new NextRequest(`http://localhost/api/us/ml-prediction-history?ticker=AAPL&date=${date}`))
    assert.equal(history.status, 400)
    assert.equal(typeof (await json(history)).error, 'string')

    const physics = await getPhysicsCandidates(new NextRequest(`http://localhost/api/us/ml-physics-candidates?date=${date}`))
    assert.equal(physics.status, 400)

    const status = await getMlStatus(
      new NextRequest(`http://localhost/api/us/ml-status/AAPL?date=${date}`),
      { params: Promise.resolve({ ticker: 'AAPL' }) },
    )
    assert.equal(status.status, 400)
  }

  for (const limit of ['0', '13', '1.5', 'NaN']) {
    const response = await getCurrentSimilars(new NextRequest(`http://localhost/api/us/ml-current-similars?ticker=AAPL&limit=${limit}`))
    assert.equal(response.status, 400)
  }
  for (const limit of ['0', '301', '1.5', 'NaN']) {
    const response = await getPredictionHistory(new NextRequest(`http://localhost/api/us/ml-prediction-history?ticker=AAPL&limit=${limit}`))
    assert.equal(response.status, 400)
  }
  for (const query of ['horizon=7', 'direction=sideways', 'limit=0', 'limit=121']) {
    const response = await getPhysicsCandidates(new NextRequest(`http://localhost/api/us/ml-physics-candidates?${query}`))
    assert.equal(response.status, 400)
  }
  assert.equal((await getPhysicsCandidates(new NextRequest('http://localhost/api/us/ml-physics-candidates?date=2026-10-01&date=2026-10-02'))).status, 400)
  assert.equal((await getMlStatus(
    new NextRequest('http://localhost/api/us/ml-status/AAPL?date=2026-10-01&date=2026-10-02'),
    { params: Promise.resolve({ ticker: 'AAPL' }) },
  )).status, 400)
  assert.equal((await getCurrentSimilars(new NextRequest('http://localhost/api/us/ml-current-similars?ticker=AAPL&date=2026-10-01&date=2026-10-02'))).status, 400)
  assert.equal((await getPredictionHistory(new NextRequest('http://localhost/api/us/ml-prediction-history?ticker=AAPL&limit=20&limit=30'))).status, 400)

const currentSimilars = readFileSync('app/api/us/ml-current-similars/route.ts', 'utf8')
assert.match(currentSimilars, /availabilityReason/)
assert.match(currentSimilars, /status: 503/)
assert.match(currentSimilars, /database_busy/)
assert.match(currentSimilars, /schema_unavailable/)

  for (const route of [
    'app/api/us/quote/[ticker]/route.ts',
    'app/api/us/history/[ticker]/route.ts',
  ]) {
    const source = readFileSync(route, 'utf8')
    assert.doesNotMatch(source, /message:\s*\(error as Error\)\.message/)
  }

  const scenarioRoute = readFileSync('app/api/stock-scenario-projections/[ticker]/route.ts', 'utf8')
  assert.match(scenarioRoute, /market === 'US'[\s\S]{0,160}Tiingo由来の調整後価格データ/)
  assert.match(scenarioRoute, /error: 'invalid_date'/)
  assert.doesNotMatch(scenarioRoute, /stock_scenario_projections_failed', message:/)

  console.log('US API date, availability, and error contracts: PASS')
}

void main()

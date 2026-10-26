import assert from 'node:assert/strict'
import {
  fetchFmpCompanyProfile,
  fetchFmpEarningsCalendar,
  isFmpDisplayLicenseApproved,
  normalizeFmpCompanyProfile,
  normalizeFmpEarningsCalendar,
} from '@/lib/fmp'

const earnings = normalizeFmpEarningsCalendar([
  {
    symbol: 'AAPL',
    date: '2026-07-30',
    epsActual: null,
    epsEstimated: 1.88,
    revenueActual: null,
    revenueEstimated: 109_038_900_000,
    lastUpdated: '2026-07-29',
  },
  {
    symbol: 'MSFT',
    date: '2026-07-31',
    epsActual: 3.1,
    epsEstimated: 3.0,
  },
  { symbol: 'INVALID', date: 'not-a-date' },
])

assert.equal(earnings.length, 2)
assert.equal(earnings[0]?.timeBucket, 'unknown')
assert.equal(earnings[0]?.scheduleStatus, 'provider_scheduled_unverified')
assert.equal(earnings[0]?.sourceUpdatedAt, '2026-07-29')
assert.equal(earnings[1]?.scheduleStatus, 'reported')

const profiles = normalizeFmpCompanyProfile([{
  symbol: 'aapl',
  companyName: 'Apple Inc.',
  cik: '0000320193',
  exchange: 'NASDAQ',
  exchangeFullName: 'NASDAQ Global Select',
  sector: 'Technology',
  industry: 'Consumer Electronics',
  currency: 'USD',
}])
assert.equal(profiles[0]?.ticker, 'AAPL')
assert.equal(profiles[0]?.taxonomy, 'FMP_CUSTOM')
assert.equal(profiles[0]?.historicalPitAvailable, false)

assert.equal(isFmpDisplayLicenseApproved({}), false)
assert.equal(isFmpDisplayLicenseApproved({ FMP_DISPLAY_LICENSE_APPROVED: '1' }), true)

async function testFetchContracts() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    assert.equal(url.searchParams.get('apikey'), 'fixture-fmp-key')
    if (url.pathname.endsWith('/earnings-calendar')) {
      assert.equal(url.searchParams.get('includeReportTimes'), 'true')
      if (url.searchParams.get('from') === '2026-09-01') {
        return Response.json(Array.from({ length: 4_000 }, () => ({ symbol: 'AAPL', date: '2026-09-01' })))
      }
      return Response.json([{ symbol: 'AAPL', date: '2026-08-01' }])
    }
    assert.equal(url.pathname.endsWith('/profile'), true)
    assert.equal(url.searchParams.get('symbol'), 'AAPL')
    return Response.json([{ symbol: 'AAPL', sector: 'Technology' }])
  }
  try {
    const environment = { FMP_API_KEY: 'fixture-fmp-key', FMP_DISPLAY_LICENSE_APPROVED: '1' }
    assert.equal((await fetchFmpEarningsCalendar('2026-08-01', '2026-08-02', environment))[0]?.ticker, 'AAPL')
    assert.equal((await fetchFmpCompanyProfile('AAPL', environment))[0]?.taxonomy, 'FMP_CUSTOM')
    await assert.rejects(
      () => fetchFmpEarningsCalendar('2026-01-01', '2026-05-01', environment),
      /90-day maximum/,
    )
    await assert.rejects(
      () => fetchFmpCompanyProfile('AAPL', { FMP_API_KEY: 'fixture-fmp-key' }),
      /display\/redistribution rights are not approved/,
    )
    await assert.rejects(
      () => fetchFmpEarningsCalendar('2026-09-01', '2026-09-02', environment),
      /potentially truncated calendar/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
}

testFetchContracts()
  .then(() => console.log('FMP disconnected adapter contract tests: PASS'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

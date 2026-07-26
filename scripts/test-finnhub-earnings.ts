import assert from 'node:assert/strict'
import {
  fetchFinnhubEarningsCalendar,
  finnhubEarningsTimeBucket,
  normalizeFinnhubEarningsHour,
  parseFinnhubEarningsResponse,
} from '@/lib/finnhub'

const events = parseFinnhubEarningsResponse({
  earningsCalendar: [
    {
      date: '2026-07-30',
      symbol: 'AAPL',
      hour: 'amc',
      year: 2026,
      quarter: 3,
      epsEstimate: 1.42,
      epsActual: null,
      revenueEstimate: 94_100_000_000,
      revenueActual: null,
    },
    {
      date: '2026-07-31',
      symbol: 'BRK.B',
      hour: 'BMO',
      year: '2026',
      quarter: '2',
      epsEstimate: '',
    },
    { date: 'invalid', symbol: 'INVALID' },
  ],
})

assert.equal(events.length, 2)
assert.equal(events[0]?.symbol, 'AAPL')
assert.equal(events[0]?.hour, 'amc')
assert.equal(events[0]?.epsEstimate, 1.42)
assert.equal(events[1]?.symbol, 'BRK.B')
assert.equal(events[1]?.hour, 'bmo')
assert.equal(events[1]?.year, 2026)
assert.equal(events[1]?.epsEstimate, null)

assert.equal(normalizeFinnhubEarningsHour('DMH'), 'dmh')
assert.equal(normalizeFinnhubEarningsHour('unknown'), null)
assert.equal(finnhubEarningsTimeBucket('bmo'), 'before_open')
assert.equal(finnhubEarningsTimeBucket('dmh'), 'market_hours')
assert.equal(finnhubEarningsTimeBucket('amc'), 'after_close')
assert.equal(finnhubEarningsTimeBucket(null), 'unknown')

assert.throws(
  () => parseFinnhubEarningsResponse({}),
  /earningsCalendar array/,
)

async function testSecureFetch() {
  const originalFetch = globalThis.fetch
  process.env.FINNHUB_API_KEY = 'test-finnhub-key'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    assert.equal(url.includes('token='), false)
    assert.equal(new Headers(init?.headers).get('X-Finnhub-Token'), 'test-finnhub-key')
    return new Response(JSON.stringify({
      earningsCalendar: [{ date: '2026-08-01', symbol: 'MSFT', hour: 'amc' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    const fetched = await fetchFinnhubEarningsCalendar('2026-08-01', '2026-08-02')
    assert.equal(fetched[0]?.symbol, 'MSFT')
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.FINNHUB_API_KEY
  }
}

testSecureFetch()
  .then(() => console.log('Finnhub earnings parser tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })

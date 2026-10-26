// SMA Dynamics Lab link contract: the URL a producer (six-stage current candidates) builds and
// the lab parses. Pure: no database, API, network or Production data. The synthetic six-stage
// rows below model the structural producer contract without importing research runtime code.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  addSmaLabPeriodsFromText,
  isSmaLabPeriod,
  normalizeSmaLabPeriods,
  parseSmaLabPeriodText,
  smaLabColor,
  SMA_LAB_MAX_SELECTED_PERIODS,
} from '@/lib/sma-dynamics-lab'
import {
  buildSmaDynamicsLink,
  closestSmaPair,
  linkIntentToSettingsPatch,
  normalizeLinkTicker,
  parseSmaDynamicsLink,
  sixStageCandidateLinkRequest,
  SMA_LINK_PARAMS,
  type SmaLinkIntent,
} from '@/lib/sma-dynamics-link'

const read = (path: string) => readFileSync(path, 'utf8')

// ---------------------------------------------------------------------------
// Ticker normalization per market
assert.equal(normalizeLinkTicker('JP', '7203.T'), '7203')
assert.equal(normalizeLinkTicker('JP', ' 285a '), '285A')
assert.equal(normalizeLinkTicker('JP', 'AAPL'), null, 'a US symbol is not a JP security')
assert.equal(normalizeLinkTicker('JP', '72030'), null)
assert.equal(normalizeLinkTicker('US', 'brk-b'), 'BRK-B')
assert.equal(normalizeLinkTicker('US', '../etc'), null, 'path characters never reach the URL')
assert.equal(normalizeLinkTicker('US', ''), null)

// ---------------------------------------------------------------------------
// Build -> parse round trip
{
  const built = buildSmaDynamicsLink({
    market: 'JP',
    ticker: '7203.T',
    origin: 'six-stage-current',
    asOfTradingDate: '2026-10-23',
    sourceGeneration: 'fixture-jp-serving-20261023-v1',
    timeframe: '1D',
    periods: [75, 5, 25, 25, 7],
    mode: 'freeze',
    horizon: 5,
    pair: [75, 25],
  })
  assert.ok(built.ok)
  assert.equal(built.target, 'stock-detail')
  assert.ok(built.href.startsWith('/stock/7203?'), built.href)
  assert.ok(built.href.endsWith('#chart'), 'the detail page opens its chart tab from the hash')
  const url = new URL(built.href, 'https://stockboard.invalid')
  assert.equal(url.searchParams.get(SMA_LINK_PARAMS.open), '1')
  assert.equal(url.searchParams.get(SMA_LINK_PARAMS.periods), '5,7,25,75', 'periods are normalized and sorted')
  assert.equal(url.searchParams.get(SMA_LINK_PARAMS.pair), '25-75', 'pair is ordered short-long')
  const intent = parseSmaDynamicsLink(url.search)!
  assert.deepEqual(intent, {
    origin: 'six-stage-current',
    asOfTradingDate: '2026-10-23',
    sourceGeneration: 'fixture-jp-serving-20261023-v1',
    timeframe: '1D',
    periods: [5, 7, 25, 75],
    mode: 'freeze',
    horizon: 5,
    pair: [25, 75],
  } satisfies SmaLinkIntent)

  const us = buildSmaDynamicsLink({ market: 'US', ticker: 'aapl', timeframe: '1W', mode: 'solver' })
  assert.ok(us.ok && us.href.startsWith('/us/stock/AAPL?smalab=1&smatf=1W&smamode=solver'), us.ok ? us.href : '')

  // Extended timeframes round-trip too.
  for (const timeframe of ['5D', '3W', '2M', '6M', '1Y', '2Y', '3Y', '5Y'] as const) {
    const link = buildSmaDynamicsLink({ market: 'US', ticker: 'MSFT', timeframe })
    assert.ok(link.ok)
    assert.equal(parseSmaDynamicsLink(new URL(link.href, 'https://x.invalid').search)?.timeframe, timeframe)
  }
}

// ---------------------------------------------------------------------------
// Parsing is strict: every bad field is dropped on its own, nothing is guessed
{
  assert.equal(parseSmaDynamicsLink(''), null, 'no smalab=1 -> the page is untouched')
  assert.equal(parseSmaDynamicsLink('?date=2026-10-01&actual=1'), null)
  assert.equal(parseSmaDynamicsLink('?smalab=0'), null)
  assert.equal(parseSmaDynamicsLink('?smalab=true'), null)
  const hostile = parseSmaDynamicsLink('?smalab=1&smatf=9X&smap=2,3,300,301,5.5,abc,-4,7&smamode=evil&smah=999&smapair=5-5&smasrc=other&smaasof=2026-02-30&smagen=<script>')!
  assert.deepEqual(hostile, {
    origin: null,
    asOfTradingDate: null,
    sourceGeneration: null,
    timeframe: null,
    periods: [3, 7, 300],
    mode: null,
    horizon: null,
    pair: null,
  } satisfies SmaLinkIntent)
  assert.equal(parseSmaDynamicsLink('?smalab=1&smatf=1D&smah=21')!.horizon, null, 'horizon beyond 20 bars is dropped')
  assert.equal(parseSmaDynamicsLink('?smalab=1&smatf=5Y&smah=9')!.horizon, null, '5Y cannot project 9 bars')
  assert.equal(parseSmaDynamicsLink('?smalab=1&smatf=5Y&smah=8')!.horizon, 8)
  assert.equal(parseSmaDynamicsLink('?smalab=1&smah=3')!.horizon, 3, 'without a timeframe the default 20-bar limit applies')
  assert.deepEqual(parseSmaDynamicsLink('?smalab=1&smapair=300-3')!.pair, [3, 300])
  assert.equal(parseSmaDynamicsLink('?smalab=1&smapair=2-300')!.pair, null, 'SMA2 is out of range')
  assert.equal(parseSmaDynamicsLink(`?smalab=1&smap=${Array.from({ length: 40 }, (_, i) => i + 3).join(',')}`)!.periods.length, SMA_LAB_MAX_SELECTED_PERIODS)

  // Builder rejects what the parser would reject.
  assert.deepEqual(buildSmaDynamicsLink({ market: 'JP', ticker: 'AAPL' }), { ok: false, reason: 'invalid_ticker' })
  assert.deepEqual(buildSmaDynamicsLink({ market: 'JP', ticker: '7203', target: 'dev-preview' }), { ok: false, reason: 'invalid_fixture' })
  assert.deepEqual(buildSmaDynamicsLink({ market: 'JP', ticker: '7203', target: 'dev-preview', fixtureId: '../x' }), { ok: false, reason: 'invalid_fixture' })
  const sanitized = buildSmaDynamicsLink({ market: 'US', ticker: 'AAPL', periods: [2, 5, 301], horizon: 99, timeframe: '1D', sourceGeneration: 'bad gen', asOfTradingDate: 'nope', pair: [5, 5] })
  assert.ok(sanitized.ok)
  assert.equal(sanitized.href, '/us/stock/AAPL?smalab=1&smatf=1D&smap=5#chart')
}

// ---------------------------------------------------------------------------
// Settings patch
{
  assert.deepEqual(linkIntentToSettingsPatch(parseSmaDynamicsLink('?smalab=1')!), {})
  assert.deepEqual(linkIntentToSettingsPatch(parseSmaDynamicsLink('?smalab=1&smatf=3W&smap=5,25&smamode=solver&smah=4&smapair=75-150')!), {
    timeframe: '3W',
    periods: [5, 25, 75, 150],
    analysis: 'solver',
    horizon: 4,
  })
}

// ---------------------------------------------------------------------------
// Six-stage current candidates (isolated structural fixtures)
{
  const rows = [
    {
      market: 'JP' as const,
      ticker: '7203',
      asOfTradingDate: '2022-12-30',
      sourceGeneration: 'fixture-jp-v1',
      smaShape: { pairDistance: { sma25To75: 0.4, sma75To150: -0.1, sma150To200: null, sma200To300: 0.2 } },
    },
    {
      market: 'US' as const,
      ticker: 'AAPL',
      asOfTradingDate: '2022-12-30',
      sourceGeneration: 'fixture-us-v1',
      smaShape: { pairDistance: { sma25To75: null, sma75To150: 0.3, sma150To200: 0.15, sma200To300: 0.5 } },
    },
  ]
  for (const row of rows) {
    const request = sixStageCandidateLinkRequest(row)
    assert.equal(request.target, 'stock-detail')
    assert.equal(request.origin, 'six-stage-current')
    assert.equal(request.asOfTradingDate, row.asOfTradingDate)
    assert.equal(request.sourceGeneration, row.sourceGeneration)
    assert.equal(request.timeframe, '1D')
    assert.deepEqual([...request.periods!], [5, 25, 75, 150, 200, 300])
    const pair = closestSmaPair(row)
    // The pair is the adjacent long-term pair with the smallest known |distance|.
    const distances = Object.entries(row.smaShape.pairDistance).filter(([, value]) => value != null).map(([key, value]) => [key, Math.abs(value as number)] as const)
    if (distances.length === 0) assert.equal(pair, null)
    else {
      const min = Math.min(...distances.map(([, value]) => value))
      const expected = distances.find(([, value]) => value === min)![0]
      const names = { sma25To75: [25, 75], sma75To150: [75, 150], sma150To200: [150, 200], sma200To300: [200, 300] } as const
      assert.deepEqual(pair, names[expected as keyof typeof names])
    }

    // Production-safe: a fixture projection links only to the fixture-only preview, never to a stock page.
    const fixtureLink = buildSmaDynamicsLink(sixStageCandidateLinkRequest(row, { fixtureId: row.market === 'JP' ? 'jp-rising' : 'us-falling' }))
    assert.ok(fixtureLink.ok)
    assert.equal(fixtureLink.target, 'dev-preview')
    assert.ok(fixtureLink.href.startsWith('/dev/sma-dynamics?fixture='), fixtureLink.href)
    assert.ok(!fixtureLink.href.includes(row.ticker) || row.ticker.length < 2, 'the synthetic ticker is not carried into the URL path')

    const link = buildSmaDynamicsLink(request)
    if (link.ok) {
      const parsed = parseSmaDynamicsLink(new URL(link.href, 'https://x.invalid').search)!
      assert.equal(parsed.asOfTradingDate, row.asOfTradingDate)
      assert.equal(parsed.sourceGeneration, row.sourceGeneration)
      assert.equal(parsed.origin, 'six-stage-current')
      assert.deepEqual(parsed.pair, pair)
    }
  }
  assert.equal(closestSmaPair({ smaShape: { pairDistance: { sma25To75: null, sma75To150: null, sma150To200: null, sma200To300: null } } }), null)
  assert.deepEqual(closestSmaPair({ smaShape: { pairDistance: { sma25To75: 0.4, sma75To150: -0.1, sma150To200: null, sma200To300: 0.2 } } }), [75, 150], 'sign is ignored: closeness is |distance|')
}

// ---------------------------------------------------------------------------
// Custom periods (3..300) used by links and the period input
{
  assert.ok(isSmaLabPeriod(3) && isSmaLabPeriod(300) && isSmaLabPeriod(117))
  for (const bad of [2, 301, 7.5, -3, Number.NaN, '5', null]) assert.equal(isSmaLabPeriod(bad), false, String(bad))
  assert.deepEqual(normalizeSmaLabPeriods([30, 4, 30, 2, 400, 300]), [4, 30, 300])
  assert.deepEqual(parseSmaLabPeriodText('７, 20 21、120,abc,0,301,7.5'), { periods: [7, 20, 21, 120], rejected: ['abc', '0', '301', '7.5'] })
  assert.deepEqual(parseSmaLabPeriodText('  '), { periods: [], rejected: [] })
  const added = addSmaLabPeriodsFromText([5, 25], '25, 7, 200, x')
  assert.deepEqual(added.periods, [5, 7, 25, 200])
  assert.deepEqual(added.added, [7, 200], 'already selected periods are not "added"')
  assert.deepEqual(added.rejected, ['x'])
  const full = addSmaLabPeriodsFromText(Array.from({ length: SMA_LAB_MAX_SELECTED_PERIODS }, (_, i) => i + 3), '250')
  assert.deepEqual(full.added, [])
  assert.deepEqual(full.overflow, [250], 'the line limit holds')
  assert.equal(smaLabColor(25), '#2563eb', 'presets keep the shared palette')
  assert.equal(smaLabColor(117), smaLabColor(117), 'custom colors are stable per period')
  assert.notEqual(smaLabColor(117), smaLabColor(118))
}

// ---------------------------------------------------------------------------
// Source contract: the receiver and builder are pure; no data access from the link module
{
  const lib = read('lib/sma-dynamics-link.ts')
  assert.doesNotMatch(lib, /fetch\(|@\/lib\/db|@\/lib\/queries|process\.env|Math\.random|Date\.now|new Date\(\)|@\/lib\/research|@\/lib\/server/)
  const hook = read('components/stock/sma-dynamics/useSmaLinkIntent.ts')
  assert.match(hook, /useEffect\(/)
  assert.doesNotMatch(hook, /fetch\(/)
  const proxy = read('proxy.ts')
  assert.doesNotMatch(proxy, /smalab|sma-dynamics-link/, 'the link carries no server-side behaviour')
}

console.log('test-sma-dynamics-link: ok')

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import type { TriggerDiscoveryFilteredCandidate } from '@/lib/server/trigger-discovery-read-model'
import {
  groupUsGenericRows,
  loadUsGenericMaObservations,
  usGenericMaWindow,
  usMarketMonthEndLookups,
  usMonthEndGroupMatchesGeneric,
  type UsGenericMaQuery,
} from '@/lib/server/us-trigger-discovery'
import { daysBetween } from '@/lib/snapshots/continuous-ma'

const AS_OF = '2026-10-09'
const MARKET_HOLIDAYS = new Set(['2025-12-25', '2026-01-01', '2026-07-03'])

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function marketSessions(from: string, through: string): string[] {
  const sessions: string[] = []
  for (let date = from; date <= through; date = addDays(date, 1)) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    if (weekday !== 0 && weekday !== 6 && !MARKET_HOLIDAYS.has(date)) sessions.push(date)
  }
  return sessions
}

function lastSessionOfMonth(sessions: readonly string[], monthKey: string): string {
  const inMonth = sessions.filter((date) => date.startsWith(monthKey))
  return inMonth[inMonth.length - 1]
}

function candidate(ticker: string, priceDate: string): TriggerDiscoveryFilteredCandidate {
  return {
    ticker,
    companyName: ticker,
    market: null,
    priceDate,
    price: 1,
    averageVolume: null,
    averageTradingValue: null,
    liquidityObservationCount: 0,
    priceStalenessSessions: 0,
    priceFreshness: 'CURRENT',
    liquidityComplete: false,
  }
}

function plainObservations(value: Map<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...value.entries()].sort(([left], [right]) => left.localeCompare(right)))
}

export async function runUsTriggerDiscoveryMaParityTests(): Promise<void> {
  // --- Pure helper coverage -------------------------------------------------
  const lookups = usMarketMonthEndLookups('2024-03-17', '2024-06-05')
  assert.deepEqual(lookups, [
    { monthKey: '2024-03', fromDate: '2024-03-17', throughDate: '2024-03-31' },
    { monthKey: '2024-04', fromDate: '2024-04-01', throughDate: '2024-04-31' },
    { monthKey: '2024-05', fromDate: '2024-05-01', throughDate: '2024-05-31' },
  ], 'month-end lookups stop before the newest price month and clip the first month')
  assert.deepEqual(usMarketMonthEndLookups('2024-11-20', '2025-02-01').map((lookup) => lookup.monthKey), [
    '2024-11', '2024-12', '2025-01',
  ], 'month-end lookups roll over year boundaries')

  const window = usGenericMaWindow([{ priceDate: '2026-10-09' }, { priceDate: '2026-08-14' }], 15, 5)
  assert.deepEqual(window, {
    historyStart: addDays('2026-08-14', -(15 * 32 + 160 + 5 * 4)),
    recentStart: addDays('2026-08-14', -(5 * 4 + 30)),
  }, 'window is derived from the oldest candidate price_date')

  const row = (ticker: string, date: string, close: number, isRecent: number) => ({
    ticker, date, open: close, high: close, low: close, close, volume: 1, is_recent: isRecent,
  })
  const deduped = groupUsGenericRows([
    row('A', '2026-08-31', 10, 0),
    row('A', '2026-08-31', 10, 1),
    row('A', '2026-09-30', 11, 0),
    row('A', '2026-10-01', 12, 1),
  ]).get('A')!
  assert.deepEqual([...deduped.byDate.keys()], ['2026-08-31', '2026-09-30', '2026-10-01'])
  assert.deepEqual([...deduped.recentDates], ['2026-08-31', '2026-10-01'])

  const monthEnds = [
    { monthKey: '2026-07', date: '2026-07-31' },
    { monthKey: '2026-08', date: '2026-08-31' },
    { monthKey: '2026-09', date: '2026-09-30' },
  ]
  assert.equal(usMonthEndGroupMatchesGeneric(deduped, '2026-10-01', monthEnds), false,
    'missing a completed market month-end must fall back')
  assert.equal(usMonthEndGroupMatchesGeneric(deduped, '2026-10-01', monthEnds.slice(1)), true)
  assert.equal(usMonthEndGroupMatchesGeneric(deduped, '2026-10-02', monthEnds.slice(1)), false,
    'latest recent row must equal the candidate price_date')
  assert.equal(usMonthEndGroupMatchesGeneric(deduped, '2026-09-30', monthEnds), false,
    'recent rows must include the candidate price_date')
  assert.equal(usMonthEndGroupMatchesGeneric(undefined, '2026-10-01', monthEnds), false)
  const marketGap = groupUsGenericRows([
    row('B', '2026-06-01', 10, 0),
    row('B', '2026-08-31', 11, 0),
    row('B', '2026-09-01', 12, 1),
  ]).get('B')!
  assert.equal(usMonthEndGroupMatchesGeneric(marketGap, '2026-09-01', [
    { monthKey: '2026-06', date: '2026-06-01' },
    { monthKey: '2026-07', date: null },
    { monthKey: '2026-08', date: '2026-08-31' },
  ]), false, 'a >60-day gap between month-end rows must fall back')

  // --- Fixture DB parity ----------------------------------------------------
  const directory = mkdtempSync(path.join(tmpdir(), 'us-trigger-ma-parity-'))
  const client = createClient({ url: `file:${path.join(directory, 'fixture.db')}` })
  try {
    await client.executeMultiple(`
      CREATE TABLE market_ohlcv_daily (
        market TEXT NOT NULL,
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        adj_open REAL,
        adj_high REAL,
        adj_low REAL,
        adj_close REAL,
        volume INTEGER NOT NULL,
        adj_volume INTEGER,
        PRIMARY KEY (market, ticker, date)
      );
      CREATE INDEX market_ohlcv_market_date_idx ON market_ohlcv_daily(market, date);
      CREATE INDEX market_ohlcv_market_date_ticker_idx ON market_ohlcv_daily(market, date, ticker);
      CREATE INDEX market_ohlcv_market_ticker_date_idx ON market_ohlcv_daily(market, ticker, date);
    `)

    const sessions = marketSessions('2022-01-03', AS_OF)
    const monthEndSet = new Set(
      [...new Set(sessions.map((date) => date.slice(0, 7)))].map((monthKey) => lastSessionOfMonth(sessions, monthKey)),
    )
    const gap60Start = '2026-02-02'
    const gap60End = '2026-04-03'
    const gap61Start = '2026-02-05'
    const gap61End = '2026-04-07'
    assert.equal(daysBetween(gap60Start, gap60End), 60)
    assert.equal(daysBetween(gap61Start, gap61End), 61)
    const fixtures: Record<string, (date: string) => boolean> = {
      CONT: () => true,
      NULLADJ: () => true,
      MIDGAP: (date) => !(date >= '2026-05-11' && date <= '2026-05-22'),
      MISSME: (date) => date !== lastSessionOfMonth(sessions, '2026-03'),
      GAP60: (date) => date <= gap60Start || date >= gap60End,
      GAP61: (date) => date <= gap61Start || date >= gap61End,
      LIST: (date) => date >= '2026-01-15',
      STALE: (date) => date <= '2026-08-14',
      STALECUT: () => true,
    }
    const statements: Array<{ sql: string; args: Array<string | number | null> }> = []
    const insertedCloses = new Map<string, number>()
    for (const [tickerIndex, [ticker, trades]] of Object.entries(fixtures).entries()) {
      sessions.forEach((date, index) => {
        if (!trades(date)) return
        const close = Math.round((50 + tickerIndex * 7 + 12 * Math.sin(index / 9 + tickerIndex) + index / 40) * 100) / 100
        const nullAdjusted = ticker === 'NULLADJ' && (monthEndSet.has(date) || index % 3 === 0)
        const adj = (value: number) => nullAdjusted ? null : Math.round(value * 0.97 * 100) / 100
        insertedCloses.set(`${ticker}|${date}`, adj(close) ?? close)
        statements.push({
          sql: `INSERT INTO market_ohlcv_daily VALUES ('US', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            ticker, date, close - 0.5, close + 1, close - 1, close,
            adj(close - 0.5), adj(close + 1), adj(close - 1), adj(close),
            1_000 + index, nullAdjusted ? null : 900 + index,
          ],
        })
      })
    }
    // Rows outside the US market and after AS_OF must never leak into either path.
    statements.push({
      sql: `INSERT INTO market_ohlcv_daily VALUES ('JP', 'CONT', '2026-09-29', 1, 1, 1, 1, NULL, NULL, NULL, NULL, 1, NULL)`,
      args: [],
    })
    await client.batch(statements, 'write')

    const query: UsGenericMaQuery = async <T,>(sql: string, args: Array<string | number>) => (
      (await client.execute({ sql, args })).rows as unknown as T[]
    )
    const priceDates = await query<{ ticker: string; price_date: string }>(`
      SELECT ticker, MAX(date) AS price_date FROM market_ohlcv_daily
      WHERE market = 'US' AND date <= ? GROUP BY ticker ORDER BY ticker
    `, [AS_OF])
    const candidates = [
      ...priceDates.map((entry) => candidate(entry.ticker, entry.price_date)).filter((entry) => entry.ticker !== 'STALECUT'),
      candidate('STALECUT', '2026-07-15'),
      candidate('NOROWS', AS_OF),
    ]
    assert.equal(candidates.find((entry) => entry.ticker === 'STALE')?.priceDate, '2026-08-14')

    const expectedFallback = ['GAP60', 'GAP61', 'LIST', 'MISSME', 'NOROWS']
    const configs = [
      { ma1Period: 20, ma2Period: 25, requiredObservations: 5 },
      { ma1Period: 15, ma2Period: 25, requiredObservations: 1 },
      { ma1Period: 3, ma2Period: 15, requiredObservations: 30 },
      { ma1Period: 5, ma2Period: 10, requiredObservations: 60 },
    ]
    for (const config of configs) {
      const legacy = await loadUsGenericMaObservations({ candidates, ...config }, query, { legacyOnly: true })
      const optimized = await loadUsGenericMaObservations({ candidates, ...config }, query)
      const label = JSON.stringify(config)
      assert.deepEqual(plainObservations(optimized.value), plainObservations(legacy.value),
        `month-end path must match legacy generic path exactly ${label}`)
      assert.deepEqual([...optimized.fallbackTickers].sort(), expectedFallback, `fallback set ${label}`)
      assert.equal(legacy.queryCount, 1)
      assert.equal(optimized.queryCount, 3, 'month-end lookup + month-end rows + legacy fallback')

      for (const ticker of ['CONT', 'NULLADJ', 'STALE', 'STALECUT', 'MIDGAP', 'GAP60', 'GAP61', 'LIST', 'MISSME']) {
        const observations = optimized.value.get(ticker) ?? []
        const own = candidates.find((entry) => entry.ticker === ticker)!
        assert.ok(observations.every((point) => point.date <= own.priceDate), `${ticker} respects its own price_date ${label}`)
      }
      for (const ticker of ['CONT', 'NULLADJ', 'STALE', 'STALECUT', 'MIDGAP']) {
        const observations = optimized.value.get(ticker) ?? []
        assert.equal(observations.length, config.requiredObservations, `${ticker} has complete observations ${label}`)
        assert.equal(observations.at(-1)?.date, candidates.find((entry) => entry.ticker === ticker)!.priceDate)
      }
      assert.equal(optimized.value.has('NOROWS'), false)
    }

    // 60-day gaps stay continuous while 61-day gaps restart the monthly MA segment.
    const gapResult = await loadUsGenericMaObservations({
      candidates, ma1Period: 3, ma2Period: 8, requiredObservations: 1,
    }, query)
    assert.equal(gapResult.value.get('GAP60')?.length, 1, '60-day gap keeps one continuous segment')
    assert.deepEqual(gapResult.value.get('GAP61'), [], '61-day gap restarts the segment (Apr-Oct < 8 months)')

    // NULL adjusted values fall back to raw OHLCV via COALESCE on the month-end path.
    const nullAdjResult = await loadUsGenericMaObservations({
      candidates, ma1Period: 3, ma2Period: 15, requiredObservations: 30,
    }, query)
    assert.equal(nullAdjResult.fallbackTickers.includes('NULLADJ'), false)
    const nullAdjPoints = nullAdjResult.value.get('NULLADJ') ?? []
    assert.equal(nullAdjPoints.length, 30)
    assert.ok(nullAdjPoints.some((point) => monthEndSet.has(point.date)), 'window includes a NULL-adjusted month-end')
    for (const point of nullAdjPoints) {
      assert.equal(point.price, insertedCloses.get(`NULLADJ|${point.date}`))
    }

    // A ticker without any month-end coverage in a lone chunk still runs the legacy path.
    const onlyFallback = await loadUsGenericMaObservations({
      candidates: [candidates.find((entry) => entry.ticker === 'LIST')!],
      ma1Period: 15,
      ma2Period: 20,
      requiredObservations: 3,
    }, query)
    const onlyLegacy = await loadUsGenericMaObservations({
      candidates: [candidates.find((entry) => entry.ticker === 'LIST')!],
      ma1Period: 15,
      ma2Period: 20,
      requiredObservations: 3,
    }, query, { legacyOnly: true })
    assert.deepEqual(onlyFallback.fallbackTickers, ['LIST'])
    assert.deepEqual(plainObservations(onlyFallback.value), plainObservations(onlyLegacy.value))
  } finally {
    client.close()
    rmSync(directory, { recursive: true, force: true })
  }

  console.log('US Trigger Discovery generic MA parity tests passed')
}

if (process.argv[1]?.endsWith('test-us-trigger-discovery-ma-parity.ts')) {
  runUsTriggerDiscoveryMaParityTests().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

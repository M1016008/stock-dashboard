import assert from 'node:assert/strict'
import { execAll } from '@/lib/db/client'
import {
  createTriggerDiscoverySqlDataSource,
  getTriggerDiscovery,
  type TriggerDiscoveryFilteredCandidate,
} from '@/lib/server/trigger-discovery-read-model'
import { calendarWeekBucket } from '@/lib/timeframes'
import type { OHLCV } from '@/types/stock'

const AS_OF = process.env.AS_OF ?? '2026-09-11'
const TICKERS = ['7203', '7003', '8306', '4755', '7974']

type CandidateRow = {
  ticker: string
  name: string | null
  market: string | null
  date: string
  close: number
}

type WeeklyRow = OHLCV & {
  ticker: string
  week_start_date: string
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function manualBiweekly(weekly: WeeklyRow[]): OHLCV[] {
  const buckets = new Map<number, OHLCV>()
  for (const row of weekly.slice().sort((left, right) => left.date.localeCompare(right.date))) {
    const key = Math.floor(calendarWeekBucket(row.week_start_date) / 2)
    const current = buckets.get(key)
    buckets.set(key, current == null ? {
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    } : {
      date: row.date,
      open: current.open,
      high: Math.max(current.high, Number(row.high)),
      low: Math.min(current.low, Number(row.low)),
      close: Number(row.close),
      volume: current.volume + Number(row.volume),
    })
  }
  return [...buckets.values()].sort((left, right) => left.date.localeCompare(right.date))
}

async function main() {
  const discovery = await getTriggerDiscovery({
    asOf: AS_OF,
    limit: 10_000,
    triggerConfig: { ma1Period: 20, ma2Period: 25 },
  }, { timeframe: 'BIWEEKLY' })

  const placeholders = TICKERS.map(() => '?').join(',')
  const candidateRows = await execAll<CandidateRow>(`
    SELECT universe.ticker,
           universe.name,
           universe.market_segment AS market,
           prices.date,
           prices.close
    FROM ticker_universe AS universe
    INNER JOIN ohlcv_daily AS prices
      ON prices.ticker = universe.ticker
     AND prices.date = (
       SELECT MAX(history.date)
       FROM ohlcv_daily AS history
       WHERE history.ticker = universe.ticker
         AND history.date <= ?
     )
    WHERE universe.ticker IN (${placeholders})
    ORDER BY universe.ticker
  `, [AS_OF, ...TICKERS])
  const candidates: TriggerDiscoveryFilteredCandidate[] = candidateRows.map((row) => ({
    ticker: row.ticker,
    companyName: row.name ?? row.ticker,
    market: row.market,
    priceDate: row.date,
    price: Number(row.close),
    averageVolume: null,
    averageTradingValue: null,
    liquidityObservationCount: 0,
    priceStalenessSessions: 0,
    priceFreshness: 'CURRENT',
    liquidityComplete: false,
  }))
  const dataSource = createTriggerDiscoverySqlDataSource()
  const prepared = await dataSource.loadBiweeklyMaObservations!({
    candidates,
    ma1Period: 20,
    ma2Period: 25,
    requiredObservations: 21,
  })

  const weeklyRows = await execAll<WeeklyRow>(`
    WITH ranked AS (
      SELECT ticker,
             date,
             week_start_date,
             open,
             high,
             low,
             close,
             volume,
             ROW_NUMBER() OVER (
               PARTITION BY ticker, week_start_date
               ORDER BY date DESC
             ) AS row_number
      FROM weekly_ohlcv
      WHERE ticker IN (${placeholders})
        AND date <= ?
    )
    SELECT ticker, date, week_start_date, open, high, low, close, volume
    FROM ranked
    WHERE row_number = 1
    ORDER BY ticker, date
  `, [...TICKERS, AS_OF])

  const crossCheck = candidates.map((candidate) => {
    const weekly = weeklyRows.filter((row) => row.ticker === candidate.ticker && row.date <= candidate.priceDate)
    const biweekly = manualBiweekly(weekly)
    const observations = prepared.value.get(candidate.ticker) ?? []
    const latest = observations.at(-1)
    const expectedMa20 = average(biweekly.slice(-20).map((row) => row.close))
    const expectedMa25 = average(biweekly.slice(-25).map((row) => row.close))
    assert.ok(latest)
    assert.equal(latest.date, biweekly.at(-1)?.date)
    assert.equal(latest.price, biweekly.at(-1)?.close)
    assert.ok(Math.abs(latest.ma1 - expectedMa20) < 1e-9)
    assert.ok(Math.abs(latest.ma2 - expectedMa25) < 1e-9)
    return {
      ticker: candidate.ticker,
      companyName: candidate.companyName,
      weeklyBars: weekly.length,
      biweeklyBars: biweekly.length,
      latestDate: latest.date,
      close: latest.price,
      ma20: latest.ma1,
      ma25: latest.ma2,
      exactMatch: true,
    }
  })

  console.log(JSON.stringify({
    timeframe: 'BIWEEKLY',
    anchorMonday: '1970-01-05',
    requestedAsOf: AS_OF,
    resolvedAsOf: discovery.resolvedAsOf,
    universeCount: discovery.diagnostics.counts.universe,
    evaluatedCount: discovery.diagnostics.counts.evaluated,
    matchedCount: discovery.totalMatched,
    performance: discovery.diagnostics.performance,
    crossCheck,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

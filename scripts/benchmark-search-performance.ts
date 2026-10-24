import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { KeyedSingleflight } from '@/lib/server/keyed-singleflight'
import type { ExactCandidate } from '@/app/api/ml/historical-analogs/route'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-search-benchmark-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: path.join(runtimeDir, 'stockboard.db'),
})
process.once('exit', () => fs.rmSync(runtimeDir, { recursive: true, force: true }))

function candidate(ticker: string, startDate: string, endDate: string): ExactCandidate {
  return {
    ticker,
    startDate,
    middleDate: startDate,
    endDate,
    score: 0.9,
    dailyScore: 0.9,
    weeklyScore: 0.9,
    monthlyScore: 0.9,
    yearlyScore: 0.9,
    mlFeatureScore: null,
    mlFeaturePointCount: 0,
    mlFeatureTotalPoints: 3,
    components: [],
    approximationScore: 0.8,
    bandMatches: 2,
    stageCode: null,
  }
}

async function benchmarkSingleflight() {
  const requests = 40
  let naiveExecutions = 0
  const naiveStarted = performance.now()
  await Promise.all(Array.from({ length: requests }, async () => {
    naiveExecutions += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
  }))
  const naiveMs = performance.now() - naiveStarted

  const coordinator = new KeyedSingleflight(2)
  let coordinatedExecutions = 0
  const coordinatedStarted = performance.now()
  await Promise.all(Array.from({ length: requests }, () => coordinator.run('same-search', async () => {
    coordinatedExecutions += 1
    await new Promise((resolve) => setTimeout(resolve, 10))
  })))
  return {
    requests,
    naiveExecutions,
    coordinatedExecutions,
    naiveMs: Math.round(naiveMs * 100) / 100,
    coordinatedMs: Math.round((performance.now() - coordinatedStarted) * 100) / 100,
  }
}

async function benchmarkPresentationBatching() {
  const { loadPresentations } = await import('@/app/api/ml/historical-analogs/route')
  const dates = Array.from({ length: 760 }, (_, index) =>
    new Date(Date.UTC(2023, 0, 1 + index)).toISOString().slice(0, 10)
  )
  const tickers = Array.from({ length: 24 }, (_, index) => `T${String(index).padStart(3, '0')}`)
  const prices = tickers.flatMap((ticker, tickerIndex) => dates.map((date, index) => {
    const close = 70 + tickerIndex * 2 + index * 0.04 + Math.sin(index / 13)
    return { ticker, date, open: close - 1, high: close + 1, low: close - 2, close, volume: 1_000 + index }
  }))
  const candidates = tickers.map((ticker, index) => candidate(ticker, dates[590 + index], dates[630 + index]))
  const syntheticQueryLatencyMs = 3
  let queryCount = 0
  const db = {
    all: async <T>(_sql: string, args: readonly (string | number | null)[] = []): Promise<T[]> => {
      queryCount += 1
      await new Promise((resolve) => setTimeout(resolve, syntheticQueryLatencyMs))
      const ranges = Array.from({ length: args.length / 3 }, (_, index) => ({
        ticker: String(args[index * 3]),
        from: String(args[index * 3 + 1]),
        to: String(args[index * 3 + 2]),
      }))
      const rangesByTicker = new Map(ranges.map((range) => [range.ticker, range]))
      return prices.filter((row) => {
        const range = rangesByTicker.get(row.ticker)
        return range && row.date >= range.from && row.date <= range.to
      }) as T[]
    },
    get: async <T>(): Promise<T | undefined> => undefined,
  }

  const batchedStarted = performance.now()
  await loadPresentations(db as never, candidates)
  const batchedMs = performance.now() - batchedStarted
  const batchedQueries = queryCount

  queryCount = 0
  const referenceStarted = performance.now()
  for (const row of candidates) await loadPresentations(db as never, [row])
  return {
    candidates: candidates.length,
    syntheticQueryLatencyMs,
    batchedQueries,
    referenceQueries: queryCount,
    batchedMs: Math.round(batchedMs * 100) / 100,
    referenceMs: Math.round((performance.now() - referenceStarted) * 100) / 100,
  }
}

async function main() {
  console.log(JSON.stringify({
    singleflight: await benchmarkSingleflight(),
    presentation: await benchmarkPresentationBatching(),
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

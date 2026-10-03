import fs from 'node:fs'
import { client, ensureReady, localDbPath } from '@/lib/db/client'
import { buildValuationServingForTicker } from '@/lib/server/valuation-serving'

const YEARS = Math.max(0, Number(process.env.VALUATION_SERVING_YEARS ?? 0))
const FORCE = process.env.VALUATION_SERVING_FORCE === '1'
const LIMIT = Math.max(0, Number(process.env.VALUATION_SERVING_LIMIT ?? 0))
const PROGRESS_EVERY = Math.max(1, Number(process.env.VALUATION_SERVING_PROGRESS_EVERY ?? 25))
const GC_EVERY = Math.max(1, Number(process.env.VALUATION_SERVING_GC_EVERY ?? 25))

function explicitTickers(): string[] {
  return [...new Set((process.env.VALUATION_SERVING_TICKERS ?? '')
    .split(',')
    .map((ticker) => ticker.trim().replace(/\.T$/i, ''))
    .filter(Boolean))]
}

async function targetTickers(): Promise<string[]> {
  const explicit = explicitTickers()
  if (explicit.length > 0) return explicit
  const result = await client.execute(`
    SELECT DISTINCT universe.ticker
    FROM ticker_universe universe
    INNER JOIN ohlcv_daily price ON price.ticker = universe.ticker
    WHERE universe.active = 1
    ORDER BY universe.ticker
  `)
  const tickers = result.rows.map((row) => String(row.ticker))
  return LIMIT > 0 ? tickers.slice(0, LIMIT) : tickers
}

function fileSize(): number {
  try {
    return fs.statSync(localDbPath).size
  } catch {
    return 0
  }
}

async function tableCounts() {
  const [daily, bases, checkpoints] = await Promise.all([
    client.execute('SELECT COUNT(*) AS count, COUNT(DISTINCT ticker) AS tickers FROM valuation_daily_serving'),
    client.execute('SELECT COUNT(*) AS count FROM valuation_metric_bases'),
    client.execute(`SELECT status, COUNT(*) AS count FROM valuation_serving_checkpoints GROUP BY status ORDER BY status`),
  ])
  return {
    dailyRows: Number(daily.rows[0]?.count ?? 0),
    dailyTickers: Number(daily.rows[0]?.tickers ?? 0),
    bases: Number(bases.rows[0]?.count ?? 0),
    checkpoints: Object.fromEntries(checkpoints.rows.map((row) => [String(row.status), Number(row.count)])),
  }
}

async function verifyLatestFreshness() {
  const result = await client.execute(`
    WITH latest_quote AS (
      SELECT MAX(date) AS date FROM ohlcv_daily
    ), expected AS (
      SELECT DISTINCT u.ticker
      FROM ticker_universe u
      INNER JOIN ohlcv_daily p ON p.ticker = u.ticker
      CROSS JOIN latest_quote q
      WHERE u.active = 1 AND p.date = q.date
    )
    SELECT
      q.date AS quote_date,
      (SELECT MAX(valuation_date) FROM valuation_daily_serving) AS serving_date,
      (SELECT COUNT(*) FROM expected) AS expected_tickers,
      (SELECT COUNT(*) FROM expected e WHERE NOT EXISTS (
        SELECT 1 FROM valuation_daily_serving v
        WHERE v.ticker = e.ticker AND v.valuation_date = q.date
      )) AS missing_tickers
    FROM latest_quote q
  `)
  const row = result.rows[0]
  const freshness = {
    quoteDate: row?.quote_date == null ? null : String(row.quote_date),
    servingDate: row?.serving_date == null ? null : String(row.serving_date),
    expectedTickers: Number(row?.expected_tickers ?? 0),
    missingTickers: Number(row?.missing_tickers ?? 0),
  }
  if (!freshness.quoteDate || freshness.quoteDate !== freshness.servingDate || freshness.missingTickers > 0) {
    throw new Error(`Valuation Serving freshness check failed: ${JSON.stringify(freshness)}`)
  }
  return freshness
}

async function main() {
  await ensureReady()
  const tickers = await targetTickers()
  const startedAt = Date.now()
  const beforeBytes = fileSize()
  let completed = 0
  let skipped = 0
  let noPrice = 0
  let failed = 0
  let persistedRows = 0
  let bases = 0

  for (const [index, ticker] of tickers.entries()) {
    try {
      const result = await buildValuationServingForTicker(ticker, { years: YEARS, force: FORCE })
      if (result.status === 'completed') completed += 1
      if (result.status === 'skipped') skipped += 1
      if (result.status === 'no_price') noPrice += 1
      persistedRows += result.rows
      bases += result.bases
    } catch (error) {
      failed += 1
      console.error(`[valuation-serving] ${ticker}:`, error instanceof Error ? error.message : String(error))
    }
    if ((index + 1) % PROGRESS_EVERY === 0 || index + 1 === tickers.length) {
      const elapsedSeconds = (Date.now() - startedAt) / 1000
      console.log(JSON.stringify({
        progress: `${index + 1}/${tickers.length}`,
        completed,
        skipped,
        failed,
        persistedRows,
        rowsPerSecond: elapsedSeconds > 0 ? Math.round(persistedRows / elapsedSeconds) : 0,
      }))
    }
    if ((index + 1) % GC_EVERY === 0) {
      ;(globalThis as typeof globalThis & { gc?: () => void }).gc?.()
    }
  }

  const afterBytes = fileSize()
  const verifyGlobalFreshness = explicitTickers().length === 0 && LIMIT === 0 && failed === 0
  const freshness = verifyGlobalFreshness ? await verifyLatestFreshness() : null
  console.log(JSON.stringify({
    requestedTickers: tickers.length,
    completed,
    skipped,
    noPrice,
    failed,
    persistedRows,
    generatedBases: bases,
    years: YEARS,
    force: FORCE,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    databaseBytesBefore: beforeBytes,
    databaseBytesAfter: afterBytes,
    databaseBytesIncrease: afterBytes - beforeBytes,
    freshness,
    tables: await tableCounts(),
  }, null, 2))
  if (failed > 0) process.exitCode = 1
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

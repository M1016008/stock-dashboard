// Tiingoから米国株ユニバースを取得し、market_universe(market='US')へ保存する。

import { db, ensureReady } from '@/lib/db/client'
import { marketDataRuns, marketUniverse } from '@/lib/db/schema'
import { fetchTiingoSupportedTickers } from '@/lib/tiingo'
import { eq, sql } from 'drizzle-orm'

const MARKET = 'US'
const DEFAULT_EXCHANGES = ['NASDAQ', 'NYSE', 'NYSE ARCA', 'NYSE MKT', 'AMEX']
const EXCHANGES = (process.env.US_EXCHANGES ?? DEFAULT_EXCHANGES.join(','))
  .split(',')
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean)
const INCLUDE_ETF = process.env.US_INCLUDE_ETF !== '0'
const REQUIRE_DATE_RANGE = process.env.US_REQUIRE_DATE_RANGE !== '0'
const STRICT_SYMBOLS = process.env.US_STRICT_SYMBOLS !== '0'
const LIMIT = Number(process.env.US_UNIVERSE_LIMIT ?? 0)
const TICKERS = process.env.TICKERS?.split(',').map((value) => value.trim().toUpperCase()).filter(Boolean)

function isActive(endDate: string | null | undefined): boolean {
  if (!endDate) return false
  const latest = new Date(`${endDate}T00:00:00Z`).getTime()
  const today = Date.now()
  return Number.isFinite(latest) && latest >= today - 14 * 24 * 60 * 60 * 1000
}

function looksLikeTradableSymbol(ticker: string): boolean {
  if (!STRICT_SYMBOLS) return true
  return /^[A-Z][A-Z0-9.-]{0,14}$/.test(ticker)
}

async function main() {
  await ensureReady()
  const [run] = await db.insert(marketDataRuns).values({
    market: MARKET,
    jobType: 'tiingo_universe',
    status: 'running',
    payloadJson: JSON.stringify({
      exchanges: EXCHANGES,
      includeEtf: INCLUDE_ETF,
      requireDateRange: REQUIRE_DATE_RANGE,
      strictSymbols: STRICT_SYMBOLS,
      limit: LIMIT || null,
      tickers: TICKERS ?? null,
    }),
  }).returning({ id: marketDataRuns.id })

  let succeeded = 0
  let failed = 0
  try {
    const allRows = await fetchTiingoSupportedTickers()
    const rows = allRows
      .filter((row) => !TICKERS?.length || TICKERS.includes(row.ticker))
      .filter((row) => EXCHANGES.length === 0 || EXCHANGES.includes((row.exchange ?? '').toUpperCase()))
      .filter((row) => INCLUDE_ETF || (row.assetType ?? '').toLowerCase() !== 'etf')
      .filter((row) => row.ticker && !row.ticker.includes('/'))
      .filter((row) => looksLikeTradableSymbol(row.ticker))
      .filter((row) => !REQUIRE_DATE_RANGE || Boolean(row.startDate || row.endDate))
      .sort((a, b) => a.ticker.localeCompare(b.ticker))
      .slice(0, LIMIT > 0 ? LIMIT : undefined)

    const CHUNK = 500
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK)
      try {
        await db.insert(marketUniverse).values(chunk.map((row) => ({
          market: MARKET,
          ticker: row.ticker,
          name: row.name ?? row.ticker,
          active: isActive(row.endDate),
          exchange: row.exchange ?? null,
          currency: row.priceCurrency ?? 'USD',
          assetType: row.assetType ?? null,
          startDate: row.startDate ?? null,
          endDate: row.endDate ?? null,
          source: 'tiingo',
          sourcePayloadJson: JSON.stringify(row),
        }))).onConflictDoUpdate({
          target: [marketUniverse.market, marketUniverse.ticker],
          set: {
            name: sql`excluded.name`,
            active: sql`excluded.active`,
            exchange: sql`excluded.exchange`,
            currency: sql`excluded.currency`,
            assetType: sql`excluded.asset_type`,
            startDate: sql`excluded.start_date`,
            endDate: sql`excluded.end_date`,
            source: sql`excluded.source`,
            sourcePayloadJson: sql`excluded.source_payload_json`,
            updatedAt: sql`unixepoch()`,
          },
        })
        succeeded += chunk.length
      } catch (error) {
        failed += chunk.length
        console.error(`universe chunk failed ${i}:`, error)
      }
    }

    await db.update(marketDataRuns).set({
      status: failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial',
      finishedAt: new Date(),
      totalTickers: rows.length,
      succeeded,
      failed,
      rowsInserted: succeeded,
      payloadJson: JSON.stringify({
        fetched: allRows.length,
        filtered: rows.length,
        exchanges: EXCHANGES,
        includeEtf: INCLUDE_ETF,
        requireDateRange: REQUIRE_DATE_RANGE,
        strictSymbols: STRICT_SYMBOLS,
      }),
    }).where(eq(marketDataRuns.id, run.id))
    console.log(`US universe complete: fetched=${allRows.length}, saved=${succeeded}, failed=${failed}`)
  } catch (error) {
    await db.update(marketDataRuns).set({
      status: 'failed',
      finishedAt: new Date(),
      errorSummary: error instanceof Error ? error.message : String(error),
    }).where(eq(marketDataRuns.id, run.id))
    throw error
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

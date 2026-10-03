import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execAll, execGet } from '@/lib/db/client'
import {
  historicalUniverseMembershipSql,
  isHistoricalUniverseMemberAt,
} from '@/lib/historical-universe'
import { getStockSectorContextResult } from '@/lib/queries/stock-sector-context'

const ledgerThrough = '2026-09-04'
const sectorQuerySource = readFileSync('lib/queries/sectors.ts', 'utf8')
const sectorBatchSource = readFileSync('scripts/batch-sector-structure.ts', 'utf8')
const stockContextSource = readFileSync('lib/queries/stock-sector-context.ts', 'utf8')

assert.ok((sectorQuerySource.match(/historicalUniverseMembershipSql/g) ?? []).length >= 4)
assert.match(sectorBatchSource, /historicalUniverseMembershipSql\([\s\S]*?'source\.ticker IS NOT NULL'/)
assert.doesNotMatch(sectorBatchSource, /INNER JOIN ticker_universe AS tu[^\n]+tu\.active = 1/)
assert.match(stockContextSource, /isHistoricalUniverseMemberAt/)
assert.match(stockContextSource, /SELECT MIN\(date\) FROM ohlcv_daily/)
assert.match(stockContextSource, /SELECT MAX\(date\) FROM ohlcv_daily/)

assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2025-06-30', currentActive: false,
  firstTradeDate: '2010-01-04', lastTradeDate: '2025-12-30', ledgerThrough,
}), true, 'a subsequently delisted ticker must remain in its historical window')
assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2026-01-05', currentActive: false,
  firstTradeDate: '2010-01-04', lastTradeDate: '2025-12-30', ledgerThrough,
}), false, 'a delisted ticker must not remain after its last trade')
assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2026-08-25', currentActive: true,
  firstTradeDate: '2026-08-28', lastTradeDate: '2026-09-04', ledgerThrough,
}), false, 'a post-IPO ticker must not appear before its first trade')
assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2026-09-05', currentActive: true,
  firstTradeDate: '2026-08-28', lastTradeDate: '2026-09-04', ledgerThrough,
}), true, 'current membership must cover dates after the ledger refresh horizon')
assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2026-08-25', currentActive: true, historicalRecordExists: false,
  firstTradeDate: null, lastTradeDate: null, ledgerThrough,
  fallbackFirstTradeDate: '2026-08-28', fallbackLastTradeDate: '2026-09-05',
}), false, 'a current ticker missing from the ledger must not appear before OHLCV evidence')
assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2026-09-05', currentActive: true, historicalRecordExists: false,
  firstTradeDate: null, lastTradeDate: null, ledgerThrough,
  fallbackFirstTradeDate: '2026-08-28', fallbackLastTradeDate: '2026-09-05',
}), true, 'OHLCV evidence must keep a current ticker available while the ledger catches up')
assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2026-09-06', currentActive: true, historicalRecordExists: false,
  firstTradeDate: null, lastTradeDate: null, ledgerThrough,
  fallbackFirstTradeDate: '2026-08-28', fallbackLastTradeDate: '2026-09-05',
}), true, 'current membership may extend beyond the ledger only after first-trade evidence')
assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2026-09-06', currentActive: true, historicalRecordExists: false,
  firstTradeDate: null, lastTradeDate: null, ledgerThrough,
}), false, 'currentActive alone is not historical membership evidence')
assert.equal(isHistoricalUniverseMemberAt({
  asOf: '2026-08-25', currentActive: true, historicalRecordExists: true,
  firstTradeDate: null, lastTradeDate: null, ledgerThrough,
}), false, 'an incomplete historical record must fail closed instead of using currentActive')

async function main() {
  const inventory = await execGet<{
    total: number
    inactive: number
    historicalOnly: number
    firstDate: string
    ledgerThrough: string
  }>(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(tu.active, 0) = 0 THEN 1 ELSE 0 END) AS inactive,
      SUM(CASE WHEN hu.is_latest_member = 0 THEN 1 ELSE 0 END) AS historicalOnly,
      MIN(hu.first_trade_date) AS firstDate,
      MAX(hu.latest_ohlcv_date) AS ledgerThrough
    FROM historical_universe AS hu
    LEFT JOIN ticker_universe AS tu ON tu.ticker = hu.ticker
  `)
  assert.ok((inventory?.total ?? 0) > 0)

  const predicate = historicalUniverseMembershipSql('snapshot.date')
  const membership = await execGet<{ historicalCount: number; currentActiveCount: number }>(`
    WITH snapshot AS (
      SELECT ticker, date FROM daily_snapshots WHERE date = '2026-08-25'
    )
    SELECT
      SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END) AS historicalCount,
      SUM(CASE WHEN COALESCE(tu.active, 0) = 1 THEN 1 ELSE 0 END) AS currentActiveCount
    FROM snapshot
    LEFT JOIN historical_universe AS hu ON hu.ticker = snapshot.ticker
    LEFT JOIN ticker_universe AS tu ON tu.ticker = snapshot.ticker
  `)
  assert.ok((membership?.historicalCount ?? 0) > 0)

  const missingLedgerWithoutEvidence = await execGet<{ member: number }>(`
    WITH hu AS (
      SELECT NULL AS ticker, NULL AS latest_ohlcv_date,
        NULL AS first_trade_date, NULL AS last_trade_date
    ), tu AS (SELECT 1 AS active)
    SELECT CASE WHEN ${historicalUniverseMembershipSql("'2026-08-25'", 'hu', 'tu')}
      THEN 1 ELSE 0 END AS member
    FROM hu CROSS JOIN tu
  `)
  assert.equal(missingLedgerWithoutEvidence?.member, 0)

  const missingLedgerWithSnapshotEvidence = await execGet<{ member: number }>(`
    WITH hu AS (
      SELECT NULL AS ticker, NULL AS latest_ohlcv_date,
        NULL AS first_trade_date, NULL AS last_trade_date
    ), tu AS (SELECT 1 AS active), source AS (SELECT '9999' AS ticker)
    SELECT CASE WHEN ${historicalUniverseMembershipSql(
      "'2026-09-05'",
      'hu',
      'tu',
      'source.ticker IS NOT NULL',
    )} THEN 1 ELSE 0 END AS member
    FROM hu CROSS JOIN tu CROSS JOIN source
  `)
  assert.equal(missingLedgerWithSnapshotEvidence?.member, 1)

  const postIpo = await execGet<{
    ticker: string
    name: string | null
    firstTradeDate: string
    lastTradeDate: string
  }>(`
    SELECT hu.ticker, hu.name, hu.first_trade_date AS firstTradeDate, hu.last_trade_date AS lastTradeDate
    FROM historical_universe AS hu
    JOIN ticker_universe AS tu ON tu.ticker = hu.ticker AND tu.active = 1
    WHERE hu.first_trade_date > '2026-08-25'
      AND hu.first_trade_date <= hu.latest_ohlcv_date
      AND hu.sector33_code IS NOT NULL
    ORDER BY hu.first_trade_date, hu.ticker
    LIMIT 1
  `)
  assert.ok(postIpo)
  const preIpoContext = await getStockSectorContextResult({
    ticker: postIpo!.ticker,
    taxonomy: '33',
    requestedDate: '2026-08-25',
    universe: null,
  })
  assert.equal(preIpoContext.availability, 'not_applicable')
  assert.equal(preIpoContext.reason?.code, 'ticker_not_listed_as_of')

  const inactiveExample = await execAll<{
    ticker: string
    name: string | null
    firstTradeDate: string
    lastTradeDate: string
  }>(`
    SELECT hu.ticker, hu.name, hu.first_trade_date AS firstTradeDate, hu.last_trade_date AS lastTradeDate
    FROM historical_universe AS hu
    JOIN ticker_universe AS tu ON tu.ticker = hu.ticker
    WHERE tu.active = 0
    ORDER BY hu.last_trade_date DESC
    LIMIT 1
  `)

  const current7003 = await getStockSectorContextResult({
    ticker: '7003', taxonomy: '33', requestedDate: null, universe: null,
  })
  const pit7003 = await getStockSectorContextResult({
    ticker: '7003', taxonomy: '33', requestedDate: '2026-08-25', universe: null,
  })
  const current7203 = await getStockSectorContextResult({
    ticker: '7203', taxonomy: '33', requestedDate: null, universe: null,
  })
  assert.equal(current7003.availability, 'available')
  assert.equal(pit7003.availability, 'available')
  assert.ok((pit7003.context?.date ?? '9999-99-99') <= '2026-08-25')
  assert.equal(current7203.availability, 'available')

  console.log(JSON.stringify({
    inventory,
    membership,
    fallbackContract: {
      missingLedgerWithoutEvidence: missingLedgerWithoutEvidence?.member ?? null,
      missingLedgerWithSnapshotEvidence: missingLedgerWithSnapshotEvidence?.member ?? null,
    },
    inactiveExample: inactiveExample[0] ?? null,
    postIpo,
    preIpoContext,
    current7003: current7003.context,
    pit7003: pit7003.context,
    current7203: current7203.context,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

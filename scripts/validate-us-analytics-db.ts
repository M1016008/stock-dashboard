// Validate that the US analytics SQLite is complete enough before running ML.

import path from 'node:path'
import { createClient, type Client } from '@libsql/client'

const configuredTargetPath = process.env.US_ANALYTICS_DB_PATH?.trim()
const TARGET_PATH = path.resolve(configuredTargetPath || 'data/stockboard-us.db')
const MIN_COPY_DONE = Number(process.env.US_ANALYTICS_MIN_COPY_DONE ?? 20500)
const MIN_OHLCV_TICKERS = Number(process.env.US_ANALYTICS_MIN_OHLCV_TICKERS ?? 18000)
const MIN_SNAPSHOT_TICKERS = Number(process.env.US_ANALYTICS_MIN_SNAPSHOT_TICKERS ?? 18000)
const MIN_OHLCV_ROWS = Number(process.env.US_ANALYTICS_MIN_OHLCV_ROWS ?? 40000000)
const MIN_SNAPSHOT_ROWS = Number(process.env.US_ANALYTICS_MIN_SNAPSHOT_ROWS ?? 40000000)

type ScalarRow = { value: number | string | null }

async function scalarNumber(client: Client, sql: string): Promise<number> {
  const result = await client.execute(sql)
  const row = result.rows[0] as unknown as ScalarRow | undefined
  return Number(row?.value ?? 0)
}

async function scalarText(client: Client, sql: string): Promise<string | null> {
  const result = await client.execute(sql)
  const row = result.rows[0] as unknown as ScalarRow | undefined
  return row?.value == null ? null : String(row.value)
}

function assertThreshold(name: string, actual: number, expected: number): string | null {
  return actual >= expected ? null : `${name}: ${actual} < ${expected}`
}

async function main() {
  const target = createClient({ url: `file:${TARGET_PATH}` })

  const copyDone = await scalarNumber(
    target,
    `SELECT COUNT(*) AS value FROM us_analytics_copy_state WHERE status = 'done'`,
  )
  const ohlcvRows = await scalarNumber(target, `SELECT COUNT(*) AS value FROM ohlcv_daily`)
  const ohlcvTickers = await scalarNumber(target, `SELECT COUNT(DISTINCT ticker) AS value FROM ohlcv_daily`)
  const ohlcvMinDate = await scalarText(target, `SELECT MIN(date) AS value FROM ohlcv_daily`)
  const ohlcvMaxDate = await scalarText(target, `SELECT MAX(date) AS value FROM ohlcv_daily`)
  const snapshotRows = await scalarNumber(target, `SELECT COUNT(*) AS value FROM daily_snapshots`)
  const snapshotTickers = await scalarNumber(target, `SELECT COUNT(DISTINCT ticker) AS value FROM daily_snapshots`)
  const snapshotMinDate = await scalarText(target, `SELECT MIN(date) AS value FROM daily_snapshots`)
  const snapshotMaxDate = await scalarText(target, `SELECT MAX(date) AS value FROM daily_snapshots`)

  console.log(
    [
      `US analytics validation: ${TARGET_PATH}`,
      `copyDone=${copyDone}`,
      `ohlcvRows=${ohlcvRows}`,
      `ohlcvTickers=${ohlcvTickers}`,
      `ohlcvRange=${ohlcvMinDate ?? '-'}..${ohlcvMaxDate ?? '-'}`,
      `snapshotRows=${snapshotRows}`,
      `snapshotTickers=${snapshotTickers}`,
      `snapshotRange=${snapshotMinDate ?? '-'}..${snapshotMaxDate ?? '-'}`,
    ].join(' '),
  )

  const failures = [
    assertThreshold('copyDone', copyDone, MIN_COPY_DONE),
    assertThreshold('ohlcvTickers', ohlcvTickers, MIN_OHLCV_TICKERS),
    assertThreshold('snapshotTickers', snapshotTickers, MIN_SNAPSHOT_TICKERS),
    assertThreshold('ohlcvRows', ohlcvRows, MIN_OHLCV_ROWS),
    assertThreshold('snapshotRows', snapshotRows, MIN_SNAPSHOT_ROWS),
  ].filter((failure): failure is string => failure != null)

  if (failures.length > 0) {
    throw new Error(`US analytics validation failed: ${failures.join('; ')}`)
  }

  console.log('US analytics validation passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

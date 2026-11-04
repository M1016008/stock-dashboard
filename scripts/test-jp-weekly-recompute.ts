import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import { ensureSchema } from '@/lib/db/migrate'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-weekly-recompute-'))
const database = path.join(directory, 'weekly.sqlite')
const client = createClient({ url: `file:${database}` })

async function main(): Promise<void> {
  try {
    await ensureSchema(client)
    await client.batch([
      {
        sql: `INSERT INTO ticker_universe(ticker,name,active)
              VALUES('7003','fixture',1)`,
        args: [],
      },
      ...[
        ['2026-07-13', 100, 110, 95, 105, 1000],
        ['2026-07-14', 105, 112, 101, 108, 1100],
        ['2026-07-15', 108, 114, 103, 109, 1200],
        ['2026-07-16', 109, 115, 104, 111, 1300],
        ['2026-07-17', 111, 118, 106, 116, 1400],
      ].map(([date, open, high, low, close, volume]) => ({
        sql: `INSERT INTO ohlcv_daily(ticker,date,open,high,low,close,volume)
              VALUES('7003',?,?,?,?,?,?)`,
        args: [date, open, high, low, close, volume],
      })),
      {
        sql: `INSERT INTO weekly_ohlcv(
                ticker,date,week_start_date,week_end_date,open,high,low,close,volume,computed_at
              ) VALUES('7003','2026-07-16','2026-07-13','2026-07-16',100,115,95,111,4600,unixepoch())`,
        args: [],
      },
    ])
    client.close()

    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/batch-weekly-ohlcv.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        USE_LOCAL_DB: '1',
        STOCKBOARD_DB_PATH: database,
        SKIP_SCHEMA_ENSURE: '1',
        TICKERS: '7003',
        WEEKLY_RECOMPUTE_FROM_DATE: '2026-07-17',
      },
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)

    const verify = createClient({ url: `file:${database}` })
    const rows = await verify.execute(`
      SELECT date,week_start_date,week_end_date,close,volume
      FROM weekly_ohlcv WHERE ticker='7003' ORDER BY week_start_date,date
    `)
    assert.equal(rows.rows.length, 1, 'the previous partial-week row must be replaced')
    assert.deepEqual(
      Object.fromEntries(Object.entries(rows.rows[0]).map(([key, value]) => [key, Number.isFinite(Number(value)) && key !== 'date' && key !== 'week_start_date' && key !== 'week_end_date' ? Number(value) : value])),
      { date: '2026-07-17', week_start_date: '2026-07-13', week_end_date: '2026-07-17', close: 116, volume: 6000 },
    )
    verify.close()
    console.log('JP weekly partial-week replacement test: PASS')
  } finally {
    try { client.close() } catch { /* already closed */ }
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

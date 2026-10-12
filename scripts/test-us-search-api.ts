import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-search-api-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: path.join(runtimeDir, 'stockboard.db'),
  STOCK_DATA_INCIDENT_DIR: path.join(runtimeDir, 'incidents'),
})
process.once('exit', () => fs.rmSync(runtimeDir, { recursive: true, force: true }))

async function main() {
  const [{ execRun }, { GET }] = await Promise.all([
    import('@/lib/db/client'),
    import('@/app/api/us/search/route'),
  ])
  for (const [ticker, exchange] of [
    ['BRK-A', 'NYSE'],
    ['BRK-B', 'NYSE'],
    ['NVDA', 'NASDAQ'],
  ] as const) {
    await execRun(
      `INSERT INTO market_universe (
         market, ticker, name, active, exchange, currency, asset_type,
         start_date, source
       ) VALUES ('US', ?, ?, 1, ?, 'USD', 'Stock', '2020-01-01', 'fixture')`,
      [ticker, ticker, exchange],
    )
  }

  async function search(query: string) {
    const response = await GET(new NextRequest(`http://local.test/api/us/search?q=${encodeURIComponent(query)}`))
    assert.equal(response.status, 200)
    return await response.json() as Array<{ ticker: string; name: string }>
  }

  for (const query of ['BRK.B', 'BRK-B', 'BRK/B', 'brk_b']) {
    const rows = await search(query)
    assert.deepEqual(rows.map((row) => row.ticker), ['BRK-B'])
    assert.equal(rows[0]?.name, 'Berkshire Hathaway Inc. Class B')
  }

  const nvidia = await search('エヌビディア')
  assert.deepEqual(nvidia.map((row) => row.ticker), ['NVDA'])
  assert.equal(nvidia[0]?.name, 'NVIDIA Corporation')

  const berkshire = await search('Berkshire')
  assert.deepEqual(berkshire.map((row) => row.ticker), ['BRK-A', 'BRK-B'])

  console.log('US search API aliases: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

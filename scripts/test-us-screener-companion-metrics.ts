import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-screener-companion-'))
const analyticsPath = path.join(runtimeDir, 'stockboard-us.db')
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: path.join(runtimeDir, 'stockboard.db'),
  SERVING_CACHE_DB_PATH: path.join(runtimeDir, 'serving-cache.db'),
  STOCK_DATA_INCIDENT_DIR: path.join(runtimeDir, 'incidents'),
  US_ANALYTICS_DB_PATH: analyticsPath,
})

async function main() {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (file: string) => { exec(sql: string): void; close(): void }
  }
  const analytics = new DatabaseSync(analyticsPath)
  analytics.exec(`
    CREATE TABLE physical_momentum_metrics(
      market TEXT NOT NULL, symbol TEXT NOT NULL, date TEXT NOT NULL,
      physical_momentum_score REAL, physical_force_score REAL, physical_energy_score REAL,
      acceleration REAL, force REAL, ma5_angle REAL, ma25_angle REAL, ma75_angle REAL, ma200_angle REAL
    );
    INSERT INTO physical_momentum_metrics VALUES
      ('US','AAA','2026-01-02',10,11,12,1,1,2,3,4,5),
      ('US','BBB','2026-01-02',NULL,22,23,2,2,3,4,5,6);
  `)
  analytics.close()

  const { execRun } = await import('@/lib/db/client')
  for (const [ticker, name] of [['AAA', 'Alpha'], ['BBB', 'Beta']] as const) {
    await execRun(`INSERT INTO market_universe(
      market,ticker,name,active,exchange,currency,asset_type,sector,industry,start_date,shares_outstanding,source
    ) VALUES ('US',?,?,1,'NASDAQ','USD','Stock','Technology','Software','2020-01-01',1000,'fixture')`, [ticker, name])
    await execRun(`INSERT INTO market_ohlcv_daily(
      market,ticker,date,open,high,low,close,volume,adj_open,adj_high,adj_low,adj_close,adj_volume,source
    ) VALUES ('US',?,'2026-01-02',100,101,99,100,1000000,100,101,99,100,1000000,'fixture')`, [ticker])
    await execRun(`INSERT INTO market_daily_snapshots(
      market,ticker,date,daily_a_stage,daily_b_stage,weekly_a_stage,weekly_b_stage,monthly_a_stage,monthly_b_stage,
      prev_close,close_5d,close_20d,close_60d,close_120d,avg_volume_20,ma_200,ma_200_prev,ma_200_observations
    ) VALUES ('US',?,'2026-01-02',1,1,1,1,1,1,99,95,90,80,70,1000000,90,89,200)`, [ticker])
  }

  const { GET } = await import('@/app/api/us/screener/route')
  const response = await GET(new NextRequest(
    'http://local.test/api/us/screener?date=2026-01-02&sort=pms&dir=desc&limit=10',
  ))
  assert.equal(response.status, 200)
  const body = await response.json() as {
    rows: Array<{ ticker: string; physical_momentum_score: number | null; physical_force_score: number | null; physical_energy_score: number | null }>
  }
  assert.deepEqual(body.rows.map((row) => row.ticker), ['AAA', 'BBB'])
  const companion = body.rows.find((row) => row.ticker === 'BBB')
  assert.equal(companion?.physical_momentum_score, null)
  assert.equal(companion?.physical_force_score, 22)
  assert.equal(companion?.physical_energy_score, 23)
  console.log('US screener companion physical metrics survive nullable selected-sort metric: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})

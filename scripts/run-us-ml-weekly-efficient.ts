import { spawn } from 'node:child_process'
import { createClient } from '@libsql/client'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

const usAnalyticsDbPath = process.env.US_ANALYTICS_DB_PATH?.trim()
  || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'

async function metadataValue(key: string): Promise<string | null> {
  const client = createClient({ url: `file:${usAnalyticsDbPath}` })
  try {
    const table = await client.execute(
      `SELECT 1
       FROM sqlite_master
       WHERE type = 'table' AND name = 'us_analytics_metadata'
       LIMIT 1`,
    )
    if (table.rows.length === 0) return null
    const row = await client.execute({
      sql: 'SELECT value FROM us_analytics_metadata WHERE key = ?',
      args: [key],
    })
    const value = row.rows[0]?.value
    return value == null ? null : String(value)
  } finally {
    client.close()
  }
}

async function adjustedFoundationIsCurrent(): Promise<boolean> {
  const [priceBasis, derivedBasis, analogBasis] = await Promise.all([
    metadataValue('ohlcv_price_basis'),
    metadataValue('derived_price_basis'),
    metadataValue('analog_index_price_basis'),
  ])
  return (
    priceBasis === US_ADJUSTED_PRICE_BASIS
    && derivedBasis === US_ADJUSTED_PRICE_BASIS
    && analogBasis === US_ADJUSTED_PRICE_BASIS
  )
}

async function runNpm(script: string, overrides: Record<string, string> = {}): Promise<void> {
  await waitForMemoryHeadroom({ label: `US weekly ${script}` })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        US_ANALYTICS_DB_PATH: usAnalyticsDbPath,
        ...overrides,
      }),
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`npm run ${script} failed: code=${code}, signal=${signal ?? 'none'}`))
    })
  })
}

async function main(): Promise<void> {
  const foundationWasCurrent = await adjustedFoundationIsCurrent()
  await runNpm('batch:us-adjusted-foundation')
  await runNpm('batch:us-analytics-validate')

  if (foundationWasCurrent) {
    await runNpm('batch:us-ml-full-history')
  } else {
    console.log(
      'US weekly: full-history ML already completed inside the newly promoted adjusted generation; '
      + 'skipping duplicate live-DB training for this run',
    )
  }

  await runNpm('db:maintenance', { DB_MAINT_TARGETS: 'us' })
}

main().catch((error) => {
  console.error('US weekly efficient update failed:', error)
  process.exit(1)
})

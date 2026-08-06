// scripts/install-local-daily-refresh.ts
//
// Register the full local StockBoard daily refresh suite.  This intentionally
// keeps the individual launchd jobs separate so each market can retry on its
// own cadence, while giving operations one command that makes the whole daily
// pipeline complete and repeatable.

import { spawnSync } from 'node:child_process'

type Step = {
  name: string
  label: string
  script: string
  env?: NodeJS.ProcessEnv
}

const baseEnv: NodeJS.ProcessEnv = {
  ...process.env,
  USE_LOCAL_DB: '1',
  SQLITE_BUSY_TIMEOUT_MS: process.env.SQLITE_BUSY_TIMEOUT_MS ?? '15000',
  SQLITE_BUSY_RETRIES: process.env.SQLITE_BUSY_RETRIES ?? '12',
  US_ANALYTICS_DB_PATH: process.env.US_ANALYTICS_DB_PATH?.trim() || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db',
}

const steps: Step[] = [
  {
    name: 'JP latest data and page cache',
    label: 'com.stockboard.update-latest',
    script: 'auto-update:install',
  },
  {
    name: 'JP classification CSV change detector',
    label: 'com.stockboard.classification-sync',
    script: 'auto-classification-sync:install',
  },
  {
    name: 'Kabutan dashboard news hourly refresh',
    label: 'com.stockboard.kabutan-material-news',
    script: 'auto-kabutan-material-news:install',
  },
  {
    name: 'Kabutan themes daily refresh with retry',
    label: 'com.stockboard.kabutan-themes',
    script: 'auto-kabutan-themes:install',
  },
  {
    name: 'Earnings calendar and stock serving refresh',
    label: 'com.stockboard.earnings-refresh',
    script: 'auto-earnings-refresh:install',
  },
  {
    name: 'US latest data, analytics DB, and US daily ML',
    label: 'com.stockboard.us-update-latest',
    script: 'auto-update-us:install',
  },
  {
    name: 'JP daily ML serving refresh',
    label: 'com.stockboard.ml-learning',
    script: 'auto-ml:install',
  },
  {
    name: 'JP ML freshness repair guard',
    label: 'com.stockboard.ml-freshness-guard',
    script: 'auto-ml-freshness-guard:install',
    env: {
      ...baseEnv,
      ML_FRESHNESS_GUARD_TIMES: process.env.ML_FRESHNESS_GUARD_TIMES ?? '23:45',
    },
  },
  {
    name: 'Cross-market persisted-data freshness recovery',
    label: 'com.stockboard.data-freshness-guard',
    script: 'auto-data-freshness-guard:install',
  },
  {
    name: 'Sunday JP/US weekly optimization',
    label: 'com.stockboard.weekly-optimization',
    script: 'auto-weekly-optimization:install',
  },
  {
    name: 'Safe JP/US DB maintenance',
    label: 'com.stockboard.db-maintenance',
    script: 'auto-db-maintenance:install',
  },
]

function runningPid(label: string): string | null {
  const result = spawnSync('launchctl', ['list'], { encoding: 'utf8' })
  if (result.status !== 0 || !result.stdout.trim()) return null
  const line = result.stdout
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item.endsWith(`\t${label}`) || item.endsWith(` ${label}`))
  if (!line) return null
  const [pid] = line.split(/\s+/)
  return pid && pid !== '-' ? pid : null
}

for (const step of steps) {
  const pid = runningPid(step.label)
  if (pid) {
    console.log(`\n▶ ${step.name}: skipped because ${step.label} is running (pid=${pid})`)
    continue
  }

  console.log(`\n▶ ${step.name}: npm run ${step.script}`)
  const result = spawnSync('npm', ['run', step.script], {
    cwd: process.cwd(),
    env: step.env ?? baseEnv,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${step.script} failed: code=${result.status}, signal=${result.signal ?? 'none'}`)
  }
}

console.log('\nStockBoard daily refresh suite registered.')
console.log('JP prices/cache: Mon-Fri 16:40, 16:55, 17:20, 18:10, 21:10 JST')
console.log('JP heavy derived serving refresh: 21:10 JST window only, latest 60 trading dates')
console.log('JP classification CSV: daily 16:05/16:15/16:30/17:00/18:00 JST plus six-hour recovery')
console.log('Kabutan dashboard news: every 60 minutes')
console.log('Kabutan themes: daily 21:00 JST, recovery checks 22:00/23:00, waits safely for the DB writer')
console.log('US prices/analytics/ML: Tue-Sat 06:30, 10:30 JST')
console.log('JP ML serving: Mon-Fri 03:00 JST, JP exchange holidays skipped')
console.log('JP ML freshness guard: Mon-Fri 23:45 JST')
console.log('All-data recovery guard: after login and every 30 minutes; stale services only')
console.log('Weekly optimization: Sunday 00:30 JST, sequential JP/US ML, indexes, cache, and DB maintenance')
console.log('DB maintenance: daily 01:30 JST, skips unsafe checkpoints when DB is open')

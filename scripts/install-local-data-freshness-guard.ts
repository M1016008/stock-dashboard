// Register the cross-market recovery guard. It runs after login and every
// 15 minutes, then conditionally starts only stale, compatible StockBoard services.

import path from 'node:path'
import {
  cwd, ensureLaunchAgentDirs, home, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.data-freshness-guard'
const intervalSeconds = Math.max(
  900,
  Number(process.env.DATA_FRESHNESS_GUARD_INTERVAL_SECONDS ?? '900') || 900,
)
const defaultUsDb = process.env.US_ANALYTICS_DB_PATH?.trim()
  || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'

ensureLaunchAgentDirs()

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SKIP_SCHEMA_ENSURE=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-8}',
  'export STOCKBOARD_DB_READ_CONCURRENCY=${STOCKBOARD_DB_READ_CONCURRENCY:-2}',
  `export US_ANALYTICS_DB_PATH=${JSON.stringify(defaultUsDb)}`,
  'nice -n 15 npm run batch:data-freshness-guard',
].join(' && ')

const plist = launchAgentPlist(label, command, `  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>15</integer>
  <key>ThrottleInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('data-freshness-guard.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('data-freshness-guard.err'))}</string>`, launchAgentStorageEnvironmentXml('  '))

const plistPath = installLaunchAgent(label, plist)

console.log(`launchd registered: ${plistPath}`)
console.log(`schedule: after login and every ${Math.round(intervalSeconds / 60)} minutes`)
console.log('safety: read-only audit, no duplicate launch, writer-lock deferral, per-source cooldown')
console.log(`report: ${path.join(home, 'Library', 'Application Support', 'StockBoard', 'data-freshness-latest.json')}`)
console.log(`logs: ${logPath('data-freshness-guard.log')}`)

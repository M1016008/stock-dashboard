// scripts/install-local-kabutan-material-news.ts
//
// Register a low-frequency local launchd job for Kabutan dashboard news.
// The batch stores only dashboard-target articles and short snippets, not full text.

import {
  cwd, ensureLaunchAgentDirs, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.kabutan-material-news'
const intervalSeconds = Math.max(1800, Number(process.env.KABUTAN_MATERIAL_NEWS_INTERVAL_SECONDS ?? '3600') || 3600)

ensureLaunchAgentDirs()

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-8}',
  'export KABUTAN_MATERIAL_NEWS_PAGES=${KABUTAN_MATERIAL_NEWS_PAGES:-2}',
  'export KABUTAN_MATERIAL_NEWS_LOOKBACK_DAYS=${KABUTAN_MATERIAL_NEWS_LOOKBACK_DAYS:-7}',
  'export KABUTAN_MATERIAL_NEWS_LIMIT=${KABUTAN_MATERIAL_NEWS_LIMIT:-30}',
  'export KABUTAN_REQUEST_DELAY_MS=${KABUTAN_REQUEST_DELAY_MS:-1200}',
  'export KABUTAN_MATERIAL_NEWS_WAIT_FOR_LOCK_SECONDS=${KABUTAN_MATERIAL_NEWS_WAIT_FOR_LOCK_SECONDS:-1200}',
  'export KABUTAN_MATERIAL_NEWS_LOCK_POLL_SECONDS=${KABUTAN_MATERIAL_NEWS_LOCK_POLL_SECONDS:-30}',
  'npm run batch:kabutan-material-news',
].join(' && ')

const plist = launchAgentPlist(label, command, `  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('kabutan-material-news.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('kabutan-material-news.err'))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>ThrottleInterval</key>
  <integer>300</integer>`, launchAgentStorageEnvironmentXml('  '))

const plistPath = installLaunchAgent(label, plist)

console.log(`launchd registered: ${plistPath}`)
console.log(`schedule: every ${Math.round(intervalSeconds / 60)} minutes`)
console.log('targets: Kabutan previous-day movers and good/bad disclosure articles')
console.log(`logs: ${logPath('kabutan-material-news.log')}`)

// scripts/install-local-earnings-refresh.ts
//
// Register a local launchd job that refreshes the earnings calendar and actual disclosure times.
// The refresh uses J-Quants + JPX official data and warms dashboard cache.

import fs from 'node:fs'
import path from 'node:path'
import {
  calendarXml, cwd, ensureLaunchAgentDirs, home, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.earnings-refresh'
const supportDir = path.join(home, 'Library', 'Application Support', 'StockBoard')
const deferredPath = path.join(supportDir, 'earnings-refresh-deferred')
const scheduleHour = Number(process.env.EARNINGS_REFRESH_HOUR ?? '7')
const scheduleMinute = Number(process.env.EARNINGS_REFRESH_MINUTE ?? '10')

function clampHour(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : 7
}

function clampMinute(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 59 ? value : 10
}

ensureLaunchAgentDirs()
fs.mkdirSync(supportDir, { recursive: true })

const hour = clampHour(scheduleHour)
const minute = clampMinute(scheduleMinute)
const retryHour = clampHour(Number(process.env.EARNINGS_REFRESH_RETRY_HOUR ?? '14'))
const retryMinute = clampMinute(Number(process.env.EARNINGS_REFRESH_RETRY_MINUTE ?? '10'))
const closeHour = clampHour(Number(process.env.EARNINGS_REFRESH_CLOSE_HOUR ?? '16'))
const closeMinute = clampMinute(Number(process.env.EARNINGS_REFRESH_CLOSE_MINUTE ?? '30'))
const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-8}',
  'export EARNINGS_REFRESH_MAX_ATTEMPTS=${EARNINGS_REFRESH_MAX_ATTEMPTS:-3}',
  'export EARNINGS_REFRESH_RETRY_DELAY_SECONDS=${EARNINGS_REFRESH_RETRY_DELAY_SECONDS:-300}',
  'export EARNINGS_REFRESH_WAIT_FOR_LOCK_SECONDS=${EARNINGS_REFRESH_WAIT_FOR_LOCK_SECONDS:-2700}',
  'export EARNINGS_REFRESH_LOCK_POLL_SECONDS=${EARNINGS_REFRESH_LOCK_POLL_SECONDS:-30}',
  `export EARNINGS_REFRESH_DEFERRED_PATH=${JSON.stringify(deferredPath)}`,
  'npm run batch:earnings-refresh',
].join(' && ')

const plist = launchAgentPlist(label, command, `  <key>StartCalendarInterval</key>
  <array>
${[[hour, minute], [retryHour, retryMinute], [closeHour, closeMinute]].map(([h, m]) => calendarXml(h, m)).join('\n')}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('earnings-refresh.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('earnings-refresh.err'))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>${xmlEscape(deferredPath)}</key>
      <true/>
    </dict>
  </dict>
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
console.log(
  `schedule: daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} and `
  + `${String(retryHour).padStart(2, '0')}:${String(retryMinute).padStart(2, '0')} and `
  + `${String(closeHour).padStart(2, '0')}:${String(closeMinute).padStart(2, '0')} JST`,
)
console.log('command: npm run batch:earnings-refresh')
console.log(`logs: ${logPath('earnings-refresh.log')}`)

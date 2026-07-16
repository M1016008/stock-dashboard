// scripts/install-local-us-ml-weekly.ts
//
// Register a weekly full-history US ML training/governance run. US daily update
// keeps serving data fresh; this job refreshes full-history models and
// evaluations from the oldest available history.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.us-ml-weekly'
const cwd = process.cwd()
const home = os.homedir()
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const pathEnv = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':')

// launchd Weekday: 1=Monday ... 6=Saturday, 0/7=Sunday.
const scheduleWeekday = Number(process.env.US_ML_WEEKLY_WEEKDAY ?? '0')
const scheduleHour = Number(process.env.US_ML_WEEKLY_HOUR ?? '3')
const scheduleMinute = Number(process.env.US_ML_WEEKLY_MINUTE ?? '0')
const defaultUsAnalyticsDb = process.env.US_ANALYTICS_DB_PATH?.trim() || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-15}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-8192}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  'export SQLITE_BUSY_RETRIES=720',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=2880',
  `export US_ANALYTICS_DB_PATH=${JSON.stringify(defaultUsAnalyticsDb)}`,
  'export US_ML_FULL_START_DATE=${US_ML_FULL_START_DATE:-1900-01-01}',
  'npm run batch:us-ml-full',
].join(' && ')

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cwd)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>${scheduleWeekday}</integer>
    <key>Hour</key><integer>${scheduleHour}</integer>
    <key>Minute</key><integer>${scheduleMinute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'us-ml-weekly.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'us-ml-weekly.err'))}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`

fs.writeFileSync(plistPath, plist)

try {
  execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
} catch {
  // Not registered yet.
}

execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })

console.log(`launchd registered: ${plistPath}`)
console.log(`schedule: weekday=${scheduleWeekday} ${String(scheduleHour).padStart(2, '0')}:${String(scheduleMinute).padStart(2, '0')} JST`)
console.log(`logs: ${path.join(logDir, 'us-ml-weekly.log')}`)

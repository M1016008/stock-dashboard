// scripts/install-local-ml-weekly-governance.ts
//
// Register a weekly, full-history ML governance run on the local Mac.
// It runs on Saturday morning using Friday's market data and deliberately
// bypasses the JP market-open calendar because weekly retraining is expected to
// happen while the market is closed.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.ml-weekly-governance'
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
const scheduleWeekday = Number(process.env.ML_WEEKLY_GOVERNANCE_WEEKDAY ?? '6')
const scheduleHour = Number(process.env.ML_WEEKLY_GOVERNANCE_HOUR ?? '4')
const scheduleMinute = Number(process.env.ML_WEEKLY_GOVERNANCE_MINUTE ?? '30')

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
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-4096}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-30000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-20}',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=1440',
  'export ML_LEARNING_IGNORE_MARKET_CALENDAR=1',
  'export ML_LEARNING_MAX_ATTEMPTS=${ML_LEARNING_MAX_ATTEMPTS:-2}',
  'export ML_LEARNING_RETRY_DELAY_SECONDS=${ML_LEARNING_RETRY_DELAY_SECONDS:-1800}',
  'export ML_LEARNING_BATCH_WAIT_MINUTES=${ML_LEARNING_BATCH_WAIT_MINUTES:-720}',
  'export ML_LEARNING_NPM_SCRIPT=batch:ml-weekly-governance',
  'npm run batch:ml-learning-daily',
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
  <string>${xmlEscape(path.join(logDir, 'ml-weekly-governance.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'ml-weekly-governance.err'))}</string>
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
console.log(`command: ML_LEARNING_NPM_SCRIPT=batch:ml-weekly-governance npm run batch:ml-learning-daily`)
console.log(`logs: ${path.join(logDir, 'ml-weekly-governance.log')}`)

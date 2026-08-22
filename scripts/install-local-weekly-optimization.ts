// scripts/install-local-weekly-optimization.ts
//
// Register the single Sunday JP/US optimization pipeline. Legacy weekly
// launchers are disabled for future runs, but an already-running job is not
// interrupted.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.weekly-optimization'
const legacyLabels = [
  'com.stockboard.ml-weekly-governance',
  'com.stockboard.us-ml-weekly',
] as const
const cwd = process.cwd()
const home = os.homedir()
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const scheduleWeekday = Number(process.env.WEEKLY_OPTIMIZATION_WEEKDAY ?? '0')
const scheduleHour = Number(process.env.WEEKLY_OPTIMIZATION_HOUR ?? '0')
const scheduleMinute = Number(process.env.WEEKLY_OPTIMIZATION_MINUTE ?? '30')
const defaultUsDb = process.env.US_ANALYTICS_DB_PATH?.trim()
  || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'
const pathEnv = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':')

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function validateSchedule(): void {
  if (!Number.isInteger(scheduleWeekday) || scheduleWeekday < 0 || scheduleWeekday > 7) {
    throw new Error(`WEEKLY_OPTIMIZATION_WEEKDAY must be 0-7: ${scheduleWeekday}`)
  }
  if (!Number.isInteger(scheduleHour) || scheduleHour < 0 || scheduleHour > 23) {
    throw new Error(`WEEKLY_OPTIMIZATION_HOUR must be 0-23: ${scheduleHour}`)
  }
  if (!Number.isInteger(scheduleMinute) || scheduleMinute < 0 || scheduleMinute > 59) {
    throw new Error(`WEEKLY_OPTIMIZATION_MINUTE must be 0-59: ${scheduleMinute}`)
  }
}

function runningPid(targetLabel: string): string | null {
  const result = spawnSync('launchctl', ['list'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const line = result.stdout
    .split('\n')
    .find((item) => item.trim().endsWith(targetLabel))
  const pid = line?.trim().split(/\s+/)[0]
  return pid && pid !== '-' ? pid : null
}

validateSchedule()
fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  `export US_ANALYTICS_DB_PATH=${JSON.stringify(defaultUsDb)}`,
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-20}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-6144}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  'export US_PMS_WEEKLY_TICKER_CHUNK=${US_PMS_WEEKLY_TICKER_CHUNK:-250}',
  'export US_PMS_WEEKLY_DATE_CHUNK=${US_PMS_WEEKLY_DATE_CHUNK:-50}',
  'export US_PMS_CHECKPOINT_ENABLED=${US_PMS_CHECKPOINT_ENABLED:-1}',
  'export ML_MODEL_DETERIORATION_STRICT=${ML_MODEL_DETERIORATION_STRICT:-1}',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-30000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-20}',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=${UPDATE_CHILD_TIMEOUT_MINUTES:-2880}',
  'npm run batch:weekly-optimize',
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
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'weekly-optimization.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'weekly-optimization.err'))}</string>
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

for (const legacyLabel of legacyLabels) {
  const pid = runningPid(legacyLabel)
  execFileSync('launchctl', ['disable', `gui/${uid}/${legacyLabel}`], { stdio: 'inherit' })
  console.log(
    pid
      ? `legacy schedule disabled; current run continues: ${legacyLabel} pid=${pid}`
      : `legacy schedule disabled: ${legacyLabel}`,
  )
}

console.log(`launchd registered: ${plistPath}`)
console.log(
  `schedule: Sunday ${String(scheduleHour).padStart(2, '0')}:${String(scheduleMinute).padStart(2, '0')} JST`,
)
console.log('pipeline: JP ML -> US ML -> JP/US analog indexes -> dashboard cache -> JP/US DB maintenance')
console.log(`logs: ${path.join(logDir, 'weekly-optimization.log')}`)

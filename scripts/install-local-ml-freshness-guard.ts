// scripts/install-local-ml-freshness-guard.ts
//
// Register a weekday launchd safety net that verifies and repairs JP ML
// freshness after the regular daily learning job.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.ml-freshness-guard'
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

type GuardTime = {
  hour: number
  minute: number
}

const DEFAULT_GUARD_TIMES: GuardTime[] = [
  // The first check follows the regular post-close ML serving run. Morning
  // retries close the hole where that run overlapped an active writer or
  // completed after the first check. Saturday covers Friday's close.
  { hour: 0, minute: 15 },
  { hour: 5, minute: 15 },
  { hour: 8, minute: 15 },
]

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function parseGuardTimes(): GuardTime[] {
  const raw = process.env.ML_FRESHNESS_GUARD_TIMES
    ?? DEFAULT_GUARD_TIMES.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(',')
  const parsed = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [hour, minute] = item.split(':').map(Number)
      return { hour, minute }
    })
    .filter((item) => Number.isInteger(item.hour) && Number.isInteger(item.minute) && item.hour >= 0 && item.hour <= 23 && item.minute >= 0 && item.minute <= 59)
  return parsed.length > 0
    ? parsed
    : DEFAULT_GUARD_TIMES
}

function calendar(hour: number, minute: number, weekday: number): string {
  return [
    '    <dict>',
    `      <key>Weekday</key><integer>${weekday}</integer>`,
    `      <key>Hour</key><integer>${hour}</integer>`,
    `      <key>Minute</key><integer>${minute}</integer>`,
    '    </dict>',
  ].join('\n')
}

function recoverySchedule(times: GuardTime[]): string {
  // launchd Weekday: 1=Monday ... 6=Saturday, 0/7=Sunday. Saturday is
  // required to repair a Friday post-close run without waiting for Monday.
  // The guard checks the latest available JP price date, so exchange holidays
  // naturally become no-op checks when no new price date exists.
  return [1, 2, 3, 4, 5, 6]
    .flatMap((weekday) => times.map((time) => calendar(time.hour, time.minute, weekday)))
    .join('\n')
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-8}',
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-20}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-8192}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  'export ML_DAILY_RECENT_DAYS=${ML_DAILY_RECENT_DAYS:-5}',
  'export ML_DAILY_MIN_HISTORY_DAYS=${ML_DAILY_MIN_HISTORY_DAYS:-220}',
  'export ML_CONTEXT_DAILY_RECENT_DAYS=${ML_CONTEXT_DAILY_RECENT_DAYS:-5}',
  'export ML_PHYSICS_DAILY_RECENT_DAYS=${ML_PHYSICS_DAILY_RECENT_DAYS:-5}',
  'export ML_PHYSICS_DAILY_MIN_HISTORY_DAYS=${ML_PHYSICS_DAILY_MIN_HISTORY_DAYS:-220}',
  'export ML_DAILY_RL_RECENT_DAYS=${ML_DAILY_RL_RECENT_DAYS:-60}',
  'export ML_DAILY_STATUS_RECENT_DAYS=${ML_DAILY_STATUS_RECENT_DAYS:-60}',
  'npm run batch:ml-freshness-guard',
].join(' && ')

const times = parseGuardTimes()
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
  <array>
${recoverySchedule(times)}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'ml-freshness-guard.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'ml-freshness-guard.err'))}</string>
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
console.log(`schedule: Mon-Sat ${times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(', ')} JST`)
console.log(`logs: ${path.join(logDir, 'ml-freshness-guard.log')}`)

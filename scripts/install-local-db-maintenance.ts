// scripts/install-local-db-maintenance.ts
//
// Register a local launchd job for safe DB maintenance. The job is intentionally
// conservative: it yields to active StockBoard writers and lets SQLite coordinate
// checkpoints with any readers that still need the WAL.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.db-maintenance'
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

type MaintenanceTime = {
  hour: number
  minute: number
}

function parseScheduleTimes(): MaintenanceTime[] {
  const legacyTime = process.env.DB_MAINT_HOUR !== undefined || process.env.DB_MAINT_MINUTE !== undefined
    ? `${process.env.DB_MAINT_HOUR ?? '1'}:${process.env.DB_MAINT_MINUTE ?? '30'}`
    : null
  const rawTimes = process.env.DB_MAINT_TIMES?.trim() || legacyTime || '01:30,05:30,12:30,15:30'
  const times = rawTimes.split(',').map((rawTime) => {
    const match = rawTime.trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!match) throw new Error(`Invalid DB maintenance time: ${rawTime}`)
    const hour = Number(match[1])
    const minute = Number(match[2])
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
      throw new Error(`Invalid DB maintenance time: ${rawTime}`)
    }
    return { hour, minute }
  })

  return [...new Map(times.map((time) => [`${time.hour}:${time.minute}`, time])).values()]
}

const scheduleTimes = parseScheduleTimes()

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
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

function dailySchedule(): string {
  // launchd Weekday: 1=Monday ... 6=Saturday, 0/7=Sunday.
  // Retry in several quiet windows; the script itself yields to active writers.
  return [1, 2, 3, 4, 5, 6, 0]
    .flatMap((weekday) => scheduleTimes.map(({ hour, minute }) => calendar(hour, minute, weekday)))
    .join('\n')
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export DB_MAINT_TARGETS=${DB_MAINT_TARGETS:-jp,us}',
  'export DB_MAINT_CHECK_MODE=${DB_MAINT_CHECK_MODE:-smoke}',
  'export DB_MAINT_STALE_BATCH_TTL_HOURS=${DB_MAINT_STALE_BATCH_TTL_HOURS:-6}',
  'export DB_MAINT_CLEAN_STALE_WITH_ACTIVE=${DB_MAINT_CLEAN_STALE_WITH_ACTIVE:-1}',
  `export US_ANALYTICS_DB_PATH=${JSON.stringify(process.env.US_ANALYTICS_DB_PATH?.trim() || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db')}`,
  'npm run db:maintenance',
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
  <array>
${dailySchedule()}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'db-maintenance.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'db-maintenance.err'))}</string>
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
console.log(`schedule: daily ${scheduleTimes.map(({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`).join(', ')} JST`)
console.log(`logs: ${path.join(logDir, 'db-maintenance.log')}`)

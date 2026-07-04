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

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function parseGuardTimes(): GuardTime[] {
  const raw = process.env.ML_FRESHNESS_GUARD_TIMES ?? '07:30,12:30,18:30,21:30'
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
    : [{ hour: 7, minute: 30 }, { hour: 12, minute: 30 }, { hour: 18, minute: 30 }, { hour: 21, minute: 30 }]
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

function weekdaySchedule(times: GuardTime[]): string {
  // launchd Weekday: 1=Monday ... 6=Saturday, 0/7=Sunday.
  // The guard checks the latest available JP price date, so exchange holidays
  // naturally become no-op checks when no new price date exists.
  return [1, 2, 3, 4, 5]
    .flatMap((weekday) => times.map((time) => calendar(time.hour, time.minute, weekday)))
    .join('\n')
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_RETRIES=240',
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
${weekdaySchedule(times)}
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
console.log(`schedule: Mon-Fri ${times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(', ')} JST`)
console.log(`logs: ${path.join(logDir, 'ml-freshness-guard.log')}`)

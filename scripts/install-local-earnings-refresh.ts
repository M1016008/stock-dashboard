// scripts/install-local-earnings-refresh.ts
//
// Register a local launchd job that refreshes the earnings calendar once per day.
// The refresh uses J-Quants + JPX official data and warms dashboard cache.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.earnings-refresh'
const cwd = process.cwd()
const home = os.homedir()
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const scheduleHour = Number(process.env.EARNINGS_REFRESH_HOUR ?? '7')
const scheduleMinute = Number(process.env.EARNINGS_REFRESH_MINUTE ?? '10')
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

function clampHour(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : 7
}

function clampMinute(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 59 ? value : 10
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const hour = clampHour(scheduleHour)
const minute = clampMinute(scheduleMinute)
const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-40}',
  'npm run batch:earnings-refresh',
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
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'earnings-refresh.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'earnings-refresh.err'))}</string>
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
console.log(`schedule: daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} JST`)
console.log('command: npm run batch:earnings-refresh')
console.log(`logs: ${path.join(logDir, 'earnings-refresh.log')}`)

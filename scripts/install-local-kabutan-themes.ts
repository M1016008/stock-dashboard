// Register the low-priority daily Kabutan theme refresh.
// A second run provides a safe retry when another StockBoard writer owns the DB.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.kabutan-themes'
const cwd = process.cwd()
const home = os.homedir()
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const primaryHour = clamp(Number(process.env.KABUTAN_THEMES_HOUR ?? '2'), 0, 23, 2)
const primaryMinute = clamp(Number(process.env.KABUTAN_THEMES_MINUTE ?? '15'), 0, 59, 15)
const retryHour = clamp(Number(process.env.KABUTAN_THEMES_RETRY_HOUR ?? '12'), 0, 23, 12)
const retryMinute = clamp(Number(process.env.KABUTAN_THEMES_RETRY_MINUTE ?? '15'), 0, 59, 15)
const pathEnv = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':')

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

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
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-12}',
  'export KABUTAN_THEME_LIMIT=${KABUTAN_THEME_LIMIT:-30}',
  'export KABUTAN_THEME_DETAIL_LIMIT=${KABUTAN_THEME_DETAIL_LIMIT:-30}',
  'export KABUTAN_THEME_STOCK_PAGES=${KABUTAN_THEME_STOCK_PAGES:-8}',
  'export KABUTAN_REQUEST_DELAY_MS=${KABUTAN_REQUEST_DELAY_MS:-1000}',
  'nice -n 10 npm run batch:kabutan-themes',
].join(' && ')

const calendar = (hour: number, minute: number) => `
    <dict>
      <key>Hour</key><integer>${hour}</integer>
      <key>Minute</key><integer>${minute}</integer>
    </dict>`

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
  <array>${calendar(primaryHour, primaryMinute)}${calendar(retryHour, retryMinute)}
  </array>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>900</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'kabutan-themes.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'kabutan-themes.err'))}</string>
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
console.log(
  `schedule: daily ${String(primaryHour).padStart(2, '0')}:${String(primaryMinute).padStart(2, '0')} JST`
  + ` + retry ${String(retryHour).padStart(2, '0')}:${String(retryMinute).padStart(2, '0')} JST`,
)
console.log('safety: exclusive DB writer lock, low-priority I/O, niceness 10')
console.log(`logs: ${path.join(logDir, 'kabutan-themes.log')}`)

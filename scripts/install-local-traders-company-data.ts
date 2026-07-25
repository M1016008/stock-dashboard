// Register the authorized, low-priority Traders Web company-data sync.
// The job uses a separate supplemental DB and never writes to the market DB.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tradersCompanyDataDbPath } from '@/lib/traders-company-data'

const label = 'com.stockboard.traders-company-data'
const cwd = process.cwd()
const home = os.homedir()
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const hour = clamp(Number(process.env.TRADERS_COMPANY_HOUR ?? '1'), 0, 23, 1)
const minute = clamp(Number(process.env.TRADERS_COMPANY_MINUTE ?? '45'), 0, 59, 45)
const dbPath = tradersCompanyDataDbPath()
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
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export TRADERS_COMPANY_DATA_AUTHORIZED=1',
  `export TRADERS_COMPANY_DB_PATH=${JSON.stringify(dbPath)}`,
  'export TRADERS_COMPANY_REQUEST_DELAY_MS=${TRADERS_COMPANY_REQUEST_DELAY_MS:-3000}',
  'export TRADERS_COMPANY_MAX_REQUEST_DELAY_MS=${TRADERS_COMPANY_MAX_REQUEST_DELAY_MS:-15000}',
  'export TRADERS_COMPANY_RATE_LIMIT_BACKOFF_MS=${TRADERS_COMPANY_RATE_LIMIT_BACKOFF_MS:-60000}',
  'export TRADERS_COMPANY_CIRCUIT_BREAKER_THRESHOLD=${TRADERS_COMPANY_CIRCUIT_BREAKER_THRESHOLD:-3}',
  'export TRADERS_COMPANY_FETCH_TIMEOUT_MS=${TRADERS_COMPANY_FETCH_TIMEOUT_MS:-20000}',
  'export TRADERS_COMPANY_RETRIES=${TRADERS_COMPANY_RETRIES:-4}',
  'nice -n 15 npm run batch:traders-company-data',
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
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>900</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'traders-company-data.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'traders-company-data.err'))}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`

fs.writeFileSync(plistPath, plist)

try {
  execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
} catch {
  // First registration.
}

execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })

console.log(`launchd registered: ${plistPath}`)
console.log(`schedule: daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} JST`)
console.log(`supplemental DB: ${dbPath}`)
console.log('safety: authorization gate, isolated DB, single process lock, adaptive throttling, niceness 15, low-priority I/O')
console.log(`logs: ${path.join(logDir, 'traders-company-data.log')}`)

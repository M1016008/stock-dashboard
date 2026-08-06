// Register a low-priority launchd watcher for the removable classification CSV.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.classification-sync'
const cwd = process.cwd()
const home = os.homedir()
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const recoveryIntervalSeconds = Math.max(
  3600,
  Number(process.env.CLASSIFICATION_SYNC_INTERVAL_SECONDS ?? '21600') || 21600,
)
const scheduleTimes = (process.env.CLASSIFICATION_SYNC_TIMES ?? '16:05,16:15,16:30,17:00,18:00')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value))
if (scheduleTimes.length === 0) {
  throw new Error('CLASSIFICATION_SYNC_TIMES must contain at least one HH:MM value.')
}
const sourcePath = process.env.CLASSIFICATION_FILE?.trim()
  || '/Volumes/OWC Express 1M2 80G/会社四季報CSV/会社四季報_最新.csv'
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

function calendar(time: string): string {
  const [hour, minute] = time.split(':').map(Number)
  return [
    '    <dict>',
    `      <key>Hour</key><integer>${hour}</integer>`,
    `      <key>Minute</key><integer>${minute}</integer>`,
    '    </dict>',
  ].join('\n')
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function bootstrap(attempts = 6): void {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
        stdio: attempt === attempts ? 'inherit' : 'ignore',
      })
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) sleep(500 * attempt)
    }
  }
  throw lastError
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  `export CLASSIFICATION_FILE=${JSON.stringify(sourcePath)}`,
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-6}',
  'nice -n 15 npm run batch:classification-sync',
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
${scheduleTimes.map(calendar).join('\n')}
  </array>
  <key>StartInterval</key>
  <integer>${recoveryIntervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>15</integer>
  <key>ThrottleInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'classification-sync.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'classification-sync.err'))}</string>
</dict>
</plist>
`

fs.writeFileSync(plistPath, plist)

try {
  execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
} catch {
  // First registration.
}
sleep(750)
bootstrap()
execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })

console.log(`launchd registered: ${plistPath}`)
console.log(`daily schedule: ${scheduleTimes.join(', ')} JST`)
console.log(`recovery: after login and every ${Math.round(recoveryIntervalSeconds / 3600)} hours`)
console.log(`source: ${sourcePath}`)
console.log(`logs: ${path.join(logDir, 'classification-sync.log')}`)

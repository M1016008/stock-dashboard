// scripts/install-local-kabutan-material-news.ts
//
// Register a low-frequency local launchd job for Kabutan dashboard news.
// The batch stores only dashboard-target articles and short snippets, not full text.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.kabutan-material-news'
const cwd = process.cwd()
const home = os.homedir()
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const intervalSeconds = Math.max(1800, Number(process.env.KABUTAN_MATERIAL_NEWS_INTERVAL_SECONDS ?? '3600') || 3600)
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

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-8}',
  'export KABUTAN_MATERIAL_NEWS_PAGES=${KABUTAN_MATERIAL_NEWS_PAGES:-2}',
  'export KABUTAN_MATERIAL_NEWS_LIMIT=${KABUTAN_MATERIAL_NEWS_LIMIT:-30}',
  'export KABUTAN_REQUEST_DELAY_MS=${KABUTAN_REQUEST_DELAY_MS:-1200}',
  'export KABUTAN_MATERIAL_NEWS_WAIT_FOR_LOCK_SECONDS=${KABUTAN_MATERIAL_NEWS_WAIT_FOR_LOCK_SECONDS:-1200}',
  'export KABUTAN_MATERIAL_NEWS_LOCK_POLL_SECONDS=${KABUTAN_MATERIAL_NEWS_LOCK_POLL_SECONDS:-30}',
  'npm run batch:kabutan-material-news',
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
  <key>StartInterval</key>
  <integer>${intervalSeconds}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'kabutan-material-news.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'kabutan-material-news.err'))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>ThrottleInterval</key>
  <integer>300</integer>
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
console.log(`schedule: every ${Math.round(intervalSeconds / 60)} minutes`)
console.log('targets: Kabutan previous-day movers and good/bad disclosure articles')
console.log(`logs: ${path.join(logDir, 'kabutan-material-news.log')}`)

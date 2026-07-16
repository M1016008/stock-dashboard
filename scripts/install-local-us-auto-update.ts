// scripts/install-local-us-auto-update.ts
//
// ローカルMacのlaunchdに、米国株Tiingo差分更新とUS日次ML更新を登録する。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.us-update-latest'
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

function marketCloseRetrySchedule(): string {
  // launchd Weekday: 1=Monday ... 6=Saturday, 0/7=Sunday.
  // Tue-Sat JST corresponds to Mon-Fri US closes. 06:30 JST is after both
  // daylight-saving (05:00 JST close) and standard-time (06:00 JST close).
  const weekdays = [2, 3, 4, 5, 6]
  const times = [
    [6, 30],
    [7, 30],
    [8, 30],
    [12, 30],
    [18, 30],
  ] as const
  return weekdays.flatMap((weekday) => times.map(([hour, minute]) => calendar(hour, minute, weekday))).join('\n')
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-15}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-8192}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  'export SQLITE_BUSY_RETRIES=720',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=1440',
  `export US_ANALYTICS_DB_PATH=${JSON.stringify(process.env.US_ANALYTICS_DB_PATH?.trim() || '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db')}`,
  'export US_DAILY_OHLCV_CONCURRENCY=${US_DAILY_OHLCV_CONCURRENCY:-2}',
  'export US_DAILY_OHLCV_RATE_LIMIT_MS=${US_DAILY_OHLCV_RATE_LIMIT_MS:-350}',
  'export US_DAILY_SNAPSHOT_CONCURRENCY=${US_DAILY_SNAPSHOT_CONCURRENCY:-2}',
  'export US_UPDATE_STEP_MAX_ATTEMPTS=${US_UPDATE_STEP_MAX_ATTEMPTS:-2}',
  'export US_UPDATE_STEP_RETRY_DELAY_SECONDS=${US_UPDATE_STEP_RETRY_DELAY_SECONDS:-300}',
  'export US_ML_STEP_MAX_ATTEMPTS=${US_ML_STEP_MAX_ATTEMPTS:-3}',
  'export US_ML_STEP_RETRY_DELAY_SECONDS=${US_ML_STEP_RETRY_DELAY_SECONDS:-300}',
  'export US_PMS_DAILY_RECENT_DAYS=${US_PMS_DAILY_RECENT_DAYS:-420}',
  'export US_ML_DAILY_RECENT_DAYS=${US_ML_DAILY_RECENT_DAYS:-2}',
  'export US_ML_DAILY_MIN_HISTORY_DAYS=${US_ML_DAILY_MIN_HISTORY_DAYS:-220}',
  'export US_ML_DAILY_LABEL_RECENT_DAYS=${US_ML_DAILY_LABEL_RECENT_DAYS:-10}',
  'export US_ML_CONTEXT_DAILY_RECENT_DAYS=${US_ML_CONTEXT_DAILY_RECENT_DAYS:-2}',
  'export US_ML_PHYSICS_DAILY_RECENT_DAYS=${US_ML_PHYSICS_DAILY_RECENT_DAYS:-2}',
  'export US_ML_PHYSICS_DAILY_MIN_HISTORY_DAYS=${US_ML_PHYSICS_DAILY_MIN_HISTORY_DAYS:-220}',
  'export US_ML_DAILY_RL_RECENT_DAYS=${US_ML_DAILY_RL_RECENT_DAYS:-60}',
  'export US_ML_DAILY_STATUS_RECENT_DAYS=${US_ML_DAILY_STATUS_RECENT_DAYS:-60}',
  'export US_ML_DAILY_REFRESH_LABELS=${US_ML_DAILY_REFRESH_LABELS:-0}',
  'export US_ML_DAILY_REFRESH_RL=${US_ML_DAILY_REFRESH_RL:-0}',
  'export US_ML_DAILY_REFRESH_STATUS=${US_ML_DAILY_REFRESH_STATUS:-0}',
  'export US_ML_DAILY_ACCURACY_HEALTH=${US_ML_DAILY_ACCURACY_HEALTH:-0}',
  'npm run batch:us-update-latest',
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
${marketCloseRetrySchedule()}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'us-update-latest.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'us-update-latest.err'))}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`

fs.writeFileSync(plistPath, plist)

try {
  execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
} catch {
  // 未登録なら問題なし。
}

execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })

console.log(`launchd registered: ${plistPath}`)
console.log('schedule: Tue-Sat 06:30, 07:30, 08:30, 12:30, 18:30 JST')
console.log(`logs: ${path.join(logDir, 'us-update-latest.log')}`)

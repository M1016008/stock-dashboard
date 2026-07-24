// scripts/install-local-auto-update.ts
//
// ローカルMacの launchd に StockBoard の日次自動更新を登録する。
// J-Quantsの日次株価更新を16:30以降とみなし、17:00までにサイト基準日を最新化する。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.update-latest'
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

function marketDayRetrySchedule(): string {
  // launchd Weekday: 1=Monday ... 5=Friday.
  // Exchange holidays are harmless no-op runs in the updater, but weekends
  // must not consume memory or contend with weekly ML governance.
  const weekdays = [1, 2, 3, 4, 5]
  const times = [
    [16, 40],
    [16, 55],
    [17, 20],
    [18, 10],
    [21, 10],
  ] as const
  return weekdays.flatMap((weekday) => times.map(([hour, minute]) => calendar(hour, minute, weekday))).join('\n')
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
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-15}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-8192}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  // A busy optional writer must fail fast enough for the next scheduled
  // repair to run. Required refreshes still retry through their own jobs.
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-6}',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=75',
  'export UPDATE_OPTIONAL_CHILD_TIMEOUT_MINUTES=${UPDATE_OPTIONAL_CHILD_TIMEOUT_MINUTES:-30}',
  'export UPDATE_LATEST_OPTIONAL_AFTER_HOUR=${UPDATE_LATEST_OPTIONAL_AFTER_HOUR:-21}',
  'export SKIP_DAILY_ML=1',
  'export SERVING_DATE_LIMIT=${SERVING_DATE_LIMIT:-60}',
  'export SERVING_SUMMARY_DATE_CHUNK=${SERVING_SUMMARY_DATE_CHUNK:-30}',
  'export SERVING_RESULT_DATE_CHUNK=${SERVING_RESULT_DATE_CHUNK:-10}',
  'export SERVING_EVIDENCE_DATE_CHUNK=${SERVING_EVIDENCE_DATE_CHUNK:-10}',
  // 夕方の差分更新は全期間再計算に倒さない。全期間ML/PMSは週次ジョブへ分離する。
  'export PMS_DAILY_RECENT_DAYS=${PMS_DAILY_RECENT_DAYS:-30}',
  'export ML_DAILY_RECENT_DAYS=${ML_DAILY_RECENT_DAYS:-5}',
  'export ML_DAILY_MIN_HISTORY_DAYS=${ML_DAILY_MIN_HISTORY_DAYS:-220}',
  'export ML_DAILY_LABEL_RECENT_DAYS=${ML_DAILY_LABEL_RECENT_DAYS:-30}',
  'export ML_DAILY_EXTREMA_RECENT_DAYS=${ML_DAILY_EXTREMA_RECENT_DAYS:-60}',
  'export ML_DAILY_RL_RECENT_DAYS=${ML_DAILY_RL_RECENT_DAYS:-60}',
  'export ML_DAILY_STATUS_RECENT_DAYS=${ML_DAILY_STATUS_RECENT_DAYS:-60}',
  'export ML_CONTEXT_DAILY_RECENT_DAYS=${ML_CONTEXT_DAILY_RECENT_DAYS:-5}',
  'export ML_PHYSICS_DAILY_RECENT_DAYS=${ML_PHYSICS_DAILY_RECENT_DAYS:-5}',
  'export ML_PHYSICS_DAILY_MIN_HISTORY_DAYS=${ML_PHYSICS_DAILY_MIN_HISTORY_DAYS:-220}',
  'npm run batch:update-latest',
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
${marketDayRetrySchedule()}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'update-latest.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'update-latest.err'))}</string>
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

sleep(750)
bootstrap()
execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })

console.log(`launchd registered: ${plistPath}`)
console.log('schedule: Mon-Fri 16:40, 16:55, 17:20, 18:10, 21:10 JST')
console.log(`logs: ${path.join(logDir, 'update-latest.log')}`)

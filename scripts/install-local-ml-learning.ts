// scripts/install-local-ml-learning.ts
//
// ローカルMacの launchd に、日次ML serving更新ジョブを登録する。
// 当日引け後を本実行、翌早朝を自動再試行枠として登録する。

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.ml-learning'
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
const scheduleHour = Number(process.env.ML_LEARNING_HOUR ?? '22')
const scheduleMinute = Number(process.env.ML_LEARNING_MINUTE ?? '30')
const retryHour = Number(process.env.ML_LEARNING_RETRY_HOUR ?? '3')
const retryMinute = Number(process.env.ML_LEARNING_RETRY_MINUTE ?? '0')

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

function weekdaySchedule(): string {
  // launchd Weekday: 1=Monday ... 6=Saturday, 0/7=Sunday.
  // Japanese exchange holidays are handled inside scripts/run-ml-learning.ts.
  return [1, 2, 3, 4, 5]
    .flatMap((weekday) => [
      calendar(scheduleHour, scheduleMinute, weekday),
      calendar(retryHour, retryMinute, weekday),
    ])
    .join('\n')
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-20}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-8192}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-12}',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=${UPDATE_CHILD_TIMEOUT_MINUTES:-240}',
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
  'export ML_LEARNING_MAX_ATTEMPTS=${ML_LEARNING_MAX_ATTEMPTS:-2}',
  'export ML_LEARNING_RETRY_DELAY_SECONDS=${ML_LEARNING_RETRY_DELAY_SECONDS:-300}',
  'export ML_LEARNING_LOCK_WAIT_MINUTES=${ML_LEARNING_LOCK_WAIT_MINUTES:-60}',
  'export ML_LEARNING_BATCH_WAIT_MINUTES=${ML_LEARNING_BATCH_WAIT_MINUTES:-60}',
  'npm run batch:ml-learning-daily',
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
${weekdaySchedule()}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'ml-learning.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'ml-learning.err'))}</string>
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
console.log(
  `schedule: Mon-Fri ${String(scheduleHour).padStart(2, '0')}:${String(scheduleMinute).padStart(2, '0')} JST`
  + ` + retry ${String(retryHour).padStart(2, '0')}:${String(retryMinute).padStart(2, '0')} JST;`
  + ' JP exchange holidays are skipped by the wrapper',
)
console.log(`logs: ${path.join(logDir, 'ml-learning.log')}`)

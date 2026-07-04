// scripts/install-local-ml-learning.ts
//
// ローカルMacの launchd に、日次ML serving更新ジョブを登録する。
// 特徴量・PMS・RL/物理状態は、保持している最古データから全期間で早朝に更新する。

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
const scheduleHour = Number(process.env.ML_LEARNING_HOUR ?? '3')
const scheduleMinute = Number(process.env.ML_LEARNING_MINUTE ?? '0')

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
  return [1, 2, 3, 4, 5].map((weekday) => calendar(scheduleHour, scheduleMinute, weekday)).join('\n')
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_RETRIES=720',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=2880',
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
console.log(`schedule: Mon-Fri ${String(scheduleHour).padStart(2, '0')}:${String(scheduleMinute).padStart(2, '0')} JST; JP exchange holidays are skipped by the wrapper`)
console.log(`logs: ${path.join(logDir, 'ml-learning.log')}`)

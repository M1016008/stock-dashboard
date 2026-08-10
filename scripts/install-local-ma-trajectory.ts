import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.ma-trajectory'
const cwd = process.cwd()
const home = os.homedir()
const launchAgents = path.join(home, 'Library', 'LaunchAgents')
const logs = path.join(home, 'Library', 'Logs', 'StockBoard')
const plistPath = path.join(launchAgents, `${label}.plist`)
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const hour = Number(process.env.MA_TRAJECTORY_DAILY_HOUR ?? '23')
const minute = Number(process.env.MA_TRAJECTORY_DAILY_MINUTE ?? '20')
const retryHour = Number(process.env.MA_TRAJECTORY_RETRY_HOUR ?? '0')
const retryMinute = Number(process.env.MA_TRAJECTORY_RETRY_MINUTE ?? '20')

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function scheduleEntry(weekday: number, scheduleHour: number, scheduleMinute: number): string {
  return [
    '    <dict>',
    `      <key>Weekday</key><integer>${weekday}</integer>`,
    `      <key>Hour</key><integer>${scheduleHour}</integer>`,
    `      <key>Minute</key><integer>${scheduleMinute}</integer>`,
    '    </dict>',
  ].join('\n')
}

const everyDay = [0, 1, 2, 3, 4, 5, 6]
const schedule = [
  ...everyDay.map((weekday) => scheduleEntry(weekday, hour, minute)),
  ...everyDay.map((weekday) => scheduleEntry(weekday, retryHour, retryMinute)),
]
  .join('\n')
const command = [
  `cd ${JSON.stringify(cwd)}`,
  'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
  'export USE_LOCAL_DB=1',
  'export MA_TRAJECTORY_NUM_THREADS=${MA_TRAJECTORY_NUM_THREADS:-2}',
  'export MA_TRAJECTORY_TRAINING_PROFILE=${MA_TRAJECTORY_TRAINING_PROFILE:-accuracy}',
  'export MA_TRAJECTORY_MIN_FREE_PERCENT=${MA_TRAJECTORY_MIN_FREE_PERCENT:-35}',
  'export MA_TRAJECTORY_MIN_FREE_MB=${MA_TRAJECTORY_MIN_FREE_MB:-4096}',
  'export MA_TRAJECTORY_RUNTIME_MIN_AVAILABLE_MB=${MA_TRAJECTORY_RUNTIME_MIN_AVAILABLE_MB:-2048}',
  'export MA_TRAJECTORY_RUNTIME_MIN_FREE_PERCENT=${MA_TRAJECTORY_RUNTIME_MIN_FREE_PERCENT:-18}',
  'export MA_TRAJECTORY_MAX_RSS_MB=${MA_TRAJECTORY_MAX_RSS_MB:-3500}',
  'npm run batch:ma-trajectory-refresh:jp',
].join(' && ')

fs.mkdirSync(launchAgents, { recursive: true })
fs.mkdirSync(logs, { recursive: true })
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>WorkingDirectory</key><string>${escapeXml(cwd)}</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>${escapeXml(command)}</string></array>
  <key>StartCalendarInterval</key>
  <array>
${schedule}
  </array>
  <key>StandardOutPath</key><string>${escapeXml(path.join(logs, 'ma-trajectory.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(path.join(logs, 'ma-trajectory.err'))}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`
fs.writeFileSync(plistPath, plist)
try {
  execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
} catch {
  // The job was not registered yet.
}
execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })
console.log(`launchd registered: ${plistPath}`)
console.log(`JP MA refresh: daily ${hour}:${minute}, retry ${retryHour}:${retryMinute} JST`)
console.log(`logs: ${path.join(logs, 'ma-trajectory.log')}`)

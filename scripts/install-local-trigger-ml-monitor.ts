import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.trigger-ml-frozen-monitor'
const home = os.homedir()
const cwd = process.cwd()
const agents = path.join(home, 'Library', 'LaunchAgents')
const logs = path.join(home, 'Library', 'Logs', 'StockBoard')
const plist = path.join(agents, `${label}.plist`)
const day = Number(process.env.TRIGGER_ML_MONITOR_WEEKDAY ?? 6)
const hour = Number(process.env.TRIGGER_ML_MONITOR_HOUR ?? 9)
const minute = Number(process.env.TRIGGER_ML_MONITOR_MINUTE ?? 0)
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const forceReinstall = process.env.STOCKBOARD_FORCE_REINSTALL === '1'

if (![day, hour, minute].every(Number.isInteger) || day < 0 || day > 7
  || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
  throw new Error('invalid_frozen_monitor_schedule')
}
if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Asia/Tokyo') {
  throw new Error('frozen_monitor_calendar_requires_Asia_Tokyo_host_timezone')
}
if (!fs.existsSync(path.join(cwd, '.env.local')) || !fs.existsSync(path.join(cwd, 'scripts/trigger_ml_phase15f_ops.py'))) {
  throw new Error('frozen_monitor_install_requires_project_and_local_db_config')
}

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const command = `cd ${JSON.stringify(cwd)} && export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin && npm run trigger:ml-monitor-scheduler`
const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>WorkingDirectory</key><string>${escape(cwd)}</string>
${launchAgentStorageEnvironmentXml('  ')}
  <key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>${escape(command)}</string></array>
  <key>StartCalendarInterval</key><dict>
    <key>Weekday</key><integer>${day}</integer>
    <key>Hour</key><integer>${hour}</integer>
    <key>Minute</key><integer>${minute}</integer>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(path.join(logs, 'trigger-ml-frozen-monitor.log'))}</string>
  <key>StandardErrorPath</key><string>${escape(path.join(logs, 'trigger-ml-frozen-monitor.err'))}</string>
</dict></plist>
`

fs.mkdirSync(agents, { recursive: true })
fs.mkdirSync(logs, { recursive: true })
const existing = spawnSync('launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' })
if (existing.status === 0 && /state = running/.test(existing.stdout) && !forceReinstall) {
  throw new Error('frozen_monitor_running; do not replace a live scheduler')
}
fs.writeFileSync(plist, content, { mode: 0o600 })
if (existing.status === 0) execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'inherit' })
execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { stdio: 'inherit' })
execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })
console.log(`launchd registered: ${plist}`)
console.log(`schedule: weekday=${day} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (host local time, Asia/Tokyo required)`)
console.log(`logs: ${logs}`)

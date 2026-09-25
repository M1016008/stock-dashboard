import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const label = 'com.stockboard.large-holder-update'
const cwd = process.cwd()
const home = homedir()
const agents = join(home, 'Library', 'LaunchAgents')
const logs = join(home, 'Library', 'Logs', 'StockBoard')
const plistPath = join(agents, `${label}.plist`)
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const command = [
  `cd ${JSON.stringify(cwd)}`,
  'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
  'export USE_LOCAL_DB=1',
  'export SKIP_SCHEMA_ENSURE=1',
  'npm run large-holders:update-daily',
].join(' && ')
const schedule = [1, 2, 3, 4, 5].flatMap((weekday) => [
  `<dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>22</integer><key>Minute</key><integer>30</integer></dict>`,
  `<dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>23</integer><key>Minute</key><integer>30</integer></dict>`,
]).join('\n')
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>WorkingDirectory</key><string>${escape(cwd)}</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>-lc</string><string>${escape(command)}</string></array>
<key>StartCalendarInterval</key><array>${schedule}</array>
<key>StandardOutPath</key><string>${escape(join(logs, 'large-holder-update.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(logs, 'large-holder-update.err'))}</string>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>Nice</key><integer>10</integer>
<key>ThrottleInterval</key><integer>300</integer>
</dict></plist>`

if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ label, plistPath, schedule: 'Mon-Fri 22:30/23:30 JST',
    command, writes: 0 }, null, 2))
} else {
  mkdirSync(agents, { recursive: true })
  mkdirSync(logs, { recursive: true })
  writeFileSync(plistPath, plist)
  try { execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' }) }
  catch { /* Not yet registered. */ }
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
  execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })
  console.log(`launchd registered: ${plistPath}`)
}

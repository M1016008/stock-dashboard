import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.large-holder-update'
const cwd = process.cwd()
const home = homedir()
const agents = join(home, 'Library', 'LaunchAgents')
const logs = join(home, 'Library', 'Logs', 'StockBoard')
const configDir = join(home, 'Library', 'Application Support', 'StockBoard', 'config')
const machineEnv = join(configDir, 'production.env')
const plistPath = join(agents, `${label}.plist`)
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const node = process.execPath
const script = join(cwd, 'scripts', 'run-large-holder-daily-current.ts')
const scheduleTimes = ['16:50', '17:10', '17:40', '18:30', '21:30', '22:30', '23:30'] as const
const requiredMachineKeys = [
  'LARGE_HOLDER_RANKING_CURRENT_PATH',
  'LARGE_HOLDER_REVIEW_LEDGER_PATH',
  'LARGE_HOLDER_OPERATIONS_DIR',
] as const

function calendar(hour: number, minute: number, weekday: number): string {
  return `<dict><key>Weekday</key><integer>${weekday}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`
}

const mode = statSync(machineEnv).mode & 0o777
if ((mode & 0o077) !== 0) throw new Error('Canonical production env permissions must be owner-only')
const machineEnvKeys = new Set(readFileSync(machineEnv, 'utf8').split('\n')
  .map((line) => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1]).filter(Boolean))
for (const key of requiredMachineKeys) {
  if (!machineEnvKeys.has(key)) throw new Error(`Canonical production env is missing ${key}`)
}
const schedule = [1, 2, 3, 4, 5].flatMap((weekday) => scheduleTimes.map((time) => {
  const [hour, minute] = time.split(':').map(Number)
  return calendar(hour, minute, weekday)
})).join('\n')
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>WorkingDirectory</key><string>${escape(cwd)}</string>
${launchAgentStorageEnvironmentXml('')}
<key>ProgramArguments</key><array>
<string>${escape(node)}</string>
<string>--env-file=${escape(machineEnv)}</string>
<string>--import</string><string>tsx</string>
<string>${escape(script)}</string>
</array>
<key>StartCalendarInterval</key><array>${schedule}</array>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${escape(join(logs, 'large-holder-update.log'))}</string>
<key>StandardErrorPath</key><string>${escape(join(logs, 'large-holder-update.err'))}</string>
<key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/>
<key>Nice</key><integer>10</integer>
<key>ThrottleInterval</key><integer>300</integer>
</dict></plist>`

if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify({ label, plistPath, machineEnv: 'PRESENT', machineEnvMode: mode.toString(8),
    requiredMachineKeys: 'PRESENT',
    edinetApiKey: machineEnvKeys.has('EDINET_API_KEY') ? 'PRESENT' : 'OPTIONAL_NOT_SET',
    schedule: `Mon-Fri ${scheduleTimes.join(', ')} JST + RunAtLoad catch-up`,
    command: 'run-large-holder-daily-current.ts', writes: 0 }, null, 2))
} else {
  mkdirSync(agents, { recursive: true })
  mkdirSync(logs, { recursive: true })
  writeFileSync(plistPath, plist)
  try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' }) }
  catch { /* Not yet registered. */ }
  execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
  execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })
  console.log(`launchd registered: ${plistPath}`)
  console.log(`schedule: Mon-Fri ${scheduleTimes.join(', ')} JST + RunAtLoad catch-up`)
}

// Register a low-priority launchd watcher for the removable classification CSV.

import {
  calendarXml, cwd, ensureLaunchAgentDirs, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.classification-sync'
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

function calendar(time: string): string {
  const [hour, minute] = time.split(':').map(Number)
  return calendarXml(hour, minute)
}

ensureLaunchAgentDirs()

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  `export CLASSIFICATION_FILE=${JSON.stringify(sourcePath)}`,
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-6}',
  'nice -n 15 npm run batch:classification-sync',
].join(' && ')

const plist = launchAgentPlist(label, command, `  <key>StartCalendarInterval</key>
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
  <string>${xmlEscape(logPath('classification-sync.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('classification-sync.err'))}</string>`, launchAgentStorageEnvironmentXml('  '))

const plistPath = installLaunchAgent(label, plist, { retryBootstrap: true })

console.log(`launchd registered: ${plistPath}`)
console.log(`daily schedule: ${scheduleTimes.join(', ')} JST`)
console.log(`recovery: after login and every ${Math.round(recoveryIntervalSeconds / 3600)} hours`)
console.log(`source: ${sourcePath}`)
console.log(`logs: ${logPath('classification-sync.log')}`)

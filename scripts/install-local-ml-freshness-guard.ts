// scripts/install-local-ml-freshness-guard.ts
//
// Register a weekday launchd safety net that verifies and repairs JP ML
// freshness after the regular daily learning job.

import {
  calendarXml, cwd, ensureLaunchAgentDirs, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.ml-freshness-guard'

type GuardTime = {
  hour: number
  minute: number
}

const DEFAULT_GUARD_TIMES: GuardTime[] = [
  // The first check follows the regular post-close ML serving run. Morning
  // retries close the hole where that run overlapped an active writer or
  // completed after the first check. Saturday covers Friday's close.
  { hour: 0, minute: 15 },
  { hour: 5, minute: 15 },
  { hour: 8, minute: 15 },
]

function parseGuardTimes(): GuardTime[] {
  const raw = process.env.ML_FRESHNESS_GUARD_TIMES
    ?? DEFAULT_GUARD_TIMES.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(',')
  const parsed = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [hour, minute] = item.split(':').map(Number)
      return { hour, minute }
    })
    .filter((item) => Number.isInteger(item.hour) && Number.isInteger(item.minute) && item.hour >= 0 && item.hour <= 23 && item.minute >= 0 && item.minute <= 59)
  return parsed.length > 0
    ? parsed
    : DEFAULT_GUARD_TIMES
}

function recoverySchedule(times: GuardTime[]): string {
  // launchd Weekday: 1=Monday ... 6=Saturday, 0/7=Sunday. Saturday is
  // required to repair a Friday post-close run without waiting for Monday.
  // The guard checks the latest available JP price date, so exchange holidays
  // naturally become no-op checks when no new price date exists.
  return [1, 2, 3, 4, 5, 6]
    .flatMap((weekday) => times.map((time) => calendarXml(time.hour, time.minute, weekday)))
    .join('\n')
}

ensureLaunchAgentDirs()

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-8}',
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-20}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-8192}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  'export ML_DAILY_RECENT_DAYS=${ML_DAILY_RECENT_DAYS:-5}',
  'export ML_DAILY_MIN_HISTORY_DAYS=${ML_DAILY_MIN_HISTORY_DAYS:-220}',
  'export ML_CONTEXT_DAILY_RECENT_DAYS=${ML_CONTEXT_DAILY_RECENT_DAYS:-5}',
  'export ML_PHYSICS_DAILY_RECENT_DAYS=${ML_PHYSICS_DAILY_RECENT_DAYS:-5}',
  'export ML_PHYSICS_DAILY_MIN_HISTORY_DAYS=${ML_PHYSICS_DAILY_MIN_HISTORY_DAYS:-220}',
  'export ML_DAILY_RL_RECENT_DAYS=${ML_DAILY_RL_RECENT_DAYS:-60}',
  'export ML_DAILY_STATUS_RECENT_DAYS=${ML_DAILY_STATUS_RECENT_DAYS:-60}',
  'npm run batch:ml-freshness-guard',
].join(' && ')

const times = parseGuardTimes()
const plist = launchAgentPlist(label, command, `  <key>StartCalendarInterval</key>
  <array>
${recoverySchedule(times)}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('ml-freshness-guard.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('ml-freshness-guard.err'))}</string>
  <key>RunAtLoad</key>
  <false/>`, launchAgentStorageEnvironmentXml('  '))

const plistPath = installLaunchAgent(label, plist)

console.log(`launchd registered: ${plistPath}`)
console.log(`schedule: Mon-Sat ${times.map((time) => `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`).join(', ')} JST`)
console.log(`logs: ${logPath('ml-freshness-guard.log')}`)

// Register the low-priority daily Kabutan theme refresh at 21:00 JST.
// Later triggers recover transient failures and no-op after a successful refresh.

import {
  calendarXml, cwd, ensureLaunchAgentDirs, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.kabutan-themes'
const primaryHour = clamp(Number(process.env.KABUTAN_THEMES_HOUR ?? '21'), 0, 23, 21)
const primaryMinute = clamp(Number(process.env.KABUTAN_THEMES_MINUTE ?? '0'), 0, 59, 0)
const recoveryHours = parseHours(process.env.KABUTAN_THEMES_RECOVERY_HOURS ?? '22,23')
  .filter((hour) => hour !== primaryHour)

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback
  return Math.max(min, Math.min(max, value))
}

function parseHours(value: string): number[] {
  return Array.from(new Set(
    value
      .split(',')
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isInteger(item) && item >= 0 && item <= 23),
  ))
}

ensureLaunchAgentDirs()

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-12}',
  'export KABUTAN_THEME_LIMIT=${KABUTAN_THEME_LIMIT:-30}',
  'export KABUTAN_THEME_DETAIL_LIMIT=${KABUTAN_THEME_DETAIL_LIMIT:-30}',
  'export KABUTAN_THEME_STOCK_PAGES=${KABUTAN_THEME_STOCK_PAGES:-8}',
  'export KABUTAN_REQUEST_DELAY_MS=${KABUTAN_REQUEST_DELAY_MS:-1000}',
  'export KABUTAN_THEME_WAIT_FOR_LOCK_SECONDS=${KABUTAN_THEME_WAIT_FOR_LOCK_SECONDS:-2700}',
  'export KABUTAN_THEME_LOCK_POLL_SECONDS=${KABUTAN_THEME_LOCK_POLL_SECONDS:-30}',
  'export KABUTAN_THEME_FAIL_ON_LOCK_TIMEOUT=${KABUTAN_THEME_FAIL_ON_LOCK_TIMEOUT:-1}',
  'export KABUTAN_THEME_SKIP_IF_FRESH=${KABUTAN_THEME_SKIP_IF_FRESH:-1}',
  `export KABUTAN_THEME_FRESH_SINCE_HOUR=\${KABUTAN_THEME_FRESH_SINCE_HOUR:-${primaryHour}}`,
  `export KABUTAN_THEME_FRESH_SINCE_MINUTE=\${KABUTAN_THEME_FRESH_SINCE_MINUTE:-${primaryMinute}}`,
  'nice -n 10 npm run batch:kabutan-themes',
].join(' && ')

const schedules = [
  [primaryHour, primaryMinute] as const,
  ...recoveryHours.map((hour) => [hour, 0] as const),
]

const plist = launchAgentPlist(label, command, `  <key>StartCalendarInterval</key>
  <array>
${schedules.map(([hour, minute]) => calendarXml(hour, minute)).join('\n')}
  </array>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>900</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('kabutan-themes.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('kabutan-themes.err'))}</string>
  <key>RunAtLoad</key>
  <true/>`, launchAgentStorageEnvironmentXml('  '))

const plistPath = installLaunchAgent(label, plist)

console.log(`launchd registered: ${plistPath}`)
console.log(
  `schedule: daily ${schedules
    .map(([hour, minute]) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
    .join(', ')} JST`,
)
console.log('safety: runs after login, waits up to 45 minutes for a JP DB writer; recovery runs skip after success')
console.log('resource policy: low-priority I/O, niceness 10')
console.log(`logs: ${logPath('kabutan-themes.log')}`)
